#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	installSignalCleanup,
	spawnOwned,
	terminateOwned,
	waitForExit,
} from "./process-supervisor.mjs";
import { browserSession } from "./qa-browser-session.mjs";

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
const timeoutMs = Number(process.env.QA_CDP_TIMEOUT_MS || 30000);

try {
	await fetch(cdpUrl, { signal: AbortSignal.timeout(1000) });
	throw new Error(`CDP port ${port} is already in use; stop the existing QA browser first`);
} catch (error) {
	if (!String(error?.message).includes("fetch failed")) throw error;
}

const profileDir = mkdtempSync(join(tmpdir(), "cozyclay-qa-"));
const children = [];
let removeSignalCleanup = () => {};
const cleanupProfile = () => rmSync(profileDir, { recursive: true, force: true });
const started = Date.now(), events = [];
let chrome, session, phase = "cdp", stderr = "", cdpReady = false;
let cdpMs, runnerMs, failure;
const chromeEnv = { ...process.env };
// This throwaway profile has no credentials to unlock. Inheriting the desktop
// bus can block HTTP navigation on a locked keyring even after CDP is listening.
if (process.platform === "linux") {
	delete chromeEnv.DBUS_SESSION_BUS_ADDRESS;
	delete chromeEnv.XDG_RUNTIME_DIR;
}

try {
	chrome = spawnOwned(chromePath, [
		"--headless=new",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profileDir}`,
		`--window-size=${process.env.QA_WINDOW || "1600,1000"}`,
		...(process.platform === "linux" ? ["--password-store=basic"] : []),
		...chromeFlags,
		// Do not begin (and then cancel) an app lifetime just to seed storage.
		"about:blank",
	], { env: chromeEnv, stdio: ["ignore", "inherit", "pipe"] });
	children.push(chrome);
	removeSignalCleanup = installSignalCleanup(() => children, cleanupProfile);

	// Chrome publishes this signal when the DevTools listener is bound. Subscribe
	// immediately; a stalled HTTP response must share the same startup deadline.
	const deadline = Date.now() + timeoutMs;
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error("QA browser CDP startup timed out")), timeoutMs);
		const finish = error => {
			clearTimeout(timer);
			chrome.off("exit", exited);
			chrome.off("error", failed);
			error ? reject(error) : resolve();
		};
		const exited = () => finish(new Error("QA browser exited before CDP became ready"));
		const failed = error => finish(error);
		chrome.once("exit", exited);
		chrome.once("error", failed);
		chrome.stderr.on("data", chunk => {
			process.stderr.write(chunk);
			stderr = (stderr + chunk).slice(-16000);
			if (/DevTools listening on ws:\/\//.test(stderr)) finish();
		});
	});
	const response = await fetch(cdpUrl, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
	if (!response.ok) throw new Error(`QA browser CDP readiness returned HTTP ${response.status}`);
	const version = await response.json();
	if (!version.webSocketDebuggerUrl) throw new Error("QA browser CDP readiness omitted its websocket URL");
	cdpReady = true;
	cdpMs = Date.now() - started;
	phase = "session";
	session = await browserSession(port, timeoutMs, events);

	// The studio opens a modal project chooser on a first run (no project
	// session in storage). Its dialog sits over the viewport and takes the
	// pointer, so every canvas press a suite dispatches lands on the dialog
	// instead of the gizmo — the suite then reads "nothing moved" as a
	// regression (#83). Seed a session before navigation so QA drives the
	// studio a returning author sees. QA_STARTUP_CHOOSER=1 keeps the chooser
	// for suites that exercise it.
	if (process.env.QA_STARTUP_CHOOSER !== "1") {
		await session.navigate(`${new URL(pageUrl).origin}/favicon.ico`);
		await session.evaluate("(() => { const key = 'cozyclay.project-session.v1'; if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ name: 'QA', updatedAt: Date.now() })); })()");
	}
	await session.navigate(bootstrapUrl);

	phase = "runner";
	runnerMs = Date.now() - started;
	console.log(`QA_BROWSER_READY ${JSON.stringify({ cdpMs, runnerMs })}`);
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
	if (process.exitCode) failure = `${first.owner} exited: code=${first.code} signal=${first.signal}`;
} catch (error) {
	failure = error.stack ?? String(error);
	process.exitCode = 1;
} finally {
	try {
		if (failure) {
			const diagnostic = {
				phase, failure, elapsedMs: Date.now() - started,
				chrome: { pid: chrome?.pid, exitCode: chrome?.exitCode, signalCode: chrome?.signalCode, stderr },
				cdp: { url: cdpUrl, ready: cdpReady, cdpMs, runnerMs }, events,
			};
			if (session) {
				try {
					diagnostic.document = await session.evaluate("({url:location.href,ready:document.readyState,body:document.body?.innerText.slice(0,3000),app:!!window.__cozyclay,rig:!!window.__cozyclay?.rigA})", 2000);
				} catch (error) { diagnostic.document = { error: error.message }; }
			}
			if (process.env.QA_SERVER_LOG) {
				try { diagnostic.serverLog = readFileSync(process.env.QA_SERVER_LOG, "utf8").slice(-16000); }
				catch (error) { diagnostic.serverLog = error.message; }
			}
			const out = process.env.QA_OUT ?? mkdtempSync(join(tmpdir(), "cozyclay-qa-evidence-"));
			mkdirSync(out, { recursive: true });
			writeFileSync(join(out, "qa-browser-failure.json"), JSON.stringify(diagnostic, null, 2));
			console.error(`QA_BROWSER_DIAGNOSTIC ${JSON.stringify(diagnostic)}`);
			console.error(`QA browser evidence: ${join(out, "qa-browser-failure.json")}`);
		}
	} finally {
		session?.close();
		removeSignalCleanup();
		await Promise.allSettled(children.map((child) => terminateOwned(child)));
		cleanupProfile();
		console.log(`QA_BROWSER_CLEANUP ${JSON.stringify({ pid: chrome?.pid, exitCode: chrome?.exitCode, signalCode: chrome?.signalCode, profileRemoved: !existsSync(profileDir) })}`);
	}
}
