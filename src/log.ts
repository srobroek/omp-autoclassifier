/**
 * Append-only decision log.
 *
 * Every method is best-effort and never throws. A gate that cannot write its audit trail must still
 * gate, so a full disk or an unwritable path degrades to "no log" rather than to "no gate". The first
 * write failure disables further attempts, so a broken destination does not cost a syscall per tool
 * call for the rest of the session.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DecisionRecord } from "./gate";

export class DecisionLog {
	readonly #path: string;
	#ready = false;
	#disabledReason: string | undefined;

	constructor(logPath: string) {
		this.#path = logPath;
	}

	/** Set once writing has failed, and surfaced by `/autoclassifier status`. */
	get disabledReason(): string | undefined {
		return this.#disabledReason;
	}

	get path(): string {
		return this.#path;
	}

	append(record: DecisionRecord): void {
		if (this.#disabledReason !== undefined) return;
		try {
			if (!this.#ready) {
				fs.mkdirSync(path.dirname(this.#path), { recursive: true });
				this.#ready = true;
			}
			// JSON.stringify escapes newlines, so one record is always exactly one line.
			fs.appendFileSync(this.#path, `${JSON.stringify(record)}\n`);
		} catch (error) {
			this.#disabledReason = error instanceof Error ? error.message : String(error);
		}
	}

	/** The last `count` records, oldest first, skipping anything unparseable. */
	tail(count: number, filter?: (record: DecisionRecord) => boolean): DecisionRecord[] {
		let text: string;
		try {
			text = fs.readFileSync(this.#path, "utf8");
		} catch {
			return [];
		}
		const out: DecisionRecord[] = [];
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof parsed !== "object" || parsed === null) continue;
			const candidate = parsed as DecisionRecord;
			if (filter !== undefined && !filter(candidate)) continue;
			out.push(candidate);
		}
		return out.slice(-count);
	}
}
