#!/usr/bin/env node
// Renders the cube look comparison video: one spec (tools/lowvis/cube-motion-spec.js, or --spec <file.js|json>)
// built by engine-simple once per lane at that lane's body scale, drawn by tools/lowvis/cube-motion.html (the cube
// look, one orthographic camera for every lane), stepped frame by frame in headless Chrome and piped to ffmpeg.
//
//   node tools/lowvis/cube-motion.mjs --out <file.mp4> [--view three|side] [--lanes A:now:0.9,B:b:0.9,C:b:0.81]
//                                     [--b '{"armTopX":0.15}'] [--spec <module with SCENE and SPEC>] [--check]
//                                     [--port 5198] [--cdp 9344] [--width 1920] [--height 800]
// --check: build and print the engine's check rows per lane, render nothing.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip, validateClip } from "../../src/lowvis/clip.js";
import { badness, isSpike, measure } from "../../src/lowvis/pi/measure.mjs";

const { values: a } = parseArgs({ options: {
	out: { type: "string" }, view: { type: "string", default: "three" }, lanes: { type: "string", default: "A:now:0.9,B:b:0.9,C:b:0.81" },
	b: { type: "string" }, spec: { type: "string" }, check: { type: "boolean" }, port: { type: "string", default: "5198" }, cdp: { type: "string", default: "9344" },
	width: { type: "string", default: "1920" }, height: { type: "string", default: "800" },
} });
const ROOT = resolve(import.meta.dirname, "../..");
const { SCENE, SPEC } = await import(a.spec ? pathToFileURL(resolve(a.spec)).href : "./cube-motion-spec.js");
const LANES = a.lanes.split(",").map(s => { const [name, shape, scale] = s.split(":"); return { name, shape, scale: +scale }; });

// One clip per lane: the same spec and scene, the character at the lane's scale.
for (const lane of LANES) {
	const def = { frames: SCENE.frames, props: SCENE.props, characters: [{ id: "a", at: [0, 0], heading: 0, ...(lane.scale !== 1 && { scale: lane.scale }) }] };
	const { clip, aux } = buildClip(SPEC, def);
	const json = JSON.parse(serializeClip(clip));
	const v = validateClip(json);
	const rows = measure(json, aux, { stretch: v.maxStretch ?? 0 });
	lane.clip = json;
	lane.spikes = rows.filter(isSpike).map(r => `${r.label} ${r.value.toFixed(0)} ${r.unit} at f${r.frame} (spike ${r.spike})`);
	lane.rows = rows;
	lane.notes = json.notes ?? [];
	console.log(`${lane.name} scale ${lane.scale}: ${lane.spikes.length ? `past spike: ${lane.spikes.join("; ")}` : "no row past its spike"}${lane.notes.length ? ` | notes: ${JSON.stringify(lane.notes)}` : ""}`);
	if (a.check) for (const r of rows) console.log(`  ${r.label}: ${r.value?.toFixed?.(1)} ${r.unit ?? ""}${r.frame != null ? ` f${r.frame}` : ""}${r.spike != null ? ` (spike ${r.spike}, ${badness(r) > r.spike ? "PAST" : "under"})` : ""}`);
}
if (a.check) process.exit(0);
if (!a.out) throw new Error("--out <file.mp4> is required");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const answers = async url => { try { return (await fetch(url)).ok; } catch { return false; } };
const until = async (what, test, ms = 60000) => { for (const t0 = Date.now(); !(await test());) { if (Date.now() - t0 > ms) throw new Error(`${what} did not come up`); await sleep(200); } };
const stop = async child => { if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise(r => child.once("exit", r)), sleep(3000)]); } if (child.exitCode === null) child.kill("SIGKILL"); };

const base = `http://127.0.0.1:${a.port}`, W = +a.width, H = +a.height;
if (await answers(base)) throw new Error(`port ${a.port} is in use`);
if (await answers(`http://127.0.0.1:${a.cdp}/json/version`)) throw new Error(`port ${a.cdp} is in use`);
const vite = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "--port", a.port, "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "cube-motion-"));
let chrome = null, ffmpeg = null;
try {
	await until("dev server", () => answers(`${base}/tools/lowvis/cube-motion.html`));
	chrome = spawn(CHROME, ["--headless=new", "--password-store=basic", "--use-angle=metal", "--enable-webgl", "--ignore-gpu-blocklist", `--remote-debugging-port=${a.cdp}`,
		`--user-data-dir=${profile}`, `--window-size=${W},${H}`, "--force-device-scale-factor=1", "--hide-scrollbars", "--no-first-run",
		"--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "about:blank"], { stdio: "ignore" });
	await until("Chrome", () => answers(`http://127.0.0.1:${a.cdp}/json/version`));
	const page = (await (await fetch(`http://127.0.0.1:${a.cdp}/json`)).json()).find(t => t.type === "page");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
	let id = 0;
	const pending = new Map();
	ws.onmessage = e => { const m = JSON.parse(e.data), p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p[1](new Error(m.error.message)) : p[0](m.result); };
	const send = (method, params = {}) => new Promise((ok, fail) => { pending.set(++id, [ok, fail]); ws.send(JSON.stringify({ id, method, params })); });
	const value = async expression => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
	await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
	await send("Page.navigate", { url: `${base}/tools/lowvis/cube-motion.html` });
	await until("page", async () => (await value("typeof window.cubeMotion")) === "object", 90000);
	const data = { view: a.view, b: a.b ? JSON.parse(a.b) : {}, width: W, height: H, props: SCENE.props, lanes: LANES.map(({ name, shape, scale, clip }) => ({ name, shape, scale, clip })) };
	const info = await value(`window.cubeMotion.load(${JSON.stringify(data)})`);
	mkdirSync(dirname(resolve(a.out)), { recursive: true });
	ffmpeg = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "png", "-framerate", "24", "-i", "-",
		"-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", a.out], { stdio: ["pipe", "ignore", "inherit"] });
	const done = new Promise(r => ffmpeg.once("exit", r));
	for (let f = 0; f < info.frames; f++) {
		await value(`window.cubeMotion.seek(${f})`);
		const shot = await send("Page.captureScreenshot", { format: "png" });
		if (!ffmpeg.stdin.write(Buffer.from(shot.data, "base64"))) await new Promise(r => ffmpeg.stdin.once("drain", r));
	}
	ffmpeg.stdin.end();
	if ((await done) !== 0) throw new Error("ffmpeg failed");
	ffmpeg = null;
	console.log(`${a.out}: ${info.frames} frames, ${(info.frames / 24).toFixed(2)} s, ${W}x${H}; heights ${info.heights.map(h => h.toFixed(3)).join(", ")} m`);
	ws.close();
} finally {
	if (ffmpeg) await stop(ffmpeg);
	if (chrome) await stop(chrome);
	await stop(vite);
	rmSync(profile, { recursive: true, force: true });
}
