import { describe, expect, test } from "bun:test";
import { GateState } from "../src/state";

const thresholds = { maxConsecutiveDenials: 3, maxTotalDenials: 20 };

describe("counters", () => {
	test("a fresh gate is armed with nothing recorded", () => {
		const state = new GateState(thresholds);
		expect(state.paused).toBe(false);
		expect(state.degradedReason).toBeUndefined();
		expect(state.snapshot()).toMatchObject({ checked: 0, allowed: 0, denied: 0, consecutiveDenials: 0 });
	});

	test("an allow counts as checked and allowed", () => {
		const state = new GateState(thresholds);
		state.recordAllow();
		expect(state.snapshot()).toMatchObject({ checked: 1, allowed: 1, denied: 0 });
	});

	test("a deny counts toward both the total and the consecutive run", () => {
		const state = new GateState(thresholds);
		state.recordDeny();
		expect(state.snapshot()).toMatchObject({ checked: 1, denied: 1, consecutiveDenials: 1 });
	});

	test("an allow breaks the consecutive run without erasing the total", () => {
		const state = new GateState(thresholds);
		state.recordDeny();
		state.recordDeny();
		state.recordAllow();
		expect(state.snapshot()).toMatchObject({ denied: 2, consecutiveDenials: 0 });
	});
});

/**
 * The point of the tool is that a model judges the risky calls. Without a visible count of how many
 * decisions actually reached the model, a heavy allowlist could quietly turn it into a pattern matcher
 * and nothing would report the difference.
 */
describe("classifier coverage", () => {
	test("a fast-path decision counts as checked but not as classified", () => {
		const state = new GateState(thresholds);
		state.recordAllow();
		expect(state.snapshot()).toMatchObject({ checked: 1, classified: 0 });
	});

	test("a decision the model made counts as classified", () => {
		const state = new GateState(thresholds);
		state.recordAllow({ classified: true });
		expect(state.snapshot()).toMatchObject({ checked: 1, classified: 1 });
	});

	test("a denial by the model counts as classified", () => {
		const state = new GateState(thresholds);
		state.recordDeny({ classified: true });
		expect(state.snapshot()).toMatchObject({ denied: 1, classified: 1 });
	});

	test("a denial by a static rule does not count as classified", () => {
		const state = new GateState(thresholds);
		state.recordDeny();
		expect(state.snapshot()).toMatchObject({ denied: 1, classified: 0 });
	});

	test("a classifier failure counts as classified, since the model was consulted", () => {
		const state = new GateState(thresholds);
		state.recordFailure("unreachable");
		expect(state.snapshot()).toMatchObject({ classified: 1 });
	});

	test("the classified count survives a restore", () => {
		const state = new GateState(thresholds);
		state.recordAllow({ classified: true });
		const restored = new GateState(thresholds);
		restored.restore(state.snapshot());
		expect(restored.snapshot()).toMatchObject({ classified: 1 });
	});

	test("resume keeps the coverage counters, which describe the session not the breaker", () => {
		const state = new GateState(thresholds);
		state.recordAllow({ classified: true });
		state.resume();
		expect(state.snapshot()).toMatchObject({ checked: 1, classified: 1 });
	});
});

/**
 * The breaker marks the gate `degraded`: the classifier failed enough times that no verdict is available,
 * so every call is refused until the user resumes.
 *
 * It sets a different flag from `paused` on purpose. `paused` is the user's own bypass and allows; sharing
 * one flag meant a provider rejecting a fixable request field switched supervision off silently, which is
 * the opposite of what a fail-closed gate promises.
 */
describe("circuit breaker", () => {
	test("a run of consecutive failures degrades the gate", () => {
		const state = new GateState(thresholds);
		state.recordFailure("model unreachable");
		state.recordFailure("model unreachable");
		expect(state.degraded).toBe(false);
		state.recordFailure("model unreachable");
		expect(state.degraded).toBe(true);
	});

	/** The breaker must not touch the user's bypass, or resuming would report the wrong state. */
	test("degrading never sets the user's own pause", () => {
		const state = new GateState({ maxConsecutiveDenials: 1, maxTotalDenials: 20 });
		state.recordFailure("down");
		expect(state.degraded).toBe(true);
		expect(state.paused).toBe(false);
	});

	test("scattered failures still degrade once the session total is reached", () => {
		const state = new GateState({ maxConsecutiveDenials: 100, maxTotalDenials: 3 });
		for (let i = 0; i < 2; i++) {
			state.recordFailure("down");
			state.recordAllow();
		}
		expect(state.degraded).toBe(false);
		state.recordFailure("down");
		expect(state.degraded).toBe(true);
	});

	test("a threshold of one degrades on the first failure", () => {
		const state = new GateState({ maxConsecutiveDenials: 1, maxTotalDenials: 20 });
		state.recordFailure("down");
		expect(state.degraded).toBe(true);
	});

	/**
	 * Resume is the only exit. A degraded gate refuses every call, so no allow can ever arrive to reset the
	 * run on its own — without this, resuming would report success and change nothing.
	 */
	test("resume clears the degraded state and its counters", () => {
		const state = new GateState({ maxConsecutiveDenials: 1, maxTotalDenials: 20 });
		state.recordFailure("down");
		state.resume();
		expect(state.degraded).toBe(false);
		state.recordFailure("down");
		expect(state.degraded).toBe(true);
	});

	/**
	 * The counterpart, and the reason the two are no longer one counter. A reviewer that answers is a
	 * reviewer that works, and a working reviewer's refusals must never be a route to switching it off.
	 */
	test("a run of denials does not pause the gate, however long", () => {
		const state = new GateState(thresholds);
		for (let i = 0; i < 25; i++) state.recordDeny();
		expect(state.paused).toBe(false);
	});

	/**
	 * The lock is the answer to persistence: an agent that keeps arriving at a refused action stops
	 * getting tool calls at all, and only the user lifts it.
	 *
	 * Warning the agent about it is safe only because the lock is strictly more restrictive than the gate.
	 * The earlier design tripped the same counter and then *opened* the gate, which made the threshold a
	 * three-call recipe for switching off supervision — publishable only once that was separated.
	 */
	test("a run of denials locks the session", () => {
		const state = new GateState(thresholds);
		state.recordDeny();
		state.recordDeny();
		expect(state.locked).toBe(false);
		state.recordDeny();
		expect(state.locked).toBe(true);
	});

	test("an allowed call between denials clears the run", () => {
		const state = new GateState(thresholds);
		state.recordDeny();
		state.recordDeny();
		state.recordAllow();
		state.recordDeny();
		expect(state.locked).toBe(false);
	});

	/**
	 * A broken reviewer is not the agent misbehaving, so it must not spend the agent's budget toward a
	 * lock. Failures have their own counter and their own outcome, which is to pause rather than lock.
	 */
	test("classifier failures do not count toward the lock", () => {
		const state = new GateState(thresholds);
		for (const _ of [1, 2, 3, 4]) state.recordFailure("model unreachable");
		expect(state.locked).toBe(false);
	});

	test("the user lifting the pause also lifts the lock", () => {
		const state = new GateState(thresholds);
		for (const _ of [1, 2, 3]) state.recordDeny();
		expect(state.locked).toBe(true);
		state.resume();
		expect(state.locked).toBe(false);
	});

	test("resume re-arms the gate and clears both counters", () => {
		const state = new GateState(thresholds);
		for (let i = 0; i < 3; i++) state.recordDeny();
		state.resume();
		expect(state.paused).toBe(false);
		expect(state.snapshot()).toMatchObject({ denied: 0, consecutiveDenials: 0 });
	});

	test("resume clears the degraded reason too", () => {
		const state = new GateState(thresholds);
		state.recordFailure("model unreachable");
		expect(state.degradedReason).toBe("model unreachable");
		state.resume();
		expect(state.degradedReason).toBeUndefined();
	});

	test("pausing by hand does not need a denial", () => {
		const state = new GateState(thresholds);
		state.pause();
		expect(state.paused).toBe(true);
	});

	test("an allow after pausing does not silently re-arm the gate", () => {
		const state = new GateState(thresholds);
		state.pause();
		state.recordAllow();
		expect(state.paused).toBe(true);
	});
});

/**
 * A failure and a denial are indistinguishable from the agent's side — both block — and that was once the
 * argument for counting them together. It was wrong, because the right *response* differs: a wall of
 * failures means the reviewer is broken and no verdict exists, while a wall of denials means the reviewer
 * is working and is being ignored.
 *
 * Neither opens the gate. Failures used to, and a review of this file caught what that bought: a provider
 * rejecting one fixable request field would silently stop supervision after three calls. The two states are
 * now separate flags with opposite answers, and only the user's own `/autoclassifier pause` allows.
 */
describe("breaker separates a broken reviewer from a working one", () => {
	test("a run of classifier failures degrades the gate rather than opening it", () => {
		const state = new GateState(thresholds);
		for (const _ of [1, 2, 3]) state.recordFailure("model unreachable");
		expect(state.degraded).toBe(true);
		expect(state.paused).toBe(false);
	});

	test("a run of genuine denials never opens the gate", () => {
		const state = new GateState(thresholds);
		for (const _ of [1, 2, 3, 4, 5, 6]) state.recordDeny();
		expect(state.paused).toBe(false);
		expect(state.degraded).toBe(false);
	});

	test("a wall of denials is still counted, so it can be reported", () => {
		const state = new GateState(thresholds);
		for (const _ of [1, 2, 3]) state.recordDeny();
		expect(state.locked).toBe(true);
	});

	test("a single denial is not a wall", () => {
		const state = new GateState(thresholds);
		state.recordDeny();
		expect(state.locked).toBe(false);
	});

	test("an allow between denials clears the run", () => {
		const state = new GateState(thresholds);
		state.recordDeny();
		state.recordDeny();
		state.recordAllow();
		state.recordDeny();
		expect(state.locked).toBe(false);
	});

	/** Mixed traffic must not trip the open-the-gate breaker on the denial half. */
	test("denials do not contribute to the failure run", () => {
		const state = new GateState(thresholds);
		state.recordFailure("down");
		state.recordDeny();
		state.recordFailure("down");
		state.recordDeny();
		expect(state.paused).toBe(false);
	});

	test("the total denial ceiling does not open the gate either", () => {
		const state = new GateState({ maxConsecutiveDenials: 3, maxTotalDenials: 4 });
		for (const _ of [1, 2, 3, 4, 5]) {
			state.recordDeny();
			state.recordAllow();
		}
		expect(state.paused).toBe(false);
	});
});

/**
 * A refusal is not cached, deliberately, so that authorization given in chat takes effect at once. The
 * cost is that an agent may simply ask again in different words. A live run did exactly that: a refused
 * subagent spawn was reworded until a fresh review passed it. The ledger is what lets the next review
 * see the pattern.
 */
describe("refusal ledger", () => {
	test("a fresh gate has refused nothing", () => {
		expect(new GateState(thresholds).refusals).toEqual([]);
	});

	test("a refusal is remembered with its tool, target, and reason", () => {
		const state = new GateState(thresholds);
		state.recordRefusal("task", "git push --force origin main", "Destroys shared history.");
		expect(state.refusals).toEqual([
			{ toolName: "task", target: "git push --force origin main", reason: "Destroys shared history." },
		]);
	});

	test("refusals are kept oldest first", () => {
		const state = new GateState(thresholds);
		state.recordRefusal("bash", "one", "a");
		state.recordRefusal("write", "two", "b");
		expect(state.refusals.map(refusal => refusal.target)).toEqual(["one", "two"]);
	});

	test("the ledger is bounded so a long session cannot grow without limit", () => {
		const state = new GateState(thresholds);
		for (let index = 0; index < 40; index++) state.recordRefusal("bash", `c${index}`, "no");
		expect(state.refusals.length).toBeLessThanOrEqual(16);
		expect(state.refusals.at(-1)?.target).toBe("c39");
	});

	test("an identical refusal is not recorded twice", () => {
		const state = new GateState(thresholds);
		state.recordRefusal("bash", "same", "no");
		state.recordRefusal("bash", "same", "no");
		expect(state.refusals.length).toBe(1);
	});

	/** Resuming the gate is the user forgiving the session, so the history goes with the counters. */
	test("resuming clears the ledger", () => {
		const state = new GateState(thresholds);
		state.recordRefusal("bash", "one", "a");
		state.resume();
		expect(state.refusals).toEqual([]);
	});

	test("the ledger survives a snapshot and restore", () => {
		const state = new GateState(thresholds);
		state.recordRefusal("task", "one", "a");
		const restored = new GateState(thresholds);
		restored.restore(state.snapshot());
		expect(restored.refusals).toEqual([{ toolName: "task", target: "one", reason: "a" }]);
	});

	test("a malformed persisted ledger is ignored rather than trusted", () => {
		const state = new GateState(thresholds);
		state.restore({ refusals: [{ toolName: 7 }, "nope", null] });
		expect(state.refusals).toEqual([]);
	});
});

describe("degraded reporting", () => {
	test("a failure records why the gate is degraded", () => {
		const state = new GateState(thresholds);
		state.recordFailure("no api key");
		expect(state.degradedReason).toBe("no api key");
	});

	test("a successful allow clears the degraded reason", () => {
		const state = new GateState(thresholds);
		state.recordFailure("no api key");
		state.recordAllow();
		expect(state.degradedReason).toBeUndefined();
	});

	test("a notice fires once per session per class", () => {
		const state = new GateState(thresholds);
		expect(state.shouldNotice("auth")).toBe(true);
		expect(state.shouldNotice("auth")).toBe(false);
		expect(state.shouldNotice("timeout")).toBe(true);
	});
});

/** State is persisted as a session entry so a resumed session does not forget it was paused. */
describe("persistence", () => {
	test("a snapshot restores every field", () => {
		const state = new GateState(thresholds);
		state.recordDeny();
		state.recordDeny();
		state.recordFailure("boom");
		const snapshot = state.snapshot();

		const restored = new GateState(thresholds);
		restored.restore(snapshot);
		expect(restored.snapshot()).toEqual(snapshot);
		expect(restored.degradedReason).toBe("boom");
	});

	/**
	 * Both flags survive a branch or a resume of the same session, and they are separate fields because
	 * they mean opposite things. A resumed session must not silently re-arm a gate the user paused, nor
	 * forget that the classifier is broken.
	 */
	test("a degraded gate stays degraded after restore", () => {
		const state = new GateState(thresholds);
		for (let i = 0; i < 3; i++) state.recordFailure("down");
		const restored = new GateState(thresholds);
		restored.restore(state.snapshot());
		expect(restored.degraded).toBe(true);
		expect(restored.paused).toBe(false);
	});

	test("the user's own pause stays paused after restore", () => {
		const state = new GateState(thresholds);
		state.pause();
		const restored = new GateState(thresholds);
		restored.restore(state.snapshot());
		expect(restored.paused).toBe(true);
		expect(restored.degraded).toBe(false);
	});

	test("malformed persisted state is ignored rather than throwing", () => {
		const state = new GateState(thresholds);
		for (const bad of [undefined, null, 42, "paused", [], { denied: "many", paused: "yes" }]) {
			expect(() => state.restore(bad)).not.toThrow();
		}
		expect(state.snapshot()).toMatchObject({ checked: 0, denied: 0 });
		expect(state.paused).toBe(false);
	});

	test("a partial snapshot contributes only the fields it has", () => {
		const state = new GateState(thresholds);
		state.restore({ denied: 2 });
		expect(state.snapshot()).toMatchObject({ denied: 2, checked: 0 });
	});

	test("negative persisted counters are clamped", () => {
		const state = new GateState(thresholds);
		state.restore({ denied: -5, checked: -1 });
		expect(state.snapshot()).toMatchObject({ denied: 0, checked: 0 });
	});
});
