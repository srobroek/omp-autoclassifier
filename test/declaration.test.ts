import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";

/**
 * Structural checks on the declaration in `docs/confirm-credentials-clause.md`. Nothing here prevents the
 * defect that document records.
 *
 * What happened: the document froze a clause under "The clause under test", lint fixes then split its
 * sentences before the commit, and the measured arm kept the original wording in `tools/tune-extension.ts`.
 * The declaration misdescribed its own run.
 *
 * An earlier version of this file claimed to guard against that. It did not. It compared the constants against
 * the erratum, which records what ran and was written afterwards, so it could not have fired before the run.
 * It would also have failed on any legitimate later edit to those constants, turning a historical record into
 * a brake on the code.
 *
 * Preventing the class needs one value rather than two copies: a declaration that imports the clause it
 * declares, or generates its text from the exported constant. That is a change to how the next declaration is
 * written, not a test over this one.
 *
 * So these tests keep only what is stable and worth keeping: the erratum exists, and it sits where an erratum
 * belongs.
 */
const DOC = "docs/confirm-credentials-clause.md";

describe("declaration structure", () => {
	const markdown = fs.readFileSync(DOC, "utf8");

	/** The erratum carries the reason the recorded result reads as it does. Losing it loses the reason. */
	test("the declaration keeps its erratum", () => {
		expect(markdown).toContain("### Erratum: the frozen text is not what ran");
	});

	/**
	 * Everything above the Results heading is frozen once results exist. An erratum inserted above it edits
	 * the frozen region, which is the one thing a declaration exists to prevent.
	 */
	test("the erratum sits below the results heading", () => {
		expect(markdown.indexOf("## Results")).toBeLessThan(markdown.indexOf("### Erratum"));
	});

	/** A declaration without a verdict invites a later reader to supply their own. */
	test("the declaration records a verdict", () => {
		expect(markdown).toContain("Verdict: the clause fails the declaration");
	});
});
