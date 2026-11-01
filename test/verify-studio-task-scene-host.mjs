#!/usr/bin/env node
// A task whose run opens another scene (scene.create, scene.open) must close on the scene it is in now: the tools adopt the
// new host (studio-tools.mjs), and task.finish follows it (studio-turn-transaction.mjs). With the host the run began on, the
// editor refused the finish with STALE_SCENE, the board marked the task failed and its scope stayed held (SCOPE_BUSY).
import assert from "node:assert/strict";
import { studioTransaction } from "../bin/agent/studio-turn-transaction.mjs";

const first = { workspaceId: "w", documentEpoch: "d", sceneId: "scene-a", sceneEpoch: "ea" }, second = { ...first, sceneId: "scene-b", sceneEpoch: "eb" };
const sent = [];
const hub = { command: async (_name, request) => { sent.push({ action: request.args.action, host: request.host }); return { ok: true, action: request.args.action, authored: false }; } };
const admission = { host: { ...first }, revision: 3 };
const tx = studioTransaction({ hub, context: { host: { ...first, workspaceHandle: "h" }, scene: { previsMode: "animation" } }, turnId: "t", admission, task: { taskId: "task-1", scope: ["character:c"] } });
const frames = [];
for await (const frame of tx.run(async function* () { admission.host = { ...second }; yield { type: "text.delta", text: "made a scene" }; yield { type: "done" }; })({})) frames.push(frame);
assert.equal(sent[0].action, "task.begin");
assert.equal(sent[0].host.sceneId, "scene-a", "the task begins on the scene it was given");
assert.equal(sent.at(-1).action, "task.finish");
assert.equal(sent.at(-1).host.sceneId, "scene-b", "the finish goes to the scene the run opened");
assert.ok(frames.some(f => f.type === "receipt" && f.receipt.action === "task.finish") && frames.at(-1).type === "done");
console.log("PASS a task that opened another scene finishes there (no STALE_SCENE, its scope is released)");
