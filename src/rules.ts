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

/**
 * Tools whose target is a filesystem path, and therefore compared path-wise.
 *
 * `grep` and `glob` belong here even though their primary argument is not a path. A review found the
 * reason: `grep` is allowlisted and returns the matching lines, so searching `~/.ssh` for `PRIVATE KEY`
 * leaks the key as surely as reading the file, and a path rule could not see the target because the tool
 * was not compared path-wise. Their `path` field is optional, and a call without one resolves to no
 * targets, which a path rule then declines to claim. So a bare search still takes the fast path.
 */
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "glob"]);

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
 * Tools whose argument is a command line rather than a value, so one call can carry several actions.
 *
 * These need the same allow/deny asymmetry paths get, for the same reason. `bash` matches on its whole
 * `command` string, so `allow: ["bash(git status*)"]` cleared `git status` followed by anything at all,
 * and `deny: ["bash(git push*)"]` missed a push that had a harmless command in front of it. Both holes
 * open with a rule a careful user would plausibly write.
 */
const COMMAND_TOOLS: Record<string, true> = { bash: true, eval: true };

/** Shell text that starts a new action, plus the two substitution forms that smuggle one inside another. */
const LINK_SPLIT_RE = /&&|\|\||[;\n|]/;
const SUBSTITUTION_RE = /\$\(([^()]*)\)|`([^`]*)`/g;
/**
 * The same shapes without `g`. A global regex carries `lastIndex` across `.test()` calls, so reusing
 * `SUBSTITUTION_RE` for a predicate returns alternating answers on identical input.
 */
const OPERATOR_PRESENT_RE = /&&|\|\||[;\n|]|\$\(|`/;

/**
 * Every action a command string carries: the top-level links, plus the body of any substitution.
 *
 * Quoting is deliberately not parsed. Splitting inside a quoted string makes an allow stricter and a deny
 * broader, and both of those are the safe direction, so a shell-accurate parser would only ever weaken
 * this. A single link comes back as a one-element list, which leaves an ordinary command on the existing
 * whole-string path.
 */
export function commandLinks(value: string): string[] {
	const inner: string[] = [];
	const stripped = value.replace(SUBSTITUTION_RE, (_match, dollar: string | undefined, tick: string | undefined) => {
		const body = (dollar ?? tick ?? "").trim();
		if (body.length > 0) inner.push(body);
		return " ";
	});
	const links = [...stripped.split(LINK_SPLIT_RE), ...inner].map(link => link.trim()).filter(link => link.length > 0);
	return links.length > 0 ? links : [value.trim()];
}

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

/** Any URL-scheme target. None of these is a local filesystem path, so none gets path-resolved. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Schemes that disqualify a fast-path allow, because the operation leaves this machine or dispatches
 * another tool:
 *
 *   - `ssh://`          omp promotes `read` and `grep` to `exec` tier; the work runs on another host
 *   - `http(s)://`      network egress, so a data channel out of the workspace
 *   - `xd://`           a `write` to a device URL executes the mounted tool instead of writing a file
 *
 * omp's other schemes (`skill://`, `rule://`, `local://`, `omp://`, `memory://`, `artifact://`,
 * `agent://`, `history://`) resolve inside the process. Treating those as remote would push the agent's
 * own skills and plan files through the classifier for nothing, and a degraded classifier would then
 * block it from reading them.
 */
const REMOTE_SCHEME_RE = /^(?:ssh|https?|xd):\/\//i;

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
 * Targets that leave this machine or dispatch another tool, for any tool. Checked independently of the
 * primary-argument table because `grep`'s rule pattern matches its search pattern while its remoteness
 * lives in `path`.
 */
export function remoteTargets(input: unknown): string[] {
	return pathFields(input).filter(target => REMOTE_SCHEME_RE.test(target));
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
	/** Whether the rule itself contains a shell operator, and so knowingly covers a compound command. */
	operatorAware: boolean;
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
		return { tool: globToRegExp(trimmed), pathwise: false, schemeAware: false, operatorAware: false, source: trimmed };
	}
	if (!trimmed.endsWith(")")) return undefined;

	const toolName = trimmed.slice(0, open).trim();
	const argPattern = trimmed.slice(open + 1, -1);
	if (toolName.length === 0 || argPattern.length === 0) return undefined;

	const pathwise = PATH_TOOLS.has(toolName);
	const expanded = expandVars(argPattern, vars);
	const arg = pathwise ? globToRegExp(resolveRealish(expanded, vars.cwd, vars.home)) : globToRegExp(expanded);
	return {
		tool: globToRegExp(toolName),
		arg,
		pathwise,
		schemeAware: expanded.includes("://"),
		operatorAware: OPERATOR_PRESENT_RE.test(expanded),
		source: trimmed,
	};
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
 * Whether `matcher` claims this call, and the concrete target it fired on.
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
): { target?: string } | undefined {
	if (!matcher.tool.test(toolName)) return undefined;
	// omp promotes any tool call with an `ssh://` target to `exec` tier because the work happens on
	// another host. A fast-path allow that never mentioned a scheme must not cover that, or the gate
	// hands out remote execution for free. A rule that spells out the scheme is taken at its word.
	if (list === "allow" && !matcher.schemeAware && remoteTargets().length > 0) return undefined;
	const arg = matcher.arg;
	// A bare tool rule ignores arguments, but still reports one so the block message stays specific.
	if (arg === undefined) return { target: describeTarget(rawArgument) };
	if (matcher.pathwise && PATH_TOOLS.has(toolName)) {
		const resolved = targets();
		if (resolved.length === 0) return undefined;
		if (list === "allow") {
			return resolved.every(target => arg.test(target)) ? { target: describeTarget(resolved[0]) } : undefined;
		}
		// Report the specific path that tripped the rule, not the whole list.
		const hit = resolved.find(target => arg.test(target));
		return hit === undefined ? undefined : { target: describeTarget(hit) };
	}
	// The same any/every doctrine, for the tools whose one argument carries several actions. A rule that
	// writes an operator itself is taken at its word and compared whole, exactly as a scheme-aware rule is.
	if (COMMAND_TOOLS[toolName] === true && !matcher.operatorAware) {
		const links = commandLinks(rawArgument);
		if (links.length > 1) {
			if (list === "allow") {
				return links.every(link => arg.test(link)) ? { target: describeTarget(links[0]) } : undefined;
			}
			// Name the link that tripped the rule, not the whole pipeline.
			const hit = links.find(link => arg.test(link));
			return hit === undefined ? undefined : { target: describeTarget(hit) };
		}
	}
	return arg.test(rawArgument) ? { target: describeTarget(rawArgument) } : undefined;
}

/** Keep a block message readable: a 200-line heredoc is not useful in a one-line reason. */
const MAX_TARGET_CHARS = 300;

export function describeTarget(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	// `{}` and `null` are what serializing an argument-free call produces. Putting either in a block
	// message adds noise and tells the reader nothing.
	if (trimmed.length === 0 || trimmed === "{}" || trimmed === "null") return undefined;
	return trimmed.length <= MAX_TARGET_CHARS ? trimmed : `${trimmed.slice(0, MAX_TARGET_CHARS)}…`;
}

/** Which list claimed the call, the rule text that did it, and the target it fired on. */
export interface RuleMatch {
	list: RuleVerdict;
	/** Verbatim rule as written in config, for the block reason and the audit log. */
	source: string;
	/** The concrete path or argument that matched, truncated for display. */
	target?: string;
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
			const claim = matcherClaims(matcher, list, toolName, rawArgument, targets, remotes);
			if (claim !== undefined) return { list, source: matcher.source, target: claim.target };
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
