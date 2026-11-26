// The `script` tool (#715): one model call runs a JavaScript body in a QuickJS
// sandbox (@earendil-works/pi-codemode) whose only capability is calling the
// turn's own Studio tools. Nested results never enter the model's context whole:
// the script's text()/return value and a call summary do, a row per nested call
// that carries what differs from what was asked (warnings, dropped paths, a
// refusal's facts), and the pictures nested calls answered with.
import { refusalFacts } from "./refusal.mjs";

const TIMEOUT_MS = 120_000;
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
// A receipt lists up to 100 affected ids (src/studio-agent-protocol.js receiptBase); a row keeps them all.
const MAX_AFFECTED_IDS = 100;
// Pictures one script answers with. A closeup is 1260x480 px, about 806 tokens to the provider (pixels / 750).
export const MAX_PICTURES = 8;

/** JSON round trip without image bytes: a nested verify_result may resolve an
 * image, and the sandbox, the call summary and the model never carry it. */
const publicData = value => value === undefined ? null : JSON.parse(JSON.stringify(value, (key, entry) => key === "dataUrl" ? undefined : entry) ?? "null");

// The object sizes a call's receipt states (src/receipt-sizes.js), every entry: a mixed patch_elements answers one receipt per domain.
// With them, the text of its SIZES_ warning (sizes left out, or a partial receipt's sizes).
function sizesOf(result) {
	const receipts = Array.isArray(result?.commands) ? result.commands.map(row => row?.receipt).filter(Boolean) : [result];
	const sizes = Object.assign({}, ...receipts.map(receipt => receipt?.output?.sizeM ?? {}));
	const notes = receipts.flatMap(receipt => Array.isArray(receipt?.warnings) ? receipt.warnings : []).filter(warning => /^SIZES_/.test(warning?.code)).map(warning => warning.message);
	return { ...(Object.keys(sizes).length ? { sizeM: sizes } : {}), ...(notes.length ? { sizesNote: notes.join(" ") } : {}) };
}

// What a call's receipts say differs from what it asked: every warning but the SIZES_ ones (sizesNote carries those) and
// every op that lost a path (its index in the call's own ops: a split patch maps each domain's op back by opIndices).
// A split patch's refused domains are in the row's code and message already (patch-domains.mjs splitReceipt).
function differencesOf(result) {
	const parts = Array.isArray(result?.commands) ? result.commands.filter(row => row?.receipt).map(row => ({ receipt: row.receipt, indices: row.opIndices })) : [{ receipt: result }];
	const warnings = parts.flatMap(({ receipt }) => (Array.isArray(receipt?.warnings) ? receipt.warnings : [])).filter(warning => warning?.code && !/^SIZES_/.test(warning.code));
	const dropped = parts.flatMap(({ receipt, indices }) => (Array.isArray(receipt?.ops) ? receipt.ops : []).filter(op => op?.droppedPaths?.length).map(op => ({ index: indices?.[op.index] ?? op.index, droppedPaths: op.droppedPaths })));
	return { ...(warnings.length ? { warnings } : {}), ...(dropped.length ? { dropped } : {}) };
}

// The look an action answered with (action-look.mjs), without the picture's own bookkeeping, and beside it the
// receipt's summary: the model's own call of such an action reads both (a sculpt's summary holds its box check).
const lookOf = result => (result?.look && typeof result.look === "object" ? { ...(typeof result.summary === "string" && result.summary ? { summary: result.summary } : {}),
	look: { status: result.look.status, ...(result.look.reason ? { reason: result.look.reason } : {}), ...(result.look.floating ? { floating: result.look.floating } : {}) } } : {});

function callSummary(name, result, error, args) {
	if (error) {
		const { code, message, tool: _tool, ...facts } = refusalFacts(error, { tool: name, args });
		return { name, ok: false, receiptId: error.receipt?.receiptId ?? null, status: error.receipt?.status ?? null, revision: error.receipt?.revision ?? null,
			affectedIds: (error.receipt?.affectedIds ?? []).slice(0, MAX_AFFECTED_IDS), code, message, ...facts };
	}
	return { name, ...(typeof result?.action === "string" ? { action: result.action } : {}), ok: result?.ok !== false, receiptId: result?.receiptId ?? null, status: result?.status ?? null, revision: result?.revision ?? null,
		affectedIds: Array.isArray(result?.affectedIds) ? result.affectedIds.slice(0, MAX_AFFECTED_IDS) : [], code: result?.code ?? null, message: result?.message ?? null, ...sizesOf(result), ...differencesOf(result), ...lookOf(result) };
}

/** A failed script whose nested calls moved the scene revision: its edits are rolled back (agent-routes.mjs). */
export const scriptEditedBeforeFailing = result => !result.ok && result.calls.some(call => call.ok && Number.isSafeInteger(call.revision?.after) && call.revision.after !== call.revision.before);

/** A rolled-back script's result: its pictures showed edits that are gone, so they leave, and every row and the count say so. */
export function withoutPictures({ dataUrls, ...result }) {
	if (!dataUrls?.length) return result;
	return { ...result, calls: result.calls.map(row => (typeof row.picture === "number" ? { ...row, picture: "left out" } : row)), picturesLeftOut: (result.picturesLeftOut ?? 0) + dataUrls.length };
}

function description(names) {
	return [
		"Run a JavaScript body that calls Studio tools in code. Use script whenever a request needs 3 or more commands or any computed placement (circles, rows, symmetric coverage, repeated objects): one script replaces many tool calls.",
		`Inside the script, \`await tools.<name>(args)\` calls a Studio tool with the same arguments as the direct tool and returns its parsed JSON result; a refused command throws an Error whose message starts with its code. Available: ${names.map(name => `tools.${name}`).join(", ")}.`,
		"Compute coordinates in code: metres, +Y up, yaw in degrees, floor at y=0 (Math works; there are no timers, fetch or modules).",
		"You see only what the script passes to text(value) or returns, plus a calls summary (name, ok, receiptId, status, revision, affectedIds, code, message per call; sizeM when its receipt states object sizes, sizesNote when it has a SIZES_ warning; warnings, dropped (ops that lost paths) and a refusal's at, asked and changed when there are any). Nested results are not shown to you, so return what you need.",
		`A nested call's picture comes back with the script (a verify_result visual, an action's own look), up to ${MAX_PICTURES}; its calls row says which (picture: n), and with an action's own look carries the receipt's summary.`,
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
			const calls = [], pictures = [];
			let started = 0, picturesLeftOut = 0;
			// A nested call's picture rides on the script's result; its row names it by place (1-based), or says it was left out.
			const summarize = (name, result, args) => {
				const row = callSummary(name, result, null, args);
				if (typeof result?.dataUrl === "string" && result.dataUrl.startsWith("data:image/")) {
					if (pictures.length < MAX_PICTURES) { pictures.push(result.dataUrl); row.picture = pictures.length; }
					else { picturesLeftOut += 1; row.picture = "left out"; }
				}
				return row;
			};
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
							calls.push(callSummary(tool.name, null, error, args));
							report(index, tool.name, args, "failed", null, error);
							// The script reads the code and message, as before; the facts of the refusal are in its calls row, once.
							throw new Error(error?.code ? `${error.code}: ${error.rawMessage ?? error.message}` : (error?.rawMessage ?? error?.message ?? String(error)));
						}
						calls.push(summarize(tool.name, result, args));
						report(index, tool.name, args, result?.ok === false ? "failed" : "done", result);
						return publicData(result);
					},
				})),
			});
			try {
				const result = await sandbox.execute(code, runSignal ? { signal: runSignal } : {});
				const output = result.output.filter(item => item.type === "text").map(item => item.text);
				const seen = { ...(pictures.length ? { dataUrls: pictures } : {}), ...(picturesLeftOut ? { picturesLeftOut } : {}) };
				if (result.ok) return { ok: true, value: publicData(result.value), output, calls, ...seen };
				return { ok: false, error: { kind: result.error.kind, message: result.error.message }, output, calls, ...seen };
			} finally {
				await sandbox.close();
			}
		},
	};
}
