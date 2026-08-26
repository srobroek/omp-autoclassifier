import { describe, expect, test } from "bun:test";
import {
	type CatalogModel,
	isTestedModel,
	NoTestedModelError,
	PROVIDER_RULES,
	TESTED_MODEL_NAMES,
	type TestedModel,
	testedModel,
	untestedRoleReason,
} from "../src/models";

function model(provider: string, id: string): CatalogModel {
	return { provider, id, name: id };
}

/**
 * Every id in this block was dumped from the live catalog, not invented. An earlier version of this suite
 * guessed them, which proved only that a regex matches a string the same author wrote.
 */
describe("observed ids", () => {
	for (const region of ["global", "us", "eu", "jp", "au", "us-gov"]) {
		test(`haiku through ${region} cross-region inference`, () => {
			const id = `${region}.anthropic.claude-haiku-4-5-20251001-v1:0`;
			expect(testedModel(model("amazon-bedrock", id))).toBe("claude-haiku-4-5");
		});
	}

	test("luna on bedrock carries no version tail", () => {
		expect(testedModel(model("amazon-bedrock", "global.openai.gpt-5.6-luna"))).toBe("gpt-5.6-luna");
	});

	test("luna on the mantle route is vendor-qualified and unprefixed", () => {
		expect(testedModel(model("bedrock-mantle", "openai.gpt-5.6-luna"))).toBe("gpt-5.6-luna");
	});

	/**
	 * These sit in the same catalog as the tested haiku. The vendor flipped the word order between
	 * generations — `claude-3-5-haiku` against `claude-haiku-4-5` — so a pattern keyed on the word "haiku"
	 * would accept a model this gate never measured.
	 */
	for (const id of [
		"anthropic.claude-3-5-haiku-20241022-v1:0",
		"eu.anthropic.claude-3-5-haiku-20241022-v1:0",
		"anthropic.claude-3-haiku-20240307-v1:0",
	]) {
		test(`an earlier haiku generation is refused: ${id}`, () => {
			expect(isTestedModel(model("amazon-bedrock", id))).toBe(false);
		});
	}

	test("the table records which rules this account can reach", () => {
		const observed = PROVIDER_RULES.filter(rule => rule.observed).map(rule => rule.provider.source);
		expect(observed).toEqual(["^amazon-bedrock$", "^bedrock-mantle$"]);
	});
});

/**
 * The gate is not Bedrock-specific. Each of these is the vendor's published id grammar for a release the
 * matrix measured; none is reachable on this account, which is why the table marks them unobserved.
 */
describe("documented provider ids", () => {
	const documented: Array<[string, string, TestedModel]> = [
		["anthropic", "claude-haiku-4-5-20251001", "claude-haiku-4-5"],
		["openai", "gpt-5.6-luna", "gpt-5.6-luna"],
		["openrouter", "anthropic/claude-haiku-4.5", "claude-haiku-4-5"],
		["openrouter", "openai/gpt-5.6-luna", "gpt-5.6-luna"],
		["google-vertex", "claude-haiku-4-5@20251001", "claude-haiku-4-5"],
		["vertex-claude-api", "publishers/anthropic/models/claude-haiku-4-5@20251001", "claude-haiku-4-5"],
		["azure-openai-responses", "gpt-5.6-luna", "gpt-5.6-luna"],
		["azure", "gpt-5.6-luna", "gpt-5.6-luna"],
	];
	for (const [provider, id, expected] of documented) {
		test(`${provider} spells it ${id}`, () => {
			expect(testedModel(model(provider, id))).toBe(expected);
		});
	}
});

/**
 * Pinning is the property the whole table exists for. A vendor may repoint an undated alias to new weights,
 * and the gate would then claim a measurement it never made — so the alias is refused even though it names
 * a model that was measured.
 */
describe("only a pinned id passes", () => {
	const floating: Array<[string, string]> = [
		["anthropic", "claude-haiku-4-5"],
		["google-vertex", "claude-haiku-4-5"],
		["vertex-claude-api", "publishers/anthropic/models/claude-haiku-4-5"],
	];
	for (const [provider, id] of floating) {
		test(`an undated alias is refused: ${provider} ${id}`, () => {
			expect(isTestedModel(model(provider, id))).toBe(false);
		});
	}

	/**
	 * OpenRouter variant suffixes route the call to a different upstream. Stripping every colon tail would
	 * have read these as the plain slug and accepted them.
	 */
	for (const variant of [":free", ":nitro", ":online", ":beta", ":floor"]) {
		test(`an openrouter routing variant is refused: ${variant}`, () => {
			expect(isTestedModel(model("openrouter", `anthropic/claude-haiku-4.5${variant}`))).toBe(false);
		});
	}

	test("the openrouter slug itself is the pin", () => {
		expect(testedModel(model("openrouter", "anthropic/claude-haiku-4.5"))).toBe("claude-haiku-4-5");
		expect(isTestedModel(model("openrouter", "anthropic/claude-haiku-3.5"))).toBe(false);
	});

	test("a different release date is refused", () => {
		expect(isTestedModel(model("anthropic", "claude-haiku-4-5-20260301"))).toBe(false);
		expect(isTestedModel(model("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20260301-v1:0"))).toBe(false);
	});

	/**
	 * Bedrock's packaging revision is pinned alongside the date, because that is the exact id the matrix
	 * ran against and the table claims no more than it measured.
	 */
	test("a different bedrock packaging revision is refused", () => {
		expect(isTestedModel(model("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v2:0"))).toBe(false);
	});

	/**
	 * Azure's deployment name is routing metadata, resolved separately from `model.id`. An entry carrying
	 * only an opaque deployment name matches nothing, which is the fail-closed half of supporting Azure.
	 */
	test("an opaque azure deployment name is refused", () => {
		expect(isTestedModel(model("azure-openai-responses", "prod-classifier-01"))).toBe(false);
	});
});

describe("the provider decides the grammar", () => {
	test("an openrouter spelling is not accepted on bedrock", () => {
		expect(isTestedModel(model("amazon-bedrock", "anthropic/claude-haiku-4.5"))).toBe(false);
	});

	test("a bedrock spelling is not accepted on anthropic direct", () => {
		expect(isTestedModel(model("anthropic", "us.anthropic.claude-haiku-4-5-20251001-v1:0"))).toBe(false);
	});

	test("an unknown provider is refused even with a pinned id", () => {
		expect(isTestedModel(model("some-reseller", "gpt-5.6-luna"))).toBe(false);
	});
});

describe("suffixes and variants", () => {
	/**
	 * A thinking suffix reaches this code from a raw `modelRoles` value — the live configuration carries
	 * one. It selects an effort level, and omp discards it during resolution, so it must not change which
	 * model the id names.
	 */
	test("a thinking suffix does not disqualify a tested model", () => {
		expect(testedModel(model("bedrock-mantle", "openai.gpt-5.6-luna:xhigh"))).toBe("gpt-5.6-luna");
		expect(testedModel(model("anthropic", "claude-haiku-4-5-20251001:auto"))).toBe("claude-haiku-4-5");
	});

	/**
	 * Bedrock ids end in a real numeric revision. Stripping every colon tail would truncate the id and
	 * refuse the model this gate is built around.
	 */
	test("a numeric bedrock revision tail is not mistaken for a suffix", () => {
		expect(testedModel(model("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0"))).toBe(
			"claude-haiku-4-5",
		);
	});

	/**
	 * This catalog carries `gpt-5.6-luna-fast` on another route. It is a different model with different
	 * behaviour, and accepting it would ship an unmeasured reviewer under a measured name.
	 */
	test("a routing variant is not the tested model", () => {
		expect(isTestedModel(model("openai", "gpt-5.6-luna-fast"))).toBe(false);
		expect(isTestedModel(model("bedrock-mantle", "openai.gpt-5.6-luna-fast"))).toBe(false);
	});
});

describe("refusals", () => {
	const refused: Array<[string, string, string]> = [
		["a sibling of the session model", "amazon-bedrock", "global.anthropic.claude-sonnet-5-20250929-v1:0"],
		["the session model itself", "amazon-bedrock", "global.anthropic.claude-opus-5"],
		["a different openai tier", "bedrock-mantle", "openai.gpt-5.6-sol"],
		["a different openai tier", "amazon-bedrock", "global.openai.gpt-5.6-terra"],
		["an open-weight model", "amazon-bedrock", "openai.gpt-oss-120b"],
		["another family entirely", "amazon-bedrock", "meta.llama4-scout-17b"],
		["another family entirely", "amazon-bedrock", "amazon.nova-lite-v1:0"],
	];
	for (const [why, provider, id] of refused) {
		test(`${why}: ${id}`, () => {
			expect(isTestedModel(model(provider, id))).toBe(false);
		});
	}
});

/** A refusal a user cannot act on is a bug report addressed to nobody. */
describe("messages", () => {
	test("the two tested releases are named for the user", () => {
		expect(TESTED_MODEL_NAMES).toEqual(["claude-haiku-4-5", "gpt-5.6-luna"]);
	});

	test("the no-model error names both releases and the next step", () => {
		const message = new NoTestedModelError().message;
		for (const name of TESTED_MODEL_NAMES) expect(message).toContain(name);
		expect(message).toContain("/autoclassifier setup");
	});

	test("an untested role is refused by name, and explains the alias rule", () => {
		const reason = untestedRoleReason("bedrock-mantle/openai.gpt-5.6-sol");
		expect(reason).toContain("openai.gpt-5.6-sol");
		for (const name of TESTED_MODEL_NAMES) expect(reason).toContain(name);
		expect(reason.toLowerCase()).toContain("alias");
	});
});
