#!/usr/bin/env node
// The repair's progress gate: clearing the last shallow hit is progress, but not at another contact's expense.
import assert from "node:assert/strict";
import { compileMotion } from "../../src/motion3/compiler/compile.js";
import { runMotionQa } from "../../src/motion3/qa/index.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";

const sk = skeletonFor("y-bot-tpose"), P = sk.restWorldPos, I = sk.index;
const spec = {
	schema: "cozyclay.motion-spec.v1", fps: 24, frames: 1, idle: false, flow: false, auto: false, fix: { retime: false },
	keys: [{ f: 0, set: { root: [0, P[I.Hips][1] - 0.01, 0], foot_l: P[I.LeftFoot].slice(), foot_r: P[I.RightFoot].slice(),
		armw_l: 0, armw_r: 0, aswing_l: 60, arm_rest: 89.8 } }],
};
const scene = { objects: {} }, qa = (out, source = spec) => runMotionQa(sk, out, source, { explain: false });
const before = compileMotion(spec, { sk, scene }, { selfRepair: false }), after = compileMotion(spec, { sk, scene });
const was = qa(before), now = qa(after), hit = was.groups.find(g => g.kind === "BODY");
assert.equal(was.groups.length, 1, "the fixture has exactly one collision before repair");
assert.ok(hit && hit.worst > hit.limit && hit.worst - hit.limit < 0.002, "the last collision is less than 2 mm past the existing limit");

// The forearm can clear its hip by moving out, but that same move enters this fixed wall.
const wall = { objects: { wall: { pos: [-0.321, 0.94, -0.0617147], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [0.1, 0.05, 0.1] } } };
const blockedBefore = compileMotion(spec, { sk, scene: wall }, { selfRepair: false });
const unsafeSpec = { ...spec, keys: [{ f: 0, set: { ...spec.keys[0].set, arm_rest: 88.8 } }] };
const unsafe = compileMotion(unsafeSpec, { sk, scene: wall }, { selfRepair: false });
const blocked = compileMotion(spec, { sk, scene: wall }), blockedQa = qa(blocked);
assert.ok(!qa(blockedBefore).groups.some(g => g.kind === "COLLIDE"), "the wall is clear before any repair move");
assert.ok(!qa(unsafe, unsafeSpec).groups.some(g => g.kind === "BODY"), "the outward move clears the original collision");
assert.ok(qa(unsafe, unsafeSpec).groups.some(g => g.kind === "COLLIDE" && g.subject === "farm_r x wall"), "the outward move would add a wall collision");
assert.ok(!blockedQa.groups.some(g => g.kind === "COLLIDE"), "the gate rejects a move that adds the wall collision");
assert.ok(blockedQa.groups.length <= was.groups.length, "the guarded result has no additional contact groups");
console.log(`PASS new-collision guard: ${JSON.stringify(qa(unsafe, unsafeSpec).groups)} -> ${JSON.stringify(blockedQa.groups)}`);

assert.ok(after.fixed.self?.spans?.length > 0, "the gate accepts a move that clears the last collision with gain under 2 mm");
assert.ok(now.ok, `the last collision is cleared: ${JSON.stringify(now.groups)}`);
console.log(`PASS shallow progress: ${hit.worst} m -> QA 0, gain ${(hit.worst - hit.limit).toFixed(4)} m`);
console.log("motion3 self gate: all checks passed");
