#!/usr/bin/env node
// Browser QA for the optional export folder. The native directory picker is
// replaced with an OPFS directory so the real production path (IndexedDB handle,
// permission check, numbered collision, disk write) runs headlessly.
//
// Run against the full dev server:
//   QA_URL=http://127.0.0.1:5181/app/ CDP_PORT=9331 \
//   QA_OUT=/tmp/cozyclay-export-workspace-qa \
//   node tools/qa-browser.mjs -- node test/qa-export-workspace-browser.mjs
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/tmp/cozyclay-export-workspace-qa";
const downloads = join(out, "downloads");
rmSync(downloads, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const pending = new Map();
const listeners = new Map();
const runtimeErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params?.exceptionDetails?.exception?.description ?? "page exception");
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
const once = (method, predicate = () => true, timeoutMs = 60000) => new Promise((resolve, reject) => {
	const set = listeners.get(method) ?? new Set();
	listeners.set(method, set);
	const timer = setTimeout(() => { set.delete(on); reject(new Error(`Missing CDP event ${method}`)); }, timeoutMs);
	const on = (params) => { if (!predicate(params)) return; set.delete(on); clearTimeout(timer); resolve(params); };
	set.add(on);
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
const click = async (selector) => {
	await evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
		element.click();
		return true;
	})()`);
};
const screenshot = async (name) => {
	const image = await send("Page.captureScreenshot", { format: "png" });
	const path = join(out, name);
	writeFileSync(path, Buffer.from(image.data, "base64"));
	console.log(`SCREENSHOT ${path}`);
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const framing = (x, z) => ({ pos: { x, y: 1.6, z }, yaw: 0, pitch: -0.08, fovDeg: 45 });
const sceneDocument = (shots, frameCount = 24) => ({
	version: 4, activeSceneId: "qa-export-scene",
	scenes: [{
		id: "qa-export-scene", name: "QA EXPORT", objects: [],
		shotDocument: { version: 4, frameCount, waypoints: [], shots },
		stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }], hasCharSheet: false, shotAspect: "16:9" },
	}],
});
const shot = { id: "qa-shot", name: "QA SHOT", startFrame: 0, endFrame: 23, camera: { mode: "keys" }, cameraKeys: [{ id: "k0", frame: 0, framing: framing(0, 5) }, { id: "k23", frame: 23, framing: framing(1.5, 3) }] };

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
// The real picker cannot be driven by CDP. OPFS is a real FileSystemDirectoryHandle,
// so the production handle store, permission check, write and collision paths all run.
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
	Object.defineProperty(window, "showDirectoryPicker", {
		configurable: true,
		value: async () => {
			const root = await navigator.storage.getDirectory();
			return root.getDirectoryHandle("qa-export", { create: true });
		},
	});
})();` });

const url = new URL(process.env.QA_URL || "http://127.0.0.1:5181/app/");
const loaded = once("Page.loadEventFired");
await send("Page.navigate", { url: `${url.origin}/favicon.ico` });
await loaded;
await evaluate(`(async () => {
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, JSON.stringify(${JSON.stringify(sceneDocument([shot]))}));
	const root = await navigator.storage.getDirectory();
	try { await root.removeEntry("qa-export", { recursive: true }); } catch {}
	return true;
})()`);
const appLoaded = once("Page.loadEventFired");
await send("Page.navigate", { url: `${url.origin}/app/` });
await appLoaded;
await waitFor("!!window.__cozyclay?.rigA && !!document.querySelector('.v2-topbar')", 60000);

const openPreferences = async () => {
	await click("[data-testid=menu-edit]");
	await waitFor("!!document.querySelector('.menubar-menu[data-menu=edit]')");
	await click("[data-testid=menu-preferences]");
	await waitFor("!!document.querySelector('.v2-preferences__dialog')");
	await evaluate(`([...document.querySelectorAll('[data-testid=preferences-nav-item]')].find((item) => item.textContent.trim() === "Export"))?.click()`);
	await waitFor(`([...document.querySelectorAll('[data-testid=preferences-nav-item]')].find((item) => item.textContent.trim() === "Export"))?.getAttribute("aria-current") === "page"`);
	await waitFor("!!document.querySelector('[data-testid=settings-export-folder-choose]')");
};
const closePreferences = async () => {
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await waitFor("!document.querySelector('.v2-preferences__dialog')");
};
const reloadApp = async () => {
	const loaded = once("Page.loadEventFired");
	await send("Page.reload", { ignoreCache: false });
	await loaded;
	await waitFor("!!window.__cozyclay?.rigA && !!document.querySelector('.v2-topbar')", 60000);
};
const openFileExport = async () => {
	await click("[data-testid=menu-file]");
	await waitFor("!!document.querySelector('#export-menu-trigger')");
	await click("#export-menu-trigger");
	await waitFor("!!document.querySelector('.export-menu')");
};
const workspaceFiles = () => evaluate(`(async () => {
	const root = await navigator.storage.getDirectory();
	const dir = await root.getDirectoryHandle("qa-export");
	const files = [];
	for await (const [name] of dir.entries()) files.push(name);
	return files;
})()`);
const waitForExportDone = async () => {
	await waitFor("['preparing','encoding','finalizing'].includes(document.querySelector('[data-testid=export-status]')?.dataset.phase)", 15000).catch(() => {});
	await waitFor("document.querySelector('[data-testid=export-status]')?.dataset.phase === 'completed'", 90000);
};

await openPreferences();
expect("the Export page starts on browser downloads", await evaluate(`document.querySelector('[data-testid=preferences-export-folder-name]')?.textContent.trim() === "Browser downloads"`));
await screenshot("preferences-export-before.png");
await click("[data-testid=settings-export-folder-choose]");
await waitFor(`document.querySelector('[data-testid=preferences-export-folder-name]')?.textContent.trim() === "qa-export"`, 10000);
expect("choosing a folder shows its name", await evaluate(`document.querySelector('[data-testid=preferences-export-folder-name]')?.textContent.trim() === "qa-export"`));
expect("a granted folder has no access warning", !await evaluate(`!!document.querySelector('[data-testid=preferences-export-folder] [role=status]')`));
await screenshot("preferences-export-after.png");
await closePreferences();

await reloadApp();
const permissionPatched = await evaluate(`(() => {
	try {
		const proto = FileSystemDirectoryHandle.prototype;
		window.__qaPermission = "prompt";
		Object.defineProperty(proto, "queryPermission", { configurable: true, value: async () => window.__qaPermission });
		Object.defineProperty(proto, "requestPermission", { configurable: true, value: async () => { window.__qaPermission = "granted"; return "granted"; } });
		return true;
	} catch { return false; }
})()`);
await openPreferences();
expect("the chosen folder survives a reload", await evaluate(`document.querySelector('[data-testid=preferences-export-folder-name]')?.textContent.trim() === "qa-export"`));
if (permissionPatched) {
	expect("a demoted permission shows its warning", await evaluate(`!!document.querySelector('[data-testid=preferences-export-folder] [role=status]')`));
	expect("a demoted permission offers Allow", await evaluate(`!!document.querySelector('[data-testid=settings-export-folder-allow]')`));
	await screenshot("preferences-export-reallow.png");
	await click("[data-testid=settings-export-folder-allow]");
	await waitFor("!document.querySelector('[data-testid=preferences-export-folder] [role=status]')", 10000);
	expect("Allow restores the folder", await evaluate(`window.__qaPermission === "granted"`));
} else {
	console.log("SKIP the demoted-permission UI: FileSystemDirectoryHandle methods are not patchable here");
}
await screenshot("preferences-export-after-reload.png");
await closePreferences();

await openFileExport();
await click("[data-testid=export-keyframe-pack]");
await waitForExportDone();
const firstFiles = await workspaceFiles();
expect("the keyframe pack lands in the chosen folder", firstFiles.some((name) => name.endsWith(".zip")), JSON.stringify(firstFiles));
const firstZip = firstFiles.find((name) => name.endsWith(".zip"));
const first = await evaluate(`(async () => {
	const root = await navigator.storage.getDirectory();
	const dir = await root.getDirectoryHandle("qa-export");
	const file = await (await dir.getFileHandle(${JSON.stringify(firstZip)})).getFile();
	const bytes = new Uint8Array(await file.arrayBuffer());
	return { size: file.size, magic: String.fromCharCode(bytes[0], bytes[1]) };
})()`);
expect("the workspace zip is a real zip", first.size > 0 && first.magic === "PK", JSON.stringify(first));
expect("no browser download was requested", readdirSync(downloads).length === 0, readdirSync(downloads).join(", "));

await openFileExport();
await click("[data-testid=export-keyframe-pack]");
await waitForExportDone();
const secondFiles = await workspaceFiles();
expect("a repeated export gets a numbered name", secondFiles.some((name) => name.includes(" (1).zip")), JSON.stringify(secondFiles));
expect("both exports survive side by side", secondFiles.filter((name) => name.endsWith(".zip")).length === 2, JSON.stringify(secondFiles));
await screenshot("workspace-after-two-exports.png");

await openPreferences();
await click("[data-testid=settings-export-folder-clear]");
await waitFor(`document.querySelector('[data-testid=preferences-export-folder-name]')?.textContent.trim() === "Browser downloads"`, 10000);
expect("clearing the folder returns to browser downloads", await evaluate(`document.querySelector('[data-testid=preferences-export-folder-name]')?.textContent.trim() === "Browser downloads"`));
await closePreferences();

await openFileExport();
const downloadStarted = once("Browser.downloadWillBegin");
await click("[data-testid=export-otio]");
const started = await downloadStarted;
expect("without a folder, OTIO falls back to a browser download", started.suggestedFilename.endsWith(".otio"), started.suggestedFilename);
await once("Browser.downloadProgress", (event) => event.state === "completed");
expect("the fallback download reaches the browser download manager", readdirSync(downloads).length === 1, readdirSync(downloads).join(", "));

expect("the page raised no runtime exceptions", runtimeErrors.length === 0, runtimeErrors.join(" | "));
ws.close();
console.log(failures ? `${failures} FAILURE(S)` : "all export workspace browser checks PASS");
if (failures) process.exitCode = 1;
