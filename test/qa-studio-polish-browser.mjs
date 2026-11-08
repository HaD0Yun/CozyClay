#!/usr/bin/env node
// Browser QA for the first-session polish: a new project opens with the bright
// neutral key, the Tutorial guide in the middle of the window, + Add puts
// objects at the origin, the Outliner folds to a rail, the shot camera has a
// Transform section whose rotation turns it, and the Text box can be cleared
// without its words coming back.
// Run through tools/qa-browser.mjs with QA_URL pointing at `/app/`.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || join(process.cwd(), ".omo/evidence/studio-polish");
await mkdir(out, { recursive: true });
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
const waitForPageLoad = (timeoutMs = 30000) => new Promise((resolve, reject) => {
	let settled = false;
	const finish = (error) => {
		if (settled) return;
		settled = true;
		ws.removeEventListener("message", onMessage);
		clearTimeout(timer);
		if (error) reject(error);
		else resolve();
	};
	const onMessage = (event) => {
		if (JSON.parse(event.data).method === "Page.loadEventFired") finish();
	};
	const timer = setTimeout(() => finish(new Error("timed out waiting for the QA page to load")), timeoutMs);
	ws.addEventListener("message", onMessage);
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const reload = async () => {
	const loaded = waitForPageLoad();
	await send("Page.reload", { ignoreCache: true });
	await loaded;
};
const waitFor = (condition, timeoutMs = 15000) => evaluate(`new Promise((resolve) => {
	let settled = false;
	const finish = (value) => {
		if (settled) return;
		settled = true;
		observer.disconnect();
		clearTimeout(timer);
		resolve(value);
	};
	const check = () => {
		let value = false;
		try { value = Boolean(${condition}); } catch {}
		if (value) finish(true);
	};
	const observer = new MutationObserver(check);
	observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
	const timer = setTimeout(() => finish(false), ${timeoutMs});
	check();
})`);
const screenshot = async (name) => {
	const result = await send("Page.captureScreenshot", { format: "png" });
	const path = join(out, name);
	await writeFile(path, Buffer.from(result.data, "base64"));
	console.log(`SCREENSHOT ${path}`);
	return path;
};
const setInput = (selector, value) => evaluate(`(() => {
	const input = document.querySelector(${JSON.stringify(selector)});
	if (!input) return false;
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	setter.call(input, ${JSON.stringify(value)});
	input.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
})()`);
const click = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
const rect = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; })()`);
const exported = () => evaluate("window.__cozyclayProject.export('qa').then((text) => { const p = JSON.parse(text); const scene = p.scenes.scenes.find((s) => s.id === p.scenes.activeSceneId) ?? p.scenes.scenes[0]; return { keyLight: scene.stage.keyLight, objects: scene.objects }; })");
const typeInto = (selector, value) => evaluate(`(() => {
	const node = document.querySelector(${JSON.stringify(selector)});
	if (!node) return false;
	node.focus();
	const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(node, ${JSON.stringify(value)});
	node.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
})()`);

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await evaluate(`(() => { for (const key of Object.keys(localStorage)) if (/project-session|scenes|left-collapsed|first-success/i.test(key)) localStorage.removeItem(key); })()`);
await reload();
expect("the start screen renders", await waitFor("!!document.querySelector('.v2-start-screen.startup [data-testid=start-create]')"));
await setInput('[data-testid="start-project-name"]', "qa_polish");
await click("[data-testid=start-create]");
expect("Create opens the editor", await waitFor("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline')"));

// --- 1. Default lighting --------------------------------------------------------
const { keyLight } = await exported();
expect("a new project opens with brightness 3 and warmth 0", keyLight?.intensity === 3 && keyLight?.warmth === 0, JSON.stringify(keyLight));

// --- 2. No tutorial pop-up ---------------------------------------------------
await new Promise((resolve) => setTimeout(resolve, 1200));
expect("Create opens the studio without a tutorial pop-up", await evaluate("!document.querySelector('.v2-first-success-guide')"));

// --- 3. + Add lands at the origin ---------------------------------------------
await evaluate("window.__cozyclay.runStudioAction && null");
await click("[data-testid=viewport-add]");
expect("Add opens its menu", await waitFor("!!document.querySelector('.add-object-menu')"));
await evaluate("[...document.querySelectorAll('.add-object-menu .add-object-item')].find((node) => /^Cube/.test(node.textContent.trim()))?.click()");
await waitFor("false", 600);
const cube = (await exported()).objects.find((object) => object.renderer === "cube");
expect("+ Add puts a cube at the world origin", !!cube && cube.x === 0 && (cube.y ?? 0) === 0 && cube.z === 0, JSON.stringify(cube && { x: cube.x, y: cube.y, z: cube.z }));

// --- 4. Text words can be cleared ----------------------------------------------
await click("[data-testid=viewport-add]");
await waitFor("!!document.querySelector('.add-object-menu')");
await evaluate("[...document.querySelectorAll('.add-object-menu .add-object-item')].find((node) => /^Text/.test(node.textContent.trim()))?.click()");
expect("a text object shows its Words box", await waitFor("!!document.querySelector('[data-field=text-words]')"));
await typeInto("[data-field=text-words]", "");
expect("clearing the Words box leaves it empty", await waitFor("document.querySelector('[data-field=text-words]')?.value === ''", 1500), await evaluate("document.querySelector('[data-field=text-words]')?.value"));
await typeInto("[data-field=text-words]", "Hi");
const typed = (await exported()).objects.find((object) => object.renderer === "text");
expect("typing after clearing stores the new words", typed?.text?.value === "Hi", JSON.stringify(typed?.text));
await typeInto("[data-field=text-words]", "");
await evaluate("document.querySelector('[data-field=text-words]').blur()");
expect("leaving the box blank restores the last words", await waitFor("document.querySelector('[data-field=text-words]')?.value === 'Hi'"), await evaluate("document.querySelector('[data-field=text-words]')?.value"));

// --- 5. Outliner folds --------------------------------------------------------
const addBefore = (await rect(".vp-mode-toolbar")).left;
await click("[data-testid=shell-left-toggle]");
expect("the Outliner folds away to its toggle", await waitFor("Math.round(document.querySelector('.studio-left-column').getBoundingClientRect().width) === 0 && getComputedStyle(document.querySelector('.studio-left-column')).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(document.querySelector('.studio-left-column')).boxShadow === 'none'"));
expect("the folded rail hides the Outliner body", await evaluate("document.querySelector('.shell-left-body').hidden === true"));
const addAfter = (await rect(".vp-mode-toolbar")).left;
expect("the stage widens into the folded column (its centred mode bar moves left)", addAfter < addBefore - 50, JSON.stringify({ addBefore, addAfter }));
const toggle = await rect("[data-testid=shell-left-toggle]"), column = await rect(".studio-left-column");
expect("the folded toggle is a slim tab on the left edge, centred top to bottom", toggle.width <= 16 && toggle.left <= 4 && Math.abs(toggle.top + toggle.height / 2 - (column.top + column.height / 2)) <= 2, JSON.stringify({ toggle, column }));
await reload();
expect("the fold survives a reload", await waitFor("Math.round(document.querySelector('.studio-left-column')?.getBoundingClientRect().width ?? -1) === 0 && document.querySelector('.app').hasAttribute('data-left-collapsed')"));
await click("[data-testid=shell-left-toggle]");
expect("the toggle unfolds it again", await waitFor("document.querySelector('.studio-left-column').getBoundingClientRect().width > 150"));

// --- 5b. One compact rail on the right -----------------------------------------
const rail = await rect(".vp-overlay-rail");
expect("the object and view tools share one rail", await evaluate("!!document.querySelector('.vp-overlay-rail > .vp-overlay-left') && !!document.querySelector('.vp-overlay-rail > .vp-overlay-right')"));
expect("the rail is 30px wide on the right edge of the stage", !!rail && Math.round(rail.width) === 30 && rail.left > 1000, JSON.stringify(rail));
expect("every rail cell is at most 24px and none overlap", await evaluate(`(() => {
	const box = document.querySelector('.vp-overlay-rail').getBoundingClientRect();
	const cells = [...document.querySelectorAll('.vp-overlay-rail button, .vp-overlay-rail .vp-speed')].filter((node) => node.offsetParent).map((node) => node.getBoundingClientRect());
	return cells.every((cell, index) => cell.width <= 24.5 && cell.height <= 24.5 && cell.bottom <= box.bottom + 0.5 && (index === 0 || cell.top >= cells[index - 1].bottom - 0.5));
})()`));
await click("[data-testid=viewport-add]");
await waitFor("!!document.querySelector('.add-object-menu')");
const addMenu = await rect(".add-object-menu");
expect("Add opens to the left of the rail, inside the window", !!addMenu && addMenu.left >= 0 && addMenu.left + addMenu.width <= rail.left, JSON.stringify({ addMenu, rail }));
await click("[data-testid=viewport-add]");
await screenshot("compact-rail.png");

// --- 5c. The dock fits: no scrolled overflow, every lane label on screen ------
for (const [width, height] of [[1440, 900], [1280, 800], [1180, 760]]) {
	await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
	await waitFor("false", 400);
	const fit = await evaluate(`(() => {
		const dock = document.querySelector('.studio-dock-slot').getBoundingClientRect();
		const scroller = document.querySelector('.bottom-timeline');
		const crane = [...document.querySelectorAll('.tl-surface *')].find((node) => node.childElementCount === 0 && node.textContent.trim() === 'Crane')?.getBoundingClientRect();
		const frames = document.querySelector('.pose-key-bar')?.getBoundingClientRect();
		const tabs = document.querySelector('.dock-tabs')?.getBoundingClientRect();
		const box = scroller.getBoundingClientRect();
		const past = [...scroller.querySelectorAll('*')].filter((node) => node.getClientRects().length && node.getBoundingClientRect().bottom > box.bottom + 0.5).slice(0, 4).map((node) => (node.className?.baseVal ?? node.className ?? node.tagName).toString().slice(0, 40) + ' ' + Math.round(node.getBoundingClientRect().bottom - box.bottom));
		return { past, overflow: scroller.scrollHeight - scroller.clientHeight, scrolled: scroller.scrollTop, craneInside: !!crane && crane.bottom <= dock.bottom, framesInside: !!frames && frames.top >= dock.top, framesUnderTabs: !!frames && !!tabs && frames.top >= tabs.bottom };
	})()`);
	// A classic (space-taking) horizontal scrollbar in the lane body can add ~2px at narrow widths;
	// what must hold is that nothing is scrolled away and every lane label is on screen.
	expect(`at ${width}px the dock is not scrolled and shows every lane`, fit.overflow <= 2 && fit.scrolled === 0 && fit.craneInside && fit.framesInside && fit.framesUnderTabs, JSON.stringify(fit));
}
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await waitFor("false", 300);
await screenshot("dock-fit.png");

// --- 5d. A selected shot (Cut, Draw rail, the camera bar) still fits one row --
await evaluate(`window.__cozyclay.runStudioAction("shot.create")`);
await evaluate("[...document.querySelectorAll('.tl-track.shots .tl-shot-label')][0]?.click()");
expect("a shot is selected and the camera bar shows", await waitFor("!!document.querySelector('.tl-camera-editor')?.getClientRects().length && !!document.querySelector('.tl-seq-action.cut')"));
for (const [width, height] of [[1920, 1080], [1600, 960], [1440, 900], [1280, 800], [1180, 760]]) {
	await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
	await waitFor("false", 400);
	const fit = await evaluate(`(() => {
		const hit = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
		const head = document.querySelector('.tl-head'), editor = document.querySelector('.tl-camera-editor');
		const dock = document.querySelector('.studio-dock-slot').getBoundingClientRect();
		const scroller = document.querySelector('.bottom-timeline');
		const groups = [...head.children].filter((node) => node.getClientRects().length && getComputedStyle(node).position !== 'absolute');
		const frames = document.querySelector('.pose-key-bar label')?.getBoundingClientRect();
		const bar = [...editor.children].filter((node) => node.getClientRects().length && node.getBoundingClientRect().width > 0).map((node) => node.getBoundingClientRect());
		const crane = [...document.querySelectorAll('.tl-track-chip')].find((node) => node.textContent.trim() === 'Crane')?.getBoundingClientRect();
		const shots = document.querySelector('.tl-track.shots')?.getBoundingClientRect();
		return {
			headRows: new Set(groups.map((node) => Math.round(node.getBoundingClientRect().top))).size,
			headHeight: Math.round(head.getBoundingClientRect().height),
			headOver: head.scrollWidth - head.clientWidth,
			barOver: editor.scrollWidth - editor.clientWidth,
			scrolled: scroller.scrollTop,
			lanesInside: !!crane && crane.bottom <= dock.bottom && !!shots && shots.bottom <= dock.bottom + 1,
			framesClear: !!frames && !bar.some((box) => hit(frames, box)) && ![...document.querySelectorAll('.tl-tick, .tl-track-chip')].some((node) => hit(frames, node.getBoundingClientRect())),
			addTrack: !!document.querySelector('.tl-seq-action:not(.cut):not(.rail)')?.getClientRects().length,
		};
	})()`);
	expect(`with a shot selected at ${width}px: one 48px head row, nothing clipped, every lane on screen`, fit.headRows === 1 && fit.headHeight === 48 && fit.headOver <= 0 && fit.barOver <= 0 && fit.scrolled === 0 && fit.lanesInside && fit.framesClear && fit.addTrack, JSON.stringify(fit));
	if (width === 1440 || width === 1180) await screenshot(`dock-shot-${width}.png`);
}
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evaluate("window.__cozyclay.undo?.() ?? null");

// --- 6. Camera Transform -------------------------------------------------------
await click(".hierarchy-row-wrap[data-node-id=camera] button");
expect("selecting the camera shows a Transform section", await waitFor("!!document.querySelector('[data-testid=camera-transform]')"), await evaluate("document.querySelector('.studio-right-column')?.textContent.slice(0, 120)"));
const rows = await evaluate("[...document.querySelectorAll('[data-testid=camera-transform] .vec3-label')].map((node) => node.textContent)");
expect("it has Position and Rotation rows", JSON.stringify(rows) === JSON.stringify(["Position", "Rotation"]), JSON.stringify(rows));
// Selecting the camera switches to Camera mode; let that settle before typing.
await waitFor("false", 1200);
const yawBefore = await evaluate("Number(document.querySelectorAll('[data-testid=camera-transform] .vec3-row')[1].querySelectorAll('input')[1].value)");
await evaluate(`(() => {
	const input = document.querySelectorAll('[data-testid=camera-transform] .vec3-row')[1].querySelectorAll('input')[1];
	input.focus();
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(${JSON.stringify(yawBefore)} + 30));
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	input.blur();
})()`);
await waitFor(`Math.abs(Number(document.querySelectorAll('[data-testid=camera-transform] .vec3-row')[1].querySelectorAll('input')[1].value) - ${yawBefore} - 30) < 0.6`, 3000);
const yawAfter = await evaluate("Number(document.querySelectorAll('[data-testid=camera-transform] .vec3-row')[1].querySelectorAll('input')[1].value)");
expect("typing a Rotation Y turns the shot camera", Math.abs(yawAfter - yawBefore - 30) < 0.6, JSON.stringify({ yawBefore, yawAfter, look: await evaluate("document.querySelector('.app')?.dataset.workflowMode + ' ' + !!document.querySelector('.v2-start-screen')"), values: await evaluate("[...document.querySelectorAll('[data-testid=camera-transform] input')].map((node) => node.value)") }));
const editField = async (rowIndex, axisIndex, delta) => evaluate(`(async () => {
	const field = () => document.querySelectorAll('[data-testid=camera-transform] .vec3-row')[${rowIndex}].querySelectorAll('input')[${axisIndex}];
	const before = Number(field().value);
	const input = field();
	input.focus();
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(before + ${delta}));
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	input.blur();
	await new Promise((resolve) => setTimeout(resolve, 600));
	return { before, after: Number(field().value) };
})()`);
const moved = await editField(0, 0, 1);
expect("typing a Position X moves the shot camera", Math.abs(moved.after - moved.before - 1) < 0.02, JSON.stringify(moved));
const tilted = await editField(1, 0, -10);
expect("typing a Rotation X tilts the shot camera", Math.abs(tilted.after - tilted.before + 10) < 0.6, JSON.stringify(tilted));
expect("the roll field is read-only", await evaluate("document.querySelectorAll('[data-testid=camera-transform] .vec3-row')[1].querySelectorAll('input')[2].disabled"));
await screenshot("camera-transform.png");

// One top row 8px inside the stage frame: toggle, modes, menus, then the rail.
const row = await evaluate(`(() => { const r = (s) => document.querySelector(s)?.getBoundingClientRect(); const t = r(".shell-left-toggle"), m = r(".v2-topbar .menubar"), v = r(".vp-mode-toolbar"), rail = r(".vp-overlay-rail"), dock = r(".studio-dock-slot"); return { tops: [t?.top, m?.top, v?.top, rail?.top].map(Math.round), menuRight: Math.round(m?.right), railLeft: Math.round(rail?.left), railRight: Math.round(rail?.right), dockRight: Math.round(dock?.right), gap: getComputedStyle(document.querySelector(".app")).getPropertyValue("--shell-gap").trim(), radius: getComputedStyle(document.querySelector(".v2-dock")).borderRadius }; })()`);
expect("the top row shares one top line", new Set(row.tops).size === 1, JSON.stringify(row));
expect("the menus sit just left of the rail", row.menuRight < row.railLeft && row.railLeft - row.menuRight <= 8, JSON.stringify(row));
expect("panels use a 3px gap and 10px corners", row.gap === "3px" && row.radius === "10px", JSON.stringify(row));

// Wheel over a camera-bar number field steps it by its own step.
await click(".tl-track.shots .tl-shot-block");
await waitFor("document.querySelector(\".tl-camera-editor input[type='number']\")", 5000);
const field = await evaluate(`(() => { const i = document.querySelector(".tl-camera-editor input[type='number']"); const r = i.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, value: Number(i.value), step: Number(i.step) }; })()`);
await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: field.x, y: field.y, deltaX: 0, deltaY: -40 });
await new Promise((resolve) => setTimeout(resolve, 400));
const wheeled = await evaluate("Number(document.querySelector(\".tl-camera-editor input[type='number']\").value)");
expect("wheel up over Speed raises it one step", Math.abs(wheeled - field.value - field.step) < 1e-6, JSON.stringify({ ...field, wheeled }));
await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: field.x, y: field.y, deltaX: 0, deltaY: 40 });
await new Promise((resolve) => setTimeout(resolve, 400));
expect("wheel down lowers it back", Math.abs(await evaluate("Number(document.querySelector(\".tl-camera-editor input[type='number']\").value)") - field.value) < 1e-6);

// The agent composer keeps its controls on one row.
await click(".studio-agent-bar");
await waitFor("document.querySelector('.studio-agent-inspector .agent-composer-controls')?.getBoundingClientRect().height > 0", 5000);
const composer = await evaluate(`(() => { const c = document.querySelector(".studio-agent-inspector .agent-composer-controls"); if (!c || !c.getBoundingClientRect().height) return null; const tops = [...c.children].filter((k) => k.getBoundingClientRect().width > 0).map((k) => Math.round(k.getBoundingClientRect().top + k.getBoundingClientRect().height / 2)); const t = document.querySelector(".agent-tasks-toggle"), had = t.classList.contains("is-on"); t.classList.add("is-on"); const on = getComputedStyle(t).backgroundColor; t.classList.remove("is-on"); const off = getComputedStyle(t).backgroundColor; t.classList.toggle("is-on", had); return { tops, toggle: t.getBoundingClientRect().width, on, off }; })()`);
expect("the agent composer controls fit one row", composer && Math.max(...composer.tops) - Math.min(...composer.tops) <= 2 && composer.toggle <= 26, JSON.stringify(composer)); expect("Task mode on is a solid disc, off has no fill", /^rgb\(/.test(composer?.on) && composer?.off === "rgba(0, 0, 0, 0)", JSON.stringify(composer));

// The tool rail: 24px cells that never overlap, 13px glyphs, snap is icon-only.
await click(".vp-mode-key");
const railCells = await evaluate(`(() => { const rail = document.querySelector(".vp-overlay-rail"); const cells = [...rail.querySelectorAll("button, .vp-speed")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.getBoundingClientRect()); const snap = rail.querySelector(".vp-snap-value"); return { overlaps: cells.slice(1).filter((c, i) => c.top < cells[i].bottom - 0.5).length, icons: Math.max(...[...rail.querySelectorAll(".vp-icon")].map((i) => i.getBoundingClientRect().width)), snapFont: snap ? getComputedStyle(snap).fontSize : "0px" }; })()`);
expect("rail cells do not overlap", railCells.overlaps === 0, JSON.stringify(railCells));
expect("rail glyphs are at most 13px", railCells.icons <= 13, JSON.stringify(railCells));
expect("the snap cell shows only its icon", railCells.snapFont === "0px", JSON.stringify(railCells));
const snapInset = await evaluate(`(() => { const b = document.querySelector("[data-testid=snap-toggle]")?.getBoundingClientRect(); const i = document.querySelector("[data-testid=snap-toggle] .vp-icon")?.getBoundingClientRect(); return b && i ? [i.top - b.top, b.bottom - i.bottom, i.left - b.left, b.right - i.right].map((v) => Math.round(v * 2) / 2) : null; })()`);
expect("the snap glyph sits centred in its round cell", snapInset && Math.max(...snapInset) - Math.min(...snapInset) <= 0.5, JSON.stringify(snapInset));

ws.close();
if (failures > 0) {
	console.error(`\n${failures} studio polish check(s) failed`);
	process.exit(1);
}
console.log("\nAll studio polish checks passed");
