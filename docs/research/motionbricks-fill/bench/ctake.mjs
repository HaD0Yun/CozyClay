// time one compile of each run's final take, the way fill-native probes it
import { readFileSync, readdirSync } from "node:fs";
const M = process.env.MAIN, D = process.argv[2];
const { compileSpec } = await import(M + "/src/motion3/pipeline.js");
const { skeletonFor } = await import(M + "/src/motion3/rigs/index.js");
const find = function* (o, key) { if (o && typeof o === "object") { if (key in o) yield o[key]; for (const v of Object.values(o)) yield* find(v, key); } };
for (const f of readdirSync(D).filter(f => f.endsWith(".json")).sort()) {
	const doc = JSON.parse(readFileSync(`${D}/${f}`, "utf8"));
	const take = [...find(doc, "motionTake")].find(Boolean); if (!take) { console.log(f, "no take"); continue; }
	const sk = skeletonFor(take.rig), scene = take.scene, keys = take.spec.keys ?? [];
	const t = performance.now(); const r = compileSpec(take.spec, { sk, scene }); const ms = performance.now() - t;
	const ops = {}; for (const k of keys) for (const op of Object.keys(k.do ?? k.skill ?? {})) ops[op] = (ops[op] ?? 0) + 1;
	console.log(f, "ms", Math.round(ms), "frames", r.out.frameCount, "keys", keys.length, "skills", JSON.stringify(take.spec.skills ?? take.spec.actions ?? "").slice(0, 200));
}
