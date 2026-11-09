#!/usr/bin/env node
// Browser contract: Props reads the way it behaves. In an agent-built scene the
// first Props rows are big expanded groups ("Environment" with its streets), so
// an object appended at the end of the records looked as if it had gone INTO
// the group above it, and dropping it on Props did nothing (it already was a
// top-level prop). A UI-made object is now listed first under Props, and a drop
// on Props takes the object out of any group and lists it first.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5911 npm run dev -- --port 5811`
// in one shell, then
// `QA_URL=http://127.0.0.1:5811/app/ CDP_PORT=9511 node tools/qa-browser.mjs -- node test/qa-props-placement-browser.mjs`
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const cdpPort = Number(process.env.CDP_PORT || 9498);
const out = process.env.QA_OUT || "/tmp/empty-object-qa";
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.url.includes("/app/")) || targets.find((target) => target.type === "page");
assert.ok(page, "studio page is not open");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
const runtimeErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || "exception");
	if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") runtimeErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
	if (!message.id || !pending.has(message.id)) return;
	const item = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) item.reject(new Error(JSON.stringify(message.error)));
	else item.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "browser evaluation failed");
	return result.result?.value;
};
const waitFor = async (label, probe, timeoutMs = 30000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe().catch(() => null);
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 120));
	}
	throw new Error(`Timed out waiting for ${label}`);
};

await send("Runtime.enable");
await mkdir(out, { recursive: true });
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1, ...extra });
const click = async (x, y) => { await mouse("mouseMoved", x, y, { buttons: 0 }); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
const rightClick = async (x, y) => {
	await mouse("mouseMoved", x, y, { buttons: 0 });
	await mouse("mousePressed", x, y, { button: "right", buttons: 2 });
	await mouse("mouseReleased", x, y, { button: "right", buttons: 0 });
};
// A point ON the element that real hit-testing really lands on it. The Outliner
// pane clips its context menu, so the geometric centre of a wide menu item can
// sit outside the visible pane; probe a few points along the row and return the
// first whose topmost element is the item (or a child of it).
const centerOf = (selector, textPattern = null) => evaluate(`(() => {
	const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
	const node = ${textPattern ? `nodes.find((n) => ${textPattern}.test(n.textContent.trim()))` : "nodes[0]"};
	if (!node) return null;
	const r = node.getBoundingClientRect();
	if (!(r.width > 0 && r.height > 0)) return null;
	for (const fraction of [0.5, 0.35, 0.2, 0.1, 0.65]) {
		const x = r.left + r.width * fraction, y = r.top + r.height / 2;
		const top = document.elementFromPoint(x, y);
		if (top && (top === node || node.contains(top))) return { x, y };
	}
	return null;
})()`);
const objects = () => evaluate("window.__cozyclay.objects.map((o) => ({ id: o.id, name: o.name, renderer: o.renderer, x: o.x, y: o.y ?? 0, z: o.z, parent: o.parent ?? null, color: o.color }))");
const pressUndo = async () => {
	const key = { key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 };
	await send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
};
const openProps = () => evaluate(`(() => {
	const fold = document.querySelector('[data-node-id="props"] .hierarchy-toggle');
	if (fold && fold.textContent.trim() === "▸") fold.click();
	return true;
})()`);
const rowFor = async (id) => {
	await waitFor(`outliner row ${id}`, async () => {
		await openProps();
		return evaluate(`!!document.querySelector('[data-node-id="${id}"]')`);
	});
};

await waitFor("studio QA hook", () => evaluate("Boolean(window.__cozyclay?.sceneObject && window.__cozyclay?.scrub && window.__cozyclay?.editorCam)"));
await evaluate("window.__cozyclay.setLookThrough(false)");
await waitFor("editor view is the main view", () => evaluate("window.__cozyclay.activeCam === window.__cozyclay.editorCam"));

/* ---------------------------------------------- the part: a plain cube ---- */

const cubeId = await evaluate(`window.__cozyclay.sceneObject.place({ kind: "cube", name: "Probe Cube", x: 1, z: 1 }).id`);
await rowFor(`object:${cubeId}`);


await waitFor("hook", () => evaluate("Boolean(window.__cozyclay?.sceneObject && window.__cozyclay?.editorCam)"));
// The user's shape: Props → "Environment" plane (with a child), then a car.
const env = await evaluate(`window.__cozyclay.sceneObject.place({ kind: "plane", name: "Environment", x: 0, z: -3.5 }).id`);
const house = await evaluate(`window.__cozyclay.sceneObject.place({ kind: "cube", name: "House", x: 3, z: -4 }).id`);
const car = await evaluate(`window.__cozyclay.sceneObject.place({ kind: "cube", name: "Vintage Car", x: -2, z: 0.6 }).id`);
await rowFor(`object:${house}`);
let intercepted = null;
const prev = ws.onmessage; ws.onmessage = (event) => { const m = JSON.parse(event.data); if (m.method === "Input.dragIntercepted") intercepted = m.params.data; prev(event); };
await send("Input.setInterceptDrags", { enabled: true });
const rowPt = (id) => evaluate(`(() => { const r = document.querySelector('[data-node-id="${id}"] .hierarchy-row, [data-node-id="${id}"]').getBoundingClientRect(); return { x: r.left + Math.min(60, r.width / 2), y: r.top + r.height / 2 }; })()`);
const realDrag = async (src, dst) => { const a = await rowPt(src), b = await rowPt(dst); intercepted = null;
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", clickCount: 1, buttons: 1 });
	for (let i = 1; i <= 6; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x + (b.x - a.x) * i / 6, y: a.y + (b.y - a.y) * i / 6, button: "left", buttons: 1 }); await new Promise((r) => setTimeout(r, 30)); }
	if (!intercepted) { await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 }); return "no drag"; }
	for (const type of ["dragEnter", "dragOver", "drop"]) await send("Input.dispatchDragEvent", { type, x: b.x, y: b.y, data: intercepted });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 }); return "ok"; };
// group the house under the Environment plane, like the agent did
await realDrag(`object:${house}`, `object:${env}`); await new Promise((r) => setTimeout(r, 400));
// focus Props, then create an Empty from Props' right-click menu
const pr = await rowPt("props"); await click(pr.x, pr.y); await new Promise((r) => setTimeout(r, 200));
await rightClick(pr.x, pr.y);
await waitFor("menu", () => evaluate(`!!document.querySelector(".v2-outliner .hierarchy-context-menu .add-object-item")`));
const item = await centerOf(".v2-outliner .hierarchy-context-menu .add-object-item", /^(Empty|빈 오브젝트)/); await click(item.x, item.y);
const empty = await waitFor("empty", async () => (await objects()).find((o) => o.renderer === "empty") ?? null);
for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await new Promise((r) => setTimeout(r, 400));
// The Outliner is a flat list of rows; depth is the row's --hierarchy-depth.
const propsChildren = () => evaluate(`(() => {
	const all = [...document.querySelectorAll('.v2-outliner [data-node-id]')];
	const depthOf = (n) => Number(getComputedStyle(n.querySelector('[style*="--hierarchy-depth"]') ?? n).getPropertyValue('--hierarchy-depth')) || 0;
	const start = all.findIndex((n) => n.dataset.nodeId === "props");
	const base = depthOf(all[start]);
	const out = [];
	for (const n of all.slice(start + 1)) { const d = depthOf(n); if (d <= base) break; out.push({ id: n.dataset.nodeId, depth: d - base - 1 }); }
	return out;
})()`);
assert.equal(empty.parent, null, "a new Empty is a top-level prop");
let rows = await propsChildren();
assert.equal(rows[0]?.id, `object:${empty.id}`, `the new Empty is the first row under Props: ${JSON.stringify(rows.slice(0, 4))}`);
assert.equal(rows[0]?.depth, 0, "and sits directly under Props");
// Into the Environment group, then back out by dropping on Props.
assert.equal(await realDrag(`object:${empty.id}`, `object:${env}`), "ok"); await new Promise((r) => setTimeout(r, 400));
assert.equal((await objects()).find((o) => o.id === empty.id)?.parent, env, "the Empty went into the Environment group");
await rowFor(`object:${empty.id}`);
assert.equal(await realDrag(`object:${empty.id}`, "props"), "ok"); await new Promise((r) => setTimeout(r, 500));
assert.equal((await objects()).find((o) => o.id === empty.id)?.parent, null, "dropping on Props takes it out of the group");
rows = await propsChildren();
assert.equal(rows[0]?.id, `object:${empty.id}`, `and lists it first under Props: ${JSON.stringify(rows.slice(0, 4))}`);
// A top-level object dropped on Props moves to the top as well.
assert.equal(await realDrag(`object:${car}`, "props"), "ok"); await new Promise((r) => setTimeout(r, 500));
rows = await propsChildren();
assert.equal(rows[0]?.id, `object:${car}`, "a top-level object dropped on Props moves to the top");
// One undo puts the order back.
await pressUndo(); await new Promise((r) => setTimeout(r, 400));
rows = await propsChildren();
assert.equal(rows[0]?.id, `object:${empty.id}`, "one undo restores the previous order");
console.log("props placement browser QA: new and dropped objects land directly under Props, first");
const s = await send("Page.captureScreenshot", { format: "png" }); (await import("node:fs")).writeFileSync(`${process.env.QA_OUT}/user-probe.png`, Buffer.from(s.data, "base64"));
ws.close();
