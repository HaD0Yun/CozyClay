#!/usr/bin/env node
// Where a motion run writes its files (bin/agent/motion-files.mjs), made here with scenes and specs of this test:
// 1. a source checkout keeps today's places under the checkout (lowvis-out/pi/<name>/, public/lowvis/clips/pi/<name>.json);
//    an installed package (no .git) writes each run into <config>/motion-runs/<name>/, the config folder of
//    COZYCLAY_CONFIG_DIR, else XDG_CONFIG_HOME/cozyclay; the newest 20 runs are kept, older ones go when a run starts
// 2. in a copy of the package with no .git and its folder read-only, the compile tool and runScene write nothing under
//    the package: the run record, the sheets and the clip land in the config folder
// 3. bin/cozyclay.mjs serves such a clip at the address the page fetches (/lowvis/clips/pi/<name>.json), and hands the
//    page the look it was launched with (COZYCLAY_FIGURE), the value the sidecar in the same process reads
import "./block-figure.mjs"; // the block figure's numbers (figure.js: the launch names the look)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runFiles } from "../../bin/agent/motion-files.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url)), TMP = mkdtempSync(join(tmpdir(), "motion-files-"));
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isSymbolicLink() ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const pkg = join(TMP, "package"), config = join(TMP, "config");
try {
	// --- 1: the layout ---
	{
		const here = runFiles("agent-a");
		assert.deepEqual([here.outDir, here.clipFile], [join(REPO, "lowvis-out/pi/agent-a"), join(REPO, "public/lowvis/clips/pi/agent-a.json")], "a checkout: today's places");
		const bare = join(TMP, "bare");
		mkdirSync(bare);
		const xdg = runFiles("agent-a", { root: bare, env: { XDG_CONFIG_HOME: join(TMP, "xdg") } }), own = runFiles("agent-a", { root: bare, env: { XDG_CONFIG_HOME: join(TMP, "xdg"), COZYCLAY_CONFIG_DIR: join(TMP, "own") } });
		assert.deepEqual([xdg.outDir, xdg.clipFile], [join(TMP, "xdg/cozyclay/motion-runs/agent-a"), join(TMP, "xdg/cozyclay/motion-runs/agent-a/clip.json")], "installed: the user's config folder");
		assert.equal(own.outDir, join(TMP, "own/motion-runs/agent-a"), "COZYCLAY_CONFIG_DIR names the config folder, as for the sessions");
		assert.throws(() => runFiles("../x", { root: bare }), /letters, digits/, "a name is never a path");
		// 25 older runs: a run that starts keeps the newest 19 of them, itself the 20th
		const runs = join(TMP, "own/motion-runs");
		for (let k = 0; k < 25; k++) { const dir = join(runs, `agent-${k}`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "run.json"), "{}"); utimesSync(dir, 1000 + k, 1000 + k); }
		runFiles("agent-new", { root: bare, env: { COZYCLAY_CONFIG_DIR: join(TMP, "own") }, prune: true });
		assert.deepEqual(readdirSync(runs).sort(), Array.from({ length: 19 }, (_, k) => `agent-${k + 6}`).sort(), "the newest 19 runs stay, the 6 oldest are removed");
		assert.equal(runFiles("agent-a", { root: here.outDir }).kept, 20);
		// a checkout's run clips (public/lowvis/clips/pi) never go into a build: vite would copy public/ into dist and the package
		assert.match(readFileSync(join(REPO, "vite.config.js"), "utf8"), /apply: "build",\s*closeBundle: \(\) => rmSync\(resolve\(import\.meta\.dirname, "dist\/lowvis\/clips\/pi"\)/, "the build leaves the run clips out");
		console.log("ok layout: a checkout keeps today's places; an installed package writes into the config folder and keeps the newest 20 runs");
	}

	// --- 2: a copy of the package (no .git), read-only: nothing is written under it ---
	mkdirSync(pkg);
	for (const dir of ["bin", "src"]) cpSync(join(REPO, dir), join(pkg, dir), { recursive: true });
	cpSync(join(REPO, "package.json"), join(pkg, "package.json"));
	mkdirSync(join(pkg, "dist/app"), { recursive: true });
	writeFileSync(join(pkg, "dist/app/index.html"), "<!doctype html><html><head></head><body></body></html>");
	symlinkSync(join(REPO, "node_modules"), join(pkg, "node_modules"), "dir");
	const before = walk(pkg).map(f => relative(pkg, f)).sort();
	const writable = [];
	const lock = mode => { for (const dir of [pkg, ...readdirSync(pkg, { recursive: true, withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => join(e.parentPath, e.name))]) { if (mode === "ro") writable.push(dir); chmodSync(dir, mode === "ro" ? 0o555 : 0o755); } };
	lock("ro");
	try {
		process.env.COZYCLAY_CONFIG_DIR = config;
		const { createCompileTool } = await import(join(pkg, "src/lowvis/pi/compile-tool.mjs"));
		const { runScene } = await import(join(pkg, "src/lowvis/pi/harness.mjs"));
		const tool = createCompileTool({ name: "agent-copy", variant: "studio" });
		const r = tool.call({ scene: { frames: 24, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [] }, spec: { a: [[0, "idle"]] } });
		assert.equal(r.status, "ok", r.error);
		assert.equal(tool.clipFile, join(config, "motion-runs/agent-copy/clip.json"));
		assert.ok(JSON.parse(readFileSync(tool.clipFile, "utf8")).frameCount === 24, "the clip is in the run's folder");
		assert.ok(r.files.length && r.files.every(f => f.startsWith(join(config, "motion-runs/agent-copy/")) && existsSync(f)), "and the sheets");
		const record = await runScene({ name: "agent-copy-run", request: "x", variant: "studio", env: { COZYCLAY_CONFIG_DIR: config } });
		assert.equal(record.infraError?.at, "setup", "no proxy in this test: the run stops before a model call");
		assert.ok(existsSync(join(config, "motion-runs/agent-copy-run/run.json")), "the run record is in the run's folder");
		assert.deepEqual(walk(pkg).map(f => relative(pkg, f)).sort(), before, "nothing is created under the package");
		console.log("ok a read-only package with no .git: the clip, the sheets and the run record go to the config folder, nothing under the package");

		// --- 3: the launcher serves the clip and hands the page the look ---
		const port = await new Promise((resolve, reject) => { const s = createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
		const { COZYCLAY_FIGURE: _named, ...unnamed } = process.env; // a launch that names no look
		const launch = async named => {
			const child = spawn(process.execPath, ["bin/cozyclay.mjs", "--port", String(port), "--no-open", "--no-star", "--no-update-check"], { cwd: pkg, env: { ...unnamed, ...named, CI: "", DO_NOT_TRACK: "1", XDG_CONFIG_HOME: join(TMP, "xdg-launch"), COZYCLAY_CONFIG_DIR: config, COZYCLAY_LIVE_PORT: String(port + 1) }, stdio: ["ignore", "pipe", "pipe"] });
			let said = "";
			child.stdout.on("data", d => { said += d; }); child.stderr.on("data", d => { said += d; });
			for (let i = 0; i < 100 && !said.includes("is running at"); i++) await new Promise(r => setTimeout(r, 100));
			assert.ok(said.includes("is running at"), said);
			return { child, get: path => fetch(`http://127.0.0.1:${port}${path}`) };
		};
		for (const [named, handed] of [[{}, ""], [{ COZYCLAY_FIGURE: "block" }, "block"]]) {
			const { child, get } = await launch(named);
			try {
				const clip = await get("/lowvis/clips/pi/agent-copy.json");
				assert.equal(clip.status, 200, "the run's clip at the address the page fetches");
				assert.equal(await clip.text(), readFileSync(tool.clipFile, "utf8"));
				assert.equal((await get("/lowvis/clips/pi/agent-none.json")).status, 404, "no such run: not found");
				assert.equal((await get("/lowvis/clips/pi/..%2Fx.json")).status, 404, "a name is never a path");
				const page = await (await get("/app/")).text();
				assert.ok(page.includes(`window.__COZYCLAY_FIGURE__ = ${JSON.stringify(handed)};`), `the page is handed ${JSON.stringify(handed)}`);
			} finally { child.kill("SIGTERM"); await new Promise(r => child.once("exit", r)); }
		}
		console.log("ok the launcher: the run's clip at /lowvis/clips/pi/<name>.json; the page is handed the launch's look");
	} finally { lock("rw"); }
	assert.ok(writable.length > 0);
	console.log("PASS verify-motion-files");
} finally {
	rmSync(TMP, { recursive: true, force: true });
}
