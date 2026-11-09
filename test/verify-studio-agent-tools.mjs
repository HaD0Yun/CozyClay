#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { startLiveHub } from "../mcp/live-hub.mjs";
import { STUDIO_TOOL_FAMILIES, STUDIO_TOOLS } from "../src/studio-agent-protocol.js";
import { studioToolSchemas, studioToolResult } from "../bin/agent/studio-tools.mjs";
import { createFakeModel } from "./fixtures/fake-model.mjs";
import { fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { WebSocket } = createRequire(new URL("../mcp/package.json", import.meta.url))("ws");
// Sessions this suite drives through the routes stay in a scratch dir, never
// in the author's History (#375).
const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-sessions-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
process.on("exit", () => rmSync(sessionDir, { recursive: true, force: true }));

const CASES = new Set(["studio-tool-catalogue", "storyboard-tool-surface", "surface-context-and-images", "stale-host-and-post-install-rate-limit", "sequential-mutations-revision-chain", "external-revision-bump-refuses", "sequential-same-target-token-rotation", "rejection-receipt-surfaces-reason", "inspect-readmits-revision", "stale-scene-readmits-revision", "uncertain-apply-readmits-revision", "run-action-admission", "stale-scene-readmits-any-family", "run-action-job-timeout", "verify-motion-timeout", "scene-change-readmits-host"]);
const index = process.argv.indexOf("--case");
const selected = index >= 0 ? process.argv[index + 1] : null;
if (selected && !CASES.has(selected)) { console.error(`unknown --case ${selected}`); process.exit(2); }
const shouldRun = name => !selected || selected === name;
// The command index the editor puts in the turn context, built from the
// declarations its registry registers.
const declaredActionIndex = async () => (await import("../src/studio-agent-context.js")).studioActionIndex((await import("../src/studio-actions.js")).STUDIO_ACTIONS);
const uuid = () => randomUUID();
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const host = (handle = "handle-12", workspaceId = "tab-7") => ({ surface: "studio", workspaceId, workspaceHandle: handle, documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" });
function context(binding = host(), sceneRevision = 1) {
  return { schema: "studio-context-v1", host: binding, revision: { scene: sceneRevision, physics: 1, view: 1 }, units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", pivot: "base", fps: 24, rangeEnd: "exclusive" }, scene: { name: "Workshop", aspect: "16:9", floorY: 0, frameCount: 48, objectCount: 0, characterCount: 1 }, selection: { kind: "character", id: "char-alex" }, activeCharacterId: "char-alex", view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: false, autoColor: false }, shot: null, camera: null, entities: [{ id: "char-alex", kind: "character", token: "ct-11", position: { x: 0, y: 0, z: 0 }, yawDeg: 0, scale: 1, bounds: null, motion: { takeId: null, frames: 48, ikKeyCount: 0 }, capabilities: { rigReady: true, ik: true, measuredFeet: true } }], entityPage: { returned: 1, total: 1, truncated: false, nextCursor: null }, shots: [], shotsTruncated: false, assets: [], recentReceipts: [], jobs: [], capabilities: { profile: "studio-slice-1", tools: [...STUDIO_TOOL_FAMILIES], rigReady: true, cameraReady: false, bridgeReady: true } };
}
const envelope = (binding = host(), text = "inspect") => ({ surface: "studio", sessionId: uuid(), turnId: uuid(), text, context: context(binding) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fixture event deadline")), 10000); })]); } finally { clearTimeout(timer); } }

async function liveFixture({ bridge = null, command = null } = {}) {
  const hub = await startLiveHub(0); assert.ok(hub);
  const socket = new WebSocket(`ws://127.0.0.1:${hub.server.address().port}/live`);
  const ready = deferred();
  socket.on("message", raw => { const frame = JSON.parse(raw); if (frame.type === "workspace") ready.resolve(frame.handle); else if (frame.type === "cmd") void (async () => { const value = await command(frame.name, frame.args); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value })); })(); });
  await once(socket, "open"); socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: "tab-7" }));
  const handle = await bounded(ready.promise);
  return { hub, socket, handle, async close() { socket.terminate(); for (const peer of hub.server.clients) peer.terminate(); await new Promise(resolve => hub.server.close(resolve)); if (bridge) await new Promise(resolve => bridge.close(resolve)); } };
}
async function httpFixture({ modelResponse, live, getBridgeOrigin = () => null, clock = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  const auth = { getAccessToken: async () => "fixture-token" };
  const fakeModel = createFakeModel();
  const convertInput = (message) => {
    // the prompt and tool declarations travel in pi's system messages; the fixture passes tools separately
    if (message.role === "system") return [];
    if (message.role === "user") return { role: "user", content: (Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]).map((part) => part.type === "image" ? { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` } : { type: "input_text", text: part.text }) };
    if (message.role === "assistant") return { type: "message", role: "assistant", content: (message.content || []).filter((part) => part.type === "text").map((part) => ({ type: "output_text", text: part.text })) };
    if (message.role === "toolResult") {
      const image = message.content?.find((part) => part.type === "image");
      return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content?.find((part) => part.type === "text")?.text || "" }, ...(image ? [{ role: "user", content: [{ type: "input_text", text: "Studio image observation" }, { type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` }] }] : [])];
    }
    return message;
  };
  const fauxResponse = async (context) => {
    const items = await modelResponse({ input: (context.messages || []).flatMap(convertInput), tools: studioToolSchemas() });
    const content = [];
    for (const item of items) {
      if (item.type === "response.output_text.delta") content.push(fauxText(item.delta));
      if (item.type === "response.output_item.done") {
        if (item.item.type === "function_call") content.push(fauxToolCall(item.item.name, JSON.parse(item.item.arguments || "{}"), { id: item.item.call_id }));
        else if (item.item.type === "message") for (const part of item.item.content || []) if (part.type === "output_text") content.push(fauxText(part.text));
      }
    }
    return fauxAssistantMessage(content.length ? content : [fauxText("")]);
  };
  fakeModel.fauxProvider.setResponses(Array.from({ length: 128 }, () => fauxResponse));
  const handler = createAgentHandler({ auth, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider, liveHub: live.hub, getBridgeOrigin, clock, setIntervalImpl, clearIntervalImpl, port: () => server.address().port });
  const server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) { res.writeHead(500); res.end(error.stack); } }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, cookie = null, signal) => { const response = await fetch(`${origin}/agent/turn`, { method: "POST", signal: signal ?? AbortSignal.timeout(10000), headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }); return { response, text: await response.text(), cookie: response.headers.get("set-cookie")?.split(";")[0] ?? cookie }; };
  return { handler, server, origin, post, async close() { await handler.close(); await new Promise(resolve => server.close(resolve)); } };
}
function streamOf(items) { return items.map((item) => ({ type: "response.output_item.done", item })); }

for (const scenario of ["inspect-readmits-revision", "stale-scene-readmits-revision", "uncertain-apply-readmits-revision"]) {
  if (!shouldRun(scenario)) continue;
  const { createStudioTools } = await import("../bin/agent/studio-tools.mjs");
  const { LiveMutationUncertainError } = await import("../mcp/live-hub.mjs");
  let revision = 1, uncertain = false, refreshes = 0;
  const sent = [];
  const admission = { host: host(), revision: 1, commandId: uuid };
  const args = { ops: [{ op: "update", id: "cube", position: { world: { x: 1, y: 0, z: 0 } } }] };
  const liveHub = { async command(name, payload, handle) {
    assert.equal(handle, "handle-12");
    if (name === "inspect_studio") return { revision: { scene: revision } };
    sent.push(structuredClone(payload));
    if (payload.expectedRevision !== revision) {
      if (scenario === "stale-scene-readmits-revision") return { ok: false, code: "STALE_SCENE", message: "Authored scene revision changed." };
      throw new Error(`unexpected revision ${payload.expectedRevision}; live is ${revision}`);
    }
    const before = revision;
    revision++;
    if (uncertain) {
      uncertain = false;
      throw new LiveMutationUncertainError("Editor applied but acknowledgement timed out.");
    }
    return { ok: true, status: "applied", revision: { before, after: revision } };
  } };
  admission.refresh = async () => { refreshes++; const read = await liveHub.command("inspect_studio", { scope: "scene" }, "handle-12"); admission.revision = read.revision.scene; };
  const invoke = createStudioTools({ liveHub, workspaceHandle: "handle-12", session: { admission } }).internal.invoke;
  await invoke("arrange_objects", args);
  assert.equal(admission.revision, 2);
  if (scenario === "inspect-readmits-revision") {
    revision = 3;
    await invoke("inspect_studio", { scope: "scene" });
    await invoke("arrange_objects", args);
    assert.deepEqual(sent.map(payload => payload.expectedRevision), [1, 3]);
    assert.equal(refreshes, 0);
  } else if (scenario === "stale-scene-readmits-revision") {
    revision = 3;
    await assert.rejects(invoke("arrange_objects", args), { code: "STALE_SCENE" });
    assert.equal(refreshes, 1);
    await invoke("arrange_objects", args);
    assert.deepEqual(sent.map(payload => payload.expectedRevision), [1, 2, 3]);
  } else {
    uncertain = true;
    await assert.rejects(invoke("arrange_objects", args), { code: "UNCERTAIN_APPLY" });
    assert.equal(refreshes, 1);
    assert.equal(admission.revision, 3);
    await invoke("arrange_objects", args);
    assert.deepEqual(sent.map(payload => payload.expectedRevision), [1, 2, 3]);
  }
  console.log(`PASS ${scenario}`);
}

if (shouldRun("stale-scene-readmits-any-family")) {
  const { createStudioTools } = await import("../bin/agent/studio-tools.mjs");
  // A STALE_SCENE re-admits whichever family reported it and however it
  // arrived: as a rejection receipt or as a thrown error.
  const calls = [["verify_result", { receiptId: "receipt-1", checks: ["placement"] }], ["operate_studio", { frame: 3 }], ["inspect_studio", { scope: "scene" }]];
  for (const shape of ["receipt", "thrown"]) {
    for (const [name, args] of calls) {
      let live = 7, refreshes = 0;
      const admission = { host: host(), revision: 5, commandId: uuid, refresh: async () => { refreshes++; admission.revision = live; } };
      const liveHub = { async command() {
        if (shape === "thrown") throw Object.assign(new Error("Authored state changed; obtain fresh intent."), { code: "STALE_SCENE" });
        return { ok: false, code: "STALE_SCENE", phase: "admission", mutated: false, recovery: { action: "inspect", retryAllowed: false } };
      } };
      const invoke = createStudioTools({ liveHub, workspaceHandle: "handle-12", session: { admission } }).internal.invoke;
      await assert.rejects(invoke(name, args), { code: "STALE_SCENE" });
      assert.deepEqual({ refreshes, revision: admission.revision }, { refreshes: 1, revision: live }, `a ${shape} STALE_SCENE from ${name} re-admits at the live revision`);
    }
  }
  console.log("PASS a STALE_SCENE from any Studio family, receipt or thrown, re-admits the live revision");
}

if (shouldRun("studio-tool-catalogue")) {
  const { createStudioTools, studioToolSchemas } = await import("../bin/agent/studio-tools.mjs");
  const families = ["inspect_studio", "operate_studio", "arrange_objects", "arrange_characters", "patch_elements", "frame_shot", "verify_result", "undo_edit", "run_action"];
  assert.deepEqual([...STUDIO_TOOL_FAMILIES], ["inspect_studio", "run_action", "verify_result"]);
  assert.deepEqual([...STUDIO_TOOLS], families, "the primary tools and compatibility aliases remain callable");
  assert.deepEqual(studioToolSchemas().map(tool => tool.name), families);
  const sent = [];
  const tools = createStudioTools({ liveHub: { command: async (name, payload) => { sent.push({ name, payload }); return { ok: true, commandId: payload.commandId, receiptId: "receipt-1", status: "applied", revision: { before: 1, after: 2 } }; } }, workspaceHandle: "handle-1",
    session: { admission: { commandId: () => "cmd-1", host: { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" }, revision: 1, refresh: async () => {} } } });
  assert.deepEqual(tools.map(tool => tool.name), families);
  assert.ok(tools.every(tool => tool.parameters?.type === "object"));
  assert.match(studioToolSchemas().find(tool => tool.name === "verify_result").description, /pass exactly one of receiptId or targets/i);
  await tools.find(tool => tool.name === "patch_elements").handler({ ops: [{ target: { kind: "stage" }, set: { "keyLight.intensity": 2 } }] });
  // A mutation family carries the admission envelope, or a timeout would lose
  // its UNCERTAIN_APPLY meaning downstream.
  assert.equal(sent[0].name, "patch_elements");
  assert.equal(sent[0].payload.commandId, "cmd-1");
  assert.equal(sent[0].payload.expectedRevision, 1);
  // Mutation tool descriptions must teach receipt semantics: dropped paths,
  // landed delta values, and STALE_SCENE inspect-then-resubmit recovery.
  const mutations = ["operate_studio", "arrange_objects", "arrange_characters", "patch_elements", "frame_shot", "verify_result", "undo_edit", "run_action"];
  for (const tool of studioToolSchemas()) {
    if (!mutations.includes(tool.name)) continue;
    assert.ok(tool.description.includes("droppedPaths"), `${tool.name} description names ops[].droppedPaths`);
    assert.ok(tool.description.includes("delta[].after"), `${tool.name} description names the landed delta[].after value`);
    assert.ok(tool.description.includes("STALE_SCENE"), `${tool.name} description explains STALE_SCENE`);
    assert.ok(/inspect_studio/.test(tool.description) && /resubmit|re-?issue/i.test(tool.description), `${tool.name} description teaches inspect-then-resubmit for STALE_SCENE`);
  }
  // A partial receipt parses back with its dropped paths and the value that
  // actually landed in delta[].after, unabridged.
  const partial = { ok: true, commandId: "cmd-1", receiptId: "receipt-1", host: host(), status: "partial", authored: true, revision: { before: 1, after: 2 }, affectedIds: ["cube-24"],
    delta: [{ id: "cube-24", after: { patched: [{ path: "object.scale", vec: { x: 0.24, y: 0.1, z: 0.5 } }] } }],
    checks: { coverage: "declared-element-readback" }, undo: { historyEntryId: "h-1", entries: 1, canUndoDirect: true }, warnings: [], ops: [{ index: 0, status: "partial", droppedPaths: ["object.scale"] }] };
  const rendered = studioToolResult(partial);
  const parsed = JSON.parse(rendered);
  assert.deepEqual(parsed.ops[0].droppedPaths, ["object.scale"]);
  assert.equal(parsed.delta[0].after.patched.find(p => p.path === "object.scale").vec.y, 0.1);
  assert.ok(rendered.length < 8000, "sanity: this fixture is far under the 8000-byte receipt cap");
  console.log("PASS the Studio tool list is exactly the nine families and patch_elements is admitted");
}

if (shouldRun("storyboard-tool-surface")) {
  const { createStudioTools } = await import("../bin/agent/studio-tools.mjs");
  const { STUDIO_ACTIONS } = await import("../src/studio-actions.js");
  const { studioActionIndex } = await import("../src/studio-agent-context.js");
  const liveHub = { command: async () => ({ ok: true, status: "applied", revision: { before: 1, after: 2 } }) };
  const session = { admission: { commandId: () => "cmd-1", host: host(), revision: 1, refresh: async () => {} } };
  const storyboardTools = createStudioTools({ liveHub, workspaceHandle: "handle-1", previsMode: "storyboard", session });
  const animationTools = createStudioTools({ liveHub, workspaceHandle: "handle-1", previsMode: "animation", session });
  assert.deepEqual(storyboardTools.map(tool => tool.name), STUDIO_TOOLS);
  assert.deepEqual(animationTools.map(tool => tool.name), STUDIO_TOOLS);
  const storyboardActions = studioActionIndex(STUDIO_ACTIONS, { previsMode: "storyboard" });
  const animationActions = studioActionIndex(STUDIO_ACTIONS, { previsMode: "animation" });
  assert(!storyboardActions.some(action => action.generation === "motion" || action.id.startsWith("motion.")));
  assert.deepEqual(animationActions, studioActionIndex(STUDIO_ACTIONS));
  console.log("PASS storyboard tools and actions match animation, with no motion actions in the catalogue");
}

if (shouldRun("run-action-admission")) {
  const { createStudioTools } = await import("../bin/agent/studio-tools.mjs");
  const { LiveHub } = await import("../mcp/live-hub.mjs");
  // The hub treats a lost run_action acknowledgement as a possibly applied mutation.
  assert.equal(LiveHub.commandMayMutate("run_action"), true);
  assert.equal(LiveHub.commandTimeoutMs("run_action"), 30_000);
  const sent = []; let commandNumber = 0;
  const admission = { commandId: () => `cmd-${++commandNumber}`, host: { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" }, revision: 4, refresh: async () => {} };
  const liveHub = { command: async (name, payload) => {
    sent.push({ name, payload });
    return { ok: true, commandId: payload.commandId, receiptId: `receipt-${commandNumber}`, status: "applied", action: payload.args.action, revision: { before: admission.revision, after: admission.revision + 1 } };
  } };
  const tools = createStudioTools({ liveHub, workspaceHandle: "handle-1", session: { admission, actionIndex: await declaredActionIndex() } });
  const run = tools.find(tool => tool.name === "run_action");
  assert.ok(run, "run_action is an agent tool");
  const applied = await run.handler({ action: "shot.create", args: {} });
  assert.equal(applied.status, "applied");
  // run_action is admitted like every other mutation family.
  assert.deepEqual(sent[0], { name: "run_action", payload: { name: "run_action", args: { action: "shot.create", args: {} }, commandId: "cmd-1", host: admission.host, expectedRevision: 4 } });
  assert.equal(admission.revision, 5, "the receipt's revision admits the next command");
  await assert.rejects(run.handler({ action: "shot create" }), { code: "INVALID_ARGUMENT" });
  assert.equal(sent.length, 1, "a malformed action never reaches the editor");
  console.log("PASS run_action is admitted as a mutation");
}

if (shouldRun("run-action-job-timeout")) {
  const { createStudioTools } = await import("../bin/agent/studio-tools.mjs");
  const { MAX_COMMAND_TIMEOUT_MS } = await import("../mcp/live-hub.mjs");
  const { STUDIO_ACTIONS } = await import("../src/studio-actions.js");
  // A long-running action carries its declared timeout through the hub, which
  // bounds it by MAX_COMMAND_TIMEOUT_MS; every other command keeps the default.
  const declared = STUDIO_ACTIONS.filter(action => action.timeoutMs !== undefined);
  assert.ok(declared.some(action => action.id === "export.shotVideo"), "the shot video export declares its timeout");
  for (const action of declared) assert.ok(action.timeoutMs <= MAX_COMMAND_TIMEOUT_MS, `${action.id} fits the hub ceiling`);
  const calls = []; let commandNumber = 0;
  const admission = { commandId: () => `cmd-${++commandNumber}`, host: { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" }, revision: 4, refresh: async () => {} };
  const liveHub = { command: async (name, payload, handle, ...options) => {
    calls.push({ action: payload.args.action, options });
    if (payload.args.action === "export.shotVideo") return { ok: true, commandId: payload.commandId, action: "export.shotVideo", kind: "job", status: "completed", affectedIds: [], summary: "Exported.", output: { fileName: "cozyclay-shot.mp4", frameCount: 24 } };
    return { ok: true, commandId: payload.commandId, receiptId: "receipt-1", status: "applied", action: payload.args.action, revision: { before: admission.revision, after: admission.revision + 1 } };
  } };
  const run = createStudioTools({ liveHub, workspaceHandle: "handle-1", session: { admission, actionIndex: await declaredActionIndex() } }).find(tool => tool.name === "run_action");
  assert.deepEqual((await run.handler({ action: "export.shotVideo" })).output, { fileName: "cozyclay-shot.mp4", frameCount: 24 });
  await run.handler({ action: "shot.create" });
  assert.deepEqual(calls, [{ action: "export.shotVideo", options: [{ timeoutMs: 300_000 }] }, { action: "shot.create", options: [] }]);
  console.log("PASS a long-running run_action carries its declared hub timeout");
}

if (shouldRun("verify-motion-timeout")) {
  const { createStudioTools } = await import("../bin/agent/studio-tools.mjs");
  const { MAX_COMMAND_TIMEOUT_MS } = await import("../mcp/live-hub.mjs");
  // A motion check samples the whole take in the editor, which runs for
  // minutes on a long take: it waits under the hub ceiling. Placement and
  // framing are one-frame checks and keep the Studio default.
  const calls = []; let commandNumber = 0;
  const admission = { commandId: () => `cmd-${++commandNumber}`, host: { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" }, revision: 4, refresh: async () => {} };
  const liveHub = { command: async (name, payload, handle, ...options) => {
    calls.push({ checks: payload.args.checks, options });
    return { receiptId: null, revision: admission.revision, evidenceRevision: admission.revision, stale: false, checks: { coverage: "current-scene-targets" }, verification: null, semanticStatus: "unavailable", visualRefs: [], unsupportedChecks: [], unsupportedReasons: {} };
  } };
  const verify = createStudioTools({ liveHub, workspaceHandle: "handle-1", session: { admission } }).find(tool => tool.name === "verify_result");
  await verify.handler({ targets: ["char-a"], checks: ["motion"] });
  await verify.handler({ targets: ["char-a"], checks: ["placement", "framing"] });
  assert.deepEqual(calls, [{ checks: ["motion"], options: [{ timeoutMs: MAX_COMMAND_TIMEOUT_MS }] }, { checks: ["placement", "framing"], options: [] }]);
  console.log("PASS a verify_result motion check waits under the hub ceiling");
}

if (shouldRun("scene-change-readmits-host")) {
  const { createStudioTools } = await import("../bin/agent/studio-tools.mjs");
  // The editor admits a command only at its open scene. A scene action that
  // moves it answers the new host; the turn adopts it (same workspace only),
  // so the next edit in the same message is admitted instead of STALE_SCENE.
  const identity = (sceneId, sceneEpoch, workspaceId = "tab-7") => ({ workspaceId, documentEpoch: "doc-3", sceneId, sceneEpoch });
  let open = identity("scene-main", "scene-open-4"), revision = 4; const sent = [];
  const liveHub = { async command(name, payload) {
    if (JSON.stringify(payload.host) !== JSON.stringify(open)) return name === "read_studio_context" ? Promise.reject(Object.assign(new Error("This is not the requested document."), { code: "STALE_SCENE" })) : { ok: false, code: "STALE_SCENE", message: "The live document changed." };
    if (name === "read_studio_context") return { revision: { scene: revision } };
    sent.push({ name, host: payload.host, expectedRevision: payload.expectedRevision });
    if (payload.expectedRevision !== revision) return { ok: false, code: "STALE_SCENE", message: "Authored state changed." };
    if (name === "run_action") {
      const moved = payload.args.args.sceneId === "scene-foreign" ? identity("scene-b", "scene-open-5", "tab-9") : identity(payload.args.args.sceneId, "scene-open-5");
      open = identity(moved.sceneId, moved.sceneEpoch); revision = 11;
      return { ok: true, commandId: payload.commandId, action: "scene.switch", kind: "document", status: "completed", affectedIds: [moved.sceneId], summary: "Opened.", host: moved };
    }
    return { ok: true, commandId: payload.commandId, receiptId: `receipt-${sent.length}`, status: "applied", revision: { before: revision, after: ++revision } };
  } };
  const admission = { commandId: uuid, host: identity("scene-main", "scene-open-4"), revision: 4,
    async refresh() { const read = await liveHub.command("read_studio_context", { host: admission.host }, "handle-12"); admission.revision = read.revision.scene; } };
  const invoke = createStudioTools({ liveHub, workspaceHandle: "handle-12", session: { admission } }).internal.invoke;
  const edit = { ops: [{ op: "update", id: "cube", position: { world: { x: 1, y: 0, z: 0 } } }] };
  assert.equal((await invoke("run_action", { action: "scene.switch", args: { sceneId: "scene-b" } })).status, "completed");
  const moved = await invoke("arrange_objects", edit).catch(error => error);
  assert.equal(moved.status, "applied", `an edit after a scene switch in the same turn is admitted: ${moved.code ?? ""} ${moved.message ?? ""}`);
  assert.deepEqual(sent.at(-1), { name: "arrange_objects", host: identity("scene-b", "scene-open-5"), expectedRevision: 11 });
  assert.deepEqual(admission.host, identity("scene-b", "scene-open-5"));
  // A host from another workspace is never adopted.
  await invoke("run_action", { action: "scene.switch", args: { sceneId: "scene-foreign" } });
  assert.deepEqual(admission.host, identity("scene-b", "scene-open-5"), "a foreign workspace's host is not adopted");
  console.log("PASS a scene change in a turn re-admits later commands at the new open scene");
}

if (shouldRun("surface-context-and-images")) {
  const commands = []; let failImage = false;
  const live = await liveFixture({ command: async (name, args) => { commands.push({ name, args }); if (name === "read_studio_context") return { context: context(host(live.handle)) }; if (name === "verify_result") return { ok: true, receiptId: "receipt-1", revision: { scene: 1, physics: 1, view: 1 }, visualRefs: [{ imageId: "capture-1" }] }; if (name === "resolve_studio_image") return failImage ? {} : { imageId: "capture-1", dataUrl: png, revision: { scene: 1 }, receiptId: "receipt-1" }; return { ok: true, commandId: args.commandId ?? "cmd-1", receiptId: "receipt-1", affectedIds: [], status: "applied" }; } });
  const calls = []; let phase = 0;
  const modelResponse = ({ input, tools }) => { calls.push(input); assert.deepEqual(tools.map(t => t.name), STUDIO_TOOLS); const turn = phase++; if (turn === 0) return streamOf([{ type: "function_call", call_id: "arrange-1", name: "arrange_objects", arguments: JSON.stringify({ ops: [{ op: "remove", id: "cube" }] }) }]); if (turn === 2 || turn === 4) return streamOf([{ type: "function_call", call_id: `visual-${turn}`,  name: "verify_result", arguments: JSON.stringify({ targets: ["char-alex"], checks: ["framing"], visual: "frame" }) }]); return streamOf([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]); };
  const liveHttp = await httpFixture({ modelResponse, live }); const first = envelope(host(live.handle)); const result = await liveHttp.post(first); assert.equal(result.response.status, 200); assert.ok(result.text.split("\n").some(line => line.startsWith("data: "))); assert.ok(!result.text.includes("data: {\\\"")); assert.equal(commands[1].name, "arrange_objects"); assert.equal(typeof commands[1].args.commandId, "string"); assert.deepEqual(commands[1].args.host, { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" });
  const imageTurn = envelope(host(live.handle), "check the frame"); const imageResult = await liveHttp.post(imageTurn, result.cookie); assert.equal(imageResult.response.status, 200); assert.ok(calls.some(input => input.some(item => item.content?.some(part => part.type === "input_image" && part.image_url === png)))); assert.ok(!calls.flat().filter(item => item.type === "function_call_output").some(item => JSON.stringify(item).includes(png))); assert.match(imageResult.text, /visualStatus/);
  failImage = true; const failedImage = await liveHttp.post(envelope(host(live.handle), "check again"), imageResult.cookie); assert.equal(failedImage.response.status, 200); assert.match(failedImage.text, /unavailable/); assert.ok(!calls.at(-1).some(item => item.content?.some(part => part.type === "input_image")));
  await liveHttp.close(); await live.close(); console.log("PASS surface context, eight-family profile, command envelopes and actual image bytes");
}

if (shouldRun("stale-host-and-post-install-rate-limit")) {
  const live = await liveFixture({ command: async name => { if (name !== "read_studio_context") heartbeat?.(); return name === "read_studio_context" ? { context: context(host(live.handle)) } : { ok: true, status: "installed", receiptId: "receipt-installed" }; } });
  const calls = []; let first = true; let heartbeat; let clockTicks = 0;
  const modelResponse = ({ input }) => { calls.push(input); if (first) { first = false; return streamOf([{ type: "function_call", call_id: "tool-1", name: "arrange_objects", arguments: JSON.stringify({ ops: [{ op: "remove", id: "cube" }] }) }]); } const error = Object.assign(new Error("rate limited"), { status: 429 }); throw error; };
  const liveHttp = await httpFixture({ modelResponse, live, clock: () => ++clockTicks, setIntervalImpl: callback => { heartbeat = callback; return callback; }, clearIntervalImpl: () => {} });
  const wrong = envelope(host("missing-handle")); let refused = await liveHttp.post(wrong); assert.equal(refused.response.status, 409); assert.match(refused.text, /LIVE_HUB_UNAVAILABLE/);
  const otherSocket = new WebSocket(`ws://127.0.0.1:${live.hub.server.address().port}/live`); const otherReady = deferred(); otherSocket.on("message", raw => { const frame = JSON.parse(raw); if (frame.type === "workspace") otherReady.resolve(frame.handle); }); await once(otherSocket, "open"); otherSocket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: "tab-other" })); const otherHandle = await bounded(otherReady.promise); const mismatch = envelope(host(otherHandle, "tab-7")); const mismatchResult = await liveHttp.post(mismatch); assert.equal(mismatchResult.response.status, 409); assert.match(mismatchResult.text, /STALE_SCENE/); otherSocket.terminate();
  const firstTurn = envelope(host(live.handle), "explain this"); const firstResult = await liveHttp.post(firstTurn); heartbeat?.(); assert.equal(firstResult.response.status, 200); assert.match(firstResult.text, /: heartbeat\n\n/); assert.ok(clockTicks > 0); assert.match(firstResult.text, /rate_limit/); assert.ok(calls.length >= 2); assert.ok(calls.slice(1).some(input => input.some(item => item.type === "function_call_output" && item.output.includes("installed")))); const stopResponse = await fetch(`${liveHttp.origin}/agent/stop`, { method: "POST", headers: { origin: liveHttp.origin, cookie: firstResult.cookie, "content-type": "application/json" }, body: JSON.stringify({ surface: "studio", sessionId: firstTurn.sessionId, turnId: firstTurn.turnId }) }); assert.equal(stopResponse.status, 200);
  const priorCalls = calls.length; const retry = envelope(host(live.handle), "explain this"); const retryResult = await liveHttp.post(retry, firstResult.cookie); assert.equal(retryResult.response.status, 200); assert.ok(calls.length > priorCalls); assert.ok(!retryResult.text.includes("tool.start"));
  await liveHttp.close(); await live.close(); console.log("PASS mismatched handle refusal and rate-limit retry retains completed output without regeneration");
}

if (shouldRun("sequential-mutations-revision-chain") || shouldRun("external-revision-bump-refuses")) {
  const revisionScenarios = selected ? [selected === "external-revision-bump-refuses"] : [false, true];
  for (const externalBump of revisionScenarios) {
    let sceneRevision = 1; let applies = 0; const commands = []; let charToken = "ct-11";
  const live = await liveFixture({ command: async (name, args) => {
    commands.push({ name, args });
    if (name === "read_studio_context") { const fresh = context(host(live.handle), sceneRevision); return { context: { ...fresh, entities: fresh.entities.map(row => ({ ...row, token: charToken })) } }; }
    // The outside edit touches the very character the model is about to remove, so the sidecar must not replay the command for it.
    if (externalBump && applies === 1 && sceneRevision === 2) { sceneRevision++; charToken = "ct-12"; }
    if (args.expectedRevision !== sceneRevision) return { ok: false, error: { code: "STALE_SCENE", message: "Authored scene revision changed." } };
    applies++; const before = sceneRevision++; return { ok: true, commandId: args.commandId, receiptId: `receipt-${applies}`, host: host(live.handle), status: "applied", authored: true, revision: { before, after: sceneRevision }, affectedIds: [args.name === "arrange_objects" ? "cube" : "char-alex"], delta: [], checks: { coverage: "fixture" }, undo: { historyEntryId: `history-${applies}`, entries: 1, canUndoDirect: true }, warnings: [] };
  } });
  let callNumber = 0; const inputs = []; const modelResponse = ({ input }) => { inputs.push(input); callNumber++; if (callNumber === 1) return streamOf([{ type: "function_call", call_id: "mutation-1", name: "arrange_objects", arguments: JSON.stringify({ ops: [{ op: "remove", id: "cube" }] }) }]); if (callNumber === 2) return streamOf([{ type: "function_call", call_id: "mutation-2", name: "arrange_characters", arguments: JSON.stringify({ ops: [{ op: "remove", characterId: "char-alex" }] }) }]); return streamOf([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]); };
  const liveHttp = await httpFixture({ modelResponse, live }); const result = await liveHttp.post(envelope(host(live.handle), "apply both")).then(value => ({ ...value, calls: commands.filter(command => command.name !== "read_studio_context") }));
  assert.equal(result.response.status, 200); assert.equal(result.calls.length, 2); assert.equal(result.calls[0].args.expectedRevision, 1); assert.equal(result.calls[1].args.expectedRevision, 2); assert.equal(applies, externalBump ? 1 : 2);
  if (externalBump) { assert.ok(inputs[2].some(item => item.type === "function_call_output" && item.output.includes("STALE_SCENE"))); assert.equal(result.calls[1].args.expectedRevision, 2); } else { assert.ok(!result.text.includes("STALE_SCENE")); }
    await liveHttp.close(); await live.close(); console.log(`PASS ${externalBump ? "external revision bump refuses second mutation" : "sequential mutations chain receipt revision"}`);
  }
}

if (shouldRun("sequential-same-target-token-rotation")) {
  let sceneRevision = 1; let tokenSequence = 1; const commands = []; const tokens = new Map([["cube-1", "cube-1:1"]]);
  const objectContext = (binding, revision = sceneRevision) => {
    const base = context(binding, revision);
    return { ...base, scene: { ...base.scene, objectCount: 1 }, selection: { kind: "object", id: "cube-1" },
      entities: [...base.entities, { id: "cube-1", kind: "object", token: tokens.get("cube-1"), position: { x: 0, y: 0, z: 0 }, yawDeg: 0, rotationDeg: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, bounds: null }],
      entityPage: { returned: 2, total: 2, truncated: false, nextCursor: null } };
  };
  const failure = (payload, code, expected, current) => ({ ok: false, commandId: payload.commandId, host: host(live.handle), code, phase: "admission", affectedIds: [], expectedTargets: expected ? [expected] : [], currentTargets: current ? [current] : [], mutated: false, preserved: { authoredState: "unchanged" }, recovery: { action: "inspect", retryAllowed: false }, message: `The fixture editor refuses with ${code}.` });
  const live = await liveFixture({ command: async (name, args) => {
    commands.push({ name, args });
    if (name === "read_studio_context") return { context: objectContext(host(live.handle)) };
    if (name !== "arrange_objects") return { ok: true, commandId: args.commandId, receiptId: "receipt-view", status: "noop", authored: false, mutated: false, host: host(live.handle), revision: { before: sceneRevision, after: sceneRevision }, affectedIds: [], delta: [], checks: { coverage: "fixture" }, undo: null, warnings: [] };
    const expected = args.expectedTargets?.find(target => target.targetId === "cube-1");
    const current = { ...host(live.handle), targetId: "cube-1", token: tokens.get("cube-1") };
    if (args.expectedRevision !== sceneRevision) return failure(args, "STALE_SCENE", null, null);
    // The editor still enforces any guard it is given, and rotates the token of
    // every entity it touches: a client that re-sends the token it read before
    // its own first edit is refused. The sidecar must therefore send none.
    if (expected && expected.token !== current.token) return failure(args, "STALE_TARGET", expected, current);
    const before = sceneRevision; sceneRevision++; tokens.set("cube-1", `cube-1:${++tokenSequence}`);
    return { ok: true, commandId: args.commandId, receiptId: `receipt-${before}`, host: host(live.handle), status: "applied", authored: true, mutated: true, revision: { before, after: sceneRevision }, affectedIds: ["cube-1"], delta: [], checks: { coverage: "fixture" }, undo: { historyEntryId: `history-${before}`, entries: 1, canUndoDirect: true }, warnings: [] };
  } });
  let callNumber = 0; const modelResponse = ({ tools }) => { assert.deepEqual(tools.map(tool => tool.name), STUDIO_TOOLS); callNumber++; if (callNumber <= 2) return streamOf([{ type: "function_call", call_id: `same-target-${callNumber}`, name: "arrange_objects", arguments: JSON.stringify({ ops: [{ op: "update", id: "cube-1", position: { world: { x: callNumber, y: 0, z: 0 } } }] }) }]); return streamOf([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]); };
  const liveHttp = await httpFixture({ modelResponse, live });
  const turn = envelope(host(live.handle), "update the same object twice"); turn.context = objectContext(host(live.handle), 1);
  const result = await liveHttp.post(turn); const applied = commands.filter(command => command.name === "arrange_objects");
  assert.equal(result.response.status, 200); assert.equal(applied.length, 2);
  assert.ok(!result.text.includes("STALE_TARGET"), `a second mutation on the same object must not be refused for a rotated token: ${result.text}`);
  assert.equal(sceneRevision, 3, "both mutations reach the editor and publish a revision");
  assert.deepEqual(applied.map(command => command.args.expectedRevision), [1, 2], "each mutation is admitted against the revision the previous one published");
  assert.ok(applied.every(command => command.args.expectedTargets === undefined), "the sync admission envelope carries no per-entity incarnation tokens");
  await liveHttp.close(); await live.close(); console.log("PASS sequential same-target mutations tolerate editor token rotation");
}

if (shouldRun("rejection-receipt-surfaces-reason")) {
  const { createStudioTools } = await import("../bin/agent/studio-tools.mjs");
  // The out-of-bounds message names the offending path and the allowed range
  // (#398), not the generic "one supported variant" union rejection.
  const receipt = { ok: false, commandId: "cmd-9", code: "INVALID_ARGUMENT", phase: "admission", message: "$.args.ops[0].set.scale.y: Expected a number within [0.1, 100].", recovery: { action: "inspect", retryAllowed: false }, expectedTargets: [], currentTargets: [], mutated: false, preserved: { authoredState: "unchanged" } };
  const rejecting = { command: async () => receipt };
  const tools = createStudioTools({ liveHub: rejecting, workspaceHandle: "handle-1", session: { signal: new AbortController().signal } });
  const invoke = tools.internal.invoke;
  await assert.rejects(invoke("inspect_studio", { scope: "scene" }), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT", "the receipt's top-level code wins");
    assert.match(error.message, /scale\.y/, "the receipt's top-level message names the offending path");
    assert.match(error.message, /0\.1/, "the receipt's top-level message names the lower bound");
    assert.match(error.message, /100/, "the receipt's top-level message names the upper bound");
    assert.deepEqual(error.receipt, receipt, "the whole receipt is attached for the route to forward");
    return true;
  });
  // Nested `error` still works, and top level beats it when both exist.
  const nested = { command: async () => ({ ok: false, code: "STALE_SCENE", message: "top-level wins", error: { code: "TARGET_BUSY", message: "nested" } }) };
  await assert.rejects(createStudioTools({ liveHub: nested, workspaceHandle: "h", session: { signal: new AbortController().signal } }).internal.invoke("inspect_studio", { scope: "scene" }), (error) => {
    assert.equal(error.code, "STALE_SCENE"); assert.equal(error.message, "top-level wins"); return true;
  });
  // The generic string survives only when the receipt has neither code nor message.
  const bare = { command: async () => ({ ok: false }) };
  await assert.rejects(createStudioTools({ liveHub: bare, workspaceHandle: "h", session: { signal: new AbortController().signal } }).internal.invoke("inspect_studio", { scope: "scene" }), (error) => {
    assert.equal(error.code, undefined); assert.equal(error.message, "Studio command failed"); return true;
  });
  console.log("PASS rejection receipts surface their code, message and recovery to the route");
}
