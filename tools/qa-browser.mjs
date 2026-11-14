#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	installSignalCleanup,
	spawnOwned,
	terminateOwned,
	waitForExit,
} from "./process-supervisor.mjs";

const separator = process.argv.indexOf("--");
const command = separator >= 0 ? process.argv[separator + 1] : null;
const commandArgs = separator >= 0 ? process.argv.slice(separator + 2) : [];
if (!command) {
	console.error("usage: node tools/qa-browser.mjs -- <command> [...args]");
	process.exit(2);
}

const chromeCandidates = [
	process.env.CHROME_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
].filter(Boolean);
const chromePath = chromeCandidates.find(existsSync);
if (!chromePath) throw new Error("Google Chrome/Chromium not found; set CHROME_PATH");
const chromeFlags = String(process.env.QA_CHROME_FLAGS || process.env.CHROME_FLAGS || "")
	.trim()
	.split(/\s+/)
	.filter(Boolean);

const port = Number(process.env.CDP_PORT || 9222);
// The studio lives at /app/; "/" is the static landing page, and a QA run
// pointed there fails every selector before a single assertion is useful.
const pageUrl = process.env.QA_URL || "http://127.0.0.1:5180/app/";
// This suite installs its saved scene before opening the app. Keep bootstrap
// on the plain origin instead of starting an app lifetime it must replace.
const ownsSceneStartup = commandArgs.some((arg) => basename(arg) === "qa-camera-record-browser.mjs");
const bootstrapUrl = ownsSceneStartup ? `${new URL(pageUrl).origin}/favicon.ico` : pageUrl;
const cdpUrl = `http://127.0.0.1:${port}/json/version`;

/** Give the QA profile a project session before the studio opens, so QA drives
 * the studio a returning author sees rather than the first-run chooser. */
async function seedProjectSession(cdpPort, url) {
	const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
	const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
	if (!page) throw new Error("QA browser exposed no page target to seed");
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
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	try {
		// Chrome's first document for a headless launch URL can still deny
		// storage access (about:blank origin) while the studio is loading, so
		// the seed goes through a plain same-origin document instead, and the
		// studio is opened afterwards with the session already in place. The
		// value is written once, into storage: nothing re-runs on later
		// navigations, so a suite that sweeps storage to test a first-run path
		// still gets one.
		const origin = new URL(url).origin;
		await send("Page.enable");
		const loadedOnce = () => new Promise((resolve) => {
			const onMessage = (event) => {
				if (JSON.parse(event.data).method !== "Page.loadEventFired") return;
				ws.removeEventListener("message", onMessage);
				resolve();
			};
			ws.addEventListener("message", onMessage);
		});
		let loaded = loadedOnce();
		await send("Page.navigate", { url: `${origin}/favicon.ico` });
		await loaded;
		await evaluate("(() => { try { const key = 'cozyclay.project-session.v1'; if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ name: 'QA', updatedAt: Date.now() })); } catch {} })()");
		loaded = loadedOnce();
		await send("Page.navigate", { url });
		await loaded;
	} finally {
		ws.close();
	}
}

try {
	await fetch(cdpUrl);
	throw new Error(`CDP port ${port} is already in use; stop the existing QA browser first`);
} catch (error) {
	if (!String(error?.message).includes("fetch failed")) throw error;
}

	const profileDir = mkdtempSync(join(tmpdir(), "cozyclay-qa-"));
const children = [];
let removeSignalCleanup = () => {};
const cleanupProfile = () => rmSync(profileDir, { recursive: true, force: true });

try {
	const chrome = spawnOwned(chromePath, [
		"--headless=new",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profileDir}`,
		`--window-size=${process.env.QA_WINDOW || "1600,1000"}`,
		...chromeFlags,
		bootstrapUrl,
	]);
	children.push(chrome);
	removeSignalCleanup = installSignalCleanup(() => children, cleanupProfile);

	// Chrome's first launch on a cold CI runner (SwiftShader, no GPU process
	// cache) can take well over ten seconds to bring the DevTools port up, and
	// a timeout here reads as a suite failure with zero checks run. Thirty
	// seconds covers what the gating jobs have been seen to need; QA_CDP_TIMEOUT_MS
	// overrides it.
	const deadline = Date.now() + Number(process.env.QA_CDP_TIMEOUT_MS || 30000);
	while (true) {
		if (chrome.exitCode !== null || chrome.signalCode !== null) {
			throw new Error("QA browser exited before CDP became ready");
		}
		try {
			const response = await fetch(cdpUrl);
			if (response.ok) break;
		} catch {
			// Browser startup is asynchronous; retry within the bounded deadline.
		}
		if (Date.now() >= deadline) throw new Error("QA browser CDP startup timed out");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	// The studio opens a modal project chooser on a first run (no project
	// session in storage). Its dialog sits over the viewport and takes the
	// pointer, so every canvas press a suite dispatches lands on the dialog
	// instead of the gizmo — the suite then reads "nothing moved" as a
	// regression (#83). Seed a session before navigation so QA drives the
	// studio a returning author sees. QA_STARTUP_CHOOSER=1 keeps the chooser
	// for suites that exercise it.
	if (process.env.QA_STARTUP_CHOOSER !== "1") await seedProjectSession(port, bootstrapUrl);

	const runner = spawnOwned(command, commandArgs, {
		env: { ...process.env, CDP_PORT: String(port) },
	});
	children.push(runner);
	const first = await Promise.race([
		waitForExit(runner).then((result) => ({ owner: "runner", ...result })),
		waitForExit(chrome).then((result) => ({ owner: "chrome", ...result })),
	]);
	if (first.owner === "chrome") await terminateOwned(runner);
	process.exitCode = first.owner === "runner" ? (first.code ?? 1) : 1;
} finally {
	removeSignalCleanup();
	await Promise.allSettled(children.map((child) => terminateOwned(child)));
	cleanupProfile();
}
