import { describe, expect, test } from "bun:test";
import { ConfigStore } from "../src/config";
import { VerdictCache } from "../src/cache";
import type { ClassifyResult } from "../src/classifier";
import { compileRules, expandDefaults, pathVars } from "../src/rules";
import { DEFAULT_ALLOW, DEFAULT_ENVIRONMENT, DEFAULT_HARD_DENY, EVIDENCE_DEFAULTS, SCALAR_DEFAULTS } from "../src/defaults";
import type { EffectiveConfig } from "../src/config";
import { decide, type GateDeps, type GateRequest } from "../src/gate";
import { GateState } from "../src/state";

const vars = pathVars("/agent", "/work", "/plugins");

function config(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
	const rules = {
		hardDeny: [...DEFAULT_HARD_DENY],
		deny: [] as string[],
		ask: [] as string[],
		allow: [...DEFAULT_ALLOW],
		...overrides.rules,
	};
	return {
		...SCALAR_DEFAULTS,
		environment: [...DEFAULT_ENVIRONMENT],
		evidence: EVIDENCE_DEFAULTS,
		logPath: "/agent/autoclassifier/decisions.jsonl",
		origins: {},
		warnings: [],
		...overrides,
		rules,
		compiled: compileRules(rules, vars),
	};
}

interface Harness {
	deps: GateDeps;
	state: GateState;
	cache: VerdictCache;
	classifyCalls: number;
	escalateCalls: number;
	notices: string[];
	childDenials: string[];
	logged: { decision: string; via: string }[];
}

function harness(options: {
	cfg?: Partial<EffectiveConfig>;
	verdict?: ClassifyResult;
	env?: Record<string, string>;
	escalate?: "once" | "session" | "deny" | Error;
} = {}): Harness {
	const cfg = config(options.cfg);
	const state = new GateState(cfg);
	const cache = new VerdictCache(cfg.cacheSize);
	const result: Harness = {
		state,
		cache,
		classifyCalls: 0,
		escalateCalls: 0,
		notices: [],
		childDenials: [],
		logged: [],
		deps: {} as GateDeps,
	};
	result.deps = {
		config: () => cfg,
		state,
		cache,
		cwd: "/work",
		branch: () => [],
		env: name => options.env?.[name],
		classify: async () => {
			result.classifyCalls++;
			return options.verdict ?? { kind: "allow", reason: "fine", stage: 2 };
		},
		escalate: async () => {
			result.escalateCalls++;
			if (options.escalate instanceof Error) throw options.escalate;
			return options.escalate ?? "deny";
		},
		notify: message => {
			result.notices.push(message);
		},
		reportChildDenial: (_tool, reason) => {
			result.childDenials.push(reason);
		},
		log: record => {
			result.logged.push({ decision: record.decision, via: record.via });
		},
	};
	return result;
}

const call = (overrides: Partial<GateRequest> = {}): GateRequest => ({
	toolName: "bash",
	input: { command: "git status" },
	hasUI: true,
	approvalMode: "yolo",
	...overrides,
});

/**
 * Ordering is the whole security contract: an early return in the wrong place is a silent hole. Each
 * test below pins one step of that order and says why it sits where it does.
 */
describe("decision order", () => {
	test("the kill switch env var bypasses everything, including anti-tamper", async () => {
		const h = harness({ env: { OMP_AUTOCLASSIFIER_DISABLE: "1" } });
		const decision = await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		expect(decision.action).toBe("allow");
		expect(h.classifyCalls).toBe(0);
	});

	test("any other value of the env var does not disable the gate", async () => {
		const h = harness({ env: { OMP_AUTOCLASSIFIER_DISABLE: "0" } });
		expect((await decide(h.deps, call())).action).toBe("allow");
		expect(h.classifyCalls).toBe(1);
	});

	test("disabling the gate is an explicit opt-out and lifts anti-tamper too", async () => {
		const h = harness({ cfg: { enabled: false } });
		const decision = await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		expect(decision.action).toBe("allow");
	});

	/**
	 * hardDeny outranks the mode filter and the breaker. If pausing or an inactive mode lifted
	 * anti-tamper, the agent could disable the gate during exactly the window when it is not watching.
	 */
	test("anti-tamper survives an inactive approval mode", async () => {
		const h = harness({ cfg: { activeModes: "always-ask" } });
		const decision = await decide(
			h.deps,
			call({ approvalMode: "yolo", toolName: "write", input: { path: "/agent/autoclassifier.yml" } }),
		);
		expect(decision.action).toBe("block");
		expect(decision.via).toBe("hardDeny");
	});

	test("anti-tamper survives a paused breaker", async () => {
		const h = harness();
		h.state.pause();
		const decision = await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		expect(decision.action).toBe("block");
		expect(decision.via).toBe("hardDeny");
	});

	test("an inactive approval mode skips classification", async () => {
		const h = harness({ cfg: { activeModes: "always-ask" } });
		expect((await decide(h.deps, call({ approvalMode: "yolo" }))).action).toBe("allow");
		expect(h.classifyCalls).toBe(0);
	});

	test("an active approval mode classifies", async () => {
		const h = harness({ cfg: { activeModes: "yolo,write" } });
		expect((await decide(h.deps, call({ approvalMode: "write" }))).action).toBe("allow");
		expect(h.classifyCalls).toBe(1);
	});

	test("whitespace in the configured mode list is tolerated", async () => {
		const h = harness({ cfg: { activeModes: " yolo , write " } });
		await decide(h.deps, call({ approvalMode: "write" }));
		expect(h.classifyCalls).toBe(1);
	});

	test("a paused breaker allows and says so", async () => {
		const h = harness();
		h.state.pause();
		const decision = await decide(h.deps, call());
		expect(decision.action).toBe("allow");
		expect(decision.via).toBe("paused");
		expect(h.classifyCalls).toBe(0);
	});

	test("a deny rule blocks without spending a model call", async () => {
		const h = harness({ cfg: { rules: { hardDeny: [], deny: ["bash(git push*)"], ask: [], allow: [] } } });
		const decision = await decide(h.deps, call({ input: { command: "git push --force" } }));
		expect(decision.action).toBe("block");
		expect(decision.via).toBe("deny");
		expect(h.classifyCalls).toBe(0);
	});

	test("an allow rule short-circuits before the classifier", async () => {
		const h = harness();
		const decision = await decide(h.deps, call({ toolName: "read", input: { path: "README.md" } }));
		expect(decision.action).toBe("allow");
		expect(decision.via).toBe("allow");
		expect(h.classifyCalls).toBe(0);
	});

	test("an unmatched call reaches the classifier", async () => {
		const h = harness();
		await decide(h.deps, call());
		expect(h.classifyCalls).toBe(1);
	});

	test("the block reason names the rule that fired, so the model can react", async () => {
		const h = harness({ cfg: { rules: { hardDeny: [], deny: ["bash(git push*)"], ask: [], allow: [] } } });
		const decision = await decide(h.deps, call({ input: { command: "git push --force" } }));
		expect(decision).toMatchObject({ action: "block", reason: expect.stringContaining("bash(git push*)") });
	});
});

describe("verdict cache", () => {
	test("a classified allow is remembered and skips the second call", async () => {
		const h = harness();
		await decide(h.deps, call());
		await decide(h.deps, call());
		expect(h.classifyCalls).toBe(1);
	});

	test("a denial is never cached, so authorization granted in chat takes effect", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "risky", risk: "high", stage: 2 } });
		await decide(h.deps, call());
		await decide(h.deps, call());
		expect(h.classifyCalls).toBe(2);
	});

	test("a classifier failure is never cached either", async () => {
		const h = harness({ verdict: { kind: "failure", reason: "unreachable" } });
		await decide(h.deps, call());
		await decide(h.deps, call());
		expect(h.classifyCalls).toBe(2);
	});

	test("a different argument is classified separately", async () => {
		const h = harness();
		await decide(h.deps, call({ input: { command: "a" } }));
		await decide(h.deps, call({ input: { command: "b" } }));
		expect(h.classifyCalls).toBe(2);
	});
});

describe("failing closed", () => {
	test("a classifier failure blocks", async () => {
		const h = harness({ verdict: { kind: "failure", reason: "model unreachable" } });
		const decision = await decide(h.deps, call());
		expect(decision).toMatchObject({ action: "block", reason: expect.stringContaining("model unreachable") });
	});

	test("a classifier failure marks the gate degraded", async () => {
		const h = harness({ verdict: { kind: "failure", reason: "model unreachable" } });
		await decide(h.deps, call());
		expect(h.state.degradedReason).toBe("model unreachable");
	});

	test("a degraded gate notifies once, not on every call", async () => {
		const h = harness({ verdict: { kind: "failure", reason: "model unreachable" } });
		await decide(h.deps, call({ input: { command: "a" } }));
		await decide(h.deps, call({ input: { command: "b" } }));
		expect(h.notices.length).toBe(1);
	});

	test("a classifier that throws blocks rather than escaping", async () => {
		const h = harness();
		h.deps.classify = async () => {
			throw new Error("classifier exploded");
		};
		const decision = await decide(h.deps, call());
		expect(decision).toMatchObject({ action: "block", reason: expect.stringContaining("classifier exploded") });
	});

	/** Without a classifier role there is nothing to ask, so the gate says so instead of pretending. */
	test("an unconfigured classifier allows and asks the user to run setup", async () => {
		const h = harness({ verdict: { kind: "unconfigured" } });
		const decision = await decide(h.deps, call());
		expect(decision.action).toBe("allow");
		expect(decision.via).toBe("unconfigured");
		expect(h.notices.join(" ")).toContain("/autoclassifier setup");
	});

	test("the unconfigured notice does not repeat every call", async () => {
		const h = harness({ verdict: { kind: "unconfigured" } });
		await decide(h.deps, call({ input: { command: "a" } }));
		await decide(h.deps, call({ input: { command: "b" } }));
		expect(h.notices.length).toBe(1);
	});
});

describe("escalation", () => {
	test("an ask rule blocks when escalation is off", async () => {
		const h = harness({ cfg: { rules: { hardDeny: [], deny: [], ask: ["bash"], allow: [] } } });
		const decision = await decide(h.deps, call());
		expect(decision.action).toBe("block");
		expect(decision.via).toBe("ask");
		// Not merely refused: the user is never interrupted at all when escalation is off.
		expect(h.escalateCalls).toBe(0);
	});

	/**
	 * The prompt runs UI code that can fail — a torn-down terminal, a cancelled dialog, a timeout. An
	 * unusable prompt has to read as refusal, never as consent.
	 */
	test("a prompt that fails outright blocks", async () => {
		const h = harness({
			cfg: { escalate: true, rules: { hardDeny: [], deny: [], ask: ["bash"], allow: [] } },
			escalate: new Error("terminal is gone"),
		});
		const decision = await decide(h.deps, call());
		expect(decision.action).toBe("block");
		expect(h.escalateCalls).toBe(1);
	});

	test("an ask rule prompts when escalation is on and a ui exists", async () => {
		const h = harness({ cfg: { escalate: true, rules: { hardDeny: [], deny: [], ask: ["bash"], allow: [] } }, escalate: "once" });
		const decision = await decide(h.deps, call());
		expect(decision.action).toBe("allow");
		expect(decision.via).toBe("escalated");
	});

	test("declining at the prompt blocks", async () => {
		const h = harness({ cfg: { escalate: true, rules: { hardDeny: [], deny: [], ask: ["bash"], allow: [] } }, escalate: "deny" });
		expect((await decide(h.deps, call())).action).toBe("block");
	});

	test("allowing once does not persist to the next call", async () => {
		const h = harness({ cfg: { escalate: true, rules: { hardDeny: [], deny: [], ask: ["bash"], allow: [] } }, escalate: "once" });
		await decide(h.deps, call());
		expect(h.cache.isAllowed("bash", { command: "git status" })).toBe(false);
	});

	test("allowing for the session is remembered in the cache", async () => {
		const h = harness({
			cfg: { escalate: true, rules: { hardDeny: [], deny: [], ask: ["bash"], allow: [] } },
			escalate: "session",
		});
		await decide(h.deps, call());
		expect(h.cache.isAllowed("bash", { command: "git status" })).toBe(true);
	});

	test("a classifier denial can also escalate when configured", async () => {
		const h = harness({ cfg: { escalate: true }, verdict: { kind: "deny", reason: "risky", risk: "high", stage: 2 }, escalate: "once" });
		expect((await decide(h.deps, call())).action).toBe("allow");
	});

	test("a hard deny is never escalatable", async () => {
		const h = harness({ cfg: { escalate: true }, escalate: "once" });
		const decision = await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		expect(decision.action).toBe("block");
	});
});

/**
 * A subagent is headless: `ctx.hasUI` is false, so there is no dialog to escalate to and its transcript
 * is rarely read. The policy is deliberately stricter there.
 */
describe("subagents", () => {
	test("an ask outcome becomes a block, since there is nothing to escalate to", async () => {
		const h = harness({ cfg: { escalate: true, rules: { hardDeny: [], deny: [], ask: ["bash"], allow: [] } }, escalate: "once" });
		const decision = await decide(h.deps, call({ hasUI: false }));
		expect(decision.action).toBe("block");
	});

	test("a classifier denial cannot be escalated away in a subagent", async () => {
		const h = harness({ cfg: { escalate: true }, verdict: { kind: "deny", reason: "risky", risk: "high", stage: 2 }, escalate: "once" });
		expect((await decide(h.deps, call({ hasUI: false }))).action).toBe("block");
	});

	test("the fast-path allow list still applies in a subagent", async () => {
		const h = harness();
		const decision = await decide(h.deps, call({ hasUI: false, toolName: "read", input: { path: "a.ts" } }));
		expect(decision.action).toBe("allow");
	});

	test("a denial inside a subagent is reported upward", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "Adds an SSH key.", risk: "high", stage: 2 } });
		await decide(h.deps, call({ hasUI: false }));
		expect(h.childDenials).toEqual(["Adds an SSH key."]);
	});

	test("a denial in an interactive session is not reported as a child denial", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "nope", risk: "high", stage: 2 } });
		await decide(h.deps, call({ hasUI: true }));
		expect(h.childDenials).toEqual([]);
	});

	test("subagent classification can be turned off without lifting anti-tamper", async () => {
		const h = harness({ cfg: { classifySubagents: false } });
		expect((await decide(h.deps, call({ hasUI: false }))).action).toBe("allow");
		expect(h.classifyCalls).toBe(0);

		const tamper = await decide(
			h.deps,
			call({ hasUI: false, toolName: "write", input: { path: "/agent/autoclassifier.yml" } }),
		);
		expect(tamper.action).toBe("block");
	});

	test("turning off subagent classification leaves interactive sessions classified", async () => {
		const h = harness({ cfg: { classifySubagents: false } });
		await decide(h.deps, call({ hasUI: true }));
		expect(h.classifyCalls).toBe(1);
	});
});

describe("bookkeeping", () => {
	test("an allow and a block both advance the counters", async () => {
		const h = harness();
		await decide(h.deps, call({ input: { command: "a" } }));
		expect(h.state.snapshot()).toMatchObject({ checked: 1, allowed: 1 });

		const denier = harness({ verdict: { kind: "deny", reason: "no", risk: "high", stage: 2 } });
		await decide(denier.deps, call());
		expect(denier.state.snapshot()).toMatchObject({ denied: 1 });
	});

	test("a rule-based block counts toward the breaker as well", async () => {
		const h = harness({ cfg: { rules: { hardDeny: [], deny: ["bash"], ask: [], allow: [] } } });
		await decide(h.deps, call());
		expect(h.state.snapshot()).toMatchObject({ denied: 1 });
	});

	test("fast-path allows are not counted as classifier work", async () => {
		const h = harness();
		await decide(h.deps, call({ toolName: "read", input: { path: "a.ts" } }));
		expect(h.state.snapshot()).toMatchObject({ checked: 1, allowed: 1 });
	});

	test("a bypassed call is not counted at all", async () => {
		const h = harness({ cfg: { enabled: false } });
		await decide(h.deps, call());
		expect(h.state.snapshot()).toMatchObject({ checked: 0 });
	});

	test("every decision is logged with how it was reached", async () => {
		const h = harness();
		await decide(h.deps, call({ toolName: "read", input: { path: "a.ts" } }));
		await decide(h.deps, call());
		expect(h.logged).toEqual([
			{ decision: "allow", via: "allow" },
			{ decision: "allow", via: "classifier" },
		]);
	});

	test("logging can be turned off", async () => {
		const h = harness({ cfg: { logDecisions: false } });
		await decide(h.deps, call());
		expect(h.logged).toEqual([]);
	});

	test("turning logging off silences every path, including failures and anti-tamper", async () => {
		const failing = harness({ cfg: { logDecisions: false }, verdict: { kind: "failure", reason: "down" } });
		await decide(failing.deps, call());
		expect(failing.logged).toEqual([]);

		const tamper = harness({ cfg: { logDecisions: false } });
		await decide(tamper.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		expect(tamper.logged).toEqual([]);
	});

	test("a blocked call is logged with its reason", async () => {
		const h = harness({ verdict: { kind: "failure", reason: "model unreachable" } });
		await decide(h.deps, call());
		expect(h.logged).toEqual([{ decision: "block", via: "failure" }]);
	});

	test("a failure is counted exactly once, not twice", async () => {
		const h = harness({ verdict: { kind: "failure", reason: "down" } });
		await decide(h.deps, call());
		expect(h.state.snapshot()).toMatchObject({ checked: 1, denied: 1 });
	});

	test("a repeated denial eventually pauses the gate through the breaker", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "no", risk: "high", stage: 2 } });
		for (const command of ["a", "b", "c"]) await decide(h.deps, call({ input: { command } }));
		expect(h.state.paused).toBe(true);
		const after = await decide(h.deps, call({ input: { command: "d" } }));
		expect(after.action).toBe("allow");
	});
});

describe("classifier input", () => {
	test("the transcript and config reach the classifier unchanged", async () => {
		const h = harness();
		let seen: { toolName: string; cwd: string; includeToolResults: boolean } | undefined;
		h.deps.classify = async request => {
			seen = { toolName: request.toolName, cwd: request.cwd, includeToolResults: request.includeToolResults };
			return { kind: "allow", reason: "ok", stage: 2 };
		};
		await decide(h.deps, call({ toolName: "eval", input: { code: "x" } }));
		expect(seen).toEqual({ toolName: "eval", cwd: "/work", includeToolResults: false });
	});

	test("the configured timeouts are passed through", async () => {
		const h = harness({ cfg: { stage1TimeoutMs: 1234, stage2TimeoutMs: 5678 } });
		let seen: { stage1TimeoutMs: number; stage2TimeoutMs: number } | undefined;
		h.deps.classify = async (_request, timeouts) => {
			seen = timeouts;
			return { kind: "allow", reason: "ok", stage: 2 };
		};
		await decide(h.deps, call());
		expect(seen).toEqual({ stage1TimeoutMs: 1234, stage2TimeoutMs: 5678 });
	});
});
