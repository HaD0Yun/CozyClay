#!/usr/bin/env node
// Browser QA for issue #606. The action bar is reached with a real pointer
// path from the shot block to each button, including the former two-pixel gap.
import { mkdirSync, writeFileSync } from "node:fs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const port = Number(process.env.CDP_PORT || 9222);
const outputDir = process.env.QA_OUT || "/tmp/cozyclay-shot-actions";
const appUrl = process.env.QA_URL || "http://127.0.0.1:5180/app/";
mkdirSync(outputDir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const waitFor = async (expression, timeoutMs = 20000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await evaluate(expression).catch(() => false)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 60));
	}
};
const screenshot = async (name) => {
	const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	const path = `${outputDir}/${name}.png`;
	writeFileSync(path, Buffer.from(data, "base64"));
	console.log(`QA_SCREENSHOT ${path}`);
	return path;
};
const pointFor = async (selector) => evaluate(`(() => {
	const element = document.querySelector(${JSON.stringify(selector)});
	if (!element) return null;
	const rect = element.getBoundingClientRect();
	if (rect.width < 2 || rect.height < 2) return null;
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
})()`);
const mouseMove = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
const movePointer = async (from, to) => {
	await mouseMove(from.x, from.y);
	// A fixed step count could jump over the two-pixel regression entirely.
	const steps = Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)));
	for (let step = 1; step <= steps; step += 1) {
		await mouseMove(from.x + (to.x - from.x) * (step / steps), from.y + (to.y - from.y) * (step / steps));
		if (!await evaluate("getComputedStyle(document.querySelector('.tl-shot-actions')).display === 'flex'")) return false;
	}
	return true;
};
const clickPoint = async (point) => {
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

// Seed one real shot, leaving enough free timeline for Duplicate and Split.
const origin = new URL(appUrl).origin;
await send("Page.navigate", { url: `${origin}/favicon.ico` });
await evaluate(`(() => {
	const shot = {
		id: "qa-shot-actions",
		name: "QA Shot",
		startFrame: 0,
		endFrame: 79,
		cameraKeys: [],
		camera: { mode: "keys", followCam: { distance: 3, height: 1.6, response: 0.7, lead: 0.25, railStartMode: "head", maxDollySpeed: 4, pitchOffsetDeg: 0, orbitOffsetDeg: 0 } },
	};
	const scene = {
		version: 4,
		activeSceneId: "qa-shot-actions-scene",
		scenes: [{
			id: "qa-shot-actions-scene",
			name: "Shot actions QA",
			objects: [],
			shotDocument: { version: 4, frameCount: 240, shots: [shot], waypoints: [] },
			stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }], hasCharSheet: false, shotAspect: "16:9" },
		}],
	};
	localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded');
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Shot actions QA", updatedAt: Date.now() }));
	localStorage.setItem("${SCENES_STORAGE_KEY}", JSON.stringify(scene));
})()`);
await send("Page.navigate", { url: appUrl });

expect("the Studio and v2 sequencer are ready", await waitFor("!!document.querySelector('.v2-sequencer') && !!document.querySelector('.tl-shot-block')", 60000));
await evaluate("document.querySelector('.tl-shot-block')?.scrollIntoView({ block: 'center', inline: 'center' })");

const actionBarVisible = () => waitFor("getComputedStyle(document.querySelector('.tl-shot-actions')).display === 'flex'", 5000);
const reachAction = async (buttonIndex) => {
	const block = await pointFor(".tl-shot-block");
	if (!block) return false;
	await mouseMove(block.x, block.y);
	if (!await actionBarVisible()) return false;
	const action = await pointFor(`.tl-shot-actions button:nth-of-type(${buttonIndex})`);
	if (!action) return false;
	if (!await movePointer(block, action)) return false;
	return evaluate(`document.elementFromPoint(${action.x}, ${action.y})?.closest('button') === document.querySelector('.tl-shot-actions button:nth-of-type(${buttonIndex})')`);
};

expect("the action bar stays visible while crossing from the block", await reachAction(2));
let action = await pointFor(".tl-shot-actions button:nth-of-type(2)");
if (action) await clickPoint(action);
expect("Duplicate is clickable after the pointer crosses from the block", await waitFor("document.querySelectorAll('.tl-shot-block').length === 2", 10000));

await evaluate("document.querySelectorAll('.tl-shot-block')[0]?.scrollIntoView({ block: 'center', inline: 'center' })");
expect("Delete stays reachable from the first shot", await reachAction(3));
action = await pointFor(".tl-shot-actions button:nth-of-type(3)");
if (action) await clickPoint(action);
expect("Delete removes the first shot", await waitFor("document.querySelectorAll('.tl-shot-block').length === 1", 10000));

await evaluate("window.__cozyclay.scrub(100)");
expect("the playhead reaches the remaining shot", await waitFor("window.__cozyclay.tlFrame === 100", 10000));
await evaluate("document.querySelector('.tl-shot-block')?.scrollIntoView({ block: 'center', inline: 'center' })");
expect("Split stays reachable from the shot", await reachAction(1));
action = await pointFor(".tl-shot-actions button:nth-of-type(1)");
if (action) await clickPoint(action);
expect("Split is clickable after the pointer crosses from the block", await waitFor("document.querySelectorAll('.tl-shot-block').length === 2", 10000));

await screenshot("shot-actions");
ws.close();
if (failures) process.exit(1);
console.log("qa-shot-actions-browser: all checks passed");
