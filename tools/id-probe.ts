/**
 * Print the resolved provider and id for a model spec. Dev-only; NOT shipped.
 *
 * A bare spec is not an identity. One model id can span distinct Bedrock routes with different APIs, so a
 * test that names only the spec does not say what it measured.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export default function idProbe(pi: ExtensionAPI): void {
	let session: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		session = ctx;
	});

	pi.registerTool({
		name: "ac_idprobe",
		label: "Resolve model identities",
		description: "Prints provider and id for each spec. Development tool. Changes no configuration.",
		parameters: pi.zod.object({ specs: pi.zod.array(pi.zod.string()) }),
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { specs: string[] };
			const lines: string[] = [];
			for (const spec of params.specs) {
				const model = session?.models.resolve(spec) as { provider?: string; id?: string; api?: string } | undefined;
				lines.push(`${spec.padEnd(24)} provider=${model?.provider ?? "?"}  id=${model?.id ?? "?"}  api=${model?.api ?? "?"}`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});
}
