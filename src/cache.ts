/**
 * Session-scoped allow cache.
 *
 * Allow-only by construction: there is no method to record a denial. That is a policy decision, not
 * an omission — a denied action must be re-classified on its next attempt so that authorization the
 * user grants in chat ("yes, add that key") takes effect immediately instead of being shadowed by a
 * stale verdict.
 */
import { createHash } from "node:crypto";

/** Stable serialization: object key order must not change a call's identity, array order must. */
function canonical(value: unknown, seen: Set<object>): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (seen.has(value)) throw new TypeError("cyclic input");
	seen.add(value);
	try {
		if (Array.isArray(value)) return `[${value.map(item => canonical(item, seen)).join(",")}]`;
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, seen)}`).join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

export class VerdictCache {
	readonly #capacity: number;
	/** Insertion-ordered, so the first key is the least recently used. */
	readonly #entries = new Set<string>();

	constructor(capacity: number) {
		this.#capacity = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 0;
	}

	get size(): number {
		return this.#entries.size;
	}

	/** `undefined` when the input cannot be canonicalized, which makes the call uncacheable. */
	#key(toolName: string, input: unknown): string | undefined {
		let serialized: string;
		try {
			serialized = canonical(input, new Set());
		} catch {
			return undefined;
		}
		return createHash("sha256").update(toolName).update("\u0000").update(serialized).digest("hex");
	}

	isAllowed(toolName: string, input: unknown): boolean {
		if (this.#capacity === 0) return false;
		const key = this.#key(toolName, input);
		if (key === undefined || !this.#entries.has(key)) return false;
		// Refresh recency: delete then re-add moves the key to the end of the Set's iteration order.
		this.#entries.delete(key);
		this.#entries.add(key);
		return true;
	}

	allow(toolName: string, input: unknown): void {
		if (this.#capacity === 0) return;
		const key = this.#key(toolName, input);
		if (key === undefined) return;
		this.#entries.delete(key);
		this.#entries.add(key);
		while (this.#entries.size > this.#capacity) {
			const oldest = this.#entries.values().next();
			if (oldest.done) break;
			this.#entries.delete(oldest.value);
		}
	}

	clear(): void {
		this.#entries.clear();
	}
}
