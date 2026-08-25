import { describe, expect, test } from "bun:test";
import { rankCandidates, type WizardModel } from "../src/wizard";

function model(id: string, provider = "prov"): WizardModel {
	return { id, provider, name: id };
}

const ids = (models: WizardModel[]): string[] => models.map(candidate => candidate.id);

describe("candidate ranking", () => {
	/**
	 * These ids deliberately avoid every cheap-sounding word, so the name heuristic cannot produce the
	 * expected order on its own and only the configured role can.
	 */
	/**
	 * A measurement outranks every heuristic here, and this is the case that motivated it.
	 *
	 * Cheapness used to win. On the account this was measured against, that picked `gpt-5.6-luna`, which
	 * allowed 13 of 193 dangerous calls and flapped on 12, while `claude-haiku-4-5` allowed none and flapped
	 * on none. Recommending the cheapest model was recommending the leakiest one.
	 */
	test("a measured model outranks the user own cheap role", () => {
		const models = [model("gpt-5.6-luna"), model("claude-haiku-4-5")];
		const ranked = rankCandidates(models, { roles: { smol: "prov/gpt-5.6-luna", tiny: "prov/gpt-5.6-luna" } });
		expect(ranked[0]?.id).toBe("claude-haiku-4-5");
	});

	test("the measured order is preserved among measured models", () => {
		const models = [model("claude-sonnet-5"), model("claude-haiku-4-5")];
		expect(ids(rankCandidates(models, { roles: {} }))).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
	});

	test("an unmeasured model is ranked, not rejected", () => {
		const models = [model("some-new-model")];
		expect(ids(rankCandidates(models, { roles: {} }))).toEqual(["some-new-model"]);
	});

	test("a model already trusted for cheap work is offered first", () => {
		const models = [model("alpha-one"), model("beta-two"), model("gamma-three")];
		const ranked = rankCandidates(models, { roles: { smol: "prov/beta-two" } });
		expect(ranked[0]?.id).toBe("beta-two");
	});

	test("the tiny role counts as trusted for cheap work too", () => {
		const models = [model("alpha-one"), model("beta-two")];
		const ranked = rankCandidates(models, { roles: { tiny: "prov/beta-two" } });
		expect(ranked[0]?.id).toBe("beta-two");
	});

	test("a role naming only the bare id still matches", () => {
		const ranked = rankCandidates([model("alpha-one"), model("beta-two")], { roles: { smol: "beta-two" } });
		expect(ranked[0]?.id).toBe("beta-two");
	});

	test("a role with a thinking suffix still matches", () => {
		const ranked = rankCandidates([model("alpha-one"), model("beta-two")], { roles: { smol: "prov/beta-two:auto" } });
		expect(ranked[0]?.id).toBe("beta-two");
	});

	test("a role pointing at a different provider does not promote a same-named model", () => {
		const ranked = rankCandidates([model("alpha-one"), model("beta-two", "other")], {
			roles: { smol: "prov/beta-two" },
		});
		expect(ranked[0]?.id).toBe("alpha-one");
	});

	test("names that signal a small model rank above unknown ones", () => {
		const models = [model("mystery-model"), model("claude-haiku-4-5"), model("another-mystery")];
		expect(ids(rankCandidates(models, { roles: {} }))[0]).toBe("claude-haiku-4-5");
	});

	test("every known cheap naming convention is recognized", () => {
		for (const id of ["x-haiku-1", "gpt-mini", "gemini-flash", "llama-lite", "gpt-luna", "phi-small"]) {
			const ranked = rankCandidates([model("mystery"), model(id)], { roles: {} });
			expect(ranked[0]?.id).toBe(id);
		}
	});

	/**
	 * The penalty targets an expensive sibling of the session model, not cheapness in general: picking
	 * another frontier model from the same family would make the reviewer cost as much as the work.
	 */
	test("an expensive sibling of the session model is pushed down", () => {
		const current = model("claude-opus-5");
		const models = [current, model("claude-opus-5-thinking"), model("unrelated-model")];
		const ranked = rankCandidates(models, {
			roles: {},
			current,
			family: candidate => (candidate.id.startsWith("claude") ? "claude" : candidate.id),
		});
		expect(ranked[0]?.id).toBe("unrelated-model");
	});

	test("a cheap sibling of the session model is still a fine suggestion", () => {
		const current = model("claude-opus-5");
		const models = [current, model("claude-haiku-4-5"), model("unrelated-model")];
		const ranked = rankCandidates(models, {
			roles: {},
			current,
			family: candidate => (candidate.id.startsWith("claude") ? "claude" : candidate.id),
		});
		expect(ranked[0]?.id).toBe("claude-haiku-4-5");
	});

	test("a trusted cheap role outranks the family penalty", () => {
		const current = model("claude-opus-5");
		const models = [current, model("claude-haiku-4-5"), model("unrelated")];
		const ranked = rankCandidates(models, {
			roles: { smol: "prov/claude-haiku-4-5" },
			current,
			family: candidate => (candidate.id.startsWith("claude") ? "claude" : candidate.id),
		});
		expect(ranked[0]?.id).toBe("claude-haiku-4-5");
	});

	test("the session model itself is never the top suggestion when anything else exists", () => {
		const current = model("claude-opus-5");
		const ranked = rankCandidates([current, model("other")], { roles: {}, current });
		expect(ranked[0]?.id).toBe("other");
	});

	test("every model is offered, so an unusual setup is not left with an empty list", () => {
		const models = [model("a"), model("b"), model("c")];
		expect(rankCandidates(models, { roles: {} }).length).toBe(3);
	});

	test("ranking is stable for equally ranked models", () => {
		const models = [model("m1"), model("m2"), model("m3")];
		expect(ids(rankCandidates(models, { roles: {} }))).toEqual(["m1", "m2", "m3"]);
	});

	test("an empty catalog ranks to an empty list rather than failing", () => {
		expect(rankCandidates([], { roles: {} })).toEqual([]);
	});

	test("a family function that throws does not break ranking", () => {
		const ranked = rankCandidates([model("a"), model("b")], {
			roles: {},
			current: model("a"),
			family: () => {
				throw new Error("catalog is unavailable");
			},
		});
		expect(ranked.length).toBe(2);
	});
});
