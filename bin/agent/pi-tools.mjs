import { Value } from "typebox/value";
import { STUDIO_TOOL_LABELS } from "../../src/studio-agent-protocol.js";
import { toTypeBox } from "./schema-to-typebox.mjs";
import { toolArgumentPreparer } from "./tool-arguments.mjs";


function dataUrlImage(dataUrl) {
	const match = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl || "");
	return match ? { type: "image", data: match[2], mimeType: match[1] } : null;
}

function publicResult(result) {
	if (!result || typeof result !== "object" || Array.isArray(result) || !Object.hasOwn(result, "dataUrl")) return result;
	return Object.fromEntries(Object.entries(result).filter(([key]) => key !== "dataUrl"));
}

// One tool result rides whole in every later model call of its turn (studio-context-budget.mjs shrinks only older ones),
// so a result past this many characters is cut, with a note on how to ask for less. A scene-document read once
// answered 470k characters, ~300k tokens a call for the rest of that turn.
export const RESULT_CHARS = 100_000;
export function resultText(details) {
	const text = JSON.stringify(details ?? null);
	if (text.length <= RESULT_CHARS) return text;
	return `${text.slice(0, RESULT_CHARS)} … [cut: this result is ${text.length} characters, over the ${RESULT_CHARS}-character limit for one tool result. `
		+ "Ask for less: name ids, select kinds, page with cursor, or read it inside a script and return only what you need.]";
}

function recoveryHint(error) {
	const recovery = error?.receipt?.recovery;
	if (!recovery?.action || recovery.action === "none") return "";
	return ` (${recovery.action}${recovery.retryAllowed === false ? ", do not retry" : ", retry allowed"})`;
}

/** The handler's result, unless the run is stopped first: then the call ends at once as aborted, as it did under pi's
 * removed AgentHarness. The handler may still settle in the background; its result no longer counts. */
function untilAborted(pending, signal) {
	const aborted = () => Object.assign(new Error("Stopped before this call finished."), { name: "AbortError", code: "ABORTED" });
	if (!signal) return pending;
	if (signal.aborted) return Promise.reject(aborted());
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(aborted());
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function formatToolError(error) {
	const code = error?.code || "BACKEND_UNAVAILABLE";
	const message = error?.message || "Tool execution failed.";
	return `${code}: ${message}${recoveryHint(error)}`;
}

/** Throws INVALID_ARGUMENT, naming the first failed rule, when `params` do not match the TypeBox `parameters`. */
export function assertToolArguments(name, parameters, params) {
	if (Value.Check(parameters, params)) return;
	const first = [...Value.Errors(parameters, params)][0];
	throw Object.assign(new Error(`Invalid arguments for ${name}${first ? `: ${first.keyword}: ${first.message}` : "."}`), { code: "INVALID_ARGUMENT" });
}

/** Convert CozyClay's handler catalogue into pi AgentTools; ready AgentTools pass through unchanged. */
export function toAgentTools(tools, { emit, signal, labels = STUDIO_TOOL_LABELS } = {}) {
	return (Array.isArray(tools) ? tools : []).map((tool) => {
		// A ready pi AgentTool (it has its own execute) passes through as the same object.
		if (typeof tool?.execute === "function") return tool;
		const schema = tool.parameters || { type: "object", properties: {}, additionalProperties: false }, parameters = toTypeBox(schema);
		return {
			name: tool.name,
			label: labels?.[tool.name] ?? tool.label ?? tool.name.replaceAll("_", " "),
			description: tool.description || tool.name,
			parameters,
			// Before pi's own check: array texts parsed, unknown fields named (tool-arguments.mjs).
			prepareArguments: toolArgumentPreparer(tool.name, schema),
			// pi's `Agent` calls `execute(id, params, signal, onUpdate)`, where `signal`
			// is the REAL run abort signal (session.abort() fires it); a caller that
			// passes none gets the adapter's own fallback signal.
			execute: async (toolCallId, params, runSignal) => {
				const executeSignal = runSignal ?? signal;
				assertToolArguments(tool.name, parameters, params);
				try {
					const result = await untilAborted(Promise.resolve(tool.handler(params, { signal: executeSignal, toolCallId, emit })), executeSignal);
					const details = publicResult(result);
					const image = result && typeof result === "object" && !Array.isArray(result) && result.dataUrl ? dataUrlImage(result.dataUrl) : null;
					const content = [{ type: "text", text: resultText(details) }];
					if (image) content.push(image);
					return { content, details };
				} catch (error) {
					error.message = formatToolError(error);
					throw error;
				}
			},
		};
	});
}
