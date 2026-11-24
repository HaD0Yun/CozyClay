#!/usr/bin/env node
// P2-a: ui:rage_click and ui:dead_click from real pointer input in the Studio.
// Start Vite separately, then:
//   QA_URL=http://127.0.0.1:5371/app/ CDP_PORT=9571 node tools/qa-browser.mjs -- node test/qa-click-friction-browser.mjs
// Only the SDK is a fake: the analytics module is served with a PROD environment and an
// in-memory SDK at the real track()/sanitizeProps() boundary. Steps: four fast clicks on
// Play, one click on a disabled File > Export entry (a scene with no shots), one click into
// the agent composer (must emit nothing). Prints the payloads.
import assert from "node:assert/strict";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const origin = new URL(process.env.QA_URL || "http://127.0.0.1:5371/app/").origin;
const port = Number(process.env.CDP_PORT || 9571);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((target) => target.type === "page" && target.webSocketDebuggerUrl);
assert.ok(page, "QA Chrome must expose a page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map(), records = [], errors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); return; }
	if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (message.method === "Runtime.bindingCalled" && message.params.name === "__qaRecord") records.push(JSON.parse(message.params.payload));
	if (message.method === "Fetch.requestPaused") void (async () => {
		const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId: message.params.requestId });
		let source = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
		source = source.replace("return import.meta.env ?? {};", "return { PROD: true, VITE_POSTHOG_KEY: 'internal-qa-p2a', VITE_POSTHOG_HOST: 'https://telemetry.invalid', VITE_POSTHOG_ALLOWED_ORIGINS: location.origin };");
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
	for (let t = 0; t < ms; t += 200) { try { if (await evaluate(expression)) return; } catch { /* page busy */ } await sleep(200); }
	throw new Error(`Timed out: ${label}`);
};
const centre = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ' + ${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: el.disabled === true }; })()`);
const press = async ({ x, y }) => {
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
};
const show = (record) => `${record.event} ${JSON.stringify(Object.fromEntries(Object.entries(record.properties).filter(([key]) => !["distribution", "app_version", "origin_kind", "os", "install_kind", "update_status", "internal_qa", "distinct_id"].includes(key) && !key.startsWith("$"))))}`;
const scene = { version: 4, activeSceneId: "qa-clicks", scenes: [{ id: "qa-clicks", name: "QA clicks", objects: [], shotDocument: { version: 4, frameCount: 96, waypoints: [], shots: [] },
	stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "QA" }], hasCharSheet: false, shotAspect: "16:9" } }] };

try {
	await send("Page.enable"); await send("Runtime.enable");
	await send("Runtime.addBinding", { name: "__qaRecord" });
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/src/analytics.js*", requestStage: "Response" }] });
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `if (window === window.top) { localStorage.clear(); localStorage.setItem('cozyclay.locale', 'en');
		localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'QA', updatedAt: Date.now() })); localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(scene))}); }
		let beforeSend; window.__qaPosthog = { init(_key, options) { beforeSend = options.before_send; }, register() {}, opt_in_capturing() {}, opt_out_capturing() {},
			has_opted_out_capturing: () => false, get_distinct_id: () => 'internal-qa-p2a', get_session_id: () => '0192f0d6-3a4b-7c2d-8e9f-abcdefabcdef',
			capture(event, properties = {}) { const payload = beforeSend({ event, properties: { ...properties } }); if (payload) window.__qaRecord(JSON.stringify(payload)); } };` });
	await send("Page.navigate", { url: `${origin}/app/` });
	await waitFor("!!document.querySelector('[data-fid=\"tl_play\"]') && !!window.__cozyclay", "Studio with the Play control", 120_000);
	await sleep(1500);
	const mark = records.length;
	// 1. four fast clicks on Play, inside 1 s and on one spot
	const play = await centre("[data-fid='tl_play']");
	for (let i = 0; i < 4; i += 1) { await press(play); await sleep(120); }
	await sleep(1300);
	// 2. one click on a disabled export entry (no shots: the depth video cannot export)
	await press(await centre("[data-testid=menu-file]"));
	await waitFor("!!document.querySelector('#export-menu-trigger')", "File menu");
	await press(await centre("#export-menu-trigger"));
	await waitFor("!!document.querySelector('[data-testid=export-depth-video]')", "Export menu");
	const entry = await centre("[data-testid=export-depth-video]");
	assert.equal(entry.disabled, true, "the depth video entry is natively disabled with no shots");
	await press(entry);
	await sleep(700);
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	// 3. one click into the agent composer: a typing target, never a click signal
	await evaluate("document.querySelector('.studio-agent-bar')?.click(), true");
	await waitFor("!!document.querySelector('.agent-input')", "the agent composer");
	const beforeComposer = records.length;
	for (let i = 0; i < 4; i += 1) { await press(await centre(".agent-input")); await sleep(100); }
	await sleep(1300);
	const composer = records.slice(beforeComposer).filter((r) => r.event.startsWith("ui:"));
	const clicks = records.slice(mark).filter((r) => r.event.startsWith("ui:"));
	console.log("--- ui:* events (global properties omitted)");
	for (const record of clicks) console.log(`  ${show(record)}`);
	console.log(`--- events from four clicks into the composer: ${composer.length}`);
	assert.ok(clicks.some((r) => r.event === "ui:rage_click" && r.properties.control === "tl_play" && r.properties.clicks === "4-5"), "Play rage click");
	assert.ok(clicks.some((r) => r.event === "ui:dead_click" && r.properties.control === "export_depth_video" && r.properties.reason === "aria_disabled"), "the disabled entry is a dead click");
	assert.equal(composer.length, 0, "the composer emits nothing");
	assert.ok(!JSON.stringify(clicks).match(/"x"|"y"|Play|Depth/), "no coordinates or labels");
	assert.deepEqual(errors, [], "no uncaught page errors");
	console.log("PASS qa-click-friction-browser: rage click on Play, dead click on a disabled export entry, nothing from the composer");
} finally {
	ws.close();
}
