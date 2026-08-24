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

export interface Thresholds {
	maxConsecutiveDenials: number;
	maxTotalDenials: number;
}

export interface StateSnapshot {
	checked: number;
	allowed: number;
	denied: number;
	consecutiveDenials: number;
	paused: boolean;
	degradedReason?: string;
}

function counter(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

export class GateState {
	readonly #thresholds: Thresholds;
	#checked = 0;
	#allowed = 0;
	#denied = 0;
	#consecutive = 0;
	#paused = false;
	#degradedReason: string | undefined;
	/** Failure classes already announced this session, so a degraded gate notifies once, not per call. */
	readonly #noticed = new Set<string>();

	constructor(thresholds: Thresholds) {
		this.#thresholds = thresholds;
	}

	get paused(): boolean {
		return this.#paused;
	}

	get degradedReason(): string | undefined {
		return this.#degradedReason;
	}

	recordAllow(): void {
		this.#checked++;
		this.#allowed++;
		this.#consecutive = 0;
		this.#degradedReason = undefined;
	}

	recordDeny(): void {
		this.#checked++;
		this.#denied++;
		this.#consecutive++;
		this.#tripIfPiledUp();
	}

	/** A classifier failure blocks, so it counts as a denial and also marks the gate degraded. */
	recordFailure(reason: string): void {
		this.#degradedReason = reason;
		this.recordDeny();
	}

	pause(): void {
		this.#paused = true;
	}

	resume(): void {
		this.#paused = false;
		this.#denied = 0;
		this.#consecutive = 0;
		this.#degradedReason = undefined;
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
			consecutiveDenials: this.#consecutive,
			paused: this.#paused,
		};
		if (this.#degradedReason !== undefined) snapshot.degradedReason = this.#degradedReason;
		return snapshot;
	}

	/** Rebuild from a persisted session entry. Anything unrecognized is left at its current value. */
	restore(data: unknown): void {
		if (typeof data !== "object" || data === null || Array.isArray(data)) return;
		const record = data as Record<string, unknown>;
		this.#checked = counter(record.checked) ?? this.#checked;
		this.#allowed = counter(record.allowed) ?? this.#allowed;
		this.#denied = counter(record.denied) ?? this.#denied;
		this.#consecutive = counter(record.consecutiveDenials) ?? this.#consecutive;
		if (typeof record.paused === "boolean") this.#paused = record.paused;
		if (typeof record.degradedReason === "string") this.#degradedReason = record.degradedReason;
	}

	#tripIfPiledUp(): void {
		if (this.#consecutive >= this.#thresholds.maxConsecutiveDenials) this.#paused = true;
		if (this.#denied >= this.#thresholds.maxTotalDenials) this.#paused = true;
	}
}
