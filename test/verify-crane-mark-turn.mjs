// A crane mark's turn: the rotate tool on a rail mark turns the head at that place of the rail (yawDeg / pitchDeg on
// the mark), eased between marks like the height, on top of the shot's own hand angle (head). Untouched marks store
// nothing new and build the very same track; a hand turn of the camera is not counted twice where a mark turns it.
import assert from "node:assert/strict";
import { createCameraBlock, updateCameraBlock } from "../src/camera-block.js";
import { buildShotCameraTracks } from "../src/camera-direction.js";
import { buildRail } from "../src/camera-follow.js";
import { applyRailHead, craneMarkTurn, headFromLook, railTurnAt, railViewAt } from "../src/camera-rail-head.js";

import { createShotAuthoringDocument, serializeShotAuthoring } from "../src/shot-authoring.js";

const DEG = Math.PI / 180, frames = 96;
const railPoints = [{ x: -3, z: 4 }, { x: 0, z: 5 }, { x: 3, z: 4 }];
const rail = buildRail(railPoints);
const subjectTrack = Array.from({ length: frames }, (_, f) => ({ x: -1 + 2 * f / (frames - 1), z: 0 }));
const shotWith = (camera) => ({ id: "shot-1", name: "Rail", startFrame: 0, endFrame: frames - 1, cameraKeys: [], camera });
const build = (camera) => buildShotCameraTracks({ shots: [shotWith(camera)], subjectTrack, fps: 24 });
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const marks = [{ t: 0, height: 1.6 }, { t: 0.5, height: 2.2 }, { t: 1, height: 1.6 }];
const base = createCameraBlock({ mode: "rail", cameraRail: railPoints, craneHeight: { points: marks } });
const plain = build(base);

// Untouched marks: no new keys, byte-stable, no turn anywhere.
assert.deepEqual(base.craneHeight.points, marks, "marks without a turn store only t and height");
const stored = { frameCount: frames, shots: [shotWith(base)] };
assert.equal(serializeShotAuthoring(stored), serializeShotAuthoring(createShotAuthoringDocument(stored)), "an untouched crane round-trips byte-identical");
assert.equal(railTurnAt(base.craneHeight, 0.5), null, "no mark turns: no turn");
assert.deepEqual(craneMarkTurn({ yawDeg: 0.02, pitchDeg: "3" }), {}, "a turn under 0.05 degree or of the wrong type is none");
assert.deepEqual(craneMarkTurn({ yawDeg: 370.04, pitchDeg: -120 }), { yawDeg: 10, pitchDeg: -85 }, "pan wraps, tilt clamps, both to 0.1 degree");
assert.deepEqual(build(updateCameraBlock(base, { craneHeight: { points: marks.map((m) => ({ ...m, yawDeg: 0 })) } })), plain, "zero turns build the same track");

// The middle mark pans 30 degrees and tilts -10: full turn where the dolly passes it, none at the ends, eased between.
const turnedMarks = marks.map((m, i) => (i === 1 ? { ...m, yawDeg: 30, pitchDeg: -10 } : m));
const turned = updateCameraBlock(base, { craneHeight: { points: turnedMarks } });
assert.deepEqual(turned.craneHeight.points[1], { t: 0.5, height: 2.2, yawDeg: 30, pitchDeg: -10 }, "the turn is stored on the mark");
const ride = build(turned);
let mid = 0;
for (let f = 0; f < frames; f += 1) {
	const progress = plain[f].s / rail.length, turn = railTurnAt(turned.craneHeight, progress);
	assert.deepEqual(ride[f].pos, plain[f].pos, `a mark's turn never moves the dolly (frame ${f})`);
	assert.ok(close(ride[f].yaw, plain[f].yaw + turn.yawDeg * DEG) && close(ride[f].pitch, plain[f].pitch + turn.pitchDeg * DEG), `the turn applies by the dolly's place (frame ${f})`);
	assert.ok(turn.yawDeg >= -1e-9 && turn.yawDeg <= 30 + 1e-9, "eased between marks, never past them");
	if (Math.abs(progress - 0.5) < Math.abs(plain[mid].s / rail.length - 0.5)) mid = f;
}
assert.ok(close(ride[0].yaw, plain[0].yaw), "no turn at the start mark");
assert.ok(Math.abs(railTurnAt(turned.craneHeight, plain[mid].s / rail.length).yawDeg - 30) < 1, "the full pan where the dolly passes the mark");
{ const half = railTurnAt(turned.craneHeight, 0.25).yawDeg; assert.ok(half > 5 && half < 25, `between two marks the pan eases: ${half}`); }

// With the shot's own hand angle the two add up; with follow off the head is the angle and the mark turns from it.
const both = build(updateCameraBlock(turned, { head: { yawDeg: 12, pitchDeg: 0 } }));
assert.ok(close(both[mid].yaw, ride[mid].yaw + 12 * DEG), "head and mark turn add");
const off = build(updateCameraBlock(turned, { head: { follow: false, yawDeg: 90, pitchDeg: 0 } }));
assert.ok(close(off[0].yaw, 90 * DEG) && close(off[mid].yaw, (90 + railTurnAt(turned.craneHeight, plain[mid].s / rail.length).yawDeg) * DEG), "follow off: the held angle, turned by the mark where it passes");

// Turning the camera by hand where a mark turns it changes the head by the hand's turn only (not the mark's twice).
for (const head of [null, { follow: false, yawDeg: 90, pitchDeg: 0 }]) {
	const camera = updateCameraBlock(turned, { head });
	const shown = build(camera)[mid];
	const look = { yaw: shown.yaw + 5 * DEG, pitch: shown.pitch - 2 * DEG };
	const next = headFromLook(camera.head, shown, look);
	const again = build(updateCameraBlock(camera, { head: next }))[mid];
	assert.ok(Math.abs(again.yaw - look.yaw) < 0.06 * DEG && Math.abs(again.pitch - look.pitch) < 0.06 * DEG, `a hand turn shows what the hand turned to (${head ? "follow off" : "following"})`);
}
assert.deepEqual(applyRailHead(plain[3], null, null), plain[3], "no head and no turn: the sample as it is");

// The rings' view line: the track sample where the dolly passes the mark.
const view = railViewAt(ride, shotWith(turned), rail, 0.5);
assert.ok(close(view.yaw, ride[mid].yaw) && close(view.pitch, ride[mid].pitch), "the view at a mark is the camera's where it passes the mark");
assert.equal(railViewAt(null, shotWith(turned), rail, 0.5), null);

console.log("PASS crane mark turn: untouched marks byte-stable, a mark's pan/tilt eased along the ride by the dolly's place, adds to the head, a hand turn not counted twice, the rings' view line");
