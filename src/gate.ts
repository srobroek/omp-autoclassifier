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
import type { ClassifyOptions, ClassifyResult, Dimensions } from "./classifier";
import type { EffectiveConfig } from "./config";
import { DISABLE_ENV_VAR } from "./defaults";
import type { Refusal } from "./evidence";
import type { EvidenceRequest, TranscriptEntry } from "./evidence";
import { describeTarget, evaluateRules, primaryArgument, type RuleMatch } from "./rules";
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
	category?: string;
	authorization?: string;
	reversibility?: string;
	scope?: string;
	confidence?: string;
	injectionSuspected?: boolean;
	alternative?: string;
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
	classify: (request: EvidenceRequest, options: ClassifyOptions) => Promise<ClassifyResult>;
	escalate: (toolName: string, reason: string) => Promise<EscalationChoice>;
	/**
	 * Ask an interactive session on behalf of a headless one. Absent means a subagent cannot escalate and
	 * a would-be prompt becomes a block.
	 */
	escalateViaParent?: (toolName: string, reason: string) => Promise<EscalationChoice>;
	notify: (message: string, level: "info" | "warning" | "error") => void;
	reportChildDenial: (toolName: string, reason: string) => void;
	/** Refusals from sessions that already existed when this one started. */
	inheritedRefusals: () => readonly Refusal[];
	/** Publish a refusal so sessions spawned later inherit it. */
	shareRefusal: (refusal: Refusal) => void;
	log: (record: DecisionRecord) => void;
}

/** How a decision was reached. Surfaced in the block reason, the audit log, and `/autoclassifier`. */
export type Via =
	| "env-disabled"
	| "disabled"
	| "hardDeny"
	| "inactive-mode"
	| "paused"
	| "locked"
	| "deny"
	| "allow"
	| "cached"
	| "subagent-exempt"
	| "ask"
	| "escalated"
	| "classifier"
	| "unconfigured"
	| "failure";

/**
 * `reason` goes to the agent as a tool error; `announcement` is the same refusal in one line for a
 * notification. Two readers, two shapes: an agent acts on the fields, a person is reading something else
 * when the toast arrives. Absent `announcement`, the notification falls back to `reason`.
 */
export type GateDecision =
	| { action: "allow"; via: Via }
	| { action: "block"; via: Via; reason: string; announcement?: string };

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A rule refusal, in the same shape as a classifier one.
 *
 * The agent channel is JSON for every denial, not just the judged ones. A rule block and a model block
 * are the same event to whatever reads them, and giving them two shapes meant anything parsing the
 * refusal had to sniff which kind it got.
 *
 * `rule` and `ruleFrom` are the fields that only exist here: naming the pattern alone leaves
 * `<agentDir>` placeholders in front of the reader, and the origin is what separates a rule the user
 * wrote from one this plugin shipped.
 */
function explain(cfg: EffectiveConfig, match: RuleMatch, toolName: string, guidance: Record<string, string>): string {
	const origin = cfg.origins[`rules.${match.list}`] ?? "default";
	return JSON.stringify(
		{
			autoclassifier: "blocked",
			tool: toolName,
			...(match.target === undefined ? {} : { target: match.target }),
			via: match.list === "hardDeny" ? "anti-tamper rule" : `${match.list} rule`,
			rule: match.source,
			ruleFrom: origin === "default" ? "shipped default" : origin,
			...guidance,
		},
		null,
		2,
	);
}

/**
 * What this refusal costs, told to the agent before the bill arrives.
 *
 * A run of refusals locks the session, and a cost the agent cannot see is one it cannot avoid: the
 * measured failure was an agent rewording a refused call until a fresh review passed it, which is
 * exactly the behaviour a visible countdown discourages.
 *
 * Stating the threshold is safe only because the lock is strictly more restrictive than the gate. While
 * the same counter tripped a breaker that *opened* the gate, this text would have been a three-call
 * recipe for switching off supervision, which is why the two were separated before it was written.
 */
function lockNotice(deps: GateDeps, cfg: EffectiveConfig): Record<string, string> {
	// The pending denial is not recorded yet, so count it here to describe the state the agent lands in.
	const remaining = cfg.maxConsecutiveDenials - (deps.state.consecutiveDenials + 1);
	if (remaining > 0) {
		return {
			warning: `${remaining} more consecutive refusal${remaining === 1 ? "" : "s"} locks this session: every tool call is refused until the user runs \`/autoclassifier resume\`. An allowed call in between clears the run.`,
		};
	}
	return {
		warning:
			"This session is now locked: every tool call, including reads, is refused until the user runs `/autoclassifier resume`. Tell them what you need and why.",
	};
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
				reason: explain(cfg, match, toolName, {
					why: "Anti-tamper rules cover the settings that govern this gate, so the agent it gates cannot edit them.",
					next: "Ask the user to make this change.",
					notThis: "Any other route to the same change.",
					...lockNotice(deps, cfg),
				}),
			},
			{ rule: match.source, target: match.target },
		);
	}

	const activeModes = cfg.activeModes.split(",").map(mode => mode.trim());
	if (!activeModes.includes(request.approvalMode)) return { action: "allow", via: "inactive-mode" };

	// Ordered before the pause deliberately. A pause means the reviewer broke and the session should not be
	// bricked for it; a lock means the agent persisted at refused work, and that outranks the convenience.
	if (deps.state.locked) {
		return {
			action: "block",
			via: "locked",
			reason: JSON.stringify(
				{
					autoclassifier: "blocked",
					tool: toolName,
					via: "session locked",
					why: cfg.maxConsecutiveDenials + " consecutive refusals locked this session.",
					next: "Tell the user what you were trying to do and ask them to run `/autoclassifier resume`.",
					notThis: "Any tool call. Every one of them is refused until they do.",
				},
				null,
				2,
			),
		};
	}
	if (deps.state.paused) return { action: "allow", via: "paused" };

	if (match?.list === "deny") {
		return finish(
			deps,
			request,
			{
				action: "block",
				via: "deny",
				reason: explain(cfg, match, toolName, {
					next: "Tell the user which rule refused this.",
					notThis: "Any other route to the same effect.",
					...lockNotice(deps, cfg),
				}),
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
			explain(cfg, match, toolName, {
				why: "This call needs a human decision, and no prompt is available.",
				next: "Ask the user for this specific action.",
				notThis: "Any other route to the same effect.",
				...lockNotice(deps, cfg),
			}),
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
				refusals: [...deps.inheritedRefusals(), ...deps.state.refusals],
			},
			{
				stage1TimeoutMs: cfg.stage1TimeoutMs,
				stage2TimeoutMs: cfg.stage2TimeoutMs,
				suggestAlternative: cfg.suggestAlternative,
			},
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
			reason: JSON.stringify(
				{
					autoclassifier: "blocked",
					tool: toolName,
					via: "classifier unreachable",
					why: `The risk classifier could not reach a verdict: ${verdict.reason}`,
					next: "Tell the user the gate is degraded. The call did not run.",
					notThis: "Retrying. The gate fails closed, so it will refuse again.",
				},
				null,
				2,
			),
		};
		// Announced on every blocked call, not once per session. A degraded gate refuses everything, and
		// a single early warning would leave every later refusal unexplained on screen.
		//
		// Prose, not the agent's JSON: this path builds its own reason rather than going through `finish`,
		// and sending the payload to a toast put a formatted object on the user's screen.
		if (hasUI) {
			deps.notify(announceVerdict(toolName, input, "", `the risk classifier is unreachable (${verdict.reason})`), "error");
		}
		emit(deps, request, decision, { reason: verdict.reason });
		return decision;
	}

	if (verdict.kind === "allow") {
		deps.cache.allow(toolName, input);
		return finish(
			deps,
			request,
			{ action: "allow", via: "classifier" },
			// A stage-one allow never produced dimensions; only the review stage reports them.
			{ stage: verdict.stage, ...(verdict.dimensions === undefined ? {} : recordDimensions(verdict.dimensions)) },
		);
	}

	// `ask` and `deny` take the same path: config decides whether a prompt is reachable, and with
	// escalation off both end in a refusal, which is what keeps an autonomous run safe.
	return await resolveAsk(
		deps,
		request,
		"classifier",
		explainVerdict(deps, cfg, toolName, input, verdict.kind, verdict.reason, verdict.dimensions),
		{ stage: verdict.stage, reason: verdict.reason, ...recordDimensions(verdict.dimensions) },
	);
}

/** Flatten the verdict dimensions into audit-record fields. */
function recordDimensions(dimensions: Dimensions): Partial<DecisionRecord> {
	return {
		risk: dimensions.risk,
		category: dimensions.category,
		authorization: dimensions.authorization,
		reversibility: dimensions.reversibility,
		scope: dimensions.scope,
		confidence: dimensions.confidence,
		...(dimensions.injectionSuspected ? { injectionSuspected: true } : {}),
		...(dimensions.alternative === undefined ? {} : { alternative: dimensions.alternative }),
	};
}

/**
 * A refusal the agent can learn from and the user can audit.
 *
 * Both read the same text: the agent as a tool error, the user as a notification. It names what was
 * refused, which harmful category it fell into, what the transcript authorized, how recoverable and how
 * far-reaching the effect is, and the model's own sentence. Naming the risk level alone left the reader
 * guessing which call was even involved.
 */
function explainVerdict(
	deps: GateDeps,
	cfg: EffectiveConfig,
	toolName: string,
	input: unknown,
	kind: "ask" | "deny",
	reason: string,
	dimensions: Dimensions,
): string {
	const target = describeTarget(primaryArgument(toolName, input));
	// Codex states the best version of the guidance: after a rejection, "proceed only with a materially
	// safer alternative, or inform the user of the risk and send a final message to ask for approval". Two
	// moves and no third, which closes the reworded-retry vector by construction, because a reword is not
	// safer. Claude Code's equivalent permits any benign re-route ("head instead of cat"), fine for a
	// per-invocation denial and not for one that judges an effect: a measured run here had an agent reword a
	// refused subagent spawn until a fresh review passed it, and the command ran.
	const next =
		dimensions.authorization === "revoked"
			? "The user ruled this out. There is nothing here to work around."
			: "Do something materially safer that reaches the same goal, or tell the user the risk and ask them for this specific action.";
	const payload = {
		autoclassifier: "blocked",
		tool: toolName,
		...(target === undefined ? {} : { target }),
		...(kind === "ask" ? { wantedAHuman: true, escalation: "off" } : {}),
		category: dimensions.category,
		authorization: dimensions.authorization,
		risk: dimensions.risk,
		reversibility: dimensions.reversibility,
		scope: dimensions.scope,
		...(dimensions.injectionSuspected ? { injectionSuspected: true } : {}),
		why: reason,
		...(dimensions.alternative === undefined ? {} : { safer: dimensions.alternative.replace(/[.\s]+$/, "") }),
		next,
		notThis: "Rewording this call, splitting it across calls, or handing it to a subagent.",
		otherwise: "Carry on with anything that does not depend on this.",
		...lockNotice(deps, cfg),
	};
	// Two spaces, because the reader is a model: the indentation costs a few tokens and buys a shape it
	// parses without ambiguity. `next` stays a sentence — the structure is for finding the fields, and the
	// instruction is still the thing the agent has to act on.
	return JSON.stringify(payload, null, 2);
}

/**
 * The same refusal for a person, in one line.
 *
 * A notification arrives while they are reading something else, so it carries the call, the target, and
 * why — and none of the agent's next moves, which are not theirs to take. Sending both readers the same
 * string served neither: the fielded form is noise in a toast, and a one-liner leaves an agent guessing.
 */
function announceVerdict(toolName: string, input: unknown, category: string, reason: string): string {
	const target = describeTarget(primaryArgument(toolName, input));
	const what = target === undefined ? `\`${toolName}\`` : `\`${toolName}\` on ${target}`;
	// A rule block carries no category at all, which is a third empty case beside the model's two.
	const unnamed = category === "" || category === "none" || category === "unstated";
	const named = unnamed ? "" : ` (${category})`;
	return `autoclassifier blocked ${what}${named}: ${reason}`.replace(/\s+/g, " ").trim();
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
	// The target is derived rather than taken from `extra`, because only a rule match carries one. A log
	// of decisions that never names what was acted on cannot answer the question it exists to answer.
	const target = describeTarget(primaryArgument(request.toolName, request.input));
	return {
		timestamp: new Date().toISOString(),
		toolName: request.toolName,
		decision,
		via,
		hasUI: request.hasUI,
		...(target === undefined ? {} : { target }),
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
 * The sentence that explains a refusal, whoever is reading.
 *
 * A classifier verdict carries the model's own sentence in `extra.reason`; a rule block carries the rule
 * that fired instead. Both the refusal ledger and the human notification want the short form, not the
 * fielded message the agent gets.
 */
function why(decision: GateDecision, extra: Partial<DecisionRecord>): string {
	if (extra.reason !== undefined) return extra.reason;
	if (extra.rule !== undefined) return `matched the rule \`${extra.rule}\``;
	return decision.action === "block" ? decision.reason : "";
}

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
	else {
		deps.state.recordDeny(attribution);
		// Remember what was refused, so a reworded retry is not judged as a fresh request. A classifier
		// failure never arrives here: it blocks through `emit` directly, precisely because no model judged
		// the call and there is therefore no verdict to hold the agent to.
		const target = describeTarget(primaryArgument(request.toolName, request.input));
		// The verdict's own sentence, not the formatted block message: the ledger is quoted back into the
		// next review, where the guidance boilerplate would repeat once per entry and buy nothing.
		const refusal = { toolName: request.toolName, target: target ?? "", reason: why(decision, extra) };
		deps.state.recordRefusal(refusal.toolName, refusal.target, refusal.reason);
		// Also published process-wide, so a subagent spawned after this cannot be handed the same request
		// with a blank slate. Its own gate starts empty by construction.
		deps.shareRefusal(refusal);
	}
	if (decision.action === "block" && request.hasUI) {
		// Derived here rather than threaded through every block site: this is the one place that already
		// holds both the request and the record fields, and the only place that notifies.
		deps.notify(announceVerdict(request.toolName, request.input, extra.category ?? "", why(decision, extra)), "warning");
		// The refusal that locks the session is the one message the user cannot afford to miss: from here on
		// the agent is stopped and only they can restart it. Announced once, at the transition, because the
		// locked calls that follow are silent by design — a locked agent hammering tools must not spam.
		if (deps.state.locked && decision.via !== "locked") {
			deps.notify(
				`autoclassifier locked this session after ${deps.config().maxConsecutiveDenials} refusals in a row. Nothing will run until you \`/autoclassifier resume\`.`,
				"error",
			);
		}
	}
	emit(deps, request, decision, extra);
	return decision;
}
