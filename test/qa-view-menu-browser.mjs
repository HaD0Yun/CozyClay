#!/usr/bin/env node
// Browser QA for the viewport bar's View ▾ menu and the mode-aware character
// Transform foldout (#194), over CDP through the QA browser wrapper:
//
//   QA_URL=http://127.0.0.1:5180/app/ node tools/qa-browser.mjs -- \
//     node test/qa-view-menu-browser.mjs
//
// It drives the REAL studio: the menu's open/close behaviour, the three look
// toggles it now owns (part colours only while a character is selected), the
// trigger's "something is on" dot, and the foldout that is a folded Transform
// in Scene mode and an open Placement row in Motion — with the character
// gizmo mounted, which is the whole point of entering Motion on a character
// row instead of the group. Evidence script; not part of the manifest.
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
/** poll a page condition — every wait in this file is a state condition, never a delay */
const waitFor = async (expression, timeoutMs = 15000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await new Promise((resolve) => setTimeout(resolve, 60));
	}
	return false;
};
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

/* ---------------------------------------------------------- page setup --- */

// The QA browser inherits the host locale; pin English so label matching is
// deterministic, then let the studio boot from that storage.
await waitFor("location.href.startsWith('http')", 30000);
await evaluate("localStorage.setItem('cozyclay.locale', 'en')");
await send("Page.enable");
await send("Page.reload", { ignoreCache: false });
expect("the studio comes back up", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')", 40000));
expect("the scene-graph hook is live", await waitFor("!!window.__cozyclay?.editorCam?.parent", 30000));
expect("the hierarchy has rendered", await waitFor("document.querySelectorAll('.hierarchy-row-wrap').length > 0", 15000));

const trigger = "document.querySelector('.view-menu-trigger')";
const menu = "document.querySelector('.view-menu')";
const selectRow = async (nodeId) => {
	await evaluate(`document.querySelector('[data-node-id="${nodeId}"] .hierarchy-row').click()`);
	return waitFor(`document.querySelector('[data-node-id="${nodeId}"]').getAttribute('aria-selected') === 'true'`, 8000);
};
const clickMode = async (label) => {
	await evaluate(`document.querySelector('[data-mode-key="${({ Scene: "1", Pose: "2", Camera: "3", Motion: "4" })[label]}"]').click()`);
	return waitFor(`document.querySelector('.app').dataset.workflowMode === ${JSON.stringify(label.toLowerCase())}`, 8000);
};
const openMenu = async () => {
	if (!(await evaluate(`!!${menu}`))) await evaluate(`${trigger}.click()`);
	return waitFor(`!!${menu}`, 8000);
};
/** the one visible foldout with this title, read as its shipped control set */
const foldout = (title) => evaluate(`(() => {
	const head = [...document.querySelectorAll('.card.foldout:not([hidden]) .foldout-head')]
		.find((b) => b.querySelector('.foldout-title')?.textContent.trim() === ${JSON.stringify(title)});
	if (!head) return null;
	const card = head.closest('.card.foldout');
	return {
		open: head.getAttribute('aria-expanded') === 'true',
		axes: [...card.querySelectorAll('.foldout-body .vec3-row .axis')].map((s) => s.textContent.trim()),
		sliders: [...card.querySelectorAll('.foldout-body .cslider-head > span:first-child')].map((s) => s.textContent.trim()),
	};
})()`);
/** gizmo pick proxies live in the scene graph (src/gizmo-claim.js HANDLE_PROXY_FLAG) */
const gizmoProxies = `(() => {
	let node = window.__cozyclay.editorCam; while (node.parent) node = node.parent;
	let count = 0;
	node.traverse((child) => { if (child.userData?.gizmoHandleProxy) count += 1; });
	return count;
})()`;

/* ------------------------------------------------- the menu itself ------- */

expect("Scene mode is the entry state", await clickMode("Scene"));
expect("a character is selected", await selectRow("characterA"));
expect("the viewport bar carries the View trigger", await evaluate(`!!${trigger}`));
expect("the trigger reads as a menu button", await evaluate(`${trigger}.getAttribute('aria-haspopup') === 'menu'`));
expect("the menu starts closed", await evaluate(`${trigger}.getAttribute('aria-expanded') === 'false' && !${menu}`));

expect("clicking opens the menu", await openMenu());
expect("the trigger reports expanded", await evaluate(`${trigger}.getAttribute('aria-expanded') === 'true'`));
expect("Reference grid is an item", await evaluate(`!!document.querySelector('.view-menu .grid-view-switch')`));
expect("Auto Color is an item", await evaluate(`!!document.querySelector('.view-menu .auto-color-toggle')`));
expect(
	"Auto Color keeps its capture warning",
	await evaluate(`/captures include them/.test(document.querySelector('.view-menu .auto-color-toggle').title)`),
);
expect(
	"body part colours offer off/shaded/flat while a character is selected",
	await evaluate(`JSON.stringify([...document.querySelectorAll('.view-menu [data-part-colours]')].map((b) => b.dataset.partColours)) === '["off","shaded","flat"]'`),
);
expect(
	"the part colours start on off",
	await evaluate(`document.querySelector('.view-menu [data-part-colours="off"]').getAttribute('aria-checked') === 'true'`),
);

// Escape closes and hands focus back to the trigger.
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
expect("Escape closes the menu", await waitFor(`!${menu}`, 8000));
expect("focus returns to the trigger", await evaluate(`document.activeElement === ${trigger}`));

// A second click on the trigger closes it again (the trigger is a toggle).
expect("clicking reopens the menu", await openMenu());
await evaluate(`${trigger}.click()`);
expect("clicking the trigger again closes it", await waitFor(`!${menu}`, 8000));

/* --------------------------------------- the toggles the menu now owns --- */

expect("the trigger has no dot while every look toggle is off", await evaluate("!document.querySelector('.view-menu-dot')"));
expect("the menu opens for the grid toggle", await openMenu());
const gridItem = "document.querySelector('.view-menu .grid-view-switch')";
expect("the grid toggle starts unpressed", await evaluate(`${gridItem}.getAttribute('aria-pressed') === 'false'`));
await evaluate(`${gridItem}.click()`);
expect("toggling the grid flips aria-pressed", await waitFor(`${gridItem}.getAttribute('aria-pressed') === 'true'`, 8000));
expect("the item stays in the open menu after a toggle", await evaluate(`!!${menu}`));
expect("the trigger grows its dot", await waitFor("!!document.querySelector('.view-menu-dot')", 8000));
await evaluate(`${gridItem}.click()`);
expect("toggling back clears aria-pressed", await waitFor(`${gridItem}.getAttribute('aria-pressed') === 'false'`, 8000));
expect("the dot goes with it", await waitFor("!document.querySelector('.view-menu-dot')", 8000));

// Part colours belong to a body: with the camera selected the section is gone
// while the two viewport toggles stay.
await evaluate(`${trigger}.click()`);
await waitFor(`!${menu}`, 8000);
expect("the camera row can be selected", await selectRow("camera"));
expect("the menu opens with the camera selected", await openMenu());
expect(
	"body part colours are not offered without a character",
	await evaluate("document.querySelectorAll('.view-menu [data-part-colours]').length === 0"),
);
expect(
	"the viewport toggles stay",
	await evaluate("!!document.querySelector('.view-menu .grid-view-switch') && !!document.querySelector('.view-menu .auto-color-toggle')"),
);
await evaluate(`${trigger}.click()`);
await waitFor(`!${menu}`, 8000);
expect("the character row can be reselected", await selectRow("characterA"));

/* ------------------------------------- Transform (Scene) / Placement ----- */

const sceneTransform = await foldout("Transform");
expect("Scene mode still offers the character Transform", !!sceneTransform, JSON.stringify(sceneTransform));
expect("it is folded by default — the gizmo is the primary path", sceneTransform?.open === false, JSON.stringify(sceneTransform));

expect("Motion mode is reachable", await clickMode("Motion"));
expect(
	"entering Motion selects a character row, not the group",
	await waitFor("document.querySelector('.hierarchy-row-wrap.selected')?.dataset.nodeId?.startsWith('character') && document.querySelector('.hierarchy-row-wrap.selected').dataset.nodeId !== 'characters'", 8000),
);
expect("the character gizmo is mounted", await waitFor(`${gizmoProxies} > 0`, 10000));
expect("Motion has no Transform foldout", (await foldout("Transform")) === null);
const placement = await foldout("Placement");
expect("Motion shows the Placement foldout", !!placement, JSON.stringify(placement));
expect("Placement is open on arrival", placement?.open === true, JSON.stringify(placement));
expect(
	"Placement is exactly Position X/Z plus Rotation",
	JSON.stringify(placement?.axes) === '["X","Z"]' && JSON.stringify(placement?.sliders) === '["Rotation"]',
	JSON.stringify(placement),
);
expect(
	"the stage-position hint says the take is untouched",
	await evaluate("/does not change the take/.test(document.querySelector('.placement-fields .inspector-hint')?.textContent || '')"),
);
expect("the View menu is still reachable in Motion mode", await evaluate(`!!${trigger}`));
expect("the menu opens in Motion mode too", await openMenu());
expect(
	"and it still offers the part colours for the selected character",
	await evaluate("document.querySelectorAll('.view-menu [data-part-colours]').length === 3"),
);

// Back to Scene: the foldout remounts as the folded full Transform. Scene
// mode selects the shot, so the character has to be picked again first.
await evaluate(`${trigger}.click()`);
await waitFor(`!${menu}`, 8000);
expect("Scene mode is reachable again", await clickMode("Scene"));
expect("the character is selectable again", await selectRow("characterA"));
expect("Motion's Placement row is gone", (await foldout("Placement")) === null);
const backToScene = await foldout("Transform");
expect("Scene mode restores the character Transform", !!backToScene, JSON.stringify(backToScene));
expect("and it comes back folded", backToScene?.open === false, JSON.stringify(backToScene));
// Opened by hand, it is the full nine-input form again (X/Y/Z + turn + size).
await evaluate(`[...document.querySelectorAll('.card.foldout:not([hidden]) .foldout-head')].find((b) => b.querySelector('.foldout-title')?.textContent.trim() === 'Transform').click()`);
expect("opening it shows the full transform", await waitFor(`(() => {
	const head = [...document.querySelectorAll('.card.foldout:not([hidden]) .foldout-head')].find((b) => b.querySelector('.foldout-title')?.textContent.trim() === 'Transform');
	const card = head?.closest('.card.foldout');
	if (!card) return false;
	const axes = [...card.querySelectorAll('.foldout-body .vec3-row .axis')].map((s) => s.textContent.trim()).join(',');
	const sliders = [...card.querySelectorAll('.foldout-body .cslider-head > span:first-child')].map((s) => s.textContent.trim()).join(',');
	return axes === 'X,Y,Z' && sliders === 'Rotation,Scale';
})()`, 8000));

if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("qa-view-menu-browser: all checks passed");
ws.close();
