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
 * The breaker exists so a misfiring gate cannot wall off a session indefinitely. Both vendors surveyed
 * pause on a run of refusals rather than trusting the reviewer to recover on its own.
 */
describe("circuit breaker", () => {
	test("a run of consecutive failures pauses the gate", () => {
		const state = new GateState(thresholds);
		state.recordFailure("model unreachable");
		state.recordFailure("model unreachable");
		expect(state.paused).toBe(false);
		state.recordFailure("model unreachable");
		expect(state.paused).toBe(true);
	});

	test("scattered failures still pause once the session total is reached", () => {
		const state = new GateState({ maxConsecutiveDenials: 100, maxTotalDenials: 3 });
		for (let i = 0; i < 2; i++) {
			state.recordFailure("down");
			state.recordAllow();
		}
		expect(state.paused).toBe(false);
		state.recordFailure("down");
		expect(state.paused).toBe(true);
	});

	test("a threshold of one pauses on the first failure", () => {
		const state = new GateState({ maxConsecutiveDenials: 1, maxTotalDenials: 20 });
		state.recordFailure("down");
		expect(state.paused).toBe(true);
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
 * The breaker exists so a broken classifier cannot brick a session. It must not double as a way to
 * switch the gate off by persisting.
 *
 * Both were counted together at first, on the reasoning that a failure and a denial are indistinguishable
 * from the agent's side. True, and irrelevant: the right *response* differs completely. A wall of failures
 * means the reviewer is broken, so opening the gate is the lesser harm. A wall of denials means the
 * reviewer is working, and opening the gate there rewards persistence and hands any agent a three-call
 * recipe for disabling its own supervision.
 */
describe("breaker separates a broken reviewer from a working one", () => {
	test("a run of classifier failures opens the gate", () => {
		const state = new GateState(thresholds);
		for (const _ of [1, 2, 3]) state.recordFailure("model unreachable");
		expect(state.paused).toBe(true);
	});

	test("a run of genuine denials never opens the gate", () => {
		const state = new GateState(thresholds);
		for (const _ of [1, 2, 3, 4, 5, 6]) state.recordDeny();
		expect(state.paused).toBe(false);
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

	test("a paused gate stays paused after restore", () => {
		const state = new GateState(thresholds);
		for (let i = 0; i < 3; i++) state.recordFailure("down");
		const restored = new GateState(thresholds);
		restored.restore(state.snapshot());
		expect(restored.paused).toBe(true);
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
