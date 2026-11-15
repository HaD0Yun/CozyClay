#!/usr/bin/env node
// Browser QA for issue #524: the viewport overlays. Drives the real studio
// through CDP: the mode toolbar in every mode, "+ Add" › Cube, the camera
// preview inset, the speed readout, the 1280px layout and the project-mode
// gating (#650). CozyClay 3 dropped the v2 pixel spec (32 px amber toolbar
// with W/E/R and a value group inside it); the glass shell's toolbar is 40 px
// and carries the mode keys only. Motion comes from motion.compile, so there is
// no top-bar Generate and no + Block control to look for.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterPageLoad } from "./bus/browser-navigation.mjs";
import { waitForFrameState } from "./bus/browser-frame-state.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const port = Number(process.env.CDP_PORT || 9524);
const appUrl = process.env.QA_URL || "http://127.0.0.1:5524/app/?motion=/demo/walk-then-stop.npz";
const outputDir = process.env.QA_OUT || "/tmp/cozyclay-task-10";
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
const mouse = (type, params) => send("Input.dispatchMouseEvent", { type, ...params });
const rectOf = (selector) => evaluate(`(() => {
	const element = document.querySelector(${JSON.stringify(selector)});
	if (!element) return null;
	const r = element.getBoundingClientRect();
	return { x: r.left, y: r.top, width: r.width, height: r.height };
})()`);
const click = async (selector) => {
	const r = await rectOf(selector);
	if (!r || r.width < 2 || r.height < 2) return false;
	const x = r.x + r.width / 2;
	const y = r.y + r.height / 2;
	await mouse("mousePressed", { x, y, button: "left", buttons: 1, clickCount: 1 });
	await mouse("mouseReleased", { x, y, button: "left", buttons: 0, clickCount: 1 });
	return true;
};
const capture = async (clip) => {
	const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
	return shot.data;
};
const save = (name, base64) => {
	const path = `${outputDir}/${name}.png`;
	writeFileSync(path, Buffer.from(base64, "base64"));
	console.log(`QA_SCREENSHOT ${path}`);
	return path;
};
const viewportSize = (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await send("Runtime.enable");
await send("Page.enable");
await viewportSize(1920, 1080);

// One character and one named shot, so the inset header has a shot to name.
const origin = new URL(appUrl).origin;
await send("Page.navigate", { url: `${origin}/favicon.ico` });
await evaluate(`(() => {
	const shot = {
		id: "task-10-shot",
		name: "Shot_A",
		startFrame: 0,
		endFrame: 359,
		cameraKeys: [{ frame: 0, framing: { pos: { x: 0.97, y: 1.62, z: 2.39 }, yaw: 0.4, pitch: -0.1, fovDeg: 45 } }],
	};
	const scene = {
		version: 4,
		activeSceneId: "task-10-scene",
		scenes: [{
			id: "task-10-scene",
			name: "Task 10",
			objects: [],
			shotDocument: { version: 4, frameCount: 360, shots: [shot], waypoints: [] },
			stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }], hasCharSheet: false, shotAspect: "16:9" },
		}],
	};
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Task 10", updatedAt: Date.now() }));
	localStorage.setItem("${SCENES_STORAGE_KEY}", JSON.stringify(scene));
})()`);
await send("Page.navigate", { url: appUrl });

expect("the studio renders the mode toolbar", await waitFor("!!document.querySelector('[data-testid=mode-toolbar] [data-mode-key]') && !!window.__cozyclay"));
expect("the character rig can be posed", await waitFor("!!window.__cozyclay?.ikChains && !!window.__cozyclay?.rigA", 60000));
await evaluate("window.__cozyclay.pause?.()");

const TOOLBAR = "[data-testid=mode-toolbar]";
const toolbar = await evaluate(`(() => {
	const bar = document.querySelector('${TOOLBAR}');
	const keys = [...bar.querySelectorAll('[data-mode-key]')];
	return {
		height: bar.getBoundingClientRect().height,
		keys: keys.map((key) => key.dataset.modeKey),
		active: keys.filter((key) => key.classList.contains('active') || key.getAttribute('aria-selected') === 'true').length,
		titles: keys.every((key) => key.title.length > 0),
	};
})()`);
expect("the toolbar is 20 px tall", toolbar.height === 20, JSON.stringify(toolbar));
expect("mode keys read 1 2 3 4 5", toolbar.keys.join("") === "12345", JSON.stringify(toolbar));
expect("exactly one mode key is active", toolbar.active === 1, JSON.stringify(toolbar));
expect("every mode key has a title", toolbar.titles, JSON.stringify(toolbar));

const speed = await evaluate("document.querySelector('[data-testid=fly-speed]')?.textContent.trim()");
expect("the top-right pill reads the fly speed", /^\d+(\.\d+)?×$/.test(speed ?? ""), String(speed));

// Per mode: one active key that names the mode, and the inset where it belongs.
const G1 = {
	scene: { key: "1", name: "Stage" },
	pose: { key: "2", name: "Pose" },
	camera: { key: "3", name: "Camera" },
	motion: { key: "4", name: "Motion" },
};
const snapshots = [];
const modeReport = {};
for (const [mode, spec] of Object.entries(G1)) {
	await click(`[data-mode-key="${spec.key}"]`);
	const entered = await waitFor(`document.querySelector('.app')?.dataset.workflowMode === '${mode}' && document.querySelector('[data-mode-key="${spec.key}"]')?.classList.contains('active')`);
	expect(`key ${spec.key} enters ${mode}`, entered);
	const state = await evaluate(`(() => {
		const bar = document.querySelector('${TOOLBAR}');
		const active = [...bar.querySelectorAll('[data-mode-key]')].filter((key) => key.classList.contains('active'));
		return {
			height: bar.getBoundingClientRect().height,
			activeModes: active.length,
			activeText: active[0]?.textContent.trim(),
			html: bar.outerHTML,
		};
	})()`);
	modeReport[mode] = { ...state, html: undefined };
	snapshots.push(state.html);
	expect(`${mode}: the toolbar stays 20 px`, state.height === 20, JSON.stringify(modeReport[mode]));
	expect(`${mode}: exactly one active mode key, named ${spec.name}`, state.activeModes === 1 && state.activeText === `${spec.key}${spec.name}`, JSON.stringify(modeReport[mode]));

	const inset = await evaluate(`(() => {
		const el = document.querySelector('.vp-shot-preview');
		const r = el.getBoundingClientRect();
		const head = el.querySelector('.vp-shot-preview-tag').getBoundingClientRect();
		return { visible: !el.hidden && getComputedStyle(el).display !== 'none' && r.width > 0, width: r.width, header: head.height, text: el.querySelector('[data-testid=shot-preview-header]')?.textContent.trim() };
	})()`);
	// The preview fills the dock's Shot Camera frame, so it shows in every
	// mode: hidden, the frame was a hole onto the editor view (Pose, Motion).
	expect(`${mode}: the camera preview inset is visible`, inset.visible && inset.width > 0, JSON.stringify(inset));
	if (mode === "scene" || mode === "camera") {
		expect(`${mode}: the inset header names the shot and lens`, inset.header > 0 && /^Shot_A\s*\d+(\.\d+)?mm$/.test(inset.text ?? ""), JSON.stringify(inset));
	}
}
writeFileSync(`${outputDir}/task-10-modes.json`, JSON.stringify(modeReport, null, 2));

// Evidence: the four per-mode toolbars stacked, rendered by the app's own CSS.
await evaluate(`(() => {
	const board = document.createElement('div');
	board.id = 'task-10-board';
	board.style.cssText = 'position:absolute;left:50%;top:120px;transform:translateX(-50%);z-index:50;display:grid;gap:12px;justify-items:center;padding:16px;background:#1d1e20;border-radius:6px';
	board.innerHTML = ${JSON.stringify(snapshots)}.join('');
	document.querySelector('.viewport').appendChild(board);
})()`);
const board = await rectOf("#task-10-board");
save("task-10-modes", await capture(board));
await evaluate("document.getElementById('task-10-board').remove()");

// Back to Stage for the add route and the overview capture.
await click('[data-mode-key="1"]');
await waitFor("document.querySelector('.app')?.dataset.workflowMode === 'scene'");
const before = await evaluate("window.__cozyclay.objects.length");
await click("[data-testid=viewport-add]");
expect("+ Add opens the catalogue with Character and Camera", await waitFor("!!document.querySelector('.viewport-titlebar .add-object-swatch.cube') && !!document.querySelector('.viewport-titlebar [data-add=character]') && !!document.querySelector('.viewport-titlebar [data-add=camera]')"));
save("task-10-add-menu", await capture());
await evaluate("document.querySelector('.viewport-titlebar .add-object-swatch.cube').closest('button').setAttribute('data-qa-cube', '1')");
await click("[data-qa-cube]");
expect("+ Add › Cube adds one scene object", await waitFor(`window.__cozyclay.objects.length === ${before + 1} && window.__cozyclay.objects.at(-1)?.renderer === 'cube'`), String(await evaluate("window.__cozyclay.objects.map((o) => o.renderer).join(',')")));
expect("the Add menu closes after a pick", await waitFor("!document.querySelector('.viewport-titlebar .add-object-menu')"));

const pill = await evaluate("[...document.querySelectorAll('.vp-view-pill .vp-pill-segment')].map((node) => node.textContent.trim())");
expect("the view pill reads Perspective | Clay Lit | Show", pill.join("|") === "Perspective|Clay Lit|Show", JSON.stringify(pill));
await evaluate("document.activeElement?.blur()");
const app1920 = save("task-10-1920", await capture());

// Failure case: at 1280 the centred toolbar never covers the left pills.
await viewportSize(1280, 800);
const layout = {};
for (const [mode, spec] of Object.entries(G1)) {
	await click(`[data-mode-key="${spec.key}"]`);
	await waitFor(`document.querySelector('.app')?.dataset.workflowMode === '${mode}'`);
	layout[mode] = await evaluate(`(() => {
		const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
		const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
		const bar = box(document.querySelector('${TOOLBAR}'));
		const add = box(document.querySelector('[data-testid=viewport-add]'));
		const view = box(document.querySelector('.vp-view-pill'));
		const speed = box(document.querySelector('[data-testid=fly-speed]'));
		return { toolbar: bar, add, view, speed, addIntersection: overlap(bar, add), viewIntersection: overlap(bar, view), speedIntersection: overlap(bar, speed) };
	})()`);
	expect(`1280 ${mode}: the toolbar does not overlap + Add or the view pill`, layout[mode].addIntersection === 0 && layout[mode].viewIntersection === 0 && layout[mode].speedIntersection === 0, JSON.stringify(layout[mode]));
}
writeFileSync(`${outputDir}/task-10-1280.json`, JSON.stringify(layout, null, 2));
console.log(`QA_EVIDENCE ${outputDir}/task-10-1280.json`);
await click('[data-mode-key="1"]');
await waitFor("document.querySelector('.app')?.dataset.workflowMode === 'scene'");
save("task-10-1280", await capture());

// #650: the project mode gates the shell. Each project is opened fresh in the
// light and the dark theme: a storyboard shows 1 2 3 5 (no Motion), ignores
// key 4 and badges "Storyboard"; an animation project shows 1 2 3 4 5 with the
// badge "Animation". Neither has a top-bar Generate in CozyClay 3.
const nextFrame = () => evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
const openPrevisProject = async (previsMode, theme) => {
	await send("Page.navigate", { url: `${origin}/favicon.ico` });
	await evaluate(`(() => {
		const scene = {
			version: 4,
			activeSceneId: "task-19-scene",
			scenes: [{
				id: "task-19-scene", name: "Task 19", objects: [],
				shotDocument: { version: 4, frameCount: 144, shots: [], waypoints: [] },
				stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person", layer: { waypoints: [], promptClips: [{ id: "prompt-clip-task-25", startFrame: 0, endFrame: 48, text: "walks to the door" }] } }], hasCharSheet: false, shotAspect: "16:9" },
			}],
		};
		localStorage.clear();
		localStorage.setItem("cozyclay.locale", "en");
		localStorage.setItem("cozyclay.theme.v1", ${JSON.stringify(theme)});
		localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Task 19", previsMode: ${JSON.stringify(previsMode)}, updatedAt: Date.now() }));
		localStorage.setItem("${SCENES_STORAGE_KEY}", JSON.stringify(scene));
	})()`);
	await send("Page.navigate", { url: appUrl });
	const ready = await waitFor(`!!window.__cozyclay && document.querySelector('.app')?.dataset.previsMode === '${previsMode}' && !!document.querySelector('[data-testid=mode-toolbar] [data-mode-key]') && !!document.querySelector('[data-testid=topbar-previs-mode]')`, 60000);
	expect(`${previsMode}/${theme}: the studio opens the ${previsMode} project`, ready);
	await evaluate("window.__cozyclay.pause?.()");
	await evaluate("document.activeElement?.blur()");
};
const readPrevisShell = () => evaluate(`(() => {
	const badge = document.querySelector('[data-testid=topbar-previs-mode]');
	return {
		previsMode: document.querySelector('.app')?.dataset.previsMode,
		theme: document.documentElement.dataset.theme,
		keys: [...document.querySelectorAll('[data-testid=mode-toolbar] [data-mode-key]')].map((key) => key.dataset.modeKey).join(''),
		badge: badge?.textContent.trim() ?? null,
		badgeColor: badge ? getComputedStyle(badge).color : null,
		generate: !!document.querySelector('[data-testid=topbar-generate]'),
		workflowMode: document.querySelector('.app')?.dataset.workflowMode,
		agentTitle: document.querySelector('.agent-title')?.textContent.trim() ?? null,
		// Task 25: a storyboard has no prompt-block lane, chips or edit controls.
		promptLane: !!document.querySelector('.tl-track[data-track-id="Prompts"]'),
		promptChips: document.querySelectorAll('.tl-chip-input').length,
		promptAdd: !!document.querySelector('[data-testid=sequencer-add-block], .tl-track-add[title*="prompt clip"]'),
		promptPanel: [...document.querySelectorAll('.foldout')].some((node) => node.textContent.includes('Prompt Blocks')),
		bodyLane: !!document.querySelector('.tl-track[data-track-id="Full-Body"]'),
	};
})()`);
const pressDigit4 = async () => {
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "4", code: "Digit4", windowsVirtualKeyCode: 52 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "4", code: "Digit4", windowsVirtualKeyCode: 52 });
	await nextFrame();
};
const previsReport = {};
for (const theme of ["light", "dark"]) {
	await openPrevisProject("storyboard", theme);
	const storyboard = await readPrevisShell();
	expect(`storyboard/${theme}: mode tabs read 1 2 3 5`, storyboard.keys === "1235", JSON.stringify(storyboard));
	expect(`storyboard/${theme}: the badge reads Storyboard`, storyboard.badge === "Storyboard", JSON.stringify(storyboard));
	expect(`storyboard/${theme}: no topbar-generate`, storyboard.generate === false, JSON.stringify(storyboard));
	expect(`storyboard/${theme}: no prompt lane, chip, add control or Prompt Blocks panel despite an existing block`, storyboard.promptLane === false && storyboard.promptChips === 0 && storyboard.promptAdd === false && storyboard.promptPanel === false, JSON.stringify(storyboard));
	expect(`storyboard/${theme}: the other lanes stay`, storyboard.bodyLane === true, JSON.stringify(storyboard));
	expect(`storyboard/${theme}: the theme is ${theme}`, storyboard.theme === theme, JSON.stringify(storyboard));
	await pressDigit4();
	const afterKey = await readPrevisShell();
	expect(`storyboard/${theme}: key 4 does nothing`, afterKey.workflowMode === storyboard.workflowMode && afterKey.workflowMode !== "motion", JSON.stringify({ before: storyboard.workflowMode, after: afterKey.workflowMode }));
	previsReport[`storyboard-${theme}`] = { ...storyboard, afterDigit4: afterKey.workflowMode };
	console.log(`QA_PREVIS storyboard/${theme} ${JSON.stringify(previsReport[`storyboard-${theme}`])}`);
	save(`task-19-storyboard-${theme}`, await capture());
	if (theme === "light") save("task-19-previs-modes", await capture());

	await openPrevisProject("animation", theme);
	const animation = await readPrevisShell();
	expect(`animation/${theme}: mode tabs read 1 2 3 4 5`, animation.keys === "12345", JSON.stringify(animation));
	expect(`animation/${theme}: the badge reads Animation`, animation.badge === "Animation", JSON.stringify(animation));
	expect(`animation/${theme}: no topbar-generate`, animation.generate === false, JSON.stringify(animation));
	previsReport[`animation-${theme}`] = animation;
	console.log(`QA_PREVIS animation/${theme} ${JSON.stringify(animation)}`);
	save(`task-19-animation-${theme}`, await capture());
	await evaluate("document.activeElement?.blur()");
	await pressDigit4();
	const animationMotion = await waitFor("document.querySelector('.app')?.dataset.workflowMode === 'motion'", 10000);
	expect(`animation/${theme}: key 4 enters Motion`, animationMotion === true, String(animationMotion));
}

// Failure path: Motion through every door of a storyboard is refused. The bus
// answers view.setMode {mode:"motion"} with the toast text and the mode stays;
// the UI door (selectWorkflowMode) shows the same text as a toast.
await openPrevisProject("storyboard", "light");
const refusal = await evaluate(`(() => {
	const element = document.querySelector('.app');
	let fiber = element[Object.keys(element).find((key) => key.startsWith('__reactFiber'))];
	while (fiber && !fiber.memoizedProps?.value?.bus) fiber = fiber.return;
	if (!fiber) throw new Error('AppContext provider not found');
	const context = fiber.memoizedProps.value;
	let shell = element[Object.keys(element).find((key) => key.startsWith('__reactFiber'))];
	while (shell && !shell.memoizedProps?.value?.selectWorkflowMode) shell = shell.return;
	if (!shell) throw new Error('StudioShellContext provider not found');
	window.__previsShell = shell.memoizedProps.value;
	const before = element.dataset.workflowMode;
	let receipt;
	try { receipt = context.bus.run('view.setMode', { mode: 'motion' }); } catch (error) { receipt = { ok: false, code: error.code, message: error.message, uiMessage: error.uiMessage }; }
	return { before, receipt };
})()`);
await nextFrame();
const modeAfterBus = await evaluate("document.querySelector('.app').dataset.workflowMode");
console.log(`QA_PREVIS bus view.setMode motion ${JSON.stringify({ ...refusal, after: modeAfterBus })}`);
expect("storyboard: view.setMode {mode:motion} is refused with the toast text", refusal.receipt?.ok === false && refusal.receipt.message === "Motion tools are not part of a Storyboard project.", JSON.stringify(refusal));
expect("storyboard: the refused mode leaves the workflow mode unchanged", modeAfterBus === refusal.before, JSON.stringify({ before: refusal.before, after: modeAfterBus }));
await evaluate("window.__previsShell.selectWorkflowMode('motion')");
const toast = await waitFor("[...document.querySelectorAll('.toast')].some((node) => node.textContent.includes('Motion tools are not part of a Storyboard project.'))");
const modeAfterUi = await evaluate("document.querySelector('.app').dataset.workflowMode");
console.log(`QA_PREVIS ui selectWorkflowMode motion ${JSON.stringify({ toast, after: modeAfterUi })}`);
expect("storyboard: selectWorkflowMode('motion') toasts the refusal and keeps the mode", toast && modeAfterUi === refusal.before, JSON.stringify({ toast, modeAfterUi }));
save("task-19-storyboard-refusal", await capture());
writeFileSync(`${outputDir}/task-19-previs.json`, JSON.stringify(previsReport, null, 2));
console.log(`QA_EVIDENCE ${outputDir}/task-19-previs.json`);

// Compare: the studio viewport beside the owner's 2a viewport region.
await viewportSize(1920, 1080);
await waitFor("document.querySelector('.viewport')?.getBoundingClientRect().width > 1500");
const studioViewport = await rectOf(".viewport");
const studioImage = await capture(studioViewport);
const referencePath = new URL("../docs/design/v2-reference.html", import.meta.url);
readFileSync(referencePath);
await send("Page.navigate", { url: referencePath.href });
const referenceReady = await waitFor("[...document.querySelectorAll('div')].some((node) => node.textContent.trim() === 'speed 3')", 30000);
expect("the v2 reference renders its 2a viewport", referenceReady);
let referenceImage = null;
if (referenceReady) {
	const referenceViewport = await evaluate(`(() => {
		const speed = [...document.querySelectorAll('div')].find((node) => node.textContent.trim() === 'speed 3');
		const r = speed.parentElement.getBoundingClientRect();
		return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
	})()`);
	referenceImage = await capture(referenceViewport);
}
await send("Page.navigate", { url: "about:blank" });
const frame = await send("Page.getFrameTree");
await send("Page.setDocumentContent", {
	frameId: frame.frameTree.frame.id,
	html: `<body style="margin:0;background:#070708;color:#9b9ba1;font:12px sans-serif"><div style="display:grid;gap:8px;padding:8px">
		<div>v2 reference (2a viewport)</div><img style="width:1580px" src="data:image/png;base64,${referenceImage ?? ""}">
		<div>studio (#524)</div><img style="width:1580px" src="data:image/png;base64,${studioImage}"></div></body>`,
});
await waitFor("[...document.images].every((image) => image.complete)");
const compareBox = await evaluate("(() => { const r = document.body.firstElementChild.getBoundingClientRect(); return { x: 0, y: 0, width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()");
await viewportSize(compareBox.width, compareBox.height);
save("task-10-compare", await capture({ ...compareBox }));
console.log(`QA_SCREENSHOT ${app1920}`);

ws.close();
if (failures) {
	console.log(`qa-shell-viewport-browser: ${failures} failure(s)`);
	process.exit(1);
}
console.log("qa-shell-viewport-browser: all checks passed");
