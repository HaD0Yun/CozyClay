#!/usr/bin/env node
// Token cost of a multi-turn Studio session. Every turn embeds a full
// <studio-context> and inspect_studio used to echo another one per call; both
// accumulated in the history the model is re-sent on every request. This runs
// a scripted four-turn session through the real route, runner and tools and
// asserts what the model actually receives:
//   - only the newest user turn carries the full context, older ones a stub;
//   - inspect_studio results carry a revision, never a whole context;
//   - the admission still follows the revision an inspect reports (no STALE_SCENE);
//   - the persisted history is untouched (the stub is applied per request).
// COZYCLAY_TOKENS_REPORT=1 prints the byte numbers; COZYCLAY_TOKENS_LEGACY=1 makes
// the fake editor answer inspect_studio the old way (embedded context) so the
// same scenario measures a pre-change tree.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-token-sessions-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
delete process.env.CLIPROXY_API_KEY; delete process.env.CLIPROXY_BASE_URL;
const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
const { createFakeModel } = await import("./fixtures/fake-model.mjs");
const { contextFixture, envelopeFixture, uuid } = await import("./verify-studio-agent-protocol.mjs");
const report = process.env.COZYCLAY_TOKENS_REPORT === "1", legacy = process.env.COZYCLAY_TOKENS_LEGACY === "1";
// What a provider would be sent: role and content (tool results also carry a
// `details` copy for the UI in pi's own messages; no provider payload includes it).
const wire = messages => messages.map(({ role, content }) => ({ role, content }));
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const requestBytes = call => bytes(wire(call.messages));

// A realistic context: a full entity page, an entity index and a command index.
const world = { revision: 41, stale: 0, applied: [] };
function context() {
	const c = contextFixture();
	c.revision = { scene: world.revision, physics: 9, view: 18 };
	c.entities = Array.from({ length: 24 }, (_, i) => i === 0 ? c.entities[0] : { id: `obj-${i}`, kind: "object", name: `Crate number ${i}`, token: `ot-${i}`, position: { x: i, y: 0, z: -i }, yawDeg: 15, rotationDeg: { x: 0, y: 15, z: 0 }, scale: { x: 1, y: 1, z: 1 }, libraryKind: "box", renderer: "primitive", color: "#a1b2c3" });
	c.entityPage = { returned: 24, total: 120, truncated: true, nextCursor: JSON.stringify([c.host.workspaceId, c.host.documentEpoch, c.host.sceneEpoch, 24]) };
	c.entityIndex = c.entities.map(({ id, kind, name, position }) => ({ id, kind, name, position })).concat(Array.from({ length: 96 }, (_, i) => ({ id: `idx-${i}`, kind: "object", name: `Indexed prop ${i}`, position: { x: i, y: 0, z: i } })));
	c.actionIndex = Array.from({ length: 90 }, (_, i) => ({ id: `scene.action${i}`, label: `Editor action number ${i}` }));
	return c;
}
const host = () => contextFixture().host;
const inspectResult = args => {
	const c = context(), payload = { scope: args.scope, entities: c.entities.slice(0, 12).map(({ id, kind, name, position }) => ({ id, kind, name, position })), total: 24, nextCursor: null };
	return legacy ? { context: c, ...payload } : { revision: c.revision, host: host(), ...payload };
};
const receipt = payload => ({ ok: true, commandId: payload.commandId, receiptId: `receipt-${world.revision}`, host: host(), status: "applied", authored: true, mutated: true, revision: { before: world.revision, after: world.revision + 1 },
	affectedIds: ["char-alex"], delta: [], checks: { coverage: "fixture" }, undo: { historyEntryId: `history-${world.revision}`, entries: 1, canUndoDirect: true }, warnings: [] });
const hub = {
	async command(name, payload) {
		if (name === "read_studio_context") return context();
		if (name === "inspect_studio") {
			// An edit by the user lands before this read; the next command must be
			// admitted at the revision this inspect reports.
			if (world.bumpBeforeInspect) { world.bumpBeforeInspect = false; world.revision += 1; }
			return inspectResult(payload);
		}
		if (payload.expectedRevision !== world.revision) { world.stale++; return { ok: false, code: "STALE_SCENE", message: "stale", commandId: payload.commandId, host: host(), phase: "admission", mutated: false, recovery: { action: "inspect", retryAllowed: true } }; }
		const done = receipt(payload); world.revision += 1; world.applied.push(payload.expectedRevision); return done;
	},
	workspaceId: () => host().workspaceId, resolveWorkspace: () => host().workspaceHandle, handleForWorkspaceId: () => host().workspaceHandle, connected: true, workspaceHandles: [host().workspaceHandle],
};
const update = x => ({ type: "toolCall", name: "arrange_objects", arguments: { ops: [{ op: "update", id: "char-alex", position: { world: { x, y: 0, z: 0 } } }] } });
const inspect = scope => ({ type: "toolCall", name: "inspect_studio", arguments: { scope } });
const turnsScript = [
	[inspect("entities"), inspect("document"), update(1), [{ type: "text", text: "turn one done" }]],
	[inspect("entities"), update(2), [{ type: "text", text: "turn two done" }]],
	// The editor's revision moves during this turn, between the inspect and the edit.
	[inspect("entities"), update(3), [{ type: "text", text: "turn three done" }]],
	[inspect("entities"), inspect("document"), update(4), [{ type: "text", text: "turn four done" }]],
];
const fake = createFakeModel();
fake.script(turnsScript.flat());
let server;
const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { listModels: async () => ["gpt-5"], parseQuotaHeaders: () => ({}) }, models: fake.models, fauxProvider: fake.fauxProvider, liveHub: hub,
	studioRuntime: { readContext: async () => context() }, port: () => server.address().port });
server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let cookie, callsBefore = 0;
const perTurn = [];
for (const [index] of turnsScript.entries()) {
	if (index === 2) world.bumpBeforeInspect = true;
	const envelope = { ...envelopeFixture(), context: context(), model: "faux/scripted", turnId: `00000000-0000-4000-8000-00000000010${index}`, text: `turn ${index + 1}: change the scene` };
	const response = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(envelope) });
	const body = await response.text();
	assert.equal(response.status, 200, body.slice(0, 300));
	cookie ??= response.headers.get("set-cookie")?.split(";")[0];
	assert.ok(!body.includes('"type":"error"'), `turn ${index + 1} streams no error frame: ${body.slice(0, 300)}`);
	perTurn.push(fake.calls.length - callsBefore); callsBefore = fake.calls.length;
}
server.close();
assert.deepEqual(perTurn, turnsScript.map(steps => steps.length), "every scripted model request ran");
assert.equal(world.stale, 0, "admission advanced through inspect revisions: no STALE_SCENE");
assert.deepEqual(world.applied, [41, 42, 44, 45], "each edit was admitted at the revision then live, including the one the user moved mid-turn");

const contextText = message => (Array.isArray(message.content) ? message.content : []).flatMap(part => part?.type === "text" ? [part.text] : []).filter(text => text.startsWith("<studio-context"));
const toolResults = call => call.messages.filter(message => message.role === "toolResult");
const fullContextBytes = Buffer.byteLength(JSON.stringify(context()));
const isStub = text => /(omitted|superseded)\/>/.test(text);
let total = 0, uncompacted = 0;
for (const [index, call] of fake.calls.entries()) {
	const texts = call.messages.flatMap(contextText), stubs = texts.filter(isStub);
	total += requestBytes(call);
	// What this request would weigh with every old context kept and every inspect result echoing one.
	uncompacted += requestBytes(call) + stubs.reduce((sum, stub) => sum + fullContextBytes - Buffer.byteLength(stub), 0)
		+ (legacy ? 0 : toolResults(call).filter(result => result.content.some(part => part.text?.includes('"scope"'))).length * fullContextBytes);
	if (legacy) continue;
	assert.equal(texts.length - stubs.length, 1, `request ${index + 1}: exactly one full studio-context`);
	assert.ok(!isStub(contextText(call.messages.filter(message => message.role === "user" && contextText(message).length).at(-1))[0]), `request ${index + 1}: the newest turn keeps its full context`);
	for (const stub of stubs) assert.match(stub, /^<studio-context superseded\/>/, "older turns carry the superseded marker");
}
if (!legacy) {
	for (const result of toolResults(fake.calls.at(-1))) {
		const text = result.content.map(part => part.text ?? "").join("");
		if (!text.includes('"scope"')) continue;
		const parsed = JSON.parse(text);
		assert.ok(!("context" in parsed), "inspect results embed no studio context");
		assert.ok(Number.isSafeInteger(parsed.revision?.scene), "inspect results carry the revision");
		assert.ok(text.length < 4000, `inspect result is the scope payload only (${text.length} B)`);
	}
	// The persisted history keeps every full context: stubs exist only in the request.
	const persisted = readFileSync(join(sessionDir, `${uuid}.jsonl`), "utf8");
	assert.equal((persisted.match(/<studio-context>/g) ?? []).length, 4, "persisted history keeps each turn's full context");
	assert.ok(!persisted.includes("omitted/>") && !persisted.includes("superseded/>"), "no stub is persisted");
	assert.ok(total < uncompacted * 0.5, `prompt bytes drop by more than half: ${total} vs ${uncompacted} uncompacted`);
}
if (report) console.log(JSON.stringify({ mode: legacy ? "legacy-inspect" : "compact", requests: fake.calls.length, totalPromptBytes: total, uncompactedEstimate: uncompacted, perRequestBytes: fake.calls.map(requestBytes), fullContextBytes }));
rmSync(sessionDir, { recursive: true, force: true });
console.log(`PASS studio session token cost: ${fake.calls.length} requests, ${total} prompt bytes${legacy ? " (legacy inspect)" : ""}`);
