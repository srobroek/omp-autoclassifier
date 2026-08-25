/**
 * Parameter sweep for the classifier: models against provider settings. Dev-only; NOT shipped.
 *
 *   omp --no-extensions -e tools/sweep-extension.ts \
 *       -p "Call the ac_param_sweep tool with out set to /tmp/ac-sweep.txt"
 *
 * Exists because every guess about these settings has been wrong so far. `disableReasoning` sat on the
 * wrong options type and never reached a provider; once it did, it doubled one model's latency instead of
 * cutting it. Neither reference implementation disables reasoning at all: Codex reviews at
 * `reasoning_level: medium` with `reasoning_summary: none` and `verbosity: low`, and Claude Code instruments
 * `classifierCacheReadInputTokens`, so it caches the prompt rather than trimming the thinking.
 *
 * Latency is the measurement that matters here, so the case set is small and fixed, and every arm runs the
 * same cases in the same order.
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs/promises";
import { classify, type ClassifierDeps, type CompletionFn, type CompletionOptions } from "../src/classifier";
import { DEFAULT_ENVIRONMENT, EVIDENCE_DEFAULTS } from "../src/defaults";
import { cases } from "./calibrate";

/** Settings to compare. `undefined` in a field means "leave the module default alone". */
const VARIANTS: { name: string; options: Partial<CompletionOptions> }[] = [
	{ name: "reasoning off (was default)", options: {} },
	{ name: "reasoning low", options: { disableReasoning: false, reasoning: "low" } },
	{ name: "reasoning low + verbosity low", options: { disableReasoning: false, reasoning: "low", textVerbosity: "low" } },
	// What Codex ships for its reviewer, kept as the outside reference point.
	{ name: "codex shape (med+none+low)", options: { disableReasoning: false, reasoning: "medium", hideThinkingSummary: true, textVerbosity: "low" } },
];

// Dropped after the first sweep, with reasons, so nobody re-runs them hoping:
//   reasoning minimal          - 8 of 8 calls errored on both models. Not a fast arm, a broken one.
//   prompt cache short / long  - no median gain on either model and the worst p95 of the field, despite
//                                Claude Code instrumenting cache tokens on its own classifier. Whatever
//                                their gain depends on, this harness does not reproduce it.
//   verbosity / summary alone  - inside the noise on both models.

/** A fixed spread: some the filter should clear, some it must escalate. */
const SWEEP_CASE_NAMES = [
	"run-project-linter-unnamed",
	"organise-documents-locally",
	"install-a-cron-job",
	"log-credentials",
	"disable-tls-verification",
	"delete-the-precommit-hook",
	"world-writable-tree",
	"eval-user-input",
];

export default function sweepExtension(pi: ExtensionAPI): void {
	const z = pi.zod;
	let session: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		session = ctx;
	});

	pi.registerTool({
		name: "ac_param_sweep",
		label: "Sweep classifier settings",
		description:
			"Runs a fixed case set against each model under several provider settings and reports latency and verdicts. " +
			"Development tool for choosing reasoning, verbosity, and cache settings. Changes no configuration.",
		parameters: z.object({
			models: z.array(z.string()).optional().describe("Model specs; defaults to the four measured candidates"),
			out: z.string().optional().describe("Also write the report to this path"),
			repeats: z.number().optional().describe("Times each case is asked per arm; default 2"),
		}),

		async execute(_toolCallId, params) {
			const ctx = session;
			if (ctx === undefined) {
				return { content: [{ type: "text", text: "Sweep context is not ready yet." }], isError: true };
			}
			const specs =
				Array.isArray(params.models) && params.models.length > 0
					? (params.models as string[])
					: [
							"bedrock-mantle/openai.gpt-5.6-luna",
							"bedrock-mantle/openai.gpt-5.6-terra",
							"amazon-bedrock/global.anthropic.claude-haiku-4-5",
							"amazon-bedrock/global.anthropic.claude-sonnet-5",
						];
			const repeats = typeof params.repeats === "number" ? params.repeats : 2;
			const selected = cases.filter(kase => SWEEP_CASE_NAMES.includes(kase.name));
			if (selected.length === 0) {
				return { content: [{ type: "text", text: "No sweep case matched; the case names have drifted." }], isError: true };
			}

			const lines: string[] = [`# Classifier settings sweep`, "", `${selected.length} cases, ${repeats} repeat(s) each.`, ""];
			for (const spec of specs) {
				lines.push(`## ${spec}`, "");
				lines.push("| settings | median | p95 | slowest | wrong | failures |");
				lines.push("| --- | --- | --- | --- | --- | --- |");
				for (const variant of VARIANTS) {
					const deps: ClassifierDeps = {
						configuredRole: () => spec,
						resolveModel: () => ctx.models.resolve(spec),
						resolveAuth: async model => ctx.modelRegistry.getApiKeyAndHeaders(model as Model),
						complete: completeSimple as unknown as CompletionFn,
					};
					const timings: number[] = [];
					let wrong = 0;
					let failures = 0;
					for (const kase of selected) {
						for (let attempt = 0; attempt < repeats; attempt++) {
							const started = Date.now();
							const verdict = await classify(
								deps,
								{
									branch: kase.transcript.map(turn => ({
										type: "message" as const,
										message: {
											role: turn.role === "tool" ? ("toolResult" as const) : turn.role,
											content: turn.text,
											toolName: "read",
										},
									})),
									cwd: "/work/project",
									toolName: kase.toolName,
									input: kase.input,
									environment: DEFAULT_ENVIRONMENT,
									limits: EVIDENCE_DEFAULTS,
									includeToolResults: false,
									refusals: kase.refused ?? [],
								},
								{ stage1TimeoutMs: 20_000, stage2TimeoutMs: 40_000, providerOptions: variant.options },
							);
							timings.push(Date.now() - started);
							if (verdict.kind === "failure" || verdict.kind === "unconfigured") failures++;
							else if (verdict.kind === "ask" ? kase.want !== "deny" : verdict.kind !== kase.want) wrong++;
						}
					}
					const sorted = [...timings].sort((a, b) => a - b);
					const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
					lines.push(
						`| ${variant.name} | ${at(0.5)}ms | ${at(0.95)}ms | ${sorted[sorted.length - 1] ?? 0}ms | ${wrong} | ${failures} |`,
					);
				}
				lines.push("");
			}

			const text = lines.join("\n");
			if (typeof params.out === "string" && params.out.length > 0) await fs.writeFile(params.out, `${text}\n`);
			return { content: [{ type: "text", text }], details: { models: specs.length, variants: VARIANTS.length } };
		},
	});
}
