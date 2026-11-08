// The in-process MCP server "cozyclay" that carries the v4 tools (js, track, measure, render, qa)
// into Claude Code. The tools run here, in the sidecar: the handler calls V4Tool.run and turns its
// V4Result into an MCP CallToolResult (text, then image blocks). A throw becomes an error result
// the model reads; it never ends the turn.
import { readFileSync } from "node:fs";
import { zodShape } from "./zod-shape.mjs";

const SERVER_TIMEOUT_MS = 15 * 60_000;
const VERSION = (() => { try { return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version; } catch { return "0.0.0"; } })();

/** V4Result -> MCP CallToolResult: one text block, then one block per image. */
export function toCallToolResult(result) {
	const images = Array.isArray(result?.images) ? result.images.filter(image => typeof image?.data === "string" && image.data) : [];
	const text = typeof result?.text === "string" ? result.text : JSON.stringify(result?.data ?? null);
	return {
		content: [{ type: "text", text }, ...images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType || "image/png" }))],
		...(result?.isError ? { isError: true } : {}),
	};
}

const errorResult = error => ({ content: [{ type: "text", text: String(error?.message ?? error ?? "The tool failed.") }], isError: true });

/**
 * createV4McpServer(sdk, tools, { onCall, signal }) -> the SDK server config for options.mcpServers.cozyclay.
 * tools: V4Tool[]. signal: the turn's AbortSignal, joined with the MCP request's own signal for run().
 * onCall({ name, ok, ms, error? }) is told about every call (diagnostics only).
 */
export function createV4McpServer(sdk, tools, { onCall, signal } = {}) {
	const definitions = tools.map(tool => sdk.tool(tool.name, tool.description ?? "", zodShape(tool.inputSchema), async (args, extra) => {
		const started = Date.now();
		const signals = [signal, extra?.signal].filter(item => item && typeof item.aborted === "boolean");
		const call = { from: "model", ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}) };
		let answer;
		try {
			answer = toCallToolResult(await tool.run(args ?? {}, call));
		} catch (error) {
			answer = errorResult(error);
		}
		try { onCall?.({ name: tool.name, ok: !answer.isError, ms: Date.now() - started }); } catch { /* diagnostics never fail a call */ }
		return answer;
	}));
	return sdk.createSdkMcpServer({ name: "cozyclay", version: VERSION, tools: definitions, alwaysLoad: true, timeout: SERVER_TIMEOUT_MS });
}
