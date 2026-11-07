#!/usr/bin/env node
// #1126: the slips the validator corrected instead of refusing the whole spec (compiler/validate-mend.js), each named
// in the compile's notes (output.adjusted), on the expanded copy only (the stored spec stays as sent); what has
// another reading is refused with the message it always had. The v2 physics bench threw away 41.6 min of model
// time on refusals like these (handstand knee poles, trip-run keys[55].f = 150 of 150, rolls anchors e_l / e_r).
import { compileSpec } from "../../src/motion3/pipeline.js";
import { validateSpec } from "../../src/motion3/compiler/validate.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { SCENE_OBJECTS, CHARACTER } from "../motion3/fixtures/cup-scene.mjs";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures += 1; };
const json = JSON.stringify;
const sk = skeletonFor(CHARACTER.model), scene = motionScene(SCENE_OBJECTS);
const compile = spec => compileSpec(spec, { sk, scene });
const refused = run => { try { run(); return ""; } catch (error) { return error.message; } };
const stand = { skill: "standIdle", f0: 0, args: { at: [0, 0] } };
const spec = (keys, extra = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 40, use: [stand], keys, ...extra });
const own = (r, i) => r.expanded.keys.find(k => k.src === `keys[${i}]`);

// 1. a backward knee pole on an upright body: mirrored forward
const up = compile(spec([{ f: 10, set: { knee_l: [0.1, 0.2, -0.9] } }]));
expect("upright: a backward pole is mirrored forward, named, and stored as sent", json(own(up, 0).set.knee_l) === "[0.1,0.2,0.9]"
	&& up.notes?.includes("corrected: keys[0] (f10) knee_l = [0.1,0.2,-0.9] points backward (knees bend toward +z): mirrored forward to [0.1,0.2,0.9]")
	&& json(up.spec.keys[0].set.knee_l) === "[0.1,0.2,-0.9]", json(up.notes));
// 2. on a body turned past upright (pitch 150: the pole turns with it) the pole is left out, and out of step
const tilted = compile(spec([{ f: 4, set: { pitch: 0 } }, { f: 20, set: { pitch: 150, knee_l: [0, -0.6, -0.8], knee_r: [0, -0.6, -0.8] }, step: ["knee_l", "pitch"] }]));
const t20 = own(tilted, 1);
expect("turned past upright: the pole is left out (the knee follows its other keys), named once per channel", t20.set.knee_l === undefined && t20.set.knee_r === undefined && json(t20.step) === json(["pitch"])
	&& tilted.notes?.includes("corrected: keys[1] (f20) knee_l = [0,-0.6,-0.8] points backward (knees bend toward +z) on a body turned past upright, where a pole turns with the body: left out, so the knee follows the poles keyed around it"),
json(tilted.notes));
expect("without notes (a direct validateSpec) the backward pole is refused as before", /keys\[0\] \(f10\) knee_l = \[0.1,0.2,-0.9\] points backward; knees bend toward \+z/.test(refused(() => validateSpec(spec([{ f: 10, set: { knee_l: [0.1, 0.2, -0.9] } }]), { sk, scene }))));

// 3. a key up to 3 frames past the last frame goes on the last frame; the take keeps spec.frames
const end = compile(spec([{ f: 40, set: { pitch: 5 } }]));
expect("f = frames: on the last frame, named; the take is still 40 frames", own(end, 0).f === 39 && end.out.frameCount === 40 && end.spec.keys[0].f === 40
	&& end.notes?.includes("corrected: keys[0].f = 40 -> 39, the last frame (spec.frames 40 runs 0..39)"), json([end.notes, end.out.frameCount]));
expect("f = frames + 2 is taken too", own(compile(spec([{ f: 42, set: { pitch: 5 } }])), 0).f === 39);
expect("f = frames + 3 is refused with the advice it always had", /keys\[0\]\.f = 43 is outside 0\.\.39 \(spec\.frames 40\); set frames >= 44 or frames: "auto"/.test(refused(() => compile(spec([{ f: 43, set: { pitch: 5 } }])))));
expect("a key at the last frame setting the same channel: refused (the two would merge and one value be lost)",
	/keys\[1\]\.f = 40 is outside 0\.\.39/.test(refused(() => compile(spec([{ f: 39, set: { pitch: 3 } }, { f: 40, set: { pitch: 5 } }])))));
expect("an object key past the end too: refused (the take is short of the motion, not off by one)",
	/keys\[0\]\.f = 40 is outside 0\.\.39/.test(refused(() => compile(spec([{ f: 40, set: { pitch: 5 } }], { objects: { "empty-2": { prop: "grip", grab: 0, keys: [{ f: 41, pos: [0.2, 0.8, 0.85] }] } }, props: { grip: { hand: "r", origin: ["RightHandIndex2"] } } })))));
const beside = compile(spec([{ f: 39, set: { pitch: 3 } }, { f: 40, set: { spine_pitch: 5 } }]));
expect("a key at the last frame with other channels: both kept on it", own(beside, 0).f === 39 && own(beside, 1).f === 39 && own(beside, 0).set.pitch === 3);

// 4. an anchor named <name>_l / _r: <name>_left / _right with every ref, weight channel and fit
const anchors = { bar_l: { kind: "world", p: [0.3, 1.1, 0.35] }, bar_r: { kind: "world", p: [-0.3, 1.1, 0.35] } };
const goals = [{ name: "left hand on the bar", near: ["joint:LeftHand", "anchor:bar_l"], tol: 0.3, at: [20, 30] }];
const sided = compile(spec([{ f: 10, set: { armw_l: 0 } }, { f: 20, set: { armw_l: 1, w_bar_l_l: 1 } }], { anchors, goals }));
expect("sided anchor names: renamed with every ref, named, stored as sent", json(Object.keys(sided.expanded.anchors).filter(n => n.startsWith("bar"))) === json(["bar_left", "bar_right"])
	&& own(sided, 1).set.w_bar_left_l === 1 && sided.expanded.goals.at(-1).near[1] === "anchor:bar_left" && sided.qa.goals.find(g => g.name === "left hand on the bar") !== undefined
	&& sided.notes?.includes("corrected: anchors.bar_l -> anchors.bar_left, and every ref to it (an anchor name may not end in _l or _r; the side goes on its weight channel, w_bar_left_l / w_bar_left_r)")
	&& sided.spec.anchors.bar_l !== undefined, json(sided.notes));
expect("a new name that is taken: refused as before", /anchors\.grip_l: an anchor name may not end in _l or _r/.test(refused(() => compile(spec([], { anchors: { grip_l: anchors.bar_l, grip_left: anchors.bar_r } })))));

// 5. a refusal for something else still names the corrections made before it
const other = refused(() => compile(spec([{ f: 10, set: { knee_l: [0, 0, -1], zzz: 1 } }])));
expect("a spec refused for another problem says what was corrected first", /sets unknown channel "zzz"/.test(other) && /\(adjusted before these checks: .*knee_l = \[0,0,-1\] points backward \(knees bend toward \+z\): mirrored forward to \[0,0,1\]/.test(other), other);

if (failures) { console.error(`${failures} motion3 mend check(s) failed`); process.exit(1); }
console.log("motion3 mend: all checks passed");
