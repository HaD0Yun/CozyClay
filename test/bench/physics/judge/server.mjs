#!/usr/bin/env node
// Blind judging page for the physical motion bench (docs/qa/physics-bench.md, PR 5; plan 4.2).
//   node test/bench/physics/judge/server.mjs [--runs-dir ~/physics-bench/runs] [--port 8790] [--host 127.0.0.1]
// A pair is run n of a task in both tools. Which tool sits left is drawn once and kept in <runs>/judge-pairs.json;
// verdicts go to <runs>/judge-verdicts.json. The page and the video URLs carry only the pair id and left/right, never
// a tool name. A run without videos shows as "no result" (plan 4.1: a run that did not finish is unusable).
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSets } from "../sets.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = arg("runs-dir", join(homedir(), "physics-bench/runs")), PORT = Number(arg("port", "8790")), HOST = arg("host", "127.0.0.1");
const PAIRS = join(RUNS, "judge-pairs.json"), VERDICTS = join(RUNS, "judge-verdicts.json");
const CHOICES = ["left", "right", "same", "both_unusable"];
const read = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const sets = loadSets();

/** Every pair whose two runs both have a row, in task and run order; new pairs get a left tool drawn once. */
function pairs() {
	const kept = read(PAIRS, {});
	let changed = false;
	for (const set of sets) for (let n = 1; n < 100; n++) {
		const c = join(RUNS, `${set.id}-cozyclay-r${n}`), b = join(RUNS, `${set.id}-blender-r${n}`);
		if (!existsSync(join(c, "row.json")) || !existsSync(join(b, "row.json"))) { if (!existsSync(c) && !existsSync(b)) break; continue; }
		const id = `${set.task}-${n}`;
		if (!kept[id]) { kept[id] = { id, set: set.id, run: n, left: Math.random() < 0.5 ? "cozyclay" : "blender" }; changed = true; }
	}
	if (changed) writeFileSync(PAIRS, JSON.stringify(kept, null, 1));
	return Object.values(kept).sort((a, b) => a.set.localeCompare(b.set) || a.run - b.run);
}

const toolOf = (pair, side) => (side === "left" ? pair.left : pair.left === "cozyclay" ? "blender" : "cozyclay");
const dirOf = (pair, side) => join(RUNS, `${pair.set}-${toolOf(pair, side)}-r${pair.run}`);
const hasVideo = dir => existsSync(join(dir, "side.mp4")) && existsSync(join(dir, "front.mp4"));

function video(req, res, file) {
	const size = statSync(file).size, m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
	if (!m) { res.writeHead(200, { "content-type": "video/mp4", "content-length": size, "accept-ranges": "bytes" }); createReadStream(file).pipe(res); return; }
	const start = Number(m[1] || 0), end = m[2] ? Number(m[2]) : size - 1;
	res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1, "accept-ranges": "bytes" });
	createReadStream(file, { start, end }).pipe(res);
}

const json = (res, v, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };

createServer((req, res) => {
	const url = new URL(req.url, "http://x"), list = pairs(), verdicts = read(VERDICTS, {});
	if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(readFileSync(join(HERE, "page.html"))); return; }
	if (url.pathname === "/api/pairs") {
		return json(res, list.map(p => ({ id: p.id, task: sets.find(s => s.id === p.set).task, title: sets.find(s => s.id === p.set).title.ko,
			request: sets.find(s => s.id === p.set).request.ko, run: p.run, left: hasVideo(dirOf(p, "left")), right: hasVideo(dirOf(p, "right")), verdict: verdicts[p.id]?.choice ?? null })));
	}
	const v = /^\/video\/([\w-]+)\/(left|right)\/(side|front)$/.exec(url.pathname);
	if (v) {
		const p = list.find(x => x.id === v[1]), file = p && join(dirOf(p, v[2]), `${v[3]}.mp4`);
		if (!file || !existsSync(file)) { res.writeHead(404); res.end(); return; }
		return video(req, res, file);
	}
	if (url.pathname === "/api/verdict" && req.method === "POST") {
		let body = "";
		req.on("data", d => { body += d; });
		req.on("end", () => {
			let q;
			try { q = JSON.parse(body); } catch { return json(res, { error: "bad json" }, 400); }
			if (!list.some(p => p.id === q.id) || !CHOICES.includes(q.choice)) return json(res, { error: "unknown pair or choice" }, 400);
			verdicts[q.id] = { choice: q.choice, at: new Date().toISOString() };
			writeFileSync(VERDICTS, JSON.stringify(verdicts, null, 1));
			json(res, { ok: true });
		});
		return;
	}
	res.writeHead(404);
	res.end();
}).listen(PORT, HOST, () => console.log(`judging on http://${HOST}:${PORT}/ (${pairs().length} pairs, runs ${RUNS})`));
