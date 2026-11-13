#!/usr/bin/env node
// Browser QA for issue #527: the v2 Content | Log pane, the Content collapse
// and the dock resize edge, driven through real pointer input over CDP.
//
// Run with a dev server up:
//   QA_URL=http://127.0.0.1:5527/app/ CDP_PORT=9527 \
//   QA_OUT=<dir> node tools/qa-browser.mjs -- node test/qa-shell-content-browser.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterPageLoad } from "./bus/browser-navigation.mjs";
import { waitForFrameState } from "./bus/browser-frame-state.mjs";

const port = Number(process.env.CDP_PORT || 9527);
const appUrl = process.env.QA_URL || "http://127.0.0.1:5527/app/";
const outputDir = process.env.QA_OUT || "/tmp/cozyclay-task-13";
mkdirSync(outputDir, { recursive: true });
const referenceUrl = pathToFileURL(fileURLToPath(new URL("../docs/design/v2-reference.html", import.meta.url))).href;

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
expect("Content is 620 px wide at 1920", Math.abs((geometry.content?.width ?? 0) - 620) < 0.5, JSON.stringify(geometry.content));
expect("dock is 330 px tall at 1080", Math.abs((geometry.dock?.height ?? 0) - 330) < 0.5, JSON.stringify(geometry.dock));
expect("header row is 36 px", Math.abs((geometry.header?.height ?? 0) - 36) < 0.5, JSON.stringify(geometry.header));
expect("folder list is 140 px", Math.abs((geometry.folders?.width ?? 0) - 140) < 0.5, JSON.stringify(geometry.folders));
expect("search is 160 px", Math.abs((geometry.search?.width ?? 0) - 160) < 0.5, JSON.stringify(geometry.search));
expect("asset grid has 6 columns", geometry.gridColumns === 6, String(geometry.gridColumns));
expect("header tabs are Content | Log", JSON.stringify(geometry.tabs) === JSON.stringify(["Content", "Log"]), JSON.stringify(geometry.tabs));
expect("folders are All, then the v2 six plus Sculpts (#740)", JSON.stringify(geometry.folderNames) === JSON.stringify(["All", "Basic Shapes", "Characters", "Props", "Cameras", "Motions", "Poses", "Sculpts"]), JSON.stringify(geometry.folderNames));
expect("pane uses the panel surface", geometry.background === "rgb(21, 21, 23)", geometry.background);

// ---- Basic Shapes: select, then drop outside / inside the viewport ----
await click("[data-testid=content-folder-basic]");
const cubeTile = "[data-testid=content-asset][data-asset-key='object:cube']";
expect("Basic Shapes lists the catalogue primitives", await waitFor(`!!document.querySelector(${JSON.stringify(cubeTile)})`)
	&& await evaluate("[...document.querySelectorAll('[data-testid=content-asset]')].map((n) => n.dataset.assetKey).join() === 'object:cube,object:sphere,object:capsule,object:cylinder,object:cone,object:plane'"));
await click(cubeTile);
expect("selected asset wears the amber ring", await waitFor(`(() => {
	const tile = document.querySelector(${JSON.stringify(cubeTile)});
	return tile?.getAttribute('aria-pressed') === 'true' && getComputedStyle(tile.querySelector('.content-tile-thumb')).boxShadow.includes('rgb(232, 163, 61)');
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
expect("double-click places the asset", await waitFor(`window.__cozyclay.objects.length === ${countBefore + 2}`));
const placed = await evaluate("window.__cozyclay.objects.at(-1)");
expect("double-click places it at the origin", Math.abs(placed?.x ?? 9) < 1e-6 && Math.abs(placed?.z ?? 9) < 1e-6, JSON.stringify({ x: placed?.x, z: placed?.z }));

// ---- Log tab ----
await click("[data-testid=content-tab-log]");
expect("the Log shows the toast text after the action", await waitFor(`[...document.querySelectorAll('[data-testid=content-log-entry] .content-log-text')].some((node) => node.textContent === ${JSON.stringify(toastText)})`),
	JSON.stringify(await evaluate("[...document.querySelectorAll('[data-testid=content-log-entry]')].map((n) => n.textContent)")));
expect("the breadcrumb follows the tab", await evaluate("document.querySelector('.content-breadcrumb').textContent.includes('Log')"));
await screenshot("task-13-log");
await click("[data-testid=content-tab-content]");

// ---- Collapse gives the Sequencer the full width ----
await click("[data-testid=content-collapse]");
expect("Content collapses to its 36 px header", await waitFor("document.querySelector('.v2-dock')?.hasAttribute('data-content-collapsed') && Math.abs(document.querySelector('.v2-dock > .assets-pane').getBoundingClientRect().height - 36) < 0.5"));
const collapsed = await evaluate(`(() => {
	const dock = document.querySelector('.v2-dock').getBoundingClientRect();
	const seq = document.querySelector('.bottom-timeline').getBoundingClientRect();
	const v2 = document.querySelector('.v2-sequencer')?.getBoundingClientRect();
	// The Sequencer column may carry its own vertical scrollbar; the Sequencer
	// fills that column's client width.
	return { dock: dock.width, timeline: seq.width, timelineClient: document.querySelector('.bottom-timeline').clientWidth, sequencer: v2?.width ?? 0, left: seq.left - dock.left };
})()`);
expect("collapse gives the Sequencer the full width", Math.abs(collapsed.timeline - collapsed.dock) < 0.5 && collapsed.left < 0.5 && Math.abs(collapsed.sequencer - collapsed.timelineClient) < 1, JSON.stringify(collapsed));
expect("collapse persists", await evaluate("localStorage.getItem('cozyclay.dock.content-collapsed.v1') === '1'"));
await screenshot("task-13-collapsed");
await click("[data-testid=content-collapse]");
expect("Content expands back to 620 px", await waitFor("Math.abs(document.querySelector('.v2-dock > .assets-pane').getBoundingClientRect().width - 620) < 0.5"));

// ---- Dock resize within [220, 480], persisted ----
const handle = await rectOf("[data-testid=dock-resize-handle]");
await drag({ x: handle.x, y: handle.y }, { x: handle.x, y: handle.y - 400 });
const tall = await evaluate("({ height: document.querySelector('.v2-dock').getBoundingClientRect().height, stored: localStorage.getItem('cozyclay.dock.height.v2') })");
expect("dragging the top edge up caps the dock at 480 px", Math.abs(tall.height - 480) < 0.5 && tall.stored === "480", JSON.stringify(tall));
const handleTall = await rectOf("[data-testid=dock-resize-handle]");
await drag({ x: handleTall.x, y: handleTall.y }, { x: handleTall.x, y: handleTall.y + 500 });
const short = await evaluate("({ height: document.querySelector('.v2-dock').getBoundingClientRect().height, stored: localStorage.getItem('cozyclay.dock.height.v2') })");
expect("dragging the top edge down floors the dock at 220 px", Math.abs(short.height - 220) < 0.5 && short.stored === "220", JSON.stringify(short));
await send("Page.reload");
expect("the dock size survives a reload", await waitFor("!!document.querySelector('.v2-dock') && Math.abs(document.querySelector('.v2-dock').getBoundingClientRect().height - 220) < 0.5"));
expect("the studio reloads with its take", await waitFor("!!window.__cozyclay?.motion && window.__cozyclay.motion.frames > 0"));
await evaluate("window.__cozyclay.pause?.()");
expect("the Sequencer follows a 220 px dock", await evaluate("Math.abs(document.querySelector('.v2-sequencer').getBoundingClientRect().bottom - document.querySelector('.v2-dock').getBoundingClientRect().bottom) < 1"),
	JSON.stringify(await evaluate("[document.querySelector('.v2-sequencer').getBoundingClientRect().bottom, document.querySelector('.v2-dock').getBoundingClientRect().bottom]")));
// Leave the tallest stored size behind for the small-screen check below.
const handleAfter = await rectOf("[data-testid=dock-resize-handle]");
await drag({ x: handleAfter.x, y: handleAfter.y }, { x: handleAfter.x, y: handleAfter.y - 400 });
await waitFor("localStorage.getItem('cozyclay.dock.height.v2') === '480'");
expect("the Sequencer follows a 480 px dock", await evaluate("Math.abs(document.querySelector('.v2-sequencer').getBoundingClientRect().height - document.querySelector('.bottom-timeline').clientHeight) < 1"),
	JSON.stringify(await evaluate("[document.querySelector('.v2-sequencer').getBoundingClientRect().height, document.querySelector('.bottom-timeline').clientHeight]")));

// ---- 1280x800: the viewport stays usable even with a 480 px stored dock ----
await setViewport(1280, 800);
await waitFor("innerWidth === 1280 && innerHeight === 800");
await waitFor("document.querySelector('.viewport').getBoundingClientRect().height >= 480");
// The renderer has taken the new size once its drawing buffer matches the box.
await waitFor("(() => { const canvas = document.querySelector('.viewport canvas'); return canvas && canvas.height === Math.round(canvas.getBoundingClientRect().height * devicePixelRatio); })()");
const small = await evaluate(`(() => {
	const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, top: Math.round(r.top * 10) / 10 }; };
	return { viewportSize: [innerWidth, innerHeight], viewport: box('.viewport'), canvas: box('.viewport canvas'), dock: box('.v2-dock'), content: box('.v2-dock > .assets-pane'), storedDock: localStorage.getItem('cozyclay.dock.height.v2') };
})()`);
writeFileSync(`${outputDir}/task-13-1280.json`, `${JSON.stringify(small, null, 2)}\n`);
console.log(`QA_EVIDENCE ${outputDir}/task-13-1280.json ${JSON.stringify(small)}`);
expect("at 1280x800 the viewport is >= 480 px tall", (small.viewport?.height ?? 0) >= 480, JSON.stringify(small.viewport));
expect("at 1280x800 the 3D canvas is >= 480 px tall", (small.canvas?.height ?? 0) >= 480, JSON.stringify(small.canvas));
expect("at 1280x800 the viewport is >= 900 px wide", (small.viewport?.width ?? 0) >= 900, JSON.stringify(small.viewport));
// A demand-mode canvas repaints on the frames after its resize; let two pass.
await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
await screenshot("task-13-1280");

// ---- Compare: our dock beside the owner's 2a dock ----
await setViewport(1920, 1080);
await waitFor("innerWidth === 1920 && Math.abs(document.querySelector('.v2-dock').getBoundingClientRect().height - 480) < 0.5");
await evaluate("localStorage.removeItem('cozyclay.dock.height.v2')");
await send("Page.reload");
await waitFor("!!document.querySelector('.v2-dock') && Math.abs(document.querySelector('.v2-dock').getBoundingClientRect().height - 330) < 0.5");
await click("[data-testid=content-folder-basic]");
await click(cubeTile);
await waitFor(`document.querySelector(${JSON.stringify(cubeTile)})?.getAttribute('aria-pressed') === 'true'`);
const ours = await rectOf(".v2-dock > .assets-pane");
const oursPng = await screenshot("task-13-ours", { x: ours.left, y: ours.top, width: ours.width, height: ours.height });
await send("Page.navigate", { url: referenceUrl });
await waitFor("[...document.querySelectorAll('div')].some((node) => node.style.width === '620px' && node.textContent.includes('Content'))", 20000);
const reference = await evaluate(`(() => {
	const node = [...document.querySelectorAll('div')].find((div) => div.style.width === '620px' && div.textContent.includes('Content'));
	node.scrollIntoView({ block: 'center' });
	const r = node.getBoundingClientRect();
	return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
})()`);
const referencePng = await screenshot("task-13-reference", reference);
await send("Page.navigate", { url: "about:blank" });
await evaluate(`(() => {
	document.body.style.cssText = 'margin:0;background:#070708;color:#9b9ba1;font:12px system-ui;display:flex;gap:16px;padding:16px';
	const col = (title, data) => '<figure style="margin:0"><figcaption style="margin:0 0 8px">' + title + '</figcaption><img src="data:image/png;base64,' + data + '"></figure>';
	document.body.innerHTML = col('v2 reference (2a)', ${JSON.stringify(referencePng)}) + col('CozyClay (this branch)', ${JSON.stringify(oursPng)});
	return Promise.all([...document.images].map((img) => img.decode()));
})()`);
const compare = await evaluate("({ width: document.body.scrollWidth, height: document.body.scrollHeight })");
await screenshot("task-13-compare", { x: 0, y: 0, width: compare.width, height: compare.height });
expect("reference and ours are the same size", Math.abs(reference.width - ours.width) < 1 && Math.abs(reference.height - ours.height) < 1, JSON.stringify({ reference, ours }));

ws.close();
if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("all shell content browser checks PASS");
