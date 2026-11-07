#!/usr/bin/env node
// #1125: what carries the body for FLOAT comes from the skin, the GROUND hint lifts the sunk limb before the root, and
// what a spec relaxes in QA is reported.
//   FLOAT    no air run where any skin but the feet lies within 5 cm of the floor or a top, or a hand on a scene body
//            (qa/support.js); a body 25 cm up with its hips held still floats
//   GROUND   "<part> below floor" (qa/hints-floor.js): a leg lying along the floor gets foot_<k> up, a kneeling knee its
//            knee pole turned up or its foot moved, a prone upper arm its elbow pole turned up with the trunk left on the
//            floor, a trunk in the floor the root up by the trunk's depth; only that one lifts the root, and a GROUND frame
//            is never a FLOAT frame
//   relaxed  observations.relaxed (qa/relaxed.js): checks.limits above their defaults, declared supports the body never
//            touches, naming no part, carrying frames alone with their part off the object, or not needed
// Physics bench v2 (2026-11-07): trip-run r1 FLOAT f61-94 and crawl r1 FLOAT beside "root up" GROUND hints on the same
// frames (783 frames over 81 rebuilt compiles) while the body lay on the floor; crawl r1 f91 (call 20): the upper arm
// 3.1 cm in with the hips 0.8 cm over the floor, where "root up 0.032" took the trunk 4 cm off it; the muscle-up r1
// fixture FLOAT f20-74 and f99-139 on the bar once its declared supports are left out; roof-fall-back r2 accLimb 0.4
// (default 0.05) and QA 0.
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { applyPatch } from "../../src/motion3/json-patch.js";
import { airRuns, floatChecks } from "../../src/motion3/qa/style.js";
import { floorDepths, floorParts } from "../../src/motion3/qa/floor.js";
import { m3 } from "../../src/motion3/qa/fmt.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const SPEC = "cozyclay.motion-spec.v1", I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], NONE = motionScene([]);
const line = r => r.qa.groups.map(g => `${g.kind} ${g.subject} ${g.worst} x${g.count} :: ${g.hint ?? ""}`).join(" | ");
const held = (set, frames = 40) => ({ schema: SPEC, fps: 24, frames, keys: [{ f: 0, ...set }, { f: frames - 1, ...set }] });
// kneeling upright with the feet lifted off the floor behind (the get-up of trip-run r1 f85-94): the knees carry the body
const kneel = lift => ({ pose: "kneel", set: { root: [0, 0.5 + lift, 0], foot_l: [0.12, 0.2 + lift, -0.38], foot_r: [-0.12, 0.2 + lift, -0.38] } });

for (const model of ["y-bot-tpose", "x-bot-tpose"]) {
	const sk = skeletonFor(model), compile = (spec, scene = NONE) => compileSpec(spec, { sk, scene });
	// 1. the knees on the floor carry the body; the same pose in the air floats
	const knees = compile(held(kneel(0))), ground = knees.qa.groups.filter(g => g.kind === "GROUND" && /^(shin|thigh)_/.test(g.subject));
	expect(`${model}: kneeling with the feet up, the knees in the floor: GROUND on a shin, no FLOAT, no air run`,
		ground.length >= 1 && !knees.qa.groups.some(g => g.kind === "FLOAT") && airRuns(knees.out).length === 0, line(knees));
	const groundFrames = knees.out.frames.flatMap(({ s }, f) => (floorParts(sk, s, 0.01).length ? [f] : [])), floatFrames = new Set(floatChecks(knees.out).map(i => i.frame));
	expect(`${model}: no frame is both GROUND (${groundFrames.length} frames) and FLOAT`, groundFrames.length > 0 && groundFrames.every(f => !floatFrames.has(f)));
	const knee = ground[0], kneeFixed = knee?.patch && compile(applyPatch(knees.spec, knee.patch)).qa.groups.find(g => g.subject === knee.subject);
	expect(`${model}: the kneeling knee's hint moves that leg (its knee turned up or its foot), never the root, and its patch takes the knee most of the way out`,
		/^(knee_[lr]: key \[[^\]]*\] at f\d+ \(now \[[^\]]*\](, held f\d+-\d+(: turn that hold)?)?\) \(shin_[lr] 0\.\d+ m under the floor\): the knee turns \d+ deg up off the floor|foot_[lr]: move \[.*\] m at f\d+ \(shin_[lr] 0\.\d+ m under the floor\): the knee (rides the foot|opens off the floor)), the hips stay/.test(knee?.hint ?? "")
		&& knee.patch && (!kneeFixed || kneeFixed.worst < knee.worst / 2), `${knee?.hint} -> ${kneeFixed?.worst}`);
	const air = compile(held(kneel(0.25))), fl = air.qa.groups.find(g => g.kind === "FLOAT");
	expect(`${model}: the same kneel 25 cm over the floor, hips still: FLOAT on every frame`, fl?.count === 40 && fl.first === 0 && fl.last === 39, line(air));

	// 2. a leg lying along the floor with its knee pointed into it: its own foot lifts it, the hips stay
	const prone = compile(held({ set: { root: [0, 0.2, 0], pitch: 80, foot_l: [0.1, 0.04, -0.7], foot_r: [-0.1, 0.04, -0.7], knee_l: [0, -1, 0], knee_r: [0, -1, 0],
		armw_l: 0, armw_r: 0, abend_l: 90, abend_r: 90, aswing_l: -90, aswing_r: -90 } }, 30));
	const leg = prone.qa.groups.find(g => g.kind === "GROUND" && /^(shin|thigh)_/.test(g.subject));
	expect(`${model}: prone, the knees bent down into the floor: the hint moves the foot up by the depth, not the root`,
		/^foot_([lr]): move \[0, \+0\.\d+, 0\] m at f\d+ \((thigh|shin)_\1 0\.\d+ m under the floor\): the knee rides the foot, the hips stay(; it leaves 0\.\d+ m in)?$/.test(leg?.hint ?? ""), line(prone));
	const lifted = leg?.patch && compile(applyPatch(prone.spec, leg.patch)).qa.groups.find(g => g.subject === leg.subject);
	expect(`${model}: its patch takes that ${leg?.subject.split(" ")[0]} out of the floor (or most of the way)`, leg?.patch && (!lifted || lifted.worst < leg.worst / 2), `${leg?.worst} -> ${lifted?.worst}`);

	// 3. army crawl r1 f91: prone, the trunk on the floor, the right upper arm 3 cm in with its hand on the floor ahead. The hand
	// up leaves it in; the elbow turned up takes it out and the trunk stays on the floor (the root up took it 4 cm off it)
	const crawl = compile(held({ set: { root: [0, 0.15, 0], pitch: 88, head_pitch: -45, armw_l: 1, armw_r: 1, hand_l: [0.22, 0.093, 0.38], hand_r: [-0.22, 0.08, 0.66],
		elbow_l: [0.5, -1, 0], elbow_r: [-0.5, -1, 0], foot_l: [0.38, 0.218, -0.51], foot_r: [-0.38, 0.218, -0.79], fpitch_l: 60, fpitch_r: 60, knee_l: [1, 0.1, 0.2], knee_r: [-1, 0.1, 0.2] } }, 30));
	const uarm = crawl.qa.groups.find(g => g.subject === "uarm_r below floor"), trunkOver = s => -Math.max(...["hips", "torso_lo", "torso_hi"].map(p => floorDepths(sk, s).get(p)));
	expect(`${model}: prone crawl, the upper arm 3 cm in: the hint turns elbow_r up, the shoulders stay, and no GROUND hint lifts the root`,
		/^elbow_r: key \[[^\]]*\] at f\d+ \(now \[-0\.5, -1, 0\], held f0-29(: turn that hold)?\) \(uarm_r 0\.0\d+ m under the floor\): the elbow turns \d+ deg up off the floor, the shoulders stay$/.test(uarm?.hint ?? "")
		&& trunkOver(crawl.out.frames[10].s) < 0.04 && !crawl.qa.groups.some(g => g.kind === "GROUND" && /^root/.test(g.hint ?? "")), line(crawl));
	const turned = uarm?.patch && compile(applyPatch(crawl.spec, uarm.patch)), after = turned?.out.frames[uarm.worstFrame].s;
	expect(`${model}: its patch takes the upper arm out of the floor and leaves the trunk where it lay`, after && !turned.qa.groups.some(g => g.subject === "uarm_r below floor")
		&& Math.abs(trunkOver(after) - trunkOver(crawl.out.frames[uarm.worstFrame].s)) < 0.002, turned && `${m3(trunkOver(after))} m ${line(turned)}`);

	// 4. the trunk in the floor: sitting 4 cm low, the root up by the trunk's own depth
	const sit = compile(held({ pose: "sit_floor", set: { root: [0, 0.12, -0.1] } }, 30)), body = sit.qa.groups.find(g => g.kind === "GROUND" && !/^(fingers|hand|farm)_/.test(g.subject));
	expect(`${model}: sitting with the hips in the floor: the root up by the hips' depth`, /^root: move \[0, \+0\.0\d+, 0\] m at f\d+ \(hips 0\.0\d+ m under the floor\); a part that lies on the floor/.test(body?.hint ?? ""), line(sit));
}

// 5. army crawl r1 call 20 (the agent's spec, test/motion3/fixtures/bench-crawl-r1-spec.json): GROUND uarm_r f79-336, the
// trunk 0.8 cm over the floor at f91. The hint was "root: move [0, +0.032, 0] m at f91 (hand_r up leaves the elbow in)",
// which lifted the trunk 4 cm off the floor; now the elbow held f68-351 turns up, on its hold, and the trunk stays
const cr = JSON.parse(readFileSync(new URL("../motion3/fixtures/bench-crawl-r1-spec.json", import.meta.url), "utf8")), net = motionScene(cr.objects), crSk = skeletonFor(cr.model);
const crawlR1 = compileSpec({ fps: 24, ...cr.spec }, { sk: crSk, scene: net }), arm = crawlR1.qa.groups.find(g => g.subject === "uarm_r below floor");
const lowTrunk = (r, f) => -Math.max(...["hips", "torso_lo", "torso_hi"].map(p => floorDepths(crSk, r.out.frames[f - (r.out.f0 ?? 0)].s).get(p)));
expect("crawl r1 call 20: GROUND uarm_r turns the elbow's hold up, and no GROUND hint lifts the root",
	/^elbow_r: key \[[^\]]*\] at f91 \(now \[-0\.5, -1, 0\], held f68-351: turn that hold\) \(uarm_r 0\.031 m under the floor\): the elbow turns \d+ deg up off the floor, the shoulders stay$/.test(arm?.hint ?? "")
	&& !crawlR1.qa.groups.some(g => g.kind === "GROUND" && /^root/.test(g.hint ?? "")), arm?.hint);
const crawlFixed = arm?.patch && compileSpec({ fps: 24, ...applyPatch(structuredClone(cr.spec), arm.patch) }, { sk: crSk, scene: net });
expect("its patch turns the whole hold (the 15 elbow_r keys f68-351): uarm_r out of the floor on all its frames, the trunk still 0.8 cm over it at f91",
	arm?.patch?.length === 15 && arm.patch.every(o => /^\/keys\/\d+\/set\/elbow_r$/.test(o.path)) && crawlFixed && !crawlFixed.qa.groups.some(g => g.subject === "uarm_r below floor") && Math.abs(lowTrunk(crawlFixed, 91) - lowTrunk(crawlR1, 91)) < 0.002 && lowTrunk(crawlFixed, 91) < 0.02,
	`${arm?.patch?.length} ops, trunk ${crawlFixed && m3(lowTrunk(crawlFixed, 91))} m, ${crawlFixed && line(crawlFixed)}`);

// 6. hanging from a bar: the hands on it carry the body, so the declared supports are not needed
const sk = skeletonFor("y-bot-tpose");
const mu = JSON.parse(readFileSync(new URL("../motion3/fixtures/bench-muscleup-r1-spec.json", import.meta.url), "utf8")), bar = motionScene(mu.objects);
const { checks, ...bare } = mu.spec, declared = compileSpec({ fps: 24, ...mu.spec }, { sk, scene: bar }), undeclared = compileSpec({ fps: 24, ...bare }, { sk, scene: bar });
expect("muscle-up r1 without its declared bar supports: no FLOAT, the jump to the bar (f20-23) the one air run left (f20-74 and f99-139 were FLOAT)",
	checks?.supports?.length === 2 && !undeclared.qa.groups.some(g => g.kind === "FLOAT") && JSON.stringify(airRuns(undeclared.out)) === "[[20,23]]", `${JSON.stringify(airRuns(undeclared.out))} ${line(undeclared)}`);
expect("with them, observations.relaxed says the supports are not needed", declared.observations.relaxed?.length === 1 && /^checks\.supports \[0\] hand_l, \[1\] hand_r: .*not needed$/.test(declared.observations.relaxed[0]),
	JSON.stringify(declared.observations.relaxed));

// 7. what a spec relaxes: the limits above their defaults (not those a raise makes stricter or that only opt a style check in),
// and supports the body never touches, naming no part, carrying frames alone, or not needed
const scene = { objects: { mat: { pos: [0, 0, 0], R: I3, half: [0.6, 0.005, 0.8] }, crate: { pos: [2, 0, 0], R: I3, half: [0.3, 0.3, 0.3] } } };
const relaxed = compileSpec({ ...held(kneel(0)), checks: { limits: { accLimb: 0.4, groundAllow: 0.03, plantH: 0.03, speedLimb: 0.3, knee: 160 },
	supports: [{ object: "crate" }, { object: "mat", part: "thigh" }, { object: "mat", part: "farm_l", tol: 0.6 }, { object: "mat", part: "shin_l" }] } }, { sk, scene });
const lines = relaxed.observations.relaxed ?? [], has = re => lines.some(l => re.test(l));
expect("raised limits: accLimb and groundAllow named with their defaults, plantH, speedLimb and knee not",
	has(/^checks\.limits above the defaults: accLimb 0\.4 \(default 0\.05\), groundAllow 0\.03 \(default 0\.01\): POP, ACC, GROUND under them go unreported/) && !has(/plantH|speedLimb|knee 160/), JSON.stringify(lines));
expect("a forearm that never comes within 5 cm of the mat, carried by its tol 0.6", has(/^checks\.supports\[2\] farm_l on mat: farm_l never comes within 0\.05 m of mat \(nearest 0\.\d+ m\), yet tol 0\.6 carries f0-39$/), JSON.stringify(lines));
expect("a part with no side carries nothing", has(/^checks\.supports part thigh: no such part/), JSON.stringify(lines));
expect("the hips never near the crate", has(/^checks\.supports \[0\] hips on crate \(nearest (over )?\d\.\d+ m\): never within 0\.05 m of it/), JSON.stringify(lines));
expect("a shin on the mat is not needed: the skin carries the body there", has(/^checks\.supports \[3\] shin_l: .*not needed$/), JSON.stringify(lines));
expect("five lines at most, and none on a spec that relaxes nothing", lines.length === 5 && compileSpec(held(kneel(0)), { sk, scene }).observations.relaxed === undefined, JSON.stringify(lines));

if (failures) { console.error(`${failures} float-support check(s) failed`); process.exit(1); }
console.log("verify-motion3-float-support: all checks passed");
