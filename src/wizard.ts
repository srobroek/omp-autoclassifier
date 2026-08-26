/**
 * Setup wizard support: choosing which model should judge tool calls.
 *
 * The gate refuses to guess. Without an explicit `classifier` model role it stays inactive and says so,
 * because silently borrowing the session model would bill a frontier model for every tool call and make the
 * reviewer as expensive as the work it reviews.
 *
 * Ranking used to be a pile of heuristics — cheap-sounding names, the user's own `smol` role, a penalty for
 * siblings of the session model — because the picker could offer anything. It can now offer only the two
 * releases in {@link PROVIDER_RULES}, so the order is just the order the matrix measured them in, and the
 * heuristics went with the models they were guessing about.
 */
import { type CatalogModel, isTestedModel, TESTED_MODEL_NAMES, testedModel } from "./models";

/** The slice of omp's `Model` the wizard needs. */
export type WizardModel = CatalogModel;

/**
 * Offerable candidates, best first, and empty when the account holds neither release.
 *
 * Empty is a real answer here, not a degenerate one: the caller turns it into a hard error rather than an
 * empty picker. The replaced behaviour offered the whole catalog in that case, which is how an unmeasured
 * reviewer would have reached an account with neither release.
 *
 * Ties keep catalog order, so an account exposing the same release through two providers sees a stable list
 * and picks the route it holds credentials for. That falls out of `sort` being stable, which the language
 * has guaranteed since ES2019 — an explicit index tiebreaker sat here until a mutation showed it could be
 * deleted without any test noticing, because it never changed an answer.
 */
export function rankCandidates(models: readonly WizardModel[]): WizardModel[] {
	return models
		.filter(model => isTestedModel(model))
		.map(model => ({ model, rank: TESTED_MODEL_NAMES.indexOf(testedModel(model)!) }))
		.sort((a, b) => a.rank - b.rank)
		.map(entry => entry.model);
}

/** How a candidate is presented in the picker. */
export function describeCandidate(model: WizardModel): string {
	return `${model.provider}/${model.id}`;
}

export const SKIP_LABEL = "Skip for now — leave the gate inactive";
