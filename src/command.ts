/**
 * The `/autoclassifier` command.
 *
 * `config` exists because the split store — scalars in the plugin lockfile, lists in YAML — is genuinely
 * confusing: a value can come from any of five places. Printing the winning origin of every key is what
 * makes that design diagnosable rather than mysterious.
 *
 * `on` and `off` are session-scoped on purpose. A slash command that silently rewrote persistent config
 * would make the gate's state depend on which session last touched it.
 */
import type { EffectiveConfig } from "./config";
import type { DecisionRecord } from "./gate";
import type { GateState } from "./state";

export interface SessionOverride {
	get: () => boolean | undefined;
	set: (value: boolean | undefined) => void;
}

export interface CommandDeps {
	config: () => EffectiveConfig;
	state: GateState;
	/** The configured `modelRoles.classifier`, or undefined when the gate has nothing to ask. */
	classifierRole: () => string | undefined;
	tail: (count: number, filter?: (record: DecisionRecord) => boolean) => DecisionRecord[];
	logPath: string;
	logDisabledReason: string | undefined;
	reload: () => void;
	runSetup: () => Promise<void>;
	print: (text: string) => void;
	sessionOverride: SessionOverride;
}

const SUBCOMMANDS = [
	"status",
	"on",
	"off",
	"pause",
	"resume",
	"setup",
	"reload",
	"config",
	"rules",
	"denials",
	"log",
] as const;

const HISTORY_LIMIT = 20;

function describeRecord(record: DecisionRecord): string {
	const time = record.timestamp.slice(11, 19);
	const parts = [`${time}  ${record.decision.padEnd(5)} ${record.toolName.padEnd(14)} via ${record.via}`];
	if (record.risk !== undefined) parts.push(`risk ${record.risk}`);
	if (record.rule !== undefined) parts.push(`rule \`${record.rule}\``);
	if (record.reason !== undefined) parts.push(record.reason);
	return parts.join(" — ");
}

function status(deps: CommandDeps): string {
	const cfg = deps.config();
	const snapshot = deps.state.snapshot();
	const role = deps.classifierRole();
	const override = deps.sessionOverride.get();

	const lines: string[] = [];
	if (override === false) {
		lines.push("autoclassifier: **off** for this session (`/autoclassifier on` to re-arm).");
	} else if (!cfg.enabled) {
		lines.push("autoclassifier: **off** — disabled in configuration.");
	} else if (role === undefined) {
		lines.push("autoclassifier: **inactive** — no `classifier` model role is configured.");
		lines.push("Run `/autoclassifier setup` to choose a model; until then no tool call is classified.");
	} else if (deps.state.paused) {
		lines.push("autoclassifier: **paused** — the breaker tripped after repeated blocks.");
		lines.push("Every call is allowed until you run `/autoclassifier resume`.");
	} else if (snapshot.degradedReason !== undefined) {
		lines.push(`autoclassifier: **degraded** — blocking every classified call: ${snapshot.degradedReason}`);
	} else {
		lines.push("autoclassifier: **armed**.");
	}

	if (role !== undefined) lines.push(`Classifier model: ${role}`);
	lines.push(
		`Checked ${snapshot.checked} · allowed ${snapshot.allowed} · blocked ${snapshot.denied}` +
			` · consecutive blocks ${snapshot.consecutiveDenials}/${cfg.maxConsecutiveDenials}`,
	);
	lines.push(`Active in modes: ${cfg.activeModes} · escalation ${cfg.escalate ? "on" : "off"}`);
	if (deps.logDisabledReason !== undefined) lines.push(`Audit log disabled: ${deps.logDisabledReason}`);
	lines.push(
		"Session switches are temporary. For a persistent change use `omp plugin config set omp-autoclassifier <key> <value>` or edit `autoclassifier.yml`.",
	);
	return lines.join("\n");
}

function configView(deps: CommandDeps): string {
	const cfg = deps.config();
	const lines = ["autoclassifier effective configuration (value ← origin):", ""];
	const scalars: [string, unknown][] = [
		["enabled", cfg.enabled],
		["activeModes", cfg.activeModes],
		["escalate", cfg.escalate],
		["classifySubagents", cfg.classifySubagents],
		["stage1TimeoutMs", cfg.stage1TimeoutMs],
		["stage2TimeoutMs", cfg.stage2TimeoutMs],
		["maxConsecutiveDenials", cfg.maxConsecutiveDenials],
		["maxTotalDenials", cfg.maxTotalDenials],
		["cacheSize", cfg.cacheSize],
		["includeToolResults", cfg.includeToolResults],
		["logDecisions", cfg.logDecisions],
		["logClassifierIo", cfg.logClassifierIo],
	];
	for (const [key, value] of scalars) {
		lines.push(`  ${key.padEnd(22)} ${String(value).padEnd(22)} ← ${cfg.origins[key] ?? "default"}`);
	}
	for (const list of ["hardDeny", "deny", "ask", "allow"] as const) {
		const key = `rules.${list}`;
		lines.push(`  ${key.padEnd(22)} ${`${cfg.rules[list].length} rule(s)`.padEnd(22)} ← ${cfg.origins[key] ?? "default"}`);
	}
	lines.push(`  ${"environment".padEnd(22)} ${`${cfg.environment.length} line(s)`.padEnd(22)} ← ${cfg.origins.environment ?? "default"}`);
	lines.push(`  ${"logPath".padEnd(22)} ${cfg.logPath}`);
	lines.push("", `Audit log: ${deps.logPath}`);
	if (cfg.warnings.length > 0) {
		lines.push("", "Problems found while loading configuration:");
		for (const warning of cfg.warnings) lines.push(`  - ${warning}`);
	}
	return lines.join("\n");
}

function rulesView(deps: CommandDeps): string {
	const cfg = deps.config();
	const lines = ["autoclassifier effective rules, highest precedence first:"];
	for (const list of ["hardDeny", "deny", "ask", "allow"] as const) {
		lines.push("", `${list} (${cfg.rules[list].length}):`);
		if (cfg.rules[list].length === 0) lines.push("  (empty)");
		for (const rule of cfg.rules[list]) lines.push(`  ${rule}`);
	}
	lines.push("", "Anything matching none of these is sent to the classifier.");
	return lines.join("\n");
}

function historyView(deps: CommandDeps, onlyBlocks: boolean): string {
	const records = onlyBlocks
		? deps.tail(HISTORY_LIMIT, record => record.decision === "block")
		: deps.tail(HISTORY_LIMIT);
	if (records.length === 0) {
		return onlyBlocks
			? "autoclassifier has blocked nothing in this log."
			: `autoclassifier has recorded no decisions yet. Log: ${deps.logPath}`;
	}
	const heading = onlyBlocks ? "Recent blocks:" : "Recent decisions:";
	return [heading, ...records.map(describeRecord)].join("\n");
}

export async function runCommand(deps: CommandDeps, args: string): Promise<void> {
	const name = args.trim().toLowerCase().split(/\s+/)[0] ?? "";
	switch (name) {
		case "":
		case "status":
			deps.print(status(deps));
			return;
		case "on":
			deps.sessionOverride.set(true);
			deps.print("autoclassifier: on for this session.");
			return;
		case "off":
			deps.sessionOverride.set(false);
			deps.print("autoclassifier: off for this session. Tool calls are no longer classified.");
			return;
		case "pause":
			deps.state.pause();
			deps.print("autoclassifier: paused. Every call is allowed until `/autoclassifier resume`.");
			return;
		case "resume":
			deps.state.resume();
			deps.print("autoclassifier: re-armed, block counters cleared.");
			return;
		case "setup":
			await deps.runSetup();
			return;
		case "reload":
			deps.reload();
			deps.print("autoclassifier: configuration reloaded and the verdict cache cleared.");
			return;
		case "config":
			deps.print(configView(deps));
			return;
		case "rules":
			deps.print(rulesView(deps));
			return;
		case "denials":
			deps.print(historyView(deps, true));
			return;
		case "log":
			deps.print(historyView(deps, false));
			return;
		default:
			deps.print(`autoclassifier: unknown subcommand \`${name}\`. Try one of: ${SUBCOMMANDS.join(", ")}.`);
	}
}

/** Autocomplete source for the command's argument. */
export const subcommandNames: readonly string[] = SUBCOMMANDS;
