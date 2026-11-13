#!/usr/bin/env node
// Real-model Studio Agent bench (#714): five fixed Korean scenarios, one row of
// metrics per model x scenario, merged into $QA_OUT/<label>.json. Run one
// process per model (docs/qa/agent-bench.md):
// QA_AGENT_MODEL=<model> QA_BENCH_LABEL=baseline node tools/qa-browser.mjs -- node test/qa-agent-bench-browser.mjs
// Uses a real model and a live scene; it is excluded from the default manifest.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const cdpPort = Number(process.env.CDP_PORT || 9222);
const baseUrl = process.env.QA_URL || "http://127.0.0.1:5180/app/";
const model = process.env.QA_AGENT_MODEL || "cliproxy/claude-opus-5-5";
// Reasoning effort picked in the pane's "Reasoning effort" select (e.g. medium). Unset = the
// pane's default, which sends no effort field at all (the sidecar then runs with thinking off).
const effort = process.env.QA_AGENT_EFFORT || null;
const outputDir = process.env.QA_OUT || "/tmp/cozyclay-agent-bench";
const label = process.env.QA_BENCH_LABEL || "baseline";
// 480 s: the three-shot coverage scenario (S3) ran 180-210 s on main with thinking off, so
// 240 s turned honest slow runs into BENCH_TIMEOUT rows and poisoned S4's precondition.
const turnTimeoutMs = Number(process.env.QA_BENCH_TURN_TIMEOUT_MS || 480_000);
const reportPath = `${outputDir}/${label}.json`;
const shotDir = `${outputDir}/${label}`;
const modelSlug = model.replace(/[^a-z0-9.]+/gi, "-");
mkdirSync(shotDir, { recursive: true });
// The code under test: the newest commit touching anything but the bench itself.
const commit = execFileSync("git", ["log", "-1", "--first-parent", "--format=%h", "--abbrev=7", "--", ".", ":!test/qa-agent-bench-browser.mjs", ":!docs/qa/agent-bench.md"], { encoding: "utf8" }).trim();

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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.result?.description || "Browser evaluation failed");
  return result.result.value;
};
const waitFor = async (expression, timeoutMs = 45_000) => evaluate(`new Promise((resolve, reject) => {
  const deadline = setTimeout(() => { observer.disconnect(); reject(new Error("Browser state deadline: " + ${JSON.stringify(expression)})); }, ${timeoutMs});
  const observer = new MutationObserver(() => { try { if (${expression}) { clearTimeout(deadline); observer.disconnect(); resolve(true); } } catch {} });
  observer.observe(document, {subtree:true, childList:true, attributes:true, characterData:true});
  try { if (${expression}) { clearTimeout(deadline); observer.disconnect(); resolve(true); } } catch {}
})`);

let qaHandle = null;
function live(args) {
  try {
    const status = JSON.parse(execFileSync("node", ["bin/cozyclay.mjs", "live", "status", "--pretty"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const handle = process.env.QA_WORKSPACE || qaHandle || status.editors?.findLast((row) => row.project === "QA")?.handle;
    if (!handle) throw new Error(`no QA editor on the live hub: ${JSON.stringify(status.editors?.map(({ handle: h, project }) => ({ handle: h, project })) ?? [])}`);
    return JSON.parse(execFileSync("node", ["bin/cozyclay.mjs", "live", ...args, "--workspace", handle, "--pretty"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024 }));
  } catch (error) {
    throw new Error(`live ${args.join(" ")} failed (status ${error.status ?? "unknown"}): ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
  }
}
async function showAgentPane() {
  await evaluate(`(() => { document.querySelector('button.studio-agent-bar')?.click(); })()`);
  await waitFor(`(() => { const pane = document.querySelector('aside[aria-label="Agent"]'); return !!pane && !pane.hidden && pane.offsetParent !== null; })()`, 15_000).catch(() => null);
}
async function readHandle() {
  const selector = "document.querySelector('.live-workspace-handle[data-live-workspace]')";
  await waitFor(`!!${selector}?.dataset.liveWorkspace`, 30_000).catch(() => null);
  qaHandle = await evaluate(`${selector}?.dataset.liveWorkspace || null`);
  return qaHandle;
}
async function chooseModel() {
  const value = JSON.stringify(model);
  await waitFor(`!!document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]')`);
  await waitFor(`(() => { const select=document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]'); return [...(select?.options ?? [])].some(option => option.value === ${value}); })()`, 30_000);
  await evaluate(`(() => { const select=document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]'); const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(select,${value}); select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(`document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]')?.value === ${value}`);
}
async function chooseEffort() {
  if (!effort) return;
  const value = JSON.stringify(effort);
  const select = `document.querySelector('aside[aria-label="Agent"] select[aria-label="Reasoning effort"]')`;
  await waitFor(`!!${select}`, 30_000);
  await waitFor(`[...(${select}?.options ?? [])].some(option => option.value === ${value})`, 30_000);
  await evaluate(`(() => { const select=${select}; const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(select,${value}); select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(`${select}?.value === ${value}`);
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
const finalReply = () => evaluate(`(() => [...document.querySelectorAll('.agent-row.assistant .agent-assistant-text')].map(node => node.innerText.trim()).filter(Boolean).at(-1) || '')()`);

// The agent client binds fetch when its transport is created, so the tee is
// installed before any page script runs. Every "/agent/turn" response (the
// turn stream and a replay after a dropped stream) is cloned and its SSE
// "data: {json}" lines are pushed to window.__benchFrames; a "done" frame
// settles the waiter the harness armed for the turn. The request bodies are
// kept too (window.__benchRequests), so a failing turn can be replayed with curl.
const FETCH_TEE = `(() => {
  if (window.__benchTee) return; window.__benchTee = true;
  window.__benchFrames = []; window.__benchRequests = []; window.__benchSeqs = new Set(); window.__benchWaiters = [];
  const original = window.fetch;
  const push = (frame) => {
    if (frame.eventSeq !== undefined) { if (window.__benchSeqs.has(frame.eventSeq)) return; window.__benchSeqs.add(frame.eventSeq); }
    window.__benchFrames.push({ ...frame, receivedAt: Date.now() });
    if (frame.type === 'done') { const waiters = window.__benchWaiters.splice(0); for (const resolve of waiters) resolve(); }
  };
  window.fetch = async function (input, init) {
    const response = await original.apply(this, arguments);
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (url.includes('/agent/turn') && typeof init?.body === 'string') window.__benchRequests.push({ url, method: init.method || 'GET', status: response.status, body: init.body });
    if (!url.includes('/agent/turn') || !response.body) return response;
    (async () => {
      const reader = response.clone().body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\\n')) >= 0) {
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          try { push(JSON.parse(line.slice(5).trim())); } catch {}
        }
      }
    })().catch(() => {});
    return response;
  };
})()`;

const ready = `(() => { const pane=document.querySelector('aside[aria-label="Agent"]'); const activity=pane?.querySelector('.agent-activity-text')?.textContent.trim(); return !!pane && activity === 'Ready' && ![...pane.querySelectorAll('button')].some(button => button.textContent.trim() === 'Stop'); })()`;
const textarea = `document.querySelector('aside[aria-label="Agent"] textarea[aria-label="Message the agent"]')`;

/** Send one prompt and wait for the turn's "done" frame (or the deadline). */
async function turn(prompt) {
  await waitFor(`!!${textarea} && !${textarea}.disabled`);
  const startedAt = await evaluate(`(() => {
    window.__benchFrames = []; window.__benchRequests = []; window.__benchSeqs = new Set();
    window.__benchDone = new Promise(resolve => window.__benchWaiters.push(resolve));
    const input=${textarea}; const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    setter.call(input, ${JSON.stringify(prompt)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.focus();
    const startedAt = Date.now();
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
    return startedAt;
  })()`);
  const timedOut = !(await evaluate(`Promise.race([window.__benchDone.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), ${turnTimeoutMs}))])`));
  if (timedOut) {
    await evaluate(`(() => { const stop=[...document.querySelectorAll('aside[aria-label="Agent"] button')].find(button => button.textContent.trim() === 'Stop'); stop?.click(); })()`);
  }
  await waitFor(ready, 60_000).catch(() => null);
  const frames = await evaluate(`window.__benchFrames`);
  const requests = await evaluate(`window.__benchRequests`);
  return { startedAt, timedOut, frames, requests, reply: await finalReply() };
}

function countOverlapWarnings(value) {
  if (!value || typeof value !== "object") return 0;
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (key === "warnings" && Array.isArray(child)) count += child.filter((row) => row?.code === "FOOTPRINT_OVERLAP").length;
    else count += countOverlapWarnings(child);
  }
  return count;
}
function metricsOf({ startedAt, timedOut, frames }) {
  const done = frames.find((frame) => frame.type === "done");
  const error = frames.find((frame) => frame.type === "error");
  const toolDone = frames.filter((frame) => frame.type === "tool.done");
  return {
    toolCalls: frames.filter((frame) => frame.type === "tool.start").length,
    authoredReceipts: toolDone.filter((frame) => frame.result?.authored === true).length,
    wallMs: done ? done.receivedAt - startedAt : null,
    overlapWarnings: toolDone.reduce((sum, frame) => sum + countOverlapWarnings(frame.result), 0),
    errorCode: timedOut ? "BENCH_TIMEOUT" : (error?.code ?? null),
    errorMessage: timedOut ? `no done frame within ${turnTimeoutMs} ms` : (error?.message ?? null),
    errorStatus: error?.status ?? null,
    usage: done?.usage ?? null,
  };
}

/** Scene facts the assertions read: positions from `describe`, kinds from the
 * agent-facing entity rows (libraryKind is only there). */
function state() {
  const description = live(["describe"]);
  const scene = description.document.scenes.find((row) => row.id === description.document.activeSceneId);
  const objectRows = description.objects ?? [];
  const entities = objectRows.length ? live(["inspect", "--scope", "entities", "--ids", objectRows.map((row) => row.id).join(",")]).entities ?? [] : [];
  const kindOf = new Map(entities.map((row) => [row.id, row.libraryKind ?? null]));
  const shots = scene?.shotDocument?.shots ?? [];
  const frame = description.timeline?.frame ?? 0;
  const currentShot = shots.find((shot) => frame >= shot.startFrame && frame <= shot.endFrame) ?? shots[0] ?? null;
  return {
    activeCharacterId: description.activeCharacterId ?? null,
    characters: (description.characters ?? []).map(({ id, x, z, rot }) => ({ id, x, z, rot })),
    objects: objectRows.map(({ id, name, x, z, renderer }) => ({ id, name, x, z, renderer, libraryKind: kindOf.get(id) ?? null })),
    shots: shots.map(({ id, name, startFrame, endFrame }) => ({ id, name, startFrame, endFrame })),
    currentShotCamera: currentShot?.camera ? { shotId: currentShot.id, present: true } : null,
    viewCamera: description.camera ?? null,
  };
}
const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);
const xz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const newObjects = (before, after) => after.objects.filter((row) => !before.objects.some((old) => old.id === row.id));
const characterIn = (s, id) => s.characters.find((row) => row.id === id) ?? s.characters[0] ?? null;

const SCENARIOS = [
  { id: "S1", prompt: "선택된 캐릭터 왼쪽 1.4m에 의자 하나 놔줘", assert(before, after) {
    const character = characterIn(before, before.activeCharacterId);
    const added = newObjects(before, after).map((row) => ({ id: row.id, name: row.name, renderer: row.renderer, x: row.x, z: row.z, distanceM: round(xz(row, character)) }));
    const success = after.objects.length === before.objects.length + 1 && added.length === 1 && added[0].distanceM >= 1.0 && added[0].distanceM <= 2.0;
    return { success, measured: { characterId: character?.id ?? null, objectCountBefore: before.objects.length, objectCountAfter: after.objects.length, added } };
  } },
  { id: "S2", prompt: "그 캐릭터 주위에 의자 6개를 반경 2m 원형으로 둘러 배치해", assert(before, after) {
    const character = characterIn(before, before.activeCharacterId);
    const added = newObjects(before, after).map((row) => ({ id: row.id, name: row.name, renderer: row.renderer, x: row.x, z: row.z, distanceM: round(xz(row, character)) }));
    // The request is "six chairs on a 2 m ring": count every chair that ended up on the ring,
    // whether it was created now or moved there (reusing the S1 chair is a valid reading).
    const ring = after.objects.filter((row) => `${row.name ?? ""} ${row.libraryKind ?? ""} ${row.renderer ?? ""}`.toLowerCase().includes("chair"))
      .map((row) => ({ id: row.id, name: row.name, renderer: row.renderer, x: row.x, z: row.z, distanceM: round(xz(row, character)) }))
      .filter((row) => row.distanceM >= 1.5 && row.distanceM <= 2.5);
    let minPairwiseM = null;
    for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) minPairwiseM = Math.min(minPairwiseM ?? Infinity, xz(ring[i], ring[j]));
    const success = ring.length === 6 && minPairwiseM > 0.3;
    return { success, measured: { characterId: character?.id ?? null, objectCountBefore: before.objects.length, objectCountAfter: after.objects.length, ringCount: ring.length, minPairwiseM: round(minPairwiseM), added, ring } };
  } },
  { id: "S3", prompt: "두 캐릭터가 테이블에 마주 앉아 대화하는 장면을 만들어. 캐릭터가 하나면 하나 추가해. 샷은 세 개: 마스터 투샷, A의 OTS, B의 OTS.", assert(before, after) {
    // Built-in props carry no libraryKind; their kind is the renderer id.
    const tables = after.objects.filter((row) => `${row.name ?? ""} ${row.libraryKind ?? ""} ${row.renderer ?? ""}`.toLowerCase().includes("table"));
    const success = after.characters.length >= 2 && after.shots.length === 3 && tables.length > 0;
    return { success, measured: { characterCount: after.characters.length, shotCount: after.shots.length, objectCount: after.objects.length, shots: after.shots.map(({ id, name }) => ({ id, name })), tables: tables.map(({ id, name, libraryKind, renderer }) => ({ id, name, libraryKind, renderer })) } };
  } },
  { id: "S4", prompt: "방금 한 거 되돌려", assert(before, after) {
    // `before` is the state right after S3: the last authored change. The loop
    // only credits this when S3 itself succeeded (PRECONDITION_S3).
    const success = after.shots.length < 3 || after.objects.length < before.objects.length;
    return { success, measured: { afterS3: { shotCount: before.shots.length, objectCount: before.objects.length, characterCount: before.characters.length }, now: { shotCount: after.shots.length, objectCount: after.objects.length, characterCount: after.characters.length } } };
  } },
  { id: "S5", prompt: "두 캐릭터를 1.2m 간격으로 마주보게 세우고 미디엄 투샷으로 프레임 잡아", assert(_before, after) {
    // The first two characters in document order (char-a and the one S3 added).
    const [a, b] = after.characters;
    const distanceM = a && b ? round(xz(a, b)) : null;
    const yawDiffDeg = a && b ? round((((a.rot - b.rot) % 360) + 360) % 360) : null;
    const success = after.characters.length >= 2 && distanceM >= 1.0 && distanceM <= 1.4 && yawDiffDeg >= 155 && yawDiffDeg <= 205 && !!after.currentShotCamera;
    return { success, measured: { characterCount: after.characters.length, pair: [a, b].filter(Boolean), distanceM, yawDiffDeg, shotCount: after.shots.length, currentShotCamera: after.currentShotCamera, viewCamera: after.viewCamera } };
  } },
];

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: FETCH_TEE });
let setupFailure = null;
try {
  await pageLoad(baseUrl);
  await waitFor(`!!document.querySelector('aside[aria-label="Agent"]') && !!${textarea}`);
  await readHandle();
  await showAgentPane();
  await chooseModel();
  await chooseEffort();
  if (!(await evaluate(`window.__benchTee === true`))) throw new Error("fetch tee did not install");
} catch (error) {
  setupFailure = error.message;
  console.log(`SETUP FAIL ${JSON.stringify(setupFailure)}`);
}

const rows = [];
let previous = null;
for (const scenario of SCENARIOS) {
  const row = { model, effort, scenario: scenario.id, prompt: scenario.prompt, toolCalls: 0, authoredReceipts: 0, wallMs: null, overlapWarnings: 0, success: false, errorCode: null, errorMessage: null, errorStatus: null, usage: null, reply: "", measured: null };
  try {
    if (setupFailure) throw Object.assign(new Error(setupFailure), { code: "BENCH_SETUP" });
    const before = previous ?? state();
    const result = await turn(scenario.prompt);
    Object.assign(row, metricsOf(result), { reply: result.reply });
    row.turnLog = `${shotDir}/${modelSlug}-${scenario.id}.turn.json`;
    writeFileSync(row.turnLog, `${JSON.stringify({ requests: result.requests, frames: result.frames }, null, 2)}\n`);
    const after = state();
    const verdict = scenario.assert(before, after);
    // A turn that timed out or ended on an error frame did not do the work.
    row.success = verdict.success && row.errorCode === null;
    row.measured = verdict.measured;
    // A revert is only observable after an S3 that built the scene; otherwise
    // the shot count is below 3 whether or not anything was undone.
    const s3 = rows.find((entry) => entry.scenario === "S3");
    if (scenario.id === "S4" && !s3?.success) {
      row.measured = { ...row.measured, precondition: { s3Success: false, turnErrorCode: row.errorCode } };
      row.success = false;
      row.errorCode = "PRECONDITION_S3";
    }
    previous = after;
  } catch (error) {
    row.errorCode ??= error.code || "BENCH_ERROR";
    row.errorMessage ??= error.message;
    row.measured = { error: error.message };
    previous = null;
  }
  try {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    row.screenshot = `${shotDir}/${modelSlug}-${scenario.id}.png`;
    writeFileSync(row.screenshot, Buffer.from(shot.data, "base64"));
  } catch {}
  console.log(`${row.success ? "PASS" : "FAIL"} ${model} ${scenario.id} tools=${row.toolCalls} authored=${row.authoredReceipts} wallMs=${row.wallMs} overlap=${row.overlapWarnings} error=${row.errorCode} status=${row.errorStatus} message=${JSON.stringify(row.errorMessage)} ${JSON.stringify(row.measured)}`);
  rows.push(row);
}

// Merge by model so one process per model can share the label's file.
const existing = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
const merged = [...(existing?.rows ?? []).filter((row) => row.model !== model), ...rows]
  .sort((a, b) => a.model.localeCompare(b.model) || a.scenario.localeCompare(b.scenario));
writeFileSync(reportPath, `${JSON.stringify({ label, commit, createdAt: new Date().toISOString(), rows: merged }, null, 2)}\n`);
console.log(`REPORT ${reportPath} rows=${merged.length}`);
await send("Runtime.disable").catch(() => {});
ws.close();
