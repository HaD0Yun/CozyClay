#!/usr/bin/env node
// #1113: QA measures the whole body against the floor, the fingers against the scene and a bar grip at the palm.
//   GROUND   "<part> below floor" (qa/floor.js): the fitted skin of every part above the soles, the fingers on their phalanx
//            capsules, one part a frame for each arm below the elbow and one for the rest; deeper than groundAllow (1 cm)
//   COLLIDE  "fingers_<k> x <id>" (qa/finger-collide.js): the phalanges in a scene body; the hand's allow covers them
//   PALM_GAP "<side> palm centre off <id>" (qa/grasp-checks.js): a hand fitted to a bar, any grasp or none (#1127; a power
//            grip only before), with its palm centre more than 4 cm off it
// Physics bench 2026-11-07 (main 7ddf97c9), two installed takes replayed (test/motion3/fixtures/bench-*-spec.json): handstand r3's
// fingertips 18.3 cm under the floor (verify_result 0.183 m on the skinned mesh) and the muscle-up's palm centres 7.0-7.8 cm
// off the bar with the fingers 0.6-1.5 cm from it, both QA 0 then.
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { autoSpec } from "../../src/motion3/auto-spec.js";
import { applyPatch } from "../../src/motion3/json-patch.js";
import { floorDepths } from "../../src/motion3/qa/floor.js";
import { fingerCapsules } from "../../src/motion3/qa/geometry.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const load = name => JSON.parse(readFileSync(new URL(`../motion3/fixtures/${name}`, import.meta.url), "utf8"));
const line = r => r.qa.groups.map(g => `${g.kind} ${g.subject} ${g.worst} x${g.count}`).join(" | ");
const SPEC = "cozyclay.motion-spec.v1";

// 1. handstand r3: the hands planted by their wrists 5 cm up with the fingers pointing down into the floor
const hs = load("bench-handstand-r3-spec.json"), hsScene = motionScene(hs.objects);
const job = runCompileJob({ model: hs.model, scene: hsScene, spec: hs.spec, hintLimitMs: 0 });
const fingers = side => job.qa.groups.find(g => g.kind === "GROUND" && g.subject === `fingers_${side} below floor`);
expect("handstand r3: GROUND fingers_l and fingers_r below floor, 18 cm deep (verify_result 0.183 m), over the 167 frames the hands stand",
	["l", "r"].every(k => fingers(k)?.worst > 0.175 && fingers(k).worst < 0.19 && fingers(k).count >= 150 && fingers(k).limit === 0.01), line(job));
// #1127 reads the knees on the leg itself (qa/checks.js kneeBack): on the kick-up and the come-down the support knee juts away
// from the hands, the shin toward them (the hinge to the pelvis's right, 168-180 deg from the knee's front), which the toe test passed
const kick = job.qa.groups.filter(g => g.kind === "KNEE");
expect("handstand r3: nothing else (the take was QA 0), but the knees bent backward on the kick-up and the come-down (#1127)",
	job.qa.groups.every(g => g.kind === "GROUND" || g.kind === "KNEE") && kick.length === 2 && kick.every(g => / knee bends backward$/.test(g.subject) && g.first >= 30 && g.last <= 195), line(job));
// the hint turns the wrist (wflex) as far as it goes and says what is left; its patch takes the fingers most of the way out
const yb = skeletonFor(hs.model), plain = compileSpec({ fps: 24, ...autoSpec(hs.spec, yb) }, { sk: yb, scene: hsScene });
const fl = plain.qa.groups.find(g => g.subject === "fingers_l below floor");
expect("the fingers' hint keys the wrist flex and says how much is left to raise", /^wflex_l: key -?\d+ deg at f\d+ \(now 0\): the hand points the fingers 0\.18\d m into the floor; turned so, 0\.0\d+ m are left: raise the hand/.test(fl?.hint ?? ""), fl?.hint);
const turned = compileSpec(applyPatch(plain.spec, fl.patch), { sk: yb, scene: hsScene }).qa.groups.find(g => g.subject === "fingers_l below floor");
expect("its patch (wflex at one key) brings the left fingers up by 10 cm or more", fl.patch?.length === 1 && (!turned || turned.worst < fl.worst - 0.1), `${fl.worst} -> ${turned?.worst} ${JSON.stringify(fl.patch)}`);

// 2. muscle-up r1: the power grips hold the bar on the finger middles, the palm centres 7-8 cm off it
const mu = load("bench-muscleup-r1-spec.json"), muJob = runCompileJob({ model: mu.model, scene: motionScene(mu.objects), spec: mu.spec, hintLimitMs: 0 });
const palm = side => muJob.qa.groups.find(g => g.kind === "PALM_GAP" && g.subject === `${side} palm centre off bar`);
expect("muscle-up r1: PALM_GAP on both hands, the palm centre 7.8 cm off the bar (needs <= 4)", ["left", "right"].every(s => palm(s)?.worst > 0.07 && palm(s).worst < 0.085 && palm(s).limit === 0.04), line(muJob));
expect("muscle-up r1: nothing else (the take was QA 0)", muJob.qa.groups.every(g => g.kind === "PALM_GAP"), line(muJob));
expect("its hint says the palm is off and that moving the anchor does not seat the bar (no patch)", ["left", "right"].every(s => /palm centre 7\.\d cm off it .*does not seat it in the palm/.test(palm(s).hint)), palm("left")?.hint);
// #1127: in all 6 bar runs of bench v2 the agent switched to a hook grip or no grasp and PALM_GAP went quiet, the palm as far off;
// every grasp and a plain fit (no grasp) are judged, and the hint reports the limit with no patch
for (const grasp of ["hook", null]) {
	const anchors = Object.fromEntries(Object.entries(mu.spec.anchors).map(([n, a]) => { if (a.kind !== "object") return [n, a]; const { socket, grasp: _, ...rest } = a; return [n, grasp ? { ...rest, grasp } : rest]; }));
	const r = runCompileJob({ model: mu.model, scene: motionScene(mu.objects), spec: { ...mu.spec, anchors }, hintLimitMs: 0 }), gap = side => r.qa.groups.find(g => g.kind === "PALM_GAP" && g.subject === `${side} palm centre off bar`);
	expect(`muscle-up r1 with ${grasp ? `grasp ${grasp}` : "no grasp"}: PALM_GAP on both hands, the palm centre 6-9 cm off the bar, reported with no patch`,
		["left", "right"].every(s => gap(s)?.worst > 0.06 && gap(s).worst < 0.09 && gap(s).count > 60 && !gap(s).patch && new RegExp(`anchors\\.barLeft${grasp ? `\\.grasp ${grasp}` : " \\(no grasp\\)"}|anchors\\.barRight${grasp ? `\\.grasp ${grasp}` : " \\(no grasp\\)"}`).test(gap(s).cause) && /palm centre \d\.\d cm off it .*another grasp \(power, hook or none\) leaves the palm as far off.*report the palm off bar/.test(gap(s).hint)),
		line(r));
	if (!grasp) expect("muscle-up r1 with no grasp: a plain fit is judged on its palm only (no FINGER_*, THUMB_OFF, PALM_OFF or SUPPORT)", !r.qa.groups.some(g => /^(FINGER_|THUMB_OFF|PALM_OFF|SUPPORT)/.test(g.kind)), line(r));
}
const asked = muJob.observations.asked.find(l => l.startsWith("fingers on barLeft"));
expect("observations.asked reports the fingers' gap and the palm centre's on the grip's frames", /gap 0\.\d cm f\d+ \.\. 1\.\d cm f\d+ \(tol 4\); palm centre 7(\.\d)? \.\. 7\.\d cm \(needs <= 4\)$/.test(asked ?? ""), asked);

// 3. the fingers in a board: a hand held still toward it, its capsule 3 mm in (within the 5 mm allowance), the fingertips past it
const sk = skeletonFor("y-bot-tpose"), I = sk.index, I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const toward = extra => ({ schema: SPEC, fps: 24, frames: 30, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }],
	keys: [{ f: 0, set: { armw_r: 1, hand_r: [-0.22, 1.1, 0.34], elbow_r: [-0.5, -1, -0.3] } }], ...extra });
const free = compileSpec(toward(), { sk, scene: motionScene([]) }).out.frames[20].s;
const handFront = Math.max(free.P[I.RightHand][2], free.P[I.RightHandMiddle3][2]) + 0.022;
const tipFront = Math.max(...fingerCapsules(sk, free, "Right").map(([, a, b, r]) => Math.max(a[2], b[2]) + r));
const front = handFront - 0.003, depth = tipFront - front;
const board = { objects: { board: { pos: [-0.2, 0, front + 0.05], R: I3, half: [0.3, 0.8, 0.05] } } };
const inBoard = compileSpec(toward(), { sk, scene: board }), hit = inBoard.qa.groups.find(g => g.subject === "fingers_r x board");
expect(`the fingertips ${(depth * 100).toFixed(1)} cm past the hand capsule's front go into the board: COLLIDE fingers_r x board at the 5 mm allowance, the hand capsule within it`,
	depth > 0.008 && Math.abs(hit?.worst - depth) < 0.003 && hit.limit === 0.005 && !inBoard.qa.groups.some(g => g.subject === "hand_r x board"), `${depth} ${line(inBoard)}`);
expect("its hint moves the hand back out of the board", /^hand_r: move \[0, 0, -0\.0\d+\] m at f\d+ \(the fingers out of board\)/.test(hit?.hint ?? ""), hit?.hint);
const allowed = compileSpec(toward({ checks: { allow: [{ part: "hand", object: "board", depth: depth + 0.005 }] } }), { sk, scene: board });
expect("the hand's allow entry on the board lets its fingers touch as deep", !allowed.qa.groups.some(g => g.subject === "fingers_r x board"), line(allowed));
// through a body's top the fingers may sit the floor's allowance (1 cm) in it, as on the floor: the hanging hand over a block
const hang = { schema: SPEC, fps: 24, frames: 30, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }] };
const down = compileSpec(hang, { sk, scene: motionScene([]) }).out.frames[20].s, tips = fingerCapsules(sk, down, "Right");
const tipLow = Math.min(...tips.map(([, a, b, r]) => Math.min(a[1], b[1]) - r)), under = down.P[I.RightHandMiddle4];
const block = h => ({ objects: { block: { pos: [under[0], 0, under[2]], R: I3, half: [0.03, (tipLow + h) / 2, 0.03] } } });
const fingersIn = h => compileSpec(hang, { sk, scene: block(h) }).qa.groups.find(g => g.subject === "fingers_r x block");
expect("the hanging fingertips 0.8 cm into a block's top are within the floor's allowance; 1.5 cm in is COLLIDE at 1 cm", !fingersIn(0.008) && fingersIn(0.015)?.limit === 0.01 && Math.abs(fingersIn(0.015).worst - 0.015) < 0.002,
	JSON.stringify(fingersIn(0.015)));

// 4. the floor's measure is the skin: standing has nothing under the floor, and a hand lowered onto it is measured where its skin is
const standing = compileSpec({ schema: SPEC, fps: 24, frames: 24, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }] }, { sk, scene: motionScene([]) });
const deepest = Math.max(...standing.out.frames.flatMap(({ s }) => [...floorDepths(sk, s).values()]));
expect("standing: every part above the soles is out of the floor (its lowest skin point above y 0)", deepest < 0 && !standing.qa.groups.some(g => g.kind === "GROUND"), `${deepest}`);
const s0 = standing.out.frames[0].s, drop = Math.max(...floorDepths(sk, s0).entries().filter(([p]) => p === "fingers_r").map(([, d]) => -d)) + 0.03;
const lowered = { P: s0.P.map(p => [p[0], p[1] - drop, p[2]]), R: s0.R };
expect("the whole body lowered so the right fingertips go 3 cm under: fingers_r reads 3 cm", Math.abs(floorDepths(sk, lowered).get("fingers_r") - 0.03) < 1e-9, `${floorDepths(sk, lowered).get("fingers_r")}`);

// 5. one part a frame for each arm and for the rest: a body lying in the floor is one group, not one per part
const face = compileSpec({ schema: SPEC, fps: 24, frames: 90, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "hitReaction", f0: 20, args: { dir: [0, 1], speed: 3 } }] }, { sk, scene: motionScene([]) });
const lying = face.out.frames[89], parts = [...floorDepths(sk, lying.s).entries()].filter(([, d]) => d > 0.01).map(([p]) => p);
const atRest = face.qa.groups.filter(g => g.kind === "GROUND" && g.last === 89).map(g => g.subject);
expect(`a body lying face down in the floor (${parts.length} parts under it at f89): at most one GROUND group a driver there (each arm, the rest)`,
	parts.length >= 5 && atRest.length <= 3 && atRest.filter(sj => !/^(fingers|hand|farm)_/.test(sj)).length <= 1, `${parts.join(",")} -> ${atRest.join(", ")}`);

if (failures) { console.error(`${failures} floor-parts check(s) failed`); process.exit(1); }
console.log("verify-motion3-floor-parts: all checks passed");
