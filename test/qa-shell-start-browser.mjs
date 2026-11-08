#!/usr/bin/env node
// Visual and interaction QA for the v2 start screen at the owner's 2b size.
// Run through tools/qa-browser.mjs so Chrome and its temporary profile are
// always owned and cleaned up by the harness.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCENES_STORAGE_KEY, PREVIOUS_SCENES_STORAGE_KEY } from "../src/scenes.js";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/Users/yun/CClineFix/.omo/evidence/cozyclay-ui-overhaul";
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
		const message = JSON.parse(event.data);
		if (message.method === "Page.loadEventFired") finish();
	};
	const timer = setTimeout(() => finish(new Error("timed out waiting for the QA page to load")), timeoutMs);
	ws.addEventListener("message", onMessage);
});
const evaluate = async (expression) => {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
			return result.result.value;
		} catch (error) {
			if (!String(error?.message).includes("Execution context was destroyed") || attempt > 0) throw error;
			const loaded = waitForPageLoad();
			await send("Page.reload", { ignoreCache: true });
			await loaded;
		}
	}
};
await send("Page.enable");
// The harness seeds a project session, which skips the startup chooser this
// suite tests. Clear it itself so CI needs no extra env.
await evaluate(`(() => {
	localStorage.removeItem("cozyclay.project-session.v1");
	localStorage.removeItem("${SCENES_STORAGE_KEY}");
	localStorage.removeItem("${PREVIOUS_SCENES_STORAGE_KEY}");
})()`);
const loaded = waitForPageLoad();
await send("Page.reload", { ignoreCache: true });
await loaded;
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
	observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
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
	input.dispatchEvent(new Event("change", { bubbles: true }));
	return true;
})()`);

await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

expect("the 2b start screen renders", await waitFor("!!document.querySelector('.v2-start-screen.project-browser-backdrop.startup')"));
expect("the left navigation is 232px", (await evaluate("Math.round(document.querySelector('.v2-start-nav')?.getBoundingClientRect().width || 0)")) === 232);
expect("the right preview is 340px", (await evaluate("Math.round(document.querySelector('[data-testid=start-project-preview]')?.getBoundingClientRect().width || 0)")) === 340);
expect("the center has the v2 template grid", await waitFor("!!document.querySelector('.v2-start-template-grid')"));
expect("the preview exposes Name and Location", (await evaluate("[...document.querySelectorAll('.v2-start-field > span:not(.v2-start-select-wrap)')].map((node) => node.textContent.trim())")) .join("|") === "Name|Location");
await screenshot("task-17-start.png");

await setInput('[data-testid="start-project-name"]', "");
expect("an empty name disables Create", await waitFor("document.querySelector('[data-testid=start-create]')?.disabled === true"));
const emptyTitle = await evaluate("document.querySelector('[data-testid=start-create]')?.getAttribute('title') || ''");
expect("disabled Create explains the missing name", /name/i.test(emptyTitle), emptyTitle);
await setInput('[data-testid="start-project-name"]', "alley_chase_v2");
expect("the entered name re-enables Create", await waitFor("document.querySelector('[data-testid=start-create]')?.disabled === false"));
await screenshot("task-17-compare.png");

// The "+ New project" card is the one blank entry; the first-run guide belongs to it.
await evaluate("document.querySelector('[data-testid=start-new-project-card]').click()");
await setInput('[data-testid="start-project-name"]', "alley_chase_v2");
await evaluate("document.querySelector('[data-testid=start-create]').click()");
expect("Create opens the editor", await waitFor("!document.querySelector('.project-browser') && !!document.querySelector('.timeline')"));
const editorName = await evaluate("document.querySelector('.project-menu-trigger')?.textContent || ''");
expect("the editor shows alley_chase_v2", editorName.includes("alley_chase_v2"), editorName);

// The first-run tutorial no longer opens after Create.
await new Promise((resolve) => setTimeout(resolve, 1200));
expect("Create opens the studio without a tutorial pop-up", await evaluate("!document.querySelector('.v2-first-success-guide')"));

// #551: File › New opens the same 2b start screen as first launch, not the
// legacy Project name modal, and Create still asks before discarding work.
const fileNew = async () => {
	await evaluate("document.querySelector('[data-testid=menu-file]').click()");
	expect("File shows New", await waitFor("!!document.querySelector('[data-testid=menubar-new]')"));
	await evaluate("document.querySelector('[data-testid=menubar-new]').click()");
};
const confirmAnswer = (answer) => evaluate(`(() => {
	window.__qaConfirms = window.__qaConfirms || [];
	window.confirm = (message) => { window.__qaConfirms.push(String(message)); return ${answer ? "true" : "false"}; };
	return true;
})()`);
await confirmAnswer(false);
await fileNew();
expect("File › New shows the start screen's Create", await waitFor("!!document.querySelector('.v2-start-screen [data-testid=start-create]')"));
expect("File › New does not open the legacy Project name modal", await evaluate("!document.querySelector('.project-name-dialog-backdrop, .project-name-dialog')"));
await screenshot("task-21-file-new.png");
await evaluate("document.querySelector('.v2-start-cancel').click()");
expect("Cancel returns to the editor", await waitFor("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline')"));

await evaluate("window.__cozyclay.sceneObject.place({ kind: 'cube', x: 0, z: 0 })");
expect("placing an object leaves unsaved changes", await waitFor("!!document.querySelector('.project-dirty-dot')"));
await fileNew();
expect("File › New with unsaved work still shows the start screen", await waitFor("!!document.querySelector('.v2-start-screen [data-testid=start-create]')"));
await setInput('[data-testid="start-project-name"]', "issue551_fresh");
await evaluate("document.querySelector('[data-testid=start-create]').click()");
const refused = await evaluate("window.__qaConfirms.slice()");
expect("Create asks before discarding unsaved changes", refused.length === 1 && /unsaved/i.test(refused[0]), JSON.stringify(refused));
expect("declining keeps the start screen and the project", await evaluate("!!document.querySelector('.v2-start-screen') && !document.querySelector('.project-name-dialog') && document.querySelector('.project-menu-trigger')?.textContent.includes('alley_chase_v2')"));
await confirmAnswer(true);
await evaluate("document.querySelector('[data-testid=start-create]').click()");
expect("accepting creates the new project", await waitFor("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline') && (document.querySelector('.project-menu-trigger')?.textContent || '').includes('issue551_fresh')"));
expect("the discard confirmation ran once per Create", (await evaluate("window.__qaConfirms.length")) === 2);
await screenshot("task-21-file-new-created.png");

ws.close();
if (failures > 0) {
	console.error(`\n${failures} start-screen browser check(s) failed`);
	process.exit(1);
}
console.log("\nAll start-screen browser checks passed");
