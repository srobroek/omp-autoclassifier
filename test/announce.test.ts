import { describe, expect, test } from "bun:test";
import { announce, type AnnounceInput } from "../src/announce";
import { VERDICT_DETAIL_LEVELS, type VerdictDetail } from "../src/defaults";

/**
 * The notification, and only the notification. The agent's payload is built elsewhere and is always
 * complete, so every assertion here is about what a person reads while the gate refuses something.
 *
 * Each level is pinned with an exact string rather than a substring. The levels differ by which fields
 * they carry, and a `toContain` check cannot tell "carries less" from "carries more" — which is the one
 * distinction the setting exists to make.
 */
const base: AnnounceInput = {
	toolName: "bash",
	target: "git reset --hard origin/main",
	reason: "Rewrites history other people have pulled.",
	category: "destruction",
	authorization: "absent",
	risk: "high",
	reversibility: "irreversible",
	scope: "shared",
	confidence: "high",
	injectionSuspected: false,
	stage: 2,
};

/** Two-space indentation and real newlines, so "verbatim" is something a test can fail on. */
const agentPayload = JSON.stringify(
	{
		autoclassifier: "blocked",
		tool: "bash",
		target: "git reset --hard origin/main",
		why: "Rewrites history other people have pulled.",
	},
	null,
	2,
);

/** A rule block, which is the case that carries provenance the model path has none of. */
const withProvenance: AnnounceInput = {
	...base,
	rule: "bash(*git reset --hard*)",
	ruleFrom: "project autoclassifier.yml",
	agentPayload,
};

const CALL = "autoclassifier blocked `bash` on git reset --hard origin/main";
const SENTENCE = `${CALL} (destruction): Rewrites history other people have pulled.`;
const AXES =
	"[authorization: absent; risk: high; reversibility: irreversible; scope: shared; confidence: high; injection: none]";

describe("minimal", () => {
	test("minimal names the call and stops there", () => {
		expect(announce("minimal", base)).toBe(CALL);
	});

	/** Nothing above `minimal` is reachable from it, so a reader who wants more has to change the setting. */
	test("minimal carries neither the reason nor the axes", () => {
		const text = announce("minimal", base);
		expect(text).not.toContain(base.reason);
		expect(text).not.toContain("authorization");
	});
});

describe("normal", () => {
	test("normal adds the category and the model's sentence", () => {
		expect(announce("normal", base)).toBe(SENTENCE);
	});

	/**
	 * Three spellings of "no category": the model's two, and the empty string a rule block leaves. All read
	 * as an absence, and `(none)` beside the word "blocked" would state the opposite of the refusal.
	 */
	test("an unnamed category is left out of the line", () => {
		const expected = `${CALL}: Rewrites history other people have pulled.`;
		expect(announce("normal", { ...base, category: "" })).toBe(expected);
		expect(announce("normal", { ...base, category: "none" })).toBe(expected);
		expect(announce("normal", { ...base, category: "unstated" })).toBe(expected);
	});

	test("normal carries none of the audited axes", () => {
		expect(announce("normal", base)).not.toContain("reversibility");
	});
});

describe("verbose", () => {
	test("verbose adds the axes a refusal is audited on", () => {
		expect(announce("verbose", base)).toBe(`${SENTENCE} ${AXES}`);
	});

	/**
	 * Stated in both directions on purpose. The agent's payload omits the field when nothing was suspected,
	 * so a reader who has seen that shape cannot tell an absent flag from a level that does not carry one.
	 */
	test("verbose states the injection flag even when nothing was suspected", () => {
		expect(announce("verbose", base)).toContain("injection: none");
	});

	test("verbose says so when the evidence tried to authorize the call", () => {
		expect(announce("verbose", { ...base, injectionSuspected: true })).toContain("injection: suspected");
	});

	/** An `unstated` axis is a thing the model declined to say, which is not the same as a hidden field. */
	test("verbose reports an axis the model left unstated", () => {
		expect(announce("verbose", { ...base, scope: "unstated" })).toContain("scope: unstated");
	});

	/**
	 * A refusal can arrive with no verdict behind it: an unreachable classifier blocks the call, and there
	 * are no axes to report. They still have to read as facts rather than as empty labels.
	 */
	test("an axis the caller could not fill reads as unstated", () => {
		const text = announce("verbose", { ...base, authorization: "", risk: " \n ", confidence: "" });
		expect(text).toContain("authorization: unstated; risk: unstated");
		expect(text).toContain("confidence: unstated");
	});

	test("verbose carries no payload and no provenance", () => {
		const text = announce("verbose", withProvenance);
		expect(text).not.toContain("agent payload");
		expect(text).not.toContain("decided by");
		expect(text).not.toContain("rule:");
	});

	test("verbose stays one line when the reason and the target span several", () => {
		const text = announce("verbose", {
			...base,
			target: "git reset --hard\n  origin/main",
			reason: "Rewrites history\nother people have pulled.",
		});
		expect(text).not.toContain("\n");
		expect(text).toBe(`${SENTENCE} ${AXES}`);
	});
});

describe("debug", () => {
	test("debug adds the stage that decided", () => {
		expect(announce("debug", base)).toContain("decided by: stage 2 (review)");
		expect(announce("debug", { ...base, stage: 1 })).toContain("decided by: stage 1 (filter)");
	});

	/**
	 * A rule matches before either stage runs, so a rule block has no stage to report. A number a reader
	 * would take literally is worse than a line that is not there, so the line goes.
	 */
	test("a rule block with no stage prints no decided-by line", () => {
		const text = announce("debug", { ...base, stage: undefined, rule: "bash(*git reset --hard*)", agentPayload });
		expect(text).not.toContain("decided by");
		expect(text).toContain("rule: bash(*git reset --hard*)");
		expect(text).toContain(agentPayload);
	});

	test("a stage the classifier never reports prints no line at all", () => {
		expect(announce("debug", { ...base, stage: 0 })).not.toContain("decided by");
		expect(announce("debug", { ...base, stage: 7 })).not.toContain("decided by");
	});

	test("debug reproduces the payload the agent received verbatim", () => {
		expect(announce("debug", withProvenance)).toContain(agentPayload);
	});

	test("debug names the rule that blocked and where it came from", () => {
		expect(announce("debug", withProvenance)).toContain("rule: bash(*git reset --hard*) from project autoclassifier.yml");
	});

	test("a rule with no recorded origin still names the rule", () => {
		expect(announce("debug", { ...base, rule: "bash(*git reset --hard*)" })).toContain("rule: bash(*git reset --hard*)");
	});

	/** An origin names nothing on its own, so it cannot put a line on the screen by itself. */
	test("an origin without a rule prints no rule line", () => {
		expect(announce("debug", { ...base, ruleFrom: "project autoclassifier.yml" })).not.toContain("rule");
	});

	test("a model decision prints no rule line", () => {
		expect(announce("debug", { ...base, agentPayload })).not.toContain("rule:");
	});

	test("a refusal with no payload prints no payload label", () => {
		expect(announce("debug", base)).not.toContain("agent payload");
	});

	/** The summary and the axes stay on one line, so the extra fields read as additions below it. */
	test("debug keeps the summary and the axes on its first line", () => {
		expect(announce("debug", withProvenance).split("\n")[0]).toBe(`${SENTENCE} ${AXES}`);
	});
});

describe("levels", () => {
	/** The setting is a dial, not four formats: reading one level tells you what the one below it said. */
	test("each level starts with the level below it", () => {
		expect(announce("normal", withProvenance).startsWith(announce("minimal", withProvenance))).toBe(true);
		expect(announce("verbose", withProvenance).startsWith(announce("normal", withProvenance))).toBe(true);
		expect(announce("debug", withProvenance).startsWith(announce("verbose", withProvenance))).toBe(true);
	});

	test("only debug carries the payload the agent received", () => {
		const carrying = VERDICT_DETAIL_LEVELS.filter(level => announce(level, withProvenance).includes(agentPayload));
		expect(carrying).toEqual(["debug"]);
	});

	test("only debug spans more than one line", () => {
		const spanning = VERDICT_DETAIL_LEVELS.filter(level => announce(level, withProvenance).includes("\n"));
		expect(spanning).toEqual(["debug"]);
	});

	/**
	 * A described target can be a whole heredoc. `describeTarget` returns nothing when the call had no
	 * reportable argument, and a value that is only whitespace is the same absence one collapse later.
	 */
	test("a call with no reportable target reads without a dangling on", () => {
		for (const level of VERDICT_DETAIL_LEVELS) {
			expect(announce(level, { ...base, target: undefined })).toContain("autoclassifier blocked `bash`");
			expect(announce(level, { ...base, target: undefined })).not.toContain("`bash` on");
			expect(announce(level, { ...base, target: "  \n " })).not.toContain("`bash` on");
		}
	});

	/**
	 * A level omp never wrote. The value is validated on the way in, so this is the fallback for a caller
	 * rather than for a config file, and it lands on the conservative side of the payload.
	 */
	test("an unrecognised level does not reproduce the payload", () => {
		const text = announce("shouty" as VerdictDetail, withProvenance);
		expect(text).toBe(`${SENTENCE} ${AXES}`);
	});
});
