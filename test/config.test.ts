import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigStore, type ConfigPaths } from "../src/config";
import { DEFAULT_ALLOW, DEFAULT_HARD_DENY, SCALAR_DEFAULTS } from "../src/defaults";

let root: string;
let paths: ConfigPaths;
let clock: number;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ac-config-")));
	fs.mkdirSync(path.join(root, "agent"), { recursive: true });
	fs.mkdirSync(path.join(root, "project", ".omp"), { recursive: true });
	fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
	paths = {
		agentDir: path.join(root, "agent"),
		cwd: path.join(root, "project"),
		pluginsRoot: path.join(root, "plugins"),
		lockfile: path.join(root, "plugins", "omp-plugins.lock.json"),
		projectOverrides: path.join(root, "project", ".omp", "plugin-overrides.json"),
		userYaml: path.join(root, "agent", "autoclassifier.yml"),
		projectYaml: path.join(root, "project", ".omp", "autoclassifier.yml"),
	};
	clock = 1_000_000;
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function store(): ConfigStore {
	return new ConfigStore(paths, () => clock);
}

function writeLockfile(settings: Record<string, unknown>): void {
	fs.writeFileSync(paths.lockfile, JSON.stringify({ plugins: {}, settings: { "omp-autoclassifier": settings } }));
}

function writeOverrides(settings: Record<string, unknown>): void {
	fs.writeFileSync(paths.projectOverrides, JSON.stringify({ settings: { "omp-autoclassifier": settings } }));
}

describe("defaults", () => {
	test("everything falls back to the shipped defaults when no source exists", () => {
		const cfg = store().get();
		expect(cfg.enabled).toBe(SCALAR_DEFAULTS.enabled);
		expect(cfg.maxConsecutiveDenials).toBe(SCALAR_DEFAULTS.maxConsecutiveDenials);
		expect(cfg.rules.allow).toEqual([...DEFAULT_ALLOW]);
		expect(cfg.rules.hardDeny).toEqual([...DEFAULT_HARD_DENY]);
		expect(cfg.origins.enabled).toBe("default");
		expect(cfg.warnings).toEqual([]);
	});

	test("the log path defaults inside the agent directory", () => {
		expect(store().get().logPath).toBe(path.join(paths.agentDir, "autoclassifier", "decisions.jsonl"));
	});
});

describe("precedence", () => {
	test("the plugin lockfile beats the shipped default", () => {
		writeLockfile({ maxConsecutiveDenials: 7 });
		const cfg = store().get();
		expect(cfg.maxConsecutiveDenials).toBe(7);
		expect(cfg.origins.maxConsecutiveDenials).toBe("plugin lockfile");
	});

	test("project plugin overrides beat the lockfile", () => {
		writeLockfile({ maxConsecutiveDenials: 7 });
		writeOverrides({ maxConsecutiveDenials: 9 });
		const cfg = store().get();
		expect(cfg.maxConsecutiveDenials).toBe(9);
		expect(cfg.origins.maxConsecutiveDenials).toBe("project plugin-overrides.json");
	});

	test("the user yaml beats project plugin overrides", () => {
		writeOverrides({ escalate: false });
		fs.writeFileSync(paths.userYaml, "escalate: true\n");
		const cfg = store().get();
		expect(cfg.escalate).toBe(true);
		expect(cfg.origins.escalate).toBe("user autoclassifier.yml");
	});

	test("the project yaml beats the user yaml", () => {
		fs.writeFileSync(paths.userYaml, "stage2TimeoutMs: 5000\n");
		fs.writeFileSync(paths.projectYaml, "stage2TimeoutMs: 6000\n");
		const cfg = store().get();
		expect(cfg.stage2TimeoutMs).toBe(6000);
		expect(cfg.origins.stage2TimeoutMs).toBe("project autoclassifier.yml");
	});

	test("a lower-precedence source still supplies keys the higher one omits", () => {
		writeLockfile({ maxConsecutiveDenials: 7, cacheSize: 11 });
		fs.writeFileSync(paths.userYaml, "cacheSize: 22\n");
		const cfg = store().get();
		expect(cfg.maxConsecutiveDenials).toBe(7);
		expect(cfg.cacheSize).toBe(22);
	});
});

describe("validation", () => {
	test("a wrong-typed scalar is ignored and reported", () => {
		writeLockfile({ maxConsecutiveDenials: "lots", enabled: "yes" });
		const cfg = store().get();
		expect(cfg.maxConsecutiveDenials).toBe(SCALAR_DEFAULTS.maxConsecutiveDenials);
		expect(cfg.enabled).toBe(SCALAR_DEFAULTS.enabled);
		expect(cfg.origins.maxConsecutiveDenials).toBe("default");
		expect(cfg.warnings.join(" ")).toContain("maxConsecutiveDenials");
		expect(cfg.warnings.join(" ")).toContain("enabled");
	});

	test("an out-of-range number is ignored and reported", () => {
		writeLockfile({ stage1TimeoutMs: 10, maxTotalDenials: -4 });
		const cfg = store().get();
		expect(cfg.stage1TimeoutMs).toBe(SCALAR_DEFAULTS.stage1TimeoutMs);
		expect(cfg.maxTotalDenials).toBe(SCALAR_DEFAULTS.maxTotalDenials);
		expect(cfg.warnings.join(" ")).toContain("stage1TimeoutMs");
	});

	test("an unknown key is reported so a typo is not silently ignored", () => {
		fs.writeFileSync(paths.userYaml, "escalte: true\n");
		expect(store().get().warnings.join(" ")).toContain("escalte");
	});

	test("malformed yaml is reported and leaves lower precedence intact", () => {
		writeLockfile({ cacheSize: 42 });
		fs.writeFileSync(paths.userYaml, "escalate: [unclosed\n");
		const cfg = store().get();
		expect(cfg.cacheSize).toBe(42);
		expect(cfg.warnings.join(" ")).toContain("autoclassifier.yml");
	});

	test("a malformed lockfile is ignored without throwing", () => {
		fs.writeFileSync(paths.lockfile, "{not json");
		const cfg = store().get();
		expect(cfg.enabled).toBe(SCALAR_DEFAULTS.enabled);
		expect(cfg.warnings.length).toBeGreaterThan(0);
	});

	test("a lockfile without a section for this plugin is not an error", () => {
		fs.writeFileSync(paths.lockfile, JSON.stringify({ plugins: {}, settings: { other: { x: 1 } } }));
		expect(store().get().warnings).toEqual([]);
	});

	test("a yaml file that is not a mapping is reported", () => {
		fs.writeFileSync(paths.userYaml, "- one\n- two\n");
		expect(store().get().warnings.join(" ")).toContain("autoclassifier.yml");
	});
});

describe("rule lists", () => {
	test("the defaults sentinel expands inside a configured list", () => {
		fs.writeFileSync(paths.userYaml, 'rules:\n  allow: ["bash(echo *)", "$defaults"]\n');
		const cfg = store().get();
		expect(cfg.rules.allow[0]).toBe("bash(echo *)");
		expect(cfg.rules.allow).toEqual(["bash(echo *)", ...DEFAULT_ALLOW]);
	});

	test("omitting the sentinel replaces the shipped list", () => {
		fs.writeFileSync(paths.userYaml, 'rules:\n  allow: ["read"]\n');
		expect(store().get().rules.allow).toEqual(["read"]);
	});

	test("an untouched list keeps its shipped defaults", () => {
		fs.writeFileSync(paths.userYaml, 'rules:\n  deny: ["bash(rm -rf *)"]\n');
		const cfg = store().get();
		expect(cfg.rules.deny).toEqual(["bash(rm -rf *)"]);
		expect(cfg.rules.hardDeny).toEqual([...DEFAULT_HARD_DENY]);
	});

	test("the project yaml replaces rather than merges the user yaml lists", () => {
		fs.writeFileSync(paths.userYaml, 'rules:\n  deny: ["bash(a)"]\n');
		fs.writeFileSync(paths.projectYaml, 'rules:\n  deny: ["bash(b)"]\n');
		expect(store().get().rules.deny).toEqual(["bash(b)"]);
	});

	test("non-string rule entries are dropped and reported", () => {
		fs.writeFileSync(paths.userYaml, "rules:\n  deny: [42, \"bash(a)\"]\n");
		const cfg = store().get();
		expect(cfg.rules.deny).toEqual(["bash(a)"]);
		expect(cfg.warnings.join(" ")).toContain("deny");
	});

	test("rules compile so the gate never recompiles per call", () => {
		fs.writeFileSync(paths.userYaml, 'rules:\n  deny: ["bash(secret)"]\n');
		const cfg = store().get();
		expect(cfg.compiled.deny.length).toBe(1);
		expect(cfg.compiled.vars.agentDir).toBe(paths.agentDir);
	});
});

describe("reload behavior", () => {
	test("an edit within the poll window is not observed", () => {
		fs.writeFileSync(paths.userYaml, "cacheSize: 10\n");
		const s = store();
		expect(s.get().cacheSize).toBe(10);
		fs.writeFileSync(paths.userYaml, "cacheSize: 20\n");
		expect(s.get().cacheSize).toBe(10);
	});

	test("an edit is observed once the poll window elapses", () => {
		fs.writeFileSync(paths.userYaml, "cacheSize: 10\n");
		const s = store();
		expect(s.get().cacheSize).toBe(10);
		fs.writeFileSync(paths.userYaml, "cacheSize: 20\n");
		clock += 2500;
		expect(s.get().cacheSize).toBe(20);
	});

	test("an unchanged file is not reparsed after the window elapses", () => {
		fs.writeFileSync(paths.userYaml, "cacheSize: 10\n");
		const s = store();
		const first = s.get();
		clock += 5000;
		expect(s.get()).toBe(first);
	});

	test("reload observes an edit immediately", () => {
		fs.writeFileSync(paths.userYaml, "cacheSize: 10\n");
		const s = store();
		expect(s.get().cacheSize).toBe(10);
		fs.writeFileSync(paths.userYaml, "cacheSize: 20\n");
		s.reload();
		expect(s.get().cacheSize).toBe(20);
	});

	test("creating a config file that did not exist is observed", () => {
		const s = store();
		expect(s.get().cacheSize).toBe(SCALAR_DEFAULTS.cacheSize);
		fs.writeFileSync(paths.userYaml, "cacheSize: 33\n");
		clock += 2500;
		expect(s.get().cacheSize).toBe(33);
	});

	test("deleting a config file is observed", () => {
		fs.writeFileSync(paths.userYaml, "cacheSize: 33\n");
		const s = store();
		expect(s.get().cacheSize).toBe(33);
		fs.rmSync(paths.userYaml);
		clock += 2500;
		expect(s.get().cacheSize).toBe(SCALAR_DEFAULTS.cacheSize);
	});

	test("a lockfile edit is observed too, since the settings ui writes there", () => {
		writeLockfile({ cacheSize: 10 });
		const s = store();
		expect(s.get().cacheSize).toBe(10);
		writeLockfile({ cacheSize: 20 });
		clock += 2500;
		expect(s.get().cacheSize).toBe(20);
	});
});

describe("evidence and environment", () => {
	test("evidence limits default and can be overridden", () => {
		expect(store().get().evidence.maxUserMessages).toBe(6);
		fs.writeFileSync(paths.userYaml, "evidence:\n  maxUserMessages: 2\n  maxCharsPerMessage: 50\n");
		const cfg = store().get();
		expect(cfg.evidence.maxUserMessages).toBe(2);
		expect(cfg.evidence.maxCharsPerMessage).toBe(50);
	});

	test("the environment prose supports the defaults sentinel", () => {
		fs.writeFileSync(paths.userYaml, 'environment: ["Deploys are forbidden.", "$defaults"]\n');
		const cfg = store().get();
		expect(cfg.environment[0]).toBe("Deploys are forbidden.");
		expect(cfg.environment.length).toBeGreaterThan(1);
	});

	test("an explicit log path is honored", () => {
		fs.writeFileSync(paths.userYaml, `log:\n  path: ${JSON.stringify(path.join(root, "audit.jsonl"))}\n`);
		expect(store().get().logPath).toBe(path.join(root, "audit.jsonl"));
	});
});
