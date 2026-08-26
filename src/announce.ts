/**
 * The refusal a person reads, at four levels of detail.
 *
 * Two readers, two shapes: the agent gets the fielded payload as a tool error, and the user gets a
 * notification while they are reading something else. This module builds only the second one. The
 * payload is fixed and always complete, because an agent that has to act on a refusal cannot be given
 * a shorter one, so nothing here can withhold anything from it.
 *
 * The level exists because the two ends of that notification are both wrong for somebody. A person who
 * trusts the gate wants to know it fired and on what; a person auditing a refusal wants the axes it
 * turned on, and reconstructing those from a one-line toast is guesswork. The cost of detail here is
 * attention rather than tokens, which is why this is a user setting and not a prompt change.
 *
 * Each level is the one below it plus the fields that answer the next question a reader has:
 *
 *   minimal  what was refused
 *   normal   and why, in the model's own sentence
 *   verbose  and on which axes, so the judgement can be checked
 *   debug    and by which stage or rule, with the agent's payload verbatim
 */
import type { VerdictDetail } from "./defaults";

export interface AnnounceInput {
	toolName: string;
	/** Already-described target, or undefined when the call had no reportable argument. */
	target: string | undefined;
	/** Model reason sentence. */
	reason: string;
	category: string;
	authorization: string;
	risk: string;
	reversibility: string;
	scope: string;
	confidence: string;
	injectionSuspected: boolean;
	/**
	 * Which stage decided: 1 for the filter, 2 for the review. Absent when a rule decided, which happens
	 * before either stage runs and so has no stage of its own.
	 */
	stage?: number;
	/** Rule provenance when a rule blocked instead of the model. */
	rule?: string;
	ruleFrom?: string;
	/** The full structured payload the agent received, already JSON-stringified. */
	agentPayload?: string;
}

/**
 * Categories that name no harm, and so must not be printed.
 *
 * The model spells the absence two ways, and a rule block carries no category at all — the empty case,
 * which `present` drops. `(none)` beside the word "blocked" states the opposite of the refusal.
 */
const UNNAMED_CATEGORIES: Record<string, true> = { none: true, unstated: true };

/**
 * One logical line. A model sentence wraps, and a described command can be a whole heredoc, so every
 * emitted line is collapsed — a notification that spans lines by accident is unreadable in a toast.
 */
function line(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The collapsed value, or undefined when the field carries nothing worth a place in the line. */
function present(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const collapsed = line(value);
	return collapsed === "" ? undefined : collapsed;
}

/**
 * One axis, or the verdict's own word for a value nobody stated.
 *
 * A refusal can arrive with no dimensions at all: the classifier being unreachable blocks the call, and
 * there is no verdict behind it. `authorization: ` reads as a broken line, where `authorization: unstated`
 * reads as the fact.
 */
function axis(value: string): string {
	return present(value) ?? "unstated";
}

/**
 * The axes that make a refusal checkable, in the order the verdict table documents them.
 *
 * All six, always, including an `unstated` one: at this level a missing field would read as "not shown
 * here" when it means "the model declined to say", and those call for opposite reactions.
 *
 * The injection flag is stated even when nothing was suspected. The agent's payload omits the field in
 * that case, so absence there is ambiguous between "not suspected" and "this level does not carry it" —
 * and injection is the one axis where a reader has to be certain which they are looking at.
 */
function dimensions(input: AnnounceInput): string {
	const injection = input.injectionSuspected ? "suspected" : "none";
	return `[authorization: ${axis(input.authorization)}; risk: ${axis(input.risk)}; reversibility: ${axis(input.reversibility)}; scope: ${axis(input.scope)}; confidence: ${axis(input.confidence)}; injection: ${injection}]`;
}

/**
 * The reader's name for a stage, or nothing.
 *
 * `ClassifyResult` reports 1 or 2 and no other value, so any other number reached this from somewhere that
 * is not a stage at all. A reader auditing a refusal would take `stage 0` literally, and a missing line
 * beats a wrong one.
 */
function stageName(stage: number | undefined): string | undefined {
	if (stage === 1) return "stage 1 (filter)";
	if (stage === 2) return "stage 2 (review)";
	return undefined;
}

/**
 * What only `debug` carries: who decided, and what the agent was told.
 *
 * The stage and the rule are here because the payload names neither, so they are unrecoverable from any
 * other level. Each line appears only when the field behind it exists: a rule block was decided by a rule
 * rather than by a stage, and a model verdict names no rule. The payload is reproduced verbatim,
 * indentation and all, because the point of the level is that the user sees exactly the text the agent
 * acted on rather than a paraphrase of it.
 */
function provenance(input: AnnounceInput): string[] {
	const out: string[] = [];
	const stage = stageName(input.stage);
	if (stage !== undefined) out.push(`decided by: ${stage}`);
	const rule = present(input.rule);
	const from = present(input.ruleFrom);
	// Provenance without a rule names nothing, so the origin alone prints no line.
	if (rule !== undefined) out.push(line(`rule: ${rule}${from === undefined ? "" : ` from ${from}`}`));
	if (present(input.agentPayload) !== undefined) out.push(`agent payload:\n${input.agentPayload}`);
	return out;
}

/**
 * The notification text for one refusal at one level.
 *
 * Anything that is not `debug` returns a single collapsed line. An unrecognised level lands on
 * `verbose`, which is the conservative side of the only branch that reproduces the raw payload.
 */
export function announce(level: VerdictDetail, input: AnnounceInput): string {
	const target = present(input.target);
	const call = target === undefined ? `\`${input.toolName}\`` : `\`${input.toolName}\` on ${target}`;
	const head = `autoclassifier blocked ${call}`;
	if (level === "minimal") return line(head);
	const category = present(input.category);
	const named = category === undefined || UNNAMED_CATEGORIES[category] === true ? "" : ` (${category})`;
	const summary = `${head}${named}: ${input.reason}`;
	if (level === "normal") return line(summary);
	const audited = line(`${summary} ${dimensions(input)}`);
	if (level !== "debug") return audited;
	return [audited, ...provenance(input)].join("\n");
}
