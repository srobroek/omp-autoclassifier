/**
 * omp extension entry point.
 *
 * This is the only file that touches omp's API surface, so every host-specific quirk is handled here
 * and nothing below it needs to know about the harness:
 *
 *   - `tool_call` handlers run before the approval gate in every approval mode, which is what makes a
 *     gate possible at all under `tools.approvalMode: yolo`.
 *   - omp already fails closed for us: `emitToolCall` bounds each handler by
 *     `extensionHandlers.toolCallTimeoutMs` (30s) and turns a timeout, throw, or abort into
 *     `{ block: true }`. Our own timeouts sit well inside that budget so we can attach a useful reason.
 *   - `complete` is imported lazily from `@oh-my-pi/pi-ai`. The host's specifier shim resolves the
 *     `@oh-my-pi/*` scope to its own bundled copy, so this must not be a static import in a module the
 *     unit tests load outside omp.
 *   - `ctx.modelRegistry.complete` and `.getProvider` do not exist on omp's registry. Calling them is
 *     the exact bug that makes `@czottmann/pi-automode` block every tool call on this host.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { VerdictCache } from "./cache";
import { classify, CLASSIFIER_ROLE, type ClassifierDeps, type CompletionFn } from "./classifier";
import { runCommand, subcommandNames, type SessionOverride } from "./command";
import { ConfigStore, type ConfigPaths } from "./config";
import { CALIBRATE_ENV_VAR, PLUGIN_NAME, STATE_ENTRY_TYPE } from "./defaults";
import { decide, type DecisionRecord, type EscalationChoice, type GateDeps } from "./gate";
import { DecisionLog } from "./log";
import { registerSession, reportChildDenial, requestParentEscalation, unregisterSession } from "./registry";
import { GateState } from "./state";
import { report, runCalibration } from "./calibrate";
import { describeCandidate, rankCandidates, SKIP_LABEL, type WizardModel } from "./wizard";

/** Resolved once per process: the host's own `complete`, via the scope shim. */
let completion: Promise<CompletionFn> | undefined;

function loadCompletion(): Promise<CompletionFn> {
	completion ??= import("@oh-my-pi/pi-ai").then(module => module.complete as unknown as CompletionFn);
	return completion;
}

/**
 * How long a subagent waits for a human at the parent's prompt.
 *
 * omp bounds each `tool_call` handler by `extensionHandlers.toolCallTimeoutMs` (30s by default) and turns
 * an overrun into a block with a timeout reason. Staying well inside that budget means an unanswered
 * prompt produces a real decision instead of a confusing timeout.
 */
const PARENT_PROMPT_TIMEOUT_MS = 15_000;

/** The escalation dialog, shared by a session deciding for itself and one deciding for a subagent. */
async function askUser(ctx: ExtensionContext, toolName: string, reason: string): Promise<EscalationChoice> {
	const allowOnce = "Allow once";
	const allowSession = "Allow for this session";
	const choice = await ctx.ui.select(`autoclassifier: ${reason}`, [
		{ label: allowOnce, description: `Run this ${toolName} call now.` },
		{ label: "Deny", description: "Block the call and tell the agent why." },
		{ label: allowSession, description: "Stop asking about this exact call for the rest of the session." },
	]);
	if (choice === allowOnce) return "once";
	if (choice === allowSession) return "session";
	// Cancelled, timed out, or unavailable: never read as consent.
	return "deny";
}

function configPaths(agentDir: string, pluginsRoot: string, cwd: string): ConfigPaths {
	return {
		agentDir,
		cwd,
		pluginsRoot,
		lockfile: `${pluginsRoot}/omp-plugins.lock.json`,
		projectOverrides: `${cwd}/.omp/plugin-overrides.json`,
		userYaml: `${agentDir}/autoclassifier.yml`,
		projectYaml: `${cwd}/.omp/autoclassifier.yml`,
	};
}

export default function autoclassifier(pi: ExtensionAPI): void {
	const host = pi.pi;
	const agentDir = host.getAgentDir();
	// `getPluginsDir` lives in pi-utils, which the shim also resolves to the host copy; the join keeps
	// this working if that export ever moves.
	const pluginsRoot = `${agentDir.replace(/\/agent\/?$/, "")}/plugins`;

	pi.setLabel("Auto-classifier");

	let store: ConfigStore | undefined;
	let state: GateState | undefined;
	let cache: VerdictCache | undefined;
	let log: DecisionLog | undefined;
	let sessionEnabled: boolean | undefined;
	let registeredSessionId: string | undefined;

	/** Built lazily: `ctx.cwd` is only known once a session exists. */
	function ensure(ctx: ExtensionContext): {
		store: ConfigStore;
		state: GateState;
		cache: VerdictCache;
		log: DecisionLog;
	} {
		store ??= new ConfigStore(configPaths(agentDir, pluginsRoot, ctx.cwd));
		const cfg = store.get();
		state ??= new GateState(cfg);
		cache ??= new VerdictCache(cfg.cacheSize);
		log ??= new DecisionLog(cfg.logPath);
		return { store, state, cache, log };
	}

	function classifierRole(): string | undefined {
		try {
			return host.settings.getModelRole("classifier");
		} catch {
			return undefined;
		}
	}

	function approvalMode(): string {
		try {
			const mode = host.settings.get("tools.approvalMode");
			return typeof mode === "string" ? mode : "yolo";
		} catch {
			// Advisory only: subagents force their own `yolo`, so this can disagree with reality. It never
			// gates the anti-tamper layer.
			return "yolo";
		}
	}

	const sessionOverride: SessionOverride = {
		get: () => sessionEnabled,
		set: value => {
			sessionEnabled = value;
		},
	};

	async function runWizard(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("autoclassifier setup needs an interactive session.", "warning");
			return;
		}
		const models = ctx.models.list();
		if (models.length === 0) {
			ctx.ui.notify("autoclassifier: no authenticated models are available to act as a classifier.", "error");
			return;
		}
		// `getModelRoles` returns a dictionary whose values may be undefined; the wizard only cares about
		// roles that actually name a model.
		const roles: Record<string, string> = {};
		try {
			for (const [role, value] of Object.entries(host.settings.getModelRoles())) {
				if (typeof value === "string" && value.length > 0) roles[role] = value;
			}
		} catch {
			// A settings store that cannot answer just forfeits the "already trusted for cheap work" hint.
		}
		const ranked = rankCandidates(models as WizardModel[], {
			roles,
			current: ctx.models.current() as WizardModel | undefined,
			family: candidate => ctx.models.family(candidate as Model),
		});
		const shortlist = ranked.slice(0, 5);
		const choice = await ctx.ui.select(
			"Which model should classify tool calls? A small, cheap model is the right pick.",
			[
				...shortlist.map(candidate => ({
					label: describeCandidate(candidate),
					description: candidate.name,
				})),
				{ label: SKIP_LABEL, description: "No tool call will be classified until a model is chosen." },
			],
		);
		if (choice === undefined || choice === SKIP_LABEL) {
			ctx.ui.notify(
				"autoclassifier stays inactive: no classifier model was chosen. Run `/autoclassifier setup` when you want it on.",
				"warning",
			);
			return;
		}
		try {
			host.settings.setModelRole("classifier", choice);
			await host.settings.flush();
			ctx.ui.notify(`autoclassifier is armed, classifying with ${choice}.`, "info");
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`autoclassifier could not save the model role (${reason}). Run this yourself:\n  omp config set modelRoles.classifier ${choice}`,
				"error",
			);
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI || state === undefined || store === undefined) return;
		const snapshot = state.snapshot();
		const theme = ctx.ui.theme;
		if (sessionEnabled === false || !store.get().enabled) {
			ctx.ui.setStatus(PLUGIN_NAME, theme.fg("muted", "⚪ gate off"));
			return;
		}
		if (classifierRole() === undefined) {
			ctx.ui.setStatus(PLUGIN_NAME, theme.fg("warning", "⚠ gate unconfigured"));
			return;
		}
		if (state.paused) {
			ctx.ui.setStatus(PLUGIN_NAME, theme.fg("warning", `⏸ gate paused ${snapshot.denied}✗`));
			return;
		}
		if (snapshot.degradedReason !== undefined) {
			ctx.ui.setStatus(PLUGIN_NAME, theme.fg("error", "⛔ gate degraded"));
			return;
		}
		ctx.ui.setStatus(PLUGIN_NAME, theme.fg("success", `🛡 ${snapshot.allowed}✓ ${snapshot.denied}✗`));
	}

	function restoreState(ctx: ExtensionContext): void {
		const { state: gateState } = ensure(ctx);
		for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
			if (entry.type !== "custom") continue;
			const custom = entry as { customType?: string; data?: unknown };
			if (custom.customType !== STATE_ENTRY_TYPE) continue;
			gateState.restore(custom.data);
			break;
		}
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		const { cache: verdicts } = ensure(ctx);
		verdicts.clear();
		restoreState(ctx);
		registeredSessionId = ctx.sessionManager.getSessionId();
		registerSession(registeredSessionId, {
			hasUI: ctx.hasUI,
			notify: message => ctx.ui.notify(message, "warning"),
			// Lets a headless subagent borrow this session's dialog.
			escalate: ctx.hasUI ? (toolName, reason) => askUser(ctx, toolName, reason) : undefined,
		});
		if (ctx.hasUI && classifierRole() === undefined) {
			ctx.ui.notify(
				"autoclassifier is installed but inactive: run `/autoclassifier setup` to choose a classifier model.",
				"warning",
			);
		}

		// Headless calibration hook. A slash command cannot be reached from a print-mode or CI session,
		// and an agent cannot invoke one on its own, so tuning the classifier needs a trigger that works
		// without a terminal. Writes the report to a file and leaves it there.
		const calibrateTo = process.env[CALIBRATE_ENV_VAR];
		if (calibrateTo !== undefined && calibrateTo.length > 0) {
			const destination = calibrateTo === "1" ? path.join(agentDir, "autoclassifier", "calibration.txt") : calibrateTo;
			try {
				const results = await runCalibration({
					configuredRole: classifierRole,
					resolveModel: spec => ctx.models.resolve(spec),
					resolveAuth: async model => ctx.modelRegistry.getApiKeyAndHeaders(model as Model),
					complete: await loadCompletion(),
				});
				await fs.mkdir(path.dirname(destination), { recursive: true });
				await fs.writeFile(destination, `${report(results)}\n`);
				ctx.ui.notify(`autoclassifier calibration written to ${destination}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`autoclassifier calibration failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		}
	});

	pi.on("session_shutdown", () => {
		if (registeredSessionId !== undefined) unregisterSession(registeredSessionId);
		registeredSessionId = undefined;
	});

	pi.on("session_branch", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));

	pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
		const { store: config, state: gateState, cache: verdicts, log: audit } = ensure(ctx);

		const deps: GateDeps = {
			config: () => {
				const cfg = config.get();
				// A session switch overrides the configured value without rewriting anyone's settings.
				return sessionEnabled === undefined ? cfg : { ...cfg, enabled: sessionEnabled };
			},
			state: gateState,
			cache: verdicts,
			cwd: ctx.cwd,
			branch: () => ctx.sessionManager.getBranch(),
			env: name => process.env[name],
			classify: async (request, timeouts) => {
				const classifierDeps: ClassifierDeps = {
					configuredRole: classifierRole,
					resolveModel: spec => ctx.models.resolve(spec),
					resolveAuth: async model => ctx.modelRegistry.getApiKeyAndHeaders(model as Model),
					complete: await loadCompletion(),
				};
				return classify(classifierDeps, request, timeouts);
			},
			escalate: (toolName, reason) => askUser(ctx, toolName, reason),
			escalateViaParent: (toolName, reason) =>
				requestParentEscalation(ctx.sessionManager.getSessionId(), toolName, reason, PARENT_PROMPT_TIMEOUT_MS),
			notify: (message, level) => ctx.ui.notify(message, level),
			reportChildDenial: (toolName, reason) => {
				const id = ctx.sessionManager.getSessionId();
				reportChildDenial(id, toolName, reason);
			},
			log: (record: DecisionRecord) => audit.append(record),
		};

		const decision = await decide(deps, {
			toolName: event.toolName,
			input: event.input,
			hasUI: ctx.hasUI,
			approvalMode: approvalMode(),
		});

		pi.appendEntry(STATE_ENTRY_TYPE, gateState.snapshot());
		updateStatus(ctx);

		if (decision.action === "block") return { block: true, reason: decision.reason };
		return undefined;
	});

	pi.registerCommand("autoclassifier", {
		description: "Inspect and control the pre-execution tool-call classifier",
		getArgumentCompletions: prefix => {
			const matches = subcommandNames.filter(name => name.startsWith(prefix.trim().toLowerCase()));
			return matches.length === 0 ? null : matches.map(name => ({ value: name, label: name }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const { store: config, state: gateState, cache: verdicts, log: audit } = ensure(ctx);
			await runCommand(
				{
					config: () => {
						const cfg = config.get();
						return sessionEnabled === undefined ? cfg : { ...cfg, enabled: sessionEnabled };
					},
					state: gateState,
					classifierRole,
					tail: (count, filter) => audit.tail(count, filter),
					logPath: audit.path,
					logDisabledReason: audit.disabledReason,
					reload: () => {
						config.reload();
						verdicts.clear();
					},
					runSetup: () => runWizard(ctx),
					runCalibration: async () => {
						const results = await runCalibration({
							configuredRole: classifierRole,
							resolveModel: spec => ctx.models.resolve(spec),
							resolveAuth: async model => ctx.modelRegistry.getApiKeyAndHeaders(model as Model),
							complete: await loadCompletion(),
						});
						return report(results);
					},
					print: text => ctx.ui.notify(text, "info"),
					sessionOverride,
				},
				args,
			);
			updateStatus(ctx);
		},
	});
}

export { CLASSIFIER_ROLE };
