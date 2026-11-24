#!/usr/bin/env node
// export:menu_opened from real pointer and key input in the Studio.
// Start Vite separately, then:
//   QA_URL=http://127.0.0.1:5651/app/ CDP_PORT=5652 node tools/qa-browser.mjs -- node test/qa-export-menu-browser.mjs
// Only the SDK is a fake: the analytics module is served with a PROD environment and an
// in-memory SDK at the real track()/sanitizeProps() boundary. Steps on a two-shot scene:
// click File > Export (one event), click it again to close (none), click to reopen (one),
// Escape, then open it from the keyboard with ArrowRight on the trigger (one).
import assert from "node:assert/strict";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";
import { afterPageLoad } from "./bus/browser-navigation.mjs";
import { waitForFrameState } from "./bus/browser-frame-state.mjs";

const origin = new URL(process.env.QA_URL || "http://127.0.0.1:5651/app/").origin;
const port = Number(process.env.CDP_PORT || 5652);
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((target) => target.type === "page" && target.webSocketDebuggerUrl);
assert.ok(page, "QA Chrome must expose a page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map(), records = [], errors = [], recordSignal = new EventTarget();
const send = (method, params = {}) => afterPageLoad(ws, method, () => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }));
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); return; }
	if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (message.method === "Runtime.bindingCalled" && message.params.name === "__qaRecord") {
		const record = JSON.parse(message.params.payload);
		records.push(record);
		if (record.event === "export:menu_opened") recordSignal.dispatchEvent(new Event("opened"));
	}
	if (message.method === "Fetch.requestPaused") void (async () => {
		const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId: message.params.requestId });
		let source = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
		source = source.replace("return import.meta.env ?? {};", "return { PROD: true, VITE_POSTHOG_KEY: 'internal-qa-menu', VITE_POSTHOG_HOST: 'https://telemetry.invalid', VITE_POSTHOG_ALLOWED_ORIGINS: location.origin };");
		source = source.replace(/await import\([^)]*posthog[^)]*\)/g, "await Promise.resolve({ default: window.__qaPosthog })");
		await send("Fetch.fulfillRequest", { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(source).toString("base64") });
	})();
};
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
};
const waitFor = async (expression, label, ms = 60_000) => {
	if (!await waitForFrameState(evaluate, expression, ms)) throw new Error(`Timed out: ${label}`);
};
const actionable = (selector) => `(() => {
	const el = document.querySelector(${JSON.stringify(selector)});
	if (!el) return false;
	const r = el.getBoundingClientRect(), style = getComputedStyle(el);
	return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
		&& style.visibility !== "hidden" && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(${JSON.stringify(selector)}) === el;
})()`;
const openedSignal = () => new Promise((resolve) => recordSignal.addEventListener("opened", resolve, { once: true }));
const captured = async (signal) => {
	let timer;
	try { await Promise.race([signal, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Missing export:menu_opened within the existing 300 ms observation window")), 300); })]); }
	finally { clearTimeout(timer); }
};
const painted = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
const centre = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ' + ${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const press = async ({ x, y }) => {
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
};
const key = async (key, code, keyCode) => {
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
};
const flyoutOpen = "!!document.querySelector('[data-testid=export-keyframe-pack]')";
const flyoutReady = actionable("[data-testid=export-keyframe-pack]");
const opened = () => records.filter((record) => record.event === "export:menu_opened");
const shot = (id, startFrame, endFrame) => ({ id, name: id, startFrame, endFrame, camera: { mode: "keys" }, cameraKeys: [] });
const scene = { version: 4, activeSceneId: "qa-menu", scenes: [{ id: "qa-menu", name: "QA menu", objects: [], shotDocument: { version: 4, frameCount: 96, waypoints: [], shots: [shot("qa-shot-a", 0, 47), shot("qa-shot-b", 48, 95)] },
	stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "QA" }], hasCharSheet: false, shotAspect: "16:9" } }] };

try {
	await send("Page.enable"); await send("Runtime.enable");
	await send("Runtime.addBinding", { name: "__qaRecord" });
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/src/analytics.js*", requestStage: "Response" }] });
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `if (window === window.top) { localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded'); localStorage.setItem('cozyclay.locale', 'en');
		localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'QA', updatedAt: Date.now() })); localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(scene))}); }
		let beforeSend; window.__qaPosthog = { init(_key, options) { beforeSend = options.before_send; }, register() {}, opt_in_capturing() {}, opt_out_capturing() {},
			has_opted_out_capturing: () => false, get_distinct_id: () => 'internal-qa-menu', get_session_id: () => '0192f0d6-3a4b-7c2d-8e9f-abcdefabcdef',
			capture(event, properties = {}) { const payload = beforeSend({ event, properties: { ...properties } }); if (payload) window.__qaRecord(JSON.stringify(payload)); } };` });
	await send("Page.navigate", { url: `${origin}/app/` });
	await waitFor(`${actionable("[data-testid=menu-file]")} && !!window.__cozyclay && document.fonts.status === "loaded"`, "Studio with the File menu", 120_000);
	const webcodecs = await evaluate("typeof VideoEncoder === 'function' && typeof VideoFrame === 'function'");
	const expected = { surface: "studio", mode: "animation", webcodecs, shots: "1-3" };
	assert.equal(opened().length, 0, "nothing before the menu opens");

	// 1. click File > Export: one event
	const fileReady = waitFor(actionable("#export-menu-trigger"), "File menu");
	await press(await centre("[data-testid=menu-file]"));
	await fileReady;
	const firstOpened = openedSignal(), firstReady = waitFor(flyoutReady, "Export flyout by click");
	await press(await centre("#export-menu-trigger"));
	await firstReady; await captured(firstOpened); await painted();
	assert.equal(opened().length, 1, "one event per click open");
	// 2. click the trigger again: the flyout closes, no event
	const closed = waitFor(`!${flyoutOpen}`, "Export flyout closed");
	await press(await centre("#export-menu-trigger"));
	await closed; await painted();
	assert.equal(opened().length, 1, "closing sends nothing");
	// 3. click to reopen: a second event
	const secondOpened = openedSignal(), reopened = waitFor(flyoutReady, "Export flyout reopened");
	await press(await centre("#export-menu-trigger"));
	await reopened; await captured(secondOpened); await painted();
	assert.equal(opened().length, 2, "reopening counts again");
	// 4. Escape, then the keyboard path: File, focus the trigger, ArrowRight
	const escaped = waitFor(`!${flyoutOpen}`, "menus closed by Escape");
	await key("Escape", "Escape", 27);
	await escaped;
	// Escape may leave File open with only the flyout closed; open File only when it is shut.
	if (!(await evaluate("!!document.querySelector('#export-menu-trigger')"))) {
		const fileAgain = waitFor(actionable("#export-menu-trigger"), "File menu again");
		await press(await centre("[data-testid=menu-file]")); await fileAgain;
	} else await waitFor(actionable("#export-menu-trigger"), "File menu again");
	await evaluate("document.querySelector('#export-menu-trigger').focus(), true");
	const thirdOpened = openedSignal(), keyboardReady = waitFor(flyoutReady, "Export flyout by ArrowRight");
	await key("ArrowRight", "ArrowRight", 39);
	await keyboardReady; await captured(thirdOpened); await painted();
	assert.equal(opened().length, 3, "the keyboard open counts once");
	await key("Escape", "Escape", 27);

	console.log("--- export:menu_opened payloads (global properties omitted)");
	for (const record of opened()) console.log(`  ${JSON.stringify(Object.fromEntries(Object.entries(record.properties).filter(([name]) => Object.hasOwn(expected, name))))}`);
	for (const record of opened()) {
		for (const [name, value] of Object.entries(expected)) assert.equal(record.properties[name], value, `export:menu_opened ${name}`);
		assert.ok(!JSON.stringify(record.properties).match(/qa-shot|QA menu/), "no shot ids or scene names");
	}
	assert.deepEqual(errors, [], "no uncaught page errors");
	console.log(`PASS qa-export-menu-browser: click, reopen and ArrowRight each send one export:menu_opened ${JSON.stringify(expected)}; closing sends none`);
} finally {
	ws.close();
}
