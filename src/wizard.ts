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
 * Models confirmed on this gate's own matrix, best first. Ranked above every heuristic below, because a
 * measurement beats a naming convention.
 *
 * Entry requires the full matrix: 193 cases, three repeats, `temperature: 0`, the shipped request shape.
 * Short runs do not qualify a model however good they look, and that rule has already earned its keep.
 *
 * Measured, 579 verdicts each. The column that decides a security gate is how much harm it allowed:
 *
 *   model               harm allowed   wrong   median   $/1k verdicts
 *   claude-haiku-4-5               3      27   2322ms          $2.83
 *   llama4-scout                  30      69   1194ms          $0.51
 *   gpt-5.6-luna                  35      42   2216ms          $0.47
 *
 * `llama4-scout` is the reason for the entry rule. Over 33 cases it allowed **nothing** through, at half
 * haiku's latency and a fifth of its cost, and it topped every short ranking. Over 193 it allows ten times
 * as much harm as haiku. The short sample did not contain the calls it gets wrong, and no amount of repeats
 * would have found them, because repeats resample the same prompts.
 *
 * `haiku` costs five times more per verdict and is the only entry. A gate that lets thirty dangerous calls
 * through is not cheaper, it is broken.
 *
 * **The list is ordered, not universal.** `haiku` is an Anthropic model, so an account without Anthropic
 * credentials never matches it and falls through to the heuristics below. That is the intended degradation
 * and also a real gap. No OpenAI model qualifies:
 *
 *   gpt-5.6-luna    35 of 193, three repeats   confirmed, disqualifying
 *   gpt-5.6-terra   14 of a 33-case sample     unconfirmed, and 33 cases means nothing here
 *
 * Do not read terra's 14 as better than luna's 35. `llama4-scout` allowed nothing over 33 cases and thirty
 * over 193, so a 33-case figure carries no information about full-matrix behaviour. An OpenAI-only account
 * gets a heuristic pick, and finding a measured model for that case is open work.
 *
 * One account, one prompt revision, one matrix. Re-measure with `ac_rank` at `sample 1, repeats 3` before
 * trusting the order, and treat an unlisted model as unknown rather than bad.
 */
const MEASURED_BEST = [/claude-haiku-4-5/i];

/**
 * Models the full matrix disqualified, so no heuristic may promote them. Measured on 193 cases at three
 * repeats, escapes of 579 verdicts, against `claude-haiku-4-5` at 3 on the same cases:
 *
 *   gpt-5.6-luna      35
 *   llama4-scout      30
 *   claude-sonnet-5   25, plus 18 unparseable verdicts
 *
 * `luna` sat in the cheap-name list below until this ran, which made the naming convention promote the
 * worst reviewer in the field. A measurement decides in both directions or it is not being used.
 */
const MEASURED_WORST = [/gpt-5\.6-luna/i, /llama4-scout/i, /claude-sonnet-5/i];

/**
 * The two families this gate supports reviewing with. A model outside them is not offered, because the
 * matrix has only ever confirmed a reviewer inside them.
 *
 * An account holding neither still gets the unfiltered list rather than an empty picker: offering nothing
 * would leave the gate unconfigurable, which is worse than offering an unmeasured model and saying so.
 */
const SUPPORTED_FAMILY = /claude|anthropic|gpt|openai/i;

/** Roles that already mean "the cheap one" in omp's own vocabulary. */
const CHEAP_ROLES = ["smol", "tiny"];

/** Naming conventions vendors use for their small models. */
const CHEAP_NAME = /haiku|mini|flash|lite|small|nano|turbo/i;

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

	// Before the cheap-role promotion, not after: a `smol` role pointing at a disqualified model would
	// otherwise lift it straight to the top of the picker.
	if (MEASURED_WORST.some(pattern => pattern.test(model.id) || pattern.test(model.name))) {
		return MEASURED_BEST.length + 4;
	}
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

/**
 * Supported candidates, best first. Ties keep catalog order so the list does not shuffle per call.
 *
 * An account with no Anthropic or OpenAI model keeps the whole catalog instead of an empty picker.
 */
export function rankCandidates(models: readonly WizardModel[], options: RankOptions): WizardModel[] {
	const supported = models.filter(model => SUPPORTED_FAMILY.test(model.id) || SUPPORTED_FAMILY.test(model.provider));
	const offered = supported.length > 0 ? supported : models;
	return offered
		.map((model, index) => ({ model, index, score: score(model, options) }))
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.map(entry => entry.model);
}

/** How a candidate is presented in the picker. */
export function describeCandidate(model: WizardModel): string {
	return `${model.provider}/${model.id}`;
}

export const SKIP_LABEL = "Skip for now — leave the gate inactive";
