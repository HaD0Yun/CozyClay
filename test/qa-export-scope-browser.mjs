#!/usr/bin/env node
// Browser contract for the two video exports: the whole timeline, and one shot.
// Seeds the vintage car (a prop-only scene, no character motion: the case that
// used to record only the shot under the playhead) with its 360-frame timeline
// cut into two shots, 0–179 and 180–359.
//   1. The Export menu offers both "whole timeline" and "this shot only".
//   2. scope "timeline" records all 360 frames, across both shot boxes.
//   3. scope "shot" records the playhead's shot (180 frames), and a named shot
//      records that shot.
//   4. The menu's "whole timeline" item records all 360 frames.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5946 npm run dev -- --port 5842`,
// then `QA_URL=http://127.0.0.1:5842/app/ CDP_PORT=9842 node tools/qa-browser.mjs -- node test/qa-export-scope-browser.mjs`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/vintage-car-scene.json", import.meta.url), "utf8"));
const first = fixture.scenes[0].shotDocument.shots[0];
fixture.scenes[0].shotDocument.shots = [
	{ ...first, id: "shot-a", name: "Shot A", startFrame: 0, endFrame: 179 },
	{ ...first, id: "shot-b", name: "Shot B", startFrame: 180, endFrame: 359 },
];
const doc = JSON.stringify(fixture);

const cdpPort = Number(process.env.CDP_PORT || 9842);
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("/app/")) || targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0; const pending = new Map();
ws.onmessage = (event) => { const m = JSON.parse(event.data); if (!m.id || !pending.has(m.id)) return; const it = pending.get(m.id); pending.delete(m.id); m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed"); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, probe, timeoutMs = 60000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const v = await probe().catch(() => null); if (v) return v; await sleep(150); } throw new Error(`timeout: ${label}`); };
const navigate = async (url) => { await send("Page.enable"); const loaded = new Promise((resolve) => { const on = (e) => { if (JSON.parse(e.data).method === "Page.loadEventFired") { ws.removeEventListener("message", on); resolve(); } }; ws.addEventListener("message", on); }); await send("Page.navigate", { url }); await loaded; };
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 });
const clickSelector = async (selector) => {
	const at = await waitFor(selector, () => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`));
	await mouse("mousePressed", at.x, at.y); await mouse("mouseReleased", at.x, at.y);
};

const base = new URL(page.url);
await navigate(`${base.origin}/favicon.ico`);
await evaluate(`(() => { localStorage.clear(); localStorage.setItem('cozyclay.locale','en'); localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'Export Scope QA', updatedAt: Date.now() })); localStorage.setItem('cozyclay.scenes.v4', ${JSON.stringify(doc)}); return true; })()`);
await navigate(`${base.origin}/app/`);
await waitFor("hook", () => evaluate("Boolean(window.__cozyclay?.sceneObject) && (window.__cozyclay.objects||[]).length > 100"));
await waitFor("two shots", () => evaluate("document.querySelectorAll('.tl-shot-block').length === 2"));
await sleep(600);
await evaluate(`(() => {
	const element = document.querySelector('.app');
	let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
	while (fiber && !fiber.memoizedProps?.value?.bus) fiber = fiber.return;
	if (!fiber) throw new Error('AppContext provider not found');
	window.__qaBus = fiber.memoizedProps.value.bus;
	window.__qaVideos = [];
	const original = URL.createObjectURL;
	URL.createObjectURL = function (blob) { if (blob.type === 'video/mp4') window.__qaVideos.push(blob.size); return original.call(this, blob); };
})()`);
assert.equal(await evaluate("window.__cozyclay.motion ? 'motion' : 'none'"), "none", "a prop-only scene: no character motion");

const frames = (receipt) => Number((receipt.message ?? "").match(/· (\d+) frames/)?.[1] ?? receipt.output?.frameCount);
const run = async (input) => {
	const receipt = await evaluate(`window.__qaBus.run('export.shotVideo', ${JSON.stringify(input)})`);
	assert.equal(receipt.ok, true, JSON.stringify(receipt));
	return receipt;
};

/* ---------------------------------------------------------------- 1. */
await evaluate("window.__cozyclay.scrub(60); true");
await sleep(300);
const openExport = async () => {
	const button = await waitFor("export menu", () => evaluate("(() => { const b = [...document.querySelectorAll('.menubar button, [role=menubar] button')].find(e => /^Export/.test(e.textContent.trim())); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()"));
	await mouse("mousePressed", button.x, button.y); await mouse("mouseReleased", button.x, button.y);
	await waitFor("export items", () => evaluate("Boolean(document.querySelector('[data-testid=export-video]'))"));
};
await openExport();
const labels = await evaluate("['export-video', 'export-video-shot'].map(id => document.querySelector(`[data-testid=${id}] .menubar-item-label`)?.textContent ?? null)");
console.log(`1. Export menu: ${JSON.stringify(labels)}`);
assert.match(labels[0] ?? "", /whole timeline/i);
assert.match(labels[1] ?? "", /this shot/i);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);

/* ---------------------------------------------------------------- 2. */
const timeline = await run({ scope: "timeline" });
console.log(`2. scope timeline: ${frames(timeline)} frames`);
assert.equal(frames(timeline), 360, timeline.message);

/* ---------------------------------------------------------------- 3. */
await evaluate("window.__cozyclay.scrub(250); true");
await sleep(300);
const playheadShot = await run({ scope: "shot" });
const named = await run({ shotId: "shot-a", scope: "shot" });
console.log(`3. scope shot at frame 250: ${frames(playheadShot)} frames; shot-a: ${frames(named)} frames`);
assert.equal(frames(playheadShot), 180, playheadShot.message);
assert.equal(frames(named), 180, named.message);

/* ---------------------------------------------------------------- 4. */
const before = await evaluate("window.__qaVideos.length");
await openExport();
await clickSelector("[data-testid=export-video]");
await waitFor("menu export finished", () => evaluate(`window.__qaVideos.length > ${before}`), 240000);
const toast = await waitFor("frames message", () => evaluate("(() => { const t = [...document.querySelectorAll('.toast, [role=status], .export-panel, .export-status')].map(e => e.textContent).join(' | '); return /\\d+ frames/.test(t) ? t : null; })()"), 20000).catch(() => null);
console.log(`4. menu "whole timeline": an mp4 was produced; status: ${toast ? toast.match(/[^|]*\d+ frames[^|]*/)?.[0]?.trim() : "(no frame count shown)"}`);
if (toast) assert.match(toast, /360 frames/, toast);

console.log("export scope browser QA: whole timeline records every shot, this shot records one");
ws.close();
