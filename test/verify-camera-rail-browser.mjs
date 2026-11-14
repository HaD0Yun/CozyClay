#!/usr/bin/env node
// Browser contract for the camera rail deletion affordance. The math and
// persistence model are covered by node tests; this proves the actual editor
// button is visible, removes the authored rail, and persists Follow mode.
import { writeFileSync } from "node:fs";
import { afterPageLoad } from "./bus/browser-navigation.mjs";
import { waitForFrameState } from './bus/browser-frame-state.mjs';
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const port = Number(process.env.CDP_PORT || 9222);
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
const waitFor = (expression, timeoutMs = 10000) => waitForFrameState(evaluate, expression, timeoutMs);

// Ctrl+Shift+Z on a fresh load has an empty redo stack: a toast with no edit.
const pressRedo = async () => {
	for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, modifiers: 10, code: "KeyZ", key: "Z", windowsVirtualKeyCode: 90 });
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await send("Runtime.enable");
await send("Page.enable");
const studioUrl = process.env.QA_URL ?? "http://127.0.0.1:5180/app/";
// Seed storage without a mounted editor that could autosave over the fixture.
await send("Page.navigate", { url: `${new URL(studioUrl).origin}/favicon.ico` });
await evaluate(`(() => {
	const shot = {
		id: "rail-qa",
		name: "Rail QA",
		startFrame: 0,
		endFrame: 359,
		cameraKeys: [{ frame: 0, framing: { pos: { x: 0, y: 1.6, z: 3 }, yaw: 0, pitch: -0.1, fovDeg: 45 } }],
		camera: {
			mode: "rail",
			followCam: { distance: 3, height: 1.6, response: 0.7, lead: 0.25, railStartMode: "head", maxDollySpeed: 4, pitchOffsetDeg: 0, orbitOffsetDeg: 180 },
			cameraRail: [{ x: -2, z: -1 }, { x: -2, z: 8 }],
			railFollow: { mode: "range", startFrame: 0, endFrame: 359 },
		},
	};
	const scene = {
		version: 4,
		activeSceneId: "scene-rail-qa",
		scenes: [{
			id: "scene-rail-qa",
			name: "RAIL QA",
			objects: [],
			shotDocument: { version: 4, frameCount: 360, shots: [shot], waypoints: [] },
			stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }], hasCharSheet: false, shotAspect: "16:9" },
		}],
	};
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Rail QA", updatedAt: Date.now() }));
	localStorage.setItem("${SCENES_STORAGE_KEY}", JSON.stringify(scene));
})()`);
await send("Page.navigate", { url: studioUrl });
expect("studio renders", await waitFor("!!document.querySelector('canvas')"));
expect("timeline shot block renders", await waitFor("!!document.querySelector('.tl-shot-block')"));
await evaluate("document.querySelector('.tl-shot-block')?.click()");
expect("rail editor exposes delete action", await waitFor("[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Delete rail')"));
expect("Draw Rail row starts with Follow Off while rail owns the camera", await waitFor("[...document.querySelectorAll('.tl-camera-editor button')].some((button) => button.textContent.trim() === 'Follow Off' && button.getAttribute('aria-pressed') === 'false')"));
expect("follow distance is visible before deletion", await evaluate("[...document.querySelectorAll('.tl-camera-editor label')].some((label) => label.textContent.includes('Distance') && label.textContent.includes('3.00'))"));
if (process.env.QA_SCREENSHOT) {
	const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	writeFileSync(process.env.QA_SCREENSHOT, Buffer.from(capture.data, "base64"));
}
// #483: a toast must survive the dismissal timer of the toast it replaces. On
// the slow software-GL runner the older toast's 2.2 s timer fired before React
// committed the rail toast, and that timer wiped it. Show an older toast, then
// fire that toast's own onDone inside the Delete rail click, after React's
// handler, so the dismissal and the rail toast land in one render: the order
// the slow runner produced, on any machine. (Fired outside the event, React
// may render the two in separate lanes and the rail toast flashes first.) The
// redo press guarantees an older toast; a startup toast may replace it, and
// any visible one will do.
await pressRedo();
// The toast lives 2.2 s and the checks below wait for other state first, so
// record its appearance from before the click instead of reading it later.
await evaluate(`(() => {
	window.__railToastSeen = false;
	const seen = () => { if (document.body.textContent.includes('Camera rail deleted')) { window.__railToastSeen = true; return true; } return false; };
	if (seen()) return;
	const observer = new MutationObserver(() => { if (seen()) observer.disconnect(); });
	observer.observe(document.body, { childList: true, subtree: true, characterData: true });
})()`);
// Waits in the page and acts in the task that sees the older toast, so it can
// neither expire nor be replaced between the check and the click.
const olderDismissalFired = await evaluate(`new Promise((resolve) => {
	const fire = () => {
		const toast = document.querySelector('.toast');
		if (!toast?.textContent.trim()) return false;
		const key = Object.keys(toast).find((name) => name.startsWith('__reactFiber$'));
		let fiber = key ? toast[key] : null;
		while (fiber && typeof fiber.memoizedProps?.onDone !== 'function') fiber = fiber.return;
		const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === 'Delete rail');
		// window bubbles after React's root listener: same event, same lane.
		if (fiber) window.addEventListener('click', () => fiber.memoizedProps.onDone(), { once: true });
		button?.click();
		resolve(!!fiber && !!button);
		return true;
	};
	if (fire()) return;
	const observer = new MutationObserver(() => { if (fire()) { observer.disconnect(); clearTimeout(timer); } });
	const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, 10000);
	observer.observe(document.body, { childList: true, subtree: true, characterData: true });
})`);
expect("the older toast's dismissal fires before the rail toast renders", olderDismissalFired === true);
expect("delete action leaves Follow mode", await waitFor("document.querySelector('.tl-camera-slate')?.textContent.includes('Camera preview')"));
expect("rail deletion turns the Draw Rail row Follow On", await waitFor("[...document.querySelectorAll('.tl-camera-editor button')].some((button) => button.textContent.trim() === 'Follow On' && button.getAttribute('aria-pressed') === 'true')"));
expect("rail delete toast is shown", await waitFor("window.__railToastSeen === true"));
expect("live Follow camera holds the displayed 3 m distance", await waitFor(`(() => {
	const state = window.__cozyclay;
	if (!state?.shotCam || !state?.activeChar) return false;
	return Math.abs(Math.hypot(state.shotCam.position.x - state.activeChar.x, state.shotCam.position.z - state.activeChar.z) - 3) < 0.05;
})()`));
expect("front-authored Follow stays in front of the subject", await waitFor(`(() => {
	const state = window.__cozyclay;
	return !!state?.shotCam && !!state?.activeChar && state.shotCam.position.z > state.activeChar.z;
})()`));
expect("rail deletion reaches the debounced Scene save", await waitFor(`(() => {
	const body = JSON.parse(localStorage.getItem("${SCENES_STORAGE_KEY}"));
	const camera = body.scenes[0].shotDocument.shots[0].camera;
	return camera.mode === "follow" && camera.cameraRail === null && camera.railFollow === null;
})()`));
const persisted = await evaluate(`(() => {
	const body = JSON.parse(localStorage.getItem("${SCENES_STORAGE_KEY}"));
	const camera = body.scenes[0].shotDocument.shots[0].camera;
	return { mode: camera.mode, cameraRail: camera.cameraRail, railFollow: camera.railFollow };
})()`);
expect("deleted rail persists as Follow without geometry", persisted.mode === "follow" && persisted.cameraRail === null && persisted.railFollow === null, JSON.stringify(persisted));
await send("Page.reload");
expect("studio returns after reload", await waitFor("!!document.querySelector('canvas')"));
expect("shot block returns after reload", await waitFor("!!document.querySelector('.tl-shot-block')"));
await evaluate("document.querySelector('.tl-shot-block')?.click()");
expect("Follow mode survives reload", await waitFor("document.querySelector('.tl-camera-slate')?.textContent.includes('Camera preview')"));
await evaluate("[...document.querySelectorAll('.tl-camera-editor button')].find((button) => button.textContent.trim() === 'Follow On')?.click()");
expect("Draw Rail row Follow Off returns to Keys mode", await waitFor("[...document.querySelectorAll('.tl-camera-editor button')].some((button) => button.textContent.trim() === 'Follow Off' && button.getAttribute('aria-pressed') === 'false')"));
expect("free shot camera is available for reframing", await waitFor("!!window.__cozyclay?.shotCam"));
await evaluate("window.__cozyclay.shotCam.position.set(0, 1.6, 3)");
await evaluate("[...document.querySelectorAll('.tl-camera-editor button')].find((button) => button.textContent.trim() === 'Follow Off')?.click()");
expect("Draw Rail row Follow On restores distance mode", await waitFor("[...document.querySelectorAll('.tl-camera-editor button')].some((button) => button.textContent.trim() === 'Follow On' && button.getAttribute('aria-pressed') === 'true')"));
expect("Follow On captures the user's front camera placement", await waitFor(`(() => {
	const state = window.__cozyclay;
	return state.shotCam.position.z > state.activeChar.z &&
		Math.abs(Math.hypot(state.shotCam.position.x - state.activeChar.x, state.shotCam.position.z - state.activeChar.z) - 3) < 0.05;
})()`));
expect("front placement is persisted as a 180 degree orbit offset", await waitFor(`(() => {
	const body = JSON.parse(localStorage.getItem("${SCENES_STORAGE_KEY}"));
	return Math.abs(body.scenes[0].shotDocument.shots[0].camera.followCam.orbitOffsetDeg - 180) < 0.1;
})()`));

// A dismissed Korean toast must leave no toast box behind. The dismissal once
// resolved its updater as a localizer, which answered `isKo` (true) and
// rendered an empty toast for another 2.2 s after every Korean toast.
await evaluate("localStorage.setItem('cozyclay.locale', 'ko')");
await send("Page.reload");
// The QA state is published after App installs its keyboard listener. A DOM
// shell alone is not sufficient readiness for dispatching the redo shortcut.
expect("Korean studio returns after reload", await waitFor("!!window.__cozyclay && !!document.querySelector('.tl-shot-block')"));
// Recorded, not polled: the async startup toast can replace the redo toast at
// once (or land in the same render), so any Korean toast counts.
await evaluate(`(() => {
	window.__koToastSeen = false;
	window.__emptyToastSeen = false;
	const check = () => {
		const toast = document.querySelector('.toast');
		if (!toast) return;
		const text = toast.textContent.trim();
		if (/[\\uac00-\\ud7a3]/.test(text)) window.__koToastSeen = true;
		if (!text) window.__emptyToastSeen = true;
	};
	new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true });
})()`);
await pressRedo();
expect("Korean toast is shown", await waitFor("window.__koToastSeen === true"));
// The startup toasts queue behind it; on a slow runner the chain outlasts 10 s.
expect("Korean toast dismisses itself", await waitFor("!document.querySelector('.toast')", 30000));
expect("Korean toast dismissal leaves no empty toast box", await evaluate("window.__emptyToastSeen === false"));

ws.close();
if (failures) process.exit(1);
console.log("all camera rail browser checks PASS");
