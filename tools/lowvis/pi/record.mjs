#!/usr/bin/env node
// Records the clips the pi harness wrote (public/lowvis/clips/pi/<name>.json) to lowvis-out/pi/<name>.mp4 with the
// lowvis recorder. Starts the vite dev server on port 5193 (or uses one that answers there) and stops what it started.
//   node tools/lowvis/pi/record.mjs [--names push,chop] [--size 1280x720] [--view three|front|side|top] [--port 5193] [--look box|block|man|...]
// A look other than box writes lowvis-out/pi/<name>.<look>.mp4.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { record } from "../record.mjs";

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
const ROOT = resolve(import.meta.dirname, "../../.."), PORT = Number(opt.port ?? 5193), ORIGIN = `http://127.0.0.1:${PORT}`, CLIPS = join(ROOT, "public/lowvis/clips/pi");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const answers = async () => { try { return (await fetch(`${ORIGIN}/lowvis/`)).ok; } catch { return false; } };

async function ensureServer() {
	if (await answers()) { console.log(`using the dev server on ${PORT}`); return async () => {}; }
	const child = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
	const stop = async () => {
		if (child.exitCode !== null) return;
		child.kill("SIGTERM");
		await Promise.race([new Promise(r => child.once("exit", r)), sleep(3000)]);
		if (child.exitCode === null) child.kill("SIGKILL");
	};
	for (let i = 0; !(await answers()); i++) {
		if (child.exitCode !== null) throw new Error(`vite exited at startup (is port ${PORT} taken?)`);
		if (i > 600) { await stop(); throw new Error("vite did not answer in 60 s"); }
		await sleep(100);
	}
	console.log(`started the dev server on ${PORT}`);
	return stop;
}

const names = opt.names ? opt.names.split(",") : existsSync(CLIPS) ? readdirSync(CLIPS).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)) : [];
if (!names.length) { console.error(`no clips under ${CLIPS}`); process.exit(1); }
const stop = await ensureServer();
let failed = 0;
try {
	for (const name of names) {
		const look = opt.look ?? "box", out = join(ROOT, "lowvis-out/pi", look === "box" ? `${name}.mp4` : `${name}.${look}.mp4`), url = `${ORIGIN}/lowvis/?panels=pi/${name}:${look}${opt.view ? `&view=${opt.view}` : ""}&autoplay=0`;
		if (!existsSync(join(CLIPS, `${name}.json`))) { failed++; console.error(`${name}: no clip`); continue; }
		try { const r = await record({ url, out, size: opt.size ?? "1280x720" }); console.log(`${out}: ${r.frames} frames in ${r.seconds} s`); } catch (error) { failed++; console.error(`${name}: FAILED: ${error.message}`); }
	}
} finally {
	await stop();
}
process.exit(failed ? 1 : 0);
