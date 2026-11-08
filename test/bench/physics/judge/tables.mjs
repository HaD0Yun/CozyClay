#!/usr/bin/env node
// Result tables of the physical motion bench (docs/qa/physics-bench.md, PR 5; plan 4.1 and 4.3), from the run rows
// and the blind verdicts. No combined score: each task marks a winner per column, and the summary counts the wins.
//   node test/bench/physics/judge/tables.mjs [--runs-dir ~/physics-bench/runs] [--out results.md]
// A run that did not finish counts as 60 min (the limit) in time and spread, keeps its measured cost, and is
// "unusable" in judging. A gap within 10% of the better median is a tie (plan 4.1, a starting value).
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSets } from "../sets.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = arg("runs-dir", join(homedir(), "physics-bench/runs")), LIMIT_MS = 60 * 60_000, TIE = 0.1;
const read = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const rows = readFileSync(join(RUNS, "physics-bench.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.probe);
const pairs = read(join(RUNS, "judge-pairs.json"), {}), verdicts = read(join(RUNS, "judge-verdicts.json"), {});

const median = a => { const s = a.filter(v => v != null).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const timeOf = r => (r.ending === "finished" ? r.wallMs : LIMIT_MS);
/** "C" | "B" | "tie" for lower-is-better values, with the relative tie band. */
const lower = (c, b, band = TIE) => (c == null || b == null ? "-" : Math.abs(c - b) <= band * Math.min(c, b) ? "tie" : c < b ? "C" : "B");
const higher = (c, b) => (c === b ? "tie" : c > b ? "C" : "B");

const COLS = ["Completion", "Speed", "Cost", "Wasted effort", "Stability", "Quality (human)"];
const wins = Object.fromEntries(COLS.map(c => [c, { C: 0, B: 0, tie: 0 }]));
const lines = ["| # | Motion | Completion C · B | Time (min) C · B | Cost ($) C · B | Failed calls C · B | Spread (min) C · B | Human C : B : same : both unusable |", "|---|---|---|---|---|---|---|---|"];
const f1 = v => (v == null ? "-" : (v / 60_000).toFixed(1)), f2 = v => (v == null ? "-" : v.toFixed(2));

for (const set of loadSets()) {
	const of = tool => rows.filter(r => r.set === set.id && r.tool === tool);
	const c = of("cozyclay"), b = of("blender");
	if (!c.length && !b.length) continue;
	const done = rs => rs.filter(r => r.ending === "finished").length;
	const spread = rs => (rs.length ? Math.max(...rs.map(timeOf)) - Math.min(...rs.map(timeOf)) : null);
	const t = [median(c.map(timeOf)), median(b.map(timeOf))], cost = [median(c.map(r => r.usd)), median(b.map(r => r.usd))];
	const fail = [median(c.map(r => r.failedCalls)), median(b.map(r => r.failedCalls))], sp = [spread(c), spread(b)];
	const human = { C: 0, B: 0, same: 0, both_unusable: 0 };
	for (const p of Object.values(pairs).filter(p => p.set === set.id)) {
		const v = verdicts[p.id]?.choice;
		if (v === "same" || v === "both_unusable") human[v]++;
		else if (v) human[(v === "left") === (p.left === "cozyclay") ? "C" : "B"]++;
	}
	const marks = { Completion: higher(done(c), done(b)), Speed: lower(...t), Cost: lower(...cost), "Wasted effort": lower(fail[0], fail[1], 0),
		Stability: lower(...sp), "Quality (human)": human.C + human.B + human.same + human.both_unusable ? higher(human.C, human.B) : "-" };
	for (const [k, m] of Object.entries(marks)) if (wins[k][m] != null) wins[k][m]++;
	lines.push(`| ${set.task} | ${set.title.en} | ${done(c)}/${c.length} · ${done(b)}/${b.length} | ${f1(t[0])} · ${f1(t[1])} | ${f2(cost[0])} · ${f2(cost[1])} | ${fail[0] ?? "-"} · ${fail[1] ?? "-"} | ${f1(sp[0])} · ${f1(sp[1])} | ${human.C} : ${human.B} : ${human.same} : ${human.both_unusable} |`);
}
lines.push("", "| Column | CozyClay wins | Blender wins | Tie |", "|---|---|---|---|", ...COLS.map(k => `| ${k} | ${wins[k].C} | ${wins[k].B} | ${wins[k].tie} |`));
lines.push("", `Rows: ${rows.length} runs, ${Object.keys(verdicts).length} of ${Object.keys(pairs).length} pairs judged. Time: median of start of the request to the final reply; unfinished runs count as 60 min.`);
const text = `${lines.join("\n")}\n`;
if (arg("out")) writeFileSync(arg("out"), text);
process.stdout.write(text);
