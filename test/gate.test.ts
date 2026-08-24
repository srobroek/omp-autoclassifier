import { describe, expect, test } from "bun:test";
import type { EvidenceRequest, Refusal } from "../src/evidence";
import { VerdictCache } from "../src/cache";
import type { EffectiveConfig } from "../src/config";
import { DEFAULT_ALLOW, DEFAULT_ENVIRONMENT, DEFAULT_HARD_DENY, EVIDENCE_DEFAULTS, SCALAR_DEFAULTS } from "../src/defaults";
import type { ClassifyResult, Dimensions } from "../src/classifier";
import { decide, type DecisionRecord, type GateDeps, type GateRequest } from "../src/gate";
import { compileRules, pathVars } from "../src/rules";
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
	/** Every evidence request the gate handed the classifier, so a test can assert what it saw. */
	classifyRequests: EvidenceRequest[];
	escalateCalls: number;
	notices: string[];
	childDenials: string[];
	logged: { decision: string; via: string }[];
	records: DecisionRecord[];
	/** Refusals the gate handed to the registry for later sessions to inherit. */
	shared: Refusal[];
}

function harness(options: {
	cfg?: Partial<EffectiveConfig>;
	verdict?: ClassifyResult;
	env?: Record<string, string>;
	escalate?: "once" | "session" | "deny" | Error;
	inherited?: Refusal[];
} = {}): Harness {
	const cfg = config(options.cfg);
	const state = new GateState(cfg);
	const cache = new VerdictCache(cfg.cacheSize);
	const result: Harness = {
		state,
		cache,
		classifyCalls: 0,
		classifyRequests: [],
		escalateCalls: 0,
		notices: [],
		childDenials: [],
		logged: [],
		records: [],
		shared: [],
		deps: {} as GateDeps,
	};
	result.deps = {
		config: () => cfg,
		state,
		cache,
		cwd: "/work",
		branch: () => [],
		env: name => options.env?.[name],
		classify: async request => {
			result.classifyCalls++;
			result.classifyRequests.push(request);
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
			result.records.push(record);
		},
		inheritedRefusals: () => options.inherited ?? [],
		shareRefusal: refusal => {
			result.shared.push(refusal);
		},
	};
	return result;
}

/** Full verdict dimensions, so a test names only the axis it cares about. */
function dims(overrides: Partial<Dimensions> = {}): Dimensions {
	return {
		risk: "high",
		category: "destruction",
		authorization: "absent",
		reversibility: "irreversible",
		scope: "worktree",
		confidence: "high",
		injectionSuspected: false,
		...overrides,
	};
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

	/**
	 * A refusal has to be self-explanatory. The reason is the only thing the model and the user see, so
	 * it must name what was blocked, which concrete target tripped it, which rule fired, where that rule
	 * came from, and what to do next. Naming the pattern alone leaves `<agentDir>` placeholders on screen
	 * and no way to tell a shipped rule from one the user wrote.
	 */
	test("a deny reason names the target, the rule, its origin, and the next step", async () => {
		const h = harness({
			cfg: {
				rules: { hardDeny: [], deny: ["bash(git push*)"], ask: [], allow: [] },
				origins: { "rules.deny": "user autoclassifier.yml" },
			},
		});
		const decision = await decide(h.deps, call({ input: { command: "git push --force" } }));
		expect(decision.action).toBe("block");
		if (decision.action !== "block") return;
		expect(decision.reason).toContain("bash");
		expect(decision.reason).toContain("git push --force");
		expect(decision.reason).toContain("bash(git push*)");
		expect(decision.reason).toContain("user autoclassifier.yml");
	});

	test("an anti-tamper reason names the resolved path, not the placeholder pattern", async () => {
		const h = harness();
		const decision = await decide(
			h.deps,
			call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }),
		);
		expect(decision.action).toBe("block");
		if (decision.action !== "block") return;
		expect(decision.reason).toContain("/agent/autoclassifier.yml");
		expect(decision.reason).toContain("write(<agentDir>/autoclassifier.yml)");
		expect(decision.reason.toLowerCase()).toContain("ask the user");
	});

	test("an anti-tamper reason says the rule is shipped when the user did not write it", async () => {
		const h = harness();
		const decision = await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		if (decision.action !== "block") throw new Error("expected a block");
		expect(decision.reason).toContain("shipped default");
	});

	test("an anti-tamper reason explains why the target is protected", async () => {
		const h = harness();
		const decision = await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		if (decision.action !== "block") throw new Error("expected a block");
		const reason = decision.reason.toLowerCase();
		// States the cause, not just the refusal: these settings govern the gate, so the gated agent
		// cannot edit them.
		expect(reason).toContain("govern");
		expect(reason).toContain("cannot edit");
	});

	test("a reason stays usable when the call carried no reportable argument", async () => {
		const h = harness({ cfg: { rules: { hardDeny: [], deny: ["computer"], ask: [], allow: [] } } });
		const decision = await decide(h.deps, call({ toolName: "computer", input: {} }));
		if (decision.action !== "block") throw new Error("expected a block");
		expect(decision.reason).toContain("computer");
		expect(decision.reason).not.toContain("undefined");
	});

	test("the audit log records the target alongside the rule", async () => {
		const h = harness({ cfg: { rules: { hardDeny: [], deny: ["bash(git push*)"], ask: [], allow: [] } } });
		await decide(h.deps, call({ input: { command: "git push --force" } }));
		expect(h.logged[0]).toMatchObject({ decision: "block", via: "deny" });
		expect(h.records[0]?.target).toBe("git push --force");
		expect(h.records[0]?.rule).toBe("bash(git push*)");
	});
});

/**
 * A block that only reaches the model is invisible: the user watching the session sees the agent change
 * course with no explanation. Every refusal therefore also surfaces to the user.
 */
describe("visibility", () => {
	test("a rule block notifies the user", async () => {
		const h = harness({ cfg: { rules: { hardDeny: [], deny: ["bash(git push*)"], ask: [], allow: [] } } });
		await decide(h.deps, call({ input: { command: "git push --force" } }));
		expect(h.notices.length).toBe(1);
		expect(h.notices[0]).toContain("git push --force");
	});

	test("an anti-tamper block notifies the user", async () => {
		const h = harness();
		await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		expect(h.notices.length).toBe(1);
		expect(h.notices[0]).toContain("anti-tamper");
	});

	test("a classifier block notifies the user with the model's reason", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "Adds an SSH key.", stage: 2, dimensions: dims() } });
		await decide(h.deps, call());
		expect(h.notices.length).toBe(1);
		expect(h.notices[0]).toContain("Adds an SSH key.");
	});

	test("an allowed call does not notify, so the gate stays quiet in normal use", async () => {
		const h = harness();
		await decide(h.deps, call());
		await decide(h.deps, call({ toolName: "read", input: { path: "a.ts" } }));
		expect(h.notices).toEqual([]);
	});

	test("a block in a subagent does not notify twice, since the registry already reports it", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "nope", stage: 2, dimensions: dims() } });
		await decide(h.deps, call({ hasUI: false }));
		expect(h.notices).toEqual([]);
		expect(h.childDenials.length).toBe(1);
	});

	test("an escalated allow does not notify, because the user already answered", async () => {
		const h = harness({
			cfg: { escalate: true },
			verdict: { kind: "deny", reason: "risky", stage: 2, dimensions: dims() },
			escalate: "once",
		});
		await decide(h.deps, call());
		expect(h.notices).toEqual([]);
	});
});

/**
 * A refusal has one job beyond stopping the call: telling both readers what happened. The agent reads it
 * as a tool error and has to understand what it did wrong; the user reads the same text as a notification
 * and has to know their agent was stopped, and why.
 */
describe("deny messages", () => {
	const risky: ClassifyResult = {
		kind: "deny",
		reason: "Appends a key to authorized_keys, which grants future login.",
		stage: 2,
		dimensions: dims({ category: "persistence", authorization: "absent", reversibility: "recoverable", scope: "machine" }),
	};

	test("the agent is told what was refused and on what", async () => {
		const h = harness({ verdict: risky });
		const decision = await decide(h.deps, call({ input: { command: "echo key >> ~/.ssh/authorized_keys" } }));
		if (decision.action !== "block") throw new Error("expected a block");
		expect(decision.reason).toContain("bash");
		expect(decision.reason).toContain("authorized_keys");
	});

	test("the agent is told which category and authorization decided it", async () => {
		const h = harness({ verdict: risky });
		const decision = await decide(h.deps, call());
		if (decision.action !== "block") throw new Error("expected a block");
		expect(decision.reason).toContain("persistence");
		expect(decision.reason).toContain("absent");
		expect(decision.reason).toContain("machine");
		expect(decision.reason).toContain("recoverable");
	});

	test("the agent is given the model's own sentence, not just labels", async () => {
		const h = harness({ verdict: risky });
		const decision = await decide(h.deps, call());
		if (decision.action !== "block") throw new Error("expected a block");
		expect(decision.reason).toContain("grants future login");
	});

	test("the agent is told not to route around it", async () => {
		const h = harness({ verdict: risky });
		const decision = await decide(h.deps, call());
		if (decision.action !== "block") throw new Error("expected a block");
		expect(decision.reason.toLowerCase()).toContain("another route");
	});

	test("the user receives exactly what the agent received", async () => {
		const h = harness({ verdict: risky });
		const decision = await decide(h.deps, call());
		if (decision.action !== "block") throw new Error("expected a block");
		expect(h.notices).toEqual([decision.reason]);
	});

	test("a revoked authorization says the user already ruled it out", async () => {
		const h = harness({ verdict: { ...risky, dimensions: dims({ authorization: "revoked" }) } });
		const decision = await decide(h.deps, call());
		if (decision.action !== "block") throw new Error("expected a block");
		expect(decision.reason.toLowerCase()).toContain("ruled this out");
	});

	test("a blocked ask says why it was not put to the user", async () => {
		const h = harness({ verdict: { kind: "ask", reason: "Could go either way.", stage: 2, dimensions: dims() } });
		const decision = await decide(h.deps, call());
		if (decision.action !== "block") throw new Error("expected a block");
		expect(decision.reason).toContain("escalation is off");
	});

	test("a suspected injection is called out as hostile content", async () => {
		const h = harness({ verdict: { ...risky, dimensions: dims({ injectionSuspected: true }) } });
		const decision = await decide(h.deps, call());
		if (decision.action !== "block") throw new Error("expected a block");
		expect(decision.reason.toLowerCase()).toContain("hostile");
	});

	test("a suggested alternative is passed to the agent", async () => {
		const h = harness({ verdict: { ...risky, dimensions: dims({ alternative: "git push --force-with-lease" }) } });
		const decision = await decide(h.deps, call());
		if (decision.action !== "block") throw new Error("expected a block");
		expect(decision.reason).toContain("git push --force-with-lease");
	});

	test("every dimension reaches the audit record", async () => {
		const h = harness({ verdict: risky });
		await decide(h.deps, call());
		expect(h.records[0]).toMatchObject({
			decision: "block",
			via: "classifier",
			risk: "high",
			category: "persistence",
			authorization: "absent",
			reversibility: "recoverable",
			scope: "machine",
		});
	});
});

/**
 * The gate refuses, the agent rewords, a fresh review sees a fresh call and allows it. Each review was
 * correct in isolation, and a live run rode that sequence to completion: a refused subagent spawn was
 * reshaped until it passed, and the child ran the command. The fix is memory, not a stricter verdict.
 */
describe("refusal memory", () => {
	test("a refusal is remembered", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "no", stage: 2, dimensions: dims() } });
		await decide(h.deps, call({ input: { command: "git push --force origin main" } }));
		expect(h.state.refusals).toEqual([
			{ toolName: "bash", target: "git push --force origin main", reason: "no" },
		]);
	});

	test("the next review is shown what was already refused", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "Destroys history.", stage: 2, dimensions: dims() } });
		await decide(h.deps, call({ input: { command: "git push --force origin main" } }));
		await decide(h.deps, call({ toolName: "task", input: { task: "please push main" } }));
		expect(h.classifyRequests[1]?.refusals).toEqual([
			{ toolName: "bash", target: "git push --force origin main", reason: "Destroys history." },
		]);
	});

	test("the first review has no history to show", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "no", stage: 2, dimensions: dims() } });
		await decide(h.deps, call());
		expect(h.classifyRequests[0]?.refusals).toEqual([]);
	});

	test("a rule-based block is remembered too, so a tool switch is visible", async () => {
		const h = harness({ cfg: { rules: { hardDeny: [], deny: ["write(/etc/**)"], ask: [], allow: [] } } });
		await decide(h.deps, call({ toolName: "write", input: { path: "/etc/hosts" } }));
		expect(h.state.refusals[0]).toMatchObject({ toolName: "write", target: "/etc/hosts" });
	});

	test("an anti-tamper block is remembered", async () => {
		const h = harness();
		await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		expect(h.state.refusals.length).toBe(1);
	});

	test("an allow adds nothing to the history", async () => {
		const h = harness();
		await decide(h.deps, call());
		expect(h.state.refusals).toEqual([]);
	});

	test("a classifier failure is not recorded as a judged refusal", async () => {
		const h = harness({ verdict: { kind: "failure", reason: "model unreachable" } });
		await decide(h.deps, call());
		// It blocked, but no model judged the call, so there is no verdict to hold the agent to.
		expect(h.state.refusals).toEqual([]);
	});
});

/** A subagent's own gate starts blank, so what its parent was refused has to be handed to it. */
describe("inherited refusals", () => {
	test("a parent's refusal reaches this session's review", async () => {
		const h = harness({ inherited: [{ toolName: "task", target: "push main", reason: "Destroys history." }] });
		await decide(h.deps, call());
		expect(h.classifyRequests[0]?.refusals).toEqual([
			{ toolName: "task", target: "push main", reason: "Destroys history." },
		]);
	});

	test("inherited refusals come before this session's own", async () => {
		const h = harness({
			verdict: { kind: "deny", reason: "mine", stage: 2, dimensions: dims() },
			inherited: [{ toolName: "task", target: "theirs", reason: "parent" }],
		});
		await decide(h.deps, call({ input: { command: "a" } }));
		await decide(h.deps, call({ input: { command: "b" } }));
		expect(h.classifyRequests[1]?.refusals?.map(refusal => refusal.target)).toEqual(["theirs", "a"]);
	});

	test("a refusal is shared so a subagent spawned later inherits it", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "no", stage: 2, dimensions: dims() } });
		await decide(h.deps, call({ input: { command: "git push --force" } }));
		expect(h.shared).toEqual([{ toolName: "bash", target: "git push --force", reason: "no" }]);
	});

	test("an allow is not shared", async () => {
		const h = harness();
		await decide(h.deps, call());
		expect(h.shared).toEqual([]);
	});
});

/**
 * A log that records only tool names cannot answer the question it exists to answer. A live run left six
 * allowed `bash` calls in the log with no indication of what any of them ran, because the target was
 * only ever filled in by a rule match.
 */
describe("audit target", () => {
	test("a classifier allow names what it allowed", async () => {
		const h = harness();
		await decide(h.deps, call({ input: { command: "bun test" } }));
		expect(h.records[0]?.target).toBe("bun test");
	});
	/**
	 * A rule reports the path it actually matched, which is the resolved one. The raw argument may be
	 * relative or contain traversal, and logging that instead would leave the reader to guess what the
	 * gate really compared.
	 */
	test("a rule match records the resolved path, not the raw argument", async () => {
		const h = harness();
		await decide(h.deps, call({ toolName: "write", input: { path: "../agent/sub/../autoclassifier.yml" } }));
		expect(h.records[0]?.target).toBe("/agent/autoclassifier.yml");
	});

	test("a rule match keeps the path the rule matched, not the raw argument", async () => {
		const h = harness();
		await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		expect(h.records[0]?.target).toContain("autoclassifier.yml");
	});

	test("a call with no meaningful argument records no target rather than a placeholder", async () => {
		const h = harness();
		await decide(h.deps, call({ toolName: "hub", input: {} }));
		expect(h.records[0]?.target).toBeUndefined();
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
		const h = harness({ verdict: { kind: "deny", reason: "risky", stage: 2, dimensions: dims() } });
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

	/**
	 * Announced per blocked call rather than once per session. A degraded gate refuses everything, and a
	 * single early warning leaves every later refusal unexplained on screen, which is indistinguishable
	 * from the agent silently giving up. The breaker caps how many can accumulate.
	 */
	test("a degraded gate announces every call it blocks", async () => {
		const h = harness({ verdict: { kind: "failure", reason: "model unreachable" } });
		await decide(h.deps, call({ input: { command: "a" } }));
		await decide(h.deps, call({ input: { command: "b" } }));
		expect(h.notices.length).toBe(2);
		expect(h.notices[1]).toContain("model unreachable");
	});

	test("a degraded block in a subagent stays quiet locally and reports upward instead", async () => {
		const h = harness({ verdict: { kind: "failure", reason: "model unreachable" } });
		await decide(h.deps, call({ hasUI: false }));
		expect(h.notices).toEqual([]);
		expect(h.childDenials.length).toBe(1);
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
		const h = harness({ cfg: { escalate: true }, verdict: { kind: "deny", reason: "risky", stage: 2, dimensions: dims() }, escalate: "once" });
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
	/**
	 * A subagent has no dialog of its own, so with no parent reachable a would-be prompt stays a block.
	 * Silence never reads as consent.
	 */
	test("an ask outcome blocks when no parent can be reached", async () => {
		const h = harness({ cfg: { escalate: true, rules: { hardDeny: [], deny: [], ask: ["bash"], allow: [] } }, escalate: "once" });
		const decision = await decide(h.deps, call({ hasUI: false }));
		expect(decision.action).toBe("block");
		expect(h.escalateCalls).toBe(0);
	});

	test("a classifier denial blocks in a subagent when no parent can be reached", async () => {
		const h = harness({ cfg: { escalate: true }, verdict: { kind: "deny", reason: "risky", stage: 2, dimensions: dims() }, escalate: "once" });
		expect((await decide(h.deps, call({ hasUI: false }))).action).toBe("block");
	});

	/**
	 * The interesting case: the decision rolls up to the session that started the work, because that is
	 * where the person is. The subagent's own transcript is rarely read.
	 */
	test("a subagent escalation is answered by the parent session", async () => {
		const asked: string[] = [];
		const h = harness({ cfg: { escalate: true }, verdict: { kind: "deny", reason: "risky", stage: 2, dimensions: dims() } });
		h.deps.escalateViaParent = async (toolName, reason) => {
			asked.push(`${toolName}|${reason}`);
			return "once";
		};
		const decision = await decide(h.deps, call({ hasUI: false }));
		expect(decision).toMatchObject({ action: "allow", via: "escalated" });
		expect(asked[0]).toContain("bash");
		expect(asked[0]).toContain("risky");
	});

	test("the parent refusing keeps the subagent's call blocked", async () => {
		const h = harness({ cfg: { escalate: true }, verdict: { kind: "deny", reason: "risky", stage: 2, dimensions: dims() } });
		h.deps.escalateViaParent = async () => "deny";
		expect((await decide(h.deps, call({ hasUI: false }))).action).toBe("block");
	});

	test("the parent allowing for the session is remembered for the subagent too", async () => {
		const h = harness({ cfg: { escalate: true }, verdict: { kind: "deny", reason: "risky", stage: 2, dimensions: dims() } });
		h.deps.escalateViaParent = async () => "session";
		await decide(h.deps, call({ hasUI: false }));
		expect(h.cache.isAllowed("bash", { command: "git status" })).toBe(true);
	});

	test("an interactive session asks itself, never a peer", async () => {
		let viaParent = 0;
		const h = harness({ cfg: { escalate: true }, verdict: { kind: "deny", reason: "risky", stage: 2, dimensions: dims() }, escalate: "once" });
		h.deps.escalateViaParent = async () => {
			viaParent++;
			return "deny";
		};
		await decide(h.deps, call({ hasUI: true }));
		expect(h.escalateCalls).toBe(1);
		expect(viaParent).toBe(0);
	});

	test("a parent cannot lift anti-tamper for a subagent", async () => {
		const h = harness({ cfg: { escalate: true } });
		h.deps.escalateViaParent = async () => "once";
		const decision = await decide(
			h.deps,
			call({ hasUI: false, toolName: "write", input: { path: "/agent/autoclassifier.yml" } }),
		);
		expect(decision.action).toBe("block");
	});

	test("the fast-path allow list still applies in a subagent", async () => {
		const h = harness();
		const decision = await decide(h.deps, call({ hasUI: false, toolName: "read", input: { path: "a.ts" } }));
		expect(decision.action).toBe("allow");
	});

	test("a denial inside a subagent is reported upward", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "Adds an SSH key.", stage: 2, dimensions: dims() } });
		await decide(h.deps, call({ hasUI: false }));
		expect(h.childDenials).toEqual(["Adds an SSH key."]);
	});

	test("a denial in an interactive session is not reported as a child denial", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "nope", stage: 2, dimensions: dims() } });
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

		const denier = harness({ verdict: { kind: "deny", reason: "no", stage: 2, dimensions: dims() } });
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

	/**
	 * Attribution has to be decided where the decision is, not at the counter. If the gate credited every
	 * decision to the model, a pure pattern matcher would report full classifier coverage.
	 */
	test("a rule decision is not credited to the model", async () => {
		const h = harness();
		await decide(h.deps, call({ toolName: "read", input: { path: "a.ts" } }));
		expect(h.state.snapshot()).toMatchObject({ checked: 1, classified: 0 });
	});

	test("a classifier decision is credited to the model", async () => {
		const h = harness();
		await decide(h.deps, call());
		expect(h.state.snapshot()).toMatchObject({ checked: 1, classified: 1 });
	});

	test("a rule block is not credited to the model", async () => {
		const h = harness({ cfg: { rules: { hardDeny: [], deny: ["bash"], ask: [], allow: [] } } });
		await decide(h.deps, call());
		expect(h.state.snapshot()).toMatchObject({ denied: 1, classified: 0 });
	});

	test("an anti-tamper block is not credited to the model", async () => {
		const h = harness();
		await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		expect(h.state.snapshot()).toMatchObject({ denied: 1, classified: 0 });
	});

	test("a cached allow is not credited to the model a second time", async () => {
		const h = harness();
		await decide(h.deps, call());
		await decide(h.deps, call());
		expect(h.state.snapshot()).toMatchObject({ checked: 2, classified: 1 });
	});

	/** The model produced the verdict the user then overrode, so the model did the work. */
	test("an escalated allow is credited to the model", async () => {
		const h = harness({
			cfg: { escalate: true },
			verdict: { kind: "deny", reason: "risky", stage: 2, dimensions: dims() },
			escalate: "once",
		});
		await decide(h.deps, call());
		expect(h.state.snapshot()).toMatchObject({ classified: 1 });
	});

	test("an anti-tamper block records the target it fired on", async () => {
		const h = harness();
		await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		expect(h.records[0]).toMatchObject({
			via: "hardDeny",
			rule: "write(<agentDir>/autoclassifier.yml)",
			target: "/agent/autoclassifier.yml",
		});
	});

	test("an anti-tamper block is labelled as anti-tamper, not as an ordinary deny", async () => {
		const h = harness();
		const decision = await decide(h.deps, call({ toolName: "write", input: { path: "/agent/autoclassifier.yml" } }));
		if (decision.action !== "block") throw new Error("expected a block");
		expect(decision.reason).toContain("anti-tamper rule");
	});

	test("a repeated denial eventually pauses the gate through the breaker", async () => {
		const h = harness({ verdict: { kind: "deny", reason: "no", stage: 2, dimensions: dims() } });
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
		expect(seen).toMatchObject({ stage1TimeoutMs: 1234, stage2TimeoutMs: 5678 });
	});
});
