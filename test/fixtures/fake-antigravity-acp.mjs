#!/usr/bin/env node
// A stand-in for Google's antigravity-acp that speaks the Agent Client Protocol over stdio, for
// test/verify-google-antigravity.mjs. FAKE_AGY_MODE picks the behaviour: "text" (answer with text),
// "tool" (call the first CozyClay tool through the session's MCP server, then wait for
// session/cancel), "expired" (log the binary's browser-login line and never answer authenticate),
// "quota" (refuse the prompt with RESOURCE_EXHAUSTED). FAKE_AGY_LOG gets one JSON line per request.
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_AGY_MODE || "text";
const log = (entry) => { if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(entry)}\n`); };
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let buffer = "", session, cancelled;

async function mcp(server, method, params, id) {
	const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
	for (const header of server.headers ?? []) headers[header.name] = header.value;
	const response = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }) });
	return response.status === 202 ? undefined : (await response.json()).result;
}

async function handle(message) {
	const { id, method, params } = message;
	if (method !== undefined) log({ method, params, env: { GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null } });
	if (method === "initialize") {
		send({ id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
			authMethods: [{ id: "oauth-personal", name: "Log in with Google" }, { id: "gemini-api-key", name: "Gemini API key" }],
			agentInfo: { name: "antigravity-acp", version: "fake" } } });
	} else if (method === "authenticate") {
		if (mode === "expired") { process.stderr.write("I1127 credential_manager.py:561] Credentials missing or invalid. Launching browser login flow...\n"); return; }
		if (mode === "link") { process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=fake\n"); setTimeout(() => send({ id, result: {} }), 50); return; }
		send({ id, result: {} });
	} else if (method === "session/new") {
		session = params;
		send({ id, result: { sessionId: "s1", configOptions: [{ id: "model", category: "model", type: "select", currentValue: "gemini-4-hydrogen",
			options: ["gemini-4-hydrogen", "gemini-4-neon-low", "gemini-4-neon-medium", "gemini-4-neon-high", "gemini-4-neon-xhigh"].map((value) => ({ value, name: value })) }] } });
	} else if (method === "session/set_config_option" || method === "session/set_model") {
		send({ id, result: {} });
	} else if (method === "session/cancel") {
		cancelled?.();
	} else if (method === "session/prompt") {
		if (mode === "quota") { send({ id, error: { code: -32603, message: "RESOURCE_EXHAUSTED: quota exceeded for this Google AI plan" } }); return; }
		const update = (sessionUpdate, text) => send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate, content: { type: "text", text } } } });
		update("agent_thought_chunk", "Thinking.");
		update("agent_message_chunk", "Hello ");
		update("agent_message_chunk", "from Gemini");
		if (mode === "tool") {
			const server = session.mcpServers[0];
			await mcp(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake" } }, 1);
			await mcp(server, "notifications/initialized", {});
			const { tools } = await mcp(server, "tools/list", {}, 2);
			const reply = await mcp(server, "tools/call", { name: tools[0].name, arguments: { target: "cube", amount: 2 } }, 3);
			log({ toolReply: reply, tools: tools.map((tool) => tool.name) });
			await new Promise((resolve) => { cancelled = resolve; });
			send({ id, result: { stopReason: "cancelled" } });
			return;
		}
		send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "usage_update", used: 10, size: 100, usage: { inputTokens: 12, outputTokens: 4 } } } });
		send({ id, result: { stopReason: "end_turn" } });
	} else if (id !== undefined) {
		send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.trim()) void handle(JSON.parse(line));
	}
});
process.stdin.on("end", () => process.exit(0));
