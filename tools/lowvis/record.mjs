#!/usr/bin/env node
// Records the lowvis viewer page to an mp4: headless Chrome over CDP, lowvis.seek(f) frame by frame, one
// screenshot per frame piped to ffmpeg at the clip's fps.
//
//   node tools/lowvis/record.mjs --url <viewer url> --out <file.mp4> [--size 1920x1080] [--port 9330]
//                                [--format jpeg|png] [--from <frame>] [--to <frame, exclusive>] [--still <file.png> --frame <f>]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = process.env.FFMPEG_PATH || (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");
// Without these the canvas stops rendering when the Mac's display sleeps, or Chrome falls back to software GL.
const CHROME_FLAGS = [
	"--headless=new",
	"--disable-features=CalculateNativeWinOcclusion",
	"--disable-backgrounding-occluded-windows",
	"--disable-renderer-backgrounding",
	"--disable-background-timer-throttling",
	"--use-angle=metal",
	"--enable-webgl",
	"--enable-gpu",
	"--ignore-gpu-blocklist",
];
const PORTS = [9330, 9331, 9332, 9333, 9334, 9335, 9336, 9337, 9338, 9339];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const answers = async url => { try { return (await fetch(url)).ok; } catch { return false; } };

async function launchChrome({ width, height, port }) {
	if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);
	let cdpPort = port;
	if (!cdpPort) for (const p of PORTS) if (!(await answers(`http://127.0.0.1:${p}/json/version`))) { cdpPort = p; break; }
	if (!cdpPort) throw new Error("no free CDP port in 9330-9339");
	const profile = mkdtempSync(join(tmpdir(), "lowvis-record-"));
	const child = spawn(CHROME, [
		...CHROME_FLAGS,
		`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
		"--force-device-scale-factor=1", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "about:blank",
	], { stdio: "ignore" });
	const close = async () => {
		if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise(r => child.once("exit", r)), sleep(3000)]); }
		if (child.exitCode === null) child.kill("SIGKILL");
		rmSync(profile, { recursive: true, force: true });
	};
	try {
		for (let i = 0; !(await answers(`http://127.0.0.1:${cdpPort}/json/version`)); i++) {
			if (child.exitCode !== null) throw new Error("Chrome exited at startup");
			if (i > 300) throw new Error("Chrome CDP did not answer in 30 s");
			await sleep(100);
		}
		const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
		const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
		if (!page) throw new Error("Chrome exposed no page target");
		const ws = new WebSocket(page.webSocketDebuggerUrl);
		await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error("CDP socket failed")); });
		let nextId = 1;
		const pending = new Map();
		ws.onmessage = event => {
			const msg = JSON.parse(event.data);
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			if (msg.error) p.fail(new Error(`${p.method}: ${msg.error.message}`)); else p.ok(msg.result);
		};
		const send = (method, params = {}) => new Promise((ok, fail) => { const id = nextId++; pending.set(id, { ok, fail, method }); ws.send(JSON.stringify({ id, method, params })); });
		const evaluate = async expression => {
			const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
			return r.result.value;
		};
		return { send, evaluate, close: async () => { try { ws.close(); } catch { /* already closed */ } await close(); } };
	} catch (error) {
		await close();
		throw error;
	}
}

/**
 * Records `url` to `out`. Returns { frames, fps, seconds, captureFps, out }.
 * `still: { file, frame }` also (or, with no `out`, only) writes one PNG of that frame.
 */
export async function record({ url, out, size = "1920x1080", port, format = "jpeg", from = 0, to, still, log = () => {} }) {
	const [width, height] = size.split("x").map(Number);
	if (!(width > 0 && height > 0) || width % 2 || height % 2) throw new Error(`--size ${size}: want even WxH`);
	const chrome = await launchChrome({ width, height, port });
	let ffmpeg = null;
	try {
		await chrome.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
		await chrome.send("Page.enable");
		await chrome.send("Page.navigate", { url });
		let info = null;
		for (let i = 0; !info; i++) {
			if (i > 600) throw new Error(`window.lowvis did not appear at ${url} in 60 s`);
			await sleep(100);
			info = await chrome.evaluate("window.lowvis ? window.lowvis.ready.then(() => { window.lowvis.pause(); return { fps: window.lowvis.fps, frameCount: window.lowvis.frameCount }; }) : null").catch(() => null);
		}
		const shot = async (f, fmt) => {
			await chrome.evaluate(`window.lowvis.seek(${f})`);
			const r = await chrome.send("Page.captureScreenshot", fmt === "png" ? { format: "png" } : { format: "jpeg", quality: 95 });
			return Buffer.from(r.data, "base64");
		};
		if (still) {
			mkdirSync(dirname(resolve(still.file)), { recursive: true });
			writeFileSync(still.file, await shot(still.frame ?? 0, "png"));
		}
		if (!out) return { frames: 0, fps: info.fps, seconds: 0, captureFps: 0, out: null };

		const end = Math.min(to ?? info.frameCount, info.frameCount);
		mkdirSync(dirname(resolve(out)), { recursive: true });
		ffmpeg = spawn(FFMPEG, [
			"-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", format === "png" ? "png" : "mjpeg", "-framerate", String(info.fps), "-i", "-",
			"-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-color_range", "tv", "-movflags", "+faststart", out,
		], { stdio: ["pipe", "ignore", "pipe"] });
		let ffmpegErr = "";
		ffmpeg.stderr.on("data", d => { ffmpegErr += d; });
		const done = new Promise(r => ffmpeg.once("exit", code => r(code)));
		ffmpeg.stdin.on("error", () => {}); // a dead ffmpeg is reported through its exit code
		const t0 = performance.now();
		for (let f = from; f < end; f++) {
			const image = await shot(f, format);
			if (!ffmpeg.stdin.write(image)) await new Promise(r => ffmpeg.stdin.once("drain", r));
			if ((f - from) % 100 === 0) log(`  frame ${f}/${end}`);
		}
		const captureSeconds = (performance.now() - t0) / 1000;
		ffmpeg.stdin.end();
		const code = await done;
		if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${ffmpegErr.trim()}`);
		const frames = end - from;
		return { frames, fps: info.fps, seconds: +((performance.now() - t0) / 1000).toFixed(2), captureFps: +(frames / captureSeconds).toFixed(1), out };
	} finally {
		if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill("SIGKILL");
		await chrome.close();
	}
}

/** `--name value` pairs of argv as an object. */
export function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
	return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const a = parseArgs(process.argv.slice(2));
	if (!a.url || (!a.out && !a.still)) {
		console.error("usage: node tools/lowvis/record.mjs --url <viewer url> --out <file.mp4> [--size 1920x1080] [--port 9330] [--format jpeg|png] [--from f] [--to f] [--still file.png --frame f]");
		process.exit(2);
	}
	const result = await record({
		url: a.url, out: a.out === true ? undefined : a.out, size: a.size || "1920x1080", port: a.port ? Number(a.port) : undefined, format: a.format || "jpeg",
		from: a.from ? Number(a.from) : 0, to: a.to ? Number(a.to) : undefined,
		still: a.still ? { file: a.still, frame: Number(a.frame || 0) } : undefined, log: console.error,
	});
	console.log(JSON.stringify(result));
}
