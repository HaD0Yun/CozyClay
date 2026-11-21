#!/usr/bin/env node
// Browser contract for the Empty (a node with no geometry): an agent-built
// assembly gets one top-level handle. The author creates it from the real
// create menu, drags a part's Outliner row onto it, moves it and the part
// follows, and can wrap an existing object with "Group under new Empty" in
// one undo step. Its marker is editor furniture: visible and clickable in the
// working view, absent from the shot camera.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5908 npm run dev -- --port 5808`
// in one shell, then
// `QA_URL=http://127.0.0.1:5808/app/ CDP_PORT=9498 node tools/qa-browser.mjs -- node test/qa-empty-object-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const cdpPort = Number(process.env.CDP_PORT || 9498);
const out = process.env.QA_OUT || "/tmp/empty-object-qa";
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.url.includes("/app/")) || targets.find((target) => target.type === "page");
assert.ok(page, "studio page is not open");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
const runtimeErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || "exception");
	if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") runtimeErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
	if (!message.id || !pending.has(message.id)) return;
	const item = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) item.reject(new Error(JSON.stringify(message.error)));
	else item.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "browser evaluation failed");
	return result.result?.value;
};
const waitFor = async (label, probe, timeoutMs = 30000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe().catch(() => null);
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 120));
	}
	throw new Error(`Timed out waiting for ${label}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
let failures = 0;
const expect = (label, value, detail = "") => {
	console.log(`${value ? "PASS" : "FAIL"} ${label}${value || !detail ? "" : ` - ${detail}`}`);
	if (!value) failures += 1;
};

await send("Runtime.enable");
await mkdir(out, { recursive: true });
const shot = async (name) => {
	const image = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(`${out}/${name}.png`, Buffer.from(image.data, "base64"));
	return image.data;
};
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1, ...extra });
const click = async (x, y) => { await mouse("mouseMoved", x, y, { buttons: 0 }); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
const rightClick = async (x, y) => {
	await mouse("mouseMoved", x, y, { buttons: 0 });
	await mouse("mousePressed", x, y, { button: "right", buttons: 2 });
	await mouse("mouseReleased", x, y, { button: "right", buttons: 0 });
};
// A point ON the element that real hit-testing really lands on it. The Outliner
// pane clips its context menu, so the geometric centre of a wide menu item can
// sit outside the visible pane; probe a few points along the row and return the
// first whose topmost element is the item (or a child of it).
const centerOf = (selector, textPattern = null) => evaluate(`(() => {
	const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
	const node = ${textPattern ? `nodes.find((n) => ${textPattern}.test(n.textContent.trim()))` : "nodes[0]"};
	if (!node) return null;
	const r = node.getBoundingClientRect();
	if (!(r.width > 0 && r.height > 0)) return null;
	for (const fraction of [0.5, 0.35, 0.2, 0.1, 0.65]) {
		const x = r.left + r.width * fraction, y = r.top + r.height / 2;
		const top = document.elementFromPoint(x, y);
		if (top && (top === node || node.contains(top))) return { x, y };
	}
	return null;
})()`);
const objects = () => evaluate("window.__cozyclay.objects.map((o) => ({ id: o.id, name: o.name, renderer: o.renderer, x: o.x, y: o.y ?? 0, z: o.z, parent: o.parent ?? null, color: o.color }))");
const selectedRow = () => evaluate(`document.querySelector(".v2-outliner .hierarchy-row-wrap.selected")?.dataset.nodeId ?? null`);
const pressUndo = async () => {
	const key = { key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 };
	await send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
};
const openProps = () => evaluate(`(() => {
	const fold = document.querySelector('[data-node-id="props"] .hierarchy-toggle');
	if (fold && fold.textContent.trim() === "▸") fold.click();
	return true;
})()`);
const rowFor = async (id) => {
	await waitFor(`outliner row ${id}`, async () => {
		await openProps();
		return evaluate(`!!document.querySelector('[data-node-id="${id}"]')`);
	});
};

await waitFor("studio QA hook", () => evaluate("Boolean(window.__cozyclay?.sceneObject && window.__cozyclay?.scrub && window.__cozyclay?.editorCam)"));
await evaluate("window.__cozyclay.setLookThrough(false)");
await waitFor("editor view is the main view", () => evaluate("window.__cozyclay.activeCam === window.__cozyclay.editorCam"));

/* ---------------------------------------------- the part: a plain cube ---- */

const cubeId = await evaluate(`window.__cozyclay.sceneObject.place({ kind: "cube", name: "Probe Cube", x: 1, z: 1 }).id`);
await rowFor(`object:${cubeId}`);

const renameOpenOn = (rowId) => evaluate(`(() => { const el = document.activeElement; return el?.tagName === "INPUT" && !!el.closest('[data-node-id="${rowId}"]'); })()`);
const pressKey = async (key, code, vk) => { for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk }); };

/* ------------------------- create an Empty from the real create menu ---- */

await openProps();
const propsRow = await waitFor("Props row", () => centerOf('[data-node-id="props"] .hierarchy-row'));
await rightClick(propsRow.x, propsRow.y);
await waitFor("create menu", () => evaluate(`!!document.querySelector(".v2-outliner .hierarchy-context-menu .add-object-item")`));
const labels = await evaluate(`[...document.querySelectorAll(".v2-outliner .hierarchy-context-menu .add-object-item")].map((n) => n.textContent.trim())`);
expect("the create menu lists Empty beside Cube and Sphere", labels.some((l) => /^(Empty|빈 오브젝트)/.test(l)) && labels.some((l) => l.startsWith("Cube") || l.startsWith("큐브")) && labels.some((l) => l.startsWith("Sphere") || l.startsWith("구")), JSON.stringify(labels));
const emptyItem = await centerOf(".v2-outliner .hierarchy-context-menu .add-object-item", /^(Empty|빈 오브젝트)/);
assert.ok(emptyItem, "Empty menu item is on screen");
await click(emptyItem.x, emptyItem.y);
const created = await waitFor("an empty record", async () => (await objects()).find((o) => o.renderer === "empty") ?? null, 8000).catch((error) => { console.log("runtime errors:", JSON.stringify(runtimeErrors.slice(-5))); throw error; });
await rowFor(`object:${created.id}`);
expect("a new Empty opens its name field at once", await waitFor("rename field", async () => (await renameOpenOn(`object:${created.id}`)) || null, 4000).catch(() => false) === true);
await pressKey("Escape", "Escape", 27);
expect("the Empty is selected after creation", (await selectedRow()) === `object:${created.id}`, String(await selectedRow()));
const chip = await evaluate(`document.querySelector('[data-node-id="object:${created.id}"] .v2-outliner-chip')?.className ?? ""`);
expect("the Empty row has its own icon, distinct from a mesh row", /\bempty\b/.test(chip) && !/\bmesh\b/.test(chip), chip);
const cubeChip = await evaluate(`document.querySelector('[data-node-id="object:${cubeId}"] .v2-outliner-chip')?.className ?? ""`);
expect("a cube row keeps the mesh icon", /\bmesh\b/.test(cubeChip), cubeChip);

/* --------------------------- inspector: no colour for an Empty ---------- */

await waitFor("inspector open on the empty", () => evaluate(`!!document.querySelector('.details-selection-name')`));
const emptyInspector = await evaluate(`({ colour: !!document.querySelector(".object-colors-pop"), name: !!document.querySelector('input[type="text"]'), type: document.querySelector(".details-selection-type")?.textContent ?? "" })`);
expect("the inspector hides the colour control for an Empty", emptyInspector.colour === false, JSON.stringify(emptyInspector));
expect("the inspector still offers name and transform for an Empty", emptyInspector.name === true);
await shot("empty-created");

/* ------------------------------------ drag the cube row onto the Empty -- */

await evaluate(`(() => {
	const source = document.querySelector('[data-node-id="object:${cubeId}"]');
	const target = document.querySelector('[data-node-id="object:${created.id}"]');
	const dataTransfer = new DataTransfer();
	const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
	fire(source, "dragstart"); fire(target, "dragenter"); fire(target, "dragover"); fire(target, "drop"); fire(source, "dragend");
})()`);
await waitFor("cube grouped under the empty", async () => (await objects()).find((o) => o.id === cubeId)?.parent === created.id);
expect("dragging the cube row onto the Empty parents it", true);
const nested = await waitFor("cube row nested under the empty row", () => evaluate(`(() => {
	if (!document.querySelector('[data-node-id="object:${cubeId}"]')) {
		const fold = document.querySelector('[data-node-id="object:${created.id}"] .hierarchy-toggle');
		if (fold && fold.textContent.trim() === "▸") fold.click();
		return null;
	}
	const depth = (id) => Number(document.querySelector('[data-node-id="' + id + '"]')?.style.getPropertyValue("--hierarchy-depth"));
	const e = depth("object:${created.id}"), c = depth("object:${cubeId}");
	return Number.isFinite(e) && Number.isFinite(c) && c === e + 1 ? { e, c } : null;
})()`));
expect("the Outliner nests the cube one level under the Empty", !!nested, JSON.stringify(nested));

/* ----------------------------------- move the Empty: the cube follows --- */

const before = await objects();
const emptyBefore = before.find((o) => o.id === created.id);
const cubeBefore = before.find((o) => o.id === cubeId);
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(created.id)}, x: ${emptyBefore.x + 2}, z: ${emptyBefore.z - 1.5} })`);
const moved = await waitFor("cube carried on stage", () => evaluate(`(() => {
	const w = window.__cclayPropWorld || {};
	const c = w[${JSON.stringify(cubeId)}], e = w[${JSON.stringify(created.id)}];
	return c && e && Math.abs(c.x - ${cubeBefore.x + 2}) < 1e-3 ? { cube: c, empty: e } : null;
})()`));
expect("moving the Empty carries the cube on stage", near(moved.cube.x, cubeBefore.x + 2) && near(moved.cube.z, cubeBefore.z - 1.5) && near(moved.empty.x, emptyBefore.x + 2), JSON.stringify(moved));

/* ------------------------------- pick the Empty by its marker (real click) */

const frameOnEmpty = async (id) => {
	const row = (await objects()).find((o) => o.id === id);
	await evaluate(`window.__cozyclay.frameEditorCam({ x: ${row.x + 1.8}, y: ${row.y + 1.4}, z: ${row.z + 3.2} }, { x: ${row.x}, y: ${row.y}, z: ${row.z} })`);
	await sleep(400);
	return row;
};
const projectEmpty = (row) => evaluate(`(() => {
	const cam = window.__cozyclay.editorCam; cam.updateMatrixWorld(true);
	const pane = document.querySelector(".vp-pane.vp-main").getBoundingClientRect();
	const v = cam.position.clone().set(${row.x}, ${row.y}, ${row.z}).project(cam);
	return { x: pane.left + (v.x + 1) / 2 * pane.width, y: pane.top + (1 - v.y) / 2 * pane.height };
})()`);
const emptyRow = await frameOnEmpty(created.id);
// selection elsewhere first, so the click has to do the selecting
await click(propsRow.x, propsRow.y);
await waitFor("selection moved off the empty", async () => (await selectedRow()) !== `object:${created.id}`);
const at = await projectEmpty(emptyRow);
await click(at.x, at.y);
const picked = await waitFor("viewport click selects the Empty", async () => ((await selectedRow()) === `object:${created.id}` ? true : null), 8000).catch(() => false);
expect("clicking the Empty's marker in the viewport selects it", picked === true, String(await selectedRow()));
await shot("empty-selected-editor");

/* ----------- the marker is editor furniture: shot camera never sees it --- */

// Pixel work happens in the page: decode two data URLs and count the pixels
// that differ inside a window.
const pixelDiff = (a, b, box) => evaluate(`(async () => {
	const load = (src) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
	const draw = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height); };
	const [A, B] = await Promise.all([load(${JSON.stringify(a)}).then(draw), load(${JSON.stringify(b)}).then(draw)]);
	if (A.width !== B.width || A.height !== B.height) return { error: "size", a: [A.width, A.height], b: [B.width, B.height] };
	const scale = A.width / ${box ? "window.innerWidth" : "A.width"};
	const x0 = ${box ? `Math.max(0, Math.floor((${box.x} - ${box.r}) * scale))` : "0"}, x1 = ${box ? `Math.min(A.width, Math.ceil((${box.x} + ${box.r}) * scale))` : "A.width"};
	const y0 = ${box ? `Math.max(0, Math.floor((${box.y} - ${box.r}) * scale))` : "0"}, y1 = ${box ? `Math.min(A.height, Math.ceil((${box.y} + ${box.r}) * scale))` : "A.height"};
	let differing = 0;
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
		const i = (y * A.width + x) * 4;
		if (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]) > 30) differing++;
	}
	return { differing, width: A.width, height: A.height };
})()`);

// Put the Empty right in front of the SHOT camera, so any marker geometry
// that leaked onto a visible layer would land in the frame.
await evaluate(`(() => {
	const cam = window.__cozyclay.shotCam; cam.updateMatrixWorld(true);
	const dir = cam.getWorldDirection(cam.position.clone());
	const p = cam.position.clone().addScaledVector(dir, 4);
	window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(created.id)}, x: p.x, y: Math.max(0, p.y - 0.3), z: p.z });
})()`);
await evaluate("window.__cozyclay.scrub(0)");
const placed = await waitFor("empty in front of the shot camera", async () => {
	const row = (await objects()).find((o) => o.id === created.id);
	const w = await evaluate(`window.__cclayPropWorld?.[${JSON.stringify(created.id)}] ?? null`);
	return w && near(w.x, row.x) ? row : null;
});
const shotCamCheck = await evaluate(`(() => {
	const cam = window.__cozyclay.shotCam; cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
	const v = cam.position.clone().set(${placed.x}, ${placed.y}, ${placed.z}).project(cam);
	return { x: v.x, y: v.y, z: v.z, layerGizmo: cam.layers.isEnabled(5) };
})()`);
expect("the Empty stands inside the shot frame", Math.abs(shotCamCheck.x) < 0.9 && Math.abs(shotCamCheck.y) < 0.9 && shotCamCheck.z < 1, JSON.stringify(shotCamCheck));

// Editor view of the same spot: the marker must draw there (proves it exists).
const editorRow = await frameOnEmpty(created.id);
const editorAt = await projectEmpty(editorRow);
const withMarker = await shot("editor-with-marker");
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(created.id)}, hidden: true })`);
await sleep(500);
const withoutMarker = await shot("editor-without-marker");
const editorDiff = await pixelDiff(`data:image/png;base64,${withMarker}`, `data:image/png;base64,${withoutMarker}`, { x: editorAt.x, y: editorAt.y, r: 60 });
expect("the working view draws the marker (pixels change around the Empty when it is hidden)", editorDiff.differing > 12, JSON.stringify(editorDiff));

// Shot camera: the frame with the Empty present equals the frame with it gone.
// (Hiding an Empty would hide its children too, so it is deleted instead;
// deleting promotes the children in place.)
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(created.id)}, hidden: false })`);
await evaluate(`window.__cozyclay.scrub(0)`);
await sleep(500);
const plateEmpty = await evaluate("window.__cozyclay.capturePlate()");
// Positive control: a real cube at the same spot DOES change the plate, so an
// identical plate below means something.
const control = await evaluate(`window.__cozyclay.sceneObject.place({ kind: "cube", name: "Plate Control", x: ${placed.x}, y: ${placed.y}, z: ${placed.z} }).id`);
await sleep(500);
const plateControl = await evaluate("window.__cozyclay.capturePlate()");
const controlDiff = await pixelDiff(plateEmpty, plateControl, null);
expect("control: a cube at the Empty's spot does change the shot frame", controlDiff.differing > 200, JSON.stringify(controlDiff));
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(control)}, hidden: true })`);
await sleep(300);
// Remove through the real Outliner row menu: children are promoted in place.
const emptyRowCenter = await waitFor("empty row", () => centerOf(`[data-node-id="object:${created.id}"] .hierarchy-row`));
await rightClick(emptyRowCenter.x, emptyRowCenter.y);
const deleteItem = await waitFor("Delete menu item", () => centerOf(".v2-outliner .hierarchy-context-menu .hierarchy-context-item", /^(Delete|삭제)$/));
await click(deleteItem.x, deleteItem.y);
await waitFor("empty removed", async () => !(await objects()).some((o) => o.id === created.id));
await evaluate(`window.__cozyclay.scrub(0)`);
await sleep(500);
const plateGone = await evaluate("window.__cozyclay.capturePlate()");
const plateDiff = await pixelDiff(plateEmpty, plateGone, null);
expect("the shot camera frame is identical with and without the Empty (no marker pixels)", plateDiff.differing === 0, JSON.stringify(plateDiff));

/* ---------------------------- Outliner "Group under new Empty" ----------- */

await evaluate("window.__cozyclay.scrub(0)");
const survivor = (await objects()).find((o) => o.id === cubeId);
expect("deleting the Empty promoted its cube to top level in place", survivor.parent === null);
const groupBefore = await objects();
const cubeRow = await waitFor("cube row", () => centerOf(`[data-node-id="object:${cubeId}"] .hierarchy-row`));
await rightClick(cubeRow.x, cubeRow.y);
const groupItem = await waitFor("Group under new Empty item", () => centerOf(".v2-outliner .hierarchy-context-menu .hierarchy-context-item", /^(Group under new Empty|빈 오브젝트로 묶기)$/));
await click(groupItem.x, groupItem.y);
const grouped = await waitFor("grouped under a new empty", async () => {
	const rows = await objects();
	const cube = rows.find((o) => o.id === cubeId);
	const parent = cube?.parent && rows.find((o) => o.id === cube.parent);
	return parent && parent.renderer === "empty" ? { rows, cube, parent } : null;
});
expect("Group under new Empty wraps the cube in an Empty named after it", /Probe Cube Group/.test(grouped.parent.name), grouped.parent.name);
expect("the new Empty sits at the cube's position", near(grouped.parent.x, survivor.x) && near(grouped.parent.z, survivor.z) && near(grouped.parent.y, survivor.y), JSON.stringify(grouped.parent));
expect("the cube did not move", near(grouped.cube.x, survivor.x) && near(grouped.cube.z, survivor.z) && near(grouped.cube.y, survivor.y));
await waitFor("new empty selected", async () => ((await selectedRow()) === `object:${grouped.parent.id}` ? true : null));
expect("selection follows to the new Empty", true);
expect("Group under new Empty opens the Empty's name field", await waitFor("group rename field", async () => (await renameOpenOn(`object:${grouped.parent.id}`)) || null, 4000).catch(() => false) === true);
await pressKey("Escape", "Escape", 27);
await shot("grouped-under-new-empty");

// one undo step takes back both the Empty and the parenting
await pressUndo();
await waitFor("single undo removed the empty", async () => {
	const rows = await objects();
	return !rows.some((o) => o.renderer === "empty") && rows.find((o) => o.id === cubeId)?.parent === null ? true : null;
});
expect("one undo removes the Empty and restores the cube's parent", true);
expect("the scene is back to the state before grouping", JSON.stringify((await objects()).map((o) => o.id)) === JSON.stringify(groupBefore.map((o) => o.id)));

// a grouped character rides: dropping the character row on an Empty row is a
// valid drop target like any object row
const target = await evaluate(`(() => {
	const api = window.__cozyclay.sceneObject; return api.place({ kind: "empty", name: "Drop Target", x: 0, z: 0 }).id;
})()`);
await rowFor(`object:${target}`);
const characterRow = await evaluate(`!!document.querySelector('[data-node-id="characterA"]')`);
if (characterRow) {
	await evaluate(`(() => {
		const source = document.querySelector('[data-node-id="characterA"]');
		const dest = document.querySelector('[data-node-id="object:${target}"]');
		const dataTransfer = new DataTransfer();
		const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
		fire(source, "dragstart"); fire(dest, "dragenter"); fire(dest, "dragover"); fire(dest, "drop"); fire(source, "dragend");
	})()`);
	const adopted = await waitFor("character grouped under the empty", () => evaluate(`window.__cozyclay.charA.parent === ${JSON.stringify(target)} || null`), 8000).catch(() => false);
	expect("a character row can be dropped onto an Empty row", adopted === true);
}

const externalErrors = runtimeErrors.filter((error) => /cloudflareinsights|ERR_CONNECTION_REFUSED|ERR_FAILED|status of 404|Failed to load resource/i.test(error));
const studioErrors = runtimeErrors.filter((error) => !externalErrors.includes(error));
expect("browser QA has no Studio console or page errors", studioErrors.length === 0, JSON.stringify(studioErrors));
console.log(failures === 0 ? `empty object browser QA: ok (screenshots in ${out})` : `empty object browser QA: ${failures} failure(s)`);
ws.close();
if (failures) process.exitCode = 1;
