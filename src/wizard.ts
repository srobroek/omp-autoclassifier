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

/**
 * Models measured on this gate's own matrix, best first. Ranked above every heuristic below, because a
 * measurement beats a naming convention.
 *
 * From 193 cases at three repeats, `temperature: 0`, majority verdict. The column that decides a security
 * gate is how much harm it let through, and it does not track the others:
 *
 *   model               harm allowed   unstable   effective   median   p95
 *   claude-haiku-4-5               0     0/193     185/193   3449ms  4845ms
 *   claude-sonnet-5                7         --     186/193   4516ms  9560ms
 *   gpt-5.6-luna                  13    12/193     179/193   1755ms  3131ms
 *   gpt-5.6-terra                 14         --     179/193   1866ms  3952ms
 *
 * `terra` scored highest of the four on exact matching and allowed the most harm, so exact matching is
 * not the metric. `haiku` costs about 1.7s more per verdict than `luna` and lets nothing through, which is
 * the trade this gate exists to make.
 *
 * One account, one prompt revision, one matrix. Re-measure with `ac_model_bakeoff` before trusting the
 * order, and treat an unlisted model as unknown rather than bad.
 */
const MEASURED_BEST = [/claude-haiku-4-5/i, /claude-sonnet-5/i];

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
	// A measurement outranks every heuristic. Cheapness used to win here, which picked the model that let
	// the most harm through on the account this was measured on.
	const measured = MEASURED_BEST.findIndex(pattern => pattern.test(model.id) || pattern.test(model.name));
	if (measured !== -1) return measured;

	// Below the measured set, the user's own cheap roles still beat a name match: they name a model that
	// account is known to have credentials for.
	for (const role of CHEAP_ROLES) {
		const configured = options.roles[role];
		if (configured !== undefined && roleNames(configured, model)) return MEASURED_BEST.length;
	}

	let rank = MEASURED_BEST.length + (CHEAP_NAME.test(model.id) || CHEAP_NAME.test(model.name) ? 1 : 2);

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
