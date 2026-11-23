#!/usr/bin/env node
// The motion writer reaches its model through the Studio's own sign-ins (bin/agent/motion-writer.mjs): with a stored
// CLIProxyAPI sign-in and no environment variables the motion tool is attached and the writer's requests go to the
// provider with the stored key; the motion model when the sign-in offers it, else the session's model; no sign-in: no
// tool, and the prompt tells the user to sign in; CLIPROXY_BASE_URL / CLIPROXY_API_KEY set: the environment's proxy, and
// the requests are the same bytes as through the sign-in. The provider is a local server in the proxy's wire format.
//   node test/lowvis/verify-writer-login.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const name of ["CLIPROXY_BASE_URL", "CLIPROXY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "COZYCLAY_MOTION_MODEL", "COZYCLAY_MOTION_EFFORT", "COZYCLAY_MOTION_ENGINE"]) delete process.env[name];
process.env.COZYCLAY_CONFIG_DIR = mkdtempSync(join(tmpdir(), "writer-login-config-"));
const { createModels } = await import("../../bin/agent/providers.mjs");
const { writerRoute } = await import("../../bin/agent/motion-writer.mjs");
const { turnMotionDoor } = await import("../../bin/agent/motion-door.mjs");
const { NO_MOTION_PARAGRAPH } = await import("../../bin/agent/studio-prompt-lowvis.mjs");
const { studioSystemPrompt } = await import("../../bin/agent/studio-motion-reference.mjs");
const { runScene } = await import("../../src/lowvis/pi/harness.mjs");

// a provider in the proxy's place: its model list, and a scripted writer (a motion call, then a report)
const sse = (res, events) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); };
async function provider(served) {
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const path = new URL(req.url, "http://local").pathname, key = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
		if (path === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: served.map(id => ({ id, owned_by: "anthropic" })) })); return; }
		const body = Buffer.concat(chunks).toString("utf8"), parsed = JSON.parse(body), step = parsed.messages.filter(m => m.role === "assistant").length;
		requests.push({ key, body });
		const block = step === 0 ? { type: "tool_use", id: "w-1", name: "motion", input: {} } : { type: "text", text: "" };
		sse(res, [
			{ type: "message_start", message: { id: `msg-${step}`, type: "message", role: "assistant", content: [], model: parsed.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: block.type === "text" ? block : { ...block, input: {} } },
			{ type: "content_block_delta", index: 0, delta: block.type === "text" ? { type: "text_delta", text: "Nothing was made.\nMissing: everything" } : { type: "input_json_delta", partial_json: "{}" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: step === 0 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		]);
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	return { server, requests, base: `http://127.0.0.1:${server.address().port}` };
}
// the Studio's registry on a credential store that holds what a sign-in stored (credential-store.mjs shape)
const registryWith = credentials => createModels({ env: {}, credentials: {
	read: async id => credentials[id], list: async () => Object.keys(credentials).map(providerId => ({ providerId, type: credentials[providerId].type, source: "file" })),
	modify: async (id, fn) => (credentials[id] = await fn(credentials[id]) ?? credentials[id]), delete: async id => { delete credentials[id]; },
} });
const signIn = (base, key) => ({ cliproxy: { type: "api_key", key, env: { CLIPROXY_BASE_URL: base } } });
const doorOf = (value, env, models, deps) => turnMotionDoor({ value: { sessionId: "s-1", context: { host: { workspaceHandle: "ws" } }, ...value }, env, models, hub: { command: async () => ({}) },
	tools: { internal: { invoke: async () => ({}) } }, transaction: { mark: async () => null, rollback: async () => null }, signal: new AbortController().signal, deps });
const recording = seen => ({
	studioScene: () => ({ scene: { characters: [], props: [], others: [] }, ids: { characters: {}, props: {}, switch: [] } }),
	runScene: async options => { seen.push(options); return { wallMs: 0, compiles: 0, report: "Done.\nMissing: none", missing: "none", final: null }; },
	readClip: () => null, installClip: async () => ({ ok: true }),
});
const run = (env, writer, outDir) => runScene({ name: "writer-login", request: "c1 waves.", variant: "studio", model: "claude-opus-5-5", effort: "medium", env, outDir, ...(writer ? { writer } : {}) });
const writerOf = route => ({ models: route.models, model: route.piModel, provider: route.provider, via: route.via, secrets: route.secrets });

const offered = await provider(["claude-opus-5-5", "claude-fable-5-1"]), lacking = await provider(["claude-fable-5-1"]);
try {
	// a stored sign-in, no environment variables: the motion model on that sign-in, and the motion tool is attached
	{
		const models = await registryWith(signIn(offered.base, "stored-key"));
		const route = await writerRoute({ env: {}, models, picked: "cliproxy/claude-fable-5-1" });
		assert.deepEqual([route.via, route.provider, route.model, route.effort], ["sign-in", "cliproxy", "claude-opus-5-5", "medium"]);
		const seen = [], door = await doorOf({ model: "cliproxy/claude-fable-5-1" }, {}, async () => models, recording(seen));
		assert.equal(door?.name, "motion", "the motion tool is attached with a sign-in and no environment variables");
		const answer = await door.handler({ request: "c1 waves" }, {});
		await door.with([]).find(tool => tool.name === "motion_result").handler({});
		assert.equal(seen[0].model, "claude-opus-5-5");
		assert.equal(seen[0].writer.provider, "cliproxy", "the writer runs on the Studio's provider registry");
		assert.equal(seen[0].writer.models, models, "the very registry the agent's turns use");
		assert.ok(answer.started || answer.ok);
		console.log("PASS a stored sign-in and no environment: the motion tool is attached, the writer on the sign-in's motion model");
	}
	// the sign-in does not offer the motion model: the session's model writes the motion
	{
		const models = await registryWith(signIn(lacking.base, "stored-key"));
		const route = await writerRoute({ env: {}, models, picked: "cliproxy/claude-fable-5-1" });
		assert.deepEqual([route.via, route.provider, route.model, route.effort], ["session model", "cliproxy", "claude-fable-5-1", "medium"]);
		assert.match(route.label, /^cliproxy\/claude-fable-5-1 at medium, the model of this session/);
		assert.equal(await writerRoute({ env: {}, models, picked: "cliproxy/claude-fable-5-1", session: false }), null, "the direct key takes the motion model only");
		console.log("PASS the motion model not offered: the session's model, at the motion effort");
	}
	// no sign-in: no route, no motion tool, and the prompt says what to do
	{
		const models = await registryWith({});
		assert.equal(await writerRoute({ env: {}, models, picked: "cliproxy/claude-fable-5-1" }), null);
		assert.equal(await writerRoute({ env: {}, models, picked: null }), null, "nor ChatGPT's default model without its sign-in");
		assert.equal(await doorOf({ model: "cliproxy/claude-fable-5-1" }, {}, models, recording([])), null);
		assert.ok((await studioSystemPrompt({ engine: "lowvis", motion: false })).endsWith(NO_MOTION_PARAGRAPH));
		assert.match(NO_MOTION_PARAGRAPH, /sign in to a model provider in the model picker/);
		console.log("PASS no sign-in: no motion tool; the prompt tells the user to sign in");
	}
	// the environment's proxy: an override, and the runner reads it as before (no writer handed on)
	{
		const env = { CLIPROXY_BASE_URL: offered.base, CLIPROXY_API_KEY: "env-key" };
		const route = await writerRoute({ env, models: await registryWith({}), picked: "openai-codex/gpt-6-astra" });
		assert.deepEqual([route.via, route.provider, route.model, route.piModel], ["environment", "cliproxy", "claude-opus-5-5", undefined]);
		const seen = [], door = await doorOf({ model: "openai-codex/gpt-6-astra" }, env, null, recording(seen));
		await door.handler({ request: "c1 waves" }, {});
		await door.with([]).find(tool => tool.name === "motion_result").handler({});
		assert.equal(seen[0].writer, undefined, "the harness reads the environment itself");
		assert.deepEqual([seen[0].model, seen[0].effort], ["claude-opus-5-5", "medium"]);
		console.log("PASS environment variables set: the environment's proxy, read by the harness as before");
	}
	// the requests: through the environment and through the stored sign-in, the same bytes, each with its own key
	{
		const out = mkdtempSync(join(tmpdir(), "writer-login-runs-"));
		offered.requests.length = 0;
		// the proxy's key is read from the process's environment by its provider (cliproxy-provider.mjs), as in the Studio
		Object.assign(process.env, { CLIPROXY_BASE_URL: offered.base, CLIPROXY_API_KEY: "env-key" });
		const viaEnv = await run(process.env, null, join(out, "env"));
		delete process.env.CLIPROXY_BASE_URL; delete process.env.CLIPROXY_API_KEY;
		const envRequests = offered.requests.splice(0);
		const models = await registryWith(signIn(offered.base, "stored-key"));
		const route = await writerRoute({ env: {}, models, picked: "cliproxy/claude-opus-5-5" });
		const viaSignIn = await run({}, writerOf(route), join(out, "sign-in"));
		const signInRequests = offered.requests.splice(0);
		assert.equal(viaEnv.infraError, null, JSON.stringify(viaEnv.infraError));
		assert.equal(viaSignIn.infraError, null, JSON.stringify(viaSignIn.infraError));
		assert.equal(envRequests.length, 2);
		assert.equal(signInRequests.length, 2);
		const sessionFree = body => body.replace(/lowvis-pi-writer-login-\d+/g, "<session>");
		for (let i = 0; i < 2; i++) assert.equal(sessionFree(signInRequests[i].body), sessionFree(envRequests[i].body), `request ${i + 1}: the same bytes`);
		assert.deepEqual(envRequests.map(r => r.key), ["env-key", "env-key"]);
		assert.deepEqual(signInRequests.map(r => r.key), ["stored-key", "stored-key"], "the stored credential goes with the writer's requests");
		assert.ok(signInRequests[1].body.includes("\"cache_control\":{\"type\":\"ephemeral\"}"), "the cache mark stays on the second request");
		assert.equal(viaEnv.writer, undefined, "the environment's run record is as before");
		assert.deepEqual(viaSignIn.writer, { provider: "cliproxy", via: "sign-in" });
		assert.ok(!JSON.stringify(viaSignIn).includes("stored-key"), "the record holds no key");
		console.log(`PASS the writer's requests through the sign-in are the bytes of the environment's (${envRequests.map(r => r.body.length).join(", ")} bytes), with the stored key`);
	}
} finally { offered.server.close(); lacking.server.close(); }
