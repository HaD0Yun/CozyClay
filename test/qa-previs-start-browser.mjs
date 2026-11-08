#!/usr/bin/env node
// Browser QA for the start screen's project defaults (#649, #654). The start
// screen offers no mode or cast picker: every new project is an Animation
// project with the Hybrid cast, and both survive a reload. No URL flag is needed.
// Run through tools/qa-browser.mjs with QA_URL pointing at `/app/`.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCENES_STORAGE_KEY, PREVIOUS_SCENES_STORAGE_KEY } from "../src/scenes.js";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/Users/yun/CozyClay/.omo/evidence/previs-modes/previs-modes-r1/shots";
const SESSION_KEY = "cozyclay.project-session.v1";
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
const session = () => evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(SESSION_KEY)}) || "null")`);
const castStyle = () => evaluate("window.__cozyclayProject.export('qa').then((text) => JSON.parse(text).castStyle)");
const noPicker = "!document.querySelector('[data-testid=start-previs-mode]') && !document.querySelector('[data-testid=start-cast-style]')";
// Fresh first launch: no project session, no scenes.
const firstLaunch = async () => {
	await evaluate(`(() => {
		localStorage.removeItem(${JSON.stringify(SESSION_KEY)});
		localStorage.removeItem("${SCENES_STORAGE_KEY}");
		localStorage.removeItem("${PREVIOUS_SCENES_STORAGE_KEY}");
	})()`);
	await reload();
};
const editorOpen = "!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline')";

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await firstLaunch();

// --- First launch: name + Create only ----------------------------------------
expect("the start screen renders", await waitFor("!!document.querySelector('.v2-start-screen.startup [data-testid=start-create]')"));
expect("the start screen offers no mode or cast picker", await evaluate(noPicker));
expect("the start screen offers Open a saved project", await evaluate("!!document.querySelector('[data-testid=start-open-project-card]')"));
await setTheme("dark");
await screenshot("start-simple-dark.png");
await setTheme("light");
await screenshot("start-simple-light.png");

// The theme switches above re-render the screen; type only once it has settled,
// and press Create only once the typed name is in the field.
await waitFor("false", 300);
await setInput('[data-testid="start-project-name"]', "qa649_first");
expect("the typed name is in the field", await waitFor("document.querySelector('[data-testid=start-project-name]')?.value === 'qa649_first'"));
await click("[data-testid=start-create]");
expect("Create opens the editor", await waitFor(editorOpen));
const firstSession = await session();
expect("the new project is an animation project", firstSession?.name === "qa649_first" && firstSession?.previsMode === "animation", JSON.stringify(firstSession));
expect("the new project casts Hybrid", (await castStyle()) === "hybrid");

await reload();
expect("reload reopens the editor", await waitFor(editorOpen));
await evaluate("window.__cozyclay.sceneObject.place({ kind: 'cube', x: 0, z: 0 })");
expect("an edit after reload lands", await waitFor("!!document.querySelector('.project-dirty-dot')"));
const reloadedSession = await session();
expect("reload keeps previsMode animation", reloadedSession?.name === "qa649_first" && reloadedSession?.previsMode === "animation", JSON.stringify(reloadedSession));
expect("reload keeps the Hybrid cast", (await castStyle()) === "hybrid");

// --- File > New: same screen, same defaults ----------------------------------
await evaluate("window.confirm = () => true");
await click("[data-testid=menu-file]");
expect("File shows New", await waitFor("!!document.querySelector('[data-testid=menubar-new]')"));
await click("[data-testid=menubar-new]");
expect("File > New reuses the start screen", await waitFor("!!document.querySelector('.v2-start-screen [data-testid=start-create]')"));
expect("File > New offers no mode or cast picker", await evaluate(noPicker));
await setInput('[data-testid="start-project-name"]', "qa649_animation");
expect("the name is entered", await waitFor("document.querySelector('[data-testid=start-project-name]')?.value === 'qa649_animation'"));
await click("[data-testid=start-create]");
const animationOpened = await waitFor(`${editorOpen} && (document.querySelector('.project-menu-trigger')?.textContent || '').includes('qa649_animation')`, 30000);
expect("the project opens in the editor", animationOpened, await evaluate("JSON.stringify({ start: !!document.querySelector('.v2-start-screen'), menu: document.querySelector('.project-menu-trigger')?.textContent, toast: document.querySelector('[role=status]')?.textContent, name: document.querySelector('[data-testid=start-project-name]')?.value })"));
const animationSession = await session();
expect("the File > New project is an animation project", animationSession?.name === "qa649_animation" && animationSession?.previsMode === "animation", JSON.stringify(animationSession));
expect("the File > New project casts Hybrid", (await castStyle()) === "hybrid");

ws.close();
if (failures > 0) {
	console.error(`\n${failures} previs start-screen check(s) failed`);
	process.exit(1);
}
console.log("\nAll previs start-screen checks passed");
