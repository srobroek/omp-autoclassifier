/**
 * Setup wizard support: choosing which model should judge tool calls.
 *
 * The gate refuses to guess. Without an explicit `classifier` model role it stays inactive and says so,
 * because silently borrowing the session model would bill a frontier model for every tool call and
 * would make the reviewer as expensive as the work it reviews.
 *
 * Ranking is separated from the dialog so the choice logic is testable without a UI.
 */

/** The slice of omp's `Model` the wizard needs. */
export interface WizardModel {
	id: string;
	provider: string;
	name: string;
}

export interface RankOptions {
	/** `modelRoles` as configured, so a model the user already trusts for cheap work ranks first. */
	roles: Record<string, string>;
	current?: WizardModel;
	/** omp's opaque family token, used to avoid suggesting a sibling of the expensive session model. */
	family?: (model: WizardModel) => string;
}

/** Roles that already mean "the cheap one" in omp's own vocabulary. */
const CHEAP_ROLES = ["smol", "tiny"];

/** Naming conventions vendors use for their small models. */
const CHEAP_NAME = /haiku|mini|flash|lite|luna|small|nano|turbo/i;

/**
 * Does a `modelRoles` value refer to this model? Values may be `provider/id`, a bare `id`, or either
 * with a thinking or routing suffix (`:auto`, `:high`).
 */
function roleNames(value: string, model: WizardModel): boolean {
	const withoutSuffix = value.split(":")[0] ?? value;
	return withoutSuffix === `${model.provider}/${model.id}` || withoutSuffix === model.id;
}

/** Lower sorts first. */
function score(model: WizardModel, options: RankOptions): number {
	for (const role of CHEAP_ROLES) {
		const configured = options.roles[role];
		if (configured !== undefined && roleNames(configured, model)) return 0;
	}

	let rank = CHEAP_NAME.test(model.id) || CHEAP_NAME.test(model.name) ? 1 : 2;

	const current = options.current;
	if (current !== undefined) {
		if (current.id === model.id && current.provider === model.provider) return rank + 2;
		if (options.family !== undefined) {
			try {
				if (options.family(current) === options.family(model)) rank += 1;
			} catch {
				// A catalog that cannot answer the family question just forfeits this refinement.
			}
		}
	}
	return rank;
}

/** Every model, best candidate first. Ties keep catalog order so the list does not shuffle per call. */
export function rankCandidates(models: readonly WizardModel[], options: RankOptions): WizardModel[] {
	return models
		.map((model, index) => ({ model, index, score: score(model, options) }))
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.map(entry => entry.model);
}

/** How a candidate is presented in the picker. */
export function describeCandidate(model: WizardModel): string {
	return `${model.provider}/${model.id}`;
}

export const SKIP_LABEL = "Skip for now — leave the gate inactive";
