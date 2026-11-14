#!/usr/bin/env node
// Browser QA for composition guides, driven over CDP through the QA browser
// wrapper: cycle the guide button and read the real overlay DOM. Evidence
// script; not part of the manifest.
import { afterPageLoad } from "./bus/browser-navigation.mjs";

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
const send = (method, params = {}) => afterPageLoad(ws, method, () => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
}));
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const waitFor = (expression, timeoutMs = 15000, action = "") => evaluate(`new Promise((resolve, reject) => {
	let observer, timer;
	const finish = (value, error) => {
		observer.disconnect();
		clearTimeout(timer);
		if (error) reject(error); else resolve(value);
	};
	const check = () => {
		try { if (${expression}) finish(true); }
		catch (error) { finish(false, error); }
	};
	observer = new MutationObserver(check);
	observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
	timer = setTimeout(() => finish(false), ${timeoutMs});
	try { ${action}; check(); } catch (error) { finish(false, error); }
})`);
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

expect("app becomes ready", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')", 30000));

// --- guide cycle over the real DOM ----------------------------------------
const cycle = "document.querySelector('.vp-guide-cycle')";
const overlay = "document.querySelector('.vp-shot-preview .shot-guides')";
const openShowMenu = async () => {
	return waitFor(`!!${cycle}`, 3000, "document.querySelector('.view-menu-trigger')?.click()");
};
expect("the Show menu offers the guide button", await openShowMenu());
expect("guides start off (no overlay drawn)", await evaluate(`!${overlay}`));

expect("first click shows thirds", await waitFor(`${overlay}?.dataset.guideMode === "thirds"`, 8000, `${cycle}.click()`));
expect("thirds draws four hairlines", await evaluate(`${overlay}?.querySelectorAll("line").length === 4`));

expect("second click shows golden", await waitFor(`${overlay}?.dataset.guideMode === "golden"`, 8000, `${cycle}.click()`));

expect("third click shows center + diagonals", await waitFor(`${overlay}?.dataset.guideMode === "center"`, 8000, `${cycle}.click()`));

expect("fourth click shows safe areas as two rects", await waitFor(`${overlay}?.dataset.guideMode === "safe" && ${overlay}?.querySelectorAll("rect").length === 2`, 8000, `${cycle}.click()`));
expect("the preference is stored under its own key", await evaluate(`localStorage.getItem("cozyclay.shot-guides.v1") === "safe"`));

// The overlay never eats the pointer: the element under the frame centre is
// not the guides layer.
expect("guides are pointer-transparent", await evaluate(`(() => {
	const box = document.querySelector('.vp-shot-preview').getBoundingClientRect();
	const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
	return !hit?.closest?.('.shot-guides');
})()`));

// --- persistence across reload --------------------------------------------
await send("Page.enable");
await send("Page.reload", { ignoreCache: false });
expect("app returns after reload", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')", 30000));
expect("the Show menu returns after reload", await openShowMenu());
expect("the guide mode survives the reload", await waitFor(`${overlay}?.dataset.guideMode === "safe"`, 8000));

// --- look-through carries the same overlay --------------------------------
expect("look-through draws the letterbox-fitted overlay", await waitFor("!!document.querySelector('.shot-guides.lookthrough')", 8000, "document.querySelector('.vp-look-through').click()"));
const leftLookThrough = waitFor("!document.querySelector('.shot-guides.lookthrough')", 8000);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
expect("Esc leaves look-through and drops its overlay", await leftLookThrough);

// back to off for a clean slate
await openShowMenu();
expect("fifth click wraps back to off", await waitFor(`!${overlay}`, 8000, `${cycle}.click()`));

// --- embedded playview keeps a direct guide affordance ----------------------
const origin = await evaluate("location.origin");
await send("Page.navigate", { url: `${origin}/app/?embed=playview` });
expect("embed app returns", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')", 30000));
const embedGuide = "document.querySelector('.vp-embed-guide')";
const embeddedOverlay = "document.querySelector('.shot-guides.lookthrough')";
expect("embed exposes the guide button", await waitFor(`!!${embedGuide}?.checkVisibility()`, 8000));
expect("embed guide starts off", await evaluate(`${embedGuide}?.getAttribute("aria-pressed") === "false"`));
expect("embed guide click shows thirds", await waitFor(`${embeddedOverlay}?.dataset.guideMode === "thirds"`, 8000, `${embedGuide}.click()`));
await send("Page.navigate", { url: `${origin}/app/?embed=playground` });
expect("playground app returns", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')", 30000));
expect("playground exposes the guide button", await waitFor(`!!${embedGuide}?.checkVisibility()`, 8000));
await send("Page.navigate", { url: `${origin}/app/?embed=playground` });
expect("playground app returns", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')", 30000));
expect("playground exposes the guide button", await waitFor(`!!${embedGuide}?.checkVisibility()`, 8000));

// --- export wiring pin ----------------------------------------------------
const fs = await import("node:fs");
const appSource = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
expect("the exporter sends clean renders without the frame stamp", !appSource.includes("burnInCapture") && appSource.includes("capture: (frame, kind) => withExportFrame"));

if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("qa-shot-guides-browser: all checks passed");
ws.close();
