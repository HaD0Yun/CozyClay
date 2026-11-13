#!/usr/bin/env node
// Records every comparison video into lowvis-out/:
//   <demo>-engines.mp4   one panel per engine that has the demo, box look
//   looks.mp4            box, capsule and stick side by side on one clip
// Starts the vite dev server on port 5193 (or reuses one that already answers there) and stops what it started.
//
//   node tools/lowvis/record-all.mjs [--engines a,b] [--demos locomotion,sit] [--looks-clip <engine>/<demo>]
//                                    [--size 1920x1080] [--view three|front|side|top] [--out lowvis-out] [--only engines|looks]
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEMO_IDS } from "../../src/lowvis/demos.js";
import { parseArgs, record } from "./record.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const PORT = 5193;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLIPS = join(ROOT, "public/lowvis/clips");
// Real engines first, the placeholder last.
const ORDER = ["m3-xbot", "m3-17", "simple", "sample"];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pageAnswers = async () => { try { return (await fetch(`${ORIGIN}/lowvis/`)).ok; } catch { return false; } };

async function ensureServer() {
	if (await pageAnswers()) { console.log(`reusing the dev server on ${PORT}`); return async () => {}; }
	const child = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
	const stop = async () => {
		if (child.exitCode !== null) return;
		child.kill("SIGTERM");
		await Promise.race([new Promise(r => child.once("exit", r)), sleep(3000)]);
		if (child.exitCode === null) child.kill("SIGKILL");
	};
	for (let i = 0; !(await pageAnswers()); i++) {
		if (child.exitCode !== null) throw new Error(`vite exited at startup (is port ${PORT} taken by something else?)`);
		if (i > 600) { await stop(); throw new Error("vite did not answer in 60 s"); }
		await sleep(100);
	}
	console.log(`started the dev server on ${PORT}`);
	return stop;
}

const a = parseArgs(process.argv.slice(2));
const outDir = resolve(ROOT, typeof a.out === "string" ? a.out : "lowvis-out");
const size = typeof a.size === "string" ? a.size : "1920x1080";
const view = typeof a.view === "string" ? `&view=${a.view}` : "";
const wantEngines = typeof a.engines === "string" ? a.engines.split(",") : null;
const demos = typeof a.demos === "string" ? a.demos.split(",") : DEMO_IDS;

const found = existsSync(CLIPS) ? readdirSync(CLIPS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];
const engines = found
	.filter(e => readdirSync(join(CLIPS, e)).some(f => f.endsWith(".json")) && (!wantEngines || wantEngines.includes(e)))
	.sort((x, y) => (ORDER.indexOf(x) + 1 || 50) - (ORDER.indexOf(y) + 1 || 50) || x.localeCompare(y));
if (!engines.length) { console.error(`no clips under ${CLIPS}`); process.exit(1); }
const has = (engine, demo) => existsSync(join(CLIPS, engine, `${demo}.json`));
console.log(`engines: ${engines.join(", ")}`);

const jobs = [];
if (a.only !== "looks") for (const demo of demos) {
	const panels = engines.filter(e => has(e, demo)).map(e => `${e}/${demo}:box`);
	if (panels.length) jobs.push({ out: join(outDir, `${demo}-engines.mp4`), panels });
	else console.log(`${demo}: no engine has it, skipped`);
}
if (a.only !== "engines") {
	const looksClip = typeof a["looks-clip"] === "string" ? a["looks-clip"] : `${engines[0]}/locomotion`;
	jobs.push({ out: join(outDir, "looks.mp4"), panels: ["box", "capsule", "stick"].map(l => `${looksClip}:${l}`), cols: 3 });
}

const stopServer = await ensureServer();
let failed = 0;
try {
	for (const job of jobs) {
		const url = `${ORIGIN}/lowvis/?panels=${job.panels.join(",")}${view}${job.cols ? `&cols=${job.cols}` : ""}&autoplay=0`;
		console.log(`recording ${job.out}\n  ${url}`);
		try {
			const r = await record({ url, out: job.out, size });
			console.log(`  ${r.frames} frames in ${r.seconds} s, capture ${r.captureFps} frames/s`);
		} catch (error) {
			failed++;
			console.error(`  FAILED: ${error.message}`);
		}
	}
} finally {
	await stopServer();
}
process.exit(failed ? 1 : 0);
