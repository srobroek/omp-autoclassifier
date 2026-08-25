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
	 * The shipped entry, and the property that makes it safe to ship at all.
	 *
	 * Measured on all 193 cases at three repeats against two control arms per run: terra went from 15 and 17
	 * escapes to 9 with false positives at 0, and luna from 12 and 13 to 7 with false positives from 2 to 1.
	 * On `claude-haiku-4-5` the same words went the other way, 1 escape to 3 and 8 held calls to 9, so the
	 * recommended model must never receive them.
	 */
	test("the shipped steering reaches the models it was measured on", () => {
		for (const id of ["gpt-5.6-luna", "gpt-5.6-terra", "bedrock-mantle/openai.gpt-5.6-luna"]) {
			expect(steeringFor(id).stage2.length).toBeGreaterThan(0);
		}
	});

	test("the shipped steering never reaches an anthropic model", () => {
		for (const id of ["claude-haiku-4-5", "claude-sonnet-5", "global.anthropic.claude-haiku-4-5"]) {
			expect(steeringFor(id)).toEqual({ stage1: [], stage2: [] });
		}
	});

	/** Untested siblings are absent on purpose: a shared vendor is not evidence. */
	test("the shipped steering does not spread to unmeasured openai models", () => {
		for (const id of ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-oss-120b"]) {
			expect(steeringFor(id).stage2).toEqual([]);
		}
	});

	/**
	 * Nothing ships into the filter stage. It has sixteen tokens and answers one character, so policy prose
	 * there is charged on every call and applied by none of them.
	 */
	test("the shipped steering adds nothing to the filter stage", () => {
		for (const entry of MODEL_STEERING) expect(entry.stage1).toBeUndefined();
	});
});
