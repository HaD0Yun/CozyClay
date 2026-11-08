#!/usr/bin/env node
// Physical motion bench run harness (docs/qa/physics-bench.md, PR 4).
//   node test/bench/physics/run.mjs --sets 10 [--runs 1] [--tools cozyclay,blender] [--timeout-min 60]
//        [--out ~/physics-bench/runs] [--model claude-opus-5-5] [--effort high] [--probe banned] [--lanes 1] [--first-lane 0]
// --model takes a bare model (the panel option cliproxy/<model>) or a full panel option value such as
// v4/claude-opus-5-5 (the v4 engine).
// One queue per tool, run side by side, each drained by --lanes workers (lane k: Studio ports 6500 + 10k, starting
// 30 s after lane k-1). Blender needs one lane (its usage is the proxy log by window); CozyClay usage comes from each
// run's session logs (usage.mjs usageOfSessions). A run sends one request (sets.mjs requestText), waits for the agent's final reply or the limit, exports
// take.json itself, and appends one row to <out>/physics-bench.jsonl. A run dir that has row.json is skipped.
// --probe banned sends a short request that uses a banned tool instead of the task (rows are marked probe and
// never counted): it shows the ban check turning a run into "disqualified".
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blenderLog, cozyclayLog } from "./agent-logs.mjs";
import { BLENDER, CLAUDE, runBlender } from "./blender-run.mjs";
import { cozyclayDoc } from "./build-cozyclay.mjs";
import { takeFromDoc } from "./export-cozyclay.mjs";
import { loadSets, requestText } from "./sets.mjs";
import { laneEnv, startStudio, underBrowser } from "./studio.mjs";
import { landmarksAt, readTake, writeTake } from "./take.mjs";
import { rateLimited, usageOf, usageOfSessions } from "./usage.mjs";

const HERE = new URL(".", import.meta.url).pathname, REPO = join(HERE, "../../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", join(homedir(), "physics-bench/runs")), RUNS = Number(arg("runs", "1")), LIMIT = Number(arg("timeout-min", "60"));
const MODEL = arg("model", "claude-opus-5-5"), PANEL_MODEL = MODEL.includes("/") ? MODEL : `cliproxy/${MODEL}`, EFFORT = arg("effort", "high"), PROBE = arg("probe", null), LANES = Number(arg("lanes", "1")), FIRST_LANE = Number(arg("first-lane", "0"));
const TOOLS = arg("tools", "cozyclay,blender").split(","), sets = loadSets(arg("sets", "").split(",").filter(Boolean));
const PROBES = {
	cozyclay: "char-a에 standIdle(at [0, 0]) 다음 flip 스킬(kind: back)로 뒤공중돌기 테이크를 만들어 설치해 줘. 다른 건 하지 마.",
	blender: "Blender Python으로 bpy.ops.import_anim.bvh(filepath='/tmp/none.bvh')를 한 번 실행하고 결과를 한 줄로 알려줘. 오류여도 된다. 다른 건 하지 마.",
};
const log = (...a) => { const l = `${new Date().toISOString().slice(0, 19)} ${a.join(" ")}`; console.log(l); appendFileSync(join(OUT, "run.log"), `${l}\n`); };
const read = (p, d = null) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000 }).trim().split("\n")[0]; } catch { return null; } };
const cliproxyEnv = () => Object.fromEntries([...readFileSync(join(homedir(), ".config/cliproxy/env"), "utf8").matchAll(/^(?:export\s+)?(CLIPROXY_API_KEY)=["']?([^"'\n]+)/gm)].map(m => [m[1], m[2]]));

/** Largest landmark travel from frame 0 (m): under 1 cm the agent left no motion. */
function travel(take) {
	const a = landmarksAt(take, "char-a", 0);
	let m = 0;
	for (let f = 1; f < take.frames; f++) for (const [k, p] of Object.entries(landmarksAt(take, "char-a", f))) m = Math.max(m, Math.hypot(p[0] - a[k][0], p[1] - a[k][1], p[2] - a[k][2]));
	return m;
}

async function cozyclayRun(set, dir, request, lane) {
	writeFileSync(join(dir, "start.cclayproject"), JSON.stringify(cozyclayDoc(set)));
	writeFileSync(join(dir, "request.txt"), request);
	const port = 6500 + 10 * lane, env = laneEnv(join(dir, "config"), port + 1, { ...cliproxyEnv(), CLIPROXY_BASE_URL: "http://127.0.0.1:8317" });
	const studio = await startStudio({ port, env, log: join(dir, "dev.log") });
	try {
		await underBrowser({ port, cdpPort: port + 2, env, script: join(HERE, "drive-cozyclay.mjs"), log: join(dir, "drive.log"),
			args: ["--dir", dir, "--hub", String(port + 1), "--model", PANEL_MODEL, "--effort", EFFORT, "--timeout-min", String(LIMIT)] });
	} finally { await studio.stop(); }
	const drive = read(join(dir, "drive.json"), {}), doc = read(join(dir, "doc.json"));
	const out = { sentAt: drive.sentAt, endAt: drive.endAt, timedOut: drive.timedOut, error: drive.error, reply: drive.reply, modelSelected: drive.modelSelected, effortSelected: drive.effortSelected };
	let spec = null;
	if (doc) {
		try { const take = takeFromDoc(doc, set, { run: dir }); writeTake(join(dir, "take.json"), take); } catch (e) { out.exportError = String(e.message).slice(0, 300); }
		spec = doc.scenes?.scenes?.find(s => s.id === doc.scenes.activeSceneId)?.stage?.characters?.find(c => c.id === "char-a")?.motionTake?.spec ?? null;
	}
	const files = (drive.sessionIds ?? []).map(id => join(dir, "sessions", `${id}.jsonl`));
	// the Studio Agent's own limit on one dispatched task (bin/agent/studio-tasks.mjs TASK_LIMITS.maxMs), recorded
	// because the bench may run with it raised to the bench limit (docs/qa/physics-bench.md)
	const taskMax = /maxMs:\s*([\d\s*_]+?)\s*,/.exec(readFileSync(join(REPO, "bin/agent/studio-tasks.mjs"), "utf8"))?.[1];
	const version = { cozyclay: sh("git", ["-C", REPO, "rev-parse", "--short=8", "HEAD"]), taskMaxMin: taskMax ? Function(`return (${taskMax.replace(/_/g, "")}) / 60000`)() : null,
		patched: sh("git", ["-C", REPO, "status", "--porcelain", "--", "bin", "src", "mcp"]) || null };
	return { ...out, stats: cozyclayLog(files, spec), version, sessionFiles: files };
}

async function blenderRun(set, dir, request, lane) {
	const out = await runBlender({ set, dir, lane, request, model: MODEL, effort: EFFORT, timeoutMin: LIMIT });
	const stats = blenderLog(join(dir, "claude.jsonl")), r = stats.result;
	out.reply = r?.result ?? null;
	out.agentReported = r ? { subtype: r.subtype, isError: r.is_error, durationMs: r.duration_ms, durationApiMs: r.duration_api_ms, turns: r.num_turns, costUsd: r.total_cost_usd } : null;
	delete stats.result;
	return { ...out, stats, version: { blender: sh(BLENDER, ["--version"]), mcp: "blender_mcp 1.0.3", claudeCode: sh(CLAUDE, ["--version"]) } };
}

async function job(set, tool, run, lane = 0) {
	const id = `${set.id}-${tool}-r${run}${PROBE ? `-probe-${PROBE}` : ""}`, dir = join(OUT, id);
	if (existsSync(join(dir, "row.json"))) { log(id, "done before, skipped"); return; }
	for (let waited = 0; rateLimited(); waited++) {
		if (waited >= 48) { log(id, "rate limited for 12 h, stopping"); process.exit(3); }
		log(id, "the proxy refused a request for the rate limit in the last 15 min, waiting 15 min");
		await new Promise(r => setTimeout(r, 15 * 60_000));
	}
	mkdirSync(dir, { recursive: true });
	log(id, "start", `lane ${lane}`);
	const request = PROBE ? PROBES[tool] : requestText(set, tool);
	let res;
	try { res = await (tool === "cozyclay" ? cozyclayRun : blenderRun)(set, dir, request, lane); } catch (e) { res = { error: String(e.message).slice(0, 600) }; }
	let take = null;
	try { if (existsSync(join(dir, "take.json"))) take = readTake(join(dir, "take.json")); } catch (e) { res.exportError ??= String(e.message).slice(0, 300); }
	const moved = take ? travel(take) : 0, stats = res.stats ?? {};
	// a harness failure (no send, no save, an export that broke) is a crash; an agent that left no take or no motion gave up
	const harness = res.error ?? (res.saved === false ? res.saveError : null) ?? (/no installed take/.test(res.exportError ?? "") ? null : res.exportError);
	const ending = !res.sentAt ? "crash" : stats.banned?.length ? "disqualified" : res.timedOut ? "timeout" : take && moved >= 0.01 ? "finished" : harness ? "crash" : "gave_up";
	const wallMs = res.sentAt && res.endAt ? res.endAt - res.sentAt : null;
	const usageSource = tool === "cozyclay" ? "sessions" : "proxy";
	const usage = wallMs ? (usageSource === "sessions" ? usageOfSessions(res.sessionFiles ?? [], res.sentAt, res.endAt + 2000) : usageOf(tool, res.sentAt, res.endAt + 2000)) : null;
	const row = {
		id, set: set.id, task: set.task, tool, run, lane, usageSource, probe: PROBE, model: MODEL, effort: EFFORT, version: res.version ?? null,
		startedAt: res.sentAt ? new Date(res.sentAt).toISOString() : null, ending, wallMs: ending === "timeout" ? LIMIT * 60_000 : wallMs,
		modelMs: usage?.modelMs ?? null, modelBusyMs: usage?.modelBusyMs ?? null, toolMs: wallMs && usage ? wallMs - usage.modelBusyMs : null,
		tokens: usage && { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite5m: usage.cacheWrite5m, cacheWrite1h: usage.cacheWrite1h },
		modelRequests: usage?.requests ?? null, failedRequests: usage?.failed ?? null, utilization7d: usage?.utilization7d ?? null, usd: usage?.usd ?? null, usd5m: usage?.usd5m ?? null, krw: usage?.krw ?? null, priceDate: usage?.price.date ?? null,
		modelCalls: stats.modelCalls ?? null, toolCalls: stats.toolCalls ?? null, failedCalls: stats.failedCalls ?? null, retries: stats.retries ?? null,
		resultChecks: stats.resultChecks ?? null, byTool: stats.byTool ?? null, banned: stats.banned ?? [], frames: take?.frames ?? null, travelM: Math.round(moved * 1000) / 1000,
		take: take ? join(dir, "take.json") : null, error: res.error ?? res.exportError ?? res.saveError ?? null, reply: res.reply ? String(res.reply).slice(0, 600) : null,
		agentReported: res.agentReported ?? null, selected: res.modelSelected ? { model: res.modelSelected, effort: res.effortSelected } : null,
	};
	writeFileSync(join(dir, "row.json"), JSON.stringify(row, null, 1));
	appendFileSync(join(OUT, "physics-bench.jsonl"), `${JSON.stringify(row)}\n`);
	log(id, ending, wallMs ? `${(wallMs / 60000).toFixed(1)} min` : "", row.usd != null ? `$${row.usd}` : "", row.banned.length ? `banned ${row.banned.map(b => b.rule).join(",")}` : "");
}

mkdirSync(OUT, { recursive: true });
if (!sets.length || TOOLS.some(t => !["cozyclay", "blender"].includes(t)) || !(LANES >= 1)) { console.error("usage: run.mjs --sets 10[,3] [--runs n] [--tools cozyclay,blender] [--lanes n]"); process.exit(2); }
if (LANES > 1 && TOOLS.includes("blender")) { console.error("--lanes > 1 is for cozyclay only: Blender usage is read from the proxy log by window"); process.exit(2); }
log(`sets ${sets.map(s => s.task).join(",")} x ${RUNS} runs, tools ${TOOLS.join(",")}, ${MODEL} ${EFFORT}, limit ${LIMIT} min, ${LANES} lane${LANES === 1 ? "" : "s"}${PROBE ? `, probe ${PROBE}` : ""} (${readdirSync(OUT).length} entries in ${OUT})`);
await Promise.all(TOOLS.map(tool => {
	const queue = [];
	for (let run = 1; run <= RUNS; run++) for (const set of sets) queue.push({ set, run });
	return Promise.all(Array.from({ length: LANES }, async (_, lane) => {
		await new Promise(r => setTimeout(r, lane * 30_000));
		for (let next; (next = queue.shift());) await job(next.set, tool, next.run, FIRST_LANE + lane);
	}));
}));
log("all done");
