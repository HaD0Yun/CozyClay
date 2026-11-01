#!/usr/bin/env node
// motion.fill (local tool): fills the gaps between a spec's authored key poses with MotionBricks motion (X Bot).
// usage: node mcp/motionbricks/fill.mjs <spec.json> [--out filled.json] [--at <frame>]
//   needs onnxruntime-node next to the server once: (cd mcp && npm install --no-save onnxruntime-node@1.23)
//   --at re-fills only the gaps around that frame (an edited key: drop its src: "fill" so it counts as authored).
// Prints QA before (authored keys only) and after, the gaps filled, model calls and wall time as JSON.
import { readFileSync, writeFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { fillSpec } from "../../src/motion3/bricks/fill.js";
import { isFillKey } from "../../src/motion3/bricks/fill-src.js";
import { createRunner } from "./model.mjs";

const args = process.argv.slice(2), opt = n => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const input = args[0];
if (!input || input.startsWith("--")) {
	console.error("usage: node mcp/motionbricks/fill.mjs <spec.json> [--out filled.json] [--at <frame>]");
	process.exit(2);
}
const at = opt("--at") === undefined ? undefined : Number(opt("--at"));
const out = opt("--out") ?? input.replace(/\.json$/, "") + ".filled.json";

const sk = skeletonFor("x-bot-tpose"), scene = motionScene([]);
const compile = spec => compileSpec(spec, { sk, scene });
const groups = r => (r.qa?.groups ?? []).map(g => `${g.kind} ${g.subject} n=${g.count}${g.cause ? ` cause: ${g.cause}` : ""}${g.hint ? ` hint: ${g.hint}` : ""}`);

const t0 = performance.now();
const run = await createRunner(m => console.error(m));
const tLoad = performance.now();
const spec = JSON.parse(readFileSync(input, "utf8"));
const authored = { ...spec, keys: (spec.keys ?? []).filter(k => !isFillKey(k)) };
const before = compile(at === undefined ? authored : spec);
const filled = await fillSpec(spec, { sk, compile, run }, { at });
const after = compile(filled.spec);
writeFileSync(out, JSON.stringify(filled.spec, null, "\t") + "\n");
const tEnd = performance.now();
console.log(JSON.stringify({
	out, at, gaps: filled.gaps, onnxCalls: filled.calls,
	keys: { before: (spec.keys ?? []).length, after: filled.spec.keys.length, fill: filled.spec.keys.filter(k => isFillKey(k)).length },
	qa: { before: { groups: before.qa.groups.length, list: groups(before) }, after: { groups: after.qa.groups.length, list: groups(after) } },
	ms: { modelLoad: Math.round(tLoad - t0), fill: Math.round(tEnd - tLoad), total: Math.round(tEnd - t0) },
}, null, 1));
