#!/usr/bin/env node
// Browser contract: a pose edited in Pose mode survives a reload. The author
// drags a hand in Pose mode (an IK key at the playhead), the scene autosaves,
// and after a reload the hand is where the author left it — in Pose mode and
// back on the Stage.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5891 npm run dev -- --port 5791`
// in one shell, then
// `QA_URL=http://127.0.0.1:5791/app/ CDP_PORT=9432 node tools/qa-browser.mjs -- node test/qa-pose-persist-browser.mjs`
import assert from "node:assert/strict";

const cdpPort = Number(process.env.CDP_PORT || 9432);
const baseUrl = process.env.QA_URL || "http://127.0.0.1:5180/app/";
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((target) => target.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (label, expression, timeoutMs = 20000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return;
		await sleep(80);
	}
	throw new Error(`Timed out waiting for ${label}`);
};
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 });
const pressDigit = async (digit) => {
	for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: String(digit), code: `Digit${digit}`, windowsVirtualKeyCode: 48 + digit });
};
// Every bone's world position: the pose, wherever the edit landed.
const bones = () => evaluate(`(() => {
	const rig = window.__cozyclay.rigA; rig.updateMatrixWorld(true);
	const out = {}; rig.traverse((node) => { if (node.isBone && !(node.name in out)) { const e = node.matrixWorld.elements; out[node.name] = { x: e[12], y: e[13], z: e[14] }; } });
	return out;
})()`);
const maxShift = (a, b) => Math.max(...Object.keys(a).filter((name) => b[name]).map((name) => distance(a[name], b[name])));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: baseUrl });
await waitFor("viewport Add", "!!document.querySelector('[data-testid=viewport-add]')");
await evaluate("document.querySelector('[data-testid=viewport-add]').click()");
await waitFor("Character entry", "!!document.querySelector('[data-add=character]')");
await evaluate("document.querySelector('[data-add=character]').click()");
await waitFor("studio ready", "!!window.__cozyclay?.rigA && !!window.__cozyclay?.ikChains && !window.__cozyclay?.ikMode");

// Pose mode: focus a hand, then pull it along one of its axis arrows.
await pressDigit(2);
await waitFor("Pose mode", "window.__cozyclay?.ikMode === true && !!window.__ikControlScreenPositions");
await sleep(400);
const controls = await evaluate("window.__ikControlScreenPositions()");
// A handle under the timeline or a panel cannot be clicked: the canvas has to
// be the top element at the handle's pixel.
const clickable = await evaluate(`Object.fromEntries(Object.entries(window.__ikControlScreenPositions()).map(([id, p]) => [id, !!p?.exposed && document.elementFromPoint(p.x, p.y)?.tagName === "CANVAS"]))`);
const track = ["leftHand", "rightHand", "leftElbow", "rightElbow", "head", "chest"].find((id) => clickable[id]);
assert.ok(track, `a pose handle is clickable on the stage: ${JSON.stringify({ clickable, controls })}`);
const rest = await bones();
const center = controls[track];
await mouse("mousePressed", center.x, center.y); await mouse("mouseReleased", center.x, center.y);
await sleep(250);
await waitFor("hand focus", `window.__cozyclay?.ikFocus === ${JSON.stringify(track)} && window.__ikRingVisible()`).catch(async (error) => {
	console.error("focus debug:", JSON.stringify({ track, center, focus: await evaluate("window.__cozyclay?.ikFocus"), ring: await evaluate("window.__ikRingVisible()"), lastPick: await evaluate("window.__ikLastPick ?? null"), workflow: await evaluate("document.querySelector('.app')?.dataset.workflowMode") }));
	throw error;
});
const picks = await evaluate(`window.__ikPickScreenPositions().filter((pick) => pick.trackId === ${JSON.stringify(track)})`);
// An IK effector has axis arrows (pull along one); an FK joint has rotation
// rings (drag across one). Either is an ordinary Pose-mode edit.
const tip = picks.find((pick) => pick.part === "tip" && pick.axis === "y") ?? picks.find((pick) => pick.part === "tip");
const ring = picks.find((pick) => pick.part === "ring");
assert.ok(tip || ring, `the focused ${track} has a handle to drag: ${JSON.stringify(picks)}`);
const grab = tip ?? ring;
const dx = grab.x - center.x, dy = grab.y - center.y, length = Math.hypot(dx, dy) || 1;
const dir = tip ? { x: dx / length, y: dy / length } : { x: -dy / length, y: dx / length };
await mouse("mousePressed", grab.x, grab.y);
for (let i = 1; i <= 10; i += 1) { await mouse("mouseMoved", grab.x + dir.x * 6 * i, grab.y + dir.y * 6 * i); await sleep(16); }
await mouse("mouseReleased", grab.x + dir.x * 60, grab.y + dir.y * 60);
await sleep(300);
const posed = await bones();
assert.ok(maxShift(rest, posed) > 0.05, `the drag moved the ${track}: ${maxShift(rest, posed)}`);

// Autosave carries the edit.
await waitFor("autosave with the IK edit", `(() => {
	const raw = [...Array(localStorage.length).keys()].map((i) => localStorage.key(i)).filter((key) => /scenes/i.test(key)).map((key) => localStorage.getItem(key)).join("");
	return raw.includes('"ikEdits":{"keys":[{');
})()`, 8000);

// Reload: the hand stays where the author left it.
await send("Page.reload", { ignoreCache: false });
await waitFor("studio ready after reload", "!!window.__cozyclay?.rigA && !!window.__cozyclay?.ikChains");
await sleep(800);
const reloaded = await bones();
const report = { track, moved: +maxShift(rest, posed).toFixed(3), driftAfterReload: +maxShift(posed, reloaded).toFixed(4), backToRest: +maxShift(rest, reloaded).toFixed(3) };
console.log(JSON.stringify(report));
assert.ok(report.driftAfterReload < 0.01, `the edited pose survives the reload: ${JSON.stringify(report)}`);
console.log("pose persist browser QA: a Pose-mode edit survives a reload");
ws.close();
