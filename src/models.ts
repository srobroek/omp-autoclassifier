/**
 * Which models may review a tool call.
 *
 * The gate reviews with exactly two releases because exactly two were measured on its own matrix: on 193
 * cases at three repeats, `claude-haiku-4-5` (20251001) let nothing dangerous through and `gpt-5.6-luna`
 * leaked eleven to thirteen of a hundred and fifteen. Every other model is unmeasured here, and an
 * unmeasured reviewer is indistinguishable from no reviewer until something gets through it.
 *
 * Four properties this table exists to hold.
 *
 * **Every provider that offers either model gets a rule.** The gate is not Bedrock-specific: Anthropic,
 * OpenAI, OpenRouter and Vertex each sell one of these two and each spells it differently.
 *
 * **Only an exactly pinned id passes.** A floating alias is refused, including the undated
 * `claude-haiku-4-5` that most providers also publish, because a vendor may repoint an alias to new weights
 * and the gate would then claim a measurement it never made. Where a provider publishes only a floating
 * alias, that route is unusable here by design rather than accepted as if pinned. The one documented
 * exception is luna, which carries no date in any id on any route observed — the name is the whole version,
 * and that limit is recorded rather than papered over.
 *
 * **Patterns are per provider and anchored.** A single loose pattern has to be loose enough to match every
 * spelling at once, which is how `gpt-5.6-luna-fast` — a different model on a different route — matches a
 * pattern written for `gpt-5.6-luna`. A table also localises cross-region inference: only the Bedrock rules
 * carry a region prefix, because only Bedrock has one.
 *
 * **Reachability is labelled, not implied.** A rule is `observed` when this account resolves a matching id
 * today, verified by dumping the live catalog, and `documented` when the grammar comes from the vendor's
 * published id format but no such model is reachable here.
 *
 * Azure needs one clarification, because a deployment name looks like it defeats pinning and does not.
 * `resolveDeploymentName` in the installed adapter takes routing from `azureDeploymentName`, then from an
 * `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` keyed by `model.id`, and only falls back to `model.id` itself. The
 * custom name is routing metadata; `model.id` stays the canonical model. So Azure is matched on `model.id`
 * like every other provider, and an entry carrying only an opaque deployment name matches nothing and is
 * refused.
 */

/** The slice of omp's `Model` an allowlist decision needs. */
export interface CatalogModel {
	provider: string;
	id: string;
	name?: string;
}

/**
 * The measured releases. This block is the pin: changing a line here claims a measurement that has to
 * exist, so a bump belongs with a matrix run rather than a dependency update.
 */
const MEASURED = Object.freeze({
	/** Anthropic's release date for the measured haiku, as it appears in provider ids. */
	haikuDate: "20251001",
	/** The hyphenated spelling most providers use. */
	haiku: "claude-haiku-4-5",
	/** OpenRouter's dotted spelling of the same release. */
	haikuDotted: "claude-haiku-4.5",
	/**
	 * OpenAI's luna release. No provider observed publishes a dated snapshot of it, so this name is the
	 * tightest available pin. If a dated id appears, it belongs here and the patterns should require it.
	 */
	luna: "gpt-5.6-luna",
	/** Bedrock's packaging revision for the measured haiku, pinned with the date it was measured against. */
	bedrockRevision: "v1:0",
});

/** The two models the matrix measured, in the order it ranked them. */
export const TESTED_MODEL_NAMES = [MEASURED.haiku, MEASURED.luna] as const;

export type TestedModel = (typeof TESTED_MODEL_NAMES)[number];

interface ModelPattern {
	model: TestedModel;
	id: RegExp;
}

interface ProviderRule {
	/** Anchored against `Model.provider`. */
	provider: RegExp;
	/** True when this account resolves an id matching one of the patterns below. */
	observed: boolean;
	patterns: readonly ModelPattern[];
}

/** Escape a literal for embedding in a pattern: these contain `.`, which is otherwise a wildcard. */
function lit(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

const HAIKU = lit(MEASURED.haiku);
const HAIKU_DOTTED = lit(MEASURED.haikuDotted);
const HAIKU_DATE = lit(MEASURED.haikuDate);
const LUNA = lit(MEASURED.luna);
const REVISION = lit(MEASURED.bedrockRevision);

/**
 * Cross-region inference prefixes Bedrock prepends to a vendor-qualified id. `us-gov` carries a hyphen, so
 * a `[a-z]{2}` class silently refuses it. Unprefixed ids exist in the same catalog, so it is optional —
 * this varies the route to identical weights, not the weights.
 */
const BEDROCK_REGION = String.raw`(?:(?:us|eu|jp|au|us-gov|global)\.)?`;

export const PROVIDER_RULES: readonly ProviderRule[] = Object.freeze([
	{
		// Observed: `global.anthropic.claude-haiku-4-5-20251001-v1:0`, `global.openai.gpt-5.6-luna`.
		provider: /^amazon-bedrock$/,
		observed: true,
		patterns: [
			{
				model: MEASURED.haiku,
				id: new RegExp(String.raw`^${BEDROCK_REGION}anthropic\.${HAIKU}-${HAIKU_DATE}-${REVISION}$`),
			},
			{ model: MEASURED.luna, id: new RegExp(String.raw`^${BEDROCK_REGION}openai\.${LUNA}$`) },
		],
	},
	{
		// Observed: `openai.gpt-5.6-luna` on an `openai-responses` api. Vendor-qualified, never region-prefixed.
		provider: /^bedrock-mantle$/,
		observed: true,
		patterns: [{ model: MEASURED.luna, id: new RegExp(String.raw`^openai\.${LUNA}$`) }],
	},
	{
		// Documented. The dated id only: Anthropic also publishes the undated alias, which is refused.
		provider: /^anthropic$/,
		observed: false,
		patterns: [{ model: MEASURED.haiku, id: new RegExp(String.raw`^${HAIKU}-${HAIKU_DATE}$`) }],
	},
	{
		// Documented. Luna's name is its version; see MEASURED.luna.
		provider: /^openai$/,
		observed: false,
		patterns: [{ model: MEASURED.luna, id: new RegExp(String.raw`^${LUNA}$`) }],
	},
	{
		// Documented. OpenRouter namespaces by vendor and does not publish a dated Anthropic id at all: its
		// models API lists `anthropic/claude-haiku-4.5`, carrying the date only in `canonical_slug`. So the
		// versioned slug is this provider's pin — `4.5` and `5.6-luna` are the version — and requiring a date
		// here would have refused every real OpenRouter id while claiming the route was supported. Variant
		// suffixes (`:free`, `:nitro`, `:online`) are refused, because they change which upstream serves the
		// call.
		provider: /^openrouter$/,
		observed: false,
		patterns: [
			{ model: MEASURED.haiku, id: new RegExp(String.raw`^anthropic\/${HAIKU_DOTTED}$`) },
			{ model: MEASURED.luna, id: new RegExp(String.raw`^openai\/${LUNA}$`) },
		],
	},
	{
		// Documented. Vertex pins with `@`, and the model garden uses a publisher path. The bare alias is
		// refused for the same reason as Anthropic's.
		provider: /^(?:google|google-vertex|vertex-adc|vertex-claude-api)$/,
		observed: false,
		patterns: [
			{
				model: MEASURED.haiku,
				id: new RegExp(String.raw`^(?:publishers\/anthropic\/models\/)?${HAIKU}@${HAIKU_DATE}$`),
			},
		],
	},
	{
		// Documented. Matched on the canonical `model.id`, which the adapter keeps distinct from deployment
		// routing; the three identifiers are the ones the installed provider actually uses. Azure OpenAI
		// carries the OpenAI catalogue, so luna only.
		provider: /^(?:azure|azure-responses|azure-openai-responses)$/,
		observed: false,
		patterns: [{ model: MEASURED.luna, id: new RegExp(String.raw`^${LUNA}$`) }],
	},
]);

/**
 * omp's thinking suffix selects an effort level, not a different model, and the resolver discards it before
 * an extension sees the id — but a raw `modelRoles` value still carries one, and this account's does.
 *
 * Only these exact levels are stripped. Stripping any non-numeric tail instead would swallow OpenRouter's
 * routing variants, so `anthropic/claude-haiku-4.5:free` would have been read as the plain slug and
 * accepted, silently routing review to whichever upstream that variant resolves to. Bedrock's numeric
 * revision tail is left alone for free, since no level is numeric.
 */
const THINKING_SUFFIX = /:(?:auto|minimal|low|medium|high|xhigh|max)$/;

/** Which tested model is this, if any? */
export function testedModel(model: CatalogModel): TestedModel | undefined {
	const id = model.id.replace(THINKING_SUFFIX, "");
	for (const rule of PROVIDER_RULES) {
		if (!rule.provider.test(model.provider)) continue;
		for (const pattern of rule.patterns) {
			if (pattern.id.test(id)) return pattern.model;
		}
	}
	return undefined;
}

export function isTestedModel(model: CatalogModel): boolean {
	return testedModel(model) !== undefined;
}

/**
 * Raised when the account holds neither tested release. The gate refuses to run rather than reviewing with
 * an unmeasured model, and this is the error that says so.
 */
export class NoTestedModelError extends Error {
	constructor() {
		super(
			`autoclassifier cannot run: this account has neither release this gate is tested with ` +
				`(${TESTED_MODEL_NAMES.join(", ")}). Reviewing with an untested model is refused, because its ` +
				`escape rate on this gate's matrix is unknown. Add access through any provider that publishes a ` +
				`version-pinned id for one of the two, then run \`/autoclassifier setup\`.`,
		);
		this.name = "NoTestedModelError";
	}
}

/** The reason text for a configured role that names a model outside the allowlist. */
export function untestedRoleReason(configured: string): string {
	return (
		`the configured classifier model \`${configured}\` is not one of the two releases this gate is tested ` +
		`with (${TESTED_MODEL_NAMES.join(", ")}); it is refused rather than trusted, because its escape rate ` +
		`here is unmeasured. An undated alias of a tested model is refused too, since a vendor may repoint ` +
		`it. Run \`/autoclassifier setup\` to choose a tested model.`
	);
}
