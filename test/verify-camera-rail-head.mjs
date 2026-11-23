// A rail camera's head: the angle set by hand rides the whole rail, as an offset
// from what it follows or, with follow off, as the camera's own angle; an aim
// take still wins on its frames; untouched shots stay byte-stable.
import assert from "node:assert/strict";
import { createCameraBlock, updateCameraBlock, removeCameraRail } from "../src/camera-block.js";
import { buildShotCameraTracks } from "../src/camera-direction.js";
import { applyRailHead, cloneRailHead, headFromLook, railHandTurn, railShownPitchDeg, toggleRailHeadFollow } from "../src/camera-rail-head.js";
import { createShotAuthoringDocument, serializeShotAuthoring } from "../src/shot-authoring.js";
import { sampleAt } from "../src/sample-at.js";

const DEG = Math.PI / 180, frames = 72;
const rail = [{ x: -3, z: 4 }, { x: 0, z: 5 }, { x: 3, z: 4 }];
// the subject walks across, so the following head pans along the rail
const subjectTrack = Array.from({ length: frames }, (_, f) => ({ x: -1 + 2 * f / (frames - 1), z: 0 }));
const shotWith = (camera) => ({ id: "shot-1", name: "Rail", startFrame: 0, endFrame: frames - 1, cameraKeys: [], camera });
const build = (camera, track = subjectTrack) => buildShotCameraTracks({ shots: [shotWith(camera)], subjectTrack: track, fps: 24 });
const base = createCameraBlock({ mode: "rail", cameraRail: rail });
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// Untouched: no head field, the stored body and the track are what they were.
assert.equal("head" in base, false);
assert.equal(cloneRailHead({ yawDeg: 0, pitchDeg: 0 }), null, "a following head with no turn is the default");
assert.equal("head" in updateCameraBlock(base, { head: { yawDeg: 0.01, pitchDeg: -0.02 } }), false, "turns under 0.05 degree round away");
const stored = { frameCount: frames, shots: [shotWith(base)] };
assert.equal(serializeShotAuthoring(stored), serializeShotAuthoring(createShotAuthoringDocument(stored)), "an untouched rail shot round-trips byte-identical");
assert.equal(/"head":/.test(serializeShotAuthoring(stored)), false);
const plain = build(base);
assert.deepEqual(build(updateCameraBlock(base, { head: null })), plain, "a cleared head builds the very same track");

// Follow on, turned by hand: the same dolly, every frame turned by the same offset from the subject.
const turned = updateCameraBlock(base, { head: { yawDeg: 20, pitchDeg: -6 } });
assert.deepEqual(turned.head, { yawDeg: 20, pitchDeg: -6 });
const offset = build(turned);
for (let f = 0; f < frames; f += 1) {
	assert.deepEqual(offset[f].pos, plain[f].pos, `the hand angle never moves the dolly (frame ${f})`);
	assert.ok(close(offset[f].yaw, plain[f].yaw + 20 * DEG), `pan offset holds at frame ${f}`);
	assert.ok(close(offset[f].pitch, plain[f].pitch - 6 * DEG), `tilt offset holds at frame ${f}`);
}
assert.ok(Math.abs(plain[0].yaw - plain[frames - 1].yaw) > 10 * DEG, "the following head still pans with the subject");

// Follow off: the head turns to nothing and holds the angle over the whole rail; the dolly is unchanged.
const held = updateCameraBlock(base, { head: { follow: false, yawDeg: 170, pitchDeg: -12 } });
const still = build(held);
for (let f = 0; f < frames; f += 1) {
	assert.deepEqual(still[f].pos, plain[f].pos, `follow off keeps the dolly where it was (frame ${f})`);
	assert.ok(close(still[f].yaw, 170 * DEG) && close(still[f].pitch, -12 * DEG), `follow off holds the angle at frame ${f}`);
}
// ... and needs nobody to follow: with no subject at all it still rides the rail.
const nobody = build(held, Array.from({ length: frames }, () => null));
assert.ok(nobody.every(Boolean), "a head that follows no one rides the rail without a subject");
assert.ok(close(nobody[0].yaw, 170 * DEG) && nobody.at(-1).pos.x > 2, "on schedule, at its own angle");
assert.equal(build(base, Array.from({ length: frames }, () => null))[0], null, "a following head with no subject holds still, as before");
// a cast aim, with follow off, is not turned to either
const aimed = updateCameraBlock(held, { aim: { ids: ["char-b"] } });
const aimAt = () => ({ x: 9, y: 1, z: 9 });
const heldAim = buildShotCameraTracks({ shots: [shotWith(aimed)], subjectTrack, fps: 24, aimAt });
assert.ok(close(heldAim[30].yaw, 170 * DEG), "follow off ignores the aim");

// Turning by hand: the head measured from what is shown reproduces the look at that frame.
for (const [label, camera] of [["following", turned], ["held", held]]) {
	const track = build(camera), f = 40, look = { yaw: track[f].yaw - 33 * DEG, pitch: track[f].pitch + 9 * DEG };
	const next = headFromLook(camera.head, track[f], look);
	const after = build(updateCameraBlock(camera, { head: next }));
	assert.ok(Math.abs(after[f].yaw - look.yaw) < 0.001 && Math.abs(after[f].pitch - look.pitch) < 0.001, `${label}: the turned angle is kept`);
	if (label === "following") assert.ok(close(next.yawDeg, -13, 0.051) && close(next.pitchDeg, 3, 0.051), "a following head adds the turn to its offset");
	else assert.equal(next.follow, false);
}
// A yaw turn across +-180 is the short way round.
assert.deepEqual(headFromLook(null, { yaw: 179 * DEG, pitch: 0 }, { yaw: -179 * DEG, pitch: 0 }), { yawDeg: 2, pitchDeg: 0 });

// Turn or move: a camera still where the rail shows it was turned; one moved off it sets the follow framing
// (null); one still where the last hand move left it is turned only when its look changed since.
{
	const shown = { camera: { pos: { x: 1, y: 1.6, z: 4 }, yaw: 0.3, pitch: -0.1 }, head: { yawDeg: 5, pitchDeg: 0 } };
	const look = { yaw: 0.3 + 10 * DEG, pitch: -0.1 };
	assert.deepEqual(railHandTurn(shown, { x: 1, y: 1.6, z: 4.0004 }, look, null), { hold: false, head: { yawDeg: 15, pitchDeg: 0 } }, "on the rail: a turn");
	assert.equal(railHandTurn(shown, { x: 1, y: 2.1, z: 4 }, look, null), null, "lifted half a metre: a move");
	const left = { position: { x: 1, y: 2.1, z: 4 }, yaw: 0.3, pitch: -0.1 };
	assert.deepEqual(railHandTurn(shown, { x: 1, y: 2.1, z: 4 }, look, left), { hold: true, head: { yawDeg: 15, pitchDeg: 0 } }, "turned where the last move left it");
	assert.deepEqual(railHandTurn(shown, { x: 1, y: 2.1, z: 4 }, { yaw: 0.3, pitch: -0.1 }, left), { hold: true }, "nothing changed since the move");
	assert.equal(railHandTurn(shown, { x: 1, y: 2.4, z: 4 }, look, left), null, "moved again");
}

// The on/off switch: off freezes what is shown, on centres the subject again.
assert.deepEqual(toggleRailHeadFollow({ yawDeg: 5, pitchDeg: 1 }, { yaw: 30 * DEG, pitch: -10 * DEG }), { follow: false, yawDeg: 30, pitchDeg: -10 });
assert.equal(toggleRailHeadFollow({ follow: false, yawDeg: 30, pitchDeg: -10 }, { yaw: 0, pitch: 0 }), null);
assert.ok(close(applyRailHead({ yaw: 0, pitch: 80 * DEG }, { yawDeg: 0, pitchDeg: 30 }).pitch, 85 * DEG), "the tilt stops at the look limit");

// The tilt the controls show: an aimless following rail adds the follow pitch it had before the head existed.
assert.equal(railShownPitchDeg({ head: { yawDeg: 0, pitchDeg: 3 } }, 5), 8);
assert.equal(railShownPitchDeg({ aim: { ids: ["char-b"] }, head: { yawDeg: 0, pitchDeg: 3 } }, 5), 3, "an aimed rail never had the follow pitch");
assert.equal(railShownPitchDeg({ head: { follow: false, yawDeg: 0, pitchDeg: -12 } }, 5), -12, "follow off shows its own tilt");

// The aim take wins on its frames, whatever the head says; the head returns after it.
const take = { startFrame: 10, samples: Array.from({ length: 20 }, () => ({ yaw: 1.25, pitch: -0.2 })) };
const scene = { frameCount: frames, cameraTrack: still };
const taken = shotWith(updateCameraBlock(held, { aimTake: take }));
assert.deepEqual([sampleAt(scene, taken, 15).camera.yaw, sampleAt(scene, taken, 15).camera.pitch], [1.25, -0.2], "the take replaces the hand angle");
assert.ok(close(sampleAt(scene, taken, 40).camera.yaw, 170 * DEG), "after the take the head's angle is back");

// Stored with the rail: save and load keep it, deleting the rail drops it.
const saved = createShotAuthoringDocument({ frameCount: frames, shots: [shotWith(held)] }).shots[0].camera;
assert.deepEqual(saved.head, { follow: false, yawDeg: 170, pitchDeg: -12 }, "persistence keeps the head");
assert.equal("head" in removeCameraRail(held), false, "no rail, no head");
assert.equal("head" in createCameraBlock({ mode: "follow", head: { yawDeg: 9 } }), false, "only a rail carries a head");

console.log("PASS rail head: untouched shots byte-stable; a hand turn rides the rail as an offset; follow off holds its angle without a subject; the aim take wins on its frames");
