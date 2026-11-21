#!/usr/bin/env node
// F-wave manual QA for the auto color mode, driven over CDP through the QA
// browser wrapper: place two cubes, toggle the mode, and read the REAL mesh
// material colors out of the live three scene. One-off evidence script for
// .omo/plans/auto-object-color.md; not part of the manifest.
const port = Number(process.env.CDP_PORT || 9222);
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 15000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(120);
	}
	return false;
};
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

// Scene mesh colors, reached from the QA camera hook's scene-graph root.
const sceneColors = `(() => {
	let node = window.__cozyclay.editorCam; while (node.parent) node = node.parent;
	const hexes = [];
	node.traverse((child) => { if (child.isMesh && child.material?.color) hexes.push("#" + child.material.color.getHexString()); });
	return hexes;
})()`;

expect("app becomes ready", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')", 30000));
const addObject = async (label) => {
	await evaluate(`(() => {
		const row = document.querySelector('.v2-outliner [data-node-id="light"]');
		const box = row.getBoundingClientRect();
		row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(box.left + 28), clientY: Math.round(box.top + 12), button: 2 }));
		return true;
	})()`);
	await waitFor("document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item').length > 0");
	await evaluate(`[...document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item')].find(b => b.textContent.startsWith(${JSON.stringify(label)})).click()`);
	await sleep(300);
};
await addObject("Cube");
await addObject("Cube");
expect("two cubes exist (ids cube, cube-2)", await evaluate("[...document.querySelectorAll('.hierarchy-label')].filter(n => n.textContent.startsWith('Cube')).length === 2"));

const GREY_BOX = "#c2c6c8"; // src/scene-objects.js:65 — asserted below before use
expect("GREY_BOX constant matches the source", await evaluate(`(${JSON.stringify(GREY_BOX)}).length === 7`) && (await import("node:fs")).readFileSync(new URL("../src/scene-objects.js", import.meta.url), "utf8").includes(`GREY_BOX = "${GREY_BOX}"`));
expect("mode OFF renders both cubes grey-box", await evaluate(`${sceneColors}.filter(h => h === "${GREY_BOX}").length >= 2`));

// The toggle moved out of the topbar into the viewport bar's View ▾ menu
// (#194). It kept its class and its aria-pressed contract, so every
// assertion below is the same one, driven through the menu.
const toggle = "document.querySelector('.auto-color-toggle')";
const openViewMenu = async () => {
	if (!(await evaluate("!!document.querySelector('.view-menu')"))) {
		await evaluate("document.querySelector('.view-menu-trigger').click()");
	}
	return waitFor("!!document.querySelector('.view-menu')", 8000);
};
expect("the viewport bar offers the View menu", await waitFor("!!document.querySelector('.view-menu-trigger')", 15000));
expect("the View menu opens", await openViewMenu());
expect("the View menu offers the Auto Color toggle", await evaluate(`!!${toggle}`));
expect("the toggle starts unpressed", await evaluate(`${toggle}.getAttribute("aria-pressed") === "false"`));
await evaluate(`${toggle}.click()`);
await sleep(400);
expect("the toggle reports pressed", await evaluate(`${toggle}.getAttribute("aria-pressed") === "true"`));
expect("cube renders its derived hex #66b8d6", await evaluate(`${sceneColors}.includes("#66b8d6")`));
expect("cube-2 renders its derived hex #d66678", await evaluate(`${sceneColors}.includes("#d66678")`));
expect("the preference is stored under its own key", await evaluate(`localStorage.getItem("cozyclay.auto-color.v1") === "1"`));

// Toggling wrote no history: one undo removes the LAST PLACEMENT, not the mode.
await evaluate(`${toggle}.click()`); await sleep(200);
await evaluate(`${toggle}.click()`); await sleep(200);
expect("double-toggle lands back on pressed", await evaluate(`${toggle}.getAttribute("aria-pressed") === "true"`));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: process.platform === "darwin" ? 4 : 2, windowsVirtualKeyCode: 90 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers: process.platform === "darwin" ? 4 : 2, windowsVirtualKeyCode: 90 });
await sleep(500);
expect("undo removes the last placement, not the mode", await evaluate("[...document.querySelectorAll('.hierarchy-label')].filter(n => n.textContent.startsWith('Cube')).length === 1"));
expect("the toggle survives the undo", await evaluate(`${toggle}.getAttribute("aria-pressed") === "true"`));

// Reload: the mode persists; the surviving first cube keeps its exact hex.
await send("Page.enable");
await send("Page.reload", { ignoreCache: false });
await sleep(1000);
expect("app returns after reload", await waitFor("!!document.querySelector('.view-menu-trigger')", 30000));
expect("the View menu reopens after the reload", await openViewMenu());
expect("the mode survives the reload", await evaluate(`${toggle}.getAttribute("aria-pressed") === "true"`));
expect("the surviving cube keeps #66b8d6 after reload", await waitFor(`${sceneColors}.includes("#66b8d6")`, 15000));

// OFF restores the authored world exactly.
await evaluate(`${toggle}.click()`);
await sleep(400);
expect("OFF removes every derived hex", await evaluate(`!${sceneColors}.includes("#66b8d6")`));
expect("OFF restores grey-box on the cube", await evaluate(`${sceneColors}.includes("${GREY_BOX}")`));
expect("OFF is stored", await evaluate(`localStorage.getItem("cozyclay.auto-color.v1") === "0"`));

if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("qa-auto-color-browser: all checks passed");
ws.close();
