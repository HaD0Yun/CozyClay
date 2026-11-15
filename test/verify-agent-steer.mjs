// Steering a running Workflow turn (#379): the text POSTed to
// /agent/turn/:turnId/steer must reach the NEXT model call's context, placed
// after the tool result the turn was blocked on — never before it, and never
// dropped. A running Studio turn is steerable by its session's cookie owner
// (#715); a turn that already ended answers 409 NO_ACTIVE_TURN; an unknown
// turnId is 404.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createAgentRunner } from "../bin/agent/agent-runner.mjs";
import { createFakeModel } from "./fixtures/fake-model.mjs";
import { withTurnControls } from "./fixtures/turn-controls.mjs";

const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-steer-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

function deferred() {
	let resolve;
	const promise = new Promise((res) => { resolve = res; });
	return { promise, resolve };
}

/** Read an SSE response, invoking `onEvent` as each event arrives (not after
 * the stream ends) so a test can act on the turn while it is still running. */
async function readSseEvents(response, onEvent) {
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const events = [];
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let index;
		while ((index = buffer.indexOf("\n\n")) !== -1) {
			const chunk = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const match = /^data: (.+)$/m.exec(chunk);
			if (!match) continue;
			const event = JSON.parse(match[1]);
			events.push(event);
			await onEvent?.(event);
		}
	}
	return events;
}

async function startServer(options) {
	let server;
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, port: () => server.address().port, ...options });
	server = createServer((req, res) => handler(req, res).catch((error) => { console.error(error.stack); if (!res.headersSent) { res.writeHead(500); res.end(error.message); } else if (!res.writableEnded) res.end(); }));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// --- happy path: steer mid-tool lands in the next model call's context, after the tool result ---
{
	const slow = deferred();
	const fauxMain = createFakeModel();
	fauxMain.script([{ type: "toolCall", id: "c1", name: "describe_workflow", arguments: {} }, "acknowledged"]);
	// A slow live-editor command, not a slow tool call — the fixed Workflow tool
	// set (bin/agent/agent-tools.mjs) has no room for custom tool names, so the
	// stall is on the command describe_workflow forwards to the live hub.
	const liveHub = { command: async (name) => { if (name === "get_graph") { await slow.promise; return { graph: {} }; } return {}; } };
	const { server, origin } = await startServer({ models: fauxMain.models, fauxProvider: fauxMain.fauxProvider, liveHub });
	const turnId = "b".repeat(32);
	const response = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ sessionId: "steer-happy", text: "run the slow tool", model: "faux/scripted", turn_id: turnId }) });
	let steerStatus = null, steerBody = null;
	const events = await readSseEvents(response, async (event) => {
		if (event.type !== "tool.start" || steerStatus !== null) return;
		const steerResponse = await fetch(`${origin}/agent/turn/${turnId}/steer`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ text: "actually, stop and summarize" }) });
		steerStatus = steerResponse.status;
		steerBody = await steerResponse.json();
		slow.resolve();
	});
	expect("the steer request is accepted while the tool is still running", steerStatus === 200, `status ${steerStatus}`);
	expect("the steer response acknowledges the queued message", steerBody?.ok === true && steerBody?.queued === true, JSON.stringify(steerBody));
	expect("the turn completes", events.some((event) => event.type === "done"));
	expect("exactly one tool ran before the turn ended", events.filter((event) => event.type === "tool.start").length === 1);
	assert.equal(fauxMain.calls.length, 2, "the tool result triggers exactly one further model call");
	const secondContext = fauxMain.calls[1];
	const messages = secondContext?.messages ?? [];
	const toolResultIndex = messages.findIndex((message) => message.role === "toolResult");
	const steerIndex = messages.findIndex((message) => JSON.stringify(message).includes("actually, stop and summarize"));
	expect("the second model call's context carries the tool result", toolResultIndex !== -1, JSON.stringify(messages));
	expect("the second model call's context carries the steer text", steerIndex !== -1, JSON.stringify(messages));
	expect("the steer text is positioned after the tool result", steerIndex > toolResultIndex, `toolResultIndex=${toolResultIndex} steerIndex=${steerIndex}`);
	await new Promise((resolve) => server.close(resolve));
	console.log("PASS steer mid-tool is delivered before the next model call, after the tool result");
}

// --- steer after the turn already ended -> 409 NO_ACTIVE_TURN ---
{
	const fauxMain = createFakeModel();
	fauxMain.script(["all done"]);
	const { server, origin } = await startServer({ models: fauxMain.models, fauxProvider: fauxMain.fauxProvider, handlers: [], liveHub: {} });
	const turnId = "c".repeat(32);
	const response = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ sessionId: "steer-done", text: "hi", model: "faux/scripted", turn_id: turnId }) });
	await response.text();
	const steerResponse = await fetch(`${origin}/agent/turn/${turnId}/steer`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ text: "too late" }) });
	const steerBody = await steerResponse.json();
	expect("steering a turn that already ended is refused", steerResponse.status === 409 && steerBody?.error?.code === "NO_ACTIVE_TURN", JSON.stringify(steerBody));
	await new Promise((resolve) => server.close(resolve));
	console.log("PASS steer after done answers 409 NO_ACTIVE_TURN");
}

// --- unknown turnId -> 404 ---
{
	const fauxMain = createFakeModel();
	const { server, origin } = await startServer({ models: fauxMain.models, fauxProvider: fauxMain.fauxProvider, handlers: [], liveHub: {} });
	const steerResponse = await fetch(`${origin}/agent/turn/${"d".repeat(32)}/steer`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ text: "hi" }) });
	expect("an unknown turnId is 404", steerResponse.status === 404, `status ${steerResponse.status}`);
	await new Promise((resolve) => server.close(resolve));
	console.log("PASS unknown turnId answers 404");
}

// --- Studio turnId: owner steers a running turn; others 403; ended 409 ---
// The fixture is copied from verify-agent-routes.mjs's own Studio group
// (envelopeFixture/contextFixture + a plain live-command stub). The model
// calls inspect_studio, whose live command stalls until the steer has landed.
{
	const { envelopeFixture, contextFixture } = await import("./verify-studio-agent-protocol.mjs");
	const slow = deferred();
	const fauxStudio = createFakeModel();
	fauxStudio.script([{ type: "toolCall", id: "s1", name: "inspect_studio", arguments: { scope: "scene" } }, "acknowledged"]);
	const fakeLive = withTurnControls({ command: async (name) => { if (name === "inspect_studio") { await slow.promise; return { context: { revision: { scene: 41 } } }; } return { assetId: "a1", objectId: "o1" }; } });
	const studioRuntime = { readContext: async () => contextFixture() };
	const { server, origin } = await startServer({ codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fauxStudio.models, fauxProvider: fauxStudio.fauxProvider, liveHub: fakeLive, studioRuntime });
	const envelope = envelopeFixture();
	const steer = (cookie) => fetch(`${origin}/agent/turn/${envelope.turnId}/steer`, { method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ text: "steer studio" }) });
	const turnResponse = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(envelope) });
	expect("the Studio fixture turn itself starts", turnResponse.status === 200, `status ${turnResponse.status}`);
	const cookie = turnResponse.headers.get("set-cookie")?.split(";")[0];
	let anonymous = null, owned = null, ownedBody = null;
	const events = await readSseEvents(turnResponse, async (event) => {
		if (event.type !== "tool.start" || owned !== null) return;
		anonymous = await steer(null);
		owned = await steer(cookie);
		ownedBody = await owned.json();
		slow.resolve();
	});
	expect("a Studio steer without the owner cookie is 403 AUTH_REQUIRED", anonymous?.status === 403 && (await anonymous.json())?.error?.code === "AUTH_REQUIRED", `status ${anonymous?.status}`);
	expect("the owner's Studio steer is accepted while the tool runs", owned?.status === 200 && ownedBody?.ok === true && ownedBody?.queued === true, JSON.stringify(ownedBody));
	expect("the Studio turn completes", events.some((event) => event.type === "done"));
	const steered = fauxStudio.calls[1]?.messages ?? [];
	const toolResultIndex = steered.findIndex((message) => message.role === "toolResult");
	const steerIndex = steered.findIndex((message) => JSON.stringify(message).includes("steer studio"));
	expect("the Studio steer text reaches the next model call after the tool result", toolResultIndex !== -1 && steerIndex > toolResultIndex, `toolResultIndex=${toolResultIndex} steerIndex=${steerIndex}`);
	const late = await steer(cookie);
	const lateBody = await late.json();
	expect("steering a Studio turn that already ended is 409 NO_ACTIVE_TURN", late.status === 409 && lateBody?.error?.code === "NO_ACTIVE_TURN", JSON.stringify(lateBody));
	await new Promise((resolve) => server.close(resolve));
	console.log("PASS a Studio turn is steerable by its owner, 403 without the cookie, 409 after it ended");
}

// --- a Studio turn running past the 10-minute idle window keeps its session ---
// Pruning (on any new Studio turn) used to drop a session by its age alone, so a turn still running lost its owner
// token and event history and its steer answered 404. A session with a running turn is never pruned.
{
	const { envelopeFixture, contextFixture } = await import("./verify-studio-agent-protocol.mjs");
	const slow = deferred();
	let now = 1_000_000;
	const fauxStudio = createFakeModel();
	fauxStudio.script([{ type: "toolCall", id: "p1", name: "inspect_studio", arguments: { scope: "scene" } }, "other session done", "long turn done"]);
	const fakeLive = withTurnControls({ command: async (name) => { if (name === "inspect_studio") { await slow.promise; return { context: { revision: { scene: 41 } } }; } return { assetId: "a1", objectId: "o1" }; } });
	const { server, origin } = await startServer({ codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fauxStudio.models, fauxProvider: fauxStudio.fauxProvider, liveHub: fakeLive, studioRuntime: { readContext: async () => contextFixture() }, clock: () => now });
	const envelope = envelopeFixture(), other = { ...envelopeFixture(), sessionId: "00000000-0000-4000-8000-000000000003", turnId: "00000000-0000-4000-8000-000000000004", text: "another session" };
	const post = (body) => fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
	const turnResponse = await post(envelope);
	const cookie = turnResponse.headers.get("set-cookie")?.split(";")[0];
	let steered = null;
	const events = await readSseEvents(turnResponse, async (event) => {
		if (event.type !== "tool.start" || steered !== null) return;
		now += 11 * 60_000;
		await (await post(other)).text();
		steered = await fetch(`${origin}/agent/turn/${envelope.turnId}/steer`, { method: "POST", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify({ text: "still here" }) });
		slow.resolve();
	});
	expect("a Studio turn running 11 minutes is still steerable by its owner after another turn prunes", steered?.status === 200, `status ${steered?.status}`);
	expect("the long Studio turn completes", events.some((event) => event.type === "done"));
	await new Promise((resolve) => server.close(resolve));
	console.log("PASS a session with a running Studio turn survives pruning");
}

// --- the runner's own default clock must be callable with no injected clock ---
// `clock = performance.now` (an unbound method reference) throws ERR_INVALID_THIS
// the instant a tool_start/tool_end handler calls it; every real caller
// (agent-routes.mjs) injects Date.now, so only createAgentRunner()'s OWN
// default ever exercises this path.
{
	const fauxTool = createFakeModel();
	fauxTool.script([{ type: "toolCall", id: "t1", name: "ping", arguments: {} }, "done"]);
	const tools = [{ name: "ping", parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => ({ ok: true }) }];
	const runner = createAgentRunner({ models: fauxTool.models, fauxProvider: fauxTool.fauxProvider, tools });
	const session = await runner.openSession("clock-default", { surface: "workflow" });
	const frames = [];
	for await (const frame of session.start({ text: "run ping", model: "faux/scripted" })) frames.push(frame);
	await runner.close();
	const toolStart = frames.find((frame) => frame.type === "tool.start");
	const toolDone = frames.find((frame) => frame.type === "tool.done");
	expect("createAgentRunner() with no injected clock still emits tool.start", Boolean(toolStart), JSON.stringify(frames));
	expect("...and a tool.done with a finite elapsedMs", toolDone && Number.isFinite(toolDone.elapsedMs), JSON.stringify(toolDone));
}

process.exit(failures === 0 ? 0 : 1);
