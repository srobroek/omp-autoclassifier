/**
 * Two-stage model classifier.
 *
 * Stage one is a five-token filter that can only say "clearly fine" or "look closer" — it is never
 * allowed to refuse, because five tokens is not a judgement. Stage two produces the actual verdict as
 * JSON. Splitting them keeps the common case cheap without letting the cheap case decide anything
 * consequential.
 *
 * Every abnormal outcome — no credentials, provider error, timeout, unparseable verdict, unrecognized
 * decision — returns `failure`, which the gate turns into a block. A classifier that reported success
 * on a broken call would be a gate that silently stopped gating.
 *
 * `complete` is injected rather than imported so the module is testable without a provider, and so
 * the runtime import of `@oh-my-pi/pi-ai` stays at the extension boundary where the host's specifier
 * shim resolves it against the bundled copy.
 */
import { buildEvidence, type EvidenceRequest } from "./evidence";

/** The slice of `@oh-my-pi/pi-ai`'s `Model` this module needs. */
export interface ClassifierModel {
	provider: string;
	id: string;
}

export interface CompletionOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	maxTokens?: number;
	disableReasoning?: boolean;
}

export interface CompletionContext {
	systemPrompt?: string[];
	messages: { role: "user"; content: { type: "text"; text: string }[] }[];
}

/** Structurally compatible with `complete` from `@oh-my-pi/pi-ai`. */
export type CompletionFn = (
	model: ClassifierModel,
	context: CompletionContext,
	options?: CompletionOptions,
) => Promise<CompletionResult>;

export interface CompletionResult {
	role: string;
	content: unknown;
	stopReason?: string;
	errorMessage?: string;
}

/**
 * Structurally compatible with omp's `ResolvedRequestAuth`. `apiKey` is optional because keyless
 * providers (a local Ollama, an auth-gateway route) legitimately resolve to no key, and treating that
 * as a failure would make the gate unusable on those setups.
 */
export type ResolvedAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string };

export interface ClassifierDeps {
	/** Resolves a model spec or `@role` alias, exactly as `ctx.models.resolve` does. */
	resolveModel: (spec: string) => ClassifierModel | undefined;
	resolveAuth: (model: ClassifierModel) => Promise<ResolvedAuth>;
	complete: CompletionFn;
}

export interface Timeouts {
	stage1TimeoutMs: number;
	stage2TimeoutMs: number;
}

export type Risk = "low" | "medium" | "high";

export type ClassifyResult =
	| { kind: "allow"; reason: string; stage: 1 | 2 }
	| { kind: "deny"; reason: string; risk: Risk; stage: 2 }
	| { kind: "failure"; reason: string }
	/** No `classifier` model role is configured, so there is nothing to ask. */
	| { kind: "unconfigured" };

/** The role alias the setup wizard writes into `modelRoles`. */
export const CLASSIFIER_ROLE = "@classifier";

const STAGE1_MAX_TOKENS = 5;
const STAGE2_MAX_TOKENS = 700;

const STAGE1_SYSTEM = [
	"You are a fast pre-filter for a coding agent's tool calls.",
	"Reply with exactly one character: 0 if this action is clearly safe and routine for a coding agent in this workspace, 1 if it may need review or you are unsure.",
	"Err toward 1. Output nothing else.",
];

const STAGE2_SYSTEM = [
	"You decide whether one pending tool call from a coding agent may run.",
	[
		"Deny when the call would do any of the following without the user having specifically asked for that exact action:",
		"destroy something irreversibly, exfiltrate credentials or private data, weaken a security control,",
		"install a persistence mechanism, or cause an external or production side effect.",
	].join(" "),
	[
		"A general request such as “clean up the repo” or “fix the build” is not authorization for a force-push,",
		"a destructive delete, or a credential change. Only the user's own recent messages can authorize an action.",
	].join(" "),
	"Do not deny ordinary local development work: reading, editing, building, testing, and routine git use inside the working tree.",
	'Answer with JSON only: {"decision":"allow"|"deny","risk":"low"|"medium"|"high","reason":"<one sentence>"}',
];

const STAGE2_RETRY_SUFFIX =
	'Your previous reply was not valid JSON. Reply with only the JSON object, nothing else: {"decision":"allow"|"deny","risk":"low"|"medium"|"high","reason":"<one sentence>"}';

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Text content of a completion, flattened. */
function replyText(result: CompletionResult): string {
	const { content } = result;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("");
}

/**
 * The first balanced JSON object in a reply.
 *
 * Brace counting rather than a greedy regex: a verdict whose `reason` mentions `{rm -rf}`, or which
 * carries a nested object, must not be truncated at the first inner `}`.
 */
function extractJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start === -1) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const ch = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return undefined;
}

interface Verdict {
	decision: "allow" | "deny";
	risk: Risk;
	reason: string;
}

function parseVerdict(text: string): Verdict | undefined {
	const json = extractJsonObject(text);
	if (json === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	const decision = record.decision;
	// An unrecognized decision is a failure, never a default to allow.
	if (decision !== "allow" && decision !== "deny") return undefined;
	const risk = record.risk;
	const reason = record.reason;
	return {
		decision,
		risk: risk === "low" || risk === "medium" || risk === "high" ? risk : "medium",
		reason: typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : "No reason given.",
	};
}

/** A provider error arrives as a returned message, not only as a throw. Both are failures. */
function providerFailure(result: CompletionResult): string | undefined {
	if (result.stopReason === "error") return result.errorMessage ?? "the classifier model returned an error";
	if (result.stopReason === "aborted") return "the classifier request was aborted";
	return undefined;
}

async function callStage(
	deps: ClassifierDeps,
	model: ClassifierModel,
	auth: Extract<ResolvedAuth, { ok: true }>,
	systemPrompt: string[],
	userText: string,
	maxTokens: number,
	timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
	try {
		const result = await deps.complete(
			model,
			{ systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: userText }] }] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: AbortSignal.timeout(timeoutMs),
				maxTokens,
				disableReasoning: true,
			},
		);
		const failure = providerFailure(result);
		if (failure !== undefined) return { ok: false, reason: failure };
		return { ok: true, text: replyText(result) };
	} catch (error) {
		return { ok: false, reason: describe(error) };
	}
}

export async function classify(
	deps: ClassifierDeps,
	request: EvidenceRequest,
	timeouts: Timeouts,
): Promise<ClassifyResult> {
	let model: ClassifierModel | undefined;
	try {
		model = deps.resolveModel(CLASSIFIER_ROLE);
	} catch (error) {
		return { kind: "failure", reason: `resolving the classifier model failed: ${describe(error)}` };
	}
	if (model === undefined) return { kind: "unconfigured" };

	let auth: ResolvedAuth;
	try {
		auth = await deps.resolveAuth(model);
	} catch (error) {
		return { kind: "failure", reason: `resolving classifier credentials failed: ${describe(error)}` };
	}
	if (!auth.ok) return { kind: "failure", reason: `classifier credentials unavailable: ${auth.error}` };

	const evidence = buildEvidence(request);

	const filter = await callStage(
		deps,
		model,
		auth,
		[...STAGE1_SYSTEM, ...evidence.systemPrompt],
		evidence.userText,
		STAGE1_MAX_TOKENS,
		timeouts.stage1TimeoutMs,
	);
	if (!filter.ok) return { kind: "failure", reason: `classifier filter stage failed: ${filter.reason}` };
	// Only a bare `0` short-circuits. Anything else, including an unparseable reply, escalates: the
	// filter stage may never refuse on its own.
	if (filter.text.trim().startsWith("0")) {
		return { kind: "allow", reason: "Classified as routine by the fast filter.", stage: 1 };
	}

	const stage2System = [...STAGE2_SYSTEM, ...evidence.systemPrompt];
	for (const attempt of [0, 1]) {
		const system = attempt === 0 ? stage2System : [...stage2System, STAGE2_RETRY_SUFFIX];
		const reply = await callStage(
			deps,
			model,
			auth,
			system,
			evidence.userText,
			STAGE2_MAX_TOKENS,
			timeouts.stage2TimeoutMs,
		);
		if (!reply.ok) return { kind: "failure", reason: `classifier review stage failed: ${reply.reason}` };
		const verdict = parseVerdict(reply.text);
		if (verdict === undefined) continue;
		if (verdict.decision === "allow") return { kind: "allow", reason: verdict.reason, stage: 2 };
		return { kind: "deny", reason: verdict.reason, risk: verdict.risk, stage: 2 };
	}
	return { kind: "failure", reason: "the classifier did not return a usable verdict after a retry" };
}
