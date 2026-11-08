// The v4 tools (V4Tool: { name, description, inputSchema, run }) as pi AgentTools, so the v4 engine can run on
// CozyClay's pi loop (agent-runner.mjs) as well as in Claude Code. A result's images go back as image blocks,
// never stringified into the text; a failed result (isError, images kept) or a throw becomes pi's error tool result.
import { Value } from "typebox/value";
import { toTypeBox } from "../schema-to-typebox.mjs";

const DETAIL_MAX = 400;

/** toV4AgentTools(tools, { signal }) -> pi AgentTool[] from V4Tool[]; signal is the fallback when pi passes none. */
export function toV4AgentTools(tools, { signal } = {}) {
	return (Array.isArray(tools) ? tools : []).map(tool => {
		const parameters = toTypeBox(tool.inputSchema ?? { type: "object", properties: {} });
		return {
			name: tool.name,
			label: tool.name,
			description: tool.description ?? "",
			parameters,
			execute: async (toolCallId, params, runSignal) => {
				if (!Value.Check(parameters, params)) {
					const first = [...Value.Errors(parameters, params)][0];
					throw Object.assign(new Error(`Invalid arguments for ${tool.name}${first ? `: ${first.keyword}: ${first.message}` : "."}`), { code: "INVALID_ARGUMENT" });
				}
				const result = await tool.run(params ?? {}, { from: "model", signal: runSignal ?? signal });
				const text = typeof result?.text === "string" ? result.text : JSON.stringify(result?.data ?? null);
				const images = (Array.isArray(result?.images) ? result.images : []).filter(image => typeof image?.data === "string" && image.data).map(image => ({ type: "image", data: image.data, mimeType: image.mimeType || "image/png" }));
				// A failed result keeps its images (a js cell that rendered before it threw), as the Claude Code path does: pi takes isError on the result.
				const content = [{ type: "text", text: text || (result?.isError ? "The tool failed." : text) }, ...images];
				return { content, details: { text: text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text, images: images.length }, ...(result?.isError ? { isError: true } : {}) };
			},
		};
	});
}
