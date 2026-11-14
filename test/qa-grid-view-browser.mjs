#!/usr/bin/env node
// Browser QA for the Blender-style grid viewport, over CDP through the QA
// browser wrapper: flip the toolbar toggle and read the REAL three scene —
// background colour, deck presence, grid mesh layer. Evidence script; not
// part of the manifest.
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

// Real scene probes, reached from the QA camera hook's scene-graph root.
const sceneRoot = `(() => { let node = window.__cozyclay.editorCam; while (node.parent) node = node.parent; return node; })()`;
const backgroundHex = `${sceneRoot}.background.getHexString()`;
const gridMesh = `(() => { let g = null; ${sceneRoot}.traverse((c) => { if (c.name === "grid-floor") g = c; }); return g && { mask: g.layers.mask, depthWrite: g.material.depthWrite, transparent: g.material.transparent }; })()`;
// The deck is the only Lambert plane painted #5b5d63 (src/room.jsx FLOOR).
const deckPresent = `(() => { let found = false; ${sceneRoot}.traverse((c) => { if (c.isMesh && c.material?.color?.getHexString?.() === "5b5d63") found = true; }); return found; })()`;

expect("app becomes ready", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')", 30000));
expect("the scene graph hook is live", await waitFor("!!window.__cozyclay?.editorCam?.parent", 30000));
// The toggle folded into the viewport bar's View ▾ menu (#194), keeping its
// class and aria-pressed contract; the menu is opened before each use.
const toggle = "document.querySelector('.grid-view-switch')";
const openViewMenu = async () => {
	if (!(await evaluate("!!document.querySelector('.view-menu')"))) {
		await evaluate("document.querySelector('.view-menu-trigger').click()");
	}
	return waitFor("!!document.querySelector('.view-menu')", 8000);
};
expect("the viewport bar offers the View menu", await waitFor("!!document.querySelector('.view-menu-trigger')", 15000));
expect("the View menu opens", await openViewMenu());
expect("the View menu offers the Reference grid toggle", await evaluate(`!!${toggle}`));
// The stage wears the grey void in both modes; the toggle only swaps the deck for the grid.
expect("mode OFF shows the grey stage background", await evaluate(`${backgroundHex} === "232428"`));
expect("mode OFF has the floor deck", await evaluate(deckPresent));
expect("mode OFF has no grid mesh", await evaluate(`${gridMesh} === null`));

await evaluate(`${toggle}.click()`);
expect("ON keeps the dark void background", await waitFor(`${backgroundHex} === "232428"`, 8000));
expect("ON removes the floor deck", await evaluate(`!(${deckPresent})`));
const grid = await evaluate(gridMesh);
expect("ON adds the grid mesh", !!grid, JSON.stringify(grid));
expect("the grid lives on the export-stripped gizmo layer (bit 5)", grid?.mask === (1 << 5), `mask=${grid?.mask}`);
expect("the grid is transparent and never writes depth", grid?.transparent === true && grid?.depthWrite === false);
expect("the fog follows the void colour", await evaluate(`${sceneRoot}.fog.color.getHexString() === "232428"`));
expect("the preference is stored under its own key", await evaluate(`localStorage.getItem("cozyclay.grid-view.v1") === "1"`));

// persistence across reload
await send("Page.enable");
await send("Page.reload", { ignoreCache: false });
await sleep(1000);
expect("app returns after reload", await waitFor("!!document.querySelector('.view-menu-trigger')", 30000));
expect("the View menu reopens after the reload", await openViewMenu());
expect("the mode survives the reload", await waitFor(`${toggle}.getAttribute("aria-pressed") === "true"`, 8000));
expect("the void background survives the reload", await waitFor(`${backgroundHex} === "232428"`, 8000));

// OFF restores the deck; the background stays the same grey
await evaluate(`${toggle}.click()`);
expect("OFF keeps the stage background", await waitFor(`${backgroundHex} === "232428"`, 8000));
expect("OFF restores the floor deck", await evaluate(deckPresent));
expect("OFF removes the grid mesh", await evaluate(`${gridMesh} === null`));
expect("OFF is stored", await evaluate(`localStorage.getItem("cozyclay.grid-view.v1") === "0"`));

if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("qa-grid-view-browser: all checks passed");
ws.close();
