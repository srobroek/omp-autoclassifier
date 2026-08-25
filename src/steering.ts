/**
 * Per-model steering: the middle layer between the shared policy and the user's own rules.
 *
 *   generic steering  ->  per-model additions  ->  rules for steering
 *
 * Why a layer rather than a fork. The prompt is the whole security policy, and every block in it closes a
 * hole a review found. Forking it per model leaves a hole closed for one model open in the others, with
 * nothing to report the divergence. A bounded addition keeps one policy and still lets a model that reads
 * it badly be corrected.
 *
 * What earns an entry here. A clause belongs to a model, not to the policy, when it was measured on that
 * model and on the model this gate recommends, and it moved the first without costing the second. Generic
 * strictness does not qualify: four escalating levels were measured on `claude-haiku-4-5` and moved nothing
 * at all, 1 escape and 7 held calls across every arm, while the same levels on `gpt-5.6-luna` traded about
 * one held call per escape removed. A clause that buys escapes with refusals is a preference, not a fix.
 *
 * The table is empty on purpose. Nothing measured so far has cut escapes at flat false positives, and a
 * plausible clause with no number behind it is what this project keeps having to revert.
 */
export interface ModelSteering {
	/** Matched against the resolved model id. Must not carry the `g` flag; see `steeringFor`. */
	pattern: RegExp;
	/** Lines appended to the filter prompt, which has sixteen tokens and answers one character. */
	stage1?: readonly string[];
	/** Lines appended to the review prompt, ahead of the user's rules and the schema. */
	stage2?: readonly string[];
}

export const MODEL_STEERING: readonly ModelSteering[] = Object.freeze([]);

/**
 * Every steering line that applies to `modelId`, split by stage. Entries accumulate, so a family-wide
 * pattern and a model-specific one both apply.
 *
 * `lastIndex` is reset before each test. A caller passing a `g`-flagged pattern would otherwise get
 * alternating answers for the same model, which is a bug this project has already shipped once.
 */
export function steeringFor(
	modelId: string,
	table: readonly ModelSteering[] = MODEL_STEERING,
): { stage1: readonly string[]; stage2: readonly string[] } {
	const stage1: string[] = [];
	const stage2: string[] = [];
	for (const entry of table) {
		entry.pattern.lastIndex = 0;
		if (!entry.pattern.test(modelId)) continue;
		if (entry.stage1 !== undefined) stage1.push(...entry.stage1);
		if (entry.stage2 !== undefined) stage2.push(...entry.stage2);
	}
	return { stage1, stage2 };
}
