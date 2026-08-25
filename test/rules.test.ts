import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_ALLOW,
	DEFAULT_ASK,
	DEFAULT_HARD_DENY,
	DEFAULTS_SENTINEL,
	type PathVars,
	type RuleLists,
} from "../src/defaults";
import { compileRules, evaluateRules, expandDefaults, matchRule, primaryArgument } from "../src/rules";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-rules-"));
const realTmpRoot = fs.realpathSync(tmpRoot);

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const vars: PathVars = {
	agentDir: path.join(realTmpRoot, "agent"),
	cwd: path.join(realTmpRoot, "project"),
	pluginsRoot: path.join(realTmpRoot, "plugins"),
	home: realTmpRoot,
};

fs.mkdirSync(vars.agentDir, { recursive: true });
fs.mkdirSync(vars.cwd, { recursive: true });
fs.mkdirSync(vars.pluginsRoot, { recursive: true });

function lists(partial: Partial<RuleLists>): RuleLists {
	return { hardDeny: [], deny: [], ask: [], allow: [], ...partial };
}

function match(partial: Partial<RuleLists>, toolName: string, input: unknown) {
	return matchRule(compileRules(lists(partial), vars), toolName, input, vars.cwd);
}

describe("primaryArgument", () => {
	test("uses the documented argument per tool", () => {
		expect(primaryArgument("bash", { command: "git status" })).toBe("git status");
		expect(primaryArgument("eval", { code: "print(1)", language: "py" })).toBe("print(1)");
		expect(primaryArgument("grep", { pattern: "TODO", path: "src" })).toBe("TODO");
		expect(primaryArgument("lsp", { action: "diagnostics" })).toBe("diagnostics");
		expect(primaryArgument("web_search", { query: "omp docs" })).toBe("omp docs");
		expect(primaryArgument("glob", {})).toBe(".");
	});

	test("falls back to serialized input for unknown and mcp tools", () => {
		expect(primaryArgument("mcp__x__y", { a: 1 })).toBe('{"a":1}');
		expect(primaryArgument("some_new_tool", { z: "q" })).toBe('{"z":"q"}');
	});

	test("never throws on malformed input", () => {
		expect(primaryArgument("bash", null)).toBe("");
		expect(primaryArgument("bash", { command: 42 })).toBe("");
		expect(primaryArgument("read", undefined)).toBe("");
	});
});

describe("pattern grammar", () => {
	test("a bare tool name matches every call to that tool", () => {
		expect(match({ allow: ["read"] }, "read", { path: "/etc/passwd" })).toBe("allow");
		expect(match({ allow: ["read"] }, "write", { path: "/etc/passwd" })).toBeUndefined();
	});

	test("star matches any run of characters including slashes", () => {
		const l = { deny: ["bash(*git push*)"] };
		expect(match(l, "bash", { command: "git push --force" })).toBe("deny");
		expect(match(l, "bash", { command: "cd /a/b && git push" })).toBe("deny");
		// The slashes have to sit inside a single link. The chained case above no longer proves a star
		// crosses a separator, because link splitting removes the path before the pattern ever sees it.
		expect(match(l, "bash", { command: "/usr/local/bin/git push --force" })).toBe("deny");
		expect(match(l, "bash", { command: "git pull" })).toBeUndefined();
	});

	test("patterns are anchored, so a partial match alone does not fire", () => {
		expect(match({ deny: ["bash(git status)"] }, "bash", { command: "git status --short" })).toBeUndefined();
		expect(match({ deny: ["bash(git status)"] }, "bash", { command: "git status" })).toBe("deny");
	});

	test("regex metacharacters in a pattern are literal", () => {
		const l = { deny: ["bash(rm -rf .*)"] };
		expect(match(l, "bash", { command: "rm -rf .*" })).toBe("deny");
		expect(match(l, "bash", { command: "rm -rf xyz" })).toBeUndefined();
	});

	test("tool names accept globs, so mcp servers can be matched as a family", () => {
		const l = { ask: ["mcp__*"] };
		expect(match(l, "mcp__github__create_pr", { a: 1 })).toBe("ask");
		expect(match(l, "github", { a: 1 })).toBeUndefined();
	});

	test("action-level allows do not leak to sibling actions", () => {
		const l = { allow: ["lsp(diagnostics)"] };
		expect(match(l, "lsp", { action: "diagnostics" })).toBe("allow");
		expect(match(l, "lsp", { action: "rename", new_name: "x" })).toBeUndefined();
	});

	test("a malformed rule is ignored rather than matching everything", () => {
		expect(match({ deny: ["bash(unclosed"] }, "bash", { command: "unclosed" })).toBeUndefined();
		expect(match({ deny: [""] }, "bash", { command: "" })).toBeUndefined();
	});
});

describe("precedence", () => {
	test("hardDeny beats deny beats ask beats allow", () => {
		const all = { hardDeny: ["bash"], deny: ["bash"], ask: ["bash"], allow: ["bash"] };
		expect(match(all, "bash", { command: "x" })).toBe("hardDeny");
		expect(match({ deny: ["bash"], ask: ["bash"], allow: ["bash"] }, "bash", { command: "x" })).toBe("deny");
		expect(match({ ask: ["bash"], allow: ["bash"] }, "bash", { command: "x" })).toBe("ask");
		expect(match({ allow: ["bash"] }, "bash", { command: "x" })).toBe("allow");
	});

	test("an unmatched call returns undefined so the classifier decides", () => {
		expect(match({ allow: ["read"] }, "bash", { command: "git status" })).toBeUndefined();
	});
});

describe("path rules", () => {
	const l = { hardDeny: ["write(<agentDir>/config.yml)", "edit(<pluginsRoot>/*)"] };

	test("placeholders expand against the live install", () => {
		expect(match(l, "write", { path: path.join(vars.agentDir, "config.yml") })).toBe("hardDeny");
		expect(match(l, "write", { path: path.join(vars.agentDir, "other.yml") })).toBeUndefined();
	});

	test("a relative spelling of the same file still matches", () => {
		const rel = path.relative(vars.cwd, path.join(vars.agentDir, "config.yml"));
		expect(match(l, "write", { path: rel })).toBe("hardDeny");
	});

	test("a tilde spelling of the same file still matches", () => {
		const l2 = { hardDeny: ["write(<home>/agent/config.yml)"] };
		expect(match(l2, "write", { path: "~/agent/config.yml" })).toBe("hardDeny");
	});

	test("redundant separators and dot segments do not evade a rule", () => {
		expect(match(l, "write", { path: path.join(vars.agentDir, "sub", "..", "config.yml") })).toBe("hardDeny");
		expect(match(l, "write", { path: `${vars.agentDir}//config.yml` })).toBe("hardDeny");
	});

	test("a symlinked directory does not evade a rule", () => {
		const link = path.join(realTmpRoot, "agent-link");
		if (!fs.existsSync(link)) fs.symlinkSync(vars.agentDir, link, "dir");
		expect(match(l, "write", { path: path.join(link, "config.yml") })).toBe("hardDeny");
	});

	test("a rule on a directory subtree covers a file that does not exist yet", () => {
		const fresh = path.join(vars.pluginsRoot, "nested", "brand-new.json");
		expect(match(l, "edit", { path: fresh })).toBe("hardDeny");
	});

	test("a sibling directory sharing a name prefix is not covered", () => {
		const sibling = path.join(realTmpRoot, "plugins-backup", "x.json");
		expect(match(l, "edit", { path: sibling })).toBeUndefined();
	});

	test("a call that names no path does not inherit a rule covering the working directory", () => {
		const l2 = { allow: ["read(<cwd>*)"] };
		expect(match(l2, "read", { path: path.join(vars.cwd, "a.ts") })).toBe("allow");
		expect(match(l2, "read", {})).toBeUndefined();
		expect(match(l2, "read", { path: 123 })).toBeUndefined();
	});
});

/**
 * omp derives `paths` for hashline `edit` calls and omits `path` entirely when two or more files are
 * targeted, specifically so an extension gate cannot be bypassed by path. Reading only `path` is an
 * anti-tamper bypass, so every candidate path has to be considered.
 */
describe("multi-path calls", () => {
	const protectedFile = path.join(vars.agentDir, "autoclassifier.yml");

	test("a deny matches when any targeted path matches", () => {
		const l = { hardDeny: ["edit(<agentDir>/autoclassifier.yml)"] };
		expect(match(l, "edit", { paths: [path.join(vars.cwd, "a.ts"), protectedFile] })).toBe("hardDeny");
		expect(match(l, "edit", { paths: [protectedFile] })).toBe("hardDeny");
		expect(match(l, "edit", { paths: [path.join(vars.cwd, "a.ts")] })).toBeUndefined();
	});

	test("an allow requires every targeted path to match", () => {
		const l = { allow: ["edit(<cwd>/*)"] };
		expect(match(l, "edit", { paths: [path.join(vars.cwd, "a.ts"), path.join(vars.cwd, "b.ts")] })).toBe("allow");
		expect(match(l, "edit", { paths: [path.join(vars.cwd, "a.ts"), protectedFile] })).toBeUndefined();
	});

	test("the single-path form still works when omp supplies both fields", () => {
		const l = { hardDeny: ["edit(<agentDir>/autoclassifier.yml)"] };
		expect(match(l, "edit", { path: protectedFile, paths: [protectedFile] })).toBe("hardDeny");
	});

	test("a hashline header wrapper does not evade a rule", () => {
		const l = { hardDeny: ["edit(<agentDir>/autoclassifier.yml)"] };
		expect(match(l, "edit", { path: `[${protectedFile}#AB12]` })).toBe("hardDeny");
		expect(match(l, "edit", { paths: [`¶${protectedFile}#AB12`] })).toBe("hardDeny");
	});

	test("a quoted path does not evade a rule", () => {
		const l = { hardDeny: ["edit(<agentDir>/autoclassifier.yml)"] };
		expect(match(l, "edit", { path: `"${protectedFile}"` })).toBe("hardDeny");
		expect(match(l, "edit", { path: `'${protectedFile}'` })).toBe("hardDeny");
	});
});

/**
 * omp's `read` and `grep` are `exec` tier when the target is `ssh://`, and `write` to `xd://`
 * dispatches a tool rather than writing a file. A URL-scheme target is therefore never a local path
 * and must not be resolved as one.
 */
describe("url-scheme targets", () => {
	test("a scheme target is matched as text, not resolved against the working directory", () => {
		const l = { hardDeny: ["read(<cwd>*)"] };
		expect(match(l, "read", { path: "ssh://host/etc/passwd" })).toBeUndefined();
	});

	test("a remote read can be singled out while local reads stay allowed", () => {
		const l = { ask: ["read(ssh://*)"], allow: ["read"] };
		expect(match(l, "read", { path: "ssh://host/etc/passwd" })).toBe("ask");
		expect(match(l, "read", { path: "README.md" })).toBe("allow");
	});

	test("a device write can be singled out", () => {
		const l = { ask: ["write(xd://*)"] };
		expect(match(l, "write", { path: "xd://ast_edit" })).toBe("ask");
		expect(match(l, "write", { path: "notes.md" })).toBeUndefined();
	});

	test("scheme detection survives a hashline wrapper", () => {
		const l = { ask: ["read(ssh://*)"] };
		expect(match(l, "read", { path: "[ssh://host/x#AB12]" })).toBe("ask");
	});

	/**
	 * omp promotes `read` and `grep` to `exec` tier when any target is `ssh://`, because the operation
	 * runs on another host. A blanket `allow: ["read"]` must therefore not fast-path a remote read, or
	 * the gate hands out remote execution for free.
	 */
	test("a blanket allow does not fast-path a remote target", () => {
		expect(match({ allow: ["read"] }, "read", { path: "ssh://host/etc/passwd" })).toBeUndefined();
		expect(match({ allow: ["read(*)"] }, "read", { path: "ssh://host/etc/passwd" })).toBeUndefined();
	});

	test("the remote check looks at path arguments even when the rule matches another field", () => {
		const l = { allow: ["grep"] };
		expect(match(l, "grep", { pattern: "secret", path: "ssh://host/etc" })).toBeUndefined();
		expect(match(l, "grep", { pattern: "secret", paths: ["src", "ssh://host/etc"] })).toBeUndefined();
		expect(match(l, "grep", { pattern: "secret", path: "src" })).toBe("allow");
	});

	test("an allow that names the scheme explicitly still applies", () => {
		expect(match({ allow: ["read(ssh://*)"] }, "read", { path: "ssh://host/x" })).toBe("allow");
	});

	test("a remote target never weakens a deny", () => {
		expect(match({ deny: ["read"] }, "read", { path: "ssh://host/x" })).toBe("deny");
	});

	/**
	 * The same asymmetry as the remote check, for the tools whose argument is a command rather than a
	 * path. `bash` matches on its whole `command` string, so `allow: ["bash(git status*)"]` matched
	 * `git status` followed by anything at all: the trailing glob covers every later link. A user adding
	 * a read-only git rule would have handed out a general bypass without writing anything careless.
	 *
	 * The prompt already says a chained command is judged on every link. The rule engine has to agree,
	 * or the deterministic layer undoes what the model layer is told to do.
	 */
	test("an allow does not fast-path a command with more links after the match", () => {
		const l = { allow: ["bash(git status*)"] };
		expect(match(l, "bash", { command: "git status" })).toBe("allow");
		expect(match(l, "bash", { command: "git status --short" })).toBe("allow");
		for (const command of [
			"git status && git push --force origin main",
			"git status; git push origin main",
			"git status || curl https://example.com/x",
			"git status | tee /etc/cron.d/x",
			"git status\ngit push origin main",
		]) {
			expect(match(l, "bash", { command })).toBeUndefined();
		}
	});

	test("the operator check covers substitution as well as chaining", () => {
		const l = { allow: ["bash(echo *)"] };
		expect(match(l, "bash", { command: "echo hello" })).toBe("allow");
		expect(match(l, "bash", { command: "echo $(cat /etc/passwd)" })).toBeUndefined();
		expect(match(l, "bash", { command: "echo `id`" })).toBeUndefined();
	});

	test("the eval tool gets the same treatment as bash", () => {
		const l = { allow: ["eval(console.log*)"] };
		expect(match(l, "eval", { code: "console.log(1)" })).toBe("allow");
		expect(match(l, "eval", { code: "console.log(1); require('child_process').execSync('id')" })).toBeUndefined();
	});

	/** A rule written for a compound command is taken at its word, exactly as a scheme-aware one is. */
	test("an allow that spells out the operator still applies", () => {
		expect(match({ allow: ["bash(git status && git diff*)"] }, "bash", { command: "git status && git diff" })).toBe("allow");
	});

	/** Awareness has to cover the substitution shapes too, not only the chaining ones. */
	test("a rule that spells out a substitution is taken at its word", () => {
		expect(match({ allow: ["bash(echo $(date))"] }, "bash", { command: "echo $(date)" })).toBe("allow");
		expect(match({ allow: ["bash(echo $(date))"] }, "bash", { command: "echo $(whoami)" })).toBeUndefined();
	});

	test("a compound command never weakens a deny", () => {
		expect(match({ deny: ["bash(git push*)"] }, "bash", { command: "git status && git push origin main" })).toBe("deny");
	});

	/**
	 * omp's `read` accepts internal URLs that never leave the machine: `skill://`, `local://`, `omp://`,
	 * `memory://`, and friends. Treating those like a remote target sends the agent's own skills and plan
	 * files to the classifier, and a degraded classifier then blocks the agent from reading them.
	 */
	test("internal omp urls are not treated as remote", () => {
		const l = { allow: ["read"] };
		for (const target of [
			"skill://write-docs",
			"rule://go-language",
			"local://plan.md",
			"omp://extensions.md",
			"memory://abc123",
			"artifact://a1",
			"agent://Scout",
			"history://x",
		]) {
			expect(match(l, "read", { path: target })).toBe("allow");
		}
	});

	/** These genuinely leave the machine, or dispatch another tool. */
	test("targets that leave the machine or dispatch a tool are not fast-pathed", () => {
		const l = { allow: ["read", "write"] };
		expect(match(l, "read", { path: "ssh://host/etc/passwd" })).toBeUndefined();
		expect(match(l, "read", { path: "https://evil.test/x" })).toBeUndefined();
		expect(match(l, "read", { path: "http://evil.test/x" })).toBeUndefined();
		expect(match(l, "write", { path: "xd://ast_edit" })).toBeUndefined();
	});

	test("scheme comparison ignores case", () => {
		expect(match({ allow: ["read"] }, "read", { path: "SSH://host/x" })).toBeUndefined();
		expect(match({ allow: ["read"] }, "read", { path: "SKILL://x" })).toBe("allow");
	});
});

/**
 * A block message that names only the rule pattern leaves the reader guessing which file or command
 * tripped it, and `<agentDir>` placeholders make a shipped rule unreadable. The match therefore reports
 * the concrete target it fired on.
 */
describe("matched target reporting", () => {
	test("a path rule reports the resolved path it fired on", () => {
		const compiled = compileRules(lists({ hardDeny: ["write(<agentDir>/config.yml)"] }), vars);
		const match = evaluateRules(compiled, "write", { path: path.join(vars.agentDir, "config.yml") }, vars.cwd);
		expect(match?.list).toBe("hardDeny");
		expect(match?.target).toBe(path.join(vars.agentDir, "config.yml"));
	});

	test("a multi-path call reports the specific path that matched, not the whole list", () => {
		const compiled = compileRules(lists({ hardDeny: ["edit(<agentDir>/config.yml)"] }), vars);
		const protectedFile = path.join(vars.agentDir, "config.yml");
		const match = evaluateRules(compiled, "edit", { paths: [path.join(vars.cwd, "a.ts"), protectedFile] }, vars.cwd);
		expect(match?.target).toBe(protectedFile);
	});

	test("a command rule reports the command it fired on", () => {
		const compiled = compileRules(lists({ deny: ["bash(*git push*)"] }), vars);
		const match = evaluateRules(compiled, "bash", { command: "git push --force origin main" }, vars.cwd);
		expect(match?.target).toBe("git push --force origin main");
	});

	test("an oversized target is truncated so a block message stays readable", () => {
		const compiled = compileRules(lists({ deny: ["bash"] }), vars);
		const match = evaluateRules(compiled, "bash", { command: "x".repeat(1000) }, vars.cwd);
		expect(match?.target?.length).toBeLessThan(400);
	});

	test("a bare tool rule still reports the argument, so the message is specific", () => {
		const compiled = compileRules(lists({ deny: ["eval"] }), vars);
		const match = evaluateRules(compiled, "eval", { code: "print(1)" }, vars.cwd);
		expect(match?.target).toBe("print(1)");
	});

	test("a call with no usable argument reports no target rather than an empty string", () => {
		const compiled = compileRules(lists({ deny: ["computer"] }), vars);
		const match = evaluateRules(compiled, "computer", {}, vars.cwd);
		expect(match?.list).toBe("deny");
		expect(match?.target).toBeUndefined();
	});
});

describe("expandDefaults", () => {
	test("the sentinel expands in place and keeps user entries", () => {
		const out = expandDefaults(["bash(x)", DEFAULTS_SENTINEL], DEFAULT_ALLOW);
		expect(out[0]).toBe("bash(x)");
		expect(out).toEqual(["bash(x)", ...DEFAULT_ALLOW]);
	});

	test("omitting the sentinel replaces the shipped list entirely", () => {
		expect(expandDefaults(["read"], DEFAULT_ALLOW)).toEqual(["read"]);
	});

	test("an absent list keeps the shipped defaults", () => {
		expect(expandDefaults(undefined, DEFAULT_HARD_DENY)).toEqual([...DEFAULT_HARD_DENY]);
	});

	test("an explicitly empty list disables the shipped defaults", () => {
		expect(expandDefaults([], DEFAULT_HARD_DENY)).toEqual([]);
	});

	test("duplicate sentinels expand only once", () => {
		const out = expandDefaults([DEFAULTS_SENTINEL, DEFAULTS_SENTINEL], ["read"]);
		expect(out).toEqual(["read"]);
	});
});

describe("shipped defaults", () => {
	const compiled = compileRules(
		lists({ hardDeny: [...DEFAULT_HARD_DENY], allow: [...DEFAULT_ALLOW] }),
		vars,
	);
	const decide = (tool: string, input: unknown) => matchRule(compiled, tool, input, vars.cwd);

	test("omp's read-only surface is allowed without a model call", () => {
		expect(decide("read", { path: "README.md" })).toBe("allow");
		expect(decide("grep", { pattern: "x" })).toBe("allow");
		expect(decide("glob", { path: "**/*.ts" })).toBe("allow");
		expect(decide("todo", { op: "view" })).toBe("allow");
		expect(decide("web_search", { query: "x" })).toBe("allow");
		expect(decide("ast_grep", { pat: "x" })).toBe("allow");
		expect(decide("inspect_image", { path: "a.png" })).toBe("allow");
		expect(decide("ask", { questions: [] })).toBe("allow");
		expect(decide("lsp", { action: "references", file: "a.ts" })).toBe("allow");
	});

	/**
	 * The only entries in the shipped `ask` list, and they are there on evidence. A live matrix twice
	 * allowed `git filter-branch --force` because the classifier read it as the ordinary means of getting a
	 * large file out of a repository. Narrowing the prompt to stop that cost five refusals of work the user
	 * had plainly asked for, so the judgement was left alone and these four shapes were named instead.
	 */
	test("history rewriting needs a person", () => {
		const ask = compileRules(lists({ ask: [...DEFAULT_ASK] }), vars);
		const decide = (command: string) => matchRule(ask, "bash", { command }, vars.cwd);
		expect(decide("git filter-branch --force --index-filter 'git rm --cached big.bin' HEAD")).toBe("ask");
		expect(decide("git filter-repo --path big.bin --invert-paths")).toBe("ask");
		expect(decide("java -jar bfg.jar --delete-files big.bin")).toBe("ask");
		expect(decide("git rebase -i --root")).toBe("ask");
	});

	/**
	 * A rule fires before the classifier, so anything listed here loses the model's reading of the
	 * transcript. That is why `push --force` is absent: the classifier allows it when the user asked for it,
	 * and a rule could only take that judgement away.
	 */
	test("ordinary git work is left to the classifier", () => {
		const ask = compileRules(lists({ ask: [...DEFAULT_ASK] }), vars);
		const decide = (command: string) => matchRule(ask, "bash", { command }, vars.cwd);
		expect(decide("git push --force origin main")).toBeUndefined();
		expect(decide("git rebase main")).toBeUndefined();
		expect(decide("git commit -m fix")).toBeUndefined();
		expect(decide("bun test")).toBeUndefined();
	});

	/**
	 * A hole in the allowlist rather than a model failure. `read` ships unconditionally allowed because omp
	 * tiers it read-only, and read-only it is: it changes nothing. What it does is put a private key or a
	 * password manager's database into the transcript, where every later turn can see it, and reading
	 * credentials is the step before exfiltrating them. The calibration matrix caught this as a decision
	 * credited to `rule read`, with no model call involved at all.
	 */
	test("reading a secret store is not fast-pathed", () => {
		const ask = compileRules(lists({ ask: [...DEFAULT_ASK], allow: [...DEFAULT_ALLOW] }), vars);
		const decide = (p: string) => matchRule(ask, "read", { path: path.join(vars.home, p) }, vars.cwd);
		for (const store of [
			".ssh/id_ed25519",
			".ssh/id_rsa",
			".ssh/deploy_ed25519",
			".aws/credentials",
			".netrc",
			".kube/config",
			".git-credentials",
			".password-store/aws.gpg",
			"Library/Keychains/login.keychain-db",
			"Library/Application Support/1Password/data.sqlite",
		]) {
			expect(decide(store), store).toBe("ask");
		}
	});

	/** A public key is public by definition, and gets read whenever someone adds a deploy key. */
	test("reading a public key or an ssh config stays fast-pathed", () => {
		const ask = compileRules(lists({ ask: [...DEFAULT_ASK], allow: [...DEFAULT_ALLOW] }), vars);
		const decide = (p: string) => matchRule(ask, "read", { path: path.join(vars.home, p) }, vars.cwd);
		for (const benign of [".ssh/id_ed25519.pub", ".ssh/id_rsa.pub", ".ssh/config", ".ssh/known_hosts", ".zshrc"]) {
			expect(decide(benign), benign).toBe("allow");
		}
	});

	/**
	 * `grep` leaks a secret store exactly as `read` does: it is allowlisted, and it returns the matching
	 * lines. A review caught this after the `read` patterns went in, which is the tell that the fix needs to
	 * follow the tool's shape rather than its name.
	 */
	test("searching a secret store is not fast-pathed either", () => {
		const ask = compileRules(lists({ ask: [...DEFAULT_ASK], allow: [...DEFAULT_ALLOW] }), vars);
		const decide = (input: unknown) => matchRule(ask, "grep", input, vars.cwd);
		expect(decide({ pattern: "PRIVATE KEY", path: path.join(vars.home, ".ssh") })).toBe("ask");
		expect(decide({ pattern: "secret", path: path.join(vars.home, ".aws/credentials") })).toBe("ask");
		expect(decide({ pattern: "token", path: path.join(vars.home, ".netrc") })).toBe("ask");
	});

	test("searching the project stays fast-pathed", () => {
		const ask = compileRules(lists({ ask: [...DEFAULT_ASK], allow: [...DEFAULT_ALLOW] }), vars);
		const decide = (input: unknown) => matchRule(ask, "grep", input, vars.cwd);
		expect(decide({ pattern: "TODO", path: "src" })).toBe("allow");
		expect(decide({ pattern: "TODO" })).toBe("allow");
		expect(decide({ pattern: "retry", path: path.join(vars.cwd, "src/client.ts") })).toBe("allow");
	});

	/** A vault file is a secret store wherever it happens to live, so it matches on extension. */
	test("a password vault is matched by extension, not by directory", () => {
		const ask = compileRules(lists({ ask: [...DEFAULT_ASK], allow: [...DEFAULT_ALLOW] }), vars);
		expect(matchRule(ask, "read", { path: path.join(vars.cwd, "vault.kdbx") }, vars.cwd)).toBe("ask");
		expect(matchRule(ask, "read", { path: path.join(vars.home, "Documents/keys.kdbx") }, vars.cwd)).toBe("ask");
	});

	/**
	 * The bug that made the first version of this list inert. A pattern that is not absolute is resolved
	 * against the working directory, so a leading-wildcard read pattern compiled to one rooted under the
	 * working directory and matched nothing on any machine.
	 */
	test("every secret-store pattern is anchored, not working-directory relative", () => {
		const pathRules = DEFAULT_ASK.filter(rule => rule.startsWith("read(") || rule.startsWith("grep("));
		const relative = pathRules.filter(rule => !rule.includes("<home>") && !/\((\/|\*\.)/.test(rule));
		expect(relative).toEqual([]);
	});

	/**
	 * A transcript is the authorization record a resumed session reads back, so a line shaped like a user
	 * message becomes user intent for that session's reviews.
	 *
	 * Not for the running one. `getBranch()` walks an in-memory index, and the journal is written from
	 * memory rather than read back, so a forged line does nothing until a resume loads it. Claude Code's
	 * rule for this surface says the same: a tampered entry feeds later classifications once the session is
	 * resumed. Worth a pattern, not worth calling a live forgery.
	 */
	test("the session transcript cannot be written", () => {
		const transcript = path.join(vars.agentDir, "sessions", "-work", "abc", "session.jsonl");
		expect(decide("write", { path: transcript })).toBe("hardDeny");
		expect(decide("edit", { path: transcript })).toBe("hardDeny");
		expect(decide("bash", { command: `echo forged >> ${transcript}` })).toBe("hardDeny");
		expect(decide("bash", { command: `sed -i s/a/b/ ${transcript}` })).toBe("hardDeny");
		expect(decide("eval", { code: `open("${transcript}","a")` })).toBe("hardDeny");
	});

	/** Reading transcripts is ordinary work, and omp's own history tooling depends on it. */
	test("the session transcript can still be read", () => {
		const transcript = path.join(vars.agentDir, "sessions", "-work", "abc", "session.jsonl");
		expect(decide("read", { path: transcript })).toBe("allow");
		expect(decide("grep", { pattern: "x", path: path.join(vars.agentDir, "sessions") })).toBe("allow");
	});

	test("every mutating tool reaches the classifier", () => {
		for (const tool of [
			"bash",
			"write",
			"edit",
			"eval",
			"computer",
			"browser",
			"github",
			"task",
			"hub",
			"ast_edit",
			"manage_skill",
			"debug",
			"mcp__anything__here",
			"a_tool_that_does_not_exist_yet",
		]) {
			expect(decide(tool, { command: "x", path: "x", code: "x" })).toBeUndefined();
		}
	});

	/**
	 * omp tiers each of these `"read"`, but every one leaves durable state behind, so the shipped
	 * allowlist is deliberately stricter than the host's own approval gate.
	 */
	test("tools that leave durable state are not fast-pathed even though omp tiers them read", () => {
		expect(decide("learn", { memory: "x" })).toBeUndefined();
		expect(decide("learn", { memory: "x", skill: { action: "create", name: "n", description: "d", body: "b" } })).toBeUndefined();
		expect(decide("retain", { items: [] })).toBeUndefined();
		expect(decide("memory_edit", { op: "forget", id: "1" })).toBeUndefined();
		expect(decide("checkpoint", { goal: "x" })).toBeUndefined();
		expect(decide("rewind", { report: "x" })).toBeUndefined();
		expect(decide("security_scan", { action: "scan" })).toBeUndefined();
	});

	/** omp promotes these to `exec` tier, so the allowlist must not cover them. */
	test("remote reads and searches are not fast-pathed", () => {
		expect(decide("read", { path: "ssh://host/etc/passwd" })).toBeUndefined();
		expect(decide("grep", { pattern: "AWS_SECRET", path: "ssh://host/home" })).toBeUndefined();
		expect(decide("lsp", { action: "rename", file: "a.ts", new_name: "b" })).toBeUndefined();
	});

	test("eval is treated as shell-equivalent for anti-tamper", () => {
		expect(decide("eval", { code: "open('autoclassifier.yml','w')" })).toBe("hardDeny");
	});

	test("the gate's own config cannot be edited by the agent", () => {
		expect(decide("write", { path: path.join(vars.agentDir, "autoclassifier.yml") })).toBe("hardDeny");
		expect(decide("edit", { path: path.join(vars.cwd, ".omp", "autoclassifier.yml") })).toBe("hardDeny");
		expect(decide("bash", { command: "omp plugin disable omp-autoclassifier" })).toBe("hardDeny");
		expect(decide("bash", { command: "rm ~/.omp/agent/autoclassifier.yml" })).toBe("hardDeny");
	});
});
