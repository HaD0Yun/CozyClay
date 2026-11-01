#!/usr/bin/env node
// thin.js (variant J, deep research 14): an installing compile drops free-span keys one at a time while QA groups and problems
// stay; holds, the span boundaries, speed extremes and the frames a patch touched are kept; thin: false opts out.
import { readFileSync } from "node:fs";
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { motionScene } from "../../src/motion3/scene.js";
import { isFillKey } from "../../src/motion3/bricks/fill-src.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; };
const load = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}-spec.json`, import.meta.url), "utf8"));
// the move-start delay of the bench scorer (deep research 15): the first frame 10 joints average 0.15 m/s, in seconds
const BONES = ["Hips", "Head", "LeftHand", "RightHand", "LeftFoot", "RightFoot", "LeftLeg", "RightLeg", "LeftForeArm", "RightForeArm"];
function onset(doc, spec) {
	const sk = skeletonFor(doc.model), F = compileSpec({ fps: 24, ...spec }, { sk, scene: motionScene(doc.objects) }).out.frames, ix = BONES.map(b => sk.index[b]);
	for (let f = 1; f < F.length; f++) if (ix.reduce((m, i) => m + Math.hypot(...F[f].s.P[i].map((v, k) => v - F[f - 1].s.P[i][k])) * 24, 0) / ix.length >= 0.15) return (f - 1) / 24;
	return 0;
}
const frames = spec => new Set(spec.keys.filter(k => !isFillKey(k)).map(k => k.f));
for (const [name, least] of [["h-sit", 0.15], ["h-parkour", 0.15]]) {
	const doc = load(name), job = extra => runCompileJob({ model: doc.model, scene: motionScene(doc.objects), spec: doc.spec, installing: true, thinLimitMs: 120000, ...extra });
	const thin = job({}), plain = job({ thin: false }), t = thin.thinned;
	expect(`${name}: keys drop by ${least * 100}%+ (${t?.before} -> ${t?.after})`, t && (t.before - t.after) / t.before >= least, JSON.stringify(t));
	expect(`${name}: QA groups and problems unchanged or lower`, thin.qa.groups.length <= plain.qa.groups.length && (thin.qa.problems ?? 0) <= (plain.qa.problems ?? 0), `${plain.qa.groups.length} -> ${thin.qa.groups.length}`);
	expect(`${name}: the stored spec lacks exactly the removed frames; first and last stay`, t && [...frames(doc.spec)].filter(f => !frames(thin.stored).has(f)).sort((a, b) => a - b).join() === t.removed.join()
		&& frames(thin.stored).has(Math.min(...frames(doc.spec))) && frames(thin.stored).has(Math.max(...frames(doc.spec))));
	expect(`${name}: thin: false and a non-installing compile leave the keys`, plain.thinned === undefined && runCompileJob({ model: doc.model, scene: motionScene(doc.objects), spec: doc.spec }).thinned === undefined);
	const guard = job({ protect: t?.removed ?? [] }).thinned;
	expect(`${name}: protected frames (a patch's) are never removed`, !guard || guard.removed.every(f => !(t?.removed ?? []).includes(f)), JSON.stringify(guard));
	expect(`${name}: the move-start delay stays (within 0.1 s)`, onset(doc, thin.stored) >= onset(doc, plain.stored) - 0.1, `${onset(doc, plain.stored)} -> ${onset(doc, thin.stored)}`);
	// the time limit (10 s by default) is honoured: none left, nothing is thinned
	expect(`${name}: a spent time limit thins nothing`, job({ thinLimitMs: 0 }).thinned === undefined);
}
// a hold: two neighbouring keys with the same pose in a free span stay together
{
	const doc = load("h-sit"), keys = doc.spec.keys.filter(k => !isFillKey(k)), job = spec => runCompileJob({ model: doc.model, scene: motionScene(doc.objects), spec, installing: true, thinLimitMs: 120000 });
	const removed = job(doc.spec).thinned?.removed ?? [], f = removed[0];
	const k = keys.find(x => x.f === f), next = keys.find(x => x.f > f);
	const held = { ...doc.spec, keys: doc.spec.keys.map(x => (x === next ? { ...x, set: { ...k.set, ...Object.fromEntries(Object.keys(next.set).filter(c => !(c in k.set)).map(c => [c, next.set[c]])) } } : x)) };
	const r = job(held).thinned;
	expect("a key made a hold with its neighbour is kept", !r?.removed.includes(f) && !r?.removed.includes(next.f), JSON.stringify({ f, next: next.f, removed: r?.removed }));
}
// a fast move: two keys under 14 frames apart whose target moves over 1.5 m/s stay, however little QA cares
{
	const doc = load("h-sit"), job = spec => runCompileJob({ model: doc.model, scene: motionScene(doc.objects), spec, installing: true, thinLimitMs: 120000 });
	const f = job(doc.spec).thinned?.removed?.[0], k = doc.spec.keys.find(x => x.f === f && !isFillKey(x));
	if (!k.set.hand_r) k.set.hand_r = [0, 1, 0];
	const fast = { ...doc.spec, keys: [...doc.spec.keys, { f: f + 5, set: { ...k.set, hand_r: (k.set.hand_r ?? [0, 1, 0]).map((v, i) => (i === 2 ? v + 0.5 : v)), ...(k.set.hand_r ? {} : { armw_r: 1 }) } }].sort((a, b) => a.f - b.f) };
	const r = job(fast).thinned;
	expect("a key 5 frames from its neighbour is kept with it", !r?.removed.includes(f) && !r?.removed.includes(f + 5), JSON.stringify({ f, removed: r?.removed }));
}
if (failures) { console.error(`${failures} thin check(s) failed`); process.exit(1); }
console.log("verify-motion3-thin: all checks passed");
