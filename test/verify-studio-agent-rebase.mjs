#!/usr/bin/env node
// A stale scene revision or a busy editor gesture costs the model a whole turn.
// The sidecar re-sends the identical command ONCE when it can prove the targets
// are untouched (or the gesture ended), says so in the receipt, and otherwise
// teaches the model what changed. Scripted editor, no browser.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
process.env.COZYCLAY_AGENT_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "rebase-"));
delete process.env.CLIPROXY_API_KEY; delete process.env.CLIPROXY_BASE_URL;
const { createStudioTools } = await import("../bin/agent/studio-tools.mjs");
const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
const { createFakeModel } = await import("./fixtures/fake-model.mjs");
const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");

const HOST = contextFixture().host;
/** A scripted editor: revisions, per-entity tokens, one history entry per applied command. */
function editor() {
  const ed = { revision: 41, busy: 0, tokenSeq: 0, history: [], attempts: [], wire: [], hooks: [], objects: new Map() };
  const add = (id, name, x) => ed.objects.set(id, { id, kind: "object", name, token: `t-${++ed.tokenSeq}`, position: { x, y: 0, z: 0 }, yawDeg: 0, rotationDeg: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, color: "#aaaaaa" });
  add("obj-a", "Crate", 1); add("obj-b", "Barrel", 5);
  ed.add = add;
  ed.context = () => {
    const base = contextFixture(), rows = [...ed.objects.values()].map(row => structuredClone(row));
    const entities = [...base.entities, ...rows];
    return { ...base, revision: { scene: ed.revision, physics: 9, view: 18 }, scene: { ...base.scene, objectCount: rows.length },
      entities, entityIndex: entities.map(row => ({ id: row.id, kind: row.kind, ...(row.name ? { name: row.name } : {}), position: row.position })),
      entityPage: { returned: entities.length, total: entities.length, truncated: false, nextCursor: null } };
  };
  /** Someone else edits: the scene revision moves and the entity's token rotates. */
  ed.userEdit = (id, patch) => { const row = ed.objects.get(id); Object.assign(row, patch, { token: `t-${++ed.tokenSeq}` }); ed.revision++; };
  ed.userAdd = (id, name) => { add(id, name, 0); ed.revision++; };
  ed.bumpUnrelated = () => { ed.revision++; };
  const refusal = (payload, code, message) => ({ ok: false, commandId: payload.commandId, code, message, phase: "admission", mutated: false, affectedIds: [], expectedTargets: [], currentTargets: [], preserved: { authoredState: "unchanged" }, recovery: { action: "inspect", retryAllowed: false } });
  ed.command = async (name, payload) => {
    ed.wire.push(name);
    if (name === "read_studio_context") return { context: ed.context() };
    if (name === "inspect_studio") return { context: ed.context(), entities: [...ed.objects.values()].filter(row => !payload.ids || payload.ids.includes(row.id)) };
    ed.attempts.push({ name, revision: payload.expectedRevision });
    for (const hook of ed.hooks.splice(0, 1)) hook(ed.attempts.length);
    if (payload.expectedRevision !== ed.revision) return refusal(payload, "STALE_SCENE", "Authored state changed; obtain fresh intent.");
    if (ed.busy > 0) { ed.busy--; return refusal(payload, "TARGET_BUSY", "Finish the current editor gesture first."); }
    const affected = [];
    for (const op of payload.args.ops ?? []) {
      if (op.op === "update") { const row = ed.objects.get(op.id); if (op.position?.world) row.position = op.position.world; row.token = `t-${++ed.tokenSeq}`; affected.push(op.id); }
      if (op.op === "create") { const id = `obj-${op.name.toLowerCase()}`; ed.add(id, op.name, op.position?.world?.x ?? 0); affected.push(id); }
    }
    const before = ed.revision++; ed.history.push(payload.commandId);
    return { ok: true, commandId: payload.commandId, receiptId: `r-${ed.history.length}`, host: HOST, status: "applied", authored: true, mutated: true,
      revision: { before, after: ed.revision }, affectedIds: affected, delta: [], checks: { coverage: "fixture" }, undo: { historyEntryId: `h-${ed.history.length}`, entries: 1, canUndoDirect: true }, warnings: [] };
  };
  return ed;
}
/** Admission exactly as the route builds it, over the scripted editor. */
function session(ed, extra = {}) {
  const baseline = ed.context();
  const admission = { commandId: () => randomUUID(), host: HOST, revision: baseline.revision.scene,
    snapshot: async () => (await ed.command("read_studio_context")).context,
    refresh: async () => { const read = (await ed.command("read_studio_context")).context; admission.revision = read.revision.scene; return read; } };
  const slept = [];
  return { slept, admission, baseline, signal: new AbortController().signal, sleep: async ms => { slept.push(ms); return true; }, ...extra };
}
const tools = (ed, s) => createStudioTools({ liveHub: { command: (name, payload) => ed.command(name, payload) }, workspaceHandle: "handle-12", session: s }).internal.invoke;
const moveA = x => ({ ops: [{ op: "update", id: "obj-a", position: { world: { x, y: 0, z: 0 } } }] });

// 1. Revision bumped by an unrelated edit: one automatic re-send, flagged, one undo step.
{
  const ed = editor(), s = session(ed), invoke = tools(ed, s);
  ed.userEdit("obj-b", { color: "#ff0000" });
  const result = await invoke("arrange_objects", moveA(3));
  assert.equal(result.autoRebased, true, "the receipt says it was re-sent");
  assert.equal(result.autoRebase.reason, "stale_scene");
  assert.deepEqual([result.autoRebase.fromRevision, result.autoRebase.toRevision], [41, 42]);
  assert.ok(result.warnings.some(w => w.code === "AUTO_REBASED" && w.message.length <= 120), "a warning names the rebase");
  assert.deepEqual(ed.attempts.map(a => a.revision), [41, 42], "refused once, re-sent once at the live revision");
  assert.equal(ed.history.length, 1, "one applied command, one undo step");
  assert.equal(ed.objects.get("obj-a").position.x, 3);
  assert.equal(s.admission.revision, 43, "admission follows the receipt");
  console.log("PASS unrelated edit moved the revision: re-sent once, autoRebased receipt, one history entry");
}

// 2. Own edit then unrelated bump: the baseline for the entity it just edited is read back, so it can still rebase.
{
  const ed = editor(), s = session(ed), invoke = tools(ed, s);
  await invoke("arrange_objects", moveA(2));
  ed.userEdit("obj-b", { color: "#00ff00" });
  const result = await invoke("arrange_objects", moveA(4));
  assert.equal(result.autoRebased, true);
  assert.equal(ed.objects.get("obj-a").position.x, 4);
  // Without the readback (no snapshot) an own-edited entity cannot be proven unchanged.
  const ed2 = editor(), s2 = session(ed2); delete s2.admission.snapshot;
  const invoke2 = tools(ed2, s2);
  await invoke2("arrange_objects", moveA(2));
  ed2.userEdit("obj-b", { color: "#00ff00" });
  await assert.rejects(invoke2("arrange_objects", moveA(4)), error => error.code === "STALE_SCENE" && /cannot be proven unchanged/.test(error.message));
  console.log("PASS an entity the agent just edited rebases from its read-back; unverifiable ones do not");
}

// 3. The target itself changed: no replay, a change list, and the next submit needs no inspect.
{
  const ed = editor(), s = session(ed), invoke = tools(ed, s);
  ed.userEdit("obj-a", { position: { x: 7, y: 0, z: 0 } });
  await assert.rejects(invoke("arrange_objects", moveA(3)), error => {
    assert.equal(error.code, "STALE_SCENE");
    assert.match(error.message, /obj-a: position \(1, 0, 0\) -> \(7, 0, 0\)/, "ids and fields that changed");
    assert.match(error.message, /Not retried automatically/);
    assert.match(error.message, /already refreshed to revision 42/);
    assert.equal(error.autoRebased, false);
    return true;
  });
  assert.equal(ed.attempts.length, 1, "no replay on a changed target");
  assert.equal(ed.history.length, 0);
  const result = await invoke("arrange_objects", moveA(3));
  assert.equal(result.autoRebased, undefined, "the resubmit is admitted at the refreshed revision with no rebase");
  assert.equal(ed.objects.get("obj-a").position.x, 3);
  // A target that was removed, or renamed, is also a change.
  const ed2 = editor(), s2 = session(ed2), invoke2 = tools(ed2, s2);
  ed2.objects.delete("obj-a"); ed2.revision++;
  await assert.rejects(invoke2("arrange_objects", moveA(3)), error => /no longer exists|removed: obj-a/.test(error.message));
  const ed3 = editor(), invoke3 = tools(ed3, session(ed3));
  ed3.objects.get("obj-a").name = "Renamed"; ed3.revision++;
  await assert.rejects(invoke3("arrange_objects", moveA(3)), error => /renamed/.test(error.message));
  console.log("PASS a changed target is not replayed: STALE_SCENE lists the ids and fields, the resubmit succeeds");
}

// 4. A referenced entity counts as a target, not only the edited one.
{
  const ed = editor(), s = session(ed), invoke = tools(ed, s);
  ed.userEdit("obj-b", { position: { x: 9, y: 0, z: 0 } });
  const relative = { ops: [{ op: "update", id: "obj-a", position: { relativeTo: "obj-b", basis: "world", side: "left", gapM: 0.5, support: "floor" } }] };
  await assert.rejects(invoke("arrange_objects", relative), error => /obj-b: position/.test(error.message));
  assert.equal(ed.attempts.length, 1);
  console.log("PASS a reference (relativeTo) that moved blocks the replay");
}

// 5. Creates have no target: safe unless the name now collides.
{
  const ed = editor(), s = session(ed), invoke = tools(ed, s);
  ed.bumpUnrelated();
  const created = await invoke("arrange_objects", { ops: [{ op: "create", source: { kind: "cube" }, name: "Lamp", position: { world: { x: 0, y: 0, z: 0 } } }] });
  assert.equal(created.autoRebased, true);
  assert.equal(ed.history.length, 1, "exactly one object was created");
  const ed2 = editor(), s2 = session(ed2), invoke2 = tools(ed2, s2);
  ed2.userAdd("obj-theirs", "Lamp");
  await assert.rejects(invoke2("arrange_objects", { ops: [{ op: "create", source: { kind: "cube" }, name: "Lamp", position: { world: { x: 0, y: 0, z: 0 } } }] }), error => /named "lamp" appeared/.test(error.message));
  assert.equal(ed2.history.length, 0);
  console.log("PASS a create replays only while its name is still free");
}

// 6. Second stale: exactly one re-send, never a loop.
{
  const ed = editor(), s = session(ed), invoke = tools(ed, s);
  ed.bumpUnrelated();
  ed.hooks.push(() => {}, () => ed.bumpUnrelated()); // the re-send hits another outside edit
  await assert.rejects(invoke("arrange_objects", moveA(3)), error => {
    assert.equal(error.code, "STALE_SCENE");
    assert.match(error.message, /already re-sent once automatically/);
    return true;
  });
  assert.equal(ed.attempts.length, 2, "one refusal, one re-send, stop");
  assert.equal(ed.history.length, 0);
  // The admission is refreshed, so the model's own resubmit lands.
  await invoke("arrange_objects", moveA(3));
  assert.equal(ed.history.length, 1);
  console.log("PASS a second stale revision is returned, not looped");
}

// 7. A user gesture that ends: paused for (250 ms, then doubling), re-sent, flagged; the panel hears it wait.
{
  const waits = [];
  const ed = editor(), s = session(ed, { onGestureWait: waiting => waits.push(waiting) }), invoke = tools(ed, s);
  ed.busy = 1;
  const result = await invoke("arrange_objects", moveA(3));
  assert.equal(result.autoRebased, true);
  assert.equal(result.autoRebase.reason, "target_busy");
  assert.deepEqual(s.slept, [250]);
  assert.deepEqual(waits, [true, false]);
  assert.ok(result.warnings.some(w => w.code === "AUTO_REBASED"));
  assert.equal(ed.attempts.length, 2);
  assert.equal(ed.history.length, 1);
  console.log("PASS a busy gesture that ends is waited out, flagged in the receipt");
}

// 8. A gesture still held after 20 s: a soft error that says so (the task goes on); backoff 250 ms doubling to 2 s.
{
  const ed = editor(), s = session(ed), invoke = tools(ed, s);
  ed.busy = Infinity;
  await assert.rejects(invoke("arrange_objects", moveA(3)), error => {
    assert.equal(error.code, "TARGET_BUSY");
    assert.match(error.message, /still dragging or editing in the editor after 20 s/);
    assert.match(error.message, /obj-a/);
    assert.match(error.message, /does not end the task/);
    return true;
  });
  assert.deepEqual(s.slept, [250, 500, 1000, ...Array(9).fill(2000)]);
  assert.ok(s.slept.reduce((a, b) => a + b, 0) <= 20_000, "the wait is bounded by 20 s");
  assert.equal(ed.attempts.length, 1 + s.slept.length);
  assert.equal(ed.history.length, 0);
  // An abort during the wait cancels the retry and surfaces the original refusal.
  const ed2 = editor(), controller = new AbortController();
  const s2 = session(ed2, { signal: controller.signal, sleep: undefined, busyWaitMs: 5000 });
  ed2.busy = Infinity;
  const pending = tools(ed2, s2)("arrange_objects", moveA(3));
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  await assert.rejects(pending, { code: "TARGET_BUSY" });
  assert.ok(Date.now() - started < 2000, "abort ends the wait early");
  assert.equal(ed2.attempts.length, 1, "an aborted turn does not retry");
  console.log("PASS a persisting busy gesture yields a teaching error; abort cancels the wait");
}

// 9. Tools without a per-entity fingerprint are never replayed, but still teach.
{
  const ed = editor(), s = session(ed), invoke = tools(ed, s);
  ed.userEdit("obj-b", { color: "#0000ff" });
  await assert.rejects(invoke("frame_shot", { subjectIds: ["obj-a"], framing: { intent: { size: "wide shot", view: "front", level: "eye", side: "left" } } }), error => error.code === "STALE_SCENE" && /replayed automatically only right after your own edit/.test(error.message) && /obj-b/.test(error.message));
  assert.equal(ed.attempts.length, 1);
  const ed2 = editor(), s2 = session(ed2), invoke2 = tools(ed2, s2);
  ed2.bumpUnrelated();
  await assert.rejects(invoke2("undo_edit", { receiptId: "r-1" }), { code: "STALE_SCENE" });
  assert.equal(ed2.attempts.length, 1, "undo is never replayed");
  // Without a fresh context (a bare admission) the original error stands untouched.
  const bare = { host: HOST, revision: 1, commandId: () => "c", refresh: async () => {} };
  const stale = { command: async () => ({ ok: false, code: "STALE_SCENE", message: "Authored state changed; obtain fresh intent." }) };
  await assert.rejects(createStudioTools({ liveHub: stale, workspaceHandle: "h", session: { admission: bare } }).internal.invoke("arrange_objects", moveA(1)), error => error.message === "Authored state changed; obtain fresh intent.");
  console.log("PASS non-entity tools and context-less admissions keep the plain refusal");
}

// 11. The editor settling the agent's own edit (a mirror catching up a render later) moves the
// revision past the receipt. Nothing anyone else authored changed, so any tool is re-sent once,
// even one with no per-entity fingerprint; an edit by someone else in between still teaches.
{
  const ed = editor(), s = session(ed), invoke = tools(ed, s);
  // The settle lands before the sidecar reads back its own create: it cannot read the new row
  // at the revision the receipt published, yet the id is its own, never "added" by someone.
  const command = ed.command; let settle = true;
  ed.command = async (name, payload) => { if (settle && name === "read_studio_context") { settle = false; ed.bumpUnrelated(); } return command(name, payload); };
  const own = await invoke("arrange_objects", { ops: [{ op: "create", source: { kind: "cube" }, name: "Lamp", position: { world: { x: 0, y: 0, z: 0 } } }] });
  assert.equal(settle, false, "the read-back met the settled revision");
  assert.equal(s.admission.revision, own.revision.after);
  const framed = await invoke("frame_shot", { subjectIds: ["obj-a"], framing: { intent: { size: "wide shot", view: "front", level: "eye", side: "left" } } });
  assert.equal(framed.autoRebased, true, "re-sent once by the sidecar");
  assert.equal(framed.autoRebase.reason, "own_edit_settled");
  assert.ok(framed.warnings.some(w => w.code === "AUTO_REBASED" && /after your own edit/.test(w.message) && w.message.length <= 120));
  assert.deepEqual(ed.attempts.map(a => [a.name, a.revision]), [["arrange_objects", 41], ["frame_shot", 42], ["frame_shot", 43]]);
  const ed2 = editor(), s2 = session(ed2), invoke2 = tools(ed2, s2);
  await invoke2("arrange_objects", moveA(2));
  ed2.userEdit("obj-b", { color: "#0000ff" });
  await assert.rejects(invoke2("frame_shot", { subjectIds: ["obj-a"], framing: { intent: { size: "wide shot", view: "front", level: "eye", side: "left" } } }), error => error.code === "STALE_SCENE" && /obj-b/.test(error.message));
  assert.equal(ed2.attempts.length, 2, "an edit by someone else is never re-sent over");
  console.log("PASS the editor settling the agent's own edit is re-sent once for any tool; someone else's edit still teaches");
}

// 10. The route wires it end to end: baseline, snapshot, tool.done flag.
{
  const ed = editor();
  ed.hooks.push(() => ed.bumpUnrelated()); // lands after turn admission, before the model's command
  const fake = createFakeModel();
  fake.script([{ type: "toolCall", id: "m1", name: "arrange_objects", arguments: moveA(3) }, { type: "text", text: "moved" }]);
  const hub = { command: (name, payload) => ed.command(name, payload), workspaceId: () => HOST.workspaceId, resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"] };
  let server;
  const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { listModels: async () => ["gpt-5"], parseQuotaHeaders: () => ({}) }, models: fake.models, fauxProvider: fake.fauxProvider, liveHub: hub, port: () => server.address().port });
  server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const envelope = { ...envelopeFixture(), context: ed.context(), model: "faux/scripted" };
  const response = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(envelope) });
  const frames = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  server.close();
  const done = frames.find(frame => frame.type === "tool.done");
  assert.equal(response.status, 200);
  assert.ok(done?.ok, `tool succeeded: ${JSON.stringify(done)}`);
  assert.equal(done.autoRebased, true, "the tool.done frame is flagged");
  assert.equal(done.result.autoRebased, true);
  assert.deepEqual(ed.attempts.map(a => a.revision), [41, 42]);
  assert.equal(ed.history.length, 1);
  console.log("PASS route: a stale revision on an untouched target is re-sent once and flagged on the tool.done frame");
}
console.log("studio agent rebase: all scenarios passed");
