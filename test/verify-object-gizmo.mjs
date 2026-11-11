#!/usr/bin/env node
/**
 * Scene objects, end to end in a real browser.
 *
 * Creation and direct manipulation cannot be proved by unit tests: the
 * transform maths lives in scene-objects.js (verify-scene-objects.mjs covers
 * it), but "can you actually grab the arrow" depends on the camera's
 * letterboxed sub-rect, the layer masks and the pointer-capture order — all of
 * which only exist in a running page. This drives Chrome over CDP with real
 * pointer input: add a cube from the catalogue, drag it with the move gizmo,
 * spin it with a rotate ring, select it by clicking it in the shot view, drive
 * the same record from the bird's-eye board, and remove it.
 *
 * Run: `npm run dev:ui` in one shell, then `npm run test:objects`, which
 * launches the headless QA browser against QA_URL (default 127.0.0.1:5180).
 */

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
const pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	// Uncaught script errors only. Network log entries are environmental here:
	// with no ARDY bridge running, its liveness probe answers 502.
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
		return;
	}
	if (!message.id || !pending.has(message.id)) return;
	const { resolve, reject } = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) reject(new Error(JSON.stringify(message.error)));
	else resolve(message.result);
};
const send = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };
const ALT = 1; // CDP modifier bits
// macOS turns Ctrl+left into a secondary click, which is why Unity's snap
// modifier is Cmd there; drive whichever one this platform actually delivers.
const SNAP_MODIFIER = process.platform === "darwin" ? 4 : 2;
const mouse = (type, x, y, { button = "left", modifiers = 0 } = {}) =>
	send("Input.dispatchMouseEvent", {
		type,
		x: Math.round(x),
		y: Math.round(y),
		button,
		clickCount: 1,
		buttons: type === "mouseReleased" ? 0 : BUTTON_MASK[button],
		modifiers,
	});
const drag = async (from, to, options = {}) => {
	const steps = options.steps ?? 14;
	await mouse("mousePressed", from.x, from.y, options);
	for (let i = 1; i <= steps; i++) {
		await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, options);
		await sleep(16);
	}
	await mouse("mouseReleased", to.x, to.y, options);
	await sleep(150);
};
const pressKey = async (key, code) => {
	const params = { key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
	await send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
	await sleep(250);
};
/** pressKey cannot carry modifier bits; undo/redo need Ctrl/Cmd. */
const pressKeyCombo = async (key, code, modifiers) => {
	const params = { key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers };
	await send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
	await sleep(250);
};
/** evaluate that treats a mid-navigation context loss as "not ready", not a crash */
const evaluateSafely = async (expression) => {
	try {
		return await evaluate(expression);
	} catch {
		return undefined;
	}
};
/** poll the page until expression is truthy or the timeout expires; returns whether it succeeded */
const waitFor = async (expression, { timeoutMs = 5000, intervalMs = 100 } = {}) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression)) return true;
		await sleep(intervalMs);
	}
	return false;
};
/** reload the page and wait for the studio to come back up (plan §11.3) */
const reloadPage = async () => {
	await send("Page.reload");
	for (let i = 0; i < 150; i++) {
		await sleep(200);
		if (await evaluateSafely("!!document.querySelector('canvas')")) break;
	}
	// First paint is not the same as a committed tree: the QA hooks and the
	// hierarchy render in the same commit as the canvas, so wait for them
	// before letting the suite click anything.
	for (let i = 0; i < 50 && !(await evaluateSafely("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0")); i++) await sleep(200);
	await sleep(1500);
};
/** the inspector's Transform rows, as { Position: [x,y,z], Rotation: [...], Scale: [...] } */
const transform = () =>
	evaluate(
		"Object.fromEntries([...document.querySelectorAll('.inspector-pane .vec3-row')].filter(r => !r.closest('.subject-box')).map(r => [r.querySelector('.vec3-label').textContent, [...r.querySelectorAll('input')].map(i => parseFloat(i.value))]))",
	);
const click = (selectorExpression) => evaluate(`${selectorExpression}.click()`);
// Recenter on subject lives in the viewport's Perspective list (G8): open the
// list and wait for the command; clicking it closes the list again.
const openRecenter = async () => {
	await click("document.querySelector('[data-testid=\"view-camera-trigger\"]')");
	await waitFor("!!document.querySelector('.viewport-titlebar [aria-label=\"Recenter on subject\"]')");
};
const openCreateMenu = async () => {
	await evaluate(`(() => {
		const row = document.querySelector('.v2-outliner [data-node-id="light"]');
		const box = row.getBoundingClientRect();
		row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(box.left + 28), clientY: Math.round(box.top + 12), button: 2 }));
		return true;
	})()`);
	await waitFor("document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item').length > 0");
};
const addObject = async (label) => {
	await openCreateMenu();
	await click(`[...document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item')].find(b => b.textContent.startsWith(${JSON.stringify(label)}))`);
	await waitFor("window.__gizmoHandles().length > 0");
};
/** real visibility, not presence: the element must exist, paint a non-zero
 * rect, and sit inside the viewport. A hidden card still contributes its text
 * to document.body.textContent — only the rect proves it is on screen. */
const errorLineVisible = () =>
	evaluate(`(() => {
		const el = document.querySelector('.scene-save-error');
		if (!el) return false;
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return false;
		return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
	})()`);

await send("Runtime.enable");

// Scene persistence (plan §8) survives reloads, so a cozyclay.scene.v1 left by
// an earlier section would boot on the next Page.reload. Clear both keys BEFORE
// the first assertion, then reload so every run starts from empty storage
// (pre-mortem §14.1: persistence must never poison the suite mid-run).
// A freshly launched QA browser can still sit on about:blank, where touching
// localStorage throws SecurityError — wait for the app document first.
for (let i = 0; i < 100 && !(await evaluateSafely("location.href.startsWith('http')")); i++) await sleep(200);
await evaluate("localStorage.removeItem('cozyclay.scene.v1'); localStorage.removeItem('cozyclay.scene.v1.quarantine')");
// Pin the UI locale: the QA browser inherits the host machine locale.
await evaluate("localStorage.setItem('cozyclay.locale', 'en')");
await send("Page.reload");
for (let i = 0; i < 100 && !(await evaluateSafely("!!document.querySelector('canvas')")); i++) await sleep(200);
expect("the studio renders a canvas", await evaluate("!!document.querySelector('canvas')"));
// Wait for the committed tree (QA hook + hierarchy) before the fixed settle.
for (let i = 0; i < 50 && !(await evaluateSafely("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0")); i++) await sleep(200);
await sleep(1500);

/* ------------------------------------------------------- creation ---- */

await openCreateMenu();
const catalogue = await evaluate("[...document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item')].map(b => b.textContent)");
expect(
	"the catalogue lists the primitives and no retired set pieces",
	["Cube", "Sphere", "Capsule", "Cylinder", "Cone", "Plane"].every((label) =>
		catalogue.some((entry) => entry.startsWith(label)),
	) && !catalogue.some((entry) => /^(Chair|Car|Plane \(aircraft\))/.test(entry)),
	JSON.stringify(catalogue),
);

await click("[...document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item')].find(b => b.textContent.startsWith('Cube'))");
// the creation commit renders the gizmo and inspector together; poll for it
await waitFor("window.__gizmoHandles().length > 0");
expect("the new object opens in the inspector", Object.keys(await transform()).join() === "Position,Rotation,Scale", JSON.stringify(await transform()));
expect("the new object appears in the hierarchy", await evaluate("[...document.querySelectorAll('.hierarchy-label')].some(n => n.textContent === 'Cube')"));
expect("the new object exists in the 3D scene", await evaluate("window.__gizmoHandles().length > 0"));
// Unity creates primitives axis-aligned. Objects used to be turned to face the
// camera, which left every box skewed against the room and the character (whose
// own rotation starts at 0), so equal rotation values did not mean equal facing.
expect("a new object is created unrotated", JSON.stringify((await transform()).Rotation) === "[0,0,0]", JSON.stringify(await transform()));
/* ---------------------------------------------------- move gizmo ----- */

await sleep(1200); // the shot camera eases after a scene change: grab where the arrow IS
const beforeMove = await transform();
const arrows = await evaluate("window.__gizmoHandles()");
expect("the move gizmo exposes three axis arrows", ["x", "y", "z"].every((axis) => arrows.some((handle) => handle.axis === axis)), JSON.stringify(arrows));
const xArrow = arrows.find((handle) => handle.axis === "x");
expect("the X arrow is grabbable where it is drawn", await evaluate(`window.__gizmoPick(${Math.round(xArrow.x)}, ${Math.round(xArrow.y)}) === 'x'`));
await drag(xArrow, { x: xArrow.x + 140, y: xArrow.y });
const afterMove = await transform();
expect("dragging the X arrow slides the object along X", Math.abs(afterMove.Position[0] - beforeMove.Position[0]) > 0.2, JSON.stringify(afterMove));
expect("an X drag leaves the other axes alone", afterMove.Position[1] === beforeMove.Position[1] && afterMove.Position[2] === beforeMove.Position[2]);

/* --------------------------------------------------- rotate gizmo ---- */

await pressKey("e", "KeyE");
expect("E selects the rotate tool", await evaluate("document.querySelector('[data-tool-key].active')?.dataset.tool === 'rotate'"));
await sleep(1200);
const rings = await evaluate("window.__gizmoHandles()");
expect("rotate mode shows one ring per axis plus the screen ring", ["x", "y", "z", "screen"].every((axis) => rings.some((handle) => handle.axis === axis)), JSON.stringify(rings));
// Rings overlap on screen; grab a spot whose whole neighbourhood picks Y so the
// press cannot land on the X ring instead.
const ringGrab = await evaluate(
	"(() => { const c = window.__gizmoHandles().find(h => h.axis === 'y');" +
		" const solid = (x, y) => [[0,0],[3,0],[-3,0],[0,3],[0,-3]].every(([dx,dy]) => window.__gizmoPick(x+dx, y+dy) === 'y');" +
		" for (let r = 8; r < 260; r += 2) { for (let a = 0; a < 360; a += 15) {" +
		" const x = Math.round(c.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(c.y + r * Math.sin(a * Math.PI / 180));" +
		" if (solid(x, y) && document.elementFromPoint(x, y)?.tagName === 'CANVAS') return { x, y }; } } return null; })()",
);
expect("the Y ring is grabbable on screen", !!ringGrab);
const beforeRotate = await transform();
// Sweep a true arc around the gizmo centre, exactly like the screen-ring
// roll below: a fixed straight chord from a grab spot near the hub can
// subtend less than the 5-degree snap and read back as a no-op.
const hubTurn = await evaluate(
	"(() => { const hs = window.__gizmoHandles(); return { x: hs.reduce((a, h) => a + h.x / hs.length, 0), y: hs.reduce((a, h) => a + h.y / hs.length, 0) }; })()",
);
const turnRadius = Math.hypot(ringGrab.x - hubTurn.x, ringGrab.y - hubTurn.y);
const turnStart = Math.atan2(ringGrab.y - hubTurn.y, ringGrab.x - hubTurn.x);
await mouse("mousePressed", ringGrab.x, ringGrab.y);
for (let i = 1; i <= 18; i++) {
	const a = turnStart + (i / 18) * (Math.PI / 2);
	await mouse("mouseMoved", Math.round(hubTurn.x + turnRadius * Math.cos(a)), Math.round(hubTurn.y + turnRadius * Math.sin(a)));
	await sleep(16);
}
await mouse("mouseReleased", Math.round(hubTurn.x + turnRadius * Math.cos(turnStart + Math.PI / 2)), Math.round(hubTurn.y + turnRadius * Math.sin(turnStart + Math.PI / 2)));
await sleep(150);
const afterRotate = await transform();
expect("dragging the Y ring turns the object", afterRotate.Rotation[1] !== beforeRotate.Rotation[1], JSON.stringify(afterRotate));
expect("a Y ring drag leaves tilt and roll alone", afterRotate.Rotation[0] === beforeRotate.Rotation[0] && afterRotate.Rotation[2] === beforeRotate.Rotation[2]);
expect("snapping on, rotation lands on the 5 degree detents", afterRotate.Rotation[1] % 5 === 0, String(afterRotate.Rotation[1]));
// The outer camera-facing ring rolls about the view axis (Unity §3.3).
const screenGrab = await evaluate(
	"(() => { const c = window.__gizmoHandles().find(h => h.axis === 'screen'); if (!c) return null;" +
		" const solid = (x, y) => [[0,0],[3,0],[-3,0],[0,3],[0,-3]].every(([dx,dy]) => window.__gizmoPick(x+dx, y+dy) === 'screen');" +
		" for (let r = 10; r < 320; r += 2) { for (let a = 0; a < 360; a += 15) {" +
		" const x = Math.round(c.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(c.y + r * Math.sin(a * Math.PI / 180));" +
		" if (solid(x, y)) return { x, y }; } } return null; })()",
);
expect("the screen-space ring is grabbable", !!screenGrab);
if (screenGrab) {
	const beforeRoll = await transform();
	// Roll with a true arc around the gizmo centre: under the free editor
	// camera a straight chord can subtend less than the 5-degree snap and
	// read as a no-op even though the ring works.
	const hubRoll = await evaluate(
		"(() => { const hs = window.__gizmoHandles(); return { x: hs.reduce((a, h) => a + h.x / hs.length, 0), y: hs.reduce((a, h) => a + h.y / hs.length, 0) }; })()",
	);
	const rollRadius = Math.hypot(screenGrab.x - hubRoll.x, screenGrab.y - hubRoll.y);
	const rollStart = Math.atan2(screenGrab.y - hubRoll.y, screenGrab.x - hubRoll.x);
	await mouse("mousePressed", screenGrab.x, screenGrab.y);
	for (let i = 1; i <= 18; i++) {
		const a = rollStart + (i / 18) * (Math.PI / 2);
		await mouse("mouseMoved", Math.round(hubRoll.x + rollRadius * Math.cos(a)), Math.round(hubRoll.y + rollRadius * Math.sin(a)), { buttons: 1 });
		await sleep(16);
	}
	await mouse("mouseReleased", Math.round(hubRoll.x + rollRadius * Math.cos(rollStart + Math.PI / 2)), Math.round(hubRoll.y + rollRadius * Math.sin(rollStart + Math.PI / 2)));
	await sleep(150);
	const afterRoll = await transform();
	expect("the screen ring rolls the object about the view axis", JSON.stringify(afterRoll.Rotation) !== JSON.stringify(beforeRoll.Rotation), `${JSON.stringify(beforeRoll.Rotation)} -> ${JSON.stringify(afterRoll.Rotation)}`);
	expect("the screen ring never moves or scales the object", JSON.stringify(afterRoll.Position) === JSON.stringify(beforeRoll.Position) && JSON.stringify(afterRoll.Scale) === JSON.stringify(beforeRoll.Scale));
}

await pressKey("w", "KeyW");
expect("W returns to the move tool", await evaluate("document.querySelector('[data-tool-key].active')?.dataset.tool === 'move'"));

/* ---------------------------------------------------- scale gizmo ---- */

// The ring tests above leave the cube turned, and a heavily turned local Y
// can point almost AT the camera — there the knob's drag plane degenerates
// and any drag reads back as a no-op. Scale is about the knob, not the
// pose: zero the rotation first.
for (const index of [0, 1, 2]) {
	await evaluate(
		"(() => { const r = [...document.querySelectorAll('.inspector-pane .vec3-row')].filter(r => !r.closest('.subject-box')).find(r => r.querySelector('.vec3-label').textContent === 'Rotation');" +
			` const input = r.querySelectorAll('input')[${index}]; input.focus();` +
			" Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '0');" +
			" input.dispatchEvent(new Event('input', { bubbles: true }));" +
			" input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()",
	);
}
// R below must reach the tool hotkeys, not the still-focused number field
await evaluate("document.activeElement?.blur()");
await sleep(400);

await pressKey("r", "KeyR");
expect("R selects the scale tool", await evaluate("document.querySelector('[data-tool-key].active')?.dataset.tool === 'scale'"));
await sleep(1200);
const knobs = await evaluate("window.__gizmoHandles()");
expect("scale mode exposes three axis knobs", new Set(knobs.map((handle) => handle.axis)).size >= 3, JSON.stringify(knobs));
// An unambiguous grab ON the canvas: the projected knob position can sit
// under the Top-View inset (a press there never reaches the canvas), and
// the fat uniform-scale centre knob can outrank a press near the hub.
const yKnob = await evaluate(
	"(() => { const h = window.__gizmoHandles().find(e => e.axis === 'y'); if (!h) return null;" +
		" const canvas = document.querySelector('canvas');" +
		" const solid = (x, y) => document.elementFromPoint(x, y) === canvas && [[0,0],[3,0],[-3,0],[0,3],[0,-3]].every(([dx,dy]) => window.__gizmoPick(x+dx, y+dy) === 'y');" +
		" for (let r = 0; r < 80; r += 2) { for (let a = 0; a < 360; a += 20) {" +
		" const x = Math.round(h.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(h.y + r * Math.sin(a * Math.PI / 180));" +
		" if (solid(x, y)) return { x, y }; } } return { x: Math.round(h.x), y: Math.round(h.y) }; })()",
);
const beforeScale = await transform();
// Pull the Y knob straight AWAY from the pivot on screen. "Up" is only
// away while the object is unrotated; the rotate section above leaves it
// turned, and an up-drag then crosses the knob's axis at a right angle,
// so the scale delta snaps back to 1.0 and reads as a no-op.
const hubScale = knobs.find((handle) => handle.axis === "centre")
	?? { x: knobs.reduce((a, h) => a + h.x / knobs.length, 0), y: knobs.reduce((a, h) => a + h.y / knobs.length, 0) };
const outLen = Math.hypot(yKnob.x - hubScale.x, yKnob.y - hubScale.y) || 1;
await drag(yKnob, { x: yKnob.x + ((yKnob.x - hubScale.x) / outLen) * 120, y: yKnob.y + ((yKnob.y - hubScale.y) / outLen) * 120 });
const afterScale = await transform();
expect("dragging the Y knob scales height", afterScale.Scale[1] > beforeScale.Scale[1], JSON.stringify(afterScale));
expect("a Y knob drag leaves the other axes alone", afterScale.Scale[0] === beforeScale.Scale[0] && afterScale.Scale[2] === beforeScale.Scale[2]);
expect("scale lands on 5 percent steps", Math.abs(afterScale.Scale[1] * 20 - Math.round(afterScale.Scale[1] * 20)) < 1e-6, String(afterScale.Scale[1]));
await pressKey("w", "KeyW");

// restore the unit scale: the following sections assume a 1 m cube — at 4x
// the gizmo rides so high it projects under the bird's-eye inset pane
await evaluate(
	"(() => { const r = [...document.querySelectorAll('.inspector-pane .vec3-row')].filter(r => !r.closest('.subject-box')).find(r => r.querySelector('.vec3-label').textContent === 'Scale');" +
	" const input = r.querySelectorAll('input')[1]; input.focus();" +
	" Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '1');" +
	" input.dispatchEvent(new Event('input', { bubbles: true }));" +
	" input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()",
);
await waitFor(
	"(() => { const r = [...document.querySelectorAll('.inspector-pane .vec3-row')].filter(r => !r.closest('.subject-box')).find(r => r.querySelector('.vec3-label').textContent === 'Scale'); return parseFloat(r.querySelectorAll('input')[1].value) === 1; })()",
);

/* ------------------------------------------------------ selection ---- */

// Click a pixel that is unambiguously the object body: the gizmo sits on the
// pivot, so averaging handle positions lands between the handles, not on the
// mesh. Scan out from the gizmo centre for a spot the object owns.
globalThis.objectCentre = await evaluate(
	"(() => { const g = window.__gizmoHandles(); const c = g.reduce((a, h) => ({ x: a.x + h.x / g.length, y: a.y + h.y / g.length }), { x: 0, y: 0 });" +
	" for (let r = 4; r < 400; r += 4) { for (let a = 0; a < 360; a += 20) {" +
	" const x = Math.round(c.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(c.y + r * Math.sin(a * Math.PI / 180));" +
	" if (window.__objectPick(x, y) && !window.__gizmoPick(x, y) && document.elementFromPoint(x, y)?.tagName === \"CANVAS\") return { x, y }; } } return { x: Math.round(c.x), y: Math.round(c.y) }; })()",
);
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => (b.getAttribute('aria-label') || b.textContent).includes('SCENE 01'))");
// the deselection commit unmounts the gizmo; poll for it
await waitFor("window.__gizmoHandles().length === 0");
expect("selecting something else drops the gizmo", await evaluate("window.__gizmoHandles().length === 0"));
await mouse("mousePressed", objectCentre.x, objectCentre.y);
await mouse("mouseReleased", objectCentre.x, objectCentre.y);
// re-selecting remounts the gizmo; poll for the commit
await waitFor("window.__gizmoHandles().length > 0");
expect("clicking the object in the shot view selects it", await evaluate("window.__gizmoHandles().length > 0"));

/* ------------------------------ selection vs the camera (Unity) ------ */

// The reported fight: a press on an object both selected it AND slid it, and a
// press on empty space flew the camera, so aiming at something moved the set.
// Unity's split is what is asserted here — left is content, right/middle/Alt is
// the camera. (docs/unity-reference.md §1, §6, §9.6)
const gizmoPose = () => evaluate("JSON.stringify(window.__gizmoHandles().map(h => [Math.round(h.x), Math.round(h.y)]))");
const beforeBody = await transform();
// somewhere on the body that is NOT under a gizmo handle
const bodyGrab = await evaluate(
	"(() => { const g = window.__gizmoHandles(); const c = g.reduce((a, h) => ({ x: a.x + h.x / g.length, y: a.y + h.y / g.length }), { x: 0, y: 0 });" +
		" for (let r = 12; r < 400; r += 4) { for (let a = 0; a < 360; a += 15) {" +
		" const x = Math.round(c.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(c.y + r * Math.sin(a * Math.PI / 180));" +
		" if (!window.__gizmoPick(x, y) && window.__objectPick(x, y) && document.elementFromPoint(x, y)?.tagName === \"CANVAS\") return { x, y }; } } return null; })()",
);
expect("the object body is pickable away from the handles", !!bodyGrab);
const poseBeforeBodyDrag = await gizmoPose();
await drag(bodyGrab, { x: bodyGrab.x + 110, y: bodyGrab.y + 40 });
expect("dragging the object body does NOT transform it", JSON.stringify(await transform()) === JSON.stringify(beforeBody), JSON.stringify(await transform()));
expect("dragging the object body does NOT fly the camera", (await gizmoPose()) === poseBeforeBodyDrag);

// Empty space: a left press clears the selection instead of flying.
// The fly/pan/orbit section leaves the camera wherever the gestures took it —
// possibly right on top of the cube, where every pixel picks the body. Reset
// to the shot preset first so empty floor is actually on screen.
await openRecenter();
await evaluate("document.querySelector('.viewport-titlebar [aria-label=\"Recenter on subject\"]')?.click()");
await sleep(600);
// empty floor near the canvas lower-left, clear of the overlay toolbar and the subject
const emptySpot = await evaluate(
	"(() => { const r = document.querySelector('canvas').getBoundingClientRect();" +
	" for (let yy = 0.85; yy > 0.1; yy -= 0.06) { for (let xx = 0.06; xx < 0.95; xx += 0.05) {" +
	" const x = Math.round(r.left + r.width * xx); const y = Math.round(r.top + r.height * yy);" +
	" if (!window.__objectPick(x, y) && !window.__gizmoPick(x, y) && document.elementFromPoint(x, y)?.tagName === 'CANVAS') return { x, y }; } } return null; })()",
);
if (!emptySpot) {
globalThis.why = await evaluate(
		"(() => { const r = document.querySelector('canvas').getBoundingClientRect(); const out = [];" +
		" for (const [xx, yy] of [[0.1, 0.8], [0.3, 0.7], [0.5, 0.5], [0.8, 0.3], [0.2, 0.4]]) {" +
		" const x = Math.round(r.left + r.width * xx); const y = Math.round(r.top + r.height * yy);" +
		" out.push([x, y, window.__objectPick(x, y), window.__pickObjectDebug, window.__gizmoPick(x, y), document.elementFromPoint(x, y)?.tagName + '.' + (document.elementFromPoint(x, y)?.className ?? '')]); } return out; })()",
	);
	throw new Error("no empty canvas pixel found for the clear-selection drag: " + JSON.stringify(why));
}
await drag(emptySpot, { x: emptySpot.x + 140, y: emptySpot.y - 60 });
expect("a left drag on empty space clears the selection and leaves the camera", await evaluate("window.__gizmoHandles().length === 0"));

// Camera drags need a point safely inside the canvas: the studio layout
// puts panels around the stage, so a hardcoded corner is not stable geometry.
globalThis.canvasPoint = await evaluate("(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: Math.round(r.left + r.width * 0.35), y: Math.round(r.top + r.height * 0.45) }; })()");
// Right-drag is the camera.
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'))");
// selecting the object remounts the gizmo; poll for the commit
await waitFor("window.__gizmoHandles().length > 0");
expect("the object is selectable again from the hierarchy", await evaluate("window.__gizmoHandles().length > 0"));
const beforeFly = await transform();
const restPose = await gizmoPose();
await drag(canvasPoint, { x: canvasPoint.x + 120, y: canvasPoint.y + 40 }, { button: "right" });
expect("right-drag flies the camera", (await gizmoPose()) !== restPose, `${restPose} -> ${await gizmoPose()}`);
expect("flying the camera does not move the object", JSON.stringify(await transform()) === JSON.stringify(beforeFly));

// Middle-drag pans, Alt+left orbits — both move the view, neither the object.
const beforePan = await gizmoPose();
await drag(canvasPoint, { x: canvasPoint.x + 60, y: canvasPoint.y + 30 }, { button: "middle" });
expect("middle-drag pans the camera", (await gizmoPose()) !== beforePan);
const beforeOrbit = await gizmoPose();
await drag(canvasPoint, { x: canvasPoint.x + 80, y: canvasPoint.y }, { modifiers: ALT });
expect("Alt+left orbits the camera", (await gizmoPose()) !== beforeOrbit);
expect("navigation never edits the object", JSON.stringify(await transform()) === JSON.stringify(beforeFly), JSON.stringify(await transform()));

/* ------------------------------------------------- plane handle ------ */

// The camera section leaves the pose wherever fly/pan/orbit took it; at a
// grazing angle to the floor the XZ plane turns pixels into metres of travel
// and the object leaves the frame. Reset to the shot preset first.
await openRecenter();
await evaluate("document.querySelector('.viewport-titlebar [aria-label=\"Recenter on subject\"]')?.click()");
await sleep(600);

await pressKey("w", "KeyW");
await sleep(900);
const planeGrab = await evaluate(
	"(() => { const g = window.__gizmoHandles(); const c = g.reduce((a, h) => ({ x: a.x + h.x / g.length, y: a.y + h.y / g.length }), { x: 0, y: 0 });" +
		" for (let r = 6; r < 90; r += 2) { for (let a = 0; a < 360; a += 10) {" +
		" const x = Math.round(c.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(c.y + r * Math.sin(a * Math.PI / 180));" +
		" if (window.__gizmoPick(x, y) === 'plane:xz') return { x, y }; } } return null; })()",
);
expect("the move gizmo offers plane handles", !!planeGrab);
if (planeGrab) {
	const beforePlane = await transform();
	await drag(planeGrab, { x: planeGrab.x + 60, y: planeGrab.y + 30 });
	const afterPlane = await transform();
	expect(
		"the XZ plane handle slides the object on the floor",
		afterPlane.Position[0] !== beforePlane.Position[0] && afterPlane.Position[2] !== beforePlane.Position[2],
		`${JSON.stringify(beforePlane)} -> ${JSON.stringify(afterPlane)}`,
	);
	expect("the XZ plane handle never changes height", afterPlane.Position[1] === beforePlane.Position[1]);
}

/* ------------------------------------------------ snapping polarity -- */

// Snap is on by default, so Ctrl/Cmd gives the free drag.
const beforeFree = await transform();
// The axis proxies are fat and overlap near the pivot, so grab a point whose
// neighbourhood unambiguously picks X — the same trick the ring search uses.
const freeArrow = await evaluate(
	"(() => { const h = window.__gizmoHandles().find(e => e.axis === 'x'); if (!h) return null;" +
		" const solid = (x, y) => [[0,0],[2,0],[-2,0],[0,2],[0,-2]].every(([dx,dy]) => window.__gizmoPick(x+dx, y+dy) === 'x');" +
		" for (let r = 0; r < 60; r += 2) { for (const s of [1, -1]) { const x = Math.round(h.x + r * s); const y = Math.round(h.y);" +
		" if (solid(x, y)) return { x, y }; } } return null; })()",
);
expect("the X arrow has an unambiguous grab point", !!freeArrow);
await drag(freeArrow, { x: freeArrow.x + 37, y: freeArrow.y }, { modifiers: SNAP_MODIFIER });
const afterFree = await transform();
expect("the snap modifier during a drag escapes the grid", afterFree.Position[0] !== beforeFree.Position[0], `${JSON.stringify(beforeFree)} -> ${JSON.stringify(afterFree)}`);
expect(
	"the modified drag lands off the 5 cm detents",
	Math.abs(afterFree.Position[0] * 20 - Math.round(afterFree.Position[0] * 20)) > 1e-9,
	String(afterFree.Position[0]),
);

/* ----------------------------------------------------- plan parity --- */

// The Top-View is always the inset now (the double-click big-pane swap is
// gone; double-click folds the inset instead), so the puck is dragged in
// the inset itself: PLAN_EXTENT (12.4 m) maps to half its shorter side.
const beforePlan = await transform();
const planGrab = await evaluate(
	`(() => { const b = document.querySelector('.vp-inset').getBoundingClientRect(); const scale = Math.min(b.width, b.height) / 2 / 12.4;
		return { x: Math.round(b.left + b.width / 2 + ${beforePlan.Position[0]} * scale), y: Math.round(b.top + b.height / 2 + ${beforePlan.Position[2]} * scale) }; })()`,
);
await drag(planGrab, { x: planGrab.x, y: planGrab.y + 40 });
const afterPlan = await transform();
expect("the bird's-eye board drives the same object record", afterPlan.Position[2] !== beforePlan.Position[2], JSON.stringify(afterPlan));

/* ------------------------------------------- creation is world-aligned - */

// A fresh object stays axis-aligned even when the view is somewhere else
// entirely — creation must not inherit the camera's yaw.
await drag({ x: 300, y: 300 }, { x: 460, y: 320 }, { button: "right" });
await addObject("Capsule");
expect("an object created from a swung camera is still unrotated", JSON.stringify((await transform()).Rotation) === "[0,0,0]", JSON.stringify(await transform()));
await click("document.querySelector('.inspector-actions-trigger')");
await waitFor("document.querySelectorAll('.inspector-actions-menu button').length > 0");
await click("[...document.querySelectorAll('.inspector-actions-menu button')].find(b => b.textContent.startsWith('Delete'))");
await sleep(300);
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'))");
await sleep(300);

/* --------------------------------------------- hierarchy actions ----- */

const cubeRow = await evaluate(
	"(() => { const row = [...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'));" +
		" if (!row) return null; const r = row.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()",
);
expect("the hierarchy lists the object row", !!cubeRow);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cubeRow.x, y: cubeRow.y, button: "right", buttons: 2, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cubeRow.x, y: cubeRow.y, button: "right", buttons: 0, clickCount: 1 });
// the context menu mounts after the right-click; poll for its items
await waitFor("document.querySelectorAll('.hierarchy-context-menu button, .context-menu button, [role=menu] button').length > 0");
const menuItems = await evaluate("[...document.querySelectorAll('.hierarchy-context-menu button, .context-menu button, [role=menu] button')].map(b => b.textContent.trim())");
expect("right-clicking a row offers Rename / Duplicate / Delete / Frame", ["Rename", "Duplicate", "Delete", "Frame"].every((label) => menuItems.some((item) => item.startsWith(label))), JSON.stringify(menuItems));
await pressKey("Escape", "Escape");

/* -------------------------------------------------------- removal ---- */

await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'))");
await sleep(250);
await click("document.querySelector('.inspector-actions-trigger')");
await waitFor("document.querySelectorAll('.inspector-actions-menu button').length > 0");
await click("[...document.querySelectorAll('.inspector-actions-menu button')].find(b => b.textContent.startsWith('Delete'))");
// the removal commit drops the row; poll for it
await waitFor("![...document.querySelectorAll('.hierarchy-label')].some(n => n.textContent === 'Cube')");
expect("removing the object clears it from the hierarchy", await evaluate("![...document.querySelectorAll('.hierarchy-label')].some(n => n.textContent === 'Cube')"));
expect("the removed object leaves no gizmo behind", await evaluate("window.__gizmoHandles().length === 0"));
/* ------------------------------------------------ persistence ---- */

// Plan §11.3: every case reloads, and most end by clearing the keys so a later
// section can never boot from a leftover scene. The normalization chain (cases
// 7-9) deliberately skips the clear between its reloads — the second reload IS
// the point — and clears only at the very end.

const sceneKey = "cozyclay.scene.v1";
const quarantineKey = "cozyclay.scene.v1.quarantine";
const clearSceneKeys = () => evaluate(`localStorage.removeItem('${sceneKey}'); localStorage.removeItem('${quarantineKey}')`);
const setSceneKey = (value) => evaluate(`localStorage.setItem('${sceneKey}', ${JSON.stringify(value)})`);
const readSceneKey = () => evaluate(`localStorage.getItem('${sceneKey}')`);
/** The Props node starts collapsed, so restored objects are invisible until
 * it is expanded. Selecting the row does NOT expand it (a root node has no
 * ancestors to auto-expand), so drive the toggle button directly. */
const expandProps = async () => {
	const label = await evaluate(
		"(() => { const t = [...document.querySelectorAll('.hierarchy-toggle')].find(b => (b.getAttribute('aria-label') || '').endsWith(' Props')); return t ? t.getAttribute('aria-label') : null; })()",
	);
	if (label === "Expand Props") {
		await click("[...document.querySelectorAll('.hierarchy-toggle')].find(b => b.getAttribute('aria-label') === 'Expand Props')");
		// the expand commit flips the toggle's aria-label to "Collapse Props"
		await waitFor("[...document.querySelectorAll('.hierarchy-toggle')].some(b => b.getAttribute('aria-label') === 'Collapse Props')");
	}
};

// case 1: a saved scene survives a reload (the debounced save has fired)
await clearSceneKeys();
await reloadPage();
await addObject("Capsule");
await sleep(700); // past the 400 ms debounce
await reloadPage();
await expandProps();
expect(
	"the scene survives a reload",
	await evaluate("[...document.querySelectorAll('.hierarchy-label')].some(n => n.textContent.startsWith('Capsule'))"),
);

// case 2: the reloaded record is a real object, not a label
await expandProps();
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Capsule'))");
// the gizmo must be mounted AND its screen positions settled (one render
// frame) before the drag below grabs the X arrow by coordinate
await waitFor("(() => { const h = window.__gizmoHandles().find(e => e.axis === 'x'); return !!h && window.__gizmoPick(Math.round(h.x), Math.round(h.y)) === 'x'; })()");
expect("a reloaded object is still selectable", await evaluate("window.__gizmoHandles().length > 0"));
const beforeReloadDrag = await transform();
const reloadArrows = await evaluate("window.__gizmoHandles()");
const reloadXArrow = reloadArrows.find((handle) => handle.axis === "x");
await drag(reloadXArrow, { x: reloadXArrow.x + 120, y: reloadXArrow.y });
const afterReloadDrag = await transform();
expect(
	"a reloaded object is still draggable",
	afterReloadDrag.Position[0] !== beforeReloadDrag.Position[0],
	JSON.stringify(afterReloadDrag),
);

// case 3: pagehide flushes INSIDE the debounce window. This is the live-store
// regression detector (plan §8.4): a flush that captured sceneObjects in a
// []-deps closure would write startup state instead of this edit.
const beforeHide = await transform();
const hideArrows = await evaluate("window.__gizmoHandles()");
const hideXArrow = hideArrows.find((handle) => handle.axis === "x");
await drag(hideXArrow, { x: hideXArrow.x + 60, y: hideXArrow.y });
const edited = await transform(); // what the flush MUST persist
await evaluate("window.dispatchEvent(new Event('pagehide'))");
await reloadPage(); // inside the 400 ms window
await expandProps();
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Capsule'))");
// the selection commit mounts the gizmo; poll for it
await waitFor("window.__gizmoHandles().length > 0");
const afterHideReload = await transform();
expect(
	"an edit is flushed on pagehide without waiting for the debounce",
	JSON.stringify(afterHideReload.Position) === JSON.stringify(edited.Position),
	`${JSON.stringify(edited)} -> ${JSON.stringify(afterHideReload)}`,
);
await clearSceneKeys();

// case 4: a corrupt payload starts clean and quarantines the old data
await setSceneKey("{oops");
await reloadPage();
expect("a corrupt payload starts clean", await evaluate("!!document.querySelector('canvas')"));
expect("a corrupt payload causes no page errors", pageErrors.length === 0, pageErrors.join(" | "));
expect(
	"the corrupt payload is quarantined",
	(await evaluate(`localStorage.getItem('${quarantineKey}')`)) === "{oops",
	await evaluate(`localStorage.getItem('${quarantineKey}')`),
);
await clearSceneKeys();

// case 5: a future-version payload is never overwritten — not by the mount
// flush, not by the debounce after an edit, not by the pagehide flush.
await setSceneKey('{"version":99,"objects":[]}');
await reloadPage();
await addObject("Cube");
await sleep(700); // past the debounce: the blocked flush must NOT write
await evaluate("window.dispatchEvent(new Event('pagehide'))");
expect(
	"a future payload is never overwritten",
	(await readSceneKey()) === '{"version":99,"objects":[]}',
	await readSceneKey(),
);
await clearSceneKeys();

// case 6: a failing setItem is visible and the session keeps working
await reloadPage();
await addObject("Cube");
await sleep(600); // let the pre-stub write land, then break storage
await evaluate(`
	window.__realSetItem = Storage.prototype.setItem;
	Storage.prototype.setItem = function (k, v) {
		if (k === 'cozyclay.scene.v1') { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
		return window.__realSetItem.call(this, k, v);
	};
`);
const beforeFail = await transform();
const failArrows = await evaluate("window.__gizmoHandles()");
const failXArrow = failArrows.find((handle) => handle.axis === "x");
await drag(failXArrow, { x: failXArrow.x + 120, y: failXArrow.y });
await sleep(700); // past the debounce: the flush throws and must surface
expect("a failing setItem surfaces a visible error", await errorLineVisible());
expect(
	"the error line stays visible while an object is selected",
	(await evaluate("window.__gizmoHandles().length > 0")) && (await errorLineVisible()),
);
expect("a failing setItem is caught, not uncaught", pageErrors.length === 0, pageErrors.join(" | "));
const afterFailDrag = await transform();
expect(
	"the session still works after a failed save",
	afterFailDrag.Position[0] !== beforeFail.Position[0],
	JSON.stringify(afterFailDrag),
);
await pressKeyCombo("z", "KeyZ", 2); // Ctrl+Z
expect(
	"undo still works after a failed save",
	JSON.stringify((await transform()).Position) === JSON.stringify(beforeFail.Position),
	JSON.stringify(await transform()),
);
await evaluate("Storage.prototype.setItem = window.__realSetItem");
const restoreArrows = await evaluate("window.__gizmoHandles()");
const restoreXArrow = restoreArrows.find((handle) => handle.axis === "x");
await drag(restoreXArrow, { x: restoreXArrow.x + 120, y: restoreXArrow.y });
await sleep(700);
expect(
	"a successful write clears the error line",
	await evaluate("!document.querySelector('.scene-save-error')"),
);
expect(
	"a successful write persists the scene",
	await evaluate(
		`(() => { const p = JSON.parse(localStorage.getItem('${sceneKey}')); return Array.isArray(p?.objects) && p.objects.length === 1 && p.objects[0].renderer === 'cube'; })()`,
	),
);
await clearSceneKeys();

// case 7: a stale but valid payload is normalized at startup. One repairable
// legacy record (single scale), one unknown renderer, one duplicate id.
await setSceneKey(
	JSON.stringify({
		version: 1,
		objects: [
			{ id: "cube", name: "Cube", renderer: "cube", x: 1.25, y: 0, z: -0.4, rot: 0, rotX: 0, rotZ: 0, scale: 2, color: "#c2c6c8" },
			{ id: "ghost", name: "Ghost", renderer: "ghost", x: 0, y: 0, z: 0 },
			{ id: "cube", name: "Cube 2", renderer: "cube", x: 2, y: 0, z: 0 },
		],
	}),
);
await send("Page.reload");
for (let i = 0; i < 150; i++) {
	await sleep(200);
	if (await evaluateSafely("!!document.querySelector('canvas')")) break;
}
// The startup toast auto-dismisses after 2.2 s — probe it while it is alive.
await sleep(400);
expect(
	"a stale but valid payload reports dropped records",
	await evaluate("document.body.textContent.includes('saved object(s) could not be restored')"),
);
await sleep(1200); // let the rest of the boot settle
expect("a stale but valid payload renders", await evaluate("!!document.querySelector('canvas')"));
expect("a stale but valid payload causes no page errors", pageErrors.length === 0, pageErrors.join(" | "));
await expandProps();
const staleLabels = await evaluate("[...document.querySelectorAll('.hierarchy-label')].map(n => n.textContent)");
expect(
	"a stale but valid payload restores only the normalized record",
	staleLabels.filter((label) => label.startsWith("Cube")).length === 1 && !staleLabels.some((label) => label.startsWith("Ghost")),
	JSON.stringify(staleLabels),
);
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'))");
// the selection commit mounts the gizmo; poll for it
await waitFor("window.__gizmoHandles().length > 0");
const staleScale = (await transform()).Scale;
expect(
	"the normalized record fans a legacy scale into all three axes",
	JSON.stringify(staleScale) === "[2,2,2]",
	JSON.stringify(staleScale),
);

// case 8: the normalized payload is what gets written back (plan §11.3)
await sleep(700); // past the mount debounce of case 7's session
const written = await evaluate(
	`(() => { const p = JSON.parse(localStorage.getItem('${sceneKey}')); const o = p?.objects?.[0]; return { version: p?.version, count: p?.objects?.length, hasScale: o && 'scale' in o, scales: o && [o.scaleX, o.scaleY, o.scaleZ] }; })()`,
);
expect(
	"the normalized payload is what gets written back",
	written.version === 1 && written.count === 1 && !written.hasScale && JSON.stringify(written.scales) === "[2,2,2]",
	JSON.stringify(written),
);

// case 9: WITHOUT clearing anything, the normalized payload reloads cleanly a
// second time — the check the Critic required. A load is not an undoable change.
await reloadPage();
await expandProps();
expect("the normalized payload reloads cleanly a second time", await evaluate("!!document.querySelector('canvas')"));
expect("the second reload causes no page errors", pageErrors.length === 0, pageErrors.join(" | "));
const secondLabels = await evaluate("[...document.querySelectorAll('.hierarchy-label')].map(n => n.textContent)");
expect(
	"the second reload restores exactly one object",
	secondLabels.filter((label) => label.startsWith("Cube")).length === 1,
	JSON.stringify(secondLabels),
);
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'))");
// the selection commit mounts the gizmo; poll for it
await waitFor("window.__gizmoHandles().length > 0");
const secondScale = (await transform()).Scale;
expect("the second reload keeps the normalized scale", JSON.stringify(secondScale) === "[2,2,2]", JSON.stringify(secondScale));
const historyAfterLoad = await evaluate("window.__sceneHistory()");
expect(
	"a load is not an undoable change",
	historyAfterLoad.past === 0 && historyAfterLoad.settled === true,
	JSON.stringify(historyAfterLoad),
);
// Isolation: only now reset the store for anything that follows. The app
// itself persists the whole stage under SCENES_STORAGE_KEY — clearing just
// the legacy pair leaves every object the cases above created to reload
// into the drop-to-surface section. Sweep all cozyclay keys but the editor
// preferences: the locale, and the project session — without it the studio
// reopens on the first-run project chooser, whose dialog sits over the
// viewport and takes every canvas press the lifecycle section dispatches.
await evaluate("Object.keys(localStorage).filter(k => k.startsWith('cozyclay.') && k !== 'cozyclay.locale' && k !== 'cozyclay.project-session.v1').forEach(k => localStorage.removeItem(k))");
await reloadPage();

/* -------------------------------------------------- drop-to-surface ---- */

// Plan §11.3: End drops the selection straight down onto the highest support
// top whose footprint it overlaps, or the floor. Two objects created from the
// same camera position land on the same x/z, so the capsule's 0.7 m footprint
// sits fully inside the cube's 1 m one, and the cube's top is y = 1.
await addObject("Cube");
await addObject("Capsule");

// Raise the capsule clear of the cube (2.5 > 1) by typing into the Position Y
// field; blur commits the draft as one atomic entry.
const posRow = "(() => { const r = [...document.querySelectorAll('.inspector-pane .vec3-row')].filter(r => !r.closest('.subject-box')).find(r => r.querySelector('.vec3-label').textContent === 'Position'); return r; })()";
const pastBeforeY = await evaluate("window.__sceneHistory().past");
// Drive the draft the way the field models it (focus -> input -> blur):
// CDP's Input.insertText needs the browser window itself to be focused,
// which the headless QA browser is not, so the text never lands there.
await evaluate(
	`(() => { const r = ${posRow}; const input = r.querySelectorAll('input')[1]; input.focus();` +
		" Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '2.5');" +
		" input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); })()",
);
await waitFor(`window.__sceneHistory().past === ${pastBeforeY + 1}`);
expect("typing a Y value raises the object above the support", (await transform()).Position[1] === 2.5, JSON.stringify(await transform()));

const xzBefore = await evaluate(`(() => { const r = ${posRow}; return [r.querySelectorAll('input')[0].value, r.querySelectorAll('input')[2].value]; })()`);
const pastBeforeDrop = await evaluate("window.__sceneHistory().past");

await pressKey("End", "End");
await waitFor(`(() => { const r = ${posRow}; return parseFloat(r.querySelectorAll('input')[1].value) === 1; })()`);
expect("End rests the object exactly on the support's top", (await transform()).Position[1] === 1, JSON.stringify(await transform()));
const xzAfterDrop = await evaluate(`(() => { const r = ${posRow}; return [r.querySelectorAll('input')[0].value, r.querySelectorAll('input')[2].value]; })()`);
expect("a drop leaves snapped X and Z byte-for-byte unchanged", JSON.stringify(xzAfterDrop) === JSON.stringify(xzBefore), `${JSON.stringify(xzBefore)} -> ${JSON.stringify(xzAfterDrop)}`);
expect("a drop is exactly one history entry", await evaluate("window.__sceneHistory().past") === pastBeforeDrop + 1);

// A second End is a no-op: the base already rests on the support's top, so the
// pure patch is null and nothing enters history. The "Nothing to drop" toast
// is the signal that the keypress was processed at all.
const afterDrop = await transform();
await pressKey("End", "End");
await waitFor("document.body.textContent.includes('Nothing to drop')");
expect("a second End changes nothing", JSON.stringify(await transform()) === JSON.stringify(afterDrop), JSON.stringify(await transform()));
expect("a second End adds no history entry", await evaluate("window.__sceneHistory().past") === pastBeforeDrop + 1, JSON.stringify(await evaluate("window.__sceneHistory()")));
expect("the store is settled between drops", await evaluate("window.__sceneHistory().settled === true"));

// One Ctrl+Z undoes the drop as a single entry: the height returns to 2.5.
await pressKeyCombo("z", "KeyZ", 2); // Ctrl+Z
await waitFor(`(() => { const r = ${posRow}; return parseFloat(r.querySelectorAll('input')[1].value) === 2.5; })()`);
expect("undo after a drop restores the previous height", (await transform()).Position[1] === 2.5, JSON.stringify(await transform()));

/* ------------------------------------------- lifecycle adversaries ---- */

// Plan §6.3/§11.3: pointerup, pointercancel, window blur and unmount all
// COMMIT a live drag as exactly one history entry — work the user watched
// happen is real; Escape is the ONLY rollback; a mid-drag undo, atomic
// action or selection change settles the open drag FIRST so the applied
// travel commits alone and cannot fold into an unrelated entry, and the
// producer is torn down rather than left live; PlanBoard selects before it
// begins, and camera grips never open a scene transaction. State entering
// this section: Cube + Capsule exist, the Capsule is selected in the shot view
// with the move tool active. Delete runs last: it removes the Capsule.

/** Press on a gizmo handle and apply `ticks` real move ticks, leaving the
 * pointer down so the caller can interrupt the stream mid-drag. Returns
 * where the pointer ended up. */
// The Top-View inset overlays the shot view's right side (its pane spans
// x >= ~890 here), and the inset host claims presses that land on it. The X
// arrow drifts ~150 px per 160 px drag, so the cases alternate direction to
// keep every press in the clear band; grabX additionally rejects any grab
// point whose elementFromPoint is not the canvas, so a drift into the inset
// fails the case loudly instead of silently missing the arrow.
const dragHeld = async (handle, { ticks = 5, dx = 160, dy = 0 } = {}) => {
	await mouse("mousePressed", handle.x, handle.y);
	await sleep(60);
	for (let i = 1; i <= ticks; i++) {
		await mouse("mouseMoved", handle.x + (dx * i) / ticks, handle.y + (dy * i) / ticks);
		await sleep(24);
	}
	return { x: handle.x + dx, y: handle.y + dy };
};

/** Poll until the X arrow renders and is pickable, then return an
 * unambiguous grab point on it (the snapping section's neighbourhood
 * search, so a press cannot land on the overlapping Y proxy). */
const grabX = async () => {
	await waitFor("(() => { const h = window.__gizmoHandles().find(e => e.axis === 'x'); return !!h && h.x > 0 && h.x < innerWidth && h.y > 0 && h.y < innerHeight && document.elementFromPoint(Math.round(h.x), Math.round(h.y)) === document.querySelector('canvas') && window.__gizmoPick(Math.round(h.x), Math.round(h.y)) === 'x'; })()");
	// A full spiral, not just a horizontal walk: the arrow tip can project
	// under overlays that span the pane's whole width (the bottom window
	// tab bar), where every same-row candidate is equally covered.
	return evaluate(
		"(() => { const h = window.__gizmoHandles().find(e => e.axis === 'x'); if (!h) return null;" +
			" const canvas = document.querySelector('canvas');" +
			" const solid = (x, y) => document.elementFromPoint(x, y) === canvas && [[0,0],[2,0],[-2,0],[0,2],[0,-2]].every(([dx,dy]) => window.__gizmoPick(x+dx, y+dy) === 'x');" +
			" for (let r = 0; r < 70; r += 2) { for (let a = 0; a < 360; a += 20) {" +
			" const x = Math.round(h.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(h.y + r * Math.sin(a * Math.PI / 180));" +
			" if (solid(x, y)) return { x, y }; } } return { x: Math.round(h.x), y: Math.round(h.y) }; })()",
	);
};

/** the Position row's i-th input (0=X, 1=Y, 2=Z) — pollable after commits */
const positionInput = (index) => `(() => { const r = [...document.querySelectorAll('.inspector-pane .vec3-row')].filter(r => !r.closest('.subject-box')).find(r => r.querySelector('.vec3-label').textContent === 'Position'); return r ? parseFloat(r.querySelectorAll('input')[${index}].value) : NaN; })()`;

/** the Camera card's "camera to subject" readout, which live-tracks the
 * shot camera — the only DOM handle on the camera's position */
const cameraDistance = () => evaluate("document.querySelector('span[title=\"camera to subject\"]')?.textContent ?? ''");

// The drop section left the Capsule at Y = 2.5 — above the default camera's
// frame, where its gizmo renders off-screen and a press cannot reach the
// arrow. Rest it back on the Cube top (End) so the lifecycle cases below
// actually grab a live handle. One atomic entry; the cases read `past`
// fresh, so the extra entry is invisible to them.
await pressKey("End", "End");
await waitFor(`${positionInput(1)} === 1`);
// the camera-puck flight above leaves the pose wherever the plan drag took
// it; the Capsule's gizmo can project under the bird's-eye inset pane, where a
// real press never reaches the canvas. Reset to the shot preset, then park
// the inset in the stage's lower-left so it cannot occlude the handle.
await openRecenter();
await evaluate("document.querySelector('.viewport-titlebar [aria-label=\"Recenter on subject\"]')?.click()");
await sleep(600);
globalThis.insetTag = await evaluate("(() => { const t = document.querySelector('.vp-inset-tag'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
if (insetTag) {
globalThis.stageBox = await evaluate("(() => { const r = document.querySelector('.stage').getBoundingClientRect(); return { x: Math.round(r.left + 130), y: Math.round(r.bottom - 130) }; })()");
	await drag(insetTag, stageBox);
	await sleep(300);
}
expect("the lifecycle section starts with the Capsule back on the Cube", (await transform()).Position[1] === 1, JSON.stringify(await transform()));

// pointercancel mid-drag COMMITS: pointer loss is not intent to discard.
const pastBeforeCancel = await evaluate("window.__sceneHistory().past");
const cancelBefore = await transform();
const cancelEnd = await dragHeld(await grabX(), { dx: 160 });
const cancelTravelled = await transform();
expect(
	"the pointercancel case applies real travel before the cancel",
	Math.abs(cancelTravelled.Position[0] - cancelBefore.Position[0]) > 0.1,
	`${JSON.stringify(cancelBefore)} -> ${JSON.stringify(cancelTravelled)}`,
);
await evaluate("window.dispatchEvent(new PointerEvent('pointercancel'))");
await waitFor(`window.__sceneHistory().past === ${pastBeforeCancel + 1}`);
expect(
	"pointercancel mid-drag commits exactly one entry",
	await evaluate("window.__sceneHistory().past") === pastBeforeCancel + 1,
	JSON.stringify(await evaluate("window.__sceneHistory()")),
);
expect(
	"a pointercancel keeps the travelled transform",
	JSON.stringify((await transform()).Position) === JSON.stringify(cancelTravelled.Position),
	JSON.stringify(await transform()),
);
expect("the store is settled after a pointercancel", await evaluate("window.__sceneHistory().settled === true"));
await mouse("mouseReleased", cancelEnd.x, cancelEnd.y);

// window blur mid-drag COMMITS: losing focus is not an abort gesture.
const pastBeforeBlur = await evaluate("window.__sceneHistory().past");
const blurBefore = await transform();
const blurEnd = await dragHeld(await grabX(), { dx: -160 });
const blurTravelled = await transform();
expect(
	"the blur case applies real travel before the blur",
	Math.abs(blurTravelled.Position[0] - blurBefore.Position[0]) > 0.1,
	`${JSON.stringify(blurBefore)} -> ${JSON.stringify(blurTravelled)}`,
);
await evaluate("window.dispatchEvent(new Event('blur'))");
await waitFor(`window.__sceneHistory().past === ${pastBeforeBlur + 1}`);
expect(
	"window blur mid-drag commits exactly one entry",
	await evaluate("window.__sceneHistory().past") === pastBeforeBlur + 1,
	JSON.stringify(await evaluate("window.__sceneHistory()")),
);
expect(
	"a blur keeps the travelled transform",
	JSON.stringify((await transform()).Position) === JSON.stringify(blurTravelled.Position),
	JSON.stringify(await transform()),
);
// the producer is torn down: keep moving with the button still down
await mouse("mouseMoved", blurEnd.x + 60, blurEnd.y);
await sleep(60);
expect(
	"no stale movement after a blur commit",
	JSON.stringify((await transform()).Position) === JSON.stringify(blurTravelled.Position),
	JSON.stringify(await transform()),
);
await mouse("mouseReleased", blurEnd.x + 60, blurEnd.y);
expect("the store is settled after a blur", await evaluate("window.__sceneHistory().settled === true"));

// Escape mid-drag is the ONLY rollback: byte-for-byte restore, no entry.
const pastBeforeEscape = await evaluate("window.__sceneHistory().past");
const escapeBefore = await transform();
const escapeEnd = await dragHeld(await grabX(), { dx: -160 });
expect(
	"the Escape case applies real travel before the key",
	Math.abs((await transform()).Position[0] - escapeBefore.Position[0]) > 0.1,
	`${JSON.stringify(escapeBefore)} -> ${JSON.stringify(await transform())}`,
);
await pressKey("Escape", "Escape");
await waitFor(`${positionInput(0)} === ${escapeBefore.Position[0]}`);
expect(
	"Escape mid-drag restores the pre-drag transform byte-for-byte",
	JSON.stringify(await transform()) === JSON.stringify(escapeBefore),
	`${JSON.stringify(escapeBefore)} -> ${JSON.stringify(await transform())}`,
);
expect(
	"a cancelled drag creates no history entry",
	await evaluate("window.__sceneHistory().past") === pastBeforeEscape,
	JSON.stringify(await evaluate("window.__sceneHistory()")),
);
expect("a cancelled drag leaves the object selected", await evaluate("window.__gizmoHandles().length > 0"));
expect("a rollback leaves the store settled", await evaluate("window.__sceneHistory().settled === true"));
await mouse("mouseReleased", escapeEnd.x, escapeEnd.y);

// Ctrl+Z mid-drag: the travel commits as its OWN entry, then the undo steps
// back over exactly it — past N, settle to N+1, undo back to N with future
// 1. The producer is torn down, so the still-down pointer changes nothing.
const pastBeforeUndo = await evaluate("window.__sceneHistory().past");
const undoBefore = await transform();
const undoEnd = await dragHeld(await grabX(), { dx: -160 });
expect(
	"the undo case applies real travel before the key",
	Math.abs((await transform()).Position[0] - undoBefore.Position[0]) > 0.1,
	`${JSON.stringify(undoBefore)} -> ${JSON.stringify(await transform())}`,
);
await pressKeyCombo("z", "KeyZ", 2); // Ctrl+Z
await waitFor(`(() => { const h = window.__sceneHistory(); return h.past === ${pastBeforeUndo} && h.future === 1; })()`);
expect(
	"undo mid-drag commits the travel then steps back over it",
	(await evaluate("window.__sceneHistory().past")) === pastBeforeUndo && (await evaluate("window.__sceneHistory().future")) === 1,
	`expected past ${pastBeforeUndo}, future 1; got ${JSON.stringify(await evaluate("window.__sceneHistory()"))}`,
);
await waitFor(`${positionInput(0)} === ${undoBefore.Position[0]}`);
expect(
	"a mid-drag undo restores the pre-drag transform",
	JSON.stringify((await transform()).Position) === JSON.stringify(undoBefore.Position),
	JSON.stringify(await transform()),
);
const afterUndo = await transform();
await mouse("mouseMoved", undoEnd.x + 80, undoEnd.y);
await sleep(60);
expect(
	"the pointer stream is inert after a mid-drag undo",
	JSON.stringify(await transform()) === JSON.stringify(afterUndo),
	JSON.stringify(await transform()),
);
await mouse("mouseReleased", undoEnd.x + 80, undoEnd.y);
expect("the store is settled after a mid-drag undo", await evaluate("window.__sceneHistory().settled === true"));

// A selection change mid-drag settles the open drag first: the applied
// travel becomes its own entry, the stale pointer stream dies, and the new
// selection never sees a stray tick.
const capsuleBeforeSwitch = await transform(); // the Capsule is selected from the undo case
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'))");
await waitFor("window.__gizmoHandles().length > 0");
const cubeBeforeSwitch = await transform();
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Capsule'))");
await waitFor("window.__gizmoHandles().length > 0");
const pastBeforeSwitch = await evaluate("window.__sceneHistory().past");
const switchEnd = await dragHeld(await grabX(), { dx: 160 });
const switchTravelled = await transform();
expect(
	"the selection-change case applies real travel before the switch",
	Math.abs(switchTravelled.Position[0] - capsuleBeforeSwitch.Position[0]) > 0.1,
	`${JSON.stringify(capsuleBeforeSwitch)} -> ${JSON.stringify(switchTravelled)}`,
);
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'))");
await waitFor(`window.__sceneHistory().past === ${pastBeforeSwitch + 1}`);
expect(
	"a selection change mid-drag commits the travel as exactly one entry",
	await evaluate(`(() => { const history = window.__sceneHistory(); return history.past === ${pastBeforeSwitch + 1} && history.future === 0; })()`),
	JSON.stringify(await evaluate("window.__sceneHistory()")),
);
// keep moving with the button still down: the producer was torn down, so
// the new selection must not move
await mouse("mouseMoved", switchEnd.x + 80, switchEnd.y);
await sleep(60);
await mouse("mouseMoved", switchEnd.x + 120, switchEnd.y);
await sleep(60);
expect(
	"the stale stream does not move the new selection",
	JSON.stringify(await transform()) === JSON.stringify(cubeBeforeSwitch),
	`${JSON.stringify(cubeBeforeSwitch)} -> ${JSON.stringify(await transform())}`,
);
await mouse("mouseReleased", switchEnd.x + 120, switchEnd.y);
// re-select the first object: its travel was committed, not rolled back
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Capsule'))");
await waitFor("window.__gizmoHandles().length > 0");
expect(
	"the first object's travel survives the switch byte-for-byte",
	JSON.stringify(await transform()) === JSON.stringify(switchTravelled),
	`${JSON.stringify(switchTravelled)} -> ${JSON.stringify(await transform())}`,
);
expect("the store is settled after a selection change", await evaluate("window.__sceneHistory().settled === true"));

// PlanBoard selects BEFORE it begins: dragging an unselected object's puck
// must select it AND still record exactly one entry — a begin-then-select
// order would settle the fresh token and split or lose the entry (§6.4).
const capsuleForPlan = await transform(); // the Capsule, now away from the Cube
const pastBeforePlan = await evaluate("window.__sceneHistory().past");
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'))");
await waitFor("window.__gizmoHandles().length > 0");
// The plan board only lives in the Top-View inset now (planIsMain is
// hard false — the double-click big-pane swap is gone for good), so the
// puck is driven in the inset itself: PLAN_EXTENT (12.4 m) maps to half
// its shorter side, same as the bird's-eye case above.
const planRect = await evaluate("(() => { const b = document.querySelector('.vp-inset').getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height, scale: Math.min(b.width, b.height) / 2 / 12.4 }; })()");
const capsulePuck = {
	x: Math.round(planRect.left + planRect.width / 2 + capsuleForPlan.Position[0] * planRect.scale),
	y: Math.round(planRect.top + planRect.height / 2 + capsuleForPlan.Position[2] * planRect.scale),
};
await drag(capsulePuck, { x: capsulePuck.x, y: capsulePuck.y + 60 });
await waitFor(`window.__sceneHistory().past === ${pastBeforePlan + 1}`);
expect(
	"dragging an unselected plan puck selects the object",
	await evaluate("[...document.querySelectorAll('.hierarchy-row-wrap.selected .hierarchy-label')].some(n => n.textContent === 'Capsule')"),
);
expect(
	"a plan drag of an unselected object moves it",
	(await transform()).Position[2] > capsuleForPlan.Position[2] + 0.2,
	`${JSON.stringify(capsuleForPlan)} -> ${JSON.stringify(await transform())}`,
);
expect(
	"a plan drag of an unselected object is exactly one entry",
	(await evaluate("window.__sceneHistory().past")) === pastBeforePlan + 1 && (await evaluate("window.__sceneHistory().settled")) === true,
	JSON.stringify(await evaluate("window.__sceneHistory()")),
);
await pressKeyCombo("z", "KeyZ", 2); // Ctrl+Z: one entry, one undo
await waitFor(`${positionInput(2)} === ${capsuleForPlan.Position[2]}`);
expect(
	"one undo restores the unselected-object plan drag",
	JSON.stringify((await transform()).Position) === JSON.stringify(capsuleForPlan.Position),
	`${JSON.stringify(capsuleForPlan.Position)} -> ${JSON.stringify((await transform()).Position)}`,
);

// Camera grips never open a scene transaction: navigation must not enter
// scene history. The camera sits at its mount position — the persistence
// isolation reload reset it, and nothing since has flown it.
const distanceBefore = await cameraDistance();
const pastBeforeCam = await evaluate("window.__sceneHistory().past");
const camPuck = {
	x: Math.round(planRect.left + planRect.width / 2 + 0.97 * planRect.scale),
	y: Math.round(planRect.top + planRect.height / 2 + 2.39 * planRect.scale),
};
// Fly ~2 m, stated in metres via the plan scale: a raw pixel delta would
// change its meaning whenever PLAN_EXTENT does, and the choreography after
// this flight is calibrated for a short hop, not a cross-stage launch.
await drag(camPuck, { x: camPuck.x + Math.round(1.92 * planRect.scale), y: camPuck.y + Math.round(1.2 * planRect.scale) });
await waitFor(`document.querySelector('span[title="camera to subject"]')?.textContent !== ${JSON.stringify(distanceBefore)}`);
expect(
	"dragging the camera puck flies the shot camera",
	(await cameraDistance()) !== distanceBefore,
	`${distanceBefore} -> ${await cameraDistance()}`,
);
expect(
	"a camera puck drag opens no scene transaction",
	await evaluate("window.__sceneHistory().past") === pastBeforeCam,
	JSON.stringify(await evaluate("window.__sceneHistory()")),
);
expect("the store stays settled after a camera drag", await evaluate("window.__sceneHistory().settled === true"));

// Delete mid-drag: the atomic action settles the open drag first, so the
// travel commits as its own entry and the removal as a second — the two can
// never fold into one. The producer dies with the drag: further pointer
// movement resurrects nothing. (Last: it removes the Capsule.)
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Capsule'))");
await waitFor("window.__gizmoHandles().length > 0");
// The camera-puck flight above leaves the pose wherever the plan drag
// took it, and from there the capsule's gizmo projects into the bottom
// letterbox band where no press is pickable. Park the capsule near the
// stage centre first, then recenter, then wait out the camera glide —
// the projected handles must hold still before a grab point is read.
for (const [index, value] of [[0, 0.5], [2, 0.5]]) {
	await evaluate(
		"(() => { const r = [...document.querySelectorAll('.inspector-pane .vec3-row')].filter(r => !r.closest('.subject-box')).find(r => r.querySelector('.vec3-label').textContent === 'Position');" +
			` const input = r.querySelectorAll('input')[${index}]; input.focus();` +
			` Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '${value}');` +
			" input.dispatchEvent(new Event('input', { bubbles: true }));" +
			" input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()",
	);
}
await evaluate("document.activeElement?.blur()");
await openRecenter();
await evaluate("document.querySelector('.viewport-titlebar [aria-label=\"Recenter on subject\"]')?.click()");
await sleep(600);
for (let i = 0; i < 20; i++) {
	const a = JSON.stringify(await evaluate("window.__gizmoHandles()"));
	await sleep(150);
	if (a === JSON.stringify(await evaluate("window.__gizmoHandles()"))) break;
}
const pastBeforeDelete = await evaluate("window.__sceneHistory().past");
const deleteBefore = await transform();
const deleteGrab = await grabX();
// the X arrow can project near the pane's right edge; drag toward the middle
globalThis.deleteDx = deleteGrab.x > (await evaluate("document.querySelector('canvas').getBoundingClientRect().right")) * 0.75 ? -160 : 160;
globalThis.deleteEnd = await dragHeld(deleteGrab, { dx: deleteDx });
expect(
	"the Delete case applies real travel before the key",
	Math.abs((await transform()).Position[0] - deleteBefore.Position[0]) > 0.1,
	`${JSON.stringify(deleteBefore)} -> ${JSON.stringify(await transform())}`,
);
await pressKey("Delete", "Delete");
await waitFor("[...document.querySelectorAll('.hierarchy-label')].every(n => n.textContent !== 'Capsule') && window.__gizmoHandles().length === 0");
expect(
	"Delete mid-drag removes the dragged object",
	await evaluate("[...document.querySelectorAll('.hierarchy-label')].every(n => n.textContent !== 'Capsule')"),
);
expect("Delete mid-drag leaves no gizmo behind", await evaluate("window.__gizmoHandles().length === 0"));
expect(
	"Delete mid-drag commits the travel and the removal as two entries",
	(await evaluate("window.__sceneHistory().past")) === pastBeforeDelete + 2 && (await evaluate("window.__sceneHistory().settled")) === true,
	JSON.stringify(await evaluate("window.__sceneHistory()")),
);
expect("Delete mid-drag logs no page errors", pageErrors.length === 0, pageErrors.join(" | "));
// the pointer is still down: the stale stream must not resurrect anything
await mouse("mouseMoved", deleteEnd.x + 80, deleteEnd.y);
await sleep(60);
await mouse("mouseMoved", deleteEnd.x + 160, deleteEnd.y);
await sleep(60);
expect(
	"the stale stream after Delete resurrects nothing",
	await evaluate(`[...document.querySelectorAll('.hierarchy-label')].every(n => n.textContent !== 'Capsule') && window.__gizmoHandles().length === 0 && window.__sceneHistory().past === ${pastBeforeDelete + 2}`),
	JSON.stringify(await evaluate("window.__sceneHistory()")),
);
await mouse("mouseReleased", deleteEnd.x + 160, deleteEnd.y);
expect("the store is settled after a Delete mid-drag", await evaluate("window.__sceneHistory().settled === true"));


// The #81 click-through-the-cage repro lives in its own standalone suite,
// test/qa-gizmo-click-through-browser.mjs, so the regression check does not
// wait on every section above to stay green.

expect("the page logged no errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) process.exit(1);
console.log("all scene object browser checks PASS");
