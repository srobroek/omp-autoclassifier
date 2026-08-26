import { describe, expect, test } from "bun:test";
import { MODEL_STEERING, steeringFor, type ModelSteering } from "../src/steering";

/**
 * Globs, not literals. The same model carries a different region prefix per account, so an entry names the
 * identity a reader means and matches every spelling of it.
 */
const table: ModelSteering[] = [
	{ pattern: "*openai.gpt-5.6-luna*", stage2: ["Review line for luna."] },
	{ pattern: "*gpt-5.6-*", stage1: ["Filter line for the family."] },
	{ pattern: "*anthropic.claude-sonnet-5*", stage2: ["Should never reach haiku."] },
];

describe("per-model steering", () => {
	test("a model outside the table gets nothing", () => {
		expect(steeringFor("au.anthropic.claude-haiku-4-5-20251001-v1:0", table)).toEqual({ stage1: [], stage2: [] });
	});

	test("lines land on the stage they were written for", () => {
		const steering = steeringFor("openai.gpt-5.6-luna", table);
		expect(steering.stage2).toContain("Review line for luna.");
		expect(steering.stage1).toContain("Filter line for the family.");
		expect(steering.stage2).not.toContain("Filter line for the family.");
		expect(steering.stage1).not.toContain("Review line for luna.");
	});

	test("every matching entry contributes", () => {
		expect(steeringFor("openai.gpt-5.6-luna", table).stage1.length + steeringFor("openai.gpt-5.6-luna", table).stage2.length).toBe(2);
	});

	test("a non-matching entry never contributes", () => {
		expect(steeringFor("openai.gpt-5.6-luna", table).stage2).not.toContain("Should never reach haiku.");
	});

	/**
	 * The reason this is a glob. One account resolves Haiku to an `au.` id, another to `global.` or `us.`, and
	 * the dated suffix moves with the release. A literal or an anchored regex matches the account it was
	 * written on and silently misses the rest.
	 */
	test("one entry covers every region spelling of the same model", () => {
		const regional: ModelSteering[] = [{ pattern: "*anthropic.claude-haiku-4-5*", stage2: ["Haiku line."] }];
		for (const id of [
			"au.anthropic.claude-haiku-4-5-20251001-v1:0",
			"global.anthropic.claude-haiku-4-5-20251001-v1:0",
			"us.anthropic.claude-haiku-4-5-20251001-v1:0",
			"eu.anthropic.claude-haiku-4-5-20251001-v1:0",
			"anthropic.claude-haiku-4-5",
		]) {
			expect(steeringFor(id, regional).stage2).toEqual(["Haiku line."]);
		}
	});

	test("a region prefix does not make one model match another", () => {
		const regional: ModelSteering[] = [{ pattern: "*anthropic.claude-haiku-4-5*", stage2: ["Haiku line."] }];
		for (const id of [
			"au.anthropic.claude-sonnet-5",
			"global.openai.gpt-5.6-luna",
			"au.anthropic.claude-haiku-3-5-20240307-v1:0",
		]) {
			expect(steeringFor(id, regional).stage2).toEqual([]);
		}
	});

	/** A glob has to match the whole id, or `*haiku*` and `haiku` would mean the same thing. */
	test("a pattern without stars matches the whole id only", () => {
		const exact: ModelSteering[] = [{ pattern: "openai.gpt-5.6-luna", stage2: ["Exact."] }];
		expect(steeringFor("openai.gpt-5.6-luna", exact).stage2).toEqual(["Exact."]);
		expect(steeringFor("global.openai.gpt-5.6-luna", exact).stage2).toEqual([]);
	});

	/** Compiled globs are cached by pattern text, so repeated reads answer the same way. */
	test("repeated calls answer identically", () => {
		const cached: ModelSteering[] = [{ pattern: "*luna*", stage2: ["Cached."] }];
		for (const _attempt of [1, 2, 3]) {
			expect(steeringFor("openai.gpt-5.6-luna", cached).stage2).toEqual(["Cached."]);
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
		for (const id of [
			"openai.gpt-5.6-luna",
			"global.openai.gpt-5.6-terra",
			"au.anthropic.claude-haiku-4-5-20251001-v1:0",
			"anthropic.claude-sonnet-5",
		]) {
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
