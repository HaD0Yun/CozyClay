#!/usr/bin/env node
// Browser QA for the v2 Preferences dialog (#532 / todo 18).
//
// Run against the full dev server, not bare Vite:
//   QA_URL=http://127.0.0.1:5532/app/ \
//   CDP_PORT=9532 QA_OUT=/Users/yun/CClineFix/.omo/evidence/cozyclay-ui-overhaul \
//   node tools/qa-browser.mjs -- node test/qa-shell-preferences-browser.mjs

import { mkdir, writeFile } from "node:fs/promises";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/tmp/cozyclay-qa-preferences";
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
const consoleErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params?.exceptionDetails?.exception?.description || "runtime exception");
	if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
		consoleErrors.push(message.params.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ") || "console.error");
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
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const waitEvent = (method, timeoutMs = 30000) => new Promise((resolve, reject) => {
	const timer = setTimeout(() => {
		ws.removeEventListener("message", onMessage);
		reject(new Error(`timed out waiting for ${method}`));
	}, timeoutMs);
	const onMessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.method !== method) return;
		clearTimeout(timer);
		ws.removeEventListener("message", onMessage);
		resolve(message.params);
	};
	ws.addEventListener("message", onMessage);
});

// Subscribe to a concrete DOM state before triggering the action. React commits
// and observer mutations, rather than sleeps, decide when the action settled.
let waiterId = 0;
const waitForDom = async (expression, timeoutMs = 15000) => {
	const key = `__qaPreferencesWait${waiterId++}`;
	await evaluate(`(() => {
		window.${key} = new Promise((resolve) => {
			const ready = () => Boolean(${expression});
			if (ready()) { resolve(true); return; }
			const observer = new MutationObserver(() => {
				if (!ready()) return;
				observer.disconnect(); clearTimeout(timer); resolve(true);
			});
			observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
			const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, ${timeoutMs});
		});
	})()`);
	const result = await evaluate(`window.${key}`);
	if (!result) throw new Error(`timed out waiting for DOM state: ${expression}`);
	return result;
};
const reload = async () => {
	const loaded = waitEvent("Page.loadEventFired");
	await send("Page.reload", { ignoreCache: false });
	await loaded;
	await waitForDom("!!document.querySelector('.settings-menu-trigger')", 30000);
};
const clickAndWait = async (selector, expression, timeoutMs = 15000) => {
	const settled = waitForDom(expression, timeoutMs);
	await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
	await settled;
};
const clickTextAndWait = async (selector, text, expression, timeoutMs = 15000) => {
	const settled = waitForDom(expression, timeoutMs);
	await evaluate(`([...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.textContent.trim() === ${JSON.stringify(text)}))?.click()`);
	await settled;
};
const pressEscape = async () => {
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
};
const screenshot = async (name) => {
	const result = await send("Page.captureScreenshot", { format: "png" });
	await mkdir(out, { recursive: true });
	await writeFile(`${out}/${name}`, Buffer.from(result.data, "base64"));
	return `${out}/${name}`;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await waitForDom("!!document.querySelector('.settings-menu-trigger')", 30000);
await evaluate(`(() => {
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.analyticsOptOut", "0");
	localStorage.removeItem("cozyclay.preferences.invert-y.v1");
	for (const key of Object.keys(localStorage)) if (key.startsWith("ph_")) localStorage.removeItem(key);
})()`);
await reload();

const trigger = "[data-testid=\"settings-menu-trigger\"]";
const dialog = ".v2-preferences__dialog";
const nav = "[data-testid=\"preferences-nav-item\"]";

expect("the Settings trigger is present", await evaluate(`!!document.querySelector(${JSON.stringify(trigger)})`));
expect("the dialog starts closed", !(await evaluate(`!!document.querySelector(${JSON.stringify(dialog)})`)));
await clickAndWait(trigger, `!!document.querySelector(${JSON.stringify(dialog)})`);
expect("opening via the Settings trigger shows the Preferences dialog", await evaluate(`document.querySelector(${JSON.stringify(dialog)})?.getAttribute("role") === "dialog"`));
expect("the dialog is modal", await evaluate(`document.querySelector(${JSON.stringify(dialog)})?.getAttribute("aria-modal") === "true"`));

const expectedNav = ["Appearance", "Viewport", "Export", "Hotkeys"];
const actualNav = await evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(nav)})].map((item) => item.textContent.trim()))`);
expect("the Preferences nav labels match the 2c list exactly", actualNav === JSON.stringify(expectedNav), actualNav);
expect(
	"the dialog contains no provider-specific legacy names",
	await evaluate(`!/Kimodo|ProjFlow/i.test(document.querySelector(${JSON.stringify(dialog)})?.textContent || "")`),
);

const closeState = waitForDom(`!document.querySelector(${JSON.stringify(dialog)})`);
await pressEscape();
await closeState;
expect("Escape closes the Preferences dialog", !(await evaluate(`!!document.querySelector(${JSON.stringify(dialog)})`)));
// #548: the 2a top bar opens Preferences from Edit › Preferences…; the
// Settings trigger stays mounted as the dialog's programmatic handle but is
// not shown, so focus returns to the visible opener, the Edit menu trigger.
expect("the Settings trigger is not part of the 2a top bar", await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(trigger)})?.getBoundingClientRect(); return !r || r.width < 1 || r.height < 1; })()`));
expect("Escape returns focus to the Edit menu trigger", await evaluate(`document.activeElement === document.querySelector('[data-testid=menu-edit]')`));

// Switching locale reloads the real page. Check the dialog's own labels, not
// the mode toolbar, which belongs to the parallel shell toolbar change.
await clickAndWait(trigger, `!!document.querySelector(${JSON.stringify(dialog)})`);
const koreanReload = waitEvent("Page.loadEventFired");
await evaluate(`document.querySelector('[data-testid="settings-locale-ko"]')?.click()`);
await koreanReload;
await waitForDom(`!!document.querySelector(${JSON.stringify(trigger)})`, 30000);
await clickAndWait(trigger, `!!document.querySelector(${JSON.stringify(dialog)})`);
const koreanTitle = await evaluate(`document.querySelector('.v2-preferences__nav-title')?.textContent.trim()`);
const koreanNav = await evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(nav)})].map((item) => item.textContent.trim()))`);
expect("switching language changes the dialog title", koreanTitle === "환경설정", koreanTitle || "missing");
expect("switching language changes the dialog nav labels", koreanNav.includes("입력 및 카메라") && !koreanNav.includes("Input & Camera"), koreanNav);
await pressEscape();
await waitForDom(`!document.querySelector(${JSON.stringify(dialog)})`);
await evaluate(`localStorage.setItem("cozyclay.locale", "en")`);
await reload();

// Invert Y is a viewer preference: author it, reload the actual editor, and
// reopen Preferences to prove the stored state is read on a fresh mount.
await clickAndWait(trigger, `!!document.querySelector(${JSON.stringify(dialog)})`);
await clickTextAndWait(nav, "Input & Camera", `([...document.querySelectorAll(${JSON.stringify(nav)})].find((item) => item.textContent.trim() === "Input & Camera"))?.getAttribute("aria-current") === "page"`);
const invert = "[data-testid=\"preferences-invert-y\"]";
const invertFlip = waitForDom(`document.querySelector(${JSON.stringify(invert)})?.getAttribute("aria-pressed") === "true"`);
await evaluate(`document.querySelector(${JSON.stringify(invert)})?.click()`);
await invertFlip;
await pressEscape();
await waitForDom(`!document.querySelector(${JSON.stringify(dialog)})`);
await reload();
await clickAndWait(trigger, `!!document.querySelector(${JSON.stringify(dialog)})`);
await clickTextAndWait(nav, "Input & Camera", `([...document.querySelectorAll(${JSON.stringify(nav)})].find((item) => item.textContent.trim() === "Input & Camera"))?.getAttribute("aria-current") === "page"`);
expect("Invert Y persists after reload", await evaluate(`document.querySelector(${JSON.stringify(invert)})?.getAttribute("aria-pressed") === "true"`));

// Capture the reference-size Preferences surface after the functional checks.
await clickTextAndWait(nav, "Input & Camera", `([...document.querySelectorAll(${JSON.stringify(nav)})].find((item) => item.textContent.trim() === "Input & Camera"))?.getAttribute("aria-current") === "page"`);
const invertOff = waitForDom(`document.querySelector(${JSON.stringify(invert)})?.getAttribute("aria-pressed") === "false"`);
await evaluate(`document.querySelector(${JSON.stringify(invert)})?.click()`);
await invertOff;
const prefsPath = await screenshot("task-18-prefs.png");
console.log(`SCREENSHOT ${prefsPath}`);

expect("the browser emitted no page exceptions", pageErrors.length === 0, JSON.stringify(pageErrors));
expect("the browser emitted no console errors", consoleErrors.length === 0, JSON.stringify(consoleErrors));

ws.close();
if (failures) process.exit(1);
console.log("all v2 Preferences browser checks PASS — dialog, focus restore, privacy, locale, persistence and visual evidence");
