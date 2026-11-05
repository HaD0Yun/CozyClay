import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpTransport } from "../src/workflow/agent-client.js";
import { readStoredTaskMode } from "../src/workflow/task-board.js";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createCanvasCommands } from "../src/workflow/canvas-commands.js";
import { noteTurnDraft } from "../src/workflow/agent-turn-telemetry.js";
import { sanitizeProps } from "../src/analytics.js";
import { closePostTurnWindow, noteEditGesture } from "../src/post-turn-edits.js";

const request = { sessionId: "private-session", text: "private prompt /secret/file.png", model: "private-model" };
process.env.COZYCLAY_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cozyclay-agent-config-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "cozyclay-agent-sessions-"));
const encode = (event) => `data: ${JSON.stringify(event)}\n\n`;
const terminal = (turnId, outcome = "succeeded", failureCode) => ({ type: "execution_telemetry", event: `agent:turn_${outcome}`, props: { turn_id: turnId, duration_bucket: "gte30s", ...(failureCode ? { failure_code: failureCode } : {}) } });
const tool = (turnId, id, outcome = "succeeded") => ({ type: "execution_telemetry", telemetry_id: id, event: "agent:tool_executed", props: { turn_id: turnId, tool_category: "workflow_write", outcome, duration_bucket: "lt1s" } });
const started = (turnId, id) => ({ type: "execution_tool_started", turn_id: turnId, telemetry_id: id, tool_category: "workflow_write" });
const applied = (turnId) => ({ type: "execution_telemetry", event: "agent:result_applied", props: { turn_id: turnId } });
const names = (events) => events.map(({ event }) => event);
// The turn's summary and post-turn window have their own block at the end of this file.
const keep = (captured, event, props) => { if (event !== "agent:turn_summary" && event !== "agent:post_turn_edit") captured.push({ event, props }); };
const bounded = (emitter, event) => once(emitter, event, { signal: AbortSignal.timeout(5000) });
const listen = async (server) => { const ready = bounded(server, "listening"); server.listen(0, "127.0.0.1"); await ready; return `http://127.0.0.1:${server.address().port}`; };
const close = async (server) => { const closed = bounded(server, "close"); server.close(); server.closeAllConnections(); await closed; };

// Exercise the actual HTTP transport, not a telemetry helper or panel replay.
{
	const captured = [];
	const bodies = [];
	const transport = createHttpTransport({ surface: "studio", capture: (event, props) => keep(captured, event, props), now: () => 100,
		fetchImpl: async (_url, init) => {
			const body = JSON.parse(init.body); bodies.push(body);
			return new Response(encode(terminal(body.turn_id)) + encode({ type: "done" }));
		},
	});
	await transport.turn(request, () => {});
	assert.deepEqual(names(captured), ["agent:turn_requested", "agent:turn_succeeded"], "real transport owns requested and terminal");
	assert.deepEqual(captured[0].props, { surface: "studio", turn_id: bodies[0].turn_id });
	assert.match(bodies[0].turn_id, /^[a-f0-9]{32}$/);
	assert.deepEqual(captured[1].props, { turn_id: bodies[0].turn_id, duration_bucket: "lt1s" }, "browser measures the entire request, not server time");
	await transport.turn(request, () => {});
	assert.notEqual(bodies[0].turn_id, bodies[1].turn_id, "retry gets a fresh ID despite reusing session, prompt and model");
	assert.ok(!JSON.stringify(captured).includes("private"));
}

// Task mode is on by default (nothing stored), so a studio turn goes to the main agent with the opt-in header.
{
	const sent = [];
	const transport = createHttpTransport({ surface: "studio", capture: () => {}, fetchImpl: async (url, init) => {
		sent.push({ url: String(url), tasks: init.headers["x-cozyclay-tasks"] });
		return new Response(encode({ type: "done" }));
	} });
	const tasks = readStoredTaskMode({ getItem: () => null });
	const studioTurn = { ...request, surface: "studio", turnId: "turn-tasks", context: {} };
	await transport.turn({ ...studioTurn, ...(tasks ? { tasks: true } : {}) }, () => {});
	await transport.turn(studioTurn, () => {});
	assert.ok(sent[0].url.endsWith("/agent/main") && sent[0].tasks === "on", `default task mode goes to /agent/main with x-cozyclay-tasks: on: ${JSON.stringify(sent[0])}`);
	assert.ok(sent[1].url.endsWith("/agent/turn") && sent[1].tasks === undefined, `task mode off goes to /agent/turn without the header: ${JSON.stringify(sent[1])}`);
}

{
	const captured = [];
	const transport = createHttpTransport({ surface: "workflow", capture: (event, props) => keep(captured, event, props),
		fetchImpl: async (_url, init) => {
			const { turn_id: id } = JSON.parse(init.body);
			const first = tool(id, "a".repeat(32));
			const frames = [
				{ type: "execution_telemetry", event: "project:saved", props: { object_count_bucket: "gte100" } },
				{ ...first, props: { ...first.props, outcome: "uncertain" } },
				{ ...first, telemetry_id: "private-call-id" },
				{ ...first, telemetry_id: ["a".repeat(32)] },
				{ ...terminal(id), props: { turn_id: id, duration_bucket: "private duration" } },
				terminal(id, "failed", "private failure"),
				{ ...applied(id), props: { turn_id: id, result: "private" } },
				{ ...first, props: { ...first.props, tool_category: "camera" } },
				{ ...first, props: { ...first.props, prompt: "private" } },
				tool("b".repeat(32), "c".repeat(32)),
				first, first, tool(id, "d".repeat(32)), applied(id), applied(id), terminal(id), terminal(id),
				terminal(id, "failed", "upstream"), tool(id, "e".repeat(32)),
			];
			return new Response(frames.map(encode).join(""));
		},
	});
	await transport.turn(request, () => {});
	assert.deepEqual(names(captured), ["agent:turn_requested", "agent:tool_executed", "agent:tool_executed", "agent:result_applied", "agent:turn_succeeded"], "validate frames; duplicate wire IDs collapse but two real same-category tools do not");
	assert.ok(captured.every(({ props }) => !Object.hasOwn(props, "telemetry_id")));
}

for (const [status, failureCode] of [[401, "auth"], [429, "rate_limited"], [503, "upstream"]]) {
	const captured = [];
	const transport = createHttpTransport({ capture: (event, props) => keep(captured, event, props), fetchImpl: async () => new Response("private response", { status }) });
	await transport.turn(request, () => {});
	assert.deepEqual(names(captured), ["agent:turn_requested", "agent:turn_failed"]);
	assert.equal(captured[1].props.failure_code, failureCode);
}
{
	const captured = [];
	const error = new TypeError("private network refusal");
	const transport = createHttpTransport({ capture: (event, props) => keep(captured, event, props), fetchImpl: async () => { throw error; } });
	await assert.rejects(transport.turn(request, () => {}), (caught) => caught === error);
	assert.deepEqual(names(captured), ["agent:turn_requested", "agent:turn_failed"]);
	assert.equal(captured[1].props.failure_code, "network");
}
for (const body of ["", encode({ type: "done" }), 'data: {"type":"execution_telemetry"']) {
	const captured = [];
	await createHttpTransport({ capture: (event, props) => keep(captured, event, props), fetchImpl: async () => new Response(body) }).turn(request, () => {});
	assert.deepEqual(names(captured), ["agent:turn_requested"], "EOF/done without explicit outcome stays unresolved");
}

{
	const captured = [];
	const error = new TypeError("stream connection lost");
	const transport = createHttpTransport({ capture: (event, props) => keep(captured, event, props), fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(error); } })) });
	await assert.rejects(transport.turn(request, () => {}), (caught) => caught === error);
	assert.deepEqual(names(captured), ["agent:turn_requested"], "a broken in-flight SSE connection is unresolved, not a fabricated terminal");
}

for (const explicit of [true, false]) {
	const captured = [];
	const events = new EventEmitter();
	const controller = new AbortController();
	let stream;
	const ready = bounded(events, "tool");
	const transport = createHttpTransport({ capture: (event, props) => { keep(captured, event, props); }, fetchImpl: async (_url, init) => {
		if (_url === "/agent/stop") return new Response('{"ok":true}');
		const id = JSON.parse(init.body).turn_id;
		return new Response(new ReadableStream({ start(value) {
			stream = value;
			value.enqueue(new TextEncoder().encode(encode(started(id, "f".repeat(32))) + encode({ type: "text.delta", text: "ready" })));
			init.signal.addEventListener("abort", () => value.error(new DOMException("Aborted", "AbortError")), { once: true });
		} }));
	} });
	const pending = transport.turn(request, (event) => { if (event.type === "text.delta") events.emit("tool"); }, controller.signal);
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await ready;
	controller.abort(explicit ? "agent-stop" : undefined);
	if (explicit) await transport.stop(request.sessionId);
	await rejected;
	assert.deepEqual(names(captured), explicit ? ["agent:turn_requested", "agent:tool_executed", "agent:turn_cancelled"] : ["agent:turn_requested"], "explicit Stop is observed before SSE abort; disconnect is unresolved");
	if (explicit) { assert.equal(captured[1].props.outcome, "cancelled"); assert.equal(captured[2].props.failure_code, "aborted"); }
	assert.ok(stream);
}

// Randomness, clocks, capture callbacks and foreign error getters are advisory.
{
	const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	try {
		Object.defineProperty(globalThis, "crypto", { configurable: true, get() { throw new Error("random unavailable"); } });
		let calls = 0;
		await createHttpTransport({ capture: () => { throw new Error("capture unavailable"); }, now: () => { throw new Error("clock unavailable"); }, fetchImpl: async () => { calls++; return new Response(encode({ type: "done" })); } }).turn(request, () => {});
		assert.equal(calls, 1);
	} finally { Object.defineProperty(globalThis, "crypto", original); }
	for (const capture of [() => { throw new Error("sink"); }, () => Promise.reject(new Error("sink"))]) {
		for (const now of [() => { throw new Error("clock"); }, () => Symbol("unavailable"), () => ({ valueOf() { throw new Error("clock getter"); } })]) {
			await createHttpTransport({ capture, now, fetchImpl: async (_url, init) => new Response(encode(terminal(JSON.parse(init.body).turn_id))) }).turn(request, () => {});
		}
	}
	const captured = [];
	const foreign = Object.defineProperty({}, "status", { get() { throw new Error("foreign getter"); } });
	await assert.rejects(createHttpTransport({ capture: (event, props) => keep(captured, event, props), fetchImpl: async () => { throw foreign; } }).turn(request, () => {}), (error) => error === foreign);
	assert.equal(captured.at(-1).props.failure_code, "unknown");
}

// Real model HTTP/SSE -> Codex parser -> agent tools -> HTTP transport. A real
// canvas command supplies the mutation ack; generic accepted responses do not.
{
	let scenario = "success";
	let graph = { nodes: [], edges: [] };
	const canvas = createCanvasCommands({ store: { getGraph: () => graph, setGraph: (next) => { graph = next; } }, makeNode: (type, id, position) => ({ id, type, position, data: {} }), nodeSchemas: {} });
	const model = createServer(async (req, res) => {
		const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const encoded = Buffer.concat(chunks);
		const text = req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded).toString("utf8") : encoded.toString("utf8");
		const body = JSON.parse(text);
		assert.equal(body.store, false, "the fixture receives pi's non-persisted Responses request");
		assert.ok(Array.isArray(body.input), "the fixture receives a Responses input array");
		const input = body.input;
		const hasOutput = input.some((item) => item.type === "function_call_output");
		// pi-ai 1.4 declares a capable model's tools in `additional_tools` input items, not the top-level list.
		const declared = [...(Array.isArray(body.tools) ? body.tools : []), ...input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools ?? [])];
		if (!hasOutput) assert.ok(declared.length > 0, "the fixture receives the Workflow tools");
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (!hasOutput) {
			const name = scenario === "unknown" ? "private_unknown_tool" : scenario === "failure" ? "update_workflow_node" : scenario === "read" ? "describe_workflow" : "add_workflow_node";
			const args = scenario === "read" ? "{}" : scenario === "parse" ? "{private malformed" : JSON.stringify({ type: "text", data: { prompt: "private payload" } });
			res.write(encode({ type: "response.output_item.done", item: { type: "function_call", call_id: "private-call", name, arguments: args } }));
			if (scenario === "success") res.write(encode({ type: "response.output_item.done", item: { type: "function_call", call_id: "private-call-2", name, arguments: args } }));
		}
		if (scenario === "truncated" && hasOutput) return res.end();
		res.write(encode({ type: "response.completed", response: { status: "completed" } }));
		res.end();
	});
	const modelUrl = await listen(model);
	const fixtureToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.e30`;
	let toolRelease;
	const liveHub = { command: async (name, args) => {
		if (scenario === "cancel") return toolRelease.promise;
		if (scenario === "disconnected") throw new Error("Live editor disconnected");
		return scenario === "accepted" ? { accepted: true } : canvas.handlers[name](args);
	} };
	const auth = { getAccessToken: async () => fixtureToken, readStored: async () => ({ refresh_token: "fixture-refresh", access_token: fixtureToken, expires_at: Date.now() + 60 * 60 * 1000 }) };
	const handler = createAgentHandler({ auth, codexBaseUrl: modelUrl, liveHub });
	const sidecar = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
	const sidecarUrl = await listen(sidecar);
	try {
		for (scenario of ["success", "failure", "parse", "unknown", "disconnected", "read", "accepted", "truncated"]) {
			const captured = [];
			const wire = [];
			const transport = createHttpTransport({ surface: "workflow", capture: (event, props) => keep(captured, event, props), fetchImpl: async (url, init) => {
				const response = await fetch(sidecarUrl + url, init);
				const copy = await response.clone().text(); wire.push(...[...copy.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])));
				return response;
			} });
			await transport.turn({ ...request, model: "gpt-6-astra", sessionId: scenario }, () => {});
			const tools = captured.filter(({ event }) => event === "agent:tool_executed");
			assert.equal(tools.length, scenario === "success" ? 2 : 1, scenario);
			assert.ok(tools.every(({ props }) => props.outcome === (["failure", "parse", "unknown", "disconnected"].includes(scenario) ? "failed" : "succeeded")), scenario);
			if (["failure", "parse", "unknown", "disconnected"].includes(scenario)) assert.equal(captured.at(-1).props.failure_code, "tool_failed", scenario);
			else if (scenario === "truncated") assert.ok(!names(captured).some((name) => /^agent:turn_(succeeded|failed|cancelled)$/.test(name)), "truncated model stream cannot fabricate success");
			else assert.equal(captured.at(-1).event, "agent:turn_succeeded", scenario);
			assert.equal(captured.filter(({ event }) => event === "agent:result_applied").length, ["success", "truncated"].includes(scenario) ? 1 : 0, `${scenario}: only real mutation ack proves applied`);
			assert.ok(!JSON.stringify(captured).includes("private"));
			const toolFrames = wire.filter(({ event }) => event === "agent:tool_executed");
			assert.equal(new Set(toolFrames.map(({ telemetry_id }) => telemetry_id)).size, tools.length);
			assert.ok(toolFrames.every(({ telemetry_id }) => /^[a-f0-9]{32}$/.test(telemetry_id)));
			assert.ok(wire.every(({ event }) => event !== "agent:turn_requested"), "requested belongs to browser, not sidecar");
		}
		assert.ok(graph.nodes.length >= 2, "real canvas mutations were executed");
		scenario = "cancel";
		for (const throughTransport of [true, false]) {
			const captured = [];
			const events = new EventEmitter();
			const ready = bounded(events, "tool");
			toolRelease = Promise.withResolvers();
			let wireBody;
			const transport = createHttpTransport({ capture: (event, props) => keep(captured, event, props), fetchImpl: async (url, init) => {
				const response = await fetch(sidecarUrl + url, init);
				if (url === "/agent/turn") wireBody = response.clone().text();
				return response;
			} });
			const sessionId = `cancel-${throughTransport}`;
			const pending = transport.turn({ ...request, model: "gpt-6-astra", sessionId }, (event) => { if (event.type === "tool.start") events.emit("tool"); });
			await ready;
			if (throughTransport) await transport.stop(sessionId);
			else await fetch(sidecarUrl + "/agent/stop", { method: "POST", body: JSON.stringify({ sessionId }) }).then((response) => response.json());
			toolRelease.resolve({ accepted: true });
			await pending;
			assert.deepEqual(names(captured), ["agent:turn_requested", "agent:tool_executed", "agent:turn_cancelled"]);
			assert.equal(captured[1].props.outcome, "cancelled");
			assert.equal(captured[2].props.failure_code, "aborted");
			const wire = [...(await wireBody).matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
			assert.equal(wire.find(({ event }) => event === "agent:tool_executed").props.outcome, "cancelled", "server observes the stopped tool too");
			assert.equal(wire.find(({ event }) => event === "agent:turn_cancelled").props.failure_code, "aborted");
		}
		scenario = "read";
		for (const turn_id of [undefined, "private-session", ["a".repeat(32)]]) {
			const response = await fetch(sidecarUrl + "/agent/turn", { method: "POST", body: JSON.stringify({ ...request, sessionId: `unobserved-${typeof turn_id}`, turn_id }) });
			const wire = await response.text();
			assert.ok(wire.includes('"type":"done"'));
			assert.ok(!wire.includes("execution_telemetry") && !wire.includes("execution_tool_started"), "missing/invalid browser IDs disable only telemetry");
		}
	} finally { await handler.close(); await close(sidecar); await close(model); }
}
// A model URL that refuses the connection: the model client folds the fetch
// error into a failed message, and the turn still reads network on all three
// readings (the error frame, the sidecar's turn_failed, the browser's).
{
	const refusing = createServer();
	const modelUrl = await listen(refusing);
	await close(refusing);
	const fixtureToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.e30`;
	const auth = { getAccessToken: async () => fixtureToken, readStored: async () => ({ refresh_token: "fixture-refresh", access_token: fixtureToken, expires_at: Date.now() + 60 * 60 * 1000 }) };
	const handler = createAgentHandler({ auth, codexBaseUrl: modelUrl, liveHub: { command: async () => ({ accepted: true }) } });
	const sidecar = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
	const sidecarUrl = await listen(sidecar);
	try {
		const captured = [];
		const wire = [];
		const transport = createHttpTransport({ surface: "workflow", capture: (event, props) => keep(captured, event, props), fetchImpl: async (url, init) => {
			const response = await fetch(sidecarUrl + url, init);
			const copy = await response.clone().text(); wire.push(...[...copy.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])));
			return response;
		} });
		await transport.turn({ ...request, model: "gpt-6-astra", sessionId: "refused-model" }, () => {});
		assert.equal(wire.find(({ type }) => type === "error")?.code, "network", `the error frame: ${JSON.stringify(wire.filter(({ type }) => type === "error"))}`);
		assert.equal(wire.find(({ event }) => event === "agent:turn_failed")?.props.failure_code, "network", "the sidecar's agent:turn_failed");
		assert.deepEqual(names(captured), ["agent:turn_requested", "agent:turn_failed"]);
		assert.equal(captured[1].props.failure_code, "network", "the browser's agent:turn_failed");
	} finally { await handler.close(); await close(sidecar); }
}
// --- #379 / 16k (F2 pass 5 finding 4): on the REAL codex HTTP path, the
// quota frame must carry the ACTUAL response header values (proving the
// providers.mjs fetch seam reaches the runner with real headers) and must
// reach the browser BEFORE the model's own completion event is even sent —
// not merely appear first inside one all-at-once flush that happened to wait
// for the whole call. The model fixture deliberately withholds its
// `response.completed` (and the tool/text "done" that would end the turn)
// until this test releases it; the sidecar's SSE body is read incrementally
// (not `.text()`, which would hide exactly this timing) so we can observe
// the quota+text.delta frames arriving on the wire while the upstream model
// call is still deliberately blocked.
{
	const release = Promise.withResolvers();
	const model = createServer(async (req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream", "x-quota-test-percent": "77" });
		res.flushHeaders();
		res.write(encode({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }));
		res.write(encode({ type: "response.output_text.delta", output_index: 0, delta: "quota timing probe" }));
		await release.promise;
		res.write(encode({ type: "response.output_item.done", output_index: 0, item: { type: "message" } }));
		res.write(encode({ type: "response.completed", response: { status: "completed" } }));
		res.end();
	});
	const modelUrl = await listen(model);
	const fixtureToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "quota-fixture" } })).toString("base64url")}.e30`;
	const auth = { getAccessToken: async () => fixtureToken, readStored: async () => ({ refresh_token: "fixture-refresh", access_token: fixtureToken, expires_at: Date.now() + 60 * 60 * 1000 }) };
	const codex = { parseQuotaHeaders: (headers) => ({ planType: "Plus", primary: { usedPercent: Number(headers?.["x-quota-test-percent"] ?? -1), windowMinutes: null, resetAt: null }, credits: { hasCredits: true } }) };
	const handler = createAgentHandler({ auth, codex, codexBaseUrl: modelUrl, liveHub: { command: async () => ({ accepted: true }) } });
	const sidecar = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
	const sidecarUrl = await listen(sidecar);
	const deadline = async (promise, label) => {
		let timer;
		try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), 5000); })]); }
		finally { clearTimeout(timer); }
	};
	try {
		const response = await fetch(`${sidecarUrl}/agent/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "quota-timing", text: "hi", model: "gpt-6-astra" }) });
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const seenBeforeRelease = [];
		for (;;) {
			const { value, done } = await deadline(reader.read(), "sidecar SSE read");
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const frames = [...buffer.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
			for (const frame of frames) if (!seenBeforeRelease.some((seen) => seen === frame.type)) seenBeforeRelease.push(frame.type);
			if (frames.some((frame) => frame.type === "text.delta")) break; // release only after observing the early frames
		}
		const quotaFrame = [...buffer.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])).find((frame) => frame.type === "quota");
		assert.ok(seenBeforeRelease.includes("quota"), `the quota frame arrived while the model call was still blocked: ${JSON.stringify(seenBeforeRelease)}`);
		assert.ok(seenBeforeRelease.includes("text.delta"), `the text.delta arrived while the model call was still blocked: ${JSON.stringify(seenBeforeRelease)}`);
		assert.equal(seenBeforeRelease.indexOf("quota") < seenBeforeRelease.indexOf("text.delta"), true, `the quota frame precedes the first text.delta: ${JSON.stringify(seenBeforeRelease)}`);
		assert.equal(quotaFrame?.primary?.usedPercent, 77, "the quota frame carries the real parsed codex response header value, not a null default");
		release.resolve();
		// Drain the rest of the (now-released) stream so the server and sidecar close cleanly.
		for (;;) { const { done } = await deadline(reader.read(), "sidecar SSE drain"); if (done) break; }
	} finally { release.resolve(); await handler.close(); await close(sidecar); await close(model); }
	console.log("PASS 16k: the codex HTTP path's quota frame carries real header values and arrives before the model call completes");
}

// #379 / 16v: one handler registry must carry discovery from listing into every
// execution surface, including runners created before and after discovery.
{
	const liveId = "gpt-16v-live-only";
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "16v-fixture" } })).toString("base64url")}.e30`;
	const auth = {
		getAccessToken: async () => token,
		readStored: () => ({ access_token: token, refresh_token: "16v-refresh", expires_at: Date.now() + 3600000 }),
		status: () => ({ signedIn: true }),
	};
	const received = [];
	const fixture = createServer(async (req, res) => {
		if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
		const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const encoded = Buffer.concat(chunks);
		const body = JSON.parse(req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded) : encoded);
		received.push(body.model);
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`);
	});
	const fixtureUrl = await listen(fixture);
	const codex = {
		listModels: async () => [{ slug: liveId, supported_reasoning_levels: ["medium"] }],
		parseQuotaHeaders: () => ({ primary: {}, credits: {} }),
	};
	const studioRuntime = { readContext: async () => (await import("./verify-studio-agent-protocol.mjs")).contextFixture() };
	const liveHub = { workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", command: async () => ({}) };
	const handler = createAgentHandler({ auth, codex, codexBaseUrl: fixtureUrl, handlers: [], liveHub, studioRuntime });
	const sidecar = createServer((req, res) => handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const sidecarUrl = await listen(sidecar);
	const workflowTurn = async (sessionId, model) => {
		const response = await fetch(`${sidecarUrl}/agent/turn`, { method: "POST", headers: { origin: sidecarUrl, "content-type": "application/json" }, body: JSON.stringify({ sessionId, text: "hello", model }), signal: AbortSignal.timeout(8000) });
		const text = await response.text();
		return { response, frames: [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])), text };
	};
	const studioTurn = async (sessionId, turnId) => {
		const context = (await import("./verify-studio-agent-protocol.mjs")).contextFixture();
		const response = await fetch(`${sidecarUrl}/agent/turn`, { method: "POST", headers: { origin: sidecarUrl, "content-type": "application/json" }, body: JSON.stringify({ surface: "studio", sessionId, turnId, text: "inspect selection", model: `openai-codex/${liveId}`, context }), signal: AbortSignal.timeout(8000) });
		const text = await response.text();
		return { response, frames: [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])), text };
	};
	try {
		const warm = await workflowTurn("16v-workflow", "gpt-6-astra");
		assert.equal(warm.response.status, 200);
		assert.equal(warm.frames.some((frame) => frame.type === "error"), false, "the static Workflow turn warms the execution registry");
		const catalogueResponse = await fetch(`${sidecarUrl}/agent/models`, { signal: AbortSignal.timeout(8000) });
		const catalogue = await catalogueResponse.json();
		assert.equal(catalogueResponse.status, 200);
		assert.ok(catalogue.models.some((model) => model.id === `openai-codex/${liveId}`), "GET /agent/models advertises the live-only slug");
		for (const [sessionId, turnId] of [["16v-workflow", null], ["00000000-0000-4000-8000-000000000103", "00000000-0000-4000-8000-000000000101"], ["00000000-0000-4000-8000-000000000104", "00000000-0000-4000-8000-000000000102"]]) {
			const result = turnId ? await studioTurn(sessionId, turnId) : await workflowTurn(sessionId, `openai-codex/${liveId}`);
			assert.equal(result.response.status, 200);
			assert.equal(result.frames.some((frame) => frame.type === "error" && frame.code === "UNKNOWN_MODEL"), false, `${sessionId} resolves the advertised live-only slug`);
			assert.equal(result.frames.at(-1)?.type, "done", `${sessionId} reaches a terminal done frame`);
		}
		assert.deepEqual(received, ["gpt-6-astra", liveId, liveId, liveId], "static, Workflow and both Studio turns reach the Codex fixture");
		console.log("PASS 16v: one handler registry carries live Codex discovery into Workflow and Studio execution");
	} finally { await handler.close(); await close(sidecar); await close(fixture); }
}

// #379 / 16z: concurrent cold listings share discovery and execution, not just
// the last registry to finish construction. Dispatch every request before the
// catalogue can return; no sleep or second catalogue fetch opens this gate.
for (const count of [2, 5]) {
	const events = new EventEmitter();
	const release = Promise.withResolvers();
	const dispatched = bounded(events, "dispatched");
	const catalogueEntered = bounded(events, "catalogue");
	let catalogueCalls = 0;
	const received = [];
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "16z" } })).toString("base64url")}.e30`;
	const auth = {
		getAccessToken: async () => token,
		readStored: () => ({ access_token: token, refresh_token: "16z-refresh", expires_at: Date.now() + 3600000 }),
		status: () => ({ signedIn: true }),
	};
	const codex = {
		listModels: async () => {
			const call = ++catalogueCalls;
			events.emit("catalogue");
			await release.promise;
			return [{ slug: `gpt-16z-live-${call}`, supported_reasoning_levels: ["medium"] }];
		},
		parseQuotaHeaders: () => ({ primary: {}, credits: {} }),
	};
	const fixture = createServer(async (req, res) => {
		const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const encoded = Buffer.concat(chunks);
		const body = JSON.parse(req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded) : encoded);
		received.push({ path: req.url, model: body.model });
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(encode({ type: "response.completed", response: { status: "completed" } }));
	});
	const fixtureUrl = await listen(fixture);
	const handler = createAgentHandler({ auth, codex, codexBaseUrl: fixtureUrl, handlers: [], liveHub: {} });
	const waiting = [];
	const dispatch = (req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); });
	const server = createServer((req, res) => {
		if (req.url !== "/agent/models") return dispatch(req, res);
		waiting.push([req, res]);
		if (waiting.length === count) {
			for (const args of waiting) dispatch(...args);
			events.emit("dispatched");
		}
	});
	const origin = await listen(server);
	try {
		const pending = Promise.all(Array.from({ length: count }, async () => {
			const response = await fetch(`${origin}/agent/models`, { signal: AbortSignal.timeout(8000) });
			assert.equal(response.status, 200);
			return response.json();
		}));
		await Promise.all([dispatched, catalogueEntered]);
		release.resolve();
		const catalogues = await pending;
		assert.equal(catalogueCalls, 1, `${count} cold requests fetch one catalogue`);
		for (const catalogue of catalogues) {
			assert.deepEqual(catalogue.models.filter(model => model.id.includes("gpt-16z-live")).map(model => model.id), ["openai-codex/gpt-16z-live-1"]);
		}
		const response = await fetch(`${origin}/agent/turn`, { method: "POST", body: JSON.stringify({ sessionId: `16z-${count}`, text: "hello", model: "openai-codex/gpt-16z-live-1" }), signal: AbortSignal.timeout(8000) });
		assert.equal(response.status, 200);
		const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
		assert.equal(frames.some(frame => frame.type === "error"), false);
		assert.equal(frames.at(-1)?.type, "done");
		assert.deepEqual(received, [{ path: "/codex/responses", model: "gpt-16z-live-1" }]);
		console.log(`PASS 16z: ${count} concurrent cold listings share one executable live catalogue`);
	} finally { release.resolve(); await handler.close(); await close(server); await close(fixture); }
}

// A real provider import failure rejects createModels, rather than merely
// failing optional catalogue discovery (whose failure is cached separately).
{
	const { PROVIDERS, createModels } = await import("../bin/agent/providers.mjs");
	const auth = { getAccessToken: async () => null, readStored: () => undefined, status: () => ({ signedIn: false }) };
	const handler = createAgentHandler({ auth, handlers: [], liveHub: {} });
	const server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const origin = await listen(server);
	const unavailable = { id: "16z-unavailable", env: [] };
	try {
		PROVIDERS.push(unavailable);
		try {
			const failed = await fetch(`${origin}/agent/models`, { signal: AbortSignal.timeout(8000) });
			assert.equal(failed.status, 502, "registry construction failure reaches the caller");
			await failed.json();
		} finally { assert.equal(PROVIDERS.pop(), unavailable); }
		const retried = await fetch(`${origin}/agent/models`, { signal: AbortSignal.timeout(8000) });
		assert.equal(retried.status, 200, "a rejected registry build is retried");
		assert.ok((await retried.json()).models.some(model => model.id === "openai-codex/gpt-6-astra"));
	} finally { await handler.close(); await close(server); }

	const models = await createModels({ auth, keys: { readKeys: () => ({}) }, env: {} });
	let onAuthChange;
	const injected = createAgentHandler({ auth: { ...auth, onAuthChange: callback => { onAuthChange = callback; return () => {}; } }, models, handlers: [], liveHub: {} });
	const injectedServer = createServer((req, res) => injected(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const injectedOrigin = await listen(injectedServer);
	try {
		// Any attempted rebuild now fails. The extra provider can still be listed
		// by the injected registry as an empty, unconfigured catalogue.
		PROVIDERS.push(unavailable);
		for (const kind of [null, "rotated", "replaced", "signed_out"]) {
			if (kind) onAuthChange({ kind });
			const response = await fetch(`${injectedOrigin}/agent/models`, { signal: AbortSignal.timeout(8000) });
			assert.equal(response.status, 200, `injected registry is not rebuilt after ${kind}`);
			assert.ok((await response.json()).models.some(model => model.id === "openai-codex/gpt-6-astra"));
		}
	} finally { assert.equal(PROVIDERS.pop(), unavailable); await injected.close(); await close(injectedServer); }
	console.log("PASS 16z: failed construction retries and injected registries are never rebuilt");
}

// #379 / 16z: replace identity while ensureWorkflowModels is still awaiting
// construction, not merely while the later catalogue fetch is pending. This
// wrapper builds real registries and delays only the first build's return.
{
	const providersUrl = new URL("../bin/agent/providers.mjs", import.meta.url).href;
	const handlerUrl = new URL("../bin/agent/agent-routes.mjs?16z-identity-inflight", import.meta.url).href;
	const gatedUrl = `data:text/javascript,${encodeURIComponent(`
		import { EventEmitter } from "node:events";
		import { createModels as build } from ${JSON.stringify(providersUrl)};
		export * from ${JSON.stringify(providersUrl)};
		export const events = new EventEmitter();
		export const release = Promise.withResolvers();
		export const accounts = [], order = [];
		export async function createModels(options) {
			const account = options.auth.getAccountId();
			accounts.push(account);
			order.push("build-started:" + account);
			const registry = await build(options);
			if (accounts.length === 1) {
				events.emit("held");
				await release.promise;
			}
			order.push("build-settled:" + account);
			return registry;
		}
	`)}`;
	const gate = await import(gatedUrl);
	const held = bounded(gate.events, "held");
	const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
		return nextResolve(context.parentURL === handlerUrl && specifier === "./providers.mjs" ? gatedUrl : specifier, context);
	} });
	const { createAgentHandler: createGatedHandler } = await import(handlerUrl);
	let identity = "a", onAuthChange, catalogueCalls = 0;
	const token = () => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: identity } })).toString("base64url")}.e30`;
	const auth = {
		getAccountId: () => identity,
		getAccessToken: async () => token(),
		readStored: () => ({ access_token: token(), refresh_token: "16z-inflight-refresh", expires_at: Date.now() + 3600000 }),
		status: () => ({ signedIn: true }),
		onAuthChange: callback => { onAuthChange = callback; return () => {}; },
	};
	const codex = {
		// Deliberately distinct live catalogues for the old and new builds make
		// adopting the retired registry observable, even after its caller ends.
		listModels: async () => [{ slug: `gpt-16z-inflight-${gate.accounts[catalogueCalls++]}`, supported_reasoning_levels: ["medium"] }],
		parseQuotaHeaders: () => ({ primary: {}, credits: {} }),
	};
	const received = [];
	const fixture = createServer(async (req, res) => {
		const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const encoded = Buffer.concat(chunks);
		const body = JSON.parse(req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded) : encoded);
		received.push({ path: req.url, model: body.model });
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(encode({ type: "response.completed", response: { status: "completed" } }));
	});
	const fixtureUrl = await listen(fixture);
	const handler = createGatedHandler({ auth, codex, codexBaseUrl: fixtureUrl, handlers: [], liveHub: {} });
	const server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const origin = await listen(server);
	const getModels = async () => {
		const response = await fetch(`${origin}/agent/models`, { signal: AbortSignal.timeout(8000) });
		assert.equal(response.status, 200);
		return (await response.json()).models.filter(model => model.id.includes("gpt-16z-inflight")).map(model => model.id);
	};
	try {
		const staleCaller = getModels();
		await held;
		assert.deepEqual(gate.order, ["build-started:a"], "the first createModels promise has not settled");
		assert.equal(catalogueCalls, 0, "the old request is still in construction, before discovery");
		identity = "b";
		onAuthChange({ kind: "replaced" });
		gate.order.push("replaced:b");
		gate.release.resolve();
		assert.deepEqual(await staleCaller, ["openai-codex/gpt-16z-inflight-a"], "the already admitted caller may finish with its retired registry");
		assert.deepEqual(await getModels(), ["openai-codex/gpt-16z-inflight-b"], "a stale completion must not poison the next listing");
		assert.deepEqual(await getModels(), ["openai-codex/gpt-16z-inflight-b"]);
		assert.deepEqual(gate.accounts, ["a", "b"], "replacement causes exactly one new registry build");
		assert.equal(catalogueCalls, 2, "each identity's registry discovers its own catalogue once");
		assert.deepEqual(gate.order, ["build-started:a", "replaced:b", "build-settled:a", "build-started:b", "build-settled:b"]);
		const response = await fetch(`${origin}/agent/turn`, { method: "POST", body: JSON.stringify({ sessionId: "16z-inflight", text: "hello", model: "openai-codex/gpt-16z-inflight-b" }), signal: AbortSignal.timeout(8000) });
		assert.equal(response.status, 200);
		const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
		assert.equal(frames.some(frame => frame.type === "error"), false);
		assert.equal(frames.at(-1)?.type, "done");
		assert.deepEqual(received, [{ path: "/codex/responses", model: "gpt-16z-inflight-b" }]);
		assert.deepEqual(gate.accounts, ["a", "b"], "execution reuses the replacement registry");
		console.log(`PASS 16z identity in flight: ${gate.order.join(" -> ")}; stale caller=a, later listings/turn=b, builds=2, catalogues=2`);
	} finally { gate.release.resolve(); hooks.deregister(); await handler.close(); await close(server); await close(fixture); }
}

// #379 / 16m: identity changes retire the handler's catalogue registry too.
{
	let identity = "a";
	let onAuthChange;
	const calls = [];
	const token = () => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: identity } })).toString("base64url")}.e30`;
	const auth = {
		getAccessToken: async () => identity ? token() : null,
		readStored: () => identity ? ({ access_token: token(), refresh_token: "fixture-refresh", expires_at: Date.now() + 3600000 }) : undefined,
		status: () => ({ signedIn: !!identity }),
		onAuthChange: callback => { onAuthChange = callback; return () => {}; },
	};
	const codex = { listModels: async () => { calls.push(identity); return [{ slug: `gpt-16m-${identity}`, supported_reasoning_levels: ["medium"] }]; } };
	const handler = createAgentHandler({ auth, codex, handlers: [], liveHub: {} });
	const server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const origin = await listen(server);
	const getModels = async () => {
		const response = await fetch(`${origin}/agent/models`, { signal: AbortSignal.timeout(8000) });
		return { status: response.status, models: (await response.json()).models.filter(model => model.id.includes("gpt-16m")).map(model => model.id) };
	};
	try {
		const accountA = await getModels();
		assert.deepEqual(accountA.models, ["openai-codex/gpt-16m-a"]);
		assert.deepEqual(calls, ["a"]);
		identity = null;
		onAuthChange({ kind: "signed_out" });
		const signedOut = await getModels();
		assert.deepEqual(signedOut.models, [], "sign-out drops the previous account's live-only model");
		assert.deepEqual(calls, ["a"], "sign-out does not fetch a catalogue");
		identity = "b";
		onAuthChange({ kind: "replaced" });
		const accountB = await getModels();
		assert.deepEqual(accountB.models, ["openai-codex/gpt-16m-b"], "account replacement rebuilds the live catalogue registry");
		assert.deepEqual(calls, ["a", "b"], "account replacement fetches exactly the new account's catalogue");
		console.log("PASS 16m: identity changes rebuild the handler's catalogue registry");
	} finally { await handler.close(); await close(server); }
}

// Spec 5.2 #3: a provider that fails with a message-only 401 (no structured
// status) is recorded as the provider refusing the key, end to end.
{
	const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
	const { createModels } = await import("@earendil-works/pi-ai");
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	faux.setResponses([async () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 Unauthorized: invalid x-api-key" })]);
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models, fauxProvider: faux, liveHub: { command: async () => ({}) } });
	const server = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
	const url = await listen(server);
	try {
		const captured = [];
		const wire = [];
		const transport = createHttpTransport({ surface: "workflow", capture: (event, props) => keep(captured, event, props), fetchImpl: async (path, init) => {
			const response = await fetch(url + path, init);
			const copy = await response.clone().text(); wire.push(...[...copy.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])));
			return response;
		} });
		await transport.turn({ ...request, model: "faux/scripted", sessionId: "message-only-401" }, () => {});
		const sidecarCode = wire.find(({ event }) => event === "agent:turn_failed")?.props.failure_code;
		const browser = captured.find(({ event }) => event === "agent:turn_failed");
		console.log(`5.2#3 message-only 401: error frame code=${wire.find(({ type }) => type === "error")?.code} sidecar failure_code=${sidecarCode} browser ${browser?.event} failure_code=${browser?.props.failure_code}`);
		assert.equal(sidecarCode, "key_refused", "the sidecar names a provider key refusal in the closed set");
		assert.equal(browser?.props.failure_code, "key_refused", "the browser stores the provider key refusal, not auth or upstream");
	} finally { await handler.close(); await close(server); }
}

// Pre-admission refusals and provider errors map to one closed vocabulary on
// both sides; a message never decides the code.
{
	const { transportFailureCode, AGENT_FAILURE_CODES } = await import("../src/workflow/agent-failure-codes.js");
	const { failureCodeOf, agentFailureCode } = await import("../bin/agent/agent-failure-codes.mjs");
	const cases = [
		[{ code: "unauthorized", status: 401 }, "key_refused"], [{ code: "unauthorized" }, "key_refused"], [{ code: "unauthorized", status: 403 }, "key_refused"],
		[{ status: 401 }, "auth"], [{ code: "AUTH_REQUIRED", status: 403 }, "auth"], [{ code: "auth", status: 401 }, "auth"],
		[{ code: "rate_limit", status: 429 }, "rate_limited"], [{ status: 429 }, "rate_limited"],
		[{ code: "STALE_SCENE", status: 409 }, "stale_scene"], [{ code: "STALE_TARGET", status: 409 }, "stale_scene"],
		[{ code: "CAPABILITY_MISSING", status: 409 }, "capability_missing"], [{ code: "LIVE_HUB_UNAVAILABLE", status: 409 }, "capability_missing"],
		[{ code: "busy" }, "busy"], [{ code: "TARGET_BUSY", status: 409 }, "busy"],
		[{ status: 400 }, "invalid_request"], [{ code: "INVALID_CONTEXT", status: 400 }, "invalid_request"], [{ code: "AMBIGUOUS_TARGET", status: 409 }, "invalid_request"],
		[{ code: "overloaded", status: 529 }, "upstream"], [{ code: "upstream", status: 502 }, "upstream"], [{ code: "truncated" }, "upstream"], [{ status: 500 }, "upstream"], [{ code: "server_error" }, "upstream"],
		[new TypeError("offline"), "network"], [{ code: "ECONNRESET" }, "network"], [{ code: "ENOTFOUND" }, "network"],
		[Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), "network"], [{ name: "TypeError", status: 502 }, "upstream"],
		[{ code: "network" }, "network"], [{ code: "unknown" }, "unknown"], [{ code: "upstream", status: 400 }, "invalid_request"], [{ code: "overloaded", status: 429 }, "rate_limited"],
		[{ code: "constructor" }, "unknown"], [{ code: "entitlement" }, "unknown"], [{ message: "401 Unauthorized" }, "unknown"], [new Error("network down"), "unknown"], [{}, "unknown"],
	];
	for (const [input, expected] of cases) {
		assert.equal(transportFailureCode(input), expected, `browser ${JSON.stringify(input)}`);
		assert.equal(failureCodeOf(input), expected, `sidecar ${JSON.stringify(input)}`);
		assert.ok(AGENT_FAILURE_CODES.has(expected));
	}
	const live = new AbortController().signal;
	assert.equal(agentFailureCode({ status: 503 }, live, true), "tool_failed");
	assert.equal(agentFailureCode({ code: "unauthorized", status: 401 }, live, true), "key_refused");
	assert.equal(agentFailureCode(new DOMException("x", "AbortError"), live), "aborted");
	const foreign = Object.defineProperty({}, "status", { get() { throw new Error("foreign getter"); } });
	assert.equal(agentFailureCode(new TypeError("offline"), live, true), "tool_failed");
	assert.equal(agentFailureCode(new TypeError("offline"), live), "network");
	assert.equal(agentFailureCode({ code: "constructor" }, live), "unknown");
	assert.equal(transportFailureCode(foreign), "unknown"); assert.equal(failureCodeOf(foreign), "unknown");
	// A sidecar error frame carries the error's own code, else failureCodeOf: never a literal upstream.
	const { frameCodeOf } = await import("../bin/agent/agent-failure-codes.mjs");
	const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
	assert.equal(frameCodeOf({ code: "overloaded", status: 529 }), "overloaded", "a runner code is sent unchanged");
	assert.equal(frameCodeOf(foreign), "unknown");
	for (const [thrown, expected] of [[refused, "network"], [new Error("private x"), "unknown"], [{ status: 503 }, "upstream"]]) {
		const captured = [];
		const frame = { type: "error", code: frameCodeOf(thrown), message: "private sidecar failure", ...(Number.isInteger(thrown.status) ? { status: thrown.status } : {}) };
		const transport = createHttpTransport({ capture: (event, props) => keep(captured, event, props), fetchImpl: async () => new Response(encode(frame) + encode({ type: "done" })) });
		await transport.turn(request, () => {});
		assert.deepEqual(names(captured), ["agent:turn_requested", "agent:turn_failed"]);
		assert.equal(captured[1].props.failure_code, expected, `sidecar frame for ${thrown.name ?? "status"} reads ${expected} in the browser`);
	}
	for (const [status, body, expected] of [
		[409, { error: { code: "STALE_SCENE", message: "private moved" } }, "stale_scene"],
		[409, { error: { code: "CAPABILITY_MISSING", message: "private port 5184 in use" } }, "capability_missing"],
		[400, { error: "invalid request" }, "invalid_request"],
		[401, { error: { code: "AUTH_REQUIRED", message: "private" } }, "auth"],
		[502, { error: { code: "upstream", message: "private" } }, "upstream"],
	]) {
		const captured = [];
		await createHttpTransport({ surface: "studio", capture: (event, props) => keep(captured, event, props), fetchImpl: async () => Response.json(body, { status }) }).turn(request, () => {});
		assert.deepEqual(captured.at(-1), { event: "agent:turn_failed", props: { turn_id: captured[0].props.turn_id, duration_bucket: "lt1s", failure_code: expected } }, `refusal ${status}`);
	}
	const captured = [];
	await createHttpTransport({ capture: (event, props) => keep(captured, event, props), fetchImpl: async () => new Response(encode({ type: "error", code: "busy", message: "busy" }) + encode({ type: "done" })) }).turn(request, () => {});
	assert.equal(captured.at(-1).props.failure_code, "busy", "a turn already running is busy, not upstream");
	console.log("PASS failure codes: refusals, provider key refusal and busy map to the same closed codes in browser and sidecar");
}

// agent:turn_summary (one per turn, closed values) and the post-turn edit window, through the real HTTP transport.
const start = (callId) => ({ type: "tool.start", callId, name: "arrange_objects", label: "arrange objects", args: { secret: "private" } });
const done = (callId, extra = {}) => ({ type: "tool.done", callId, ok: true, elapsedMs: 5, result: {}, ...extra });
const refusedDone = (callId, code) => done(callId, { ok: false, error: `${code}: private message`, result: undefined });

let clock = 0;
/** One Studio turn: `frames(id)` are sent in order, each at the clock it names ({ at } entries move the clock). */
async function runTurn(script, { correlation = crypto.randomUUID(), captured = [], surface = "studio" } = {}) {
	clock = 0;
	const transport = createHttpTransport({ surface, now: () => clock, capture: (event, props) => captured.push({ event, props }),
		fetchImpl: async () => new Response(new ReadableStream({
			start(controller) {
				for (const item of script(correlation)) {
					if (Number.isFinite(item.at)) clock = item.at;
					else controller.enqueue(new TextEncoder().encode(encode(item)));
				}
				controller.close();
			},
		})) });
	await transport.turn({ surface: "studio", sessionId: "s", turnId: correlation, text: "private prompt", context: {} }, () => {});
	return { captured, correlation, summaries: captured.filter(({ event }) => event === "agent:turn_summary").map(({ props }) => props) };
}
// A pull-based clock: the transport reads `now` while it consumes frames, so a pull stream moves it between frames.
async function runTimedTurn(steps, options = {}) {
	clock = 0;
	const correlation = options.correlation ?? crypto.randomUUID();
	const queue = steps(correlation);
	const captured = options.captured ?? [];
	const transport = createHttpTransport({ surface: "studio", now: () => clock, capture: (event, props) => captured.push({ event, props }),
		fetchImpl: async () => new Response(new ReadableStream({
			pull(controller) {
				while (queue.length && Number.isFinite(queue[0].at)) clock = queue.shift().at;
				if (!queue.length) { controller.close(); return; }
				controller.enqueue(new TextEncoder().encode(encode(queue.shift())));
			},
		})) });
	await transport.turn({ surface: "studio", sessionId: "s", turnId: correlation, text: "private prompt", context: {} }, () => {});
	return { captured, correlation, summaries: captured.filter(({ event }) => event === "agent:turn_summary").map(({ props }) => props) };
}

// Counts, refusal_top, stale_retry, authored, first_tool, wall.
{
	const { summaries, captured } = await runTimedTurn((id) => [
		{ at: 12_000 }, start("a"), done("a", { autoRebased: true, result: { autoRebased: true } }),
		start("b"), refusedDone("b", "TARGET_BUSY"),
		start("c"), refusedDone("c", "STALE_SCENE"),
		start("d"), refusedDone("d", "STALE_SCENE"),
		start("e"), done("e", { result: { ok: false, code: "MADE_UP_CODE" } }),
		start("f"), done("f", { ok: false, error: "ABORTED: Stopped before this call finished." }),
		start("g"), done("g", { result: { ok: true, authored: true } }),
		done("g", { result: { ok: true, authored: true } }), start("g"),
		{ at: 70_000 }, terminal(id),
	]);
	assert.equal(summaries.length, 1);
	const [summary] = summaries;
	assert.deepEqual(summary, {
		turn_id: summary.turn_id, outcome: "succeeded", wall: "1-2m", tool_calls: "6-10", tool_failed: "4-5", refused: "4-5", refusal_top: "STALE_SCENE",
		stale_retry: "1", authored: true, first_tool: "10-30s", cancel_phase: "na", drafts: "0", qa_trend: "na", stuck: false,
	}, "duplicate start/done frames of one call count once; ABORTED is a failure, not a refusal; an unknown code reads other");
	assert.match(summary.turn_id, /^[a-f0-9]{32}$/);
	assert.deepEqual(sanitizeProps("agent:turn_summary", summary), summary, "the payload passes the closed schema unchanged");
	assert.ok(!JSON.stringify(captured).includes("private") && !JSON.stringify(summary).includes("arrange"), "no names, args or messages");
	closePostTurnWindow();
}

// refusal_top ties go to the first code seen; none without refusals; first_tool absent without tools; result_applied is authored.
{
	const tie = await runTurn((id) => [start("a"), refusedDone("a", "TARGET_BUSY"), start("b"), refusedDone("b", "SCOPE_DENIED"), terminal(id, "failed", "tool_failed")]);
	assert.equal(tie.summaries[0].refusal_top, "TARGET_BUSY");
	assert.equal(tie.summaries[0].outcome, "failed");
	const bare = await runTurn((id) => [{ type: "execution_telemetry", event: "agent:result_applied", props: { turn_id: id } }, terminal(id)]);
	assert.equal(bare.summaries[0].refusal_top, "none");
	assert.equal(bare.summaries[0].tool_calls, "0");
	assert.equal(Object.hasOwn(bare.summaries[0], "first_tool"), false, "no tool ran: no first_tool");
	assert.equal(bare.summaries[0].authored, true, "the turn's agent:result_applied marks it authored");
	closePostTurnWindow();
}

// cancel_phase: before_tool, during_tool, after_tool.
for (const [frames, phase] of [
	[() => [], "before_tool"],
	[() => [start("a")], "during_tool"],
	[() => [start("a"), done("a")], "after_tool"],
]) {
	const { summaries } = await runTurn((id) => [...frames(), terminal(id, "cancelled", "aborted")]);
	assert.equal(summaries[0].outcome, "cancelled");
	assert.equal(summaries[0].cancel_phase, phase);
	closePostTurnWindow();
}

// One summary per turn even with duplicate and conflicting terminal frames.
{
	const { summaries, captured } = await runTurn((id) => [terminal(id), terminal(id), terminal(id, "failed", "upstream"), terminal(id, "cancelled", "aborted"), start("late")]);
	assert.equal(summaries.length, 1);
	assert.equal(summaries[0].tool_calls, "0", "frames after the terminal are not counted");
	assert.deepEqual(captured.map(({ event }) => event), ["agent:turn_requested", "agent:turn_succeeded", "agent:turn_summary"]);
	closePostTurnWindow();
}

// Drafts keyed by the turn's correlation id: trend, first/last QA, stuck, and clearing.
for (const [drafts, expected] of [
	[[{ clean: false, problems: 3 }, { clean: false, problems: 1 }, { clean: true, problems: 0 }], { drafts: "3", qa_first: "problems", qa_last: "clean", qa_trend: "improved", stuck: false }],
	[[{ clean: false, problems: 1 }, { clean: false, problems: 4, stuck: true }], { drafts: "2", qa_first: "problems", qa_last: "problems", qa_trend: "worse", stuck: true }],
	[[{ clean: false, problems: 2 }, { clean: false, problems: 2 }], { drafts: "2", qa_first: "problems", qa_last: "problems", qa_trend: "flat", stuck: false }],
	[[{ clean: true, problems: 0 }], { drafts: "1", qa_first: "clean", qa_last: "clean", qa_trend: "na", stuck: false }],
]) {
	const correlation = crypto.randomUUID();
	noteTurnDraft(crypto.randomUUID(), { clean: true, problems: 0 });
	for (const draft of drafts) noteTurnDraft(correlation, draft);
	const { summaries } = await runTurn((id) => [terminal(id)], { correlation });
	const { turn_id: _id, outcome: _o, wall: _w, tool_calls: _t, tool_failed: _f, refused: _r, refusal_top: _rt, stale_retry: _s, authored: _a, cancel_phase: _c, ...rest } = summaries[0];
	assert.deepEqual(rest, expected);
	assert.deepEqual(sanitizeProps("agent:turn_summary", summaries[0]), summaries[0]);
	const again = await runTurn((id) => [terminal(id)], { correlation });
	assert.equal(again.summaries[0].drafts, "0", "the summary clears its turn's drafts");
	assert.equal(Object.hasOwn(again.summaries[0], "qa_first"), false);
	closePostTurnWindow();
}
// A turn that never finishes does not leak: only the newest 16 turns keep drafts.
{
	const first = crypto.randomUUID();
	noteTurnDraft(first, { clean: true, problems: 0 });
	for (let index = 0; index < 16; index += 1) noteTurnDraft(crypto.randomUUID(), { clean: true, problems: 0 });
	const { summaries } = await runTurn((id) => [terminal(id)], { correlation: first });
	assert.equal(summaries[0].drafts, "0", "the oldest unfinished turn's drafts were dropped");
	noteTurnDraft(undefined, { clean: true });
	closePostTurnWindow();
}

// The post-turn window opens at finish (every outcome) and the next turn's start closes it.
{
	const captured = [];
	const first = await runTurn((id) => [terminal(id, "failed", "upstream")], { captured });
	const firstId = first.summaries[0].turn_id;
	assert.equal(captured.some(({ event }) => event === "agent:post_turn_edit"), false, "the window is open, not yet sent");
	noteEditGesture("pose"); // the bus passes only the user's own edits (command-bus-telemetry.js)
	await runTurn((id) => [terminal(id, "cancelled", "aborted")], { captured });
	const names = captured.map(({ event }) => event);
	assert.deepEqual(names, ["agent:turn_requested", "agent:turn_failed", "agent:turn_summary", "agent:post_turn_edit", "agent:turn_requested", "agent:turn_cancelled", "agent:turn_summary"],
		"the next turn's start closes the previous window before its own request");
	const edit = captured[3].props;
	assert.equal(edit.turn_id, firstId, "the window carries the analytics turn id");
	assert.equal(edit.edited, true);
	assert.equal(edit.pose, "1", "the user's edit counts");
	assert.equal(edit.first_delay, "lt10s");
	const closed = closePostTurnWindow();
	assert.equal(closed.turn_id, captured[6].props.turn_id, "a cancelled turn opened its own window too");
	assert.equal(closed.edited, false);
	await runTurn((id) => [terminal(id, "failed", "upstream")], { captured, surface: "workflow" });
	assert.equal(closePostTurnWindow(), null, "a Workflow turn opens no post-turn window: no Studio edits follow it");
}

// Spec check #2, through the real sidecar route: a refused Studio call reaches the browser as tool.done { ok: false }
// whose error only leads with the code ("TARGET_NOT_READY: ..."); the summary reads that prefix.
{
	const { createFakeModel } = await import("./fixtures/fake-model.mjs");
	const { fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const hub = {
		command: async (name) => (name === "arrange_objects" ? { ok: false, code: "TARGET_NOT_READY", message: "private refusal", phase: "admission", recovery: { action: "none" } } : { revision: { scene: 41 }, entities: [] }),
		workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"],
	};
	const model = createFakeModel();
	model.fauxProvider.setResponses([
		async () => fauxAssistantMessage([fauxToolCall("arrange_objects", { ops: [{ op: "create", source: { kind: "chair" }, name: "Chair", position: { world: { x: -1.4, y: 0, z: 0 } } }] }, { id: "t1" })]),
		async () => fauxAssistantMessage([fauxText("It was refused.")]),
	]);
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: model.models, fauxProvider: model.fauxProvider, liveHub: hub, studioRuntime: { readContext: async () => contextFixture() } });
	const server = createServer((req, res) => handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const url = await listen(server);
	try {
		const captured = [], seen = [];
		const transport = createHttpTransport({ surface: "studio", capture: (event, props) => captured.push({ event, props }), fetchImpl: (path, init) => fetch(url + path, { ...init, headers: { ...init.headers, origin: url } }) });
		await transport.turn({ ...envelopeFixture(), turnId: crypto.randomUUID(), sessionId: crypto.randomUUID(), model: "faux/scripted" }, (event) => seen.push(event));
		const refusal = seen.find((event) => event.type === "tool.done");
		console.log(`spec #2 refused tool.done frame: ${JSON.stringify(refusal)}`);
		assert.equal(refusal.ok, false);
		assert.match(refusal.error, /^TARGET_NOT_READY: /, "the code rides only as the error's prefix");
		assert.equal(Object.hasOwn(refusal, "code"), false, "no structured code field on the frame");
		const summary = captured.find(({ event }) => event === "agent:turn_summary")?.props;
		assert.equal(summary?.refused, "1");
		assert.equal(summary.refusal_top, "TARGET_NOT_READY");
		assert.equal(summary.tool_failed, "1");
		assert.equal(summary.outcome, "succeeded", "the model answered after the refusal; the sidecar reports the turn as succeeded");
		assert.deepEqual(sanitizeProps("agent:turn_summary", summary), summary);
		assert.ok(!JSON.stringify(captured).includes("private"));
	} finally { closePostTurnWindow(); await handler.close(); await close(server); }
}

// PR A: agent:prompt_sent rides the real transport turn: the staged prompt, once, with the turn's own analytics id.
{
	const prompts = await import("../src/workflow/prompt-telemetry.js");
	let promptClock = 1_000_000;
	const restorePrompts = prompts.promptTelemetrySeam(() => promptClock);
	const captured = [];
	const SENTINEL = "QA_SENTINEL_PROMPT_TEXT";
	const send = async (text, via, outcome) => {
		prompts.stagePrompt(text, { via, model: "anthropic/claude-x" });
		await runTurn((id) => [terminal(id, outcome, outcome === "failed" ? "upstream" : undefined)], { captured });
		promptClock += 12_000;
	};
	prompts.noteDraftInput(); promptClock += 7000;
	await send(`${SENTINEL} make the actor walk to the door and wave`, "typed", "failed");
	await send(`${SENTINEL} make the actor walk to the door and wave`, "retry_button", "succeeded");
	prompts.noteDraftInput(); promptClock += 3000;
	await send(`${SENTINEL} make the actor run to the door and wave twice`, "typed", "succeeded");
	// A send that never staged (or staged too long ago) is no prompt event.
	await runTurn((id) => [terminal(id, "succeeded")], { captured });
	prompts.stagePrompt("stale prompt", { via: "typed" }); promptClock += 11_000;
	await runTurn((id) => [terminal(id, "succeeded")], { captured });
	const sent = captured.filter(({ event }) => event === "agent:prompt_sent").map(({ props }) => props);
	const requested = captured.filter(({ event }) => event === "agent:turn_requested").map(({ props }) => props.turn_id);
	assert.equal(sent.length, 3, "one agent:prompt_sent per staged send; none without one or for a stale one");
	assert.deepEqual(sent.map((props) => props.turn_id), requested.slice(0, 3), "each carries its own turn's analytics id");
	assert.deepEqual(sent.map((props) => [props.via, props.similarity, props.prev_outcome, props.gap, props.turn_index]), [
		["typed", "first", "none", "first", "1"], ["retry_button", "same", "failed", "10-30s", "2"], ["typed", "near", "succeeded", "10-30s", "3"],
	], "retry loop signals: similarity, the previous outcome and the gap");
	assert.deepEqual([sent[0].compose_ms, sent[1].compose_ms, sent[2].compose_ms], ["lt10s", undefined, "lt10s"], "compose time only for typed prompts");
	assert.equal(sent[0].provider, "anthropic");
	for (const props of sent) assert.deepEqual(sanitizeProps("agent:prompt_sent", props), props, "the payload is closed values only");
	assert.ok(!JSON.stringify(captured).includes(SENTINEL) && !JSON.stringify(captured).includes("door"), "no prompt text or word in any payload");
	// #1043: an openai-compatible prompt carries its server address's class, never the address; other providers none.
	assert.equal(Object.hasOwn(sent[0], "endpoint"), false, "no endpoint class outside openai-compatible");
	for (const [endpoint, expected] of [["local", "local"], ["lan", "lan"], ["hosted", "hosted"], [undefined, "unknown"], ["http://10.0.0.5:1234", "unknown"]]) {
		prompts.stagePrompt("hello", { via: "typed", model: "openai-compatible/qwen", endpoint });
		const props = prompts.takePrompt("a".repeat(32));
		assert.equal(props.endpoint, expected, `endpoint ${endpoint} -> ${expected}`);
		assert.deepEqual(sanitizeProps("agent:prompt_sent", props).endpoint, expected, "the class survives the closed schema");
	}
	assert.equal(sanitizeProps("agent:prompt_sent", { endpoint: "http://127.0.0.1:11434" }).endpoint, undefined, "an address never passes");
	restorePrompts();
}
console.log("PASS agent:prompt_sent: one per send on the real transport turn, its turn id, similarity/gap/prev_outcome, the openai-compatible endpoint class, and no text anywhere");
console.log("PASS agent:turn_summary: counts, refusal_top, stale_retry, authored, first_tool, cancel_phase, drafts trend and clearing, one per turn");
console.log("PASS post-turn window: opened at finish with the analytics turn id, closed by the next turn's start");

console.log("PASS Agent execution: browser ownership, refusal, failure, cancellation, retry, frame validation/dedupe, applied ack and fake-model HTTP/SSE");
