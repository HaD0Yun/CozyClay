// #1392: a two-key camera move over a running take must not shake with the
// runner's hips. Between keys the move is taken about where the subject stands
// at each key, so the frame-by-frame sway of the anchor track never reaches
// the camera, while each key is still met exactly.
import assert from "node:assert/strict";
import { sampleAt } from "../src/sample-at.js";

const frames = 81;
// A runner crossing 12 m in 80 frames, hips swaying 6 cm side to side and 4 cm along the run at step rate (about 2.6 steps/s).
const track = Array.from({ length: frames }, (_, f) => ({ x: -6 + (12 * f) / 80 + 0.04 * Math.sin(f * 0.7), z: 0.06 * Math.sin(f * 0.7 + 1) }));
const scene = { frameCount: frames, subjectTrack: track, cameraAnchorTrack: track, fovDeg: 40, filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 } };
const keyA = { frame: 0, framing: { pos: { x: -8, y: 46.6, z: -10 }, yaw: Math.PI + 0.2, pitch: -0.1, fovDeg: 40 } };
const keyB = { frame: 80, framing: { pos: { x: 6, y: 46.6, z: -10 }, yaw: Math.PI - 0.2, pitch: -0.1, fovDeg: 40 } };
const shot = { startFrame: 0, endFrame: 80, camera: { mode: "keys" }, cameraKeys: [keyA, keyB] };

const cams = Array.from({ length: frames }, (_, f) => sampleAt(scene, shot, f).camera);
const near = (a, b) => Math.abs(a - b) < 1e-9;
assert.ok(near(cams[0].pos.x, keyA.framing.pos.x) && near(cams[0].pos.z, keyA.framing.pos.z), "the first key is met exactly");
assert.ok(near(cams[80].pos.x, keyB.framing.pos.x) && near(cams[80].pos.z, keyB.framing.pos.z), "the last key is met exactly");

// Shake = how far the camera strays from the same move over a runner without the sway, and how
// much that stray changes from frame to frame (second difference): the sway itself, not the ease.
const smooth = Array.from({ length: frames }, (_, f) => ({ x: -6 + (12 * f) / 80, z: 0 }));
const ref = Array.from({ length: frames }, (_, f) => sampleAt({ ...scene, subjectTrack: smooth, cameraAnchorTrack: smooth }, shot, f).camera);
const stray = cams.map((c, f) => ({ x: c.pos.x - ref[f].pos.x, z: c.pos.z - ref[f].pos.z, yaw: c.yaw - ref[f].yaw }));
const wobble = (axis) => Math.max(...stray.slice(1, -1).map((d, i) => Math.abs(stray[i + 2][axis] - 2 * d[axis] + stray[i][axis])));
const sx = wobble("x"), sz = wobble("z"), yaw = wobble("yaw");
// The sway's own second difference is about 0.04 * 0.7^2 = 0.02 m (x) and 0.03 m (z).
assert.ok(sx < 0.001 && sz < 0.001, `the sway does not reach the camera, second difference x ${sx.toFixed(4)} z ${sz.toFixed(4)} m`);
assert.ok(yaw < 0.0005, `nor its aim, second difference ${yaw.toFixed(5)} rad`);

// The shot's subject centre jumps for a few frames (a second subject comes into view and leaves):
// before #1392 the camera jumped half a metre with it.
const blip = track.map((p, f) => (f >= 40 && f < 44 ? { x: p.x - 3, z: p.z } : p));
const jumped = Array.from({ length: frames }, (_, f) => sampleAt({ ...scene, subjectTrack: blip, cameraAnchorTrack: blip }, shot, f).camera);
const leap = Math.max(...jumped.map((c, f) => Math.hypot(c.pos.x - cams[f].pos.x, c.pos.z - cams[f].pos.z)));
assert.ok(leap < 1e-9, `a jump of the subject centre between keys moves the camera ${leap.toFixed(3)} m`);

// A fixed anchor (no track) gives the same move it always did.
const still = { ...scene, cameraAnchorTrack: undefined, subjectTrack: undefined, subject: { x: 0, z: 0 } };
const mid = sampleAt(still, shot, 40).camera;
assert.ok(Number.isFinite(mid.pos.x) && near(mid.pos.y, 46.6));
console.log(`verify-camera-key-sway: ok (shake x ${sx.toFixed(4)} z ${sz.toFixed(4)} m, yaw ${yaw.toFixed(5)} rad)`);
