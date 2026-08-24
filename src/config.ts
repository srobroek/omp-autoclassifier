/**
 * Configuration resolution.
 *
 * Two stores, one effective view. Scalars live in the plugin manifest so they appear in omp's Settings
 * TUI and `omp plugin config`, but `PluginSettingSchema` is scalar-only, so rule lists and classifier
 * prose live in `autoclassifier.yml`. Precedence, lowest first:
 *
 *   1. shipped defaults
 *   2. `<pluginsRoot>/omp-plugins.lock.json` → `.settings["omp-autoclassifier"]`
 *   3. `<cwd>/.omp/plugin-overrides.json`   → `.settings["omp-autoclassifier"]`
 *   4. `<agentDir>/autoclassifier.yml`
 *   5. `<cwd>/.omp/autoclassifier.yml`
 *
 * The lockfile is read directly because omp's `getPluginSettings` is not exported from the package
 * index. Every read degrades to "no contribution plus a warning" rather than throwing: a broken config
 * file must not be able to take the gate offline, because a gate that cannot load is a gate that
 * cannot refuse.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_ALLOW,
	DEFAULT_ASK,
	DEFAULT_DENY,
	DEFAULT_ENVIRONMENT,
	DEFAULT_HARD_DENY,
	EVIDENCE_DEFAULTS,
	type EvidenceLimits,
	PLUGIN_NAME,
	type RuleLists,
	SCALAR_DEFAULTS,
	type Scalars,
} from "./defaults";
import { type CompiledRules, compileRules, expandDefaults } from "./rules";

/** Fully resolved configuration handed to the gate on every tool call. */
export interface EffectiveConfig extends Scalars {
	rules: RuleLists;
	/** Rules compiled once per resolution, so the hot path never recompiles a pattern. */
	compiled: CompiledRules;
	environment: string[];
	evidence: EvidenceLimits;
	logPath: string;
	/** Winning source for each key, with `/autoclassifier config` as the reader. */
	origins: Record<string, string>;
	/** Non-fatal problems found while resolving, surfaced by `/autoclassifier config`. */
	warnings: string[];
}

export interface ConfigPaths {
	agentDir: string;
	cwd: string;
	pluginsRoot: string;
	lockfile: string;
	projectOverrides: string;
	userYaml: string;
	projectYaml: string;
}

/** How long a resolved config is trusted before the source files are re-stat'ed. */
const POLL_INTERVAL_MS = 2000;

type ScalarKey = keyof Scalars;

interface Bound {
	min?: number;
	max?: number;
}

/** Mirrors the `min`/`max` declared in the plugin manifest, so both stores validate identically. */
const NUMBER_BOUNDS: Partial<Record<ScalarKey, Bound>> = {
	stage1TimeoutMs: { min: 500, max: 25000 },
	stage2TimeoutMs: { min: 1000, max: 28000 },
	maxConsecutiveDenials: { min: 1 },
	maxTotalDenials: { min: 1 },
	cacheSize: { min: 0 },
};

const SCALAR_KEYS = Object.keys(SCALAR_DEFAULTS) as ScalarKey[];
const YAML_SECTIONS = new Set(["rules", "environment", "evidence", "log"]);

interface Layer {
	origin: string;
	values: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A source file's identity, used to decide whether anything actually changed. */
function stamp(file: string): string {
	try {
		const stat = fs.statSync(file);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "-";
	}
}

export class ConfigStore {
	readonly #paths: ConfigPaths;
	readonly #now: () => number;
	#cached?: EffectiveConfig;
	#stamps = "";
	#checkedAt = 0;

	constructor(paths: ConfigPaths, now: () => number = Date.now) {
		this.#paths = paths;
		this.#now = now;
	}

	/** Every file whose content can change the effective config. */
	get #sources(): string[] {
		return [this.#paths.lockfile, this.#paths.projectOverrides, this.#paths.userYaml, this.#paths.projectYaml];
	}

	get(): EffectiveConfig {
		if (this.#cached === undefined) return this.#refresh();
		const now = this.#now();
		if (now - this.#checkedAt < POLL_INTERVAL_MS) return this.#cached;
		this.#checkedAt = now;
		const current = this.#sources.map(stamp).join("|");
		if (current === this.#stamps) return this.#cached;
		return this.#refresh();
	}

	/** Drop the cached resolution, so the next `get` re-reads every source. */
	reload(): void {
		this.#cached = undefined;
	}

	#refresh(): EffectiveConfig {
		this.#checkedAt = this.#now();
		this.#stamps = this.#sources.map(stamp).join("|");
		this.#cached = resolve(this.#paths);
		return this.#cached;
	}
}

function readJsonSettings(file: string, origin: string, warnings: string[]): Layer {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { origin, values: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		warnings.push(`${origin} (${file}) is not valid JSON and was ignored: ${message(error)}`);
		return { origin, values: {} };
	}
	if (!isRecord(parsed)) {
		warnings.push(`${origin} (${file}) is not an object and was ignored.`);
		return { origin, values: {} };
	}
	const settings = parsed.settings;
	if (!isRecord(settings)) return { origin, values: {} };
	const mine = settings[PLUGIN_NAME];
	if (!isRecord(mine)) return { origin, values: {} };
	return { origin, values: mine };
}

function readYaml(file: string, origin: string, warnings: string[]): Layer {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { origin, values: {} };
	}
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(text);
	} catch (error) {
		warnings.push(`${origin} (${file}) is not valid YAML and was ignored: ${message(error)}`);
		return { origin, values: {} };
	}
	if (parsed === null || parsed === undefined) return { origin, values: {} };
	if (!isRecord(parsed)) {
		warnings.push(`${origin} (${file}) must be a mapping at the top level and was ignored.`);
		return { origin, values: {} };
	}
	for (const key of Object.keys(parsed)) {
		if (YAML_SECTIONS.has(key) || SCALAR_KEYS.includes(key as ScalarKey)) continue;
		warnings.push(`${origin} sets unknown key "${key}", which has no effect. Check for a typo.`);
	}
	return { origin, values: parsed };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Type-check and range-check one scalar. Rejected values keep the lower-precedence winner. */
function acceptScalar(key: ScalarKey, raw: unknown, origin: string, warnings: string[]): boolean {
	const expected = typeof SCALAR_DEFAULTS[key];
	if (typeof raw !== expected) {
		warnings.push(`${origin} sets ${key} to ${JSON.stringify(raw)} (expected ${expected}); ignored.`);
		return false;
	}
	if (typeof raw === "number") {
		if (!Number.isFinite(raw)) {
			warnings.push(`${origin} sets ${key} to a non-finite number; ignored.`);
			return false;
		}
		const bound = NUMBER_BOUNDS[key];
		if (bound?.min !== undefined && raw < bound.min) {
			warnings.push(`${origin} sets ${key} to ${raw}, below the minimum of ${bound.min}; ignored.`);
			return false;
		}
		if (bound?.max !== undefined && raw > bound.max) {
			warnings.push(`${origin} sets ${key} to ${raw}, above the maximum of ${bound.max}; ignored.`);
			return false;
		}
	}
	return true;
}

function stringList(raw: unknown, label: string, origin: string, warnings: string[]): string[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		warnings.push(`${origin} sets ${label} to a non-list value; ignored.`);
		return undefined;
	}
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			out.push(entry);
			continue;
		}
		warnings.push(`${origin} has a non-string entry in ${label} (${JSON.stringify(entry)}); dropped.`);
	}
	return out;
}

function positiveInt(raw: unknown, label: string, origin: string, warnings: string[]): number | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
		warnings.push(`${origin} sets ${label} to ${JSON.stringify(raw)} (expected a positive number); ignored.`);
		return undefined;
	}
	return Math.floor(raw);
}

function resolve(paths: ConfigPaths): EffectiveConfig {
	const warnings: string[] = [];
	const layers: Layer[] = [
		readJsonSettings(paths.lockfile, "plugin lockfile", warnings),
		readJsonSettings(paths.projectOverrides, "project plugin-overrides.json", warnings),
		readYaml(paths.userYaml, "user autoclassifier.yml", warnings),
		readYaml(paths.projectYaml, "project autoclassifier.yml", warnings),
	];

	const scalars: Scalars = { ...SCALAR_DEFAULTS };
	const origins: Record<string, string> = {};
	for (const key of SCALAR_KEYS) origins[key] = "default";
	for (const layer of layers) {
		for (const key of SCALAR_KEYS) {
			const raw = layer.values[key];
			if (raw === undefined) continue;
			if (!acceptScalar(key, raw, layer.origin, warnings)) continue;
			// `acceptScalar` has already proved `raw` matches this key's declared type.
			Reflect.set(scalars, key, raw);
			origins[key] = layer.origin;
		}
	}

	// Sections are replaced wholesale by the highest-precedence layer that sets them, so a project can
	// override a rule list without inheriting half of the user's.
	const sections = new Map<string, Layer>();
	for (const layer of layers) {
		for (const key of YAML_SECTIONS) {
			if (layer.values[key] !== undefined) sections.set(key, layer);
		}
	}

	const rulesLayer = sections.get("rules");
	const rawRules = rulesLayer?.values.rules;
	const rulesRecord = isRecord(rawRules) ? rawRules : {};
	if (rulesLayer && !isRecord(rawRules)) {
		warnings.push(`${rulesLayer.origin} sets rules to a non-mapping value; ignored.`);
	}
	const rulesOrigin = rulesLayer?.origin ?? "default";
	const rules = {
		hardDeny: expandDefaults(stringList(rulesRecord.hardDeny, "rules.hardDeny", rulesOrigin, warnings), DEFAULT_HARD_DENY),
		deny: expandDefaults(stringList(rulesRecord.deny, "rules.deny", rulesOrigin, warnings), DEFAULT_DENY),
		ask: expandDefaults(stringList(rulesRecord.ask, "rules.ask", rulesOrigin, warnings), DEFAULT_ASK),
		allow: expandDefaults(stringList(rulesRecord.allow, "rules.allow", rulesOrigin, warnings), DEFAULT_ALLOW),
	};
	for (const list of ["hardDeny", "deny", "ask", "allow"] as const) {
		origins[`rules.${list}`] = rulesRecord[list] === undefined ? "default" : rulesOrigin;
	}

	const envLayer = sections.get("environment");
	const environment = expandDefaults(
		stringList(envLayer?.values.environment, "environment", envLayer?.origin ?? "default", warnings),
		DEFAULT_ENVIRONMENT,
	);
	origins.environment = envLayer?.origin ?? "default";

	const evidenceLayer = sections.get("evidence");
	const rawEvidence = evidenceLayer?.values.evidence;
	const evidenceRecord = isRecord(rawEvidence) ? rawEvidence : {};
	if (evidenceLayer && !isRecord(rawEvidence)) {
		warnings.push(`${evidenceLayer.origin} sets evidence to a non-mapping value; ignored.`);
	}
	const evidenceOrigin = evidenceLayer?.origin ?? "default";
	const evidence = {
		maxUserMessages:
			positiveInt(evidenceRecord.maxUserMessages, "evidence.maxUserMessages", evidenceOrigin, warnings) ??
			EVIDENCE_DEFAULTS.maxUserMessages,
		maxCharsPerMessage:
			positiveInt(evidenceRecord.maxCharsPerMessage, "evidence.maxCharsPerMessage", evidenceOrigin, warnings) ??
			EVIDENCE_DEFAULTS.maxCharsPerMessage,
	};
	origins.evidence = evidenceOrigin;

	const logLayer = sections.get("log");
	const rawLog = logLayer?.values.log;
	const logRecord = isRecord(rawLog) ? rawLog : {};
	const configuredPath = logRecord.path;
	let logPath = path.join(paths.agentDir, "autoclassifier", "decisions.jsonl");
	origins.logPath = "default";
	if (typeof configuredPath === "string" && configuredPath.length > 0) {
		logPath = path.resolve(paths.cwd, configuredPath);
		origins.logPath = logLayer?.origin ?? "default";
	} else if (configuredPath !== undefined && configuredPath !== null) {
		warnings.push(`${logLayer?.origin} sets log.path to a non-string value; ignored.`);
	}

	return {
		...scalars,
		rules,
		compiled: compileRules(rules, {
			agentDir: paths.agentDir,
			cwd: paths.cwd,
			pluginsRoot: paths.pluginsRoot,
			home: process.env.HOME ?? paths.agentDir,
		}),
		environment,
		evidence,
		logPath,
		origins,
		warnings,
	};
}
