#!/usr/bin/env node
// P2-b: shortcut:unbound, shortcut:ignored, search:no_results and nav:thrash from
// real key presses and clicks in the Studio, and nothing from keys typed into a
// text field or the agent composer.
// Start Vite separately; this runner neither starts a server nor owns Chrome.
// QA_URL=http://127.0.0.1:5351/app/ CDP_PORT=9551 node tools/qa-browser.mjs -- node test/qa-shortcut-friction-browser.mjs
// The CDP route on src/analytics.js changes only environment() and the SDK
// import: production track(), sanitizeProps() and before_send stay real. This
// is a sanitized SDK-boundary spy, NOT proof of PostHog wire delivery.
import assert from "node:assert/strict";

const origin = new URL(process.env.QA_URL || "http://127.0.0.1:5351/app/").origin;
const port = Number(process.env.CDP_PORT || 9551);
const timeoutMs = 60_000;
const OURS = /^(shortcut:|help:shortcuts_opened|search:no_results|nav:thrash|camera:thrash)/;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
assert.ok(page, "QA Chrome must expose a page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const listeners = new Map();
const captured = [];
const pageErrors = [];
const routeErrors = [];

ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id && pending.has(message.id)) {
		const item = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) item.reject(new Error(JSON.stringify(message.error)));
		else item.resolve(message.result);
		return;
	}
	if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (message.method === "Runtime.bindingCalled" && message.params.name === "__qaFrictionRecord") captured.push(JSON.parse(message.params.payload));
	for (const listener of listeners.get(message.method) || []) listener(message.params);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++nextId;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, ms = timeoutMs) {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (await predicate()) return; await sleep(100); }
	throw new Error(`Timed out: ${label}`);
}
const ours = () => captured.filter(({ event }) => OURS.test(event));
async function click(selector) {
	const box = await evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
		const rect = element.getBoundingClientRect();
		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	})()`);
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...box, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
}
// A real key press through the browser's input pipeline. modifiers: 2 = Ctrl.
async function press(code, key, keyCode, modifiers = 0) {
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", code, key, windowsVirtualKeyCode: keyCode, modifiers });
	await send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: keyCode, modifiers });
}
function log(line) { console.log(line); }

function installFixture() {
	localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded');
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	let beforeSend;
	window.__qaPosthog = {
		init(_key, options) { beforeSend = options.before_send; },
		register() {}, opt_in_capturing() {}, opt_out_capturing() {}, has_opted_out_capturing: () => false, get_distinct_id: () => "internal-qa-p2b",
		capture(event, properties = {}) {
			const payload = beforeSend({ event, properties: { ...properties } });
			if (payload) window.__qaFrictionRecord(JSON.stringify({ event: payload.event, properties: payload.properties, at: Date.now() }));
		},
	};
}

listeners.set("Fetch.requestPaused", new Set([(request) => {
	void (async () => {
		const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId: request.requestId });
		let source = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
		assert.equal((source.match(/return import\.meta\.env \?\? \{\};/g) || []).length, 1, "analytics environment seam changed");
		source = source.replace("return import.meta.env ?? {};", "return { PROD: true, VITE_POSTHOG_KEY: 'internal-qa-p2b', VITE_POSTHOG_HOST: 'https://telemetry.invalid', VITE_POSTHOG_ALLOWED_ORIGINS: location.origin };");
		const sdkImport = /await import\([^)]*posthog[^)]*\)/g;
		assert.equal((source.match(sdkImport) || []).length, 1, "analytics SDK import seam changed");
		source = source.replace(sdkImport, "await Promise.resolve({ default: window.__qaPosthog })");
		await send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(source).toString("base64") });
	})().catch((error) => routeErrors.push(error.message));
}]));

try {
	await send("Runtime.enable");
	await send("Page.enable");
	await send("Network.setCacheDisabled", { cacheDisabled: true });
	await send("Runtime.addBinding", { name: "__qaFrictionRecord" });
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/src/analytics.js*", requestStage: "Response" }] });
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installFixture.toString()})();` });
	await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	// The mock agent (src/workflow/agent-client.js) gives the panel a live composer without a sidecar.
	await send("Page.navigate", { url: `${origin}/app/?agent=mock&state=ready` });
	await until(() => captured.some(({ event }) => event === "$pageview"), "analytics ready ($pageview through the real sanitizer)");
	await until(() => evaluate("!!window.__cozyclay && !!document.querySelector('[data-testid=dock-tab-assets]')"), "Studio ready");
	await evaluate("document.activeElement?.blur?.(); true");
	log("PASS Studio ready, analytics routed through the real track()/before_send");

	// 1. An unbound combo: Ctrl+G (group) with focus on the page.
	await press("KeyG", "g", 71, 2);
	await until(() => ours().some(({ event }) => event === "shortcut:unbound"), "shortcut:unbound");
	// 2. An ignored shortcut: Ctrl+Z with an empty history.
	await press("KeyZ", "z", 90, 2);
	await until(() => ours().some(({ event }) => event === "shortcut:ignored"), "shortcut:ignored");
	assert.ok(await evaluate("document.body.innerText.includes('Nothing to undo')"), "the Studio's own 'Nothing to undo' notice showed");
	// 3. Five quick dock tab flips: animation -> assets -> animation -> assets -> animation -> assets.
	const flipsAt = Date.now();
	for (const tab of ["assets", "animation", "assets", "animation", "assets"]) { await click(`[data-testid=dock-tab-${tab}]`); await sleep(150); }
	// 4. A search with no result, typed for real into the Content browser search field.
	await click("[data-testid=content-search]");
	const beforeTyping = ours().length;
	for (const [code, key, keyCode] of [["KeyQ", "q", 81], ["KeyZ", "z", 90], ["KeyX", "x", 88], ["KeyJ", "j", 74]]) {
		await send("Input.dispatchKeyEvent", { type: "keyDown", code, key, text: key, windowsVirtualKeyCode: keyCode });
		await send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: keyCode });
	}
	assert.equal(await evaluate("document.querySelector('[data-testid=content-search]').value"), "qzxj");
	// Ctrl+A, Ctrl+G and Ctrl+Z inside the search field are text editing, not shortcuts.
	await press("KeyA", "a", 65, 2); await press("KeyG", "g", 71, 2); await press("KeyZ", "z", 90, 2);
	await sleep(400);
	assert.equal(ours().length, beforeTyping, "keys typed into the search field emit nothing");
	await until(() => ours().some(({ event }) => event === "search:no_results"), "search:no_results after 1 s stable");
	await until(() => ours().some(({ event }) => event === "nav:thrash"), "nav:thrash 10 s after the first flip", 15_000);
	log(`PASS nav:thrash ${((ours().find(({ event }) => event === "nav:thrash").at - flipsAt) / 1000).toFixed(1)} s after the first flip`);

	// 5. The agent composer: open the panel (Ctrl+B), then keys inside the composer.
	const beforeComposer = ours().length;
	await evaluate("document.activeElement?.blur?.(); true");
	await press("KeyB", "b", 66, 2);
	await until(() => evaluate("!!document.querySelector('textarea.agent-input')"), "agent composer shown");
	await until(() => evaluate("!!document.querySelector('textarea.agent-input') && !document.querySelector('textarea.agent-input').disabled"), "mock agent composer enabled");
	await click("textarea.agent-input");
	assert.ok(await evaluate("document.activeElement?.matches('textarea.agent-input')"), "the composer has focus");
	for (const [code, key, keyCode, modifiers] of [["KeyG", "g", 71, 2], ["KeyZ", "z", 90, 2], ["KeyA", "a", 65, 2], ["KeyF", "f", 70, 0], ["Delete", "Delete", 46, 0], ["Digit2", "2", 50, 0]]) await press(code, key, keyCode, modifiers);
	await sleep(1500);
	assert.equal(ours().length, beforeComposer, "keys inside the agent composer emit nothing");
	log("PASS composer keys (Ctrl+G, Ctrl+Z, Ctrl+A, F, Delete, 2) pressed in the focused composer emitted nothing");

	// The transcript: every friction event the SDK boundary saw, closed values only.
	for (const { event, properties } of ours()) {
		const props = Object.fromEntries(Object.entries(properties).filter(([key]) => !key.startsWith("$") && !["internal_qa", "app_version", "build_channel", "surface_kind", "locale", "session_id", "install_channel", "release_channel"].includes(key)));
		log(`capture ${event} ${JSON.stringify(props)}`);
	}
	const byEvent = Object.fromEntries(ours().map(({ event, properties }) => [event, properties]));
	assert.deepEqual(Object.keys(byEvent).sort(), ["nav:thrash", "search:no_results", "shortcut:ignored", "shortcut:unbound"]);
	assert.equal(byEvent["shortcut:unbound"].combo, "group");
	assert.deepEqual([byEvent["shortcut:ignored"].key_class, byEvent["shortcut:ignored"].reason], ["undo", "empty_history"]);
	assert.deepEqual([byEvent["search:no_results"].surface, byEvent["search:no_results"].query_len], ["assets", "4-8"]);
	assert.deepEqual([byEvent["nav:thrash"].surface, byEvent["nav:thrash"].switches, byEvent["nav:thrash"].window_s], ["dock_tab", "4-5", 10]);
	assert.equal(ours().length, 4, "one of each, nothing else");
	assert.ok(!JSON.stringify(ours()).includes("qzxj"), "the search text never leaves");
	assert.deepEqual(routeErrors, []);
	assert.deepEqual(pageErrors, []);
	log("PASS shortcut, search and thrash friction QA: 4 payloads, composer and search-field keys silent");
} finally {
	ws.close();
}
