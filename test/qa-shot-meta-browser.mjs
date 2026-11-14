#!/usr/bin/env node
// Browser QA for shot metadata (#163), driven over CDP through the QA browser
// wrapper: aim a shot at a video model through the inspector select, stretch
// the cut past that model's clip length, and read the warning badge and the
// capture metadata out of the real DOM. Evidence script; not in the manifest.
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.env.QA_OUT || "/tmp/shot-meta-qa";
mkdirSync(out, { recursive: true });

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
// React state lands on a later commit than the call that requested it, so
// every assertion waits for the DOM to actually say so instead of sleeping.
const waitFor = async (expression, timeoutMs = 20000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await evaluate(expression).catch(() => false)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 60));
	}
};
const screenshot = async (name) => {
	const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	const path = `${out}/${name}.png`;
	writeFileSync(path, Buffer.from(data, "base64"));
	return path;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

expect("app becomes ready", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')", 60000));
expect("the QA capture-meta hook is exposed", await waitFor("typeof window.__cozyclay?.captureMeta === 'function'", 30000));

// --- a shot to aim -------------------------------------------------------
// The lane's own "+ Add shot" is the shipped way to create one, so QA uses it
// rather than reaching into state.
await evaluate(`(() => {
	const add = [...document.querySelectorAll('.tl-track-add.cut')][0];
	if (add && !add.disabled) add.click();
})()`);
expect("a shot block exists on the timeline", await waitFor("!!document.querySelector('.tl-shot-block')", 20000));
await evaluate("document.querySelector('.tl-shot-block').click()");

// --- aim it at Seedance 2.5 through the inspector select -----------------
const select = "document.querySelector('[data-shot-target-model]')";
expect("the shot inspector offers a Target model select", await waitFor(`!!${select} && !${select}.disabled`, 20000));
expect("the select lists every shipped preset plus None", await evaluate(`(() => {
	const values = [...${select}.options].map((option) => option.value);
	return values[0] === "" && ["seedance-2.5", "kling-2", "veo-3", "minimax-h3-selfhosted"].every((id) => values.includes(id));
})()`));
// A React-controlled select only sees a change dispatched through its own
// value setter, the way a user's pick reaches it.
await evaluate(`(() => {
	const element = ${select};
	const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
	setter.call(element, "seedance-2.5");
	element.dispatchEvent(new Event("change", { bubbles: true }));
})()`);
expect("the pick lands on the shot", await waitFor(`${select}.value === "seedance-2.5"`, 20000));

// --- stretch the cut past the 10 s limit ---------------------------------
// Seedance takes exactly 5 s or 10 s clips, so a shot longer than 10 s is out
// of grid. The end handle is the shipped control; QA drags it to the far right
// of the lane the way an editor trims.
await evaluate(`(() => {
	const block = document.querySelector('.tl-shot-block');
	const handle = block.querySelector('.tl-shot-edge.end');
	const lane = block.closest('.tl-lane');
	const laneBox = lane.getBoundingClientRect();
	const handleBox = handle.getBoundingClientRect();
	const options = { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1 };
	handle.setPointerCapture = () => {};
	handle.releasePointerCapture = () => {};
	handle.dispatchEvent(new PointerEvent("pointerdown", { ...options, clientX: handleBox.left + 2, clientY: handleBox.top + 4 }));
	handle.dispatchEvent(new PointerEvent("pointermove", { ...options, clientX: laneBox.right - 2, clientY: handleBox.top + 4 }));
	handle.dispatchEvent(new PointerEvent("pointerup", { ...options, buttons: 0, clientX: laneBox.right - 2, clientY: handleBox.top + 4 }));
})()`);
const longEnough = "(() => { const m = window.__cozyclay.captureMeta(); return (m.frameRange.end - m.frameRange.start + 1) / m.fps > 10; })()";
expect("the shot now runs past 10 s", await waitFor(longEnough, 20000), await evaluate("JSON.stringify(window.__cozyclay.captureMeta().frameRange)"));

// --- the badge ------------------------------------------------------------
expect("the shot box shows the model warning badge", await waitFor("!!document.querySelector('.tl-shot-warn')", 20000));
const badgeTitle = await evaluate("document.querySelector('.tl-shot-warn')?.title ?? ''");
expect("the badge names the limit it broke", /Seedance/.test(badgeTitle) && /too long/.test(badgeTitle), badgeTitle);
console.log(`badge title: ${badgeTitle}`);
console.log(`badge screenshot: ${await screenshot("badge")}`);

// --- capture metadata -----------------------------------------------------
const meta = await evaluate("window.__cozyclay.captureMeta()");
expect("capture meta carries the lens", Number.isFinite(meta.focalMm) && Number.isFinite(meta.fovDeg), JSON.stringify({ focalMm: meta.focalMm, fovDeg: meta.fovDeg }));
expect("capture meta carries the delivery aspect", typeof meta.aspect === "string" && meta.aspect.includes(":"), String(meta.aspect));
expect("capture meta carries the cast", Array.isArray(meta.cast) && meta.cast.length > 0 && typeof meta.cast[0].model === "string" && typeof meta.cast[0].name === "string", JSON.stringify(meta.cast));
expect("capture meta names the target model", meta.targetModel === "seedance-2.5", String(meta.targetModel));
expect("capture meta carries the cut range and fps", Number.isInteger(meta.frameRange.start) && Number.isInteger(meta.frameRange.end) && meta.fps > 0, JSON.stringify(meta));
writeFileSync(`${out}/capture-meta.json`, JSON.stringify(meta, null, 2));
console.log(`capture meta: ${out}/capture-meta.json`);

// --- clearing the target clears the badge --------------------------------
await evaluate(`(() => {
	const element = ${select};
	const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
	setter.call(element, "");
	element.dispatchEvent(new Event("change", { bubbles: true }));
})()`);
expect("clearing the target drops the badge", await waitFor("!document.querySelector('.tl-shot-warn')", 20000));

if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("qa-shot-meta-browser: all checks passed");
ws.close();
