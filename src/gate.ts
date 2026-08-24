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
import { evaluateRules } from "./rules";
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
		return finish(deps, request, {
			action: "block",
			via: "hardDeny",
			reason: `autoclassifier: blocked by the anti-tamper rule \`${match.source}\`. This protects the gate's own configuration; ask the user to change it rather than editing it yourself.`,
		}, { rule: match.source });
	}

	const activeModes = cfg.activeModes.split(",").map(mode => mode.trim());
	if (!activeModes.includes(request.approvalMode)) return { action: "allow", via: "inactive-mode" };
	if (deps.state.paused) return { action: "allow", via: "paused" };

	if (match?.list === "deny") {
		return finish(deps, request, {
			action: "block",
			via: "deny",
			reason: `autoclassifier: blocked by the deny rule \`${match.source}\`.`,
		}, { rule: match.source });
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
		if (deps.state.shouldNotice("failure")) {
			deps.notify(`autoclassifier is degraded and blocking tool calls: ${verdict.reason}`, "error");
		}
		if (!hasUI) deps.reportChildDenial(toolName, verdict.reason);
		const decision: GateDecision = {
			action: "block",
			via: "failure",
			reason: `autoclassifier: the risk classifier could not reach a verdict, so this call was blocked (${verdict.reason}). Tell the user; do not retry.`,
		};
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
	if (cfg.escalate && request.hasUI) {
		let choice: EscalationChoice;
		try {
			choice = await deps.escalate(request.toolName, reason);
		} catch {
			choice = "deny";
		}
		if (choice !== "deny") {
			if (choice === "session") deps.cache.allow(request.toolName, request.input);
			return finish(deps, request, { action: "allow", via: "escalated" }, extra);
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

/** Count it, log it, return it. Every gated decision goes through here so none can skip bookkeeping. */
function finish(
	deps: GateDeps,
	request: GateRequest,
	decision: GateDecision,
	extra: Partial<DecisionRecord>,
): GateDecision {
	if (decision.action === "allow") deps.state.recordAllow();
	else deps.state.recordDeny();
	emit(deps, request, decision, extra);
	return decision;
}
