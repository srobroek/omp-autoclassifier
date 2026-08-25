/**
 * Where does a verdict's time actually go? Dev-only; NOT shipped.
 *
 *   omp --no-extensions -e tools/latency-anatomy.ts \
 *       -p "Call the ac_latency_anatomy tool with out set to /tmp/ac-anatomy.txt"
 *
 * Every previous latency claim in this project was inferred rather than decomposed: wall-clock divided by
 * call count, then explained by analogy to a vendor's telemetry field names. This measures the two things
 * that separate the candidate causes.
 *
 * `ttft` is time to first token, so it prices the prefill: the system prompt plus evidence the provider has
 * to read before it can emit anything. `duration - ttft` prices generation: how long the model spends
 * writing. A control call with a nine-character prompt gives the floor for the same model on the same route,
 * which is the number that says whether our prompt is expensive or the provider is simply slow.
 *
 * Read it as: floor tells you the route, stage-one prefill tells you the filter prompt's cost, stage-two
 * prefill tells you the review prompt's cost, and generation tells you whether asking for a smaller verdict
 * would help.
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs/promises";
import { classify, type ClassifierDeps, type CompletionFn } from "../src/classifier";
import { DEFAULT_ENVIRONMENT, EVIDENCE_DEFAULTS } from "../src/defaults";
import { cases } from "./calibrate";

interface Sample {
	label: string;
	ttft: number | undefined;
	duration: number | undefined;
	promptChars: number;
	outTokens: number | undefined;
	/** Set when the provider refused. Without it an error reads as a very fast call with no tokens. */
	error: string | undefined;
}

/** A case the filter escalates, so both stages run and both can be priced. */
const PROBE_CASE = "install-a-cron-job";

export default function latencyAnatomy(pi: ExtensionAPI): void {
	const z = pi.zod;
	let session: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		session = ctx;
	});

	pi.registerTool({
		name: "ac_latency_anatomy",
		label: "Decompose verdict latency",
		description:
			"Prices prefill against generation for each classifier stage, with a minimal-prompt control for the same model. " +
			"Development tool. Changes no configuration.",
		parameters: z.object({
			models: z.array(z.string()).optional().describe("Model specs; defaults to the three finalists"),
			variants: z.boolean().optional().describe("Also compare output-shrinking option sets, reporting out tokens"),
			repeats: z.number().optional().describe("Times to sample each shape; default 3"),
			out: z.string().optional().describe("Also write the report to this path"),
		}),

		async execute(_toolCallId, params) {
			const ctx = session;
			if (ctx === undefined) return { content: [{ type: "text", text: "no context" }], isError: true };
			const specs =
				Array.isArray(params.models) && params.models.length > 0
					? (params.models as string[])
					: ["claude-haiku-4-5", "llama4-scout", "gpt-5.6-luna"];
			const repeats = typeof params.repeats === "number" ? params.repeats : 3;
			const kase = cases.find(entry => entry.name === PROBE_CASE);
			if (kase === undefined) {
				return { content: [{ type: "text", text: `case ${PROBE_CASE} is gone; pick another` }], isError: true };
			}

			const lines: string[] = ["# Verdict latency anatomy", "", `${repeats} sample(s) per shape.`, ""];

			for (const spec of specs) {
				const model = ctx.models.resolve(spec);
				if (model === undefined) {
					lines.push(`## ${spec}`, "", "UNRESOLVED", "");
					continue;
				}
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as Model);
				const samples: Sample[] = [];

				// Control: the smallest possible request on this route. Anything above this is our prompt.
				for (let attempt = 0; attempt < repeats; attempt++) {
					const result = (await completeSimple(
						model as never,
						{ systemPrompt: ["Answer 0."], messages: [{ role: "user", content: [{ type: "text", text: "Say 0." }] }] },
						{
							apiKey: (auth as { apiKey?: string }).apiKey,
							headers: (auth as { headers?: Record<string, string> }).headers,
							maxTokens: 16,
							disableReasoning: true,
							signal: AbortSignal.timeout(30_000),
						} as never,
					)) as { ttft?: number; duration?: number; usage?: { output?: number } };
					samples.push({
						label: "control (9-char prompt)",
						ttft: result.ttft,
						duration: result.duration,
						promptChars: 17,
						outTokens: result.usage?.output,
						error: result.errorMessage,
					});
				}

				// The real stages, priced through a shim so the prompts are exactly what ships.
				for (let attempt = 0; attempt < repeats; attempt++) {
					let stage = 0;
					const shim: CompletionFn = (async (m: unknown, context: unknown, options: unknown) => {
						stage++;
						const promptChars =
							((context as { systemPrompt?: string[] }).systemPrompt ?? []).join("").length +
							((context as { messages?: { content?: { text?: string }[] }[] }).messages ?? [])
								.flatMap(message => message.content ?? [])
								.map(block => block.text ?? "")
								.join("").length;
						const result = (await (completeSimple as never as CompletionFn)(m as never, context as never, options as never)) as {
							ttft?: number;
							duration?: number;
							usage?: { output?: number };
						errorMessage?: string;
						};
						samples.push({
							label: `stage ${stage}`,
							ttft: result.ttft,
							duration: result.duration,
							promptChars,
							outTokens: result.usage?.output,
						error: result.errorMessage,
						});
						return result as never;
					}) as CompletionFn;

					const deps: ClassifierDeps = {
						configuredRole: () => spec,
						resolveModel: () => ctx.models.resolve(spec),
						resolveAuth: async candidate => ctx.modelRegistry.getApiKeyAndHeaders(candidate as Model),
						complete: shim,
					};
					await classify(
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
						{ stage1TimeoutMs: 30_000, stage2TimeoutMs: 60_000 },
					);
				}

				// Option variants, priced by out tokens rather than by latency: the claim under test is that these
				// settings shrink what the model writes. A latency win with unchanged token counts would mean
				// something else moved.
				if (params.variants === true) {
					const VARIANTS: { name: string; options: Record<string, unknown> }[] = [
						{ name: "shipped (reasoning off)", options: {} },
						{ name: "reasoning low", options: { disableReasoning: false, reasoning: "low" } },
						{ name: "reasoning low + verbosity low", options: { disableReasoning: false, reasoning: "low", textVerbosity: "low" } },
						{ name: "reasoning medium (codex shape)", options: { disableReasoning: false, reasoning: "medium", hideThinkingSummary: true, textVerbosity: "low" } },
					];
					for (const variant of VARIANTS) {
						for (let attempt = 0; attempt < repeats; attempt++) {
							let stage = 0;
							const shim: CompletionFn = (async (m: unknown, context: unknown, options: unknown) => {
								stage++;
								const result = (await (completeSimple as never as CompletionFn)(m as never, context as never, options as never)) as {
									ttft?: number;
									duration?: number;
									usage?: { output?: number };
						errorMessage?: string;
								};
								if (stage === 2) {
									samples.push({
										label: `stage 2 ${variant.name}`,
										ttft: result.ttft,
										duration: result.duration,
										promptChars: 9913,
										outTokens: result.usage?.output,
						error: result.errorMessage,
									});
								}
								return result as never;
							}) as CompletionFn;
							await classify(
								{
									configuredRole: () => spec,
									resolveModel: () => ctx.models.resolve(spec),
									resolveAuth: async candidate => ctx.modelRegistry.getApiKeyAndHeaders(candidate as Model),
									complete: shim,
								},
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
								{ stage1TimeoutMs: 30_000, stage2TimeoutMs: 60_000, providerOptions: variant.options },
							);
						}
					}
				}

				lines.push(`## ${spec}`, "");
				lines.push("| shape | prompt chars | ttft | generate | total | out tokens |");
				lines.push("| --- | --- | --- | --- | --- | --- |");
				const labels = [...new Set(samples.map(sample => sample.label))];
				for (const label of labels) {
					const group = samples.filter(sample => sample.label === label);
					const median = (pick: (sample: Sample) => number | undefined): string => {
						const values = group.map(pick).filter((value): value is number => typeof value === "number");
						if (values.length === 0) return "n/a";
						return `${[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]}ms`;
					};
					const ttft = median(sample => sample.ttft);
					const total = median(sample => sample.duration);
					const generate = median(sample =>
						typeof sample.duration === "number" && typeof sample.ttft === "number" ? sample.duration - sample.ttft : undefined,
					);
					const chars = group[0]?.promptChars ?? 0;
					const out = group.map(sample => sample.outTokens).find(value => typeof value === "number");
					const failure = group.map(sample => sample.error).find(value => typeof value === "string");
					lines.push(`| ${label} | ${chars} | ${ttft} | ${generate} | ${total} | ${out ?? "n/a"} |`);
					if (failure !== undefined) lines.push(`| | ERROR: ${failure.slice(0, 150)} | | | | |`);
				}
				lines.push("");
			}

			const text = lines.join("\n");
			if (typeof params.out === "string" && params.out.length > 0) await fs.writeFile(params.out, `${text}\n`);
			return { content: [{ type: "text", text }], details: { models: specs.length } };
		},
	});
}
