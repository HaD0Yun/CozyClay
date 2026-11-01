#!/usr/bin/env node
// Named key poses (src/motion3/poses.js): every pose holds QA-clean on Y Bot and X Bot, a key naming one expands to its
// channels (at, face, set overrides), and a spec of named poses compiles like the same spec written out.
import assert from "node:assert/strict";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { POSE_NAMES, poseChannels, expandPoses } from "../../src/motion3/poses.js";

const scene = motionScene([]);
for (const rig of ["y-bot-tpose", "x-bot-tpose"]) {
	const sk = skeletonFor(rig);
	for (const name of POSE_NAMES) {
		// fix: false: the pose itself must hold, not the compiler's correction of it (the slide fix kept a planted foot over a kneel key)
		const r = compileSpec({ schema: "cozyclay.motion-spec.v1", frames: 12, fps: 24, fix: false, keys: [{ f: 0, pose: name }] }, { sk, scene });
		assert.equal(r.qa.groups.length, 0, `${rig} ${name}: ${r.qa.groups.map(g => `${g.kind} ${g.subject}`).join(", ")}`);
		const P = r.out.frames[0].s.P, I = sk.index, y = j => P[I[j]][1];
		const contact = { kneel: () => y("LeftLeg") < 0.1 && y("RightLeg") < 0.1, kneel_one: () => y("RightLeg") < 0.1, sit_floor: () => y("Hips") < 0.2, squat: () => y("Hips") < 0.5, stand: () => y("Hips") > 0.9 * P[I.Head][1] / 1.6 }[name];
		assert.ok(!contact || contact(), `${rig} ${name}: the pose does not reach what it says (knees ${y("LeftLeg").toFixed(3)}/${y("RightLeg").toFixed(3)}, hips ${y("Hips").toFixed(3)})`);
	}
	console.log(`PASS ${rig}: all ${POSE_NAMES.length} poses hold QA-clean with every fix off and reach what they say (knees down, hips on the floor)`);
}
const sk = skeletonFor("y-bot-tpose");
const moved = poseChannels("stand", sk, { at: [1, 2], face: 90 });
assert.deepEqual(moved.root, [1, 0.99, 2]);
assert.equal(moved.yaw, 90);
assert.ok(Math.abs(moved.foot_l[2] - 2 + 0.1) < 1e-6 && Math.abs(moved.foot_l[0] - 1) < 1e-6 && moved.knee_l[2] === 1, JSON.stringify(moved));
console.log("PASS at and face move and turn the pose (stand faced +X: the left foot toward -Z)");
const spec = expandPoses({ keys: [{ f: 0, pose: "stand" }, { f: 20, pose: "sit_floor", set: { spine_pitch: 12 } }] }, sk);
assert.ok(spec.keys.every(k => !("pose" in k)) && spec.keys[1].set.spine_pitch === 12 && spec.keys[1].set.root[1] === 0.16);
assert.throws(() => expandPoses({ keys: [{ f: 0, pose: "handstand" }] }, sk), /not a pose.*stand, ready/);
console.log("PASS a named key expands (set overrides it); an unknown name lists the poses");
// QA sees what it could not: a key the take never reaches (KEY) and hips that jump in one frame (TELEPORT)
{
	const r = compileSpec({ schema: "cozyclay.motion-spec.v1", frames: 20, keys: [{ f: 0, pose: "stand" }, { f: 10, set: { root: [0, 0.99, 0] } }, { f: 11, set: { root: [1.5, 0.99, 0] } }, { f: 19, pose: "stand", at: [1.5, 0] }] }, { sk, scene });
	assert.ok(r.qa.groups.some(g => g.kind === "TELEPORT" && g.first === 11), JSON.stringify(r.qa.groups.map(g => [g.kind, g.first])));
	const walk = compileSpec({ schema: "cozyclay.motion-spec.v1", frames: 20, keys: [{ f: 0, pose: "stand" }, { f: 19, pose: "stand", at: [0, 0.4] }] }, { sk, scene });
	assert.ok(!walk.qa.groups.some(g => g.kind === "TELEPORT"), "a 0.4 m drift over 19 frames is no jump");
	console.log("PASS QA: TELEPORT names a one-frame hips jump, not a slow move");
}
console.log("verify-motion3-poses: all checks passed");
