import { describe, expect, test } from "bun:test";
import { classify, type ClassifierDeps, type CompletionFn } from "../src/classifier";
import { DEFAULT_ENVIRONMENT, EVIDENCE_DEFAULTS } from "../src/defaults";

interface Call {
	systemPrompt: string[];
	text: string;
	maxTokens: number | undefined;
}

/** A queued reply: plain text, a thrown error, or a provider-level outcome that may also carry text. */
type Reply = string | Error | { stopReason: string; errorMessage?: string; text?: string };

/** A fake `complete` that returns queued replies and records what it was asked. */
function fakeCompletion(replies: Reply[]) {
	const calls: Call[] = [];
	const fn: CompletionFn = async (_model, context, options) => {
		const content = context.messages[0]?.content;
		const text = Array.isArray(content) ? String((content[0] as { text?: string })?.text ?? "") : String(content);
		calls.push({ systemPrompt: context.systemPrompt ?? [], text, maxTokens: options?.maxTokens });
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

	test("the filter stage is capped at a handful of tokens", async () => {
		const fake = fakeCompletion(["0"]);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(fake.calls[0]?.maxTokens).toBe(5);
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

describe("stage two", () => {
	test("a deny verdict carries the reason and risk", async () => {
		const fake = fakeCompletion(["1", '{"decision":"deny","risk":"high","reason":"Adds an SSH key."}']);
		const result = await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(result.kind).toBe("deny");
		if (result.kind === "deny") {
			expect(result.reason).toContain("Adds an SSH key.");
			expect(result.risk).toBe("high");
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

	test("the filter stage is told to err toward review", async () => {
		const fake = fakeCompletion(["0"]);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		expect(fake.calls[0]?.systemPrompt.join("\n").toLowerCase()).toContain("unsure");
	});

	test("the reasoning stage states the policy it applies", async () => {
		const fake = fakeCompletion(["1", '{"decision":"allow","risk":"low","reason":"ok"}']);
		await classify(deps({ complete: fake.fn }), evidence, timeouts);
		const prompt = fake.calls[1]?.systemPrompt.join("\n").toLowerCase() ?? "";
		expect(prompt).toContain("irreversib");
		expect(prompt).toContain("authoriz");
		expect(prompt).toContain("json");
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
