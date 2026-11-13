#!/usr/bin/env node
// Runs the five test requests one after another with the pi harness and prints a table.
//   node tools/lowvis/pi/bench.mjs [--only push,chop] [--model <id>] [--effort <level>]
//   node tools/lowvis/pi/bench.mjs --table      only the table, from the run.json files already written
// One model and one effort for every scene. A run that ends in an infrastructure error (the model or the proxy
// failed) is kept apart, run once more and never counted as a result.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_EFFORT, DEFAULT_MODEL, runScene } from "../../../src/lowvis/pi/harness.mjs";
import { summary } from "./run.mjs";

export const SCENES = [
	["push", "100kg 정도 되는 무거운 박스 미는거 한번 만들어줘"],
	["chop", "한명이 검 들고 나무 베는거 만들어줘"],
	["bowl", "볼링 치는 거 한번 만들어줘"],
	["wave", "한 명이 걸어가다가 멈춰서 뒤를 돌아보고 손을 흔드는 장면"],
	["sofa", "두 사람이 소파를 같이 들어서 옮기는 장면"],
];
const OUT = resolve(import.meta.dirname, "../../../lowvis-out/pi");
const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
const only = typeof opt.only === "string" ? opt.only.split(",") : null, wanted = SCENES.filter(([name]) => !only || only.includes(name));

if (!opt.table) for (const [name, request] of wanted) {
	for (let attempt = 1; attempt <= 2; attempt++) {
		console.log(`\n=== ${name} (attempt ${attempt}): ${request}`);
		const run = await runScene({ name, request, model: opt.model ?? DEFAULT_MODEL, effort: opt.effort ?? DEFAULT_EFFORT, log: line => console.log(line) });
		console.log(summary(run).join("\n"));
		if (!run.infraError) break;
	}
}

// the table: the last run of every scene, and every infrastructure error on file, apart
const read = file => JSON.parse(readFileSync(file, "utf8")), runs = [], infra = [];
for (const [name] of wanted) {
	const dir = join(OUT, name);
	if (!existsSync(join(dir, "run.json"))) continue;
	const run = read(join(dir, "run.json"));
	if (!run.infraError) runs.push(run);
	for (const f of readdirSync(dir).filter(f => f.startsWith("infra-error-"))) { const e = read(join(dir, f)); infra.push({ name, startedAt: e.startedAt, at: e.infraError.at, message: e.infraError.message }); }
}
const s = ms => ms == null ? "-" : (ms / 1000).toFixed(0), cell = (v, w) => String(v).padStart(w);
console.log("\nscene  model             effort wall_s first_compile_s model_calls shots out_tokens ctx_avg ctx_max spec_chars redundant mistakes sweeps streak safety_limit  Missing");
for (const r of runs) console.log([r.name.padEnd(6), r.asked.model.padEnd(17), r.asked.effort.padEnd(6), cell(s(r.wallMs), 6), cell(s(r.firstCompileMs), 15), cell(r.modelCalls, 11), cell(r.shots, 5), cell(r.tokens.output, 10), cell(r.context.average, 7), cell(r.context.max, 7), cell(r.final?.specChars ?? "-", 10), cell(r.unnecessary.redundant, 9), cell(r.unnecessary.mistakes, 8), cell(r.unnecessary.sweeps, 6), cell(r.unnecessary.streak ?? 0, 6), cell(r.safety.hit ?? "not hit", 12), ` ${r.missing ?? "(no Missing line)"}`].join(" "));
for (const e of infra) console.log(`infrastructure error, not a result: ${e.name} started ${e.startedAt}, at ${e.at}: ${e.message}`);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "bench.json"), JSON.stringify({ at: new Date().toISOString(), infra, runs: runs.map(({ transcript: _t, calls: _c, ...r }) => r) }, null, "\t"));
