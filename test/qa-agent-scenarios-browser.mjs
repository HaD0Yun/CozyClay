#!/usr/bin/env node
// Real-model capability checks against the live Studio Agent pane. Run via:
// node tools/qa-browser.mjs -- node test/qa-agent-scenarios-browser.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = Number(process.env.CDP_PORT || 9222);
const baseUrl = process.env.QA_URL || "http://127.0.0.1:5180/app/";
const model = process.env.QA_AGENT_MODEL || "cliproxy/claude-opus-5-5";
const outputDir = process.env.QA_OUT || "/tmp/cozyclay-agent-scenarios";
const reportPath = `${outputDir}/agent-scenarios.json`;
mkdirSync(outputDir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
if (!target) throw new Error(`No Chrome page on CDP port ${cdpPort}; run via tools/qa-browser.mjs`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(JSON.stringify(message.error)));
  else resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.result?.description || "Browser evaluation failed");
  return result.result.value;
};
const waitFor = async (expression, timeoutMs = 45_000) => evaluate(`new Promise((resolve, reject) => {
  const deadline = setTimeout(() => { observer.disconnect(); reject(new Error("Browser state deadline: " + ${JSON.stringify(expression)})); }, ${timeoutMs});
  const observer = new MutationObserver(() => { try { if (${expression}) { clearTimeout(deadline); observer.disconnect(); resolve(true); } } catch {} });
  observer.observe(document, {subtree:true, childList:true, attributes:true, characterData:true});
  try { if (${expression}) { clearTimeout(deadline); observer.disconnect(); resolve(true); } } catch {}
})`);

function live(args) {
  try {
    const status = JSON.parse(execFileSync("node", ["bin/cozyclay.mjs", "live", "status", "--pretty"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    // Only the QA browser's own editor (tools/qa-browser.mjs names its project
    // "QA") or an explicit QA_WORKSPACE; another open Studio tab is never touched.
    const handle = process.env.QA_WORKSPACE || qaHandle || status.editors?.findLast((row) => row.project === "QA")?.handle;
    if (!handle) throw new Error(`no QA editor on the live hub: ${JSON.stringify(status.editors?.map(({ handle: h, project }) => ({ handle: h, project })) ?? [])}`);
    return JSON.parse(execFileSync("node", ["bin/cozyclay.mjs", "live", ...args, "--workspace", handle, "--pretty"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024 }));
  } catch (error) {
    throw new Error(`live ${args.join(" ")} failed (status ${error.status ?? "unknown"}): ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
  }
}
// The page's own live workspace handle, read from the chip the Studio renders
// once its editor is connected, so the hub is always asked about THIS page.
let qaHandle = null;
// The Studio mounts the Agent pane hidden behind the Inspector; switch to it so
// every scenario screenshot shows the conversation and its receipts.
async function showAgentPane() {
  await evaluate(`(() => { const button = document.querySelector('button.inspector-agent-switch[aria-pressed]'); if (button && button.getAttribute('aria-pressed') !== 'true') button.click(); })()`);
  await waitFor(`(() => { const pane = document.querySelector('aside[aria-label="Agent"]'); return !!pane && !pane.hidden && pane.offsetParent !== null; })()`, 15_000).catch(() => null);
}
async function readHandle() {
  const selector = "document.querySelector('.live-workspace-handle[data-live-workspace]')";
  await waitFor(`!!${selector}?.dataset.liveWorkspace`, 30_000).catch(() => null);
  qaHandle = await evaluate(`${selector}?.dataset.liveWorkspace || null`);
  return qaHandle;
}
// Restoring a take after a reload is asynchronous (IndexedDB read + decode)
// and has no DOM signal, so re-read the hub until the condition holds or the
// deadline passes; each read is a CLI round trip, so no sleep is needed.
function untilState(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = state();
  while (!check(last) && Date.now() < deadline) last = state();
  return last;
}
function state() {
  // `describe` carries the complete live object list; `inspect` returns one
  // page (12 by default), so it is only asked about the named characters.
  const description = live(["describe"]);
  const scene = description.document.scenes.find((row) => row.id === description.document.activeSceneId);
  const characterIds = (description.characters ?? []).map((row) => row.id);
  const entities = characterIds.length ? live(["inspect", "--scope", "entities", "--ids", characterIds.join(",")]).entities : [];
  return {
    objectIds: (description.objects ?? []).map((row) => row.id).sort(),
    objects: (description.objects ?? []).map(({ id, name }) => ({ id, name })),
    shots: scene?.shotDocument?.shots?.map(({ id, name }) => ({ id, name })) ?? [],
    characters: entities.filter((row) => row.kind === "character").map(({ id, motion }) => ({ id, takeId: motion?.takeId ?? null, frames: motion?.frames ?? 0 })),
  };
}
// A new project starts on an empty stage (#986), but S2 and S4-S8 address the
// first cast member as char-a. Cast the Y Bot through the live CLI (the rigged
// body S4 needs for motion) and prove the editor holds it before any scenario.
async function ensureCharacter() {
  const hasCharacter = (row) => row.characters.some((entry) => entry.id === "char-a");
  if (!hasCharacter(state())) live(["run", "character.add", "--args", JSON.stringify({ character: { id: "char-a", model: "y-bot-tpose" } })]);
  const settled = untilState(hasCharacter, 20_000);
  if (!hasCharacter(settled)) throw new Error(`char-a is not on the stage after character.add: ${JSON.stringify(settled.characters)}`);
}
const finalReply = () => evaluate(`(() => [...document.querySelectorAll('.agent-row.assistant .agent-assistant-text')].map(node => node.innerText.trim()).filter(Boolean).at(-1) || '')()`);
const results = [];
let setupFailure = null;
async function scenario(id, title, run) {
  const result = { id, title, status: "FAIL", finalReply: "", before: null, after: null, evidence: null };
  try {
    result.before = state();
    if (setupFailure && id !== "S5") throw new Error(`Scenario setup failed: ${setupFailure}`);
    const evidence = await run(result);
    result.after = state();
    result.finalReply = await finalReply();
    result.evidence = evidence;
    result.status = "PASS";
    console.log(`PASS ${id} ${title} — ${JSON.stringify(evidence)}`);
  } catch (error) {
    result.after = (() => { try { return state(); } catch (stateError) { return { error: stateError.message }; } })();
    result.finalReply = await finalReply().catch(() => "");
    result.evidence = { error: error.message };
    console.log(`FAIL ${id} ${title} — ${JSON.stringify(result.evidence)}`);
  }
  try {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    result.screenshot = `${outputDir}/${id}.png`;
    writeFileSync(result.screenshot, Buffer.from(shot.data, "base64"));
  } catch {}
  results.push(result);
}
async function turn(prompt, timeoutMs = 90_000) {
  await waitFor(`!!document.querySelector('aside[aria-label="Agent"] textarea[aria-label="Message the agent"]') && !document.querySelector('aside[aria-label="Agent"] textarea[aria-label="Message the agent"]').disabled`);
  const escaped = JSON.stringify(prompt);
  await evaluate(`(() => { const input=document.querySelector('aside[aria-label="Agent"] textarea[aria-label="Message the agent"]'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(input,${escaped}); input.dispatchEvent(new Event('input',{bubbles:true})); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true})); })()`);
  await waitFor(`(() => { const pane=document.querySelector('aside[aria-label="Agent"]'); const activity=pane?.querySelector('.agent-activity-text')?.textContent.trim(); return !!pane && activity === 'Ready' && ![...pane.querySelectorAll('button')].some(button => button.textContent.trim() === 'Stop'); })()`, timeoutMs);
  return finalReply();
}
async function chooseModel() {
  const value = JSON.stringify(model);
  await waitFor(`!!document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]')`);
  await waitFor(`(() => { const select=document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]'); return [...(select?.options ?? [])].some(option => option.value === ${value}); })()`, 30_000);
  await evaluate(`(() => { const select=document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]'); const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(select,${value}); select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(`document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]')?.value === ${value}`);
}
async function pageLoad(url) {
  const loaded = new Promise((resolve) => {
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Page.loadEventFired") { ws.removeEventListener("message", listener); resolve(); }
    };
    ws.addEventListener("message", listener);
  });
  await send("Page.navigate", { url });
  await loaded;
}

await send("Page.enable");
await send("Runtime.enable");
try {
  await pageLoad(baseUrl);
  await waitFor(`!!document.querySelector('aside[aria-label="Agent"]') && !!document.querySelector('aside[aria-label="Agent"] textarea[aria-label="Message the agent"]')`);
  await readHandle();
  await ensureCharacter();
  await showAgentPane();
  await chooseModel();
} catch (error) {
  setupFailure = error.message;
  console.log(`SETUP FAIL ${JSON.stringify(setupFailure)}`);
}

await scenario("S1", "sight", async (result) => {
  // More objects than the old 24-row context cap, so a correct count proves the
  // agent sees the whole scene, not the first page of it.
  const target = 30;
  const missing = Math.max(0, target - result.before.objectIds.length);
  if (missing) {
    const opsFile = `${outputDir}/s1-ops.json`;
    writeFileSync(opsFile, JSON.stringify(Array.from({ length: missing }, (_, i) => ({ op: "create", source: { kind: "cube" }, name: `QA sight ${i + 1}`, position: { world: { x: -12 + (i % 6) * 2, y: 0, z: -12 - Math.floor(i / 6) * 2 } }, scale: { x: 0.5, y: 0.5, z: 0.5 } }))));
    live(["arrange-objects", "-f", opsFile]);
    result.before = state();
  }
  const count = result.before.objectIds.length;
  if (count <= 24) throw new Error(`Setup left only ${count} objects; S1 needs more than 24`);
  const reply = await turn("How many objects are in the scene? Answer with the number only.");
  const answer = Number(reply.trim().match(/^\d+$/)?.[0]);
  if (answer !== count) throw new Error(`Expected object count ${count}; assistant reply was ${JSON.stringify(reply)}`);
  return { liveObjectCount: count, parsedAnswer: answer };
});

await scenario("S2", "remove", async (result) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const names = [`QA remove alpha ${suffix}`, `QA remove beta ${suffix}`];
  const created = names.map((name, index) => live(["arrange-objects", "--op", JSON.stringify({ op: "create", source: { kind: "cylinder" }, name, position: { relativeTo: "char-a", basis: "subject", side: index === 0 ? "left" : "right", gapM: 1 + index, support: "floor" } })]));
  const ids = created.map((row) => row.affectedIds?.[0] ?? row.id).filter(Boolean);
  if (ids.length !== 2) throw new Error(`Could not identify both created object ids: ${JSON.stringify(created)}`);
  result.before = state();
  await turn(`Remove the two objects named ${names[0]} and ${names[1]}.`);
  result.after = state();
  const remaining = ids.filter((id) => result.after.objectIds.includes(id));
  if (remaining.length) throw new Error(`Object ids remain after remove request: ${remaining.join(", ")}`);
  return { names, ids, remaining };
});

await scenario("S3", "add shot", async (result) => {
  await turn("Add a new shot after the current one.");
  const after = state();
  const added = after.shots.length - result.before.shots.length;
  if (added < 1) throw new Error(`Shot count did not increase (${result.before.shots.length} -> ${after.shots.length})`);
  return { beforeShotCount: result.before.shots.length, afterShotCount: after.shots.length };
});

await scenario("S4", "motion", async (result) => {
  await turn("char-a에게 4초 걷기 모션을 만들어서 적용해줘.", 6 * 60_000);
  const afterState = state();
  const before = result.before.characters.find((row) => row.id === "char-a");
  const after = afterState.characters.find((row) => row.id === "char-a");
  if (!(after?.takeId && after.frames > 0)) throw new Error(`char-a has no motion take after the request: ${JSON.stringify({ before, after })}`);
  return { characterId: "char-a", before, after };
});

await scenario("S5", "persistence", async () => {
  const before = state();
  await pageLoad(baseUrl);
  await waitFor(`!!document.querySelector('aside[aria-label="Agent"]')`);
  await readHandle();
  await showAgentPane();
  const restored = (s) => (s.characters.find((row) => row.id === "char-a")?.frames ?? 0) > 0;
  const after = untilState(restored, 60_000);
  const character = after.characters.find((row) => row.id === "char-a");
  if (!(character?.takeId && character.frames > 0)) throw new Error(`char-a take did not persist after reload: ${JSON.stringify(character)}`);
  return { before, after, character };
});

// The registry actions the agent used to have no door to, driven through the
// same real model: a root waypoint, an attachment, and an arrange after it.
const waypointsOf = (id) => live(["inspect", "--scope", "motion", "--ids", id]).characters?.find((row) => row.id === id)?.waypoints ?? [];
const objectNamed = (name) => (live(["describe"]).objects ?? []).find((row) => row.name === name) ?? null;
// `describe` rows carry no attachment; the agent-facing inspect row does.
const attachmentOf = (id) => live(["inspect", "--scope", "entities", "--ids", id]).entities?.find((row) => row.id === id)?.attachment ?? null;

await scenario("S6", "waypoint", async () => {
  const before = waypointsOf("char-a");
  await turn("Add one root waypoint to char-a's path, 2 metres in front of where char-a stands now.");
  const after = waypointsOf("char-a");
  if (after.length <= before.length) throw new Error(`char-a waypoint count did not increase (${before.length} -> ${after.length})`);
  return { before, after };
});

const carrySuffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const carryName = `QA carry ${carrySuffix}`;
await scenario("S7", "attach", async () => {
  live(["arrange-objects", "--op", JSON.stringify({ op: "create", source: { kind: "cube" }, name: carryName, position: { relativeTo: "char-a", basis: "subject", side: "right", gapM: 1.5, support: "floor" }, scale: { x: 0.15, y: 0.15, z: 0.15 } })]);
  const before = objectNamed(carryName);
  if (!before) throw new Error(`Setup could not create ${carryName}`);
  // Read before the turn, so the evidence shows the transition the agent made.
  const beforeAttachment = attachmentOf(before.id);
  if (beforeAttachment) throw new Error(`Setup left ${carryName} already attached: ${JSON.stringify(beforeAttachment)}`);
  await turn(`Attach the object named ${carryName} to char-a's right hand.`);
  const after = objectNamed(carryName);
  const attachment = after ? attachmentOf(after.id) : null;
  if (attachment?.characterId !== "char-a") throw new Error(`${carryName} is not attached to char-a: ${JSON.stringify(attachment)}`);
  return { before: { id: before.id, attachment: beforeAttachment }, after: { id: after.id, attachment } };
});

await scenario("S8", "arrange after attach", async () => {
  // A carried prop must not stop the agent from placing anything else.
  const name = `QA after attach ${carrySuffix}`;
  await turn(`Create a new cube named ${name} on the floor 2 metres to the left of char-a.`);
  const created = objectNamed(name);
  if (!created) throw new Error(`${name} was not created while ${carryName} rides char-a`);
  return { created: { id: created.id, name: created.name, x: created.x, z: created.z } };
});

await scenario("S9", "new scene", async () => {
  // One message that changes the open scene and then edits inside it: the edit
  // is admitted against the scene the agent just opened, not the one it left.
  const beforeScenes = live(["describe"]).document.scenes.map((row) => row.id);
  const name = `QA scene ${carrySuffix}`;
  await turn(`Create a new scene named "${name}", open it, and put one cube in it.`);
  const description = live(["describe"]);
  const active = description.document.scenes.find((row) => row.id === description.document.activeSceneId);
  if (!active || beforeScenes.includes(active.id)) throw new Error(`The open scene is not a new one: ${JSON.stringify({ active: active?.id ?? null, beforeScenes })}`);
  if (active.name !== name) throw new Error(`The new scene is named ${JSON.stringify(active.name)}, not ${JSON.stringify(name)}`);
  const objects = (description.objects ?? []).map(({ id, name: objectName, renderer }) => ({ id, name: objectName, renderer }));
  if (!objects.some((row) => row.renderer === "cube")) throw new Error(`${name} has no cube after the request: ${JSON.stringify(objects)}`);
  return { beforeSceneCount: beforeScenes.length, afterSceneCount: description.document.scenes.length, active: { id: active.id, name: active.name }, objects };
});

writeFileSync(reportPath, `${JSON.stringify({ model, url: baseUrl, generatedAt: new Date().toISOString(), scenarios: results }, null, 2)}\n`);
console.log(`REPORT ${reportPath}`);
await send("Runtime.disable").catch(() => {});
ws.close();
if (results.some((result) => result.status !== "PASS")) process.exitCode = 1;
