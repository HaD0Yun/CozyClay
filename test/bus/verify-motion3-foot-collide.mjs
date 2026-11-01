#!/usr/bin/env node
// COLLIDE for the feet (qa/foot-checks.js): the foot's skin against scene bodies. Session e7edb718: a swinging toe
// went 8 cm into a stair's riser with QA clean, because the shin capsule ends at the ankle. fix.clear now lifts those
// toes on its own. With it off the stairs take reports both toes, its hint lifts the foot over the step, and repair
// clears most of it; a foot resting on a body's top is a step (up to the ground's 1 cm) and a sole sunk deeper is
// reported; allow excuses a foot.
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { repairSpec } from "../../src/motion3/repair.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${JSON.stringify(detail)}`}`);
	if (!condition) failures += 1;
}

const sk = skeletonFor("y-bot-tpose");
const stairs = JSON.parse(readFileSync(new URL("../fixtures/foot-collide/stairs.json", import.meta.url), "utf8"));
const stairScene = motionScene(stairs.objects), cleared = { fps: 24, ...stairs.spec }, stairSpec = { ...cleared, fix: { ...cleared.fix, clear: false } };
const foot = r => r.qa.groups.filter(g => /^foot_[lr] x /.test(g.subject));

const onByDefault = compileSpec(cleared, { sk, scene: stairScene });
expect("fix.clear, on by default, takes both toes out of the risers", foot(onByDefault).length === 0 && onByDefault.out.fixed?.clear?.frames > 0, foot(onByDefault));

const r = compileSpec(stairSpec, { sk, scene: stairScene }), groups = foot(r);
const right = groups.find(g => g.subject === "foot_r x cube-2"), left = groups.find(g => g.subject === "foot_l x cube-3");
expect("the right toe in step 2's riser is reported (f72-80, about 8 cm)", right && right.first >= 70 && right.last <= 82 && right.worst > 0.06 && right.limit === 0.005, groups);
expect("the left toe in step 3's riser is reported (f100-108, about 7 cm)", left && left.first >= 98 && left.last <= 110 && left.worst > 0.06, groups);
expect("the hint lifts the foot over the step it went into through a side, with a patch", /^foot_r: move \[0, \+0\.\d+, 0\] m at f\d+ \(over cube-2's top/.test(right?.hint ?? "") && right?.patch?.length > 0, right?.hint);

const once = s => ({ sk, ...compileSpec(s, { sk, scene: stairScene }) }), fixed = repairSpec(stairSpec, { rounds: 4 }, once);
expect("repair { rounds: 4 } lifts the swings: QA 18 -> at most 4", r.qa.total === 18 && fixed.result.qa.total <= 4, { before: r.qa.total, after: fixed.result.qa.total });

const excused = compileSpec({ ...stairSpec, checks: { allow: [{ part: "foot", object: "cube-2", depth: 0.2 }] } }, { sk, scene: stairScene });
expect("allow { part: \"foot\", object } excuses that foot in that body", !foot(excused).some(g => / x cube-2$/.test(g.subject)) && foot(excused).some(g => / x cube-3$/.test(g.subject)), foot(excused).map(g => g.subject));

// Standing on a 40 cm block: a foot on a top is a step; sunk 2 cm it is in the block.
const ank = sk.restWorldPos[sk.index.LeftFoot][1], top = 0.4;
const block = motionScene([{ id: "block", name: "Block", renderer: "cube", x: 0, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 1, scaleY: top, scaleZ: 1, footprint: { width: 1, depth: 1 }, height: 1 }]);
const stand = sink => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 12, fix: false,
	keys: [{ f: 0, set: { root: [0, sk.restWorldPos[sk.index.Hips][1] - 0.01 + top - sink, 0], yaw: 0, foot_l: [0.09, ank + top - sink, 0], foot_r: [-0.09, ank + top - sink, 0], fyaw_l: 0, fyaw_r: 0 } }] });
const resting = compileSpec(stand(0), { sk, scene: block }), shallow = compileSpec(stand(0.005), { sk, scene: block }), sunk = compileSpec(stand(0.02), { sk, scene: block });
expect("feet resting on a block's top are not a collision", foot(resting).length === 0, foot(resting));
expect("soles 5 mm into the top are within the ground's 1 cm", foot(shallow).length === 0, foot(shallow));
const deep = foot(sunk);
expect("soles 2 cm into the top are reported against the ground's 1 cm", deep.length === 2 && deep.every(g => g.limit === 0.01 && g.worst > 0.012), deep);
expect("a sunk sole's hint raises it out of the top", deep.every(g => /^foot_[lr]: move \[0, \+0\.\d+, 0\] m at f\d+ \(out of block's top\)/.test(g.hint ?? "")), deep.map(g => g.hint));

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("PASS foot collisions");
