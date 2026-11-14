#!/usr/bin/env node
// Browser QA for #81: with a scene object selected, its cage and gizmo
// furniture blanket GIZMO_LAYER around it — and the old selection guard
// vetoed any press that crossed them, so a click aimed at a DIFFERENT
// object's body never changed the selection. Stage the reported repro:
// Cube first, then a Sphere parked 1.2 m beside it (selected, cage up),
// then click the Cube's body straight through. Driven over CDP through the
// QA browser wrapper. Standalone on purpose: the check must not wait on
// the long verify-object-gizmo suite to reach its last section.
import { waitForFrameState } from './bus/browser-frame-state.mjs';
const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params?.exceptionDetails?.exception?.description ?? "unknown page error");
		return;
	}
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
await send("Runtime.enable");
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const waitFor = (expression, timeoutMs = 15000) => waitForFrameState(evaluate, expression, timeoutMs);
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", {
	type,
	x: Math.round(x),
	y: Math.round(y),
	button: "left",
	clickCount: 1,
	buttons: type === "mouseReleased" ? 0 : 1,
});
const addObject = async (label) => {
	await evaluate(`(() => {
		const row = document.querySelector('.v2-outliner [data-node-id="light"]');
		const box = row.getBoundingClientRect();
		row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(box.left + 28), clientY: Math.round(box.top + 12), button: 2 }));
		return true;
	})()`);
	await waitFor("document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item').length > 0");
	await evaluate(`[...document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item')].find(b => b.textContent.startsWith(${JSON.stringify(label)}))?.click()`);
	await waitFor("(window.__gizmoHandles?.().length ?? 0) > 0");
};
/** commit one Position field through the inspector, the way a user types it */
const typePosition = async (index, value) => {
	await evaluate(
		"(() => { const r = [...document.querySelectorAll('.inspector-pane .vec3-row')].filter(r => !r.closest('.subject-box')).find(r => r.querySelector('.vec3-label').textContent === 'Position');" +
			` const input = r.querySelectorAll('input')[${index}]; input.focus();` +
			` Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '${value}');` +
			" input.dispatchEvent(new Event('input', { bubbles: true }));" +
			" input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()",
	);
	expect('position edit settles in the renderer', await waitFor(`window.__sceneHistory?.().settled && [...document.querySelectorAll('.inspector-pane .vec3-row')].filter(r => !r.closest('.subject-box')).find(r => r.querySelector('.vec3-label').textContent === 'Position')?.querySelectorAll('input')[${index}]?.value == ${value}`));
};
const selectedLabel = () => evaluate("document.querySelector('.hierarchy-row-wrap.selected .hierarchy-label')?.textContent ?? 'nothing selected'");

expect("app becomes ready", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')", 30000));

// The Cube, selected: read its position and its record id off its own body.
await addObject("Cube");
const cubePos = await evaluate(
	"(() => { const r = [...document.querySelectorAll('.inspector-pane .vec3-row')].filter(r => !r.closest('.subject-box')).find(r => r.querySelector('.vec3-label').textContent === 'Position');" +
		" return [...r.querySelectorAll('input')].map(i => Number(i.value)); })()",
);
const cubeId = await evaluate(
	"(() => { const g = window.__gizmoHandles(); const c = g.reduce((a, h) => ({ x: a.x + h.x / g.length, y: a.y + h.y / g.length }), { x: 0, y: 0 });" +
		" for (let r = 4; r < 300; r += 4) { for (let a = 0; a < 360; a += 15) {" +
		" const x = Math.round(c.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(c.y + r * Math.sin(a * Math.PI / 180));" +
		" const picked = window.__objectPick(x, y); if (picked && !window.__gizmoPick(x, y)) return picked; } } return null; })()",
);
expect("the cube reports its record id", !!cubeId, String(cubeId));

// The Sphere: created selected, cage up, parked 1.2 m beside the cube so
// both bodies share the frame and the cage overlaps the cube on screen.
await addObject("Sphere");
expect("the sphere owns the selection", (await selectedLabel()) === "Sphere", await selectedLabel());
await typePosition(0, cubePos[0] + 1.2);
await typePosition(2, cubePos[2]);
// Recenter on subject lives in the viewport's Perspective list (G8).
await evaluate("document.querySelector('[data-testid=\"view-camera-trigger\"]').click()");
await waitFor("!!document.querySelector('.viewport-titlebar [aria-label=\"Recenter on subject\"]')");
await evaluate(`(() => {
  window.__gizmoCamera = { previous: [...window.__cozyclay.activeCam.matrixWorld.elements] };
  document.querySelector('.viewport-titlebar [aria-label="Recenter on subject"]')?.click();
})()`);
expect('recenter presents a settled camera and selected gizmo', await waitFor(`(() => {
  const state = window.__gizmoCamera, current = [...window.__cozyclay.activeCam.matrixWorld.elements];
  const delta = Math.max(...current.map((value, index) => Math.abs(value - state.previous[index])));
  state.previous = current;
  // Recenter may already be at its target; that is a settled no-op too.
  return delta < 1e-6 && (window.__gizmoHandles?.().length ?? 0) > 0;
})()`));

// A pixel that is unambiguously the Cube's body while the Sphere owns the
// cage — exactly the press the blanket veto used to swallow. The spiral
// starts at the gizmo hub, so the first match is the cube pixel CLOSEST to
// the selected sphere's furniture.
const cubePixel = await evaluate(
	"(() => { const g = window.__gizmoHandles(); if (!g.length) return null; const c = g.reduce((a, h) => ({ x: a.x + h.x / g.length, y: a.y + h.y / g.length }), { x: 0, y: 0 });" +
		" for (let r = 8; r < 500; r += 4) { for (let a = 0; a < 360; a += 12) {" +
		" const x = Math.round(c.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(c.y + r * Math.sin(a * Math.PI / 180));" +
		` if (window.__objectPick(x, y) === ${JSON.stringify(cubeId)} && !window.__gizmoPick(x, y) && document.elementFromPoint(x, y)?.tagName === 'CANVAS') return { x, y }; } } return null; })()`,
);
expect("the cube offers a body pixel beside the selected sphere", !!cubePixel, JSON.stringify(cubePixel));
if (cubePixel) {
	await mouse("mousePressed", cubePixel.x, cubePixel.y);
	await mouse("mouseReleased", cubePixel.x, cubePixel.y);
	await waitFor("[...document.querySelectorAll('.hierarchy-row-wrap.selected .hierarchy-label')].some(n => n.textContent === 'Cube')", 5000);
	expect(
		"clicking another object past the selected cage moves the selection (#81)",
		(await selectedLabel()) === "Cube",
		await selectedLabel(),
	);
}

expect("the page logged no errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("qa-gizmo-click-through-browser: all checks passed");
