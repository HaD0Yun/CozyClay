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
//
// The same throw with no tool open, in Stage mode (a scrub of a shot on a busy page): the Details panel's review box
// cleared its draft from an effect on every frame, one pending update per scrub commit of a pointer scrub (the
// posted steps below do not leave it pending there). So the Stage is scrubbed first, by real pointer moves on the
// ruler, counting the commits that end with an update pending: what React counts toward the throw, and none when
// no effect sets state on a frame.
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
// --- Stage mode, as the Studio stands after the take: real pointer moves on the ruler ---
// the left button: a move with it up, a press, a move with it down, a release
const pointer = (type, x, y, held) => send("Input.dispatchMouseEvent", { type, x, y, button: held || type !== "mouseMoved" ? "left" : "none", buttons: held ? 1 : 0, clickCount: 1 });
const clickAt = async (selector, label) => {
	const at = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
	assert.ok(at, label);
	await pointer("mouseMoved", at.x, at.y, false); await pointer("mousePressed", at.x, at.y, true); await pointer("mouseReleased", at.x, at.y, false);
};
// Commits of the page's root that end with a sync, input or default update pending (lanes 2, 8, 32), read off the
// DevTools hook the dev build installs: at the commit, and after the effects a sync commit flushes inside itself.
const counted = await evaluate(`(() => {
	const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
	if (!hook || typeof hook.onCommitFiberRoot !== "function") return false;
	const counts = window.__qaCommits = { commits: 0, pending: 0 }, onCommit = hook.onCommitFiberRoot, onPost = hook.onPostCommitFiberRoot;
	let flushing = null;
	hook.onCommitFiberRoot = function (id, root, priority, ...rest) {
		if (root?.containerInfo instanceof Element) {
			counts.commits += 1;
			if (root.pendingLanes & 42) counts.pending += 1;
			else if (priority === 1) { flushing = root; queueMicrotask(() => { flushing = null; }); }
		}
		return onCommit.call(this, id, root, priority, ...rest);
	};
	hook.onPostCommitFiberRoot = function (id, root, ...rest) {
		if (root === flushing) { flushing = null; if (root.pendingLanes & 42) counts.pending += 1; }
		return onPost?.call(this, id, root, ...rest);
	};
	return true;
})()`);
const MOVES = 60;
const ruler = await evaluate(`(() => { const r = document.querySelector(".tl-ruler-lane").getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2, span: r.width - 8 }; })()`);
await evaluate("window.__qaCommits && Object.assign(window.__qaCommits, { commits: 0, pending: 0 }); window.__qaFrames = new Set()");
await pointer("mouseMoved", ruler.x, ruler.y, false);
await pointer("mousePressed", ruler.x, ruler.y, true);
for (let i = 1; i <= MOVES; i++) { await pointer("mouseMoved", ruler.x + ruler.span * i / MOVES, ruler.y, true); await evaluate("window.__qaFrames.add(window.__cozyclay.tlFrame)"); }
await pointer("mouseReleased", ruler.x + ruler.span, ruler.y, false);
await sleep(300);
const scrubbed = await evaluate("({ frames: window.__qaFrames.size, ...(window.__qaCommits ?? {}) })");
assert.ok(scrubbed.frames >= MOVES / 2, `the pointer scrub moved the playhead (${scrubbed.frames} frames in ${MOVES} moves)`);
if (counted) {
	assert.ok(scrubbed.commits >= scrubbed.frames, `every frame of the scrub committed (${JSON.stringify(scrubbed)})`);
	assert.equal(scrubbed.pending, 0, `no scrub commit in Stage mode ends with an update pending, as when an effect sets state on every frame (${JSON.stringify(scrubbed)})`);
	console.log(`PASS ${MOVES} pointer moves on the ruler in Stage mode: ${scrubbed.commits} commits, ${scrubbed.pending} with an update left pending`);
} else console.log("SKIP commit count: this build has no DevTools hook");

// The effect that is gone kept the review box's draft to its frame. It still does: typed on a frame of a shot, the
// draft stays while the playhead stays and is dropped when it leaves, also after it comes back.
await evaluate(`window.__cozyclay.runStudioAction("shot.create")`);
await waitFor("the shot block", `!!document.querySelector(".tl-shot-block")`, 10_000);
await clickAt('[data-node-id="camera"]', "the Outliner lists the camera");
const box = `document.querySelector('textarea[aria-label="Frame comment"]')`;
await waitFor("the Review fold of the camera's Details", `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Review")`, 10_000);
if (!(await evaluate(`!!${box}`))) await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Review").click()`);
await waitFor("the frame comment box", `!!${box}`, 10_000);
// two frames of the shot: the draft is typed on the first
const typedAt = await evaluate(`(async () => { const all = JSON.parse(await window.__cozyclayProject.export()).scenes; const scene = all.scenes.find((entry) => entry.id === all.activeSceneId) ?? all.scenes[0]; return scene.shotDocument.shots[0].startFrame; })()`), away = typedAt + 1;
await evaluate(`window.__cozyclay.scrub(${typedAt})`);
await waitFor("the playhead on the shot's first frame", `window.__cozyclay.tlFrame === ${typedAt} && !!${box}`, 5_000);
await evaluate(`${box}.focus()`);
await send("Input.insertText", { text: "hold this" });
assert.equal(await evaluate(`${box}.value`), "hold this", "the draft shows what was typed");
await evaluate(`window.__cozyclay.scrub(${away})`);
await waitFor("the draft dropped on another frame", `window.__cozyclay.tlFrame === ${away} && ${box}.value === ""`, 5_000);
await evaluate(`window.__cozyclay.scrub(${typedAt})`);
await waitFor("the draft still empty back on its frame", `window.__cozyclay.tlFrame === ${typedAt} && ${box}.value === ""`, 5_000);
console.log("PASS the review draft stays on its frame and is dropped when the playhead leaves");
// back to the character, as the Pose mode part below found the Studio before
await clickAt(`[data-node-id="character:${characterId}"]`, "the Outliner lists the character");

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
