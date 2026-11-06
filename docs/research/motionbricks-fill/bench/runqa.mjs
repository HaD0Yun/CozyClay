// The final installed take of each agent run (doc.json motionTake) compiled the same way: QA, frames, shots, the box at the end.
import { readFileSync, readdirSync } from "node:fs";
const M = process.env.MAIN, D = process.argv[2];
const { compileSpec } = await import(M + "/src/motion3/pipeline.js");
const { skeletonFor } = await import(M + "/src/motion3/rigs/index.js");
const { rootPoseAt } = await import(M + "/src/motion3/object-pose.js");
const find = function* (o, key) { if (o && typeof o === "object") { if (key in o) yield o[key]; for (const v of Object.values(o)) yield* find(v, key); } };
const OVER = /^(COLLIDE|BODY|SELF|FACE)$/;
for (const f of readdirSync(D).filter(f => f.endsWith(".json")).sort()) {
	const doc = JSON.parse(readFileSync(`${D}/${f}`, "utf8"));
	const take = [...find(doc, "motionTake")].find(Boolean), shots = [...find(doc, "shots")].find(x => Array.isArray(x)) ?? [];
	if (!take) { console.log(f, "no take"); continue; }
	const sk = skeletonFor(take.rig), scene = take.scene;
	try {
		const r = compileSpec(take.spec, { sk, scene });
		const by = {}; for (const g of r.qa.groups) by[g.kind] = (by[g.kind] ?? 0) + (g.count ?? 1);
		const box = Object.keys(scene.objects ?? {}).find(id => /box/i.test(scene.objects[id].name)), last = r.out.frames.length - 1;
		let boxEnd = null; try { boxEnd = rootPoseAt(r.out, box, last)?.pos?.map(v => +v.toFixed(2)); } catch { }
		const L = r.observations?.life ?? {};
		console.log(JSON.stringify({ run: f.replace(".json", ""), frames: r.out.frameCount, sec: +(r.out.frameCount / 24).toFixed(1), shots: shots.length, qaGroups: r.qa.groups.length, qaTotal: r.qa.total, overlap: Object.entries(by).filter(([k]) => OVER.test(k)).reduce((a, [, v]) => a + v, 0), slide: by.SLIDE ?? 0, goal: by.GOAL ?? 0, held: by.HELD_OBJECT_DRIFT ?? 0, boxEnd, mbKeys: (take.spec.keys ?? []).filter(k => String(k.src ?? "").startsWith("fill")).length, sync: L.sync?.[0], spikes: L.jerk?.[2] }));
	} catch (e) { console.log(f, "ERR", e.message.slice(0, 120)); }
}
