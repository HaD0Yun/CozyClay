// The google-antigravity lane's stream body, the counterpart of anthropic-subscription-stream.mjs:
// starts Google's official antigravity-acp over ACP, signs in with the binary's own Google login
// (silent when it already holds one), opens a session with every built-in tool off and CozyClay's
// tools on a loopback MCP server (acp-tool-bridge.mjs), replays pi's history as one prompt
// (anthropic-subscription-prompt.mjs) and maps session/update back to pi events. A tool call ends
// the turn as toolUse: CozyClay's harness runs it and the result arrives with the next prompt.
// No Google token ever passes through here.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptBlocks } from "./anthropic-subscription-prompt.mjs";
import { emptyOutput } from "./anthropic-subscription-events.mjs";
import { startToolBridge, TOOL_SERVER_NAME } from "./acp-tool-bridge.mjs";
import { authenticate, signInError, startAntigravity } from "./google-antigravity-agent.mjs";
import { createAcpEventMapper, mapAcpStopReason, toAcpContent } from "./google-antigravity-events.mjs";

const EFFORT_SUFFIX = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };
// Parallel tool calls land within a few ms of each other; wait this long before ending the turn.
const HANDOFF_SETTLE_MS = 150;

/** The ids the session offers: its model config option, else the (older) session models list. */
function sessionModels(session) {
	const option = (session?.configOptions ?? []).find((item) => item?.category === "model" && Array.isArray(item.options));
	if (option) return { configId: option.id, ids: option.options.map((item) => item?.value).filter((id) => typeof id === "string") };
	const ids = (session?.models?.availableModels ?? []).map((item) => item?.modelId).filter((id) => typeof id === "string");
	return { configId: undefined, ids };
}

/** The offered id for a catalogue model at a pi thinking level (the binary lists "gemini-4-neon-high" style variants). */
export function pickModelId(ids, modelId, reasoning) {
	const suffix = EFFORT_SUFFIX[reasoning];
	if (suffix && ids.includes(`${modelId}-${suffix}`)) return `${modelId}-${suffix}`;
	if (ids.includes(modelId)) return modelId;
	return ids.find((id) => id.startsWith(`${modelId}-`));
}

function permissionAnswer(params, knownTools) {
	// Built-ins are all off, so a permission request should only ever be for a CozyClay tool, whose
	// call only reaches the bridge (which runs nothing). Anything else is refused.
	const options = Array.isArray(params?.options) ? params.options : [];
	const text = JSON.stringify(params?.toolCall ?? {});
	const ours = [...knownTools].some((name) => text.includes(name)) || text.includes(TOOL_SERVER_NAME);
	const allow = ours && options.find((option) => option?.kind === "allow_once");
	return { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } };
}

export function createAntigravityStream({ env = process.env, start = startAntigravity, version } = {}) {
	return function streamGoogleAntigravity(model, context, options = {}) {
		return (async () => {
			const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const output = emptyOutput(model);
				const mapper = createAcpEventMapper({ output, stream });
				let connection, bridge, sessionId, settle, signInNeeded = false, aborted = false;
				const workspace = mkdtempSync(join(tmpdir(), "cozyclay-agy-"));
				const cancel = () => { if (connection && sessionId) connection.notify("session/cancel", { sessionId }); };
				const onAbort = () => { aborted = true; cancel(); setTimeout(() => connection?.close(), 2000).unref?.(); };
				if (options.signal?.aborted) aborted = true;
				else options.signal?.addEventListener("abort", onAbort, { once: true });
				try {
					if (!/^gemini-/i.test(model.id)) throw Object.assign(new Error(`404 ${model.id} is not a Gemini model; this lane runs Gemini models only.`), { status: 404 });
					stream.push({ type: "start", partial: output });
					const piTools = getCurrentTools(context.messages) ?? [];
					const knownTools = new Set(piTools.map((tool) => tool.name));
					bridge = await startToolBridge(piTools, {
						onToolCall: (call) => {
							mapper.toolCall(call);
							clearTimeout(settle);
							settle = setTimeout(cancel, HANDOFF_SETTLE_MS);
						},
					});
					const started = await start({
						env, cwd: workspace, version,
						onNotification: (method, params) => { if (method === "session/update" && params?.sessionId === sessionId) mapper.update(params.update); },
						onRequest: async (method, params) => method === "session/request_permission" ? permissionAnswer(params, knownTools) : undefined,
						onSignInStarted: () => { signInNeeded = true; connection?.close(); },
						onAuthLink: () => { signInNeeded = true; connection?.close(); },
					});
					connection = started.connection;
					if (aborted) throw new Error("Operation aborted");
					await authenticate(connection).catch((error) => { throw signInNeeded ? signInError() : error; });
					const system = getCurrentSystemPrompt(context.messages).trim();
					const session = await connection.request("session/new", {
						cwd: workspace,
						mcpServers: piTools.length ? [bridge.server] : [],
						_meta: { antigravity: { enabledTools: [], ...(piTools.length ? { eagerMcpServers: [TOOL_SERVER_NAME] } : {}), ...(system ? { systemPrompt: { append: system } } : {}) } },
					});
					sessionId = session?.sessionId;
					const offered = sessionModels(session);
					if (offered.ids.length) {
						const picked = pickModelId(offered.ids, model.id, options.reasoning);
						if (!picked) throw Object.assign(new Error(`404 ${model.id} is not available on this Google AI plan.`), { status: 404 });
						if (offered.configId) await connection.request("session/set_config_option", { sessionId, configId: offered.configId, value: picked });
						else await connection.request("session/set_model", { sessionId, modelId: picked });
					}
					const result = await connection.request("session/prompt", { sessionId, prompt: toAcpContent(buildPromptBlocks(context)) });
					mapper.finish();
					if (aborted || options.signal?.aborted) {
						output.stopReason = "aborted";
						output.errorMessage = "Operation aborted";
						stream.push({ type: "error", reason: "aborted", error: output });
						return;
					}
					output.stopReason = mapAcpStopReason(result?.stopReason, { toolCalls: mapper.toolCalls });
					if (result?.usage) mapper.update({ sessionUpdate: "usage_update", usage: result.usage });
					if (output.stopReason === "error") throw new Error("The Gemini model refused this request.");
					if (output.stopReason === "aborted") throw new Error("Operation aborted");
					stream.push({ type: "done", reason: output.stopReason, message: output });
				} catch (raw) {
					mapper.finish();
					const error = signInNeeded ? signInError() : raw;
					const wasAborted = aborted || options.signal?.aborted;
					output.stopReason = wasAborted ? "aborted" : "error";
					output.errorMessage = wasAborted ? "Operation aborted" : (error instanceof Error ? error.message : String(error));
					stream.push({ type: "error", reason: output.stopReason, error: output });
				} finally {
					clearTimeout(settle);
					options.signal?.removeEventListener?.("abort", onAbort);
					connection?.close();
					await bridge?.close().catch(() => {});
					rmSync(workspace, { recursive: true, force: true });
					stream.end();
				}
			})();
			return stream;
		})();
	};
}
