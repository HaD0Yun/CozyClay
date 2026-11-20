#!/usr/bin/env node
// Rule 10: rebuild the final scene and spec of every stored run with the engine on disk, or compare two rebuilds.
//   node tools/lowvis/pi/replay.mjs build <tag> [--runs <dir>] [--variant <name>] [--off <a,b>] [--only <run name>] [--print]
//     (default <repo>/lowvis-out/pi; writes <repo>/lowvis-out/replay/<tag>/)
//   node tools/lowvis/pi/replay.mjs compare <a> <b>
// A run is rebuilt when its run.json has final.scene, final.spec and a variant the prompt still knows. --variant builds
// every run with that variant in place of its own (for example studio, to see that its engine steps leave old results
// as they were), --off with those flags switched off in place of the run's own, --only one run, --print shows the tool's
// text of each rebuilt run.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VARIANTS } from "../../../src/lowvis/pi/prompt.mjs";

const ROOT = resolve(import.meta.dirname, "../../.."), OUT = join(ROOT, "lowvis-out/replay");
const load = f => JSON.parse(readFileSync(f, "utf8"));
// prop: the deepest a body is inside a prop past the inside rows' limit (src/lowvis/pi/inside.mjs; 0 when no body row is
// past it), read only from builds whose tree has that measure (_meta.json inside)
const isBodyRow = (clip, k) => clip.characters.some(c => k.startsWith(`inside:${c.id}>`));
const checksOf = clip => { const ch = clip.stats?.checks ?? {}, v = k => ch[k]?.value; return { reach: Math.max(0, ...Object.entries(ch).filter(([k]) => k.startsWith("reach:")).map(([, x]) => x.value)), floor: Math.max(0, -Math.min(v("jointLow") ?? 0, v("footLow") ?? 0)), prop: Math.max(0, ...Object.entries(ch).filter(([k]) => isBodyRow(clip, k)).map(([, x]) => x.value)), slide: v("slide") ?? 0 }; };
const argv = process.argv.slice(2), opt = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1]; };
const VALUED = new Set(["--runs", "--variant", "--off", "--only"]), [mode, a, b] = argv.filter((x, i) => !x.startsWith("--") && !VALUED.has(argv[i - 1]));

/** The compile tool of the tree on disk (named createShot in shot.mjs before it was renamed). */
async function compileTool() {
	if (existsSync(join(ROOT, "src/lowvis/pi/compile-tool.mjs"))) return (await import("../../../src/lowvis/pi/compile-tool.mjs")).createCompileTool;
	return (await import(join(ROOT, "src/lowvis/pi/shot.mjs"))).createShot;
}

if (mode === "build" && a) {
	const runsDir = resolve(opt("runs") ?? join(ROOT, "lowvis-out/pi")), dir = join(OUT, a), create = await compileTool();
	mkdirSync(dir, { recursive: true });
	const left = { noFinal: 0, unknownVariant: {} }, runs = [];
	for (const n of readdirSync(runsDir).sort()) {
		if (!existsSync(join(runsDir, n, "run.json"))) continue;
		if (opt("only") && n !== opt("only")) continue;
		const rec = load(join(runsDir, n, "run.json")), variant = opt("variant") ?? rec.variant ?? "base";
		if (!rec.final?.scene || !rec.final?.spec) left.noFinal++;
		else if (!VARIANTS.includes(variant)) left.unknownVariant[variant] = (left.unknownVariant[variant] ?? 0) + 1;
		else runs.push({ n, rec, variant });
	}
	const failed = [];
	for (const x of runs) {
		const r = create({ name: x.n, outDir: join(dir, "sheets", x.n), clipFile: join(dir, `${x.n}.json`), variant: x.variant, off: opt("off") !== undefined ? opt("off").split(",").filter(Boolean) : x.rec.off ?? [] }).call({ scene: x.rec.final.scene, spec: x.rec.final.spec });
		if (argv.includes("--print")) console.log(`--- ${x.n}\n${r.text}`);
		if (r.status !== "ok") failed.push({ name: x.n, text: String(r.text).slice(0, 140) });
	}
	const unknown = Object.values(left.unknownVariant).reduce((s, k) => s + k, 0);
	writeFileSync(join(dir, "_meta.json"), JSON.stringify({ runsDir, runs: runs.map(x => x.n), left, failed, inside: existsSync(join(ROOT, "src/lowvis/pi/inside.mjs")) }, null, 1));
	console.log(`built ${runs.length} runs from ${runsDir} into ${dir}, failed ${failed.length}`);
	console.log(`left out ${left.noFinal + unknown}: ${left.noFinal} without final.scene and final.spec, ${unknown} with a variant the prompt no longer has${unknown ? ` (${Object.entries(left.unknownVariant).map(([k, c]) => `${k} ${c}`).join(", ")})` : ""}`);
} else if (mode === "compare" && a && b) {
	const A = join(OUT, a), B = join(OUT, b), ma = load(join(A, "_meta.json")), mb = load(join(B, "_meta.json"));
	const fa = new Set(ma.failed.map(f => f.name)), fb = new Set(mb.failed.map(f => f.name)), inB = new Set(mb.runs), spec = n => load(join(ma.runsDir, n, "run.json"));
	const noInside = [[a, ma], [b, mb]].filter(([, m]) => m.inside !== true).map(([tag]) => tag), columns = noInside.length ? ["reach", "floor", "slide"] : ["reach", "floor", "prop", "slide"];
	if (noInside.length) console.log(`prop: not compared: ${noInside.join(" and ")} ${noInside.length > 1 ? "were" : "was"} built without the inside measure (its _meta.json has no inside: true)`);
	const res = { runs: ma.runs.length, unchanged: 0, changed: 0, failedBefore: fa.size, failedAfter: fb.size, newlyFailed: [...fb].filter(n => !fa.has(n)), missingInB: ma.runs.filter(n => !inB.has(n)).length, worse: [], better: Object.fromEntries(columns.map(k => [k, 0])) };
	for (const n of ma.runs) {
		if (fa.has(n) || fb.has(n) || !inB.has(n)) continue;
		const ca = load(join(A, `${n}.json`)), cb = load(join(B, `${n}.json`));
		let d = ca.characters.length === cb.characters.length ? 0 : Infinity;
		ca.characters.forEach((c, i) => { const p = cb.characters[i]?.pos ?? []; if (p.length !== c.pos.length) d = Infinity; for (let k = 0; k < c.pos.length; k++) d = Math.max(d, Math.abs(c.pos[k] - p[k])); });
		if ((ca.props ?? []).length !== (cb.props ?? []).length) d = Infinity; // and every prop: centre and rotation
		(ca.props ?? []).forEach((p, i) => { for (const f of ["pos", "quat"]) { const o = cb.props[i]?.[f] ?? []; if (o.length !== p[f].length) d = Infinity; for (let k = 0; k < p[f].length; k++) d = Math.max(d, Math.abs(p[f][k] - o[k])); } });
		if (d < 1e-6) { res.unchanged++; continue; }
		res.changed++; console.log("changed:", n, "|", String(spec(n).request ?? "").slice(0, 50));
		const x = checksOf(ca), y = checksOf(cb);
		for (const k of columns) { if (y[k] - x[k] > 10) res.worse.push(`${n} ${k} ${x[k].toFixed(0)} -> ${y[k].toFixed(0)} mm`); if (x[k] - y[k] > 10) res.better[k]++; }
	}
	console.log(JSON.stringify({ ...res, worse: res.worse.length }));
	if (res.worse.length) console.log(res.worse.join("\n"));
} else {
	console.error("usage: node tools/lowvis/pi/replay.mjs build <tag> [--runs <dir>] [--variant <name>] [--off <a,b>] [--only <run>] [--print] | compare <a> <b>");
	process.exit(2);
}
