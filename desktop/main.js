// CozyClay desktop (desktop/): one window with its own Chromium. It starts the newest cozyclay with the Node.js that
// ships inside the app, shows a loading page until the Studio answers, then opens the Studio in the same window.
// Closing the window (or Cmd+Q) stops CozyClay. Built and signed by .github/workflows/installer-macos.yml.
"use strict";
const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const READY = /CozyClay is running at (https?:\/\/\S+)/;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
let win = null;
let server = null;
let studioUrl = null;
let quitting = false;
let logTail = [];
let logFile = null;

function nodeDir() {
	const name = `node-${process.arch === "arm64" ? "arm64" : "x64"}`;
	const packaged = path.join(process.resourcesPath, name);
	return fs.existsSync(packaged) ? packaged : path.join(__dirname, "vendor", name);
}

function log(line) {
	logTail.push(line);
	if (logTail.length > 60) logTail.shift();
	try { fs.appendFileSync(logFile, `${line}\n`); } catch {}
}

function status(text) {
	if (win && !studioUrl) win.webContents.executeJavaScript(`setStatus(${JSON.stringify(text)})`).catch(() => {});
}

function statusFor(line) {
	if (/installing MCP server dependencies/i.test(line)) return "Setting up the agent tools (first start only)";
	if (/added \d+ packages/i.test(line)) return "Almost ready";
	return null;
}

function stopServer() {
	if (!server || server.exitCode !== null) return;
	const pid = server.pid;
	try { process.kill(-pid, "SIGTERM"); } catch {}
	setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 3000).unref();
}

function startServer() {
	studioUrl = null;
	const dir = nodeDir();
	const node = path.join(dir, "bin", "node");
	const npx = path.join(dir, "lib", "node_modules", "npm", "bin", "npx-cli.js");
	const args = [npx, "--yes", "cozyclay@latest", "--no-open", "--no-star", "--no-update-check", "--via", "installer"];
	log(`[desktop] ${new Date().toISOString()} starting ${node} ${args.join(" ")}`);
	status("Downloading the newest CozyClay");
	server = spawn(node, args, {
		cwd: os.homedir(),
		detached: true,
		env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH || "/usr/bin:/bin"}`, NODE_NO_WARNINGS: "1", COZYCLAY_DESKTOP: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const onData = (chunk) => {
		for (const raw of chunk.toString().split(/\r?\n/)) {
			const line = raw.replace(ANSI, "").trimEnd();
			if (!line) continue;
			log(line);
			const ready = !studioUrl && READY.exec(line);
			if (ready) {
				studioUrl = ready[1];
				win?.loadURL(studioUrl);
				continue;
			}
			const s = statusFor(line);
			if (s) status(s);
		}
	};
	server.stdout.on("data", onData);
	server.stderr.on("data", onData);
	server.on("error", (error) => log(`[desktop] ${error.message}`));
	server.on("exit", (code, signal) => {
		log(`[desktop] cozyclay exited (${signal || code})`);
		server = null;
		if (quitting) return;
		showFailure(code === 0 ? "CozyClay stopped." : `CozyClay stopped (exit ${signal || code}).`);
	});
}

function showFailure(text) {
	if (!win) return;
	const tail = logTail.slice(-25).join("\n");
	const show = () => win.webContents.executeJavaScript(`setFailed(${JSON.stringify(text)}, ${JSON.stringify(tail)})`).catch(() => {});
	if (studioUrl) {
		studioUrl = null;
		win.loadFile(path.join(__dirname, "loading.html")).then(show);
	} else show();
}

function isStudio(url) {
	return Boolean(studioUrl) && url.startsWith(new URL(studioUrl).origin);
}

function createWindow() {
	win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 600,
		title: "CozyClay",
		backgroundColor: "#16130f",
		show: false,
		webPreferences: { contextIsolation: true, sandbox: true },
	});
	win.once("ready-to-show", () => win.show());
	win.loadFile(path.join(__dirname, "loading.html"));
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (isStudio(url)) return { action: "allow" };
		shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		if (url.startsWith("file:") || isStudio(url)) return;
		event.preventDefault();
		shell.openExternal(url);
	});
	win.webContents.on("did-navigate-in-page", (_event, url) => {
		if (url.endsWith("#retry")) {
			logTail = [];
			win.loadFile(path.join(__dirname, "loading.html")).then(startServer);
		}
	});
	win.webContents.on("did-finish-load", () => {
		const smoke = process.env.COZYCLAY_DESKTOP_SMOKE;
		if (smoke && studioUrl && isStudio(win.webContents.getURL())) {
			fs.writeFileSync(smoke, `${studioUrl}\n${win.webContents.getTitle()}\n`);
			setTimeout(() => app.quit(), 1500);
		}
	});
	win.on("closed", () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.focus();
	});
	app.whenReady().then(() => {
		logFile = path.join(app.getPath("logs"), "cozyclay.log");
		fs.mkdirSync(path.dirname(logFile), { recursive: true });
		createWindow();
		startServer();
	});
	app.on("window-all-closed", () => app.quit());
	app.on("before-quit", () => { quitting = true; stopServer(); });
}
