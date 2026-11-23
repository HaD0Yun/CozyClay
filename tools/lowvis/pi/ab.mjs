#!/usr/bin/env node
// Runs every request of a file with each harness variant, several times, a few at once, and writes one table.
//   node tools/lowvis/pi/ab.mjs --requests <file.json> --tag <tag> [--variants base,lean] [--repeats 2] [--parallel 4] [--model <id>] [--effort <level>]
//   node tools/lowvis/pi/ab.mjs --requests <file.json> --tag <tag> --table      only the table, from the run.json files already written
// requests file: [{ id, request, kind? }]. Run name: <tag>-<id>-<variant>-<n>. Every run is its own process (run.mjs), so
// one run's compile and render never hold up another's clock. The queue alternates the variants, so they share the load.
// A finished run on file is not run again. A run that ends in an infrastructure error (the model or the proxy failed)
// is run once more and never counted as a result.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../.."), OUT = join(ROOT, "lowvis-out/pi"), RUN = join(ROOT, "tools/lowvis/pi/run.mjs");
const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
if (typeof opt.requests !== "string" || typeof opt.tag !== "string") { console.error("usage: node tools/lowvis/pi/ab.mjs --requests <file.json> --tag <tag> [--variants base,lean] [--repeats 2] [--parallel 4] [--model <id>] [--effort <level>] [--table]"); process.exit(2); }
const requests = JSON.parse(readFileSync(opt.requests, "utf8")), variants = String(opt.variants ?? "base,lean").split(","), repeats = Number(opt.repeats ?? 2), parallel = Number(opt.parallel ?? 4);
const jobs = [];
for (let n = 1; n <= repeats; n++) for (const r of requests) for (const variant of variants) jobs.push({ ...r, variant, n, name: `${opt.tag}-${r.id}-${variant}-${n}` });
const read = name => { const file = join(OUT, name, "run.json"); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; };
const done = run => Boolean(run) && !run.infraError && run.finished && run.variant !== undefined;

/** One run as a child process; resolves with its run record (or null when it wrote none). */
function runOne(job) {
	const args = [RUN, "--name", job.name, "--variant", job.variant, ...(opt.model ? ["--model", opt.model] : []), ...(opt.effort ? ["--effort", opt.effort] : []), job.request];
	return new Promise(res => { const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "ignore" }); child.once("exit", () => res(read(job.name))); child.once("error", () => res(null)); });
}

if (!opt.table) {
	const t0 = Date.now(), at = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s`;
	let next = 0;
	const worker = async () => {
		while (next < jobs.length) {
			const job = jobs[next++];
			if (done(read(job.name))) { console.log(`${at()}  ${job.name}: on file, not run again`); continue; }
			for (let attempt = 1; attempt <= 2; attempt++) {
				const run = await runOne(job);
				if (!run) { console.log(`${at()}  ${job.name}: no run record (attempt ${attempt})`); continue; }
				if (run.infraError) { console.log(`${at()}  ${job.name}: INFRASTRUCTURE ERROR at ${run.infraError.at} (attempt ${attempt}): ${String(run.infraError.message).slice(0, 160)}`); continue; }
				console.log(`${at()}  ${job.name}: ${run.endedBy}, wall ${(run.wallMs / 1000).toFixed(1)} s, ${run.compiles} compiles, out ${run.tokens.output}`);
				break;
			}
		}
	};
	await Promise.all(Array.from({ length: parallel }, worker));
}

// the table and the summary file: every job, with its run on file
const rows = jobs.map(job => {
	const run = read(job.name);
	if (!run) return { ...job, state: "no run" };
	if (run.infraError) return { ...job, state: "infrastructure error", infraError: run.infraError };
	const { transcript: _t, calls, final, ...rest } = run;
	return { ...job, state: run.finished ? "finished" : run.endedBy, ...rest, final: final && { specChars: final.specChars, sceneChars: final.sceneChars, frames: final.frames, checks: final.checks }, perCall: calls.model.map(c => ({ n: c.n, ms: c.ms, output: c.output })), shotTextChars: calls.shots.map(s => String(s.text ?? "").length), shotImages: calls.shots.map(s => s.images) };
});
const s = ms => ms == null ? "-" : (ms / 1000).toFixed(1), cell = (v, w) => String(v).padStart(w);
console.log("\nrun                              state     wall_s first_s calls compiles out_tokens cache_write cache_read spec_chars");
for (const r of rows) console.log([r.name.padEnd(32), String(r.state).padEnd(9).slice(0, 9), cell(s(r.wallMs), 6), cell(s(r.firstCompileMs), 7), cell(r.modelCalls ?? "-", 5), cell(r.compiles ?? "-", 8), cell(r.tokens?.output ?? "-", 10), cell(r.tokens?.cacheWrite ?? "-", 11), cell(r.tokens?.cacheRead ?? "-", 10), cell(r.final?.specChars ?? "-", 10)].join(" "));
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `${opt.tag}.json`), JSON.stringify({ at: new Date().toISOString(), tag: opt.tag, variants, repeats, requests, runs: rows }, null, "\t"));
console.log(`\n${join(OUT, `${opt.tag}.json`)}`);
