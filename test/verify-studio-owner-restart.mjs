#!/usr/bin/env node
// A Studio turn refused before admission must not leave a session behind.
// After a sidecar restart the browser still holds the previous server's
// studio_owner cookie. The first turn can be refused (the editor is still
// reconnecting); if that refusal had already minted the session and its
// owner, the browser never received the new owner and every retry failed
// with 409 "Studio session owner mismatch" until the session aged out.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.COZYCLAY_AGENT_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "owner-repro-"));
delete process.env.CLIPROXY_API_KEY; delete process.env.CLIPROXY_BASE_URL;
const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
const { createFakeModel } = await import("./fixtures/fake-model.mjs");
const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
const fake = createFakeModel();
fake.script([{ type: "text", text: "ok" }, { type: "text", text: "ok" }, { type: "text", text: "ok" }, { type: "text", text: "ok" }, { type: "text", text: "ok" }, { type: "text", text: "ok" }]);
let failRead = true;
const hub = { command: async (name) => { if (name === "read_studio_context") { if (failRead) throw Object.assign(new Error("editor not connected yet"), { code: "LIVE_HUB_UNAVAILABLE" }); return contextFixture(); } return { ok: true }; }, workspaceId: () => contextFixture().host.workspaceId, resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"] };
let server;
const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { listModels: async () => ["gpt-5"], parseQuotaHeaders: () => ({}) }, models: fake.models, fauxProvider: fake.fauxProvider, liveHub: hub, port: () => server.address().port });
server = createServer((req, res) => handler(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500); res.end(e.message); }));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const env = envelopeFixture();
const turn = async (cookie, turnId) => { const r = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ ...env, model: "faux/scripted", turnId }) }); const body = await r.text(); return { status: r.status, setCookie: r.headers.get("set-cookie"), body: body.slice(0, 160) }; };
const stale = "studio_owner=from-the-previous-server";
const first = await turn(stale, "11111111-1111-4111-8111-111111111111");
assert.equal(first.status, 409);
assert.match(first.body, /LIVE_HUB_UNAVAILABLE/, "the refusal names the real cause");
failRead = false;
const second = await turn(stale, "22222222-2222-4222-8222-222222222222");
assert.equal(second.status, 200, `the retry with the previous server's cookie is admitted: ${second.body}`);
assert.match(second.setCookie ?? "", /studio_owner=/, "the admitted turn hands the browser its new owner");
const fresh = second.setCookie ? second.setCookie.split(";")[0] : stale;
const third = await turn(fresh, "33333333-3333-4333-8333-333333333333");
assert.equal(third.status, 200, "the next turn with the new owner is admitted");
const intruder = await turn(stale, "44444444-4444-4444-8444-444444444444");
assert.equal(intruder.status, 409, "a live session still refuses a different owner");
assert.match(intruder.body, /owner mismatch/);
// a second conversation in the same browser adopts the owner it already holds: its cookie must not lock out the first
const other = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin, cookie: fresh }, body: JSON.stringify({ ...env, sessionId: "55555555-5555-4555-8555-555555555555", model: "faux/scripted", turnId: "66666666-6666-4666-8666-666666666666" }) });
await other.text();
assert.equal(other.status, 200);
assert.equal((other.headers.get("set-cookie") ?? fresh).split(";")[0], fresh, "the new conversation keeps the browser's owner");
const back = await turn(fresh, "77777777-7777-4777-8777-777777777777");
assert.equal(back.status, 200, "the first conversation is still the browser's after the second one started");
server.close();
console.log("studio owner restart: a refused first turn leaves no session; the retry is admitted; a second conversation keeps the owner");
