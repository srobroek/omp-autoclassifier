/**
 * Latency and accuracy for candidate classifier models, on the same cases. Dev-only; NOT shipped.
 *
 *   omp --no-extensions -e tools/bakeoff-extension.ts \
 *       -p "Call the ac_model_bakeoff tool with models set to [...] and out to /tmp/ac-bakeoff.txt"
 *
 * Answers two questions a single-model run cannot: where the time goes, one round trip or two, and
 * whether a stronger model actually costs latency. Each arm receives its model spec directly, so the run
 * never touches `modelRoles.classifier` and cannot leave the shipped gate pointed somewhere else.
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs/promises";
import type { CompletionFn } from "../src/classifier";
import { cases, report, runCalibration } from "./calibrate";

export default function bakeoffExtension(pi: ExtensionAPI): void {
	const z = pi.zod;
	// A tool's execute receives an AgentToolContext, not an ExtensionContext, so the model facade is
	// captured here where it is handed out.
	let session: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		session = ctx;
	});

	pi.registerTool({
		name: "ac_model_bakeoff",
		label: "Compare classifier models",
		description:
			"Runs the same calibration cases against several classifier models and reports accuracy and latency for each. " +
			"Development tool for choosing the classifier model. Reads no settings and changes none.",
		parameters: z.object({
			models: z.array(z.string()).describe("Model specs to compare, e.g. bedrock-mantle/openai.gpt-5.6-luna"),
			filter: z.string().optional().describe("Only run cases whose name contains this substring"),
			out: z.string().optional().describe("Also write the report to this path"),
			concurrency: z.number().optional().describe("Parallel cases; default 8"),
			repeats: z.number().optional().describe("Times each case is asked; default 1, since this measures latency"),
		}),

		async execute(_toolCallId, params) {
			const ctx = session;
			if (ctx === undefined) {
				return { content: [{ type: "text", text: "Bakeoff context is not ready yet." }], isError: true };
			}
			const specs = Array.isArray(params.models) ? (params.models as string[]) : [];
			if (specs.length === 0) {
				return { content: [{ type: "text", text: "Pass at least one model spec." }], isError: true };
			}
			const filter = typeof params.filter === "string" ? params.filter : undefined;
			const selected = filter === undefined ? cases : cases.filter(kase => kase.name.includes(filter));
			if (selected.length === 0) {
				return { content: [{ type: "text", text: `No calibration case matches "${filter}".` }], isError: true };
			}

			const sections: string[] = [];
			for (const spec of specs) {
				const started = Date.now();
				try {
					const results = await runCalibration(
						{
							// `classify` resolves the alias `@classifier`, not this value, so `configuredRole` alone
							// cannot select a model. It only has to be non-empty, or the gate reports unconfigured.
							configuredRole: () => spec,
							// This is the seam that picks the model: the alias arriving here is discarded and the
							// arm's own spec resolved instead. Swapping `modelRoles.classifier` per arm was the first
							// attempt and was worse twice over — it repointed the shipped gate for the length of the
							// run, and the write was not visible to the resolver in the same process.
							resolveModel: () => ctx.models.resolve(spec),
							resolveAuth: async model => ctx.modelRegistry.getApiKeyAndHeaders(model as Model),
							complete: completeSimple as unknown as CompletionFn,
						},
						selected,
						typeof params.concurrency === "number" ? params.concurrency : 8,
						typeof params.repeats === "number" ? params.repeats : 1,
					);
					const wall = Math.round((Date.now() - started) / 1000);
					sections.push(`## ${spec}  (wall ${wall}s)\n\n${report(results)}`);
				} catch (error) {
					sections.push(`## ${spec}\n\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			const text = `# Classifier model bakeoff\n\n${selected.length} case(s) per model.\n\n${sections.join("\n\n")}`;
			if (typeof params.out === "string" && params.out.length > 0) await fs.writeFile(params.out, `${text}\n`);
			return { content: [{ type: "text", text }], details: { models: specs.length, cases: selected.length } };
		},
	});
}
