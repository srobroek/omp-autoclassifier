import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DecisionLog } from "../src/log";
import type { DecisionRecord } from "../src/gate";

let root: string;
let logPath: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ac-log-")));
	logPath = path.join(root, "nested", "decisions.jsonl");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
	return {
		timestamp: "2026-08-24T10:00:00.000Z",
		toolName: "bash",
		decision: "block",
		via: "classifier",
		hasUI: true,
		...overrides,
	};
}

describe("appending", () => {
	test("each decision becomes one json line", () => {
		const log = new DecisionLog(logPath);
		log.append(record({ toolName: "bash" }));
		log.append(record({ toolName: "write" }));
		const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n");
		expect(lines.length).toBe(2);
		expect(JSON.parse(lines[0] ?? "").toolName).toBe("bash");
		expect(JSON.parse(lines[1] ?? "").toolName).toBe("write");
	});

	test("the parent directory is created on demand", () => {
		new DecisionLog(logPath).append(record());
		expect(fs.existsSync(logPath)).toBe(true);
	});

	test("a multi-line reason stays on one line", () => {
		const log = new DecisionLog(logPath);
		log.append(record({ reason: "line one\nline two" }));
		expect(fs.readFileSync(logPath, "utf8").trimEnd().split("\n").length).toBe(1);
	});

	/**
	 * A gate that cannot write its audit log must still gate. Logging is never load-bearing, so a bad
	 * destination degrades to "no log" rather than to "no gate".
	 */
	test("an unwritable destination does not throw", () => {
		// A regular file where a directory is needed: mkdir -p cannot resolve it.
		const blocker = path.join(root, "blocker");
		fs.writeFileSync(blocker, "not a directory");
		const log = new DecisionLog(path.join(blocker, "nested", "x.jsonl"));
		expect(() => log.append(record())).not.toThrow();
		expect(log.disabledReason).toBeDefined();
	});

	/**
	 * Observable through the filesystem: once disabled, appending must not touch it again. Clearing the
	 * obstruction afterwards proves the point — a retrying implementation would create the file now.
	 */
	test("a failed destination is not retried on every subsequent call", () => {
		const blocker = path.join(root, "blocker");
		fs.writeFileSync(blocker, "not a directory");
		const target = path.join(blocker, "nested", "x.jsonl");
		const log = new DecisionLog(target);
		log.append(record());
		expect(log.disabledReason).toBeDefined();

		fs.rmSync(blocker);
		log.append(record());
		expect(fs.existsSync(target)).toBe(false);
	});
});

describe("reading back", () => {
	test("the most recent entries come back parsed and newest last", () => {
		const log = new DecisionLog(logPath);
		for (const tool of ["a", "b", "c"]) log.append(record({ toolName: tool }));
		const tail = log.tail(2);
		expect(tail.map(entry => entry.toolName)).toEqual(["b", "c"]);
	});

	test("asking for more than exists returns everything", () => {
		const log = new DecisionLog(logPath);
		log.append(record());
		expect(log.tail(50).length).toBe(1);
	});

	test("a missing log reads as empty rather than failing", () => {
		expect(new DecisionLog(logPath).tail(10)).toEqual([]);
	});

	test("a corrupt line is skipped instead of poisoning the whole read", () => {
		const log = new DecisionLog(logPath);
		log.append(record({ toolName: "good" }));
		fs.appendFileSync(logPath, "{not json\n");
		log.append(record({ toolName: "also-good" }));
		expect(log.tail(10).map(entry => entry.toolName)).toEqual(["good", "also-good"]);
	});

	test("only denials can be listed, for the denials view", () => {
		const log = new DecisionLog(logPath);
		log.append(record({ decision: "allow", via: "allow" }));
		log.append(record({ decision: "block", via: "deny" }));
		expect(log.tail(10, entry => entry.decision === "block").length).toBe(1);
	});
});
