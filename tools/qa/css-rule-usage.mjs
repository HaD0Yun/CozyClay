#!/usr/bin/env node
// Which src/styles.css rules does the Studio still use? Drives /app/ through
// every v2 surface (modes 1-4 with a character and then a prop selected, the
// File/Edit/Window/Help menus with Export, the viewport pills, Preferences
// on every page, Content and Log, and the start screen) at 1600x1000 and 1280x800 while CDP CSS.startRuleUsageTracking
// records every style rule that matched. Rules that never matched AND whose
// class/id names appear in no src/**/*.{js,jsx} file are pruning candidates.
//
//   QA_URL=http://127.0.0.1:5733/app/ CDP_PORT=9733 \
//     OUT=/tmp/css-usage.json node tools/qa-browser.mjs -- node tools/qa/css-rule-usage.mjs
//
// Writes OUT (default /tmp/css-rule-usage.json): { states, rules, used,
// candidates: [{ index, selector, line, endLine }] }. Rule indexes follow
// postcss walkRules order over src/styles.css.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import postcss from "postcss";

const root = new URL("../..", import.meta.url).pathname;
const SHEET = "src/styles.css";
const out = process.env.OUT || "/tmp/css-rule-usage.json";
const port = Number(process.env.CDP_PORT || 9222);
const appUrl = new URL(process.env.QA_URL || "http://127.0.0.1:5180/app/");

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
const listeners = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method) for (const listener of listeners.get(message.method) ?? []) listener(message.params);
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
const on = (method, listener) => { const set = listeners.get(method) ?? new Set(); set.add(listener); listeners.set(method, set); };
const once = (method, timeoutMs = 60000) => new Promise((resolve, reject) => {
	const set = listeners.get(method) ?? new Set();
	listeners.set(method, set);
	const timer = setTimeout(() => { set.delete(handler); reject(new Error(`Missing CDP event ${method}`)); }, timeoutMs);
	const handler = (params) => { set.delete(handler); clearTimeout(timer); resolve(params); };
	set.add(handler);
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const waitFor = (expression, timeoutMs = 20000) => evaluate(`new Promise((resolve, reject) => {
	const test = () => { try { return Boolean(${expression}); } catch { return false; } };
	if (test()) { resolve(true); return; }
	const observer = new MutationObserver(() => { if (!test()) return; observer.disconnect(); clearTimeout(timer); resolve(true); });
	observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
	const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`Timed out waiting for: ${expression}`)})); }, ${timeoutMs});
})`);
// Two frames guarantee a style recalc (and so rule matching) for the new DOM.
const settle = () => evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
const click = async (selector) => {
	const found = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
	if (!found) throw new Error(`missing control ${selector}`);
	await settle();
};
const escape = async () => {
	for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await settle();
};

// ---- stylesheet bookkeeping: find the <style> Vite injects for styles.css ----
const sheets = new Map();
on("CSS.styleSheetAdded", ({ header }) => sheets.set(header.styleSheetId, header));
const sheetSource = new Map(); // styleSheetId -> { file, text }
const sourceOf = async (styleSheetId) => {
	if (sheetSource.has(styleSheetId)) return sheetSource.get(styleSheetId);
	const header = sheets.get(styleSheetId);
	let file = header?.sourceURL ? new URL(header.sourceURL, appUrl).pathname : "";
	if (header?.ownerNode) {
		const { node } = await send("DOM.describeNode", { backendNodeId: header.ownerNode }).catch(() => ({ node: null }));
		const attrs = node?.attributes ?? [];
		const devId = attrs[attrs.indexOf("data-vite-dev-id") + 1];
		if (attrs.includes("data-vite-dev-id") && devId) file = devId;
	}
	const { text } = await send("CSS.getStyleSheetText", { styleSheetId });
	const entry = { file, text };
	sheetSource.set(styleSheetId, entry);
	return entry;
};

const sourceText = readFileSync(join(root, SHEET), "utf8");
const sourceRules = [];
postcss.parse(sourceText).walkRules((rule) => {
	if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
	sourceRules.push(rule);
});
const servedIndex = new Map(); // served text -> Map(startOffset -> rule index)
const indexServed = (text) => {
	if (servedIndex.has(text)) return servedIndex.get(text);
	const byOffset = new Map();
	let index = 0;
	postcss.parse(text).walkRules((rule) => {
		if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
		if (rule.selector !== sourceRules[index]?.selector) throw new Error(`served ${SHEET} diverges from the file at rule ${index}: ${rule.selector}`);
		byOffset.set(rule.source.start.offset, index);
		index += 1;
	});
	if (index !== sourceRules.length) throw new Error(`served ${SHEET} has ${index} rules, the file ${sourceRules.length}`);
	servedIndex.set(text, byOffset);
	return byOffset;
};

const used = new Set();
const states = [];
const collect = async (state) => {
	await settle();
	const { coverage } = await send("CSS.takeCoverageDelta");
	let count = 0;
	for (const usage of coverage) {
		if (!usage.used) continue;
		const { file, text } = await sourceOf(usage.styleSheetId);
		if (!file.endsWith(`/${SHEET}`)) continue;
		const byOffset = indexServed(text);
		// The usage range starts at the selector; allow for leading whitespace.
		let index = byOffset.get(usage.startOffset);
		if (index === undefined) {
			const trimmed = usage.startOffset + (text.slice(usage.startOffset).length - text.slice(usage.startOffset).trimStart().length);
			index = byOffset.get(trimmed);
		}
		// Grouping rules (@layer legacy, @media, @supports) report usage too.
		if (index === undefined && /@[\w-]+\s*$/.test(text.slice(Math.max(0, usage.startOffset - 40), usage.startOffset))) continue;
		if (index === undefined) throw new Error(`no ${SHEET} rule at offset ${usage.startOffset}: ${text.slice(usage.startOffset, usage.startOffset + 60)}`);
		if (!used.has(index)) count += 1;
		used.add(index);
	}
	states.push({ state, newlyUsed: count, totalUsed: used.size });
	console.log(`${state}: +${count} (${used.size}/${sourceRules.length})`);
};

const startTracking = async () => {
	await send("DOM.enable");
	await send("CSS.enable");
	await send("CSS.startRuleUsageTracking").catch(() => {});
};

async function load({ session = true, width, height }) {
	await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
	const seeded = once("Page.loadEventFired");
	await send("Page.navigate", { url: `${appUrl.origin}/favicon.ico` });
	await seeded;
	await evaluate(`(() => {
		localStorage.setItem("cozyclay.locale", "en");
		${session ? `localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));` : `localStorage.removeItem("cozyclay.project-session.v1");`}
		return true;
	})()`);
	sheets.clear();
	sheetSource.clear();
	const loaded = once("Page.loadEventFired");
	await send("Page.navigate", { url: appUrl.href });
	await loaded;
	await startTracking();
}

const modeKeys = ["1", "2", "3", "4"];
async function walkStudio(label) {
	await waitFor("!!window.__cozyclay?.rigA && window.__cozyclay?.motion?.frames > 0 && !!document.querySelector('[data-node-id=characterA] .hierarchy-row')", 90000);
	await evaluate("window.__cozyclay.pause?.(); true");
	await collect(`${label} loaded`);
	for (const key of modeKeys) {
		await click(`[data-mode-key="${key}"]`);
		await click("[data-node-id=characterA] .hierarchy-row");
		await collect(`${label} mode ${key} + character`);
	}
	// A prop: viewport + Add › Cube selects the new object.
	await click("[data-testid=viewport-add]");
	await waitFor("!!document.querySelector('.viewport-titlebar .add-object-swatch.cube')");
	await collect(`${label} viewport Add menu`);
	await evaluate("document.querySelector('.viewport-titlebar .add-object-swatch.cube').closest('button').click(); true");
	await waitFor("document.querySelector('.inspector-sidebar')?.dataset.inspector?.startsWith('object:')");
	const inspector = await evaluate("document.querySelector('.inspector-sidebar').dataset.inspector");
	for (const key of modeKeys) {
		await click(`[data-mode-key="${key}"]`);
		// Re-select the prop through the Outliner in every mode.
		await evaluate(`(() => { const id = ${JSON.stringify(inspector.slice("object:".length))}; const row = document.querySelector('[data-node-id="' + id + '"] .hierarchy-row') || document.querySelector('[data-node-id="object:' + id + '"] .hierarchy-row'); row?.click(); return !!row; })()`);
		await settle();
		await collect(`${label} mode ${key} + prop`);
	}
	await click('[data-mode-key="1"]');
	await click("[data-node-id=characterA] .hierarchy-row");
	for (const trigger of ["view-camera-trigger", "shading-trigger", "view-menu-trigger"]) {
		if (!await evaluate(`!!document.querySelector('[data-testid=${trigger}]')`)) continue;
		await click(`[data-testid=${trigger}]`);
		await collect(`${label} ${trigger} open`);
		await escape();
	}
	for (const menu of ["file", "edit", "window", "help"]) {
		await click(`[data-testid=menu-${menu}]`);
		await waitFor(`!!document.querySelector('.menubar-menu[data-menu=${menu}]')`);
		if (menu === "file") {
			await click("#export-menu-trigger");
			await waitFor("!!document.querySelector('.export-menu')");
		}
		await collect(`${label} ${menu} menu`);
		await escape();
	}
	// Preferences through Edit › Preferences…, then every section.
	await click("[data-testid=menu-edit]");
	await waitFor("!!document.querySelector('[data-testid=menu-preferences]')");
	await click("[data-testid=menu-preferences]");
	await waitFor("!!document.querySelector('[data-testid=preferences-nav-item]')");
	const sections = await evaluate("[...document.querySelectorAll('[data-testid=preferences-nav-item]')].map((item) => item.textContent.trim())");
	for (const section of sections) {
		await evaluate(`[...document.querySelectorAll('[data-testid=preferences-nav-item]')].find((item) => item.textContent.trim() === ${JSON.stringify(section)})?.click(); true`);
		await settle();
		await collect(`${label} Preferences › ${section}`);
	}
	await click("[data-testid=preferences-close]");
	for (const tab of ["log", "content"]) {
		await click(`[data-testid=content-tab-${tab}]`);
		await collect(`${label} ${tab} tab`);
	}
	await evaluate("[...document.querySelectorAll('.content-folders [data-testid^=content-folder-]')].map((folder) => folder.dataset.testid)").then(async (folders) => {
		for (const folder of folders) { await click(`[data-testid=${folder}]`); }
		await collect(`${label} Content folders`);
	});
}

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await send("Network.setBlockedURLs", { urls: ["*cloudflareinsights.com*"] });

await load({ width: 1600, height: 1000 });
await walkStudio("1600");
await load({ width: 1280, height: 800 });
await walkStudio("1280");
await load({ session: false, width: 1440, height: 900 });
await waitFor("!!document.querySelector('.v2-start-screen')", 60000);
await collect("start screen");

const sourceFiles = [];
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (/\.(jsx?|mjs)$/.test(name)) sourceFiles.push(readFileSync(path, "utf8"));
	}
};
walk(join(root, "src"));
const sourceBlob = sourceFiles.join("\n");
const nameUsed = new Map();
const referenced = (name) => {
	if (!nameUsed.has(name)) nameUsed.set(name, new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(sourceBlob));
	return nameUsed.get(name);
};
const lineOf = (offset) => sourceText.slice(0, offset).split("\n").length;
const candidates = [];
sourceRules.forEach((rule, index) => {
	if (used.has(index)) return;
	const names = [...new Set([...rule.selector.matchAll(/[.#](-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]))];
	if (!names.length) return; // element-only rules are never pruned by this pass
	if (names.some(referenced)) return;
	candidates.push({ index, selector: rule.selector.replace(/\s+/g, " "), line: lineOf(rule.source.start.offset), endLine: lineOf(rule.source.end.offset) });
});
writeFileSync(out, JSON.stringify({ sheet: SHEET, rules: sourceRules.length, used: used.size, states, candidates }, null, 2));
console.log(`${SHEET}: ${sourceRules.length} rules, ${used.size} used, ${candidates.length} unused with no src reference -> ${relative(process.cwd(), out)}`);
ws.close();
process.exit(0);
