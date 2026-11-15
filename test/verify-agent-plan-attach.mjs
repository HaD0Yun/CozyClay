// #742: a Studio turn for a staging/coverage request, or a staged scene's first turn in a session, carries the
// top-view plan as its one observation image; a plain single-character turn carries none, and
// an explicit attachFrame keeps the frame instead of the plan.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createSessionStore } from "../bin/agent/session-store.mjs";
import { createFakeModel } from "./fixtures/fake-model.mjs";
import { contextFixture, envelopeFixture } from "./verify-studio-agent-protocol.mjs";
import { withTurnControls } from "./fixtures/turn-controls.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const scratch = mkdtempSync(join(tmpdir(), "cozyclay-agent-plan-attach-"));
const faux = createFakeModel();
const commands = [];
let context = contextFixture();
let failPlan = false;
const hub = withTurnControls({ command: async (name) => {
  commands.push(name);
  if (name === "capture_plan_png" && failPlan) throw new Error("The plan renderer is not ready");
  return name === "capture_plan_png" || name === "capture_framing_png" ? { dataUrl: png, width: 1280, height: 720 } : {};
} });
const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: faux.models, fauxProvider: faux.fauxProvider,
  liveHub: hub, sessionStore: createSessionStore(scratch), studioRuntime: { readContext: async () => context }, port: () => server.address().port });
const server = createServer((req, res) => handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

let turn = 0;
async function studioTurn({ characterCount, text = "inspect selection", attachFrame, sessionId, sceneId }) {
  turn += 1;
  context = contextFixture();
  context.scene.characterCount = characterCount;
  if (sceneId) context.host = { ...context.host, sceneId };
  commands.length = 0;
  faux.script([{ type: "text", text: "ok" }]);
  const before = faux.calls.length;
  const body = { ...envelopeFixture(), sessionId: sessionId ?? `00000000-0000-4000-8000-0000000007${String(turn).padStart(2, "0")}`, turnId: `00000000-0000-4000-8000-0000000008${String(turn).padStart(2, "0")}`, text, context, ...(attachFrame === undefined ? {} : { attachFrame }) };
  const response = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
  assert.equal(response.status, 200);
  assert.equal(faux.calls.length, before + 1, "one provider request per turn");
  const parts = faux.calls.at(-1).messages.filter((message) => message.role === "user").flatMap((message) => message.content ?? []);
  const images = parts.flatMap((part, index) => part.type === "image" ? [{ part, label: parts[index - 1]?.text ?? "" }] : []);
  return { frames, images, captures: [...commands] };
}

try {
  const two = await studioTurn({ characterCount: 2 });
  assert.deepEqual(two.captures.filter((name) => name.startsWith("capture_")), ["capture_plan_png"], "two characters: the plan is captured once");
  assert.equal(two.images.length, 1, "exactly one image reaches the provider");
  assert.equal(two.images[0].label, "Studio plan observation (top view) at scene revision 41", "the label names the revision and no missing receipt");
  assert.equal(two.frames.some((frame) => frame.type === "error"), false);
  console.log("PASS a two-character Studio turn carries the top-view plan as its one image");

  // The plan rode every turn of a staged scene, re-sent each time; now it comes once per session unless asked for.
  const again = await studioTurn({ characterCount: 2, sessionId: "00000000-0000-4000-8000-000000000701" });
  assert.deepEqual(again.captures.filter((name) => name.startsWith("capture_")), [], "the same session's next plain turn captures no plan");
  assert.equal(again.images.length, 1, "the request holds only the first turn's plan, still in the conversation");
  const asked = await studioTurn({ characterCount: 2, text: "카메라를 레일로 바꿔줘", sessionId: "00000000-0000-4000-8000-000000000701" });
  assert.deepEqual(asked.captures.filter((name) => name.startsWith("capture_")), ["capture_plan_png"], "a camera request in that session gets the plan again");
  const other = await studioTurn({ characterCount: 2, sessionId: "00000000-0000-4000-8000-000000000701", sceneId: "scene-other" });
  assert.deepEqual(other.captures.filter((name) => name.startsWith("capture_")), ["capture_plan_png"], "another scene opened in that session gets its own first plan");
  console.log("PASS a staged scene's plan comes once per scene in a session, and again on a staging request");

  const worded = await studioTurn({ characterCount: 1, text: "투샷으로 잡아줘" });
  assert.deepEqual(worded.captures.filter((name) => name.startsWith("capture_")), ["capture_plan_png"], "a coverage word asks for the plan too");
  assert.equal(worded.images.length, 1);
  console.log("PASS a coverage request by wording carries the plan");

  const plain = await studioTurn({ characterCount: 1 });
  assert.deepEqual(plain.captures.filter((name) => name.startsWith("capture_")), [], "one character, no shots, plain text: no plan capture");
  assert.equal(plain.images.length, 0, "and no image");
  console.log("PASS a plain one-character turn captures nothing");

  const framed = await studioTurn({ characterCount: 2, attachFrame: true });
  assert.deepEqual(framed.captures.filter((name) => name.startsWith("capture_")), ["capture_framing_png"], "attachFrame keeps the frame and skips the plan");
  assert.equal(framed.images.length, 1);
  assert.match(framed.images[0].label, /^Studio frame observation /);
  console.log("PASS attachFrame still sends one image, the frame, and no plan");

  failPlan = true;
  const failed = await studioTurn({ characterCount: 2 });
  assert.deepEqual(failed.captures.filter((name) => name.startsWith("capture_")), ["capture_plan_png"]);
  assert.equal(failed.images.length, 0, "a failed plan capture sends no image");
  assert.equal(failed.frames.some((frame) => frame.type === "error"), false, "and never fails the turn");
  assert.equal(failed.frames.at(-1)?.type, "done");
  console.log("PASS a failed plan capture leaves the turn running without an image");
} finally {
  await handler.close?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
