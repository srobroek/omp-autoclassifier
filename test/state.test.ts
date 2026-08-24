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
	test("a run of consecutive denials pauses the gate", () => {
		const state = new GateState(thresholds);
		state.recordDeny();
		state.recordDeny();
		expect(state.paused).toBe(false);
		state.recordDeny();
		expect(state.paused).toBe(true);
	});

	test("scattered denials still pause once the session total is reached", () => {
		const state = new GateState({ maxConsecutiveDenials: 100, maxTotalDenials: 3 });
		for (let i = 0; i < 2; i++) {
			state.recordDeny();
			state.recordAllow();
		}
		expect(state.paused).toBe(false);
		state.recordDeny();
		expect(state.paused).toBe(true);
	});

	test("a threshold of one pauses on the first denial", () => {
		const state = new GateState({ maxConsecutiveDenials: 1, maxTotalDenials: 20 });
		state.recordDeny();
		expect(state.paused).toBe(true);
	});

	test("classifier failures count toward the breaker, since they also block", () => {
		const state = new GateState(thresholds);
		state.recordFailure("model unreachable");
		state.recordFailure("model unreachable");
		state.recordFailure("model unreachable");
		expect(state.paused).toBe(true);
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
		for (let i = 0; i < 3; i++) state.recordDeny();
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
