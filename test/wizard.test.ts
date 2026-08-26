import { describe, expect, test } from "bun:test";
import { describeCandidate, rankCandidates, SKIP_LABEL, type WizardModel } from "../src/wizard";

/** Real provider/id pairs: the allowlist is per provider, so a bare id with a made-up provider is refused. */
function model(provider: string, id: string): WizardModel {
	return { provider, id, name: id };
}

const HAIKU = model("amazon-bedrock", "global.anthropic.claude-haiku-4-5-20251001-v1:0");
const HAIKU_AU = model("amazon-bedrock", "au.anthropic.claude-haiku-4-5-20251001-v1:0");
const LUNA = model("bedrock-mantle", "openai.gpt-5.6-luna");

const ids = (models: WizardModel[]): string[] => models.map(candidate => candidate.id);

describe("candidate ranking", () => {
	/**
	 * Haiku first is a measurement, not a preference: on 193 cases at three repeats it let nothing
	 * dangerous through, where luna leaked eleven to thirteen of a hundred and fifteen.
	 */
	test("haiku is offered before luna", () => {
		expect(ids(rankCandidates([LUNA, HAIKU]))).toEqual([HAIKU.id, LUNA.id]);
	});

	test("only tested releases are offered", () => {
		const ranked = rankCandidates([
			model("amazon-bedrock", "global.anthropic.claude-opus-5"),
			HAIKU,
			model("amazon-bedrock", "meta.llama4-scout-17b"),
			LUNA,
			model("bedrock-mantle", "openai.gpt-5.6-sol"),
		]);
		expect(ids(ranked)).toEqual([HAIKU.id, LUNA.id]);
	});

	/**
	 * Empty is the answer the caller turns into a hard error. The replaced behaviour returned the whole
	 * catalog here, which is how an unmeasured reviewer would reach an account holding neither release.
	 */
	test("an account with neither release gets an empty list, not the catalog", () => {
		const ranked = rankCandidates([
			model("amazon-bedrock", "meta.llama4-scout-17b"),
			model("amazon-bedrock", "amazon.nova-lite-v1:0"),
		]);
		expect(ranked).toEqual([]);
	});

	test("an empty catalog ranks to an empty list rather than failing", () => {
		expect(rankCandidates([])).toEqual([]);
	});

	/**
	 * An account may expose the same release through two regions or two providers. All of them are offered,
	 * because only the user knows which route they hold credentials for.
	 */
	test("two routes to the same release are both offered, in catalog order", () => {
		expect(ids(rankCandidates([HAIKU, HAIKU_AU]))).toEqual([HAIKU.id, HAIKU_AU.id]);
		expect(ids(rankCandidates([HAIKU_AU, HAIKU]))).toEqual([HAIKU_AU.id, HAIKU.id]);
	});

	test("a mixed list keeps haiku routes ahead of luna routes", () => {
		expect(ids(rankCandidates([LUNA, HAIKU_AU, HAIKU]))).toEqual([HAIKU_AU.id, HAIKU.id, LUNA.id]);
	});
});

describe("presentation", () => {
	/** The picker has to show the route, since two entries can name the same release. */
	test("a candidate is described by provider and id", () => {
		expect(describeCandidate(LUNA)).toBe("bedrock-mantle/openai.gpt-5.6-luna");
	});

	test("the skip option says what skipping costs", () => {
		expect(SKIP_LABEL.toLowerCase()).toContain("inactive");
	});
});
