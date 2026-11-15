#!/usr/bin/env node
// Browser QA for issue #527: the v2 Content | Log pane, the Content collapse
// and the dock resize edge, driven through real pointer input over CDP.
//
// Run with a dev server up:
//   QA_URL=http://127.0.0.1:5527/app/ CDP_PORT=9527 \
//   QA_OUT=<dir> node tools/qa-browser.mjs -- node test/qa-shell-content-browser.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { afterPageLoad } from "./bus/browser-navigation.mjs";
import { waitForFrameState } from "./bus/browser-frame-state.mjs";

const port = Number(process.env.CDP_PORT || 9527);
const appUrl = process.env.QA_URL || "http://127.0.0.1:5527/app/";
const outputDir = process.env.QA_OUT || "/tmp/cozyclay-task-13";
mkdirSync(outputDir, { recursive: true });

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
const waitFor = (expression, timeoutMs = 20000) => waitForFrameState(evaluate, expression, timeoutMs);
const rectOf = (selector) => evaluate(`(() => {
	const element = document.querySelector(${JSON.stringify(selector)});
	if (!element) return null;
	const rect = element.getBoundingClientRect();
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
})()`);
const mouse = (type, params) => send("Input.dispatchMouseEvent", { type, ...params });
const click = async (selector, clickCount = 1) => {
	const point = await rectOf(selector);
	if (!point || point.width < 1) throw new Error(`not clickable: ${selector}`);
	for (let n = 1; n <= clickCount; n += 1) {
		await mouse("mousePressed", { x: point.x, y: point.y, button: "left", buttons: 1, clickCount: n });
		await mouse("mouseReleased", { x: point.x, y: point.y, button: "left", buttons: 0, clickCount: n });
	}
};
const drag = async (from, to, steps = 8) => {
	await mouse("mousePressed", { x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
	for (let i = 1; i <= steps; i += 1) {
		await mouse("mouseMoved", { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, button: "left", buttons: 1 });
	}
	await mouse("mouseReleased", { x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
};
const screenshot = async (name, clip) => {
	const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: Boolean(clip), ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
	const path = `${outputDir}/${name}.png`;
	writeFileSync(path, Buffer.from(capture.data, "base64"));
	console.log(`QA_SCREENSHOT ${path}`);
	return capture.data;
};
const setViewport = (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await send("Runtime.enable");
await send("Page.enable");
await setViewport(1920, 1080);

// A returning author's session in English, with no stored dock state.
const origin = new URL(appUrl).origin;
await send("Page.navigate", { url: `${origin}/favicon.ico` });
await evaluate(`(() => {
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Task 13", updatedAt: Date.now() }));
})()`);
await send("Page.navigate", { url: appUrl });
expect("Content browser renders", await waitFor("!!document.querySelector('[data-testid=content-browser]') && !!window.__cozyclay"));
expect("the old Animation/Assets tab strip is gone", await evaluate("!document.querySelector('.bottom-window-tabs')"));
await evaluate("document.querySelector('[data-testid=dock-tab-assets]')?.click()");
expect("the Assets tab exposes the Content pane", await waitFor("document.querySelector('.v2-dock > .assets-pane')?.getBoundingClientRect().width > 0"));
await evaluate("window.__cozyclay.pause?.()");

// ---- 2a geometry at 1920x1080 ----
const geometry = await evaluate(`(() => {
	const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, left: r.left }; };
	const grid = document.querySelector('.content-grid');
	return {
		content: box('.v2-dock > .assets-pane'),
		dock: box('.v2-dock'),
		header: box('.content-head'),
		folders: box('.content-folders'),
		search: box('[data-testid=content-search]'),
		gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
		tabs: [...document.querySelectorAll('.content-tabs [role=tab]')].map((node) => node.textContent.trim()),
		folderNames: [...document.querySelectorAll('.content-folders [data-testid^=content-folder-]')].map((node) => node.textContent.trim()),
		background: getComputedStyle(document.querySelector('.content-browser')).backgroundColor,
	};
})()`);
expect("Content fills the dock at 1920", Math.abs((geometry.content?.width ?? 0) - (geometry.dock?.width ?? -1)) < 0.5, JSON.stringify(geometry));
expect("dock is 220 px tall at 1080", Math.abs((geometry.dock?.height ?? 0) - 220) < 0.5, JSON.stringify(geometry.dock));
expect("header row is 48 px", Math.abs((geometry.header?.height ?? 0) - 48) < 0.5, JSON.stringify(geometry.header));
expect("the All view has no visible folder rail", Math.abs((geometry.folders?.width ?? 0) - 0) < 0.5, JSON.stringify(geometry.folders));
expect("search is 240 px", Math.abs((geometry.search?.width ?? 0) - 240) < 0.5, JSON.stringify(geometry.search));
expect("asset grid has 3 columns", geometry.gridColumns === 3, String(geometry.gridColumns));
expect("header tabs are Content | Log", JSON.stringify(geometry.tabs) === JSON.stringify(["Content", "Log"]), JSON.stringify(geometry.tabs));
expect("folders are All, then the v2 six plus Sculpts (#740)", JSON.stringify(geometry.folderNames) === JSON.stringify(["All", "Basic Shapes", "Characters", "Props", "Cameras", "Motions", "Poses", "Sculpts"]), JSON.stringify(geometry.folderNames));
expect("pane uses the transparent shell surface", geometry.background === "rgba(0, 0, 0, 0)", geometry.background);

// ---- All view / Basic Shapes: select, then drop outside / inside the viewport ----
const cubeTile = "[data-testid=content-asset][data-asset-key='object:cube']";
expect("All view lists the Basic Shapes catalogue primitives", await waitFor(`!!document.querySelector(${JSON.stringify(cubeTile)})`)
	&& await evaluate(`(() => {
		const keys = new Set([...document.querySelectorAll('[data-testid=content-asset]')].map((n) => n.dataset.assetKey));
		return ['object:cube', 'object:sphere', 'object:capsule', 'object:cylinder', 'object:cone', 'object:plane'].every((key) => keys.has(key));
	})()`));
await click(cubeTile);
expect("selected asset wears the amber ring", await waitFor(`(() => {
	const tile = document.querySelector(${JSON.stringify(cubeTile)});
	const thumb = tile?.querySelector('.content-tile-thumb');
	const style = thumb ? getComputedStyle(thumb) : null;
	return tile?.getAttribute('aria-pressed') === 'true'
		&& style?.backgroundColor === 'rgba(255, 255, 255, 0.08)'
		&& style.boxShadow !== 'none'
		&& style.boxShadow.includes('1.5px')
		&& style.boxShadow.includes('rgba(255, 255, 255, 0.5)');
})()`));
await screenshot("task-13-content");

const countBefore = await evaluate("window.__cozyclay.objects.length");
const cube = await rectOf(cubeTile);
const sequencer = await rectOf(".bottom-timeline");
await drag(cube, { x: sequencer.x, y: sequencer.y });
await waitFor("!document.querySelector('.asset-drag-ghost')");
const countOutside = await evaluate("window.__cozyclay.objects.length");
expect("dropping outside the viewport adds nothing", countOutside === countBefore, `${countBefore} -> ${countOutside}`);

const viewport = await rectOf(".viewport");
await drag(cube, { x: viewport.left + viewport.width * 0.45, y: viewport.top + viewport.height * 0.6 });
expect("Basic Shapes › Cube dragged to the viewport adds 1 object", await waitFor(`window.__cozyclay.objects.length === ${countBefore + 1}`), String(await evaluate("window.__cozyclay.objects.length")));
expect("the new object is a cube", await evaluate("window.__cozyclay.objects.at(-1)?.renderer === 'cube' || window.__cozyclay.objects.at(-1)?.kind === 'cube'"), JSON.stringify(await evaluate("window.__cozyclay.objects.at(-1)")));
const toastText = await waitFor("!!document.querySelector('.toast')") ? await evaluate("document.querySelector('.toast').textContent.trim()") : "";
expect("the drop raises a toast", toastText.length > 0, toastText);

// ---- Double-click places at the origin ----
const sphereTile = "[data-testid=content-asset][data-asset-key='object:sphere']";
await click(sphereTile, 2);
expect("double-click places the asset", await waitFor(`window.__cozyclay.objects.length >= ${countBefore + 2}`));
const placed = await evaluate(`window.__cozyclay.objects.slice(${countBefore})`);
expect("double-click places a sphere", placed.some((object) => object?.renderer === "sphere" || object?.kind === "sphere"), JSON.stringify(placed));

// ---- Log tab ----
await click("[data-testid=content-tab-log]");
expect("the Log shows the toast text after the action", await waitFor(`[...document.querySelectorAll('[data-testid=content-log-entry] .content-log-text')].some((node) => node.textContent === ${JSON.stringify(toastText)})`),
	JSON.stringify(await evaluate("[...document.querySelectorAll('[data-testid=content-log-entry]')].map((n) => n.textContent)")));
expect("the breadcrumb follows the tab", await evaluate("document.querySelector('.content-breadcrumb').textContent.includes('Log')"));
await screenshot("task-13-log");
await click("[data-testid=content-tab-content]");

const legacyControls = await evaluate(`(() => {
	const rect = (selector) => {
		const node = document.querySelector(selector);
		if (!node) return { width: 0, height: 0 };
		const box = node.getBoundingClientRect();
		return { width: box.width, height: box.height };
	};
	return { collapse: rect('[data-testid=content-collapse]'), resize: rect('[data-testid=dock-resize-handle]') };
})()`);
expect("the current full-width Content surface hides the legacy collapse control and keeps its resize edge", legacyControls.collapse.width === 0 && legacyControls.resize.height === 7, JSON.stringify(legacyControls));
const dock = await evaluate(`(() => {
	const node = document.querySelector('.v2-dock');
	const rect = node.getBoundingClientRect();
	return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
})()`);
expect("the current All view screenshot fills the measured dock", Math.abs(dock.width - geometry.dock.width) < 0.5 && Math.abs(dock.height - geometry.dock.height) < 0.5, JSON.stringify({ dock, measured: geometry.dock }));
await screenshot("task-13-current", { x: dock.left, y: dock.top, width: dock.width, height: dock.height });

ws.close();
if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("all shell content browser checks PASS");
