#!/usr/bin/env node
/**
 * Inspector number fields, scrubbed with a real mouse (issue #87).
 *
 * The maths and the click/drag threshold are unit-tested
 * (test/verify-number-field-scrub.mjs); what only a browser can answer is
 * whether a press on the NUMBER — where users actually aim — becomes a drag
 * at all. That depends on pointer capture, the input's own focus-on-mousedown
 * and React's synthetic pointer events, none of which exist under Node.
 *
 * Run: `npm run dev:ui` in one shell, then
 * `QA_URL=http://127.0.0.1:5180/app/ node tools/qa-browser.mjs -- node test/verify-number-field-scrub-browser.mjs`.
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
	// Uncaught script errors only; network noise is environmental here (no
	// ARDY bridge runs during this suite).
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
const evaluateSafely = async (expression) => {
	try {
		return await evaluate(expression);
	} catch {
		return undefined;
	}
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, { timeoutMs = 8000, intervalMs = 100 } = {}) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluateSafely(expression)) return true;
		await sleep(intervalMs);
	}
	return false;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const mouse = (type, x, y, { modifiers = 0 } = {}) =>
	send("Input.dispatchMouseEvent", {
		type,
		x: Math.round(x),
		y: Math.round(y),
		button: "left",
		clickCount: 1,
		buttons: type === "mouseReleased" ? 0 : 1,
		modifiers,
	});

await send("Runtime.enable");

// Scene persistence would boot a previous run's objects; start from empty
// storage and pin the locale (the QA browser inherits the host's).
for (let i = 0; i < 100 && !(await evaluateSafely("location.href.startsWith('http')")); i++) await sleep(200);
await evaluate("localStorage.removeItem('cozyclay.scene.v1'); localStorage.removeItem('cozyclay.scene.v1.quarantine')");
await evaluate("localStorage.setItem('cozyclay.locale', 'en')");
await send("Page.reload");
for (let i = 0; i < 100 && !(await evaluateSafely("!!document.querySelector('canvas')")); i++) await sleep(200);
for (let i = 0; i < 50 && !(await evaluateSafely("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0")); i++) await sleep(200);
await sleep(1200);

/* ------------------------------------------------------ a cube to scrub ---- */

await evaluate(`(() => {
	const row = document.querySelector('.v2-outliner [data-node-id="light"]');
	const box = row.getBoundingClientRect();
	row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(box.left + 28), clientY: Math.round(box.top + 12), button: 2 }));
	return true;
})()`);
await waitFor("document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item').length > 0");
await evaluate("[...document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item')].find(b => b.textContent.startsWith('Cube')).click()");
await waitFor("[...document.querySelectorAll('.inspector-pane .vec3-row')].some(r => r.querySelector('.vec3-label').textContent === 'Scale')");
await sleep(400);

/** The Inspector's Scale X field: its input rect, value and history depth. */
const scaleField = () =>
	evaluate(`(() => {
		const row = [...document.querySelectorAll('.inspector-pane .vec3-row')].filter(r => !r.closest('.subject-box'))
			.find(r => r.querySelector('.vec3-label').textContent === 'Scale');
		if (!row) return null;
		const field = row.querySelector('.number-field');
		const input = field.querySelector('input');
		const box = input.getBoundingClientRect();
		return {
			value: parseFloat(input.value),
			x: box.left + box.width / 2,
			y: box.top + box.height / 2,
			cursor: getComputedStyle(input).cursor,
			focused: document.activeElement === input,
			past: window.__sceneHistory().past,
		};
	})()`);

const start = await scaleField();
expect("the Inspector shows a Scale row with a number field", start !== null, JSON.stringify(start));
expect("the number itself advertises the scrub cursor", start.cursor === "ew-resize", JSON.stringify(start));

/* ------------------------------------------------- dragging the NUMBER ----- */

const DRAG_PX = 110;
await mouse("mousePressed", start.x, start.y);
for (let i = 1; i <= 12; i++) {
	await mouse("mouseMoved", start.x + (DRAG_PX * i) / 12, start.y);
	await sleep(16);
}
await mouse("mouseReleased", start.x + DRAG_PX, start.y);
await sleep(300);

const dragged = await scaleField();
expect("dragging the number changes the value", Math.abs(dragged.value - start.value) > 0.2, JSON.stringify({ start: start.value, dragged: dragged.value }));
expect("dragging right raises it", dragged.value > start.value, JSON.stringify(dragged));
// Half of the 220 px sweep over Scale's 4-unit span: +2 from 1.
expect("the rate is fixed-travel, not pixels * step", Math.abs(dragged.value - (start.value + (DRAG_PX / 220) * 4)) < 0.1, JSON.stringify(dragged));
expect("the whole drag is exactly one undo entry", dragged.past === start.past + 1, JSON.stringify({ before: start.past, after: dragged.past }));
expect("a drag does not leave the field in text-editing mode", dragged.focused === false, JSON.stringify(dragged));

const undoable = await evaluate("window.__sceneHistory().past");
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: process.platform === "darwin" ? 4 : 2 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: process.platform === "darwin" ? 4 : 2 });
await sleep(300);
const undone = await scaleField();
expect("one undo restores the pre-drag value", Math.abs(undone.value - start.value) < 1e-6, JSON.stringify({ start: start.value, undone: undone.value, past: undoable }));

/* ------------------------------------------------- a click is still a click - */

const beforeClick = await scaleField();
await mouse("mousePressed", beforeClick.x, beforeClick.y);
await mouse("mouseReleased", beforeClick.x, beforeClick.y);
await sleep(250);
const clicked = await scaleField();
expect("a plain click focuses the number for typing", clicked.focused === true, JSON.stringify(clicked));
expect("a plain click leaves the value alone", clicked.value === beforeClick.value, JSON.stringify({ before: beforeClick.value, after: clicked.value }));
expect("a plain click writes no history entry", clicked.past === beforeClick.past, JSON.stringify({ before: beforeClick.past, after: clicked.past }));
expect("a focused field shows a text caret", clicked.cursor === "text", JSON.stringify(clicked));

/* --------------------------------------------------------------- artifacts - */

const artifact = {
	suite: "number-field-scrub",
	issue: 87,
	start: { value: start.value, cursor: start.cursor, past: start.past },
	drag: { dx: DRAG_PX, value: dragged.value, past: dragged.past, focused: dragged.focused },
	undo: { value: undone.value },
	click: { value: clicked.value, focused: clicked.focused, cursor: clicked.cursor, past: clicked.past },
	pageErrors,
	failures,
};
if (process.env.QA_ARTIFACT) {
	const { writeFileSync } = await import("node:fs");
	writeFileSync(process.env.QA_ARTIFACT, `${JSON.stringify(artifact, null, "\t")}\n`);
}
if (process.env.QA_SCREENSHOT) {
	const { writeFileSync } = await import("node:fs");
	const shot = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(process.env.QA_SCREENSHOT, Buffer.from(shot.data, "base64"));
}

expect("the page threw no uncaught errors", pageErrors.length === 0, pageErrors.join(" | "));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
ws.close();
if (failures) process.exitCode = 1;
