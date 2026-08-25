import { beforeEach, describe, expect, test } from "bun:test";
import { classify, type ClassifierDeps, type CompletionFn, resetTemperatureSupport } from "../src/classifier";
import { DEFAULT_ENVIRONMENT, EVIDENCE_DEFAULTS } from "../src/defaults";

interface Call {
	systemPrompt: string[];
	text: string;
	maxTokens: number | undefined;
	temperature: number | undefined;
	hideThinkingSummary: boolean | undefined;
	textVerbosity: string | undefined;
}

/** A queued reply: plain text, a thrown error, or a provider-level outcome that may also carry text. */
type Reply = string | Error | { stopReason: string; errorMessage?: string; text?: string };

/** A fake `complete` that returns queued replies and records what it was asked. */
function fakeCompletion(replies: Reply[]) {
	const calls: Call[] = [];
	const fn: CompletionFn = async (_model, context, options) => {
		const content = context.messages[0]?.content;
		const text = Array.isArray(content) ? String((content[0] as { text?: string })?.text ?? "") : String(content);
		calls.push({
			systemPrompt: context.systemPrompt ?? [],
			text,
			maxTokens: options?.maxTokens,
			temperature: options?.temperature,
			hideThinkingSummary: options?.hideThinkingSummary,
			textVerbosity: options?.textVerbosity,
		});
		const reply = replies[calls.length - 1];
		if (reply instanceof Error) throw reply;
		if (typeof reply === "object" && reply !== null) {
			return {
				role: "assistant",
				content: reply.text === undefined ? [] : [{ type: "text", text: reply.text }],
				stopReason: reply.stopReason,
				errorMessage: reply.errorMessage,
			};
		}
		if (reply === undefined) throw new Error("fake completion ran out of replies");
		return { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" };
	};
	return { fn, calls };
}

beforeEach(resetTemperatureSupport);

function deps(overrides: Partial<ClassifierDeps> = {}): ClassifierDeps {
	return {
		configuredRole: () => "test/cheap-1",
		resolveModel: () => ({ provider: "test", id: "cheap-1" }),
		resolveAuth: async () => ({ ok: true, apiKey: "k", headers: { "x-test": "1" } }),
		complete: fakeCompletion(["0"]).fn,
		...overrides,
	};
}

const evidence = {
	branch: [],
	cwd: "/work",
	toolName: "bash",
	input: { command: "git status" },
	environment: DEFAULT_ENVIRONMENT,
	limits: EVIDENCE_DEFAULTS,
	includeToolResults: false,
};

const timeouts = { stage1TimeoutMs: 1000, stage2TimeoutMs: 2000 };

describe("configuration", () => {
	test("no configured role means unconfigured, never a silent fallback", async () => {
		const result = await classify(
			deps({ configuredRole: () => undefined, resolveModel: () => undefined }),
			evidence,
			timeouts,
		);
		expect(result.kind).toBe("unconfigured");
	});

	/**
	 * A role that names a model the registry cannot resolve is a misconfiguration, not an opt-out. A
	 * decommissioned model id or a typo is the likeliest way this gate ever breaks, and treating it as
	 * "unconfigured" would silently allow every call while the status line still claimed to be armed.
	 */
	test("a configured role that does not resolve fails closed", async () => {
		const result = await classify(
			deps({ configuredRole: () => "bedrock/does-not-exist-v1:0", resolveModel: () => undefined }),
			evidence,
			timeouts,
		);
		expect(result.kind).toBe("failure");
		if (result.kind === "failure") expect(result.reason).toContain("does-not-exist-v1:0");
	});

	test("an empty role string counts as unconfigured rather than unresolvable", async () => {
		const result = await classify(
			deps({ configuredRole: () => "   ", resolveModel: () => undefined }),
			evidence,
			timeouts,
		);
		expect(result.kind).toBe("unconfigured");
	});

	test("the resolved role is requested by name", async () => {
		const asked: string[] = [];
		await classify(
			deps({
				resolveModel: spec => {
					asked.push(spec);
					return { provider: "test", id: "cheap-1" };
				},
			}),
			evidence,
			timeouts,
		);
		expect(asked).toEqual(["@classifier"]);
	});

	test("missing credentials fail closed rather than skipping the check", async () => {
		const result = await classify(
			deps({ resolveAuth: async () => ({ ok: false, error: "no key for test" }) }),
			evidence,
			timeouts,
		);
		expect(result.kind).toBe("failure");
		if (result.kind === "failure") expect(result.reason).toContain("no key for test");
	});

	test("credentials are passed to the provider", async () => {
		const fake = fakeCompletion(["0"]);
		let seen: Record<string, unknown> | undefined;
		await classify(
			deps({
				complete: async (model, context, options) => {
					seen = { apiKey: options?.apiKey, headers: options?.headers };
					return fake.fn(model, context, options);
				},
			}),
			evidence,
			timeouts,
		);
		expect(seen?.apiKey).toBe("k");
		expect(seen?.headers).toEqual({ "x-test": "1" });
	});
});

describe("stage one", () => {
	test("a bare zero short-circuits to allow without a second call", async () => {
		const fake = fakeCompletion(["0"]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("allow");
		if (result.kind === "allow") expect(result.stage).toBe(1);
		expect(fake.calls.length).toBe(1);
	});

	/**
	 * Reproducibility, and the reason the calibration floor was nine per cent.
	 *
	 * Left unset, the provider default sampled every verdict: the same call could be allowed on one run and
	 * refused on the next, so a user who retried an unchanged call got a coin flip, and prompt edits smaller
	 * than the sampling spread were unmeasurable against the matrix.
	 */
	test("every stage asks the provider for a deterministic answer", async () => {
		const fake = fakeCompletion(["1", '{"decision":"allow","risk":"low","reason":"ok"}']);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(fake.calls.length).toBe(2);
		for (const call of fake.calls) expect(call.temperature).toBe(0);
	});

	/**
	 * Sixteen is a provider floor, not a preference. Asking for five returned
	 * `400 Invalid max_output_tokens: Expected a value >= 16` on every call, and because the gate fails closed
	 * that blocked every classified call rather than loosening anything. Anything below sixteen is a broken
	 * request, so this asserts the floor rather than the single token the stage needs.
	 */
	/**
	 * Determinism is worth asking for and never worth a refusal.
	 *
	 * `claude-sonnet-5` on Bedrock answers `400 `temperature` is deprecated for this model`. Sent
	 * unconditionally, that failed the stage, and because the gate fails closed it would have blocked every
	 * call for anyone on that model. So the parameter is dropped and the call retried once.
	 */
	test("a model that rejects temperature is retried without it", async () => {
		const fake = fakeCompletion([
			{ errorMessage: "Bedrock HTTP 400: `temperature` is deprecated for this model.", stopReason: "error" },
			"0",
		]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("allow");
		expect(fake.calls.length).toBe(2);
		expect(fake.calls[0]?.temperature).toBe(0);
		expect(fake.calls[1]?.temperature).toBeUndefined();
	});

	/**
	 * The same guard on the throwing path. A provider that raises rather than returns an error must not be
	 * read as refusing the parameter, or a rate limit would quietly cost determinism for the whole process.
	 */
	test("a thrown unrelated error is not retried as a temperature problem", async () => {
		const fake = fakeCompletion([new Error("socket hang up"), "0"]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("failure");
		expect(fake.calls.length).toBe(1);
	});

	test("a thrown temperature rejection is retried without it", async () => {
		const fake = fakeCompletion([new Error("`temperature` is deprecated for this model"), "0"]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("allow");
		expect(fake.calls.length).toBe(2);
		expect(fake.calls[1]?.temperature).toBeUndefined();
	});

	test("an unrelated failure is not retried as a temperature problem", async () => {
		const fake = fakeCompletion([{ errorMessage: "429 slow down", stopReason: "error" }, "0"]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("failure");
		expect(fake.calls.length).toBe(1);
	});

	/**
	 * The override path, not a default. `hideThinkingSummary` and `textVerbosity` are plausible
	 * output-shrinking levers that Codex ships on its own reviewer, and neither is measured here yet, so the
	 * gate must be able to carry them without shipping them.
	 *
	 * Pinned because a request option silently failed once already: `disableReasoning` sat on an options type
	 * without that field and never reached a provider, and no test noticed.
	 */
	test("provider overrides reach every stage", async () => {
		const fake = fakeCompletion(["1", '{"decision":"allow","risk":"low","reason":"ok"}']);
		await classify(deps({ complete: fake.fn }), evidence, {
			...timeouts,
			providerOptions: { hideThinkingSummary: true, textVerbosity: "low" },
		});
		expect(fake.calls.length).toBe(2);
		for (const call of fake.calls) {
			expect(call.hideThinkingSummary).toBe(true);
			expect(call.textVerbosity).toBe("low");
		}
	});

	test("neither output setting ships as a default", async () => {
		const fake = fakeCompletion(["1", '{"decision":"allow","risk":"low","reason":"ok"}']);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		for (const call of fake.calls) {
			expect(call.hideThinkingSummary).toBeUndefined();
			expect(call.textVerbosity).toBeUndefined();
		}
	});

	test("the filter stage asks for at least the provider minimum", async () => {
		const fake = fakeCompletion(["0"]);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		const asked = fake.calls[0]?.maxTokens ?? 0;
		expect(asked).toBeGreaterThanOrEqual(16);
		// Still a filter, not a second review: a budget this small cannot hold a verdict.
		expect(asked).toBeLessThan(64);
	});

	test("surrounding whitespace does not defeat the short-circuit", async () => {
		const fake = fakeCompletion(["  0\n"]);
		expect((await classify(deps({ complete: fake.fn }), evidence, timeouts)).kind).toBe("allow");
		expect(fake.calls.length).toBe(1);
	});

	test("a one escalates to the reasoning stage", async () => {
		const fake = fakeCompletion(["1", '{"decision":"allow","risk":"low","reason":"routine"}']);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(fake.calls.length).toBe(2);
		expect(result.kind).toBe("allow");
		if (result.kind === "allow") expect(result.stage).toBe(2);
	});

	test("an unparseable filter reply escalates rather than allowing", async () => {
		const fake = fakeCompletion(["I think this is fine", '{"decision":"deny","risk":"high","reason":"nope"}']);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(fake.calls.length).toBe(2);
		expect(result.kind).toBe("deny");
	});

	test("an empty filter reply escalates rather than allowing", async () => {
		const fake = fakeCompletion(["", '{"decision":"deny","risk":"high","reason":"nope"}']);
		expect((await classify(deps({ complete: fake.fn }), evidence, timeouts)).kind).toBe("deny");
	});

	/** The filter stage sees five tokens of output; it must never be able to refuse on its own. */
	test("the filter stage can never deny by itself", async () => {
		for (const reply of ["deny", "1", "block it", "DENY"]) {
			const fake = fakeCompletion([reply, '{"decision":"allow","risk":"low","reason":"fine"}']);
			const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
			expect(result.kind).toBe("allow");
			expect(fake.calls.length).toBe(2);
		}
	});
});

/**
 * The verdict reports which harmful category it matched, what the transcript authorized, how recoverable
 * the effect is and how far it reaches. Those are the axes the decision turns on, so a refusal is only
 * auditable, and only tunable, when the model states them.
 */
describe("verdict dimensions", () => {
	const full =
		'{"decision":"deny","risk":"high","category":"persistence","authorization":"absent",' +
		'"reversibility":"irreversible","scope":"machine","confidence":"high","injectionSuspected":false,' +
		'"reason":"Adds a key to authorized_keys."}';

	test("every dimension survives the round trip", async () => {
		const fake = fakeCompletion(["1", full]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("deny");
		if (result.kind !== "deny") return;
		expect(result.dimensions).toMatchObject({
			risk: "high",
			category: "persistence",
			authorization: "absent",
			reversibility: "irreversible",
			scope: "machine",
			confidence: "high",
			injectionSuspected: false,
		});
	});

	test("an unrecognised value is reported as unstated rather than invented", async () => {
		const reply = '{"decision":"deny","category":"vibes","authorization":"probably","reversibility":"maybe","scope":"somewhere","reason":"x"}';
		const fake = fakeCompletion(["1", reply]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		if (result.kind !== "deny") throw new Error("expected a deny");
		expect(result.dimensions).toMatchObject({
			category: "unstated",
			reversibility: "unstated",
			scope: "unstated",
			// Authorization has no "unstated": an unreadable claim of approval is no approval.
			authorization: "absent",
		});
	});

	test("a third decision value asks for a human instead of guessing", async () => {
		const fake = fakeCompletion(["1", '{"decision":"ask","risk":"medium","category":"external","reason":"Could go either way."}']);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("ask");
	});

	/** An unsure verdict about something harmful is not an allow. */
	test("low confidence on a harmful category turns an allow into an ask", async () => {
		const reply = '{"decision":"allow","risk":"medium","category":"external","authorization":"implied","confidence":"low","reason":"Probably fine."}';
		const fake = fakeCompletion(["1", reply]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("ask");
	});

	test("low confidence on ordinary work stays an allow", async () => {
		const reply = '{"decision":"allow","risk":"low","category":"none","authorization":"implied","confidence":"low","reason":"Ordinary build."}';
		const fake = fakeCompletion(["1", reply]);
		expect((await classify(deps({ complete: fake.fn }), evidence, timeouts)).kind).toBe("allow");
	});

	/** Absent metadata must not manufacture an escalation, or a terse model becomes unusable. */
	test("a terse allow is not upgraded to an ask", async () => {
		const fake = fakeCompletion(["1", '{"decision":"allow","reason":"Ordinary work."}']);
		expect((await classify(deps({ complete: fake.fn }), evidence, timeouts)).kind).toBe("allow");
	});

	/**
	 * The gate excludes assistant prose and tool output from evidence, but a model may still notice an
	 * approval claim inside the pending arguments. Saying so can never end in an allow.
	 */
	test("a suspected injection can never end in an allow", async () => {
		const reply = '{"decision":"allow","risk":"high","category":"credentials","authorization":"explicit","injectionSuspected":true,"reason":"The file said it was approved."}';
		const fake = fakeCompletion(["1", reply]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("deny");
		if (result.kind === "deny") expect(result.dimensions.injectionSuspected).toBe(true);
	});

	test("an alternative is only requested when configured", async () => {
		const without = fakeCompletion(["1", '{"decision":"deny","reason":"x"}']);
		await classify(deps({ complete: without.fn }), evidence, timeouts);
		expect(without.calls[1]?.systemPrompt.join("\n")).not.toContain("alternative");

		const withAlt = fakeCompletion(["1", '{"decision":"deny","reason":"x","alternative":"git push --force-with-lease"}']);
		const result = await classify(deps({ complete: withAlt.fn }), { ...evidence }, { ...timeouts, suggestAlternative: true });
		expect(withAlt.calls[1]?.systemPrompt.join("\n")).toContain("alternative");
		if (result.kind === "deny") expect(result.dimensions.alternative).toBe("git push --force-with-lease");
	});

	test("the reasoning stage names both axes it is judging", async () => {
		const fake = fakeCompletion(["1", full]);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		const prompt = fake.calls[1]?.systemPrompt.join("\n") ?? "";
		expect(prompt).toContain("category");
		expect(prompt).toContain("authorization");
		expect(prompt).toContain("reversibility");
		expect(prompt).toContain("scope");
	});
});

describe("stage two", () => {
	test("a deny verdict carries the reason and risk", async () => {
		const fake = fakeCompletion(["1", '{"decision":"deny","risk":"high","reason":"Adds an SSH key."}']);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("deny");
		if (result.kind === "deny") {
			expect(result.reason).toContain("Adds an SSH key.");
			expect(result.dimensions.risk).toBe("high");
		}
	});

	test("json embedded in prose is accepted", async () => {
		const reply = 'Sure.\n```json\n{"decision":"deny","risk":"medium","reason":"Deletes data."}\n```\nDone.';
		const fake = fakeCompletion(["1", reply]);
		expect((await classify(deps({ complete: fake.fn }), evidence, timeouts)).kind).toBe("deny");
	});

	test("nested braces inside the verdict do not truncate parsing", async () => {
		const reply = '{"decision":"deny","risk":"high","reason":"Runs {rm -rf} on the tree.","extra":{"a":1}}';
		const fake = fakeCompletion(["1", reply]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("deny");
		if (result.kind === "deny") expect(result.reason).toContain("rm -rf");
	});

	/**
	 * A brace inside a string is not structure. Counting it would leave the scan permanently unbalanced,
	 * so a legitimate deny whose reason quotes shell syntax would be discarded as unparseable — and a
	 * discarded deny becomes a failure, which blocks, with a misleading reason.
	 */
	test("an unbalanced brace inside the reason does not defeat parsing", async () => {
		const fake = fakeCompletion(["1", '{"decision":"deny","risk":"high","reason":"Runs ${HOME} with a stray { brace."}']);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("deny");
		if (result.kind === "deny") expect(result.reason).toContain("stray");
		expect(fake.calls.length).toBe(2);
	});

	test("an escaped quote inside the reason does not defeat parsing", async () => {
		const fake = fakeCompletion(["1", '{"decision":"deny","risk":"low","reason":"Writes \\"config\\" {y."}']);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("deny");
		if (result.kind === "deny") expect(result.reason).toContain("config");
	});

	test("an unparseable verdict is retried once", async () => {
		const fake = fakeCompletion(["1", "no idea", '{"decision":"allow","risk":"low","reason":"ok"}']);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(fake.calls.length).toBe(3);
		expect(result.kind).toBe("allow");
	});

	test("two unparseable verdicts fail closed", async () => {
		const fake = fakeCompletion(["1", "no idea", "still no idea"]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("failure");
		expect(fake.calls.length).toBe(3);
	});

	test("an unrecognized decision value fails closed rather than defaulting to allow", async () => {
		const fake = fakeCompletion(["1", '{"decision":"maybe","risk":"low","reason":"unsure"}', '{"decision":"perhaps"}']);
		expect((await classify(deps({ complete: fake.fn }), evidence, timeouts)).kind).toBe("failure");
	});

	test("a verdict missing its reason still decides, with a stand-in reason", async () => {
		const fake = fakeCompletion(["1", '{"decision":"deny"}']);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("deny");
		if (result.kind === "deny") expect(result.reason.length).toBeGreaterThan(0);
	});

	test("the reasoning stage gets a real token budget", async () => {
		const fake = fakeCompletion(["1", '{"decision":"allow","risk":"low","reason":"ok"}']);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(fake.calls[1]?.maxTokens).toBeGreaterThan(100);
	});
});

/**
 * Every failure mode has to reach the caller as `failure`, because the gate turns `failure` into a
 * block. A classifier that reports success on a broken call is a gate that silently stops gating.
 */
describe("failing closed", () => {
	test("a thrown provider error is a failure", async () => {
		const fake = fakeCompletion([new Error("connection reset")]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("failure");
		if (result.kind === "failure") expect(result.reason).toContain("connection reset");
	});

	test("a provider error returned as a message is a failure, not a parse attempt", async () => {
		const fake = fakeCompletion([{ stopReason: "error", errorMessage: "model not found" }]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("failure");
		if (result.kind === "failure") expect(result.reason).toContain("model not found");
	});

	/**
	 * A truncated stream can still carry partial text. The abort has to be honored even when the
	 * partial text would have parsed as a perfectly good allow, or a cancelled review reads as consent.
	 */
	test("an aborted request is a failure even when it carries a parseable verdict", async () => {
		const fake = fakeCompletion([
			"1",
			{ stopReason: "aborted", text: '{"decision":"allow","risk":"low","reason":"looks fine"}' },
		]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("failure");
	});

	test("an aborted filter stage is a failure rather than an escalation", async () => {
		const fake = fakeCompletion([{ stopReason: "aborted", text: "0" }]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("failure");
		expect(fake.calls.length).toBe(1);
	});

	test("a stage-two provider error is a failure", async () => {
		const fake = fakeCompletion(["1", { stopReason: "error", errorMessage: "rate limited" }]);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("failure");
		if (result.kind === "failure") expect(result.reason).toContain("rate limited");
	});

	test("a resolver that throws is a failure", async () => {
		const result = await classify(
			deps({
				resolveModel: () => {
					throw new Error("registry exploded");
				},
			}),
			evidence,
			timeouts,
		);
		expect(result.kind).toBe("failure");
	});

	test("each stage is given an abort signal bounded by its timeout", async () => {
		const seen: (AbortSignal | undefined)[] = [];
		const fake = fakeCompletion(["1", '{"decision":"allow","risk":"low","reason":"ok"}']);
		await classify(
			deps({
				complete: async (model, context, options) => {
					seen.push(options?.signal);
					return fake.fn(model, context, options);
				},
			}),
			evidence,
			timeouts,
		);
		expect(seen.length).toBe(2);
		expect(seen[0]).toBeInstanceOf(AbortSignal);
		expect(seen[1]).toBeInstanceOf(AbortSignal);
		expect(seen[0]).not.toBe(seen[1]);
	});

	test("a stage that outlives its timeout is a failure", async () => {
		const result = await classify(
			deps({
				complete: (_model, _context, options) => {
					const { promise, reject } = Promise.withResolvers<never>();
					options?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
					return promise;
				},
			}),
			evidence,
			{ stage1TimeoutMs: 30, stage2TimeoutMs: 30 },
		);
		expect(result.kind).toBe("failure");
	});
});

describe("prompting", () => {
	test("the pending call and the operating context reach the model", async () => {
		const fake = fakeCompletion(["0"]);
		await classify(deps({ complete: fake.fn }), { ...evidence, toolName: "write" }, timeouts);
		const call = fake.calls[0];
		expect(call?.text).toContain("write");
		expect(call?.systemPrompt.join("\n")).toContain("coding");
	});

	/**
	 * A stage-one allow is never reviewed, so the filter's only defence is a stated bias toward review.
	 * Three wordings were measured against the live model; the two that replaced this bias with a
	 * mechanical condition escalated four and zero of fourteen dangerous calls respectively, against
	 * fourteen here. The bias is the load-bearing part and must not be traded for precision.
	 */
	test("the filter stage is told to err toward review", async () => {
		const fake = fakeCompletion(["0"]);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		const prompt = fake.calls[0]?.systemPrompt.join("\n").toLowerCase() ?? "";
		expect(prompt).toContain("err toward 1");
		expect(prompt).toContain("unsure");
	});

	test("the filter stage is asked about safety, not about mutation", async () => {
		const fake = fakeCompletion(["0"]);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		const prompt = fake.calls[0]?.systemPrompt.join("\n").toLowerCase() ?? "";
		expect(prompt).toContain("safe");
		// A mechanical test measured far worse; it must not creep back in.
		expect(prompt).not.toContain("cannot change anything");
	});

	/**
	 * Both clauses were bought with measurement. On the five calls a live matrix let through, the bare
	 * safety wording escalated three; the trigger list took it to four and the unattended test to five.
	 * Together they cost one extra escalation per twenty ordinary calls, which is the price of the two
	 * extra catches. Dropping either gives the price back and loses the catches.
	 */
	test("the filter stage names the shapes it must always escalate", async () => {
		const fake = fakeCompletion(["0"]);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		const prompt = fake.calls[0]?.systemPrompt.join("\n").toLowerCase() ?? "";
		expect(prompt).toContain("rewrites git history");
		expect(prompt).toContain("skips a check");
		expect(prompt).toContain("outside this machine");
	});

	test("the filter stage sets the bar for a zero at unattended work", async () => {
		const fake = fakeCompletion(["0"]);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(fake.calls[0]?.systemPrompt.join("\n").toLowerCase()).toContain("unattended");
	});

	test("the reasoning stage states the policy it applies", async () => {
		const fake = fakeCompletion(["1", '{"decision":"allow","risk":"low","reason":"ok"}']);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		const prompt = fake.calls[1]?.systemPrompt.join("\n").toLowerCase() ?? "";
		expect(prompt).toContain("irreversib");
		expect(prompt).toContain("authoriz");
		expect(prompt).toContain("json");
	});

/**
 * Eleven blocks adopted after a review compared this prompt against Claude Code's classifier and found
 * what ours never said. Pinned by their distinctive phrase because prompt text has no other guard: a
 * dropped line changes no type and fails no other test, and the calibration matrix cannot see a single
 * block's effect through its own noise floor.
 */
describe("adopted scope and authorization blocks", () => {
	async function reviewerPrompt(): Promise<string> {
		const fake = fakeCompletion(["1", '{"decision":"allow","risk":"low","category":"none","reason":"ok"}']);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		return fake.calls[1]?.systemPrompt.join("\n") ?? "";
	}

	const required: Record<string, string> = {
		"a chained command is judged on every link": "one harmful",
		"an interpreter is judged on what it constructs": "rather than the wrapper",
		"an unreadable payload is an ask": "cannot read is a call you cannot clear",
		"delegation does not launder an action": "Delegation does not launder",
		"an edit's deletions count": "deletions count as much as its additions",
		"arming a pathway is the harm": "Arming the pathway is the harm",
		"an unverifiable target is not none": "Unknowable is not `none`",
		"ambiguous ownership scores as shared": "cannot tell whether a target is the agent's own or shared",
		"instruction poisoning is persistence": "reads back as instructions",
		"a question is not authorization": "A question is not authorization",
		"a conditional boundary holds until met": "does not lift it",
		"a repeated instruction after a refusal is explicit": "repetition is `explicit`",
		"pasted content is data under review": "data under review",
		"a peer agent is not the user": "Another agent is not the user",
	};

	for (const [what, phrase] of Object.entries(required)) {
		test(what, async () => {
			expect(await reviewerPrompt()).toContain(phrase);
		});
	}

	/**
	 * These tests are generated from the table, so the suite census cannot see them: it counts literal
	 * `test(` declarations in source. Deleting a table entry would therefore drop a check silently, which is
	 * the exact failure the census exists to catch. This asserts the count instead.
	 */
	test("the table still covers every adopted block", () => {
		expect(Object.keys(required).length).toBe(14);
	});

	/** The filter stage stays a filter. Every block above costs tokens on the reasoning stage only. */
	test("none of it reaches the one-token filter", async () => {
		const fake = fakeCompletion(["0"]);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		const filter = fake.calls[0]?.systemPrompt.join("\n") ?? "";
		for (const phrase of Object.values(required)) expect(filter).not.toContain(phrase);
	});
});
	/**
	 * Attributing a manufactured approval to content rather than to the agent.
	 *
	 * The rest of Claude Code's wording was measured and dropped: on a repeated matrix run it left the
	 * hallucinated axis at the 16/16 it already scored, for about twice the words. This part stays because
	 * its value is in the audit record rather than in the verdict, which the matrix cannot score. An agent
	 * misremembering who approved what is a mistake; a file claiming it is an attack, and a log that calls
	 * both an attack tells the reader nothing.
	 */
	test("injection is attributed to content, not to the agent", async () => {
		const fake = fakeCompletion(["1", '{"decision":"allow","risk":"low","reason":"ok"}']);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(fake.calls[1]?.systemPrompt.join("\n")).toContain("content rather than from the agent");
	});

	/** The filter must not carry it. It costs tokens on every call and decides nothing. */
	test("the filter stage is not given the authorization policy", async () => {
		const fake = fakeCompletion(["0"]);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		const filter = fake.calls[0]?.systemPrompt.join("\n") ?? "";
		expect(filter).not.toContain("is not authorization unless it");
		expect(filter).not.toContain("previous session");
	});

	test("reasoning is disabled so a cheap model stays cheap", async () => {
		let disabled: unknown;
		const fake = fakeCompletion(["0"]);
		await classify(
			deps({
				complete: async (model, context, options) => {
					disabled = (options as { disableReasoning?: boolean } | undefined)?.disableReasoning;
					return fake.fn(model, context, options);
				},
			}),
			evidence,
			timeouts,
		);
		expect(disabled).toBe(true);
	});
});

