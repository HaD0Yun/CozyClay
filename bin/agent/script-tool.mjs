// The `script` tool (#715): one model call runs a JavaScript body in a QuickJS
// sandbox (@earendil-works/pi-codemode) whose only capability is calling the
// turn's own Studio tools. Nested results never enter the model's context;
// only the script's text()/return value and a compact call summary do.

const TIMEOUT_MS = 120_000;
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_AFFECTED_IDS = 8;

/** JSON round trip without image bytes: a nested verify_result may resolve an
 * image, and the sandbox, the call summary and the model never carry it. */
const publicData = value => value === undefined ? null : JSON.parse(JSON.stringify(value, (key, entry) => key === "dataUrl" ? undefined : entry) ?? "null");

function callSummary(name, result, error) {
	if (error) return { name, ok: false, receiptId: error.receipt?.receiptId ?? null, status: error.receipt?.status ?? null, revision: error.receipt?.revision ?? null,
		affectedIds: (error.receipt?.affectedIds ?? []).slice(0, MAX_AFFECTED_IDS), code: error.code ?? null, message: error.message ?? String(error) };
	return { name, ...(typeof result?.action === "string" ? { action: result.action } : {}), ok: result?.ok !== false, receiptId: result?.receiptId ?? null, status: result?.status ?? null, revision: result?.revision ?? null,
		affectedIds: Array.isArray(result?.affectedIds) ? result.affectedIds.slice(0, MAX_AFFECTED_IDS) : [], code: result?.code ?? null, message: result?.message ?? null };
}

function description(names) {
	return [
		"Run a JavaScript body that calls Studio tools in code. Use script whenever a request needs 3 or more commands or any computed placement (circles, rows, symmetric coverage, repeated objects): one script replaces many tool calls.",
		`Inside the script, \`await tools.<name>(args)\` calls a Studio tool with the same arguments as the direct tool and returns its parsed JSON result; a refused command throws an Error whose message starts with its code. Available: ${names.map(name => `tools.${name}`).join(", ")}.`,
		"Compute coordinates in code: metres, +Y up, yaw in degrees, floor at y=0 (Math works; there are no timers, fetch or modules).",
		"You see only what the script passes to text(value) or returns, plus a calls summary (name, ok, receiptId, status, revision, affectedIds, code, message per call). Nested results are not shown to you, so return what you need.",
		"Images never come back from a script: call verify_result OUTSIDE the script when you need to see the frame.",
		"If the script fails after editing, the script's own edits are rolled back (edits made before the script stay) and the result says so; fix the script and run it again.",
	].join("\n");
}

/** What the panel shows of one nested call while the script runs: a tool.progress frame (no results, no ids). */
function progressFrame(callId, index, name, args, status, result, error) {
	const summary = error ? `${error.code ? `${error.code}: ` : ""}${error.message ?? ""}` : result?.summary;
	return { type: "tool.progress", callId, index, name, ...(name === "run_action" && typeof args?.action === "string" ? { action: args.action } : {}), status,
		...(typeof summary === "string" && summary ? { summary: summary.slice(0, 160) } : {}) };
}

/** One model-facing tool in the shape bin/agent/pi-tools.mjs toAgentTools consumes. */
export function createScriptTool({ tools = [], signal, emit: createdEmit } = {}) {
	return {
		name: "script",
		label: "Run a script",
		description: description(tools.map(tool => tool.name)),
		parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
		handler: async ({ code }, { signal: callSignal, toolCallId, emit = createdEmit } = {}) => {
			// Lazy like pi itself: package-isolation checks start the launcher
			// without node_modules.
			const { CodemodeSandbox } = await import("@earendil-works/pi-codemode");
			const runSignal = callSignal ?? signal;
			const calls = [];
			let started = 0;
			// Each nested call is told to the panel as it starts and ends; a failing view never fails the script.
			const report = (...frame) => { if (toolCallId && typeof emit === "function") try { emit(progressFrame(toolCallId, ...frame)); } catch { /* advisory */ } };
			const sandbox = new CodemodeSandbox({
				timeoutMs: TIMEOUT_MS,
				memoryLimitBytes: MEMORY_LIMIT_BYTES,
				tools: tools.map(tool => ({
					name: tool.name,
					description: tool.description,
					execute: async (args, { signal: nestedSignal }) => {
						// A quiet tool (plan-tool.mjs) is the panel's own business: no progress frame, no line in the calls summary.
						if (tool.quiet) return publicData(await tool.handler(args ?? {}, {}));
						const signals = [nestedSignal, runSignal].filter(Boolean), index = ++started;
						let result;
						report(index, tool.name, args, "running");
						// callId: the script's own tool call, so the editor counts the script's commands as one agent step (repair-watch.js)
						try { result = await tool.handler(args ?? {}, { signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0], ...(toolCallId ? { callId: toolCallId } : {}) }); }
						catch (error) {
							calls.push(callSummary(tool.name, null, error));
							report(index, tool.name, args, "failed", null, error);
							throw new Error(error?.code ? `${error.code}: ${error.message}` : (error?.message ?? String(error)));
						}
						calls.push(callSummary(tool.name, result));
						report(index, tool.name, args, result?.ok === false ? "failed" : "done", result);
						return publicData(result);
					},
				})),
			});
			try {
				const result = await sandbox.execute(code, runSignal ? { signal: runSignal } : {});
				const output = result.output.filter(item => item.type === "text").map(item => item.text);
				if (result.ok) return { ok: true, value: publicData(result.value), output, calls };
				return { ok: false, error: { kind: result.error.kind, message: result.error.message }, output, calls };
			} finally {
				await sandbox.close();
			}
		},
	};
}
