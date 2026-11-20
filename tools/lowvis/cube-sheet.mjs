#!/usr/bin/env node
// Renders the cube look comparison sheet (tools/lowvis/cube-sheet.html) to PNG: starts the dev server, opens the page
// in headless Chrome over CDP, saves a PNG of the sheet and the measured numbers as JSON next to it, stops both.
//
//   node tools/lowvis/cube-sheet.mjs --out <file.png> [--pose stand|t] [--cols A:old:0.9,C:look:0.81,...]
//                                    [--shapes '{"old":{"armTopX":0.177}}']   (named sets laid over the look's CUBE_SHAPE)
//                                    [--port 5198] [--cdp 9344]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { out: { type: "string" }, pose: { type: "string", default: "stand" }, cols: { type: "string" }, shapes: { type: "string" }, port: { type: "string", default: "5198" }, cdp: { type: "string", default: "9344" } } });
if (!a.out) throw new Error("--out <file.png> is required");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = resolve(import.meta.dirname, "../..");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const answers = async url => { try { return (await fetch(url)).ok; } catch { return false; } };
const until = async (what, test, ms = 60000) => { for (const t0 = Date.now(); !(await test());) { if (Date.now() - t0 > ms) throw new Error(`${what} did not come up`); await sleep(200); } };
const stop = async child => { if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise(r => child.once("exit", r)), sleep(3000)]); } if (child.exitCode === null) child.kill("SIGKILL"); };

const base = `http://127.0.0.1:${a.port}`;
if (await answers(base)) throw new Error(`port ${a.port} is in use`);
if (await answers(`http://127.0.0.1:${a.cdp}/json/version`)) throw new Error(`port ${a.cdp} is in use`);
const vite = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "--port", a.port, "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "cube-sheet-"));
let chrome = null;
try {
	await until("dev server", () => answers(`${base}/tools/lowvis/cube-sheet.html`));
	chrome = spawn(CHROME, ["--headless=new", "--password-store=basic", "--use-angle=metal", "--enable-webgl", "--ignore-gpu-blocklist", `--remote-debugging-port=${a.cdp}`,
		`--user-data-dir=${profile}`, "--window-size=2400,1600", "--force-device-scale-factor=1", "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
	await until("Chrome", () => answers(`http://127.0.0.1:${a.cdp}/json/version`));
	const page = (await (await fetch(`http://127.0.0.1:${a.cdp}/json`)).json()).find(t => t.type === "page");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
	let id = 0;
	const pending = new Map();
	ws.onmessage = e => { const m = JSON.parse(e.data), p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p[1](new Error(m.error.message)) : p[0](m.result); };
	const send = (method, params = {}) => new Promise((ok, fail) => { pending.set(++id, [ok, fail]); ws.send(JSON.stringify({ id, method, params })); });
	const value = async expression => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
	const query = new URLSearchParams({ pose: a.pose, ...(a.cols && { cols: a.cols }), ...(a.shapes && { shapes: a.shapes }) });
	await send("Page.navigate", { url: `${base}/tools/lowvis/cube-sheet.html?${query}` });
	await until("sheet", async () => (await value("document.title")) === "ready", 90000);
	const { w, h } = await value("(() => { const c = document.getElementById('c'); return { w: c.width, h: c.height }; })()");
	const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, captureBeyondViewport: true });
	mkdirSync(dirname(resolve(a.out)), { recursive: true });
	writeFileSync(a.out, Buffer.from(shot.data, "base64"));
	const numbers = await value("document.getElementById('numbers').textContent");
	writeFileSync(a.out.replace(/\.png$/, ".json"), `${JSON.stringify(JSON.parse(numbers), null, 1)}\n`);
	console.log(`${a.out} ${w}x${h}`);
	ws.close();
} finally {
	if (chrome) await stop(chrome);
	await stop(vite);
	rmSync(profile, { recursive: true, force: true });
}
