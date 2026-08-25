import { describe, expect, test } from "bun:test";
import { MODEL_STEERING, steeringFor, type ModelSteering } from "../src/steering";

const table: ModelSteering[] = [
	{ pattern: /leaky-model/i, stage2: ["Review line for the leaky one."] },
	{ pattern: /leaky/i, stage1: ["Filter line for the family."] },
	{ pattern: /other-model/i, stage2: ["Should never appear."] },
];

describe("per-model steering", () => {
	test("a model outside the table gets nothing", () => {
		expect(steeringFor("claude-haiku-4-5", table)).toEqual({ stage1: [], stage2: [] });
	});

	test("lines land on the stage they were written for", () => {
		const steering = steeringFor("leaky-model", table);
		expect(steering.stage2).toContain("Review line for the leaky one.");
		expect(steering.stage1).toContain("Filter line for the family.");
		expect(steering.stage2).not.toContain("Filter line for the family.");
		expect(steering.stage1).not.toContain("Review line for the leaky one.");
	});

	/** A family pattern and a model pattern both apply, so a family fix does not need repeating per model. */
	test("every matching entry contributes", () => {
		const steering = steeringFor("leaky-model", table);
		expect(steering.stage1.length + steering.stage2.length).toBe(2);
	});

	test("a non-matching entry never contributes", () => {
		expect(steeringFor("leaky-model", table).stage2).not.toContain("Should never appear.");
	});

	/**
	 * A global pattern carries `lastIndex` between calls, so the same model would match and then miss. This
	 * project shipped that bug once already, in the rule engine's operator predicate.
	 */
	test("a global pattern answers the same way every time", () => {
		const sticky: ModelSteering[] = [{ pattern: /leaky/gi, stage2: ["Sticky."] }];
		for (const _attempt of [1, 2, 3]) {
			expect(steeringFor("leaky-model", sticky).stage2).toEqual(["Sticky."]);
		}
	});

	/**
	 * The shipped table is empty deliberately. Generic strictness was measured on the recommended model and
	 * moved nothing, and on a leaky one it bought escapes at about one refusal each. Populating this without
	 * a measurement is the failure mode the whole harness exists to prevent, so the emptiness is asserted:
	 * an entry has to arrive with a test that names its numbers.
	 */
	test("the shipped table carries only measured entries", () => {
		expect(MODEL_STEERING).toEqual([]);
	});
});
