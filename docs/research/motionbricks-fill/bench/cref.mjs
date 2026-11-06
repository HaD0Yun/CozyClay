// one compile vs one install reference (repair 2 rounds + recompile), plain and walks frozen
import { readFileSync, readdirSync } from "node:fs";
const M = process.env.MAIN, D = process.argv[2];
const { compileSpec } = await import(M + "/src/motion3/pipeline.js");
const { runCompileJob } = await import(M + "/src/motion3/compile-job.js");
const { applyWalkPlans } = await import(M + "/src/motion3/walk-plan.js");
const { skeletonFor } = await import(M + "/src/motion3/rigs/index.js");
const find = function* (o, key) { if (o && typeof o === "object") { if (key in o) yield o[key]; for (const v of Object.values(o)) yield* find(v, key); } };
for (const f of readdirSync(D).filter(f => f.endsWith(".json")).sort()) {
	const take = [...find(JSON.parse(readFileSync(`${D}/${f}`, "utf8")), "motionTake")].find(Boolean);
	const model = take.rig, sk = skeletonFor(model), scene = take.scene;
	let t = performance.now(); const r = compileSpec(take.spec, { sk, scene }); const c = performance.now() - t;
	const frozen = applyWalkPlans(take.spec, r.walkPlans ?? []);
	t = performance.now(); compileSpec({ ...frozen, keys: [...frozen.keys] }, { sk, scene }); const cf = performance.now() - t;
	t = performance.now(); const j = runCompileJob({ model, scene, spec: { fps: 24, ...frozen }, repair: { rounds: 2 }, installing: true, thin: false, hintLimitMs: 0 }); compileSpec(j.stored, { sk, scene }); const ref = performance.now() - t;
	console.log(f, "compile", Math.round(c), "frozen", Math.round(cf), "reference", Math.round(ref));
}
