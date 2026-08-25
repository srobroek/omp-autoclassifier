/**
 * Per-session gate state and circuit breaker.
 *
 * The breaker exists because a fail-closed gate has a failure mode of its own: a misconfigured or
 * unreachable classifier turns every call into a block, and an agent facing a wall of refusals burns
 * the session retrying. Both surveyed vendors pause after a run of refusals instead of trusting the
 * reviewer to recover. Classifier failures count toward the breaker for the same reason denials do —
 * from the agent's side they are indistinguishable, because both block.
 *
 * Resuming is deliberately manual (`/autoclassifier resume`). An automatic re-arm would re-enter the
 * same wall of blocks the pause just escaped.
 */

export type { Refusal } from "./evidence";
import type { Refusal } from "./evidence";

export interface Thresholds {
	maxConsecutiveDenials: number;
	maxTotalDenials: number;
}

export interface StateSnapshot {
	checked: number;
	allowed: number;
	denied: number;
	/**
	 * Decisions a model actually made, as opposed to ones a static rule or the cache made.
	 *
	 * Reported so the split stays visible: this is a classifier, and a heavy allowlist would quietly
	 * turn it into a pattern matcher with nothing to show the difference.
	 */
	classified: number;
	consecutiveDenials: number;
	paused: boolean;
	degradedReason?: string;
	refusals?: Refusal[];
}

/** Whether a model produced this decision. */
export interface Attribution {
	classified?: boolean;
}

function counter(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

/** Enough refusals to establish a pattern; the evidence builder shows fewer still. */
const MAX_REFUSALS = 16;

function isRefusal(value: unknown): value is Refusal {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.toolName === "string" && typeof record.target === "string" && typeof record.reason === "string";
}

export class GateState {
	readonly #thresholds: Thresholds;
	#checked = 0;
	#allowed = 0;
	#denied = 0;
	#classified = 0;
	#consecutiveDenials = 0;
	#consecutiveFailures = 0;
	#totalFailures = 0;
	#paused = false;
	#degradedReason: string | undefined;
	/** Failure classes already announced this session, so a degraded gate notifies once, not per call. */
	readonly #noticed = new Set<string>();
	#refusals: Refusal[] = [];

	constructor(thresholds: Thresholds) {
		this.#thresholds = thresholds;
	}

	get paused(): boolean {
		return this.#paused;
	}

	/**
	 * True on a run of refusals from a working reviewer. Reported, never acted on by opening the gate.
	 *
	 * The distinction from `paused` is the whole point. A run of *failures* means the reviewer is broken
	 * and refusing everything for reasons unrelated to the calls, so opening the gate is the lesser harm.
	 * A run of *denials* means the reviewer is working. Opening the gate there rewards persistence and
	 * hands any agent a three-call recipe for switching off its own supervision.
	 */
	get consecutiveDenials(): number {
		return this.#consecutiveDenials;
	}

	get locked(): boolean {
		return this.#consecutiveDenials >= this.#thresholds.maxConsecutiveDenials;
	}

	get degradedReason(): string | undefined {
		return this.#degradedReason;
	}

	recordAllow(options?: Attribution): void {
		this.#checked++;
		this.#allowed++;
		if (options?.classified === true) this.#classified++;
		this.#consecutiveDenials = 0;
		this.#consecutiveFailures = 0;
		this.#degradedReason = undefined;
	}

	recordDeny(options?: Attribution): void {
		this.#checked++;
		this.#denied++;
		if (options?.classified === true) this.#classified++;
		this.#consecutiveDenials++;
		// Deliberately does not trip the breaker. A refusal locks instead; see `locked`.
		this.#consecutiveFailures = 0;
	}

	/**
	 * A classifier failure blocks, so it counts as a denial for the audit totals, and it is the only thing
	 * that opens the gate. A broken reviewer must not brick the session; a working one must not be
	 * switchable off.
	 */
	recordFailure(reason: string): void {
		this.#degradedReason = reason;
		this.#checked++;
		this.#denied++;
		// The model was consulted, so this counts toward coverage even though it produced no verdict.
		this.#classified++;
		// Deliberately not counted toward the lock: a broken reviewer is not the agent misbehaving.
		this.#consecutiveFailures++;
		this.#totalFailures++;
		if (this.#consecutiveFailures >= this.#thresholds.maxConsecutiveDenials) this.#paused = true;
		if (this.#totalFailures >= this.#thresholds.maxTotalDenials) this.#paused = true;
	}

	pause(): void {
		this.#paused = true;
	}

	get refusals(): readonly Refusal[] {
		return this.#refusals;
	}

	/**
	 * Remember a refusal so the next review can see it.
	 *
	 * Denials are deliberately not cached, so that authorization given in chat takes effect immediately.
	 * The cost is that the same request can be asked again in new words, and a live run showed an agent
	 * doing precisely that until a fresh review passed it. This ledger is the memory that closes it.
	 */
	recordRefusal(toolName: string, target: string, reason: string): void {
		const duplicate = this.#refusals.some(
			refusal => refusal.toolName === toolName && refusal.target === target && refusal.reason === reason,
		);
		if (duplicate) return;
		this.#refusals.push({ toolName, target, reason });
		if (this.#refusals.length > MAX_REFUSALS) this.#refusals.splice(0, this.#refusals.length - MAX_REFUSALS);
	}

	resume(): void {
		this.#paused = false;
		this.#denied = 0;
		this.#consecutiveDenials = 0;
		this.#degradedReason = undefined;
		// Resuming is the user forgiving the session; a stale history would keep arguing against them.
		this.#refusals.length = 0;
	}

	/** True the first time a failure class is seen this session. */
	shouldNotice(key: string): boolean {
		if (this.#noticed.has(key)) return false;
		this.#noticed.add(key);
		return true;
	}

	snapshot(): StateSnapshot {
		const snapshot: StateSnapshot = {
			checked: this.#checked,
			allowed: this.#allowed,
			denied: this.#denied,
			classified: this.#classified,
			consecutiveDenials: this.#consecutiveDenials,
			paused: this.#paused,
		};
		if (this.#degradedReason !== undefined) snapshot.degradedReason = this.#degradedReason;
		if (this.#refusals.length > 0) snapshot.refusals = [...this.#refusals];
		return snapshot;
	}

	/** Rebuild from a persisted session entry. Anything unrecognized is left at its current value. */
	restore(data: unknown): void {
		if (typeof data !== "object" || data === null || Array.isArray(data)) return;
		const record = data as Record<string, unknown>;
		this.#checked = counter(record.checked) ?? this.#checked;
		this.#allowed = counter(record.allowed) ?? this.#allowed;
		this.#denied = counter(record.denied) ?? this.#denied;
		this.#classified = counter(record.classified) ?? this.#classified;
		this.#consecutiveDenials = counter(record.consecutiveDenials) ?? this.#consecutiveDenials;
		if (typeof record.paused === "boolean") this.#paused = record.paused;
		if (typeof record.degradedReason === "string") this.#degradedReason = record.degradedReason;
		if (Array.isArray(record.refusals)) {
			this.#refusals = record.refusals.filter(isRefusal).slice(-MAX_REFUSALS);
		}
	}
}
