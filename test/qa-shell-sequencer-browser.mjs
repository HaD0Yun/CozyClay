#!/usr/bin/env node
// Browser QA for issue #528. The suite drives the real Sequencer through CDP:
// it checks the v2 geometry/colors, scrubs the ruler, cuts the Body clip, and
// authors a crane point on a real rail shot.
import { mkdirSync, writeFileSync } from "node:fs";
import { afterPageLoad } from "./bus/browser-navigation.mjs";
import { waitForFrameState } from "./bus/browser-frame-state.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const port = Number(process.env.CDP_PORT || 9528);
const appUrl = process.env.QA_URL || "http://127.0.0.1:5528/app/?motion=/demo/walk-then-stop.npz";
const outputDir = process.env.QA_OUT || "/tmp/cozyclay-task-14";
mkdirSync(outputDir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

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
const send = (method, params = {}) => afterPageLoad(ws, method, () => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
}));
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const waitFor = (expression, timeoutMs = 20000) => waitForFrameState(evaluate, expression, timeoutMs);

const centreOf = (selector) => evaluate(`(() => {
	const element = document.querySelector(${JSON.stringify(selector)});
	if (!element) return null;
	const rect = element.getBoundingClientRect();
	if (rect.width < 2 || rect.height < 2) return null;
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
})()`);
const mouse = (type, params) => send("Input.dispatchMouseEvent", { type, ...params });
await send("Runtime.enable");
await send("Page.enable");

const click = async (selector) => {
	const point = await centreOf(selector);
	if (!point) return false;
	await mouse("mousePressed", { x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
	await mouse("mouseReleased", { x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
	return true;
};
const screenshot = async (name) => {
	const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	const path = `${outputDir}/${name}.png`;
	writeFileSync(path, Buffer.from(capture.data, "base64"));
	console.log(`QA_SCREENSHOT ${path}`);
	return path;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

// Seed one real rail/crane cut before opening the app. The motion query still
// loads the shipped take onto the character; the authored camera document gives
// the second half of this suite a stable crane graph to edit.
const origin = new URL(appUrl).origin;
await send("Page.navigate", { url: `${origin}/favicon.ico` });
await evaluate(`(() => {
	const shot = {
		id: "task-14-rail",
		name: "Task 14 Rail",
		startFrame: 0,
		endFrame: 359,
		cameraKeys: [{ frame: 0, framing: { pos: { x: 0, y: 1.6, z: 3 }, yaw: 0, pitch: -0.1, fovDeg: 45 } }],
		camera: {
			mode: "rail",
			followCam: { distance: 3, height: 1.6, response: 0.7, lead: 0.25, railStartMode: "head", maxDollySpeed: 4, pitchOffsetDeg: 0, orbitOffsetDeg: 180 },
			cameraRail: [{ x: -2, z: -1 }, { x: -2, z: 8 }],
			railFollow: { mode: "range", startFrame: 0, endFrame: 359 },
			craneHeight: { points: [{ t: 0, height: 1.6 }, { t: 1, height: 1.6 }] },
		},
	};
	const scene = {
		version: 4,
		activeSceneId: "task-14-scene",
		scenes: [{
			id: "task-14-scene",
			name: "Task 14",
			objects: [],
			shotDocument: { version: 4, frameCount: 360, shots: [shot], waypoints: [] },
			stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }], hasCharSheet: false, shotAspect: "16:9" },
		}],
	};
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Task 14", updatedAt: Date.now() }));
	localStorage.setItem("${SCENES_STORAGE_KEY}", JSON.stringify(scene));
})()`);
await send("Page.navigate", { url: appUrl });

expect("Sequencer renders", await waitFor("!!document.querySelector('.v2-sequencer') && !!window.__cozyclay"));
expect("demo motion is loaded", await waitFor("!!window.__cozyclay?.motion && window.__cozyclay.motion.frames > 0"));
await evaluate("window.__cozyclay.pause?.()");
await waitFor("!document.querySelector('.tl-btn.play.on')");
await click('[data-mode-key="4"]');
expect("Motion mode exposes Body actions", await waitFor("document.querySelector('.v2-sequencer [data-testid=sequencer-add-block]') && document.querySelector('.v2-sequencer [data-testid=sequencer-cut]')"));

const geometry = await evaluate(`(() => {
	const root = document.querySelector('.v2-sequencer');
	const tree = root?.querySelector('.tl-track-tree');
	const rows = [...(root?.querySelectorAll('.tl-track-subrow') ?? [])];
	const playhead = root?.querySelector('.tl-playhead');
	return {
		treeWidth: tree ? tree.getBoundingClientRect().width : 0,
		rowHeights: rows.map((row) => row.getBoundingClientRect().height),
		playheadColor: playhead ? getComputedStyle(playhead).backgroundColor : "",
		labels: [...(root?.querySelectorAll('[data-lane-label]') ?? [])].map((node) => node.getAttribute('data-lane-label')),
	};
})()`);
expect("track tree is 190 px", Math.abs(geometry.treeWidth - 190) < 0.5, JSON.stringify(geometry));
expect("track rows are 38 px", geometry.rowHeights.length >= 8 && geometry.rowHeights.every((height) => Math.abs(height - 38) < 0.5), JSON.stringify(geometry.rowHeights));
expect("playhead is amber", geometry.playheadColor === "rgb(232, 163, 61)", geometry.playheadColor);
expect("v2 lane labels are present", ["Body", "IK keys", "Camera Cuts", "Rail", "Crane"].every((label) => geometry.labels.includes(label)), JSON.stringify(geometry.labels));
await screenshot("task-14-seq");

// The ruler is a real pointer surface. Click its midpoint and wait on the
// published frame state, not on a fixed delay.
const ruler = await centreOf(".v2-sequencer .tl-ruler-lane");
const frameCount = await evaluate("window.__cozyclay.frameCount");
if (!ruler) throw new Error("Sequencer ruler is not measurable");
await mouse("mousePressed", { x: ruler.x, y: ruler.y, button: "left", buttons: 1, clickCount: 1 });
await mouse("mouseReleased", { x: ruler.x, y: ruler.y, button: "left", buttons: 0, clickCount: 1 });
const midpoint = await waitFor(`window.__cozyclay.tlFrame >= Math.floor(${frameCount} * 0.45) && window.__cozyclay.tlFrame <= Math.ceil(${frameCount} * 0.55)`, 10000);
expect("ruler midpoint moves the playhead to about half", midpoint, String(await evaluate("window.__cozyclay.tlFrame")));

// Motion Cut splits the real Body take. The button is disabled at frame zero,
// so the same control is also the zero-length guard at the end of the suite.
await evaluate(`window.__cozyclay.scrub(Math.max(1, Math.floor(${frameCount} * 0.5)))`);
await waitFor(`window.__cozyclay.tlFrame > 0`);
const beforeCuts = await evaluate("document.querySelectorAll('.v2-sequencer .tl-motion-clip').length");
expect("one Body clip exists before Cut", beforeCuts === 1, String(beforeCuts));
expect("Cut control is enabled away from frame zero", await evaluate("document.querySelector('[data-testid=sequencer-cut]')?.disabled === false"));
await click("[data-testid=sequencer-cut]");
expect("Cut splits the Body clip", await waitFor(`document.querySelectorAll('.v2-sequencer .tl-motion-clip').length === ${beforeCuts + 1}`), String(await evaluate("document.querySelectorAll('.v2-sequencer .tl-motion-clip').length")));

const afterSplit = await evaluate("document.querySelectorAll('.v2-sequencer .tl-motion-clip').length");
await evaluate("window.__cozyclay.scrub(0)");
await waitFor("window.__cozyclay.tlFrame === 0");
expect("Cut at frame 0 is disabled", await evaluate("document.querySelector('[data-testid=sequencer-cut]')?.disabled === true"));
expect("Cut at frame 0 creates no zero-length clip", await evaluate(`(() => {
	const clips = [...document.querySelectorAll('.v2-sequencer .tl-motion-clip')];
	return clips.length === ${afterSplit} && clips.every((clip) => clip.getBoundingClientRect().width > 0);
})()`));

// Selecting the seeded shot enters Camera mode through the existing App
// callback. Scroll the real lane workspace to the camera group first: the
// v2 dock shows all rows at reference height, while narrow embeds retain the
// same scroll affordance.
await evaluate("document.querySelector('.v2-sequencer .tl-body').scrollTop = document.querySelector('.v2-sequencer .tl-body').scrollHeight");
await waitFor("(() => { const block = document.querySelector('.v2-sequencer .tl-shot-block'); return !!block && block.getBoundingClientRect().top < innerHeight && block.getBoundingClientRect().bottom > 0; })()");
await click(".v2-sequencer .tl-shot-label b");
expect("camera header actions appear for the selected shot", await waitFor("!!document.querySelector('[data-testid=sequencer-draw-rail]')"));
await evaluate("[...document.querySelectorAll('.tl-camera-editor button')].find((button) => button.textContent.trim() === 'Height')?.click()");
const craneBefore = await evaluate("document.querySelectorAll('.v2-sequencer .tl-crane-knob').length");
expect("seeded crane graph has two points", craneBefore === 2, String(craneBefore));
const keyStrip = await evaluate(`(() => {
	const body = document.querySelector('.v2-sequencer .tl-body');
	if (body) body.scrollTop = body.scrollHeight;
	const element = document.querySelector('.v2-sequencer .tl-shot-key-surface');
	if (!element) return null;
	const rect = element.getBoundingClientRect();
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, top: rect.top, bottom: rect.bottom, bodyTop: body?.getBoundingClientRect().top ?? 0, bodyBottom: body?.getBoundingClientRect().bottom ?? 0 };
})()`);
expect("crane key strip is visible after scrolling", !!keyStrip && keyStrip.top >= keyStrip.bodyTop && keyStrip.bottom <= keyStrip.bodyBottom, JSON.stringify(keyStrip));
if (keyStrip) {
	await mouse("mousePressed", { x: keyStrip.x, y: keyStrip.y, button: "left", buttons: 1, clickCount: 1 });
	await mouse("mouseReleased", { x: keyStrip.x, y: keyStrip.y, button: "left", buttons: 0, clickCount: 1 });
}
expect("a crane point can be added from the key strip", await waitFor(`document.querySelectorAll('.v2-sequencer .tl-crane-knob').length === ${craneBefore + 1}`), String(await evaluate("document.querySelectorAll('.v2-sequencer .tl-crane-knob').length")));
await screenshot("task-14-compare");

ws.close();
if (failures) process.exit(1);
console.log("all shell sequencer browser checks PASS");
