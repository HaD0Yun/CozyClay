#!/usr/bin/env node
// #1195: React "Maximum update depth exceeded" (#185) while scrubbing with the
// Pose mode Pin tool open. A scrub step is a sync commit (the frame store feeds
// useSyncExternalStore), and the Pin panel's preview effect ran on every frame
// and handed App a fresh preview object, so every scrub commit left a React
// update pending. When frames and input outrun React's scheduler task, React
// counts those commits as nested and throws #185 after 50 (the #1045 mechanism
// test/qa-update-depth-browser.mjs covers for playback with an empty cast).
//
// The suite plays the starved case directly: a character with a walk take in
// Pose mode with the Pin tool, then scrub steps posted as user-blocking tasks,
// which Chrome runs before React's scheduler task, the way it runs pointer
// input on a busy page.
//   QA_URL=http://127.0.0.1:5241/app/ CDP_PORT=9341 node tools/qa-browser.mjs -- node test/qa-scrub-update-depth-browser.mjs
import assert from "node:assert/strict";

const port = Number(process.env.CDP_PORT || 9222);
const STEPS = Number(process.env.QA_UPDATE_DEPTH_STEPS || 150);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
assert.ok(page, "QA browser exposes a page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
};
const send = (method, params = {}) => new Promise((resolve) => { nextId += 1; pending.set(nextId, resolve); ws.send(JSON.stringify({ id: nextId, method, params })); });
const evaluate = async (expression) => {
	const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
	return result?.result?.value;
};
const waitFor = async (label, expression, timeout = 60_000) => {
	const deadline = Date.now() + timeout;
	while (!(await evaluate(expression).catch(() => false))) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(200);
	}
};

await waitFor("window.__cozyclay.scrub", "!!(window.__cozyclay && window.__cozyclay.scrub)");
await sleep(1000);
if (!(await evaluate("window.__cozyclay.characters.length"))) {
	await evaluate(`window.__cozyclay.runStudioAction("character.add", { character: { id: "qa-pin", model: "y-bot-tpose", x: 0, z: 0, rot: 0, subject: "a person" } })`);
}
await waitFor("the character's rig", "!!window.__cozyclay.rigA?.parent", 30_000);
const characterId = await evaluate("window.__cozyclay.characters[0].id");
// The "Walk in" sample take (src/motion/sample-motions.js): two metres in from behind, ending where the character stands.
const compiled = await evaluate(`(async () => {
	const { x = 0, z = 0, rot = 0 } = window.__cozyclay.characters[0];
	const r = rot * Math.PI / 180, at = [x, z], from = [+(x - Math.sin(r) * 2).toFixed(3), +(z - Math.cos(r) * 2).toFixed(3)];
	const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto", use: [
		{ skill: "standIdle", f0: 0, args: { at: from, heading: rot } },
		{ skill: "walkTo", f0: 10, args: { to: at } },
	] };
	const receipt = await window.__cozyclay.runStudioAction("motion.compile", { characterId: ${JSON.stringify(characterId)}, spec, install: true });
	return JSON.stringify(receipt).slice(0, 300);
})()`);
await waitFor(`a walk take (${JSON.stringify(compiled)})`, "window.__cozyclay.motion?.schema === 'cozyclay.take.v3'", 30_000);
await evaluate(`document.querySelector('.vp-mode-key[data-mode=pose]')?.click()`);
await waitFor("Pose mode with IK", "window.__cozyclay.ikMode === true", 30_000);
await waitFor("the Pin tool button", "!!document.querySelector('[data-testid=range-pin-tool]:not([disabled])')", 30_000);
await evaluate(`document.querySelector('[data-testid=range-pin-tool]').click()`);
await waitFor("the Pin panel", "!!document.querySelector('[data-testid=range-pin-panel]')", 10_000);
await sleep(500);

const run = await evaluate(`(async () => {
	if (typeof scheduler === "undefined" || typeof scheduler.postTask !== "function") return { skipped: "no scheduler.postTask" };
	const errors = [];
	const onError = (event) => errors.push(String(event.error?.message ?? event.message));
	addEventListener("error", onError);
	const frames = Math.max(2, window.__cozyclay.frameCount);
	let steps = 0, thrown = null;
	try {
		for (let i = 0; i < ${STEPS}; i++) {
			await scheduler.postTask(() => window.__cozyclay.scrub(1 + (i % (frames - 1))), { priority: "user-blocking" });
			steps = i + 1;
		}
	} catch (error) {
		thrown = String(error?.message ?? error);
	}
	await new Promise((done) => setTimeout(done, 300));
	removeEventListener("error", onError);
	return { steps, thrown, errors, panel: !!document.querySelector("[data-testid=range-pin-panel]") };
})()`);
assert.ok(!run.skipped, `this Chrome has scheduler.postTask (${run.skipped})`);
const depth = /Maximum update depth|Minified React error #185/;
assert.ok(!depth.test(run.thrown ?? ""), `no React #185 while scrub steps outrun React's scheduler with the Pin tool open (threw after ${run.steps} steps: ${run.thrown})`);
assert.equal(run.thrown, null, `scrub steps run clean (${run.thrown})`);
assert.equal(run.steps, STEPS);
assert.deepEqual(run.errors.filter((message) => depth.test(message)), [], "no #185 reaches window error");
assert.ok(run.panel, "the Pin panel is still open after the scrub");
console.log(`PASS ${STEPS} starved scrub steps with the Pose mode Pin tool open: no React #185`);
ws.close();
process.exit(0);
