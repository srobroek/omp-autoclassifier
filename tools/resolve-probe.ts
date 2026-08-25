/**
 * Which candidate names resolve, and to what. Dev-only throwaway.
 *
 * Run before any long sweep: a name that does not resolve fails the whole arm, and finding that out after
 * ten minutes of matrix wastes the run.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const CANDIDATES = [
	// Guard-specific, several naming variants each: a miss may be a wrong id rather than an absent model.
	"gpt-oss-safeguard-20b",
	"gpt-oss-safeguard-120b",
	"llama-guard-4-12b",
	"llama-guard-3-8b",
	"llama-guard-3-11b-vision",
	"llamaguard-4-12b",
	"meta.llama-guard-3-8b",
	"llama-guard",
	"wildguard",
	"allenai.wildguard",
	"qwen3guard",
	"qwen3-guard",
	"qwen.qwen3guard-8b",
	"llama-3.1-nemoguard-8b-content-safety",
	"llama-3.1-nemoguard-8b-topic-control",
	"llama-3.1-nemotron-safety-guard-8b-v3",
	"nemoguard",
	"gemma-4-31b-assguard",
	"shieldgemma",
	"omni-moderation",
	"omni-moderation-latest",
	// The general models the ranking needs anyway.
	"gpt-oss-120b",
	"gpt-oss-20b",
	"claude-haiku-4-5",
	"nova-micro",
	"nova-lite",
];

export default function resolveProbe(pi: ExtensionAPI): void {
	const z = pi.zod;
	let session: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		session = ctx;
	});

	pi.registerTool({
		name: "ac_resolve_probe",
		label: "Probe model resolution",
		description: "Reports which candidate classifier model names resolve, and whether credentials exist.",
		parameters: z.object({}),

		async execute() {
			const ctx = session;
			if (ctx === undefined) return { content: [{ type: "text", text: "no context" }], isError: true };
			const lines: string[] = [];
			for (const name of CANDIDATES) {
				let resolved: string;
				try {
					const model = ctx.models.resolve(name);
					if (model === undefined) {
						lines.push(`${name.padEnd(24)} UNRESOLVED`);
						continue;
					}
					const spec = `${(model as { provider?: string }).provider}/${(model as { id?: string }).id}`;
					let auth = "auth?";
					try {
						const result = await ctx.modelRegistry.getApiKeyAndHeaders(model as never);
						auth = (result as { ok?: boolean }).ok === false ? "NO CREDENTIALS" : "ok";
					} catch (error) {
						auth = `auth threw: ${error instanceof Error ? error.message.slice(0, 40) : "?"}`;
					}
					resolved = `${spec}  ${auth}`;
				} catch (error) {
					resolved = `THREW: ${error instanceof Error ? error.message.slice(0, 50) : "?"}`;
				}
				lines.push(`${name.padEnd(24)} ${resolved}`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});
}
