/**
 * The gate: one decision per tool call.
 *
 * The ordering below *is* the security contract. Each step is placed deliberately, and an early return
 * in the wrong place is a silent hole:
 *
 *   1. kill-switch env var — the documented way out of a lockout, so it must be total
 *   2. `enabled: false`    — an explicit user opt-out, equally total
 *   3. hardDeny            — anti-tamper, above the mode filter and the breaker, so the gate's own
 *                            config cannot be edited during a window when the gate is not watching
 *   4. inactive mode       — convenience only; never reached by anti-tamper
 *   5. paused breaker      — same
 *   6. deny / allow rules  — deterministic, no model call
 *   7. cached allow
 *   8. subagents with classification disabled
 *   9. ask rules           — escalate when there is a UI, otherwise block
 *  10. the classifier      — failure blocks
 *
 * Everything that is not an explicit allow ends in a block, and a block carries a reason the model
 * reads as a tool error.
 */
import type { VerdictCache } from "./cache";
import type { ClassifyResult, Timeouts } from "./classifier";
import type { EffectiveConfig } from "./config";
import { DISABLE_ENV_VAR } from "./defaults";
import type { EvidenceRequest, TranscriptEntry } from "./evidence";
import { evaluateRules, type RuleMatch } from "./rules";
import type { GateState } from "./state";

export interface GateRequest {
	toolName: string;
	input: unknown;
	/** False in print, RPC, and subagent sessions, where no dialog can be shown. */
	hasUI: boolean;
	approvalMode: string;
}

/** What the user chose at an escalation prompt. */
export type EscalationChoice = "once" | "session" | "deny";

export interface DecisionRecord {
	timestamp: string;
	toolName: string;
	decision: "allow" | "block";
	via: Via;
	reason?: string;
	rule?: string;
	/** The concrete path or argument the rule matched, so a reader can see what tripped it. */
	target?: string;
	risk?: string;
	stage?: number;
	hasUI: boolean;
}

export interface GateDeps {
	config: () => EffectiveConfig;
	state: GateState;
	cache: VerdictCache;
	cwd: string;
	branch: () => readonly TranscriptEntry[];
	env: (name: string) => string | undefined;
	classify: (request: EvidenceRequest, timeouts: Timeouts) => Promise<ClassifyResult>;
	escalate: (toolName: string, reason: string) => Promise<EscalationChoice>;
	/**
	 * Ask an interactive session on behalf of a headless one. Absent means a subagent cannot escalate and
	 * a would-be prompt becomes a block.
	 */
	escalateViaParent?: (toolName: string, reason: string) => Promise<EscalationChoice>;
	notify: (message: string, level: "info" | "warning" | "error") => void;
	reportChildDenial: (toolName: string, reason: string) => void;
	log: (record: DecisionRecord) => void;
}

/** How a decision was reached. Surfaced in the block reason, the audit log, and `/autoclassifier`. */
export type Via =
	| "env-disabled"
	| "disabled"
	| "hardDeny"
	| "inactive-mode"
	| "paused"
	| "deny"
	| "allow"
	| "cached"
	| "subagent-exempt"
	| "ask"
	| "escalated"
	| "classifier"
	| "unconfigured"
	| "failure";

export type GateDecision = { action: "allow"; via: Via } | { action: "block"; via: Via; reason: string };

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A refusal the reader can act on without asking anyone.
 *
 * The reason string is the entire interface of a block: the model reads it as a tool error and the user
 * reads it on screen. Naming only the rule pattern leaves `<agentDir>` placeholders on the screen and no
 * way to tell a shipped rule from one the user wrote, so this states the tool, the concrete target, the
 * rule, and where the rule came from.
 */
function explain(cfg: EffectiveConfig, match: RuleMatch, toolName: string, guidance: string[]): string {
	const label = match.list === "hardDeny" ? "anti-tamper rule" : `${match.list} rule`;
	const origin = cfg.origins[`rules.${match.list}`] ?? "default";
	const source = origin === "default" ? "shipped default" : origin;
	const subject = match.target === undefined ? `\`${toolName}\`` : `\`${toolName}\` on ${match.target}`;
	return [
		`autoclassifier blocked ${subject}.`,
		`It matched the ${label} \`${match.source}\` (${source}).`,
		...guidance,
	].join(" ");
}

export async function decide(deps: GateDeps, request: GateRequest): Promise<GateDecision> {
	const cfg = deps.config();
	const { toolName, input, hasUI } = request;

	// Bypasses, before any bookkeeping: a bypassed call was never gated, so counting it would misreport
	// coverage.
	if (deps.env(DISABLE_ENV_VAR) === "1") return { action: "allow", via: "env-disabled" };
	if (!cfg.enabled) return { action: "allow", via: "disabled" };

	const match = evaluateRules(cfg.compiled, toolName, input, deps.cwd);

	// Anti-tamper outranks the mode filter and the breaker on purpose. If either lifted it, the agent
	// could disable the gate in exactly the window where nothing is watching.
	if (match?.list === "hardDeny") {
		return finish(
			deps,
			request,
			{
				action: "block",
				via: "hardDeny",
				reason: explain(cfg, match, toolName, [
					"Anti-tamper rules cover the settings that govern this gate, so the agent it gates cannot edit them.",
					"Ask the user to make this change. Do not attempt another route to it.",
				]),
			},
			{ rule: match.source, target: match.target },
		);
	}

	const activeModes = cfg.activeModes.split(",").map(mode => mode.trim());
	if (!activeModes.includes(request.approvalMode)) return { action: "allow", via: "inactive-mode" };
	if (deps.state.paused) return { action: "allow", via: "paused" };

	if (match?.list === "deny") {
		return finish(
			deps,
			request,
			{
				action: "block",
				via: "deny",
				reason: explain(cfg, match, toolName, [
					"Tell the user which rule refused this. Do not attempt another route to the same effect.",
				]),
			},
			{ rule: match.source, target: match.target },
		);
	}
	if (match?.list === "allow") {
		return finish(deps, request, { action: "allow", via: "allow" }, { rule: match.source });
	}
	if (deps.cache.isAllowed(toolName, input)) {
		return finish(deps, request, { action: "allow", via: "cached" }, {});
	}
	if (!hasUI && !cfg.classifySubagents) {
		return finish(deps, request, { action: "allow", via: "subagent-exempt" }, {});
	}

	if (match?.list === "ask") {
		return await resolveAsk(
			deps,
			request,
			"ask",
			`autoclassifier: \`${match.source}\` requires confirmation for this call.`,
			{ rule: match.source },
		);
	}

	let verdict: ClassifyResult;
	try {
		verdict = await deps.classify(
			{
				branch: deps.branch(),
				cwd: deps.cwd,
				toolName,
				input,
				environment: cfg.environment,
				limits: cfg.evidence,
				includeToolResults: cfg.includeToolResults,
			},
			{ stage1TimeoutMs: cfg.stage1TimeoutMs, stage2TimeoutMs: cfg.stage2TimeoutMs },
		);
	} catch (error) {
		verdict = { kind: "failure", reason: describe(error) };
	}

	if (verdict.kind === "unconfigured") {
		if (deps.state.shouldNotice("unconfigured")) {
			deps.notify(
				"autoclassifier is inactive: no `classifier` model role is configured. Run `/autoclassifier setup` to choose one.",
				"warning",
			);
		}
		return finish(deps, request, { action: "allow", via: "unconfigured" }, {});
	}

	if (verdict.kind === "failure") {
		// `recordFailure` already counts this as a denial, so the emit below must not count it again.
		deps.state.recordFailure(verdict.reason);
		if (!hasUI) deps.reportChildDenial(toolName, verdict.reason);
		const decision: GateDecision = {
			action: "block",
			via: "failure",
			reason: `autoclassifier blocked \`${toolName}\`: the risk classifier could not reach a verdict (${verdict.reason}). The gate fails closed, so the call did not run. Tell the user and do not retry.`,
		};
		// Announced on every blocked call, not once per session. A degraded gate refuses everything, and
		// a single early warning would leave every later refusal unexplained on screen.
		if (hasUI) deps.notify(decision.reason, "error");
		emit(deps, request, decision, { reason: verdict.reason });
		return decision;
	}

	if (verdict.kind === "allow") {
		deps.cache.allow(toolName, input);
		return finish(deps, request, { action: "allow", via: "classifier" }, { stage: verdict.stage });
	}

	return await resolveAsk(
		deps,
		request,
		"classifier",
		`autoclassifier: blocked as ${verdict.risk} risk. ${verdict.reason}`,
		{ risk: verdict.risk, stage: verdict.stage, reason: verdict.reason },
	);
}

/**
 * Turn a would-be denial into a prompt when the user asked for that and a UI exists. In a headless
 * session this always blocks: omp's no-op UI answers `select` with `undefined`, which must never read
 * as consent.
 */
async function resolveAsk(
	deps: GateDeps,
	request: GateRequest,
	via: Extract<Via, "ask" | "classifier">,
	reason: string,
	extra: Partial<DecisionRecord>,
): Promise<GateDecision> {
	const cfg = deps.config();
	if (cfg.escalate) {
		// A headless session has no dialog of its own, so it borrows an interactive one through the
		// module-level registry. That beats a flat refusal: the person who started the work is the one who
		// should answer, and they cannot see the subagent's transcript.
		const ask = request.hasUI ? deps.escalate : deps.escalateViaParent;
		if (ask !== undefined) {
			let choice: EscalationChoice;
			try {
				choice = await ask(request.toolName, reason);
			} catch {
				choice = "deny";
			}
			if (choice !== "deny") {
				if (choice === "session") deps.cache.allow(request.toolName, request.input);
				return finish(deps, request, { action: "allow", via: "escalated" }, extra);
			}
		}
	}
	const blockVia: Via = via === "ask" ? "ask" : "classifier";
	if (!request.hasUI) deps.reportChildDenial(request.toolName, extra.reason ?? reason);
	return finish(deps, request, { action: "block", via: blockVia, reason }, extra);
}

function record(
	request: GateRequest,
	decision: "allow" | "block",
	via: Via,
	extra: Partial<DecisionRecord>,
): DecisionRecord {
	return {
		timestamp: new Date().toISOString(),
		toolName: request.toolName,
		decision,
		via,
		hasUI: request.hasUI,
		...extra,
	};
}

/**
 * Write one audit record, honoring `logDecisions`.
 *
 * Separate from counting because the classifier-failure path counts through `recordFailure`, and a
 * second count there would double-charge the breaker.
 */
function emit(deps: GateDeps, request: GateRequest, decision: GateDecision, extra: Partial<DecisionRecord>): void {
	if (!deps.config().logDecisions) return;
	deps.log(
		record(request, decision.action, decision.via, {
			...extra,
			...(decision.action === "block" ? { reason: extra.reason ?? decision.reason } : {}),
		}),
	);
}

/**
 * Decision paths where a model produced the verdict. Everything else was decided by a static rule, the
 * cache, or a switch, and is counted separately so `/autoclassifier status` can show the split.
 */
const MODEL_DECIDED: Partial<Record<Via, true>> = { classifier: true, escalated: true, failure: true };

/**
 * Count it, announce it, log it, return it. Every gated decision goes through here so none can skip
 * bookkeeping.
 *
 * A block also notifies the user. Returning the reason to the model alone makes a refusal invisible on
 * screen: the agent simply changes course and the person watching has no idea the gate intervened. In a
 * headless session the notification is skipped, because the cross-session registry already reports it
 * to whoever can actually see a message.
 */
function finish(
	deps: GateDeps,
	request: GateRequest,
	decision: GateDecision,
	extra: Partial<DecisionRecord>,
): GateDecision {
	const attribution = { classified: MODEL_DECIDED[decision.via] === true };
	if (decision.action === "allow") deps.state.recordAllow(attribution);
	else deps.state.recordDeny(attribution);
	if (decision.action === "block" && request.hasUI) deps.notify(decision.reason, "warning");
	emit(deps, request, decision, extra);
	return decision;
}
