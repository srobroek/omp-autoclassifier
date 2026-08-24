/**
 * Deterministic rule matching, evaluated before any model call.
 *
 * Grammar (deliberately the same shape Claude Code and pi-automode use, so existing muscle memory
 * transfers): `tool` matches every call to that tool, `tool(pattern)` matches when `pattern` matches
 * the tool's primary argument. `*` is the only metacharacter and spans `/`.
 *
 * The primary-argument table is the entire contract for what a rule inspects: omp exposes no
 * approval tier to extensions, so tool identity and argument shape come from the tool name alone.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULTS_SENTINEL, type PathVars, type RuleLists, type RuleVerdict } from "./defaults";

/** Tools whose primary argument is a filesystem path, and therefore compared path-wise. */
const PATH_TOOLS = new Set(["read", "write", "edit"]);

/** Tools whose primary argument is a named field rather than the serialized input. */
const PRIMARY_FIELD: Record<string, string> = {
	bash: "command",
	eval: "code",
	read: "path",
	write: "path",
	edit: "path",
	grep: "pattern",
	glob: "path",
	lsp: "action",
	web_search: "query",
};

/**
 * The value a rule pattern is matched against. Unknown tools, including every `mcp__*` server tool,
 * fall back to the serialized input so a rule can still target them.
 */
export function primaryArgument(toolName: string, input: unknown): string {
	const field = PRIMARY_FIELD[toolName];
	if (field === undefined) {
		if (input === null || input === undefined) return "";
		try {
			return JSON.stringify(input) ?? "";
		} catch {
			return "";
		}
	}
	const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined;
	const value = record?.[field];
	if (typeof value === "string") return value;
	if (toolName === "glob" && value === undefined) return ".";
	return "";
}

/** A URL-scheme target (`ssh://`, `xd://`, `local://`, …) is never a local filesystem path. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

const HASHLINE_TAG_RE = /#[0-9a-fA-F]{4}$/u;

/**
 * Strip the decorations omp's file tools accept around a path, so none of them can be used to dodge
 * a rule: hashline `¶` prefixes, a `[path#TAG]` wrapper, surrounding quotes, and a trailing `#TAG`.
 * omp's own `write` approval unwraps the same shapes before deciding its tier.
 */
function unwrapPath(raw: string): string {
	let value = raw.trim();
	while (value.startsWith("¶")) value = value.slice(1).trim();
	if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1).trim();
	const tag = HASHLINE_TAG_RE.exec(value);
	if (tag?.index !== undefined) value = value.slice(0, tag.index).trim();
	const first = value[0];
	if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
		value = value.slice(1, -1).trim();
	}
	return value;
}

/**
 * Every path this call targets.
 *
 * omp derives `paths` for hashline `edit` calls and omits `path` entirely when two or more files are
 * targeted — its own comment says the derivation exists so extension gates that allowlist by path
 * cannot be bypassed. Reading only `path` would therefore miss the multi-file case.
 */
export function candidatePaths(toolName: string, input: unknown): string[] {
	if (!PATH_TOOLS.has(toolName)) return [];
	return pathFields(input);
}

/** Unwrapped `path` / `paths` string fields of any tool's input, in `paths`-then-`path` order. */
function pathFields(input: unknown): string[] {
	const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined;
	if (record === undefined) return [];
	const out: string[] = [];
	const many = record.paths;
	if (Array.isArray(many)) {
		for (const entry of many) {
			if (typeof entry !== "string") continue;
			const unwrapped = unwrapPath(entry);
			if (unwrapped.length > 0) out.push(unwrapped);
		}
	}
	const one = record.path;
	if (typeof one === "string") {
		const unwrapped = unwrapPath(one);
		if (unwrapped.length > 0 && !out.includes(unwrapped)) out.push(unwrapped);
	}
	return out;
}

/**
 * Targets that name a URL scheme, for any tool. Checked independently of the primary-argument table
 * because `grep`'s rule pattern matches its search pattern while its remote-ness lives in `path`.
 */
export function remoteTargets(input: unknown): string[] {
	return pathFields(input).filter(target => SCHEME_RE.test(target));
}

function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (const ch of pattern) {
		out += ch === "*" ? "[\\s\\S]*" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

/**
 * Resolve the non-glob head of a path to its real location, so a symlinked directory cannot be used
 * to reach a protected file under a different spelling. The first `*` ends the resolvable head; a
 * path component that does not exist yet is kept verbatim, because a `write` creates it.
 *
 * A URL-scheme target is returned untouched: `ssh://host/etc/passwd` is a remote operation and
 * `xd://ast_edit` is a tool dispatch, so resolving either against the working directory would
 * invent a local path that does not exist and silently defeat rules written against the real one.
 */
function resolveRealish(input: string, cwd: string, home: string): string {
	if (SCHEME_RE.test(input)) return input;
	let raw = input;
	if (raw === "~") raw = home;
	else if (raw.startsWith("~/")) raw = path.join(home, raw.slice(2));
	const absolute = path.resolve(cwd, raw);
	const star = absolute.indexOf("*");
	const head = star === -1 ? absolute : absolute.slice(0, absolute.lastIndexOf(path.sep, star) + 1);
	const tail = absolute.slice(head.length);

	let existing = head;
	let unresolved = "";
	for (;;) {
		if (existing.length === 0) break;
		try {
			existing = fs.realpathSync(existing);
			break;
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) break;
			unresolved = path.join(path.basename(existing), unresolved);
			existing = parent;
		}
	}
	return path.join(existing, unresolved, tail);
}

interface Matcher {
	tool: RegExp;
	/** Absent means "any argument": a bare tool-name rule. */
	arg?: RegExp;
	/** Whether the argument is compared as a path rather than as raw text. */
	pathwise: boolean;
	/** Whether the rule itself names a URL scheme, and so knowingly covers remote targets. */
	schemeAware: boolean;
	source: string;
}

export interface CompiledRules {
	hardDeny: Matcher[];
	deny: Matcher[];
	ask: Matcher[];
	allow: Matcher[];
	vars: PathVars;
}

/** Precedence order. Callers must not reorder this. */
const ORDER: readonly RuleVerdict[] = ["hardDeny", "deny", "ask", "allow"];

function expandVars(pattern: string, vars: PathVars): string {
	return pattern
		.replaceAll("<agentDir>", vars.agentDir)
		.replaceAll("<cwd>", vars.cwd)
		.replaceAll("<pluginsRoot>", vars.pluginsRoot)
		.replaceAll("<home>", vars.home);
}

function compileOne(rule: string, vars: PathVars): Matcher | undefined {
	const trimmed = rule.trim();
	if (trimmed.length === 0) return undefined;

	const open = trimmed.indexOf("(");
	if (open === -1) {
		return { tool: globToRegExp(trimmed), pathwise: false, schemeAware: false, source: trimmed };
	}
	if (!trimmed.endsWith(")")) return undefined;

	const toolName = trimmed.slice(0, open).trim();
	const argPattern = trimmed.slice(open + 1, -1);
	if (toolName.length === 0 || argPattern.length === 0) return undefined;

	const pathwise = PATH_TOOLS.has(toolName);
	const expanded = expandVars(argPattern, vars);
	const arg = pathwise ? globToRegExp(resolveRealish(expanded, vars.cwd, vars.home)) : globToRegExp(expanded);
	return { tool: globToRegExp(toolName), arg, pathwise, schemeAware: expanded.includes("://"), source: trimmed };
}

export function compileRules(lists: RuleLists, vars: PathVars): CompiledRules {
	const compiled: CompiledRules = { hardDeny: [], deny: [], ask: [], allow: [], vars };
	for (const list of ORDER) {
		for (const rule of lists[list]) {
			const matcher = compileOne(rule, vars);
			if (matcher) compiled[list].push(matcher);
		}
	}
	return compiled;
}

/**
 * Whether `matcher` claims this call.
 *
 * The allow/deny asymmetry is the load-bearing part. A deny fires when *any* targeted path matches,
 * because one protected file is enough to refuse the call. An allow requires *every* targeted path to
 * match, because a multi-file edit that touches one allowlisted file and one protected file must not
 * be fast-pathed past the classifier on the strength of the innocent half.
 */
function matcherClaims(
	matcher: Matcher,
	list: RuleVerdict,
	toolName: string,
	rawArgument: string,
	targets: () => string[],
	remoteTargets: () => string[],
): boolean {
	if (!matcher.tool.test(toolName)) return false;
	// omp promotes any tool call with an `ssh://` target to `exec` tier because the work happens on
	// another host. A fast-path allow that never mentioned a scheme must not cover that, or the gate
	// hands out remote execution for free. A rule that spells out the scheme is taken at its word.
	if (list === "allow" && !matcher.schemeAware && remoteTargets().length > 0) return false;
	const arg = matcher.arg;
	if (arg === undefined) return true;
	if (matcher.pathwise && PATH_TOOLS.has(toolName)) {
		const resolved = targets();
		if (resolved.length === 0) return false;
		return list === "allow" ? resolved.every(target => arg.test(target)) : resolved.some(target => arg.test(target));
	}
	return arg.test(rawArgument);
}

/** Which list claimed the call, and the rule text that did it. */
export interface RuleMatch {
	list: RuleVerdict;
	/** Verbatim rule as written in config, for the block reason and the audit log. */
	source: string;
}

/**
 * The rule that claims this call, or `undefined` when nothing matches and the classifier must
 * decide. Evaluated in precedence order and returns on first match.
 */
export function evaluateRules(
	compiled: CompiledRules,
	toolName: string,
	input: unknown,
	cwd: string,
): RuleMatch | undefined {
	const rawArgument = primaryArgument(toolName, input);
	let resolved: string[] | undefined;
	let remote: string[] | undefined;
	// Memoized: path resolution stats the filesystem, and most calls test many matchers.
	const targets = () =>
		(resolved ??= candidatePaths(toolName, input).map(target => resolveRealish(target, cwd, compiled.vars.home)));
	const remotes = () => (remote ??= remoteTargets(input));

	for (const list of ORDER) {
		for (const matcher of compiled[list]) {
			if (matcherClaims(matcher, list, toolName, rawArgument, targets, remotes)) {
				return { list, source: matcher.source };
			}
		}
	}
	return undefined;
}

/** The claiming list alone. The gate and its tests read verdicts far more often than rule text. */
export function matchRule(
	compiled: CompiledRules,
	toolName: string,
	input: unknown,
	cwd: string,
): RuleVerdict | undefined {
	return evaluateRules(compiled, toolName, input, cwd)?.list;
}

/**
 * Apply the `$defaults` sentinel. Present: shipped defaults expand in place, so adding one rule
 * never silently drops the shipped set. Absent: the caller's list replaces the defaults outright.
 * A list omitted from config entirely keeps the defaults.
 */
export function expandDefaults(list: string[] | undefined, defaults: readonly string[]): string[] {
	if (list === undefined) return [...defaults];
	const out: string[] = [];
	let expanded = false;
	for (const entry of list) {
		if (entry !== DEFAULTS_SENTINEL) {
			out.push(entry);
			continue;
		}
		if (expanded) continue;
		out.push(...defaults);
		expanded = true;
	}
	return out;
}

/** Placeholder values for the running install. */
export function pathVars(agentDir: string, cwd: string, pluginsRoot: string): PathVars {
	return { agentDir, cwd, pluginsRoot, home: os.homedir() };
}
