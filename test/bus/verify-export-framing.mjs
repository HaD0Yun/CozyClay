// verify_result motion: what the export camera shows of the take (src/studio-export-framing.js).
// A real compile and bake of the cup scene (the right hand lifts the carried cup to 1.4 m) seen by
// cameras whose frames are known: a wide one sees everything; a low, tight one cuts the head all
// take long and the raised hand and the carried cup only while they are up; one facing away has the
// character behind it. The camera is "studio" with no shot and "shot" under one.
import assert from "node:assert/strict";
import { exportFraming, exportFramingInto, exportSampleFrames, sampleSpans, takeObjectIds } from "../../src/studio-export-framing.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { bakeTake } from "../../src/motion3/take.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { fovToFocalMm } from "../../src/shot.js";
import { SCENE_OBJECTS, CHARACTER } from "../motion3/fixtures/cup-scene.mjs";

// sampling and spans
assert.deepEqual(exportSampleFrames(0, 47, 24).length, 24);
assert.deepEqual(exportSampleFrames(0, 47, 24).slice(0, 2), [0, 2]);
assert.equal(exportSampleFrames(0, 47, 24).at(-1), 47);
assert.deepEqual(exportSampleFrames(5, 5), [5]);
assert.deepEqual(exportSampleFrames(0, 3, 24), [0, 1, 2, 3], "a short range samples every frame");
assert.deepEqual(sampleSpans([0, 10, 20, 30, 40], [true, true, false, true, false]), [[0, 10], [30, 30]]);
assert.deepEqual(sampleSpans([0, 10], [false, false]), []);
console.log("PASS export framing: sampled frames spread evenly with both ends, spans join consecutive samples");

// the objects a spec names: spec.objects keys, object:<id>[.point] refs and plain id strings (a skill's seat)
assert.deepEqual(takeObjectIds({ objects: { "empty-2": {} }, goals: [{ near: ["object:cube.top", "joint:Head"] }], use: [{ args: { seat: "cube-3", anchor: "grip" } }], label: "a table" }, SCENE_OBJECTS).sort(),
	["cube", "cube-3", "empty-2"]);
assert.deepEqual(takeObjectIds({ keys: [] }, SCENE_OBJECTS), []);
console.log("PASS export framing: the take's objects are the ones its spec names");

const sk = skeletonFor(CHARACTER.model);
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 48, use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }],
	props: { grip: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"] } },
	keys: [{ f: 10, set: { armw_r: 1, hand_r: [-0.25, 0.95, 0.25] } }, { f: 30, set: { armw_r: 1, hand_r: [-0.2, 1.4, 0.3] } }],
	objects: { cylinder: { prop: "grip", grab: 20, release: 40 } } };
const r = compileSpec(spec, { sk, scene: motionScene(SCENE_OBJECTS) }, { lenient: true });
const take = bakeTake(sk, r.out, { position: [0, 0, 0], yaw: 0 }, { spec });
const filmback = { sensorId: "fullFrame", aspectRatio: 16 / 9 };
// a horizontal camera at height y, distance z, with a vertical field of view of fov degrees
const camera = (y, z, fov, lookZ = 0) => ({ position: { x: 0, y, z }, lookAt: { x: 0, y, z: lookZ }, focalMm: fovToFocalMm(fov * Math.PI / 180, filmback.sensorId, filmback.aspectRatio), sensorId: filmback.sensorId });
const scene = cam => ({ frame: 0, frameCount: 48, objects: SCENE_OBJECTS, characters: [CHARACTER], camera: cam, filmback, shotDocument: { shots: [] } });
const ports = { sampleStateAt: (frame, state) => ({ ...state, frame }), bounds() { throw new Error("primitives need no evaluated bounds"); } };

// wide: 8 m back, everything inside
const wide = exportFraming({ character: CHARACTER, take, scene: scene(camera(1, 8, 40)), ports, range: "whole_clip" });
assert.equal(wide.coverage, "sampled-export-camera-joints-and-object-outlines");
assert.equal(wide.camera, "studio");
assert.deepEqual(wide.shotIds, []);
assert.equal(wide.sampledFrames.length, 24);
assert.equal(wide.character.cut, undefined, JSON.stringify(wide.character));
assert.equal(wide.character.inFrame[0], 1);
assert.ok(wide.character.screenFraction[0] > 0.1 && wide.character.screenFraction[1] < 0.5, JSON.stringify(wide.character.screenFraction));
assert.deepEqual(wide.objects.map(o => [o.id, o.name, o.inFrame[0], o.out, o.cut]), [["cylinder", "Cup Body", 1, undefined, undefined]]);
console.log("PASS export framing: a wide studio camera keeps the character and the carried cup whole, no shot");

// low and tight: a 0.5 m high camera 3 m out whose frame top passes ~1.2 m at the cup
const tight = exportFraming({ character: CHARACTER, take, scene: scene(camera(0.5, 3, 31)), ports, range: "whole_clip" });
const all = [[0, 47]], within = (spans, f) => spans.some(([a, b]) => f >= a && f <= b);
assert.deepEqual(tight.character.cut.head, all, JSON.stringify(tight.character.cut));
assert.ok(!tight.character.cut.foot_l && !tight.character.cut.foot_r, "the feet stay in");
assert.ok(within(tight.character.cut.hand_r, 30) && !within(tight.character.cut.hand_r, 0), JSON.stringify(tight.character.cut.hand_r));
assert.ok(tight.character.inFrame[0] < 1);
const cup = tight.objects[0];
assert.ok(!within(cup.cut ?? [], 0) && !within(cup.out ?? [], 0), "the cup on the table is inside at f0");
assert.ok(within([...(cup.cut ?? []), ...(cup.out ?? [])], 30), `the carried cup rides the hand out of frame: ${JSON.stringify(cup)}`);
console.log("PASS export framing: a tight camera cuts the head all take, the raised hand and the carried cup only while up");

// a character resized or moved after the install carries its take (the stage draws it there): the framing reads it there
const half = { ...CHARACTER, scale: 0.5 }, small = exportFraming({ character: half, take, scene: { ...scene(camera(0.5, 3, 31)), characters: [half] }, ports, range: "whole_clip" });
assert.equal(small.character.cut?.head, undefined, `at half the size the head stays under the tight frame's top: ${JSON.stringify(small.character.cut)}`);
const aside = { ...CHARACTER, x: 30 }, far = exportFraming({ character: aside, take, scene: { ...scene(camera(1, 8, 40)), characters: [aside] }, ports, range: "whole_clip" });
assert.equal(far.character.inFrame[0], 0, "moved 30 m to the side, the character is out of the wide frame");
console.log("PASS export framing: a character resized or moved after the install is read where the stage draws it");

// facing away: the character is behind the camera
const away = exportFraming({ character: CHARACTER, take, scene: scene(camera(1, 3, 40, 10)), ports, range: "whole_clip" });
assert.deepEqual(away.character.behindCamera, all);
assert.equal(away.character.inFrame[0], 0);
assert.deepEqual(away.objects[0].out, all);
console.log("PASS export framing: a camera facing away has the character behind it and the cup out");

// a shot over the range, and a sub-range
const shot = exportFraming({ character: CHARACTER, take, scene: { ...scene(camera(1, 8, 40)), shotDocument: { shots: [{ id: "shot-1", startFrame: 0, endFrame: 47 }] } }, ports, range: { startFrame: 10, endFrameExclusive: 20 } });
assert.equal(shot.camera, "shot");
assert.deepEqual(shot.shotIds, ["shot-1"]);
assert.deepEqual(shot.sampledFrames, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
console.log("PASS export framing: under a shot the camera is the shot's, and a range limits the samples");

// the binding hook: one row per subject with a v3 take; a missing filmback is a reason, not a throw
const s = { characters: [CHARACTER, { id: "char-b", subject: "b" }], targets: new Map([[CHARACTER.id, { motion: take }], ["char-b", { motion: null }]]) };
const result = { unsupportedReasons: {} };
exportFramingInto(result, { args: { targets: [CHARACTER.id, "char-b"], range: "whole_clip" }, s, receipt: null, scene: scene(camera(1, 8, 40)), ports });
assert.equal(result.exportFraming.character.id, CHARACTER.id);
const refused = { unsupportedReasons: {} };
exportFramingInto(refused, { args: { targets: [CHARACTER.id], range: "whole_clip" }, s, receipt: null, scene: { ...scene(camera(1, 8, 40)), filmback: null }, ports });
assert.equal(refused.exportFraming.character.id, CHARACTER.id);
assert.match(refused.exportFraming.reason, /filmback/);
assert.deepEqual(refused.unsupportedReasons, {}, "the motion check's own reasons are untouched");
const unsampled = { unsupportedReasons: {} };
exportFramingInto(unsampled, { args: { targets: [CHARACTER.id], range: "whole_clip" }, s, receipt: null, scene: scene(camera(1, 8, 40)), ports: { bounds: ports.bounds } });
assert.match(unsampled.exportFraming.reason, /cannot sample/);
const fromReceipt = { unsupportedReasons: {} };
exportFramingInto(fromReceipt, { args: { range: "whole_clip" }, s, receipt: { affectedIds: [CHARACTER.id, "cube"] }, scene: scene(camera(1, 8, 40)), ports });
assert.equal(fromReceipt.exportFraming.character.id, CHARACTER.id, "a receipt's characters are the subjects");
console.log("PASS export framing: verify_result gets one row per character take, and a row with its reason when the camera cannot be read");
