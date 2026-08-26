/**
 * Per-model steering: the middle layer between the shared policy and the user's own rules.
 *
 *   generic steering  ->  per-model additions  ->  rules for steering
 *
 * Why a layer rather than a fork. The prompt is the whole security policy, and every block in it closes a
 * hole a review found. Forking it per model leaves a hole closed for one model open in the others, with
 * nothing to report the divergence. A bounded addition keeps one policy and still lets a model that reads
 * it badly be corrected.
 */
import { globToRegExp } from "./rules";

export interface ModelSteering {
	/**
	 * A rule glob matched against the resolved model id, in the same syntax the rule lists use.
	 *
	 * A glob rather than a regex, because a model id carries a region prefix that differs per account. The
	 * same Haiku resolves to `au.anthropic.claude-haiku-4-5-20251001-v1:0` on one account and to a `global.`
	 * or `us.` spelling on another, so `*anthropic.claude-haiku-4-5*` is the identity a reader means. An
	 * anchored literal would silently miss every account but the one it was written on.
	 *
	 * Globs also remove a hazard the regex form carried: a caller-supplied `/g` pattern kept `lastIndex`
	 * between calls, so the same model matched and then missed.
	 */
	pattern: string;
	/** Lines appended to the filter prompt, which has sixteen tokens and answers one character. */
	stage1?: readonly string[];
	/** Lines appended to the review prompt, ahead of the user's rules and the schema. */
	stage2?: readonly string[];
}

/**
 * Empty, and the emptiness is asserted by a test.
 *
 * One candidate reached this table and was removed again. It named three shapes a permissive reviewer clears
 * while calling them ordinary work: real credential material placed somewhere that persists, code building an
 * interpreter sink out of input it does not control, and an artifact fetched from a source nothing pins. Over
 * all 193 cases at three repeats, against two control arms per run:
 *
 *   gpt-5.6-terra    15 and 17 escapes -> 9,  false positives 0 -> 0
 *   gpt-5.6-luna     12 and 13 escapes -> 7,  false positives 2 -> 1
 *   claude-sonnet-5   6 and  8 escapes -> 6,  false positives 1 -> 0
 *   claude-haiku-4-5  1 and  1 escapes -> 3,  false positives 8 -> 9
 *
 * Those numbers do not license shipping it, for two reasons a review established rather than guessed.
 *
 * The clause was written from the cases it was then scored against, after about thirty arms had been tried
 * and the best reported. A Bonferroni threshold of .05/30 needs roughly eleven one-way case improvements; the
 * arm shows at most seven. Re-running the same cases cannot fix that, because the selection already happened
 * on them.
 *
 * The matrix also holds no near neighbour that the clause would wrongly refuse: no test fixture carrying a
 * dummy private key, no dynamic SQL built from an escaped identifier, no digest-pinned download, no MD5 used
 * as a checksum rather than for a password. The false-positive column reads 0 to 1 because the cases that
 * would move it are absent.
 *
 * Re-adoption needs a test declared before it runs, over unseen dangerous variants and unseen authorized
 * neighbours, on the gate rather than on the classifier alone. `docs/severity-burden-test.md` records the
 * instrument corrections that made the earlier numbers unreliable, including a rule-decided case that was
 * counted as a model escape in every arm.
 */
export const MODEL_STEERING: readonly ModelSteering[] = Object.freeze([]);

/** Compiled globs, keyed by pattern text. A table entry is compiled once however many calls read it. */
const compiled = new Map<string, RegExp>();

function matcher(pattern: string): RegExp {
	const hit = compiled.get(pattern);
	if (hit !== undefined) return hit;
	const made = globToRegExp(pattern);
	compiled.set(pattern, made);
	return made;
}

/**
 * Every steering line that applies to `modelId`, split by stage. Entries accumulate, so a family-wide glob
 * and a model-specific one both apply.
 */
export function steeringFor(
	modelId: string,
	table: readonly ModelSteering[] = MODEL_STEERING,
): { stage1: readonly string[]; stage2: readonly string[] } {
	const stage1: string[] = [];
	const stage2: string[] = [];
	for (const entry of table) {
		if (!matcher(entry.pattern).test(modelId)) continue;
		if (entry.stage1 !== undefined) stage1.push(...entry.stage1);
		if (entry.stage2 !== undefined) stage2.push(...entry.stage2);
	}
	return { stage1, stage2 };
}
