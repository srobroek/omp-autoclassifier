import { describe, expect, test } from "bun:test";
import { runCommand, type CommandDeps } from "../src/command";
import { compileRules } from "../src/rules";
import { DEFAULT_ALLOW, DEFAULT_ENVIRONMENT, DEFAULT_HARD_DENY, EVIDENCE_DEFAULTS, SCALAR_DEFAULTS } from "../src/defaults";
import type { EffectiveConfig } from "../src/config";
import { pathVars } from "../src/rules";
import { GateState } from "../src/state";
import type { DecisionRecord } from "../src/gate";

const vars = pathVars("/agent", "/work", "/plugins");

function config(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
	const rules = {
		hardDeny: [...DEFAULT_HARD_DENY],
		deny: ["bash(git push*)"],
		ask: [] as string[],
		allow: [...DEFAULT_ALLOW],
		...overrides.rules,
	};
	return {
		...SCALAR_DEFAULTS,
		environment: [...DEFAULT_ENVIRONMENT],
		evidence: EVIDENCE_DEFAULTS,
		logPath: "/agent/autoclassifier/decisions.jsonl",
		origins: { enabled: "default", cacheSize: "plugin lockfile", "rules.deny": "user autoclassifier.yml" },
		warnings: [],
		...overrides,
		rules,
		compiled: compileRules(rules, vars),
	};
}

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
	return {
		timestamp: "2026-08-24T10:00:00.000Z",
		toolName: "bash",
		decision: "block",
		via: "classifier",
		hasUI: true,
		reason: "Adds an SSH key.",
		...overrides,
	};
}

interface Harness {
	deps: CommandDeps;
	state: GateState;
	output: string[];
	reloads: number;
	setups: number;
}

function harness(options: { cfg?: Partial<EffectiveConfig>; entries?: DecisionRecord[]; role?: string } = {}): Harness {
	const cfg = config(options.cfg);
	const state = new GateState(cfg);
	const result: Harness = { state, output: [], reloads: 0, setups: 0, deps: {} as CommandDeps };
	result.deps = {
		config: () => cfg,
		state,
		classifierRole: () => options.role,
		// Honors the filter, like the real log does — otherwise the denials view's filtering is untestable.
		tail: (count, filter) => (options.entries ?? []).filter(entry => filter?.(entry) ?? true).slice(-count),
		logPath: cfg.logPath,
		logDisabledReason: undefined,
		reload: () => {
			result.reloads++;
		},
		runSetup: async () => {
			result.setups++;
		},
		print: text => {
			result.output.push(text);
		},
		sessionOverride: {
			get: () => undefined,
			set: () => {},
		},
	};
	return result;
}

const say = (h: Harness): string => h.output.join("\n");

describe("status", () => {
	test("no argument reports status", async () => {
		const h = harness({ role: "prov/cheap-1" });
		await runCommand(h.deps, "");
		expect(say(h).toLowerCase()).toContain("armed");
	});

	test("status names the classifier model in use", async () => {
		const h = harness({ role: "prov/cheap-1" });
		await runCommand(h.deps, "status");
		expect(say(h)).toContain("prov/cheap-1");
	});

	test("status says the gate is inactive when no role is configured", async () => {
		const h = harness();
		await runCommand(h.deps, "status");
		const text = say(h).toLowerCase();
		expect(text).toContain("inactive");
		expect(text).toContain("setup");
	});

	test("status reports a paused breaker and how to clear it", async () => {
		const h = harness({ role: "prov/cheap-1" });
		h.state.pause();
		await runCommand(h.deps, "status");
		expect(say(h).toLowerCase()).toContain("paused");
		expect(say(h)).toContain("/autoclassifier resume");
	});

	test("status reports a degraded classifier", async () => {
		const h = harness({ role: "prov/cheap-1" });
		h.state.recordFailure("model unreachable");
		await runCommand(h.deps, "status");
		const text = say(h);
		expect(text.toLowerCase()).toContain("degraded");
		expect(text).toContain("model unreachable");
	});

	test("status shows the counters", async () => {
		const h = harness({ role: "prov/cheap-1" });
		h.state.recordAllow();
		h.state.recordAllow();
		h.state.recordDeny();
		await runCommand(h.deps, "status");
		expect(say(h)).toMatch(/2\b/);
	});

	/**
	 * A user has to be able to tell whether a model is doing the deciding. Without this line, a heavy
	 * allowlist could reduce the tool to a pattern matcher and the status line would look identical.
	 */
	test("status reports how many decisions a model actually made", async () => {
		const h = harness({ role: "prov/cheap-1" });
		h.state.recordAllow();
		h.state.recordAllow({ classified: true });
		h.state.recordDeny({ classified: true });
		await runCommand(h.deps, "status");
		const text = say(h);
		expect(text).toContain("classified");
		expect(text).toMatch(/2 of 3/);
	});

	test("status reports the fast-path share when nothing reached a model", async () => {
		const h = harness({ role: "prov/cheap-1" });
		h.state.recordAllow();
		h.state.recordAllow();
		await runCommand(h.deps, "status");
		expect(say(h)).toMatch(/0 of 2/);
	});

	test("status does not divide by zero before anything happens", async () => {
		const h = harness({ role: "prov/cheap-1" });
		await runCommand(h.deps, "status");
		expect(say(h)).not.toContain("NaN");
	});

	test("status reflects a session switch, and says it is not persistent", async () => {
		const h = harness({ role: "prov/cheap-1" });
		let override: boolean | undefined;
		h.deps.sessionOverride = { get: () => override, set: value => (override = value) };
		await runCommand(h.deps, "off");
		h.output.length = 0;
		await runCommand(h.deps, "status");
		const text = say(h);
		expect(text).toContain("off");
		expect(text).toContain("for this session");
		expect(text).not.toContain("armed");
		expect(text).toContain("omp plugin config");
	});
});

describe("session toggles", () => {
	test("off disables the gate for this session only", async () => {
		const h = harness({ role: "prov/cheap-1" });
		let override: boolean | undefined;
		h.deps.sessionOverride = { get: () => override, set: value => (override = value) };
		await runCommand(h.deps, "off");
		expect(override).toBe(false);
		expect(say(h).toLowerCase()).toContain("off");
	});

	test("on re-enables the gate for this session", async () => {
		const h = harness({ role: "prov/cheap-1" });
		let override: boolean | undefined = false;
		h.deps.sessionOverride = { get: () => override, set: value => (override = value) };
		await runCommand(h.deps, "on");
		expect(override).toBe(true);
	});

	test("pause and resume drive the breaker", async () => {
		const h = harness({ role: "prov/cheap-1" });
		await runCommand(h.deps, "pause");
		expect(h.state.paused).toBe(true);
		await runCommand(h.deps, "resume");
		expect(h.state.paused).toBe(false);
	});

	test("resume clears the denial counters so the breaker does not trip again at once", async () => {
		const h = harness({ role: "prov/cheap-1" });
		for (let i = 0; i < 3; i++) h.state.recordDeny();
		await runCommand(h.deps, "resume");
		expect(h.state.snapshot()).toMatchObject({ denied: 0, consecutiveDenials: 0 });
	});
});

describe("config view", () => {
	test("every value is shown with where it came from", async () => {
		const h = harness({ role: "prov/cheap-1" });
		await runCommand(h.deps, "config");
		const text = say(h);
		expect(text).toContain("cacheSize");
		expect(text).toContain("plugin lockfile");
		expect(text).toContain("user autoclassifier.yml");
	});

	test("config warnings are surfaced rather than hidden in a log", async () => {
		const h = harness({ role: "prov/cheap-1", cfg: { warnings: ["user autoclassifier.yml sets unknown key \"escalte\""] } });
		await runCommand(h.deps, "config");
		expect(say(h)).toContain("escalte");
	});

	test("the log destination is shown so the audit trail is findable", async () => {
		const h = harness({ role: "prov/cheap-1" });
		await runCommand(h.deps, "config");
		expect(say(h)).toContain("/agent/autoclassifier/decisions.jsonl");
	});
});

describe("rules view", () => {
	test("the effective lists are printed in precedence order", async () => {
		const h = harness({ role: "prov/cheap-1" });
		await runCommand(h.deps, "rules");
		const text = say(h);
		expect(text.indexOf("hardDeny")).toBeLessThan(text.indexOf("deny"));
		expect(text.indexOf("ask")).toBeLessThan(text.indexOf("allow"));
		expect(text).toContain("bash(git push*)");
	});
});

describe("history views", () => {
	test("denials lists only blocked calls, with reasons", async () => {
		const h = harness({
			role: "prov/cheap-1",
			entries: [
				record({ decision: "allow", via: "allow", reason: "ROUTINE-READ" }),
				record({ decision: "block", reason: "Adds an SSH key." }),
			],
		});
		await runCommand(h.deps, "denials");
		const text = say(h);
		expect(text).toContain("Adds an SSH key.");
		expect(text).not.toContain("ROUTINE-READ");
	});

	test("an empty history says there is nothing rather than printing a bare heading", async () => {
		const h = harness({ role: "prov/cheap-1", entries: [] });
		await runCommand(h.deps, "denials");
		expect(say(h)).toContain("blocked nothing");
	});

	test("an empty decision log points at where it would be written", async () => {
		const h = harness({ role: "prov/cheap-1", entries: [] });
		await runCommand(h.deps, "log");
		expect(say(h)).toContain("/agent/autoclassifier/decisions.jsonl");
	});

	test("log lists recent decisions of both kinds", async () => {
		const h = harness({
			role: "prov/cheap-1",
			entries: [record({ decision: "allow", via: "allow" }), record({ decision: "block", via: "deny" })],
		});
		await runCommand(h.deps, "log");
		const text = say(h);
		expect(text).toContain("allow");
		expect(text).toContain("deny");
	});
});

describe("dispatch", () => {
	test("reload re-reads the configuration", async () => {
		const h = harness({ role: "prov/cheap-1" });
		await runCommand(h.deps, "reload");
		expect(h.reloads).toBe(1);
	});

	test("setup runs the wizard", async () => {
		const h = harness();
		await runCommand(h.deps, "setup");
		expect(h.setups).toBe(1);
	});

	test("an unknown subcommand lists the real ones instead of failing silently", async () => {
		const h = harness({ role: "prov/cheap-1" });
		await runCommand(h.deps, "frobnicate");
		const text = say(h);
		expect(text).toContain("frobnicate");
		expect(text).toContain("status");
		expect(text).toContain("resume");
	});

	test("a mixed-case subcommand still runs", async () => {
		const h = harness({ role: "prov/cheap-1" });
		h.state.pause();
		await runCommand(h.deps, "RESUME");
		expect(h.state.paused).toBe(false);
	});

	test("surrounding whitespace does not turn a subcommand into a status request", async () => {
		const h = harness({ role: "prov/cheap-1" });
		h.state.pause();
		await runCommand(h.deps, "  resume  ");
		expect(h.state.paused).toBe(false);
	});

	test("every advertised subcommand is actually handled", async () => {
		for (const name of ["status", "on", "off", "pause", "resume", "setup", "reload", "config", "rules", "denials", "log"]) {
			const h = harness({ role: "prov/cheap-1" });
			await runCommand(h.deps, name);
			expect(say(h).toLowerCase()).not.toContain("unknown subcommand");
		}
	});
});
