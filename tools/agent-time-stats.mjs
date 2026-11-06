#!/usr/bin/env node
// Agent time stats (#1083; tools/agent-session-stats.mjs counts tokens and refusals per turn): where a Studio Agent session's time went and what its motion specs asked of the agent,
// from the session logs (~/.config/cozyclay/agent-sessions/<id>.jsonl, or files given). Per session: wall time (first
// to last message), the model's time (assistant durationMs, summed), the tools' time by tool (run_action by action,
// motion.compile apart), the rest (gaps the log does not time), motion.compile calls (direct and inside scripts), whether
// the first compile was QA-clean, and the keyed values of each spec sent directly (median). With --all, a table of keyed
// values per channel family over every direct compile (the #1078 table).
//
//   node tools/agent-time-stats.mjs [--since 2026-10-15] [--json] [--all] [session.jsonl ...]
// Bench sessions (a scene id starting scene-bench-) are left out of the directory scan.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2), flag = n => args.includes(n), value = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const since = value("--since") ? Date.parse(value("--since")) : 0;
const given = args.filter((a, i) => a.endsWith(".jsonl") && args[i - 1] !== "--since");
const dir = join(process.env.COZYCLAY_AGENT_SESSIONS_DIR ?? join(homedir(), ".config/cozyclay/agent-sessions"));
const files = given.length ? given : existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(f => join(dir, f)) : [];

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const familyOf = ch => ch.replace(/_[lr]$/, "").replace(/^w_.+$/, "w_<anchor>");
const valuesOf = spec => (Array.isArray(spec?.keys) ? spec.keys.reduce((n, k) => n + Object.keys(k?.set ?? {}).length, 0) : 0);

/** One session log -> its stats, or null (no messages, before --since, a bench scene). */
function sessionStats(file, families = null) {
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const msgs = lines.map(l => l.message).filter(m => m && Number.isFinite(m.timestamp));
	if (!msgs.length || msgs[0].timestamp < since) return null;
	if (!given.length && lines.some(l => JSON.stringify(l).includes("scene-bench-"))) return null;
	const calls = new Map(), tools = {}, compiles = [];
	let model = 0, requests = 0, firstOk = null;
	for (const m of msgs) {
		if (m.role === "assistant") {
			model += m.durationMs ?? 0; requests++;
			for (const c of m.content ?? []) if (c?.type === "toolCall") calls.set(c.id, c);
		}
		if (m.role !== "toolResult") continue;
		const call = calls.get(m.toolCallId), action = call?.arguments?.action, name = m.toolName === "run_action" && action ? `run_action ${action}` : m.toolName;
		tools[name] = (tools[name] ?? 0) + (m.durationMs ?? 0);
		const inner = (m.details?.calls ?? []).filter(c => c?.action === "motion.compile");
		const direct = action === "motion.compile";
		for (let i = 0; i < (direct ? 1 : inner.length); i++) {
			const spec = direct ? call.arguments?.args?.spec : null, out = direct ? m.details?.output ?? m.details?.value?.output : null;
			compiles.push({ via: direct ? "run_action" : m.toolName, values: spec ? valuesOf(spec) : out?.authored?.values ?? null, ms: out?.ms?.total ?? null });
			if (spec && families) for (const k of spec.keys ?? []) for (const ch of Object.keys(k?.set ?? {})) families[familyOf(ch)] = (families[familyOf(ch)] ?? 0) + 1;
		}
		if (firstOk === null && (direct || inner.length)) {
			const qa = m.details?.output?.qa ?? m.details?.value?.qa ?? m.details?.value?.output?.qa;
			firstOk = qa ? Boolean(qa.ok) : null;
		}
	}
	const wall = msgs.at(-1).timestamp - msgs[0].timestamp, toolMs = Object.values(tools).reduce((a, b) => a + b, 0);
	return { file, wallMs: wall, modelMs: model, toolMs, otherMs: Math.max(0, wall - model - toolMs), requests, tools, compiles: compiles.length,
		firstCompileQaOk: firstOk, authoredValues: median(compiles.map(c => c.values).filter(Number.isFinite)) };
}

const families = flag("--all") ? {} : null;
const rows = files.map(f => sessionStats(f, families)).filter(Boolean);
if (flag("--json")) console.log(JSON.stringify({ sessions: rows, ...(families ? { families } : {}) }, null, 1));
else {
	const s = ms => (ms / 1000).toFixed(1);
	for (const r of rows) console.log(`${r.file.split("/").pop()}  wall ${s(r.wallMs)} s  model ${s(r.modelMs)}  tools ${s(r.toolMs)}  other ${s(r.otherMs)}  requests ${r.requests}  compiles ${r.compiles}  first qa.ok ${r.firstCompileQaOk}  authored ${r.authoredValues ?? "-"}`);
	const withC = rows.filter(r => r.compiles);
	console.log(`${rows.length} sessions, ${withC.length} with compiles; compiles per session median ${median(withC.map(r => r.compiles))}; first-compile qa.ok ${withC.filter(r => r.firstCompileQaOk).length}/${withC.length}; authored values median ${median(withC.map(r => r.authoredValues).filter(Number.isFinite))}`);
	if (families) console.log(Object.entries(families).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("\n"));
}
