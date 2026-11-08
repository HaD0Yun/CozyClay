#!/usr/bin/env node
// Browser QA for the start screen's Recent work list. Seeds three projects in
// the origin-private file system (granted handles, so Open really reads them),
// then checks select -> preview, search, arrow keys, Open and Remove.
// Run through tools/qa-browser.mjs with QA_URL pointing at `/app/`.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || join(process.cwd(), ".omo/evidence/recent-work");
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
const setTheme = async (theme) => {
	await evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.dispatchEvent(new CustomEvent("cozyclay:theme-change", { detail: ${JSON.stringify(theme)} })); })()`);
	await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
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
const keyOn = (selector, key) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.focus(); node.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true })); return true; })()`);
const selectedKey = () => evaluate("document.querySelector('.v2-start-work-row[aria-selected=true]')?.dataset.recentKey ?? null");
const rowNames = () => evaluate("[...document.querySelectorAll('.v2-start-work-row strong')].map((node) => node.textContent)");

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

// --- Empty: the list sketches where projects will land ---------------------
await evaluate(`(async () => {
	localStorage.removeItem("cozyclay.project-session.v1");
	for (const name of ["cozyclay.project-handle.v1", "cozyclay.project-thumbs.v1"]) await new Promise((resolve) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); });
})()`);
await reload();
expect("the start screen renders", await waitFor("!!document.querySelector('.v2-start-screen.startup [data-testid=start-recent-work]')"));
expect("an empty list shows the placeholder rows and Open a project file", await waitFor("document.querySelectorAll('.v2-start-work-ghosts span').length === 3 && !!document.querySelector('.v2-start-work-empty .v2-start-empty-open')"));
expect("an empty list has no search box", await evaluate("!document.querySelector('[data-testid=start-recent-search]')"));

// --- Seed three projects, newest first -------------------------------------
await evaluate(`(async () => {
	const base = JSON.parse(await window.__cozyclayProject.export("seed"));
	const root = await navigator.storage.getDirectory();
	const now = Date.now();
	const demos = [["alley_chase", 25 * 60e3, { scenes: 3, shots: 12, previsMode: "animation", castStyle: "hybrid" }], ["rooftop_fight", 5 * 3600e3, { scenes: 2, shots: 7, previsMode: "animation", castStyle: "rig" }], ["cafe_board", 2 * 86400e3, null]];
	const recents = [];
	for (const [name, ago, summary] of demos) {
		const handle = await root.getFileHandle(name + ".cclayproject", { create: true });
		const writable = await handle.createWritable();
		await writable.write(JSON.stringify({ ...base, name }));
		await writable.close();
		recents.push({ handle, name, openedAt: now - ago, ...summary });
	}
	const db = await new Promise((resolve, reject) => { const request = indexedDB.open("cozyclay.project-handle.v1", 1); request.onupgradeneeded = () => request.result.createObjectStore("kv"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
	await new Promise((resolve) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(recents, "recentProjects"); tx.oncomplete = resolve; });
	db.close();
})()`);
await reload();
expect("the list shows the three projects newest first", await waitFor("document.querySelectorAll('.v2-start-work-row').length === 3"), JSON.stringify(await rowNames()));
expect("rows are in recents order", JSON.stringify(await rowNames()) === JSON.stringify(["alley_chase", "rooftop_fight", "cafe_board"]), JSON.stringify(await rowNames()));
expect("the count badge reads 3", (await evaluate("document.querySelector('.v2-start-work-title small')?.textContent")) === "3");
expect("a stored summary shows scenes and shots", /3 scenes · 12 shots · Animation/.test(await evaluate("document.querySelector('[data-recent-key=recent-alley_chase] .v2-start-work-copy span')?.textContent || ''")));
expect("a record without a summary is read from its file (one scene, no shots)", await waitFor("/^1 scene · 0 shots/.test(document.querySelector('[data-recent-key=recent-cafe_board] .v2-start-work-copy span')?.textContent || '')"));
expect("relative time reads minutes ago", /minute/.test(await evaluate("document.querySelector('[data-recent-key=recent-alley_chase] time')?.textContent || ''")));
await screenshot("recent-work-list-light.png");

// --- Select -> preview -------------------------------------------------------
await click("[data-recent-key=recent-rooftop_fight]");
expect("a click selects the row", await waitFor("document.querySelector('[data-recent-key=recent-rooftop_fight]')?.getAttribute('aria-selected') === 'true'"));
expect("the preview describes the selected project", await waitFor("(document.querySelector('[data-testid=start-recent-preview]')?.textContent || '').includes('rooftop_fight')"));
expect("a project never opened here shows the no-preview tile, not the template render", await evaluate("!!document.querySelector('[data-testid=start-recent-noart]') && !document.querySelector('[data-testid=start-recent-thumb]')"));
expect("the preview names the cast", (await evaluate("document.querySelector('[data-testid=start-recent-preview]')?.textContent || ''")).includes("Humanoid"));
expect("the create form is out of the preview while a project is selected", await evaluate("!document.querySelector('[data-testid=start-create]')"));
expect("the + card is no longer marked selected", await evaluate("!document.querySelector('[data-testid=start-new-project-card].selected')"));
await setTheme("dark");
await screenshot("recent-work-selected-dark.png");
await setTheme("light");

// --- Arrow keys ---------------------------------------------------------------
await keyOn(".v2-start-work-list", "ArrowDown");
expect("ArrowDown moves to the next project", await waitFor("document.querySelector('.v2-start-work-row[aria-selected=true]')?.dataset.recentKey === 'recent-cafe_board'"), await selectedKey());
await keyOn(".v2-start-work-list", "ArrowDown");
expect("ArrowDown stops at the last project", (await selectedKey()) === "recent-cafe_board");
await keyOn(".v2-start-work-list", "ArrowUp");
expect("ArrowUp moves back", await waitFor("document.querySelector('.v2-start-work-row[aria-selected=true]')?.dataset.recentKey === 'recent-rooftop_fight'"), await selectedKey());

// --- Search -------------------------------------------------------------------
await setInput("[data-testid=start-recent-search]", "CAFE");
expect("search filters case-insensitively", await waitFor("document.querySelectorAll('.v2-start-work-row').length === 1"), JSON.stringify(await rowNames()));
expect("the match is highlighted", (await evaluate("document.querySelector('.v2-start-work-row mark')?.textContent")) === "cafe");
await setInput("[data-testid=start-recent-search]", "zzz");
expect("no match says so", await waitFor("!!document.querySelector('.v2-start-work-none')"));
await setInput("[data-testid=start-recent-search]", "");
expect("clearing the search restores the list", await waitFor("document.querySelectorAll('.v2-start-work-row').length === 3"));

// --- New instead returns the create form -----------------------------------
await evaluate("[...document.querySelectorAll('[data-testid=start-recent-preview] button')].find((node) => /New instead/.test(node.textContent))?.click()");
expect("New instead brings back the create form", await waitFor("!!document.querySelector('[data-testid=start-create]') && !document.querySelector('[data-testid=start-recent-preview]')"));

// --- Remove -------------------------------------------------------------------
await click("[data-recent-key=recent-cafe_board]");
await waitFor("document.querySelector('[data-recent-key=recent-cafe_board]')?.getAttribute('aria-selected') === 'true'");
await keyOn(".v2-start-work-list", "Delete");
expect("Delete forgets the selected recent", await waitFor("document.querySelectorAll('.v2-start-work-row').length === 2 && !document.querySelector('[data-recent-key=recent-cafe_board]')"), JSON.stringify(await rowNames()));
expect("the preview falls back to the create form", await waitFor("!!document.querySelector('[data-testid=start-create]')"));

// --- Open ---------------------------------------------------------------------
await click("[data-recent-key=recent-rooftop_fight]");
await waitFor("!!document.querySelector('[data-testid=start-open-recent]')");
await click("[data-testid=start-open-recent]");
expect("Open loads the project in the editor", await waitFor("!document.querySelector('.v2-start-screen') && (document.querySelector('.project-menu-trigger')?.textContent || '').includes('rooftop_fight')", 30000), await evaluate("document.querySelector('.project-menu-trigger')?.textContent || document.querySelector('[role=status]')?.textContent"));
const reopened = await evaluate(`new Promise((resolve) => { const request = indexedDB.open("cozyclay.project-handle.v1", 1); request.onsuccess = () => { const tx = request.result.transaction("kv", "readonly"); const get = tx.objectStore("kv").get("recentProjects"); get.onsuccess = () => resolve(get.result.map((entry) => ({ name: entry.name, scenes: entry.scenes }))); }; })`);
expect("opening moves the project to the top of the recents with its summary", reopened[0]?.name === "rooftop_fight" && Number.isFinite(reopened[0]?.scenes), JSON.stringify(reopened));

// --- The opened project's stage becomes its picture ------------------------
await evaluate("window.__cozyclay.sceneObject.place({ kind: 'cube', x: 0, z: 0 })");
await evaluate("window.__cozyclay.runStudioAction('project.save')");
const readThumbSize = () => evaluate(`new Promise((resolve) => { const request = indexedDB.open("cozyclay.project-thumbs.v1", 1); request.onupgradeneeded = () => request.result.createObjectStore("thumbs"); request.onsuccess = () => { const get = request.result.transaction("thumbs", "readonly").objectStore("thumbs").get("rooftop_fight"); get.onsuccess = () => resolve(get.result ? get.result.size : 0); get.onerror = () => resolve(-1); }; })`);
// The picture is written just after the save resolves, so poll for it.
let thumbSize = 0;
for (let tries = 0; tries < 50 && thumbSize <= 1000; tries += 1) {
	thumbSize = await readThumbSize();
	if (thumbSize <= 1000) await new Promise((resolve) => setTimeout(resolve, 100));
}
expect("save stores a picture of the stage", thumbSize > 1000, String(thumbSize));
await evaluate("document.querySelector('.project-menu-trigger').click()");
await waitFor("document.querySelectorAll('.project-menu [role=menuitem]').length > 1");
await evaluate("document.querySelectorAll('.project-menu [role=menuitem]')[1].click()");
expect("the start screen reopens over the project", await waitFor("!!document.querySelector('[data-recent-key=recent-rooftop_fight]')"));
expect("its row shows the picture", await waitFor("!!document.querySelector('[data-recent-key=recent-rooftop_fight] .v2-start-work-badge img')"));
await click("[data-recent-key=recent-rooftop_fight]");
expect("selecting it puts its own stage in the preview", await waitFor("document.querySelector('[data-testid=start-recent-thumb]')?.naturalWidth === 480"));
expect("the saved summary counts its scene", /^1 scene/.test(await evaluate("document.querySelector('[data-recent-key=recent-rooftop_fight] .v2-start-work-copy span')?.textContent || ''")));
await screenshot("recent-work-thumb-light.png");

ws.close();
if (failures > 0) {
	console.error(`\n${failures} recent work check(s) failed`);
	process.exit(1);
}
console.log("\nAll recent work checks passed");
