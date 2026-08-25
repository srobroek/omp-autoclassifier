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
	 * The table is empty, and that is the claim under test.
	 *
	 * One candidate was shipped here and removed. Its escape gain was selected in-sample from about thirty
	 * arms, and the matrix holds no authorized near neighbour it would wrongly refuse, so the false-positive
	 * column could not have moved. An entry has to arrive with a test declared before its run.
	 */
	test("the shipped table is empty until an entry is confirmed out of sample", () => {
		expect(MODEL_STEERING).toEqual([]);
	});

	test("no model receives steering while the table is empty", () => {
		for (const id of ["gpt-5.6-luna", "gpt-5.6-terra", "claude-haiku-4-5", "claude-sonnet-5", "gpt-5.4"]) {
			expect(steeringFor(id)).toEqual({ stage1: [], stage2: [] });
		}
	});

	/**
	 * Nothing may ship into the filter stage. It has sixteen tokens and answers one character, so policy prose
	 * there is charged on every call and applied by none of them.
	 */
	test("no shipped entry may add to the filter stage", () => {
		for (const entry of MODEL_STEERING) expect(entry.stage1).toBeUndefined();
	});
});
