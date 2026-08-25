/**
 * A guard against tests disappearing quietly.
 *
 * The mutation harness proves the implementation is pinned: break one behavior, and the test that owns
 * it must fail. What it cannot prove is that a test still exists. Each mutation names one test, there are
 * fewer mutations than tests, and several tests legitimately share the line a named sibling covers. A
 * deletion on such a line is invisible: the named sibling still fails, so the harness stays green.
 *
 * That is not hypothetical. An edit replaced `a classifier block names what it blocked` with a different
 * test instead of inserting beside it. The count held at 382 because one arrived as one left, the harness
 * reported no gaps because the surviving allow test killed the same mutation, and the common path ran
 * unasserted through two commits until a reviewer read the file.
 *
 * So the floor below is load-bearing. It only ever moves up, in the same commit as the tests that raise
 * it, which makes a removal show up as a conflict between the number and the suite rather than as
 * silence.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/** Raise this with the commit that adds tests. Never lower it to make a red suite green. */
const FLOOR = 437;

const DIRECTORY = path.dirname(import.meta.path);
/** Excluded from its own census, so adding a check here does not inflate the number it guards. */
const SELF = "census.test.ts";

function suiteFiles(): string[] {
	return fs
		.readdirSync(DIRECTORY)
		.filter(name => name.endsWith(".test.ts") && name !== SELF)
		.sort();
}

/** Top-level indentation only: a nested helper named `test` is not a test. */
const TEST_LINE = /^\ttest\("((?:[^"\\]|\\.)+)"/gm;

function testsIn(file: string): string[] {
	const source = fs.readFileSync(path.join(DIRECTORY, file), "utf8");
	return [...source.matchAll(TEST_LINE)].map(match => match[1] ?? "");
}

describe("suite census", () => {
	test("the suite has not shrunk", () => {
		const counted = suiteFiles().reduce((total, file) => total + testsIn(file).length, 0);
		// Reported per file when it fails, because the count alone does not say where the loss was.
		const breakdown = suiteFiles().map(file => `${file}: ${testsIn(file).length}`);
		expect(counted, `expected at least ${FLOOR} tests, counted ${counted}\n${breakdown.join("\n")}`).toBeGreaterThanOrEqual(FLOOR);
	});

	/**
	 * A botched insert lands a test inside its neighbour or repeats it. The repeat is the recoverable
	 * half, and it reads as coverage while asserting the same thing twice.
	 */
	test("no test name is used twice in a file", () => {
		const collisions: string[] = [];
		for (const file of suiteFiles()) {
			const seen = new Set<string>();
			for (const name of testsIn(file)) {
				if (seen.has(name)) collisions.push(`${file}: ${name}`);
				seen.add(name);
			}
		}
		expect(collisions).toEqual([]);
	});
});
