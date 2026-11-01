#!/usr/bin/env node
// C6 (lane D1): every hint may carry a fix (non-enumerable, never in the output), and qa/patch.js
// turns it into a JSON Patch on the agent's own spec: a user key near the frame is replaced, a
// skill key gets a new key appended, a standIdle stance moves its args.at, and path fixes
// (fix.penetration, fix.retime, an anchor point, an object field) are added or replaced. A body
// move (hold) changes what placed the body: a standIdle at, a walkTo's length, or root keys.
import { EXITCAR_SPEC, SCENE_OBJECTS } from "./fixtures/exitcar-scene.mjs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { I3 } from "../../src/motion3/compiler/math.js";
import { applyPatch } from "../../src/motion3/json-patch.js";
import { attachPatches } from "../../src/motion3/qa/patch.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor("x-bot-tpose"), I = sk.index, car = motionScene(SCENE_OBJECTS), empty = { objects: {} };
const compile = (spec, scene = car) => compileSpec(spec, { sk, scene });
const broken = edit => { const s = structuredClone(EXITCAR_SPEC); edit(s); return s; };
const json = JSON.stringify;
const stand = (extra = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }], ...extra });

// 1. The seat set 7 cm too low: the group's patch replaces keys[0] root, and applying it clears the hit.
const low = broken(s => { s.keys[0].set.root = [0.48, 0.85, -0.052]; });
let r = compile(low);
const seat = r.qa.groups.find(g => g.kind === "COLLIDE" && g.subject === "hips x Car_Seat_Driver");
const op = seat?.patch?.[0];
console.log(`  hips sunk: ${json(seat?.patch)}`);
expect("hips sunk: one replace of /keys/0/set/root, raised, x and z kept", seat?.patch?.length === 1 && op.op === "replace" && op.path === "/keys/0/set/root"
	&& op.value[0] === 0.48 && op.value[1] > 0.87 && op.value[2] === -0.052, json(seat?.patch));
expect("the fix rides on the group unseen: not in its keys or its JSON", seat?.fix?.channel === "root" && !Object.keys(seat).includes("fix") && !json(r.qa).includes("\"fix\""), json(Object.keys(seat ?? {})));
const raised = compile(applyPatch(low, seat.patch));
expect("applying the patch clears the seat collision", !raised.qa.groups.some(g => g.kind === "COLLIDE" && /hips x Car_Seat_Driver/.test(g.subject)), json(raised.qa.groups.map(g => g.subject)));
expect("the hint wording is unchanged", /^root: move \[0, \+0\.026, 0\] m at f0 \(out of Car_Seat_Driver\)$/.test(seat.hint), seat.hint);

// 2. A cause in a skill key: the feet are held from the standIdle key, so a key is appended.
const P = sk.restWorldPos, hipY = P[I.Hips][1] - 0.01;
const deep = stand({ fix: { reach: false }, keys: [{ f: 20, set: { root: [0, hipY, 0] } }, { f: 30, set: { root: [0, hipY + 0.04, 0] } }, { f: 40, set: { root: [0, hipY, 0] } }] });
r = compile(deep, empty);
const reach = r.qa.groups.find(g => g.kind === "REACH" && g.subject === "leg_miss_r"), add = reach?.patch?.[0];
console.log(`  reach from a skill key: cause ${reach?.cause}; ${json(reach?.patch)}`);
expect("skill key cause: add /keys/- at the worst frame, foot_r moved up toward the hip", /use\[0\] standIdle/.test(reach?.cause ?? "") && add?.op === "add" && add.path === "/keys/-"
	&& add.value.f === reach.worstFrame && Array.isArray(add.value.set.foot_r) && add.value.set.foot_r[1] > 0.1, json(reach?.patch));
expect("the appended key leaves the agent's keys alone", applyPatch(deep, reach.patch).keys.length === 4 && json(applyPatch(deep, reach.patch).keys.slice(0, 3)) === json(deep.keys));

// 3. A standIdle stance pushed sideways: the patch moves use[0].args.at, not a key (fix.stance off: on, the compiler
// slides the stance out itself, verify-motion3-stance-grasp.mjs).
const post = { objects: { Post: { pos: [0.16, 0.9, 0], R: I3(), half: [0.05, 0.3, 0.3] } } }, unplaced = () => stand({ fix: { stance: false } });
r = compile(unplaced(), post);
const hips = r.qa.groups.find(g => g.subject === "hips x Post");
console.log(`  stance into a post: ${json(hips?.patch)}`);
expect("standIdle cause: replace /use/0/args/at, moved away from the post", hips?.patch?.[0]?.op === "replace" && hips.patch[0].path === "/use/0/args/at" && hips.patch[0].value[0] < -0.05 && hips.patch[0].value[1] === 0, json(hips?.patch));
expect("applying it clears the hips hit", !compile(applyPatch(unplaced(), hips.patch), post).qa.groups.some(g => g.subject === "hips x Post"));

// 4. A hand 1.5 cm into a board: the hint's fix.penetration suggestion is the patch.
const held = fix => stand({ fix, keys: [{ f: 0, set: { armw_r: 1, hand_r: [-0.22, 1.1, 0.32], elbow_r: [-0.5, -1, -0.3] } }, { f: 30, set: { hand_r: [-0.22, 1.1, 0.36] } }, { f: 59, set: { hand_r: [-0.22, 1.1, 0.32] } }] });
const free = compile(held(undefined), empty).out.frames[30].s.P, front = Math.max(free[I.RightHand][2], free[I.RightHandMiddle3][2]) + 0.022;
const board = { objects: { Board: { pos: [-0.2, 0, front - 0.015 + 0.05], R: I3(), half: [0.3, 0.8, 0.05] } } };
r = compile(held(undefined), board);
const pen = r.qa.groups.find(g => g.subject === "hand_r x Board");
console.log(`  board: ${json(pen?.patch)}`);
expect("fix.penetration suggestion -> add /fix { penetration: 0.02 }", json(pen?.patch) === json([{ op: "add", path: "/fix", value: { penetration: 0.02 } }]), json(pen?.patch));
expect("an existing spec.fix gets the member added instead", json(compile(held({ slide: true }), board).qa.groups[0].patch) === json([{ op: "add", path: "/fix/penetration", value: 0.02 }]));
expect("applying it makes QA clean", compile(applyPatch(held(undefined), pen.patch), board).qa.ok);

// 5. Speed spikes past a speed limit the spec opted into (C13): the retime suggestion becomes /fix/retime.
// fix.retime is on by default (it stretches this throw clean), so the spec turns it off to see the suggestion
const thrown = { ...stand({ frames: 120, checks: { limits: { speedLimb: 0.16 } }, fix: { retime: false } }), keys: [{ f: 30, set: { armw_r: 0 } }, { f: 36, set: { armw_r: 1, hand_r: [-0.25, 1.1, 0.25] } }, { f: 50, set: { hand_r: [-0.25, 1.1, 0.25] } }, { f: 54, set: { hand_r: [0.1, 1.45, 0.3] } }, { f: 90, set: { hand_r: [0.1, 1.45, 0.3] } }] };
const fast = compile(thrown, empty).qa.groups.find(g => g.kind === "SPEED");
expect("SPEED (opted in, retime off): replace /fix/retime with true", json(fast?.patch) === json([{ op: "replace", path: "/fix/retime", value: true }]), json(fast?.patch));

// 6. attachPatches on its own: the fix shapes other lanes' hints return (C6).
const group = fix => Object.defineProperty({ kind: "X", subject: "s" }, "fix", { value: fix, enumerable: false });
const patchOf = (fix, userSpec, X) => attachPatches([group(fix)], { X, userSpec })[0].patch;
const cupSpec = { keys: [{ f: 0, set: { root: [0, 0.9, 0] } }, { f: 105, set: { hand_l: [0.2, 1, 0.3] } }], anchors: { cupHandle: { kind: "world", p: [0.2, 0.8, 0.85] } },
	objects: { cup: { prop: "cupGrip", grab: 104 } }, fix: { retime: true } };
expect("channel delta near a user key -> replace that key's value", json(patchOf({ channel: "hand_l", f: 106, delta: [0, 0.1, 0] }, cupSpec)) === json([{ op: "replace", path: "/keys/1/set/hand_l", value: [0.2, 1.1, 0.3] }]));
expect("channel value near a user key -> replace", json(patchOf({ channel: "hand_l", f: 103, value: [0, 1, 0] }, cupSpec)) === json([{ op: "replace", path: "/keys/1/set/hand_l", value: [0, 1, 0] }]));
expect("anchor point delta -> replace /anchors/<a>/p", json(patchOf({ path: "/anchors/cupHandle/p", delta: [0, 0.05, 0] }, cupSpec)) === json([{ op: "replace", path: "/anchors/cupHandle/p", value: [0.2, 0.85, 0.85] }]));
expect("object field value -> replace /objects/<id>/grab", json(patchOf({ path: "/objects/cup/grab", value: 110 }, cupSpec)) === json([{ op: "replace", path: "/objects/cup/grab", value: 110 }]));
expect("an object the agent did not define (a skill's) gets no patch", patchOf({ path: "/objects/mug/grab", value: 110 }, cupSpec) === undefined);
expect("a patch that changes nothing is dropped", patchOf({ path: "/fix/retime", value: true }, cupSpec) === undefined);
expect("a delta of the wrong shape is dropped", patchOf({ channel: "hand_l", f: 105, delta: 0.1 }, cupSpec) === undefined);
expect("no userSpec, no patch", attachPatches([group({ path: "/fix/retime", value: true })], {})[0].patch === undefined);

// 7. A body move (hold: true) moves what placed the body at f, by the delta's x and z.
const bodyX = (list, yaw = 0) => ({ fr: () => ({ c: { yaw, root: [0, 0.97, 0] } }), keys: () => list,
	bracket: (ch, f) => ({ prev: [...list].reverse().find(k => k.f <= f) ?? null, next: list.find(k => k.f > f) ?? null }) });
const body = (list, userSpec, delta = [0, 0, 0.05], yaw) => patchOf({ channel: "root", f: 100, delta, hold: true }, userSpec, bodyX(list, yaw));
const walkSpec = args => ({ use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }, { skill: "walkTo", f0: 2, args }], keys: [] });
const walked = [{ f: 0, src: "use[0] standIdle" }, { f: 76, src: "use[1] walkTo end" }];
expect("hold, a standIdle stance: replace /use/0/args/at", json(body([{ f: 0, src: "use[0] standIdle" }], { use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0.2] } }] }, [0.01, 0, 0.05]))
	=== json([{ op: "replace", path: "/use/0/args/at", value: [0.01, 0.25] }]));
expect("hold, a 2-step walkTo: firstStep grows by the forward part", json(body(walked, walkSpec({ steps: 2, firstStep: 0.3, heading: 0 }))) === json([{ op: "replace", path: "/use/1/args/firstStep", value: 0.35 }]));
expect("hold, a 4-step walkTo facing +x: step grows by the forward part over 2 strides", json(body(walked, walkSpec({ steps: 4, heading: 90 }), [0.1, 0, 0], 90)) === json([{ op: "add", path: "/use/1/args/step", value: 0.55 }]));
expect("hold, a walkTo whose steps follow from to: to moves", json(body(walked, walkSpec({ to: [0, 1] }))) === json([{ op: "replace", path: "/use/1/args/to", value: [0, 1.05] }]));
expect("hold, a mostly sideways move of a walk: no patch", body(walked, walkSpec({ steps: 2 }), [0.05, 0, 0.01]) === undefined);
const rooted = [{ f: 0, src: "use[0] standIdle" }, { f: 76, src: "use[1] walkTo end" }, { f: 80, src: "keys[0]" }, { f: 110, src: "keys[2]" }];
const rootSpec = { ...walkSpec({ steps: 2 }), keys: [{ f: 80, set: { root: [0, 0.97, 0.4] } }, { f: 90, set: { armw_l: 1 } }, { f: 110, set: { root: [0, 0.95, 0.4] } }] };
expect("hold, the agent's root keys after the walk: each one of the run moves (y kept)", json(body(rooted, rootSpec)) === json([{ op: "replace", path: "/keys/0/set/root", value: [0, 0.97, 0.45] },
	{ op: "replace", path: "/keys/2/set/root", value: [0, 0.95, 0.45] }]), json(body(rooted, rootSpec)));
expect("without hold a root delta still replaces the one key near f", json(patchOf({ channel: "root", f: 110, delta: [0, 0, 0.05] }, rootSpec, bodyX(rooted))) === json([{ op: "replace", path: "/keys/2/set/root", value: [0, 0.95, 0.45] }]));

if (failures) { console.error(`${failures} motion3 patch check(s) failed`); process.exit(1); }
console.log("motion3 patch: all checks passed");
