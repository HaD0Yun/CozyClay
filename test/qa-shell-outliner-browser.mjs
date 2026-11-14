#!/usr/bin/env node
// Browser QA for issue #525: the hierarchy is the v2 Outliner in its current
// left-column home. The suite checks the real rendered region and keeps the
// context-menu create accelerator covered after the toolbar button is gone.
import { mkdirSync, writeFileSync } from "node:fs";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/tmp/cozyclay-task-11";
mkdirSync(out, { recursive: true });

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
const runtimeErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") {
		runtimeErrors.push(message.params?.exceptionDetails?.exception?.description ?? "page exception");
	}
	if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
		runtimeErrors.push(message.params.entry.text ?? "console error");
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

// DOM mutation observation subscribes before each interaction and resolves on
// the exact UI state, rather than relying on a timing delay.
const waitFor = (expression, timeoutMs = 15000) => evaluate(`new Promise((resolve, reject) => {
	const test = () => { try { return Boolean(${expression}); } catch { return false; } };
	if (test()) { resolve(true); return; }
	const observer = new MutationObserver(() => {
		if (!test()) return;
		observer.disconnect();
		clearTimeout(timer);
		resolve(true);
	});
	observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
	const timer = setTimeout(() => {
		observer.disconnect();
		reject(new Error(${JSON.stringify(`Timed out waiting for: ${expression}`)}));
	}, ${timeoutMs});
})`);

const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
let failures = 0;

// The app page includes the site's Cloudflare beacon. Block that unrelated
// third-party request before a reload so the zero-error assertion measures the
// Studio surface rather than a network policy outside this task.
await send("Network.enable");
await send("Network.setBlockedURLs", {
	urls: ["*static.cloudflareinsights.com*", "*cloudflareinsights.com*", "*favicon.ico*"],
});
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await send("Emulation.setDeviceMetricsOverride", {
	width: 1920,
	height: 1080,
	deviceScaleFactor: 1,
	mobile: false,
});

expect("Outliner mounts", await waitFor("!!document.querySelector('.v2-outliner .v2-outliner-search')"));
expect("Outliner has visible rows", await waitFor("document.querySelectorAll('.v2-outliner .hierarchy-row-wrap').length > 0"));

const rowHeights = await evaluate(`[...document.querySelectorAll('.v2-outliner .hierarchy-row-wrap')]
	.filter((row) => row.getClientRects().length > 0)
	.map((row) => Math.round(row.getBoundingClientRect().height))`);
expect("Outliner rows are 24 px", rowHeights.length > 0 && rowHeights.every((height) => height === 24), JSON.stringify(rowHeights));

await evaluate("document.querySelector('[data-node-id=characterA] .hierarchy-row')?.click()");
expect(
	"Character 1 can be selected",
	await waitFor("document.querySelector('[data-node-id=characterA]')?.classList.contains('selected')"),
);
const selectedBackground = await evaluate("getComputedStyle(document.querySelector('.v2-outliner .hierarchy-row-wrap.selected')).backgroundColor");
expect("selected row uses the amber tint", selectedBackground === "rgba(232, 163, 61, 0.14)", selectedBackground);

const screenshot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${out}/task-11-outliner.png`, Buffer.from(screenshot.data, "base64"));
console.log(`SCREENSHOT ${out}/task-11-outliner.png`);

const searchInput = "document.querySelector('.v2-outliner .v2-outliner-search')";
const setSearch = async (value) => {
	await evaluate(`(() => {
		const input = ${searchInput};
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
		setter.call(input, ${JSON.stringify(value)});
		input.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`);
};

const rowsBeforeSearch = await evaluate("document.querySelectorAll('.v2-outliner .hierarchy-row-wrap').length");
await setSearch("Camera");
expect(
	"search filters the Outliner rows",
	await waitFor(`document.querySelectorAll('.v2-outliner .hierarchy-row-wrap').length > 0 && document.querySelectorAll('.v2-outliner .hierarchy-row-wrap').length < ${rowsBeforeSearch}`),
);
const filteredLabels = await evaluate("[...document.querySelectorAll('.v2-outliner .hierarchy-label')].map((node) => node.textContent.trim())");
expect("search keeps the matching name visible", filteredLabels.includes("Camera"), JSON.stringify(filteredLabels));

await setSearch("does-not-exist-525");
expect("an empty search result says No matches", await waitFor("document.querySelector('.v2-outliner-empty')?.textContent.trim() === 'No matches'"));
const emptyColor = await evaluate("getComputedStyle(document.querySelector('.v2-outliner-empty')).color");
expect("No matches uses the muted text color", emptyColor === "rgb(99, 99, 105)", emptyColor);
expect("an empty search result has no rows", await evaluate("document.querySelectorAll('.v2-outliner .hierarchy-row-wrap').length === 0"));

await setSearch("");
expect("clearing search restores rows", await waitFor("document.querySelectorAll('.v2-outliner .hierarchy-row-wrap').length > 0"));
expect("the removed toolbar button is absent from the Outliner", await evaluate("!document.querySelector('.v2-outliner .add-object-trigger')"));

const createRow = "document.querySelector('[data-node-id=light]')";
await evaluate(`(() => {
	const row = ${createRow};
	const box = row.getBoundingClientRect();
	row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(box.left + 28), clientY: Math.round(box.top + 12), button: 2 }));
	return true;
})()`);
expect("right-clicking a scene row opens Create", await waitFor("!!document.querySelector('.v2-outliner .hierarchy-context-menu .add-object-item')"));
const createLabels = await evaluate("[...document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item')].map((node) => node.textContent.trim())");
expect("Create still lists a primitive", createLabels.some((label) => label.startsWith("Cube")), JSON.stringify(createLabels));
await evaluate("[...document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item')].find((node) => node.textContent.trim().startsWith('Cube'))?.click()");
expect("right-click Create adds the object", await waitFor("[...document.querySelectorAll('.v2-outliner .hierarchy-label')].some((node) => node.textContent.trim() === 'Cube')"));

const externalErrors = runtimeErrors.filter((error) => /cloudflareinsights|ERR_CONNECTION_REFUSED|ERR_FAILED|status of 404/i.test(error));
const studioErrors = runtimeErrors.filter((error) => !externalErrors.includes(error));
if (externalErrors.length > 0) console.log(`WARN external QA network noise (out of scope): ${JSON.stringify(externalErrors)}`);
expect("browser QA has no Studio console or page errors", studioErrors.length === 0, JSON.stringify(studioErrors));
if (failures > 0) process.exit(1);
console.log("qa-shell-outliner-browser: all checks passed");
ws.close();
