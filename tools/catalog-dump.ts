/**
 * Dump the live catalog's provider/id/api triples. Dev-only; NOT shipped.
 *
 *   omp --no-extensions -e tools/catalog-dump.ts \
 *       -p "Call the ac_catalog_dump tool with out set to /tmp/ac-catalog.txt"
 *
 * Exists because the allowlist's fixtures were invented. A matcher for "every provider style" can only be
 * tested against the styles this account actually resolves; a guessed Azure deployment id proves nothing,
 * since deployment names are chosen by whoever created them.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs/promises";

export default function catalogDump(pi: ExtensionAPI): void {
	const z = pi.zod;
	let session: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		session = ctx;
	});

	pi.registerTool({
		name: "ac_catalog_dump",
		label: "Dump the model catalog",
		description: "Write every catalog model as provider, id and api. Development tool. Changes no configuration.",
		parameters: z.object({ out: z.string() }),

		// `execute(toolCallId, params)`: the first argument is the call id, not the arguments object.
		async execute(_toolCallId, params) {
			const ctx = session;
			if (ctx === undefined) return { content: [{ type: "text", text: "no context" }], isError: true };
			const out = String(params.out);
			const lines = ctx.models.list().map(model => {
				const record = model as unknown as Record<string, unknown>;
				return `${String(record.provider ?? "?")}\t${String(record.id ?? "?")}\t${String(record.api ?? "?")}`;
			});
			lines.sort();
			await fs.writeFile(out, `${lines.length} models\n${lines.join("\n")}\n`, "utf8");
			return { content: [{ type: "text", text: `wrote ${lines.length} models to ${out}` }] };
		},
	});
}
