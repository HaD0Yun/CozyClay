// A body off the ground (launch, engine-simple/air.js): its hips fly the path gravity gives at every body scale, the
// hips' speed changes by little from one frame to the next at take-off and landing, it lands where it was told, the
// feet leave the floor in the air and stand on it after, and the tool's air row says the numbers of the clip.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { airLines, airStretches } from "../../src/lowvis/engine-simple/air-told.js";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";

const scene = (s, frames = 72, props = []) => ({ demo: "x", frames, characters: [{ id: "a", at: [0, 0], heading: 0, ...(s === 1 ? {} : { scale: s }) }], props });
const build = (s, acts, frames, props, spec = {}) => { const def = scene(s, frames, props); return buildClip({ a: acts, ...spec }, def); };
const at = (c, f, j) => Array.from(c.pos.slice((f * JOINT_COUNT + j) * 3, (f * JOINT_COUNT + j) * 3 + 3));
const hipsY = (c, f) => at(c, f, J.Hips)[1], upSpeed = (c, f) => (hipsY(c, f) - hipsY(c, f - 1)) * 24;
/** The largest change of the Hips' upward speed from one frame to the next over frames a..b (m/s), and their largest step (m). */
const jolt = (c, a, b) => { let m = 0; for (let f = Math.max(2, a); f <= b; f++) m = Math.max(m, Math.abs(upSpeed(c, f) - upSpeed(c, f - 1))); return m; };
const step = (c, a, b) => { let m = 0; for (let f = Math.max(1, a); f <= b; f++) m = Math.max(m, Math.hypot(...at(c, f, J.Hips).map((v, k) => v - at(c, f - 1, J.Hips)[k]))); return m; };

for (const s of [0.6, 1, 1.4]) {
	const { clip, aux } = build(s, [[0, "idle", {}], [24, "launch", { to: [0, 1.2 * s] }], [36, "idle", {}]]);
	const c = clip.characters[0], fl = aux.flights[0];
	assert.equal(fl.f0, 24); assert.equal(fl.f1, 36);
	// the hips in the air against a parabola: the second difference is gravity, 9.8 m/s2 in the world
	for (let f = 25; f < 35; f++) {
		const acc = (hipsY(c, f + 1) - 2 * hipsY(c, f) + hipsY(c, f - 1)) * 576;
		assert.ok(Math.abs(acc + 9.8) < 0.01, `scale ${s}: f${f} the hips fall at ${acc.toFixed(2)} m/s2`);
	}
	assert.ok(jolt(c, 2, 71) < 0.6, `scale ${s}: the hips' upward speed changes by at most ${jolt(c, 2, 71).toFixed(2)} m/s from one frame to the next`);
	const end = at(c, 71, J.Hips);
	assert.ok(Math.abs(end[2] - 1.2 * s) < 0.04 * s, `scale ${s}: it stands where it was told, hips at z ${end[2].toFixed(3)}`);
	assert.deepEqual(aux.contacts.a[30], [false, false], "in the air neither foot stands");
	assert.deepEqual(aux.contacts.a[70], [true, true], "after it both feet stand");
	const [t] = airStretches(clip, aux);
	assert.ok(t.launch && t.a === 24 && t.b === 35 && t.frames === 12, "the air row names the frames in the air");
	assert.ok(Math.abs(t.up - upSpeed(c, 24) - 9.8 / 48) < 0.001 && Math.abs(t.down + upSpeed(c, 36) - 9.8 / 48) < 0.001 && t.along > 0.5, "its speeds are the clip's: on the frames it leaves and comes down, half a frame of gravity from the steps beside them");
	assert.match(airLines(clip, aux)[1], /^- a f24-35 launch: 12 frames in the air/);
	// a flight of any length, a hop of one frame too: the hips leave and come down without a jolt and stand again
	for (const n of [1, 2, 3, 6]) {
		const hop = build(s, [[0, "idle", {}], [24, "launch", {}], [24 + n, "idle", {}]]).clip.characters[0];
		assert.ok(jolt(hop, 2, 71) < 0.6 && Math.abs(hipsY(hop, 60) - hipsY(hop, 0)) < 1e-6, `scale ${s}: a flight of ${n} frames changes the hips' upward speed by at most ${jolt(hop, 2, 71).toFixed(2)} m/s in a frame`);
	}
	// thrown with a velocity: it leaves with it along the ground, and up with it to the whole frame gravity brings it down on
	const thrown = build(s, [[0, "idle", {}], [20, "launch", { vel: [1.5, 2, 0] }], [60, "idle", {}]]), [th] = airStretches(thrown.clip, thrown.aux);
	assert.ok(Math.abs(th.along - 1.5) < 0.02, `scale ${s}: thrown at 1.5 m/s along it leaves at ${th.along.toFixed(3)}`);
	assert.ok(Math.abs(th.up - 2) < 0.11 && Math.abs(th.frames + 1 - Math.round(2 * 2 / 9.8 * 24)) <= 1, `scale ${s}: thrown up at 2 m/s it leaves at ${th.up.toFixed(3)} and is in the air ${th.frames} frames`);
}
// no frame on the ground before it (frame 0, or the frame another launch comes down on): it stands one frame and leaves from where it is
{
	const first = build(1, [[0, "launch", { to: [0, 1] }], [12, "idle", {}]]), c = first.clip.characters[0];
	assert.equal(first.aux.flights[0].f0, 1, "a launch on frame 0 is in the air from frame 1");
	assert.ok(step(c, 1, 71) < 0.15 && Math.abs(at(c, 71, J.Hips)[2] - 1) < 0.04, `it flies to where it was told, ${step(c, 1, 71).toFixed(3)} m a frame at most`);
	const two = build(1, [[0, "idle", {}], [24, "launch", { to: [0, 1] }], [36, "launch", { to: [0, 2] }], [48, "idle", {}]]);
	assert.deepEqual(two.aux.flights.map(fl => [fl.f0, fl.f1]), [[24, 36], [37, 48]], "the second launch stands on the frame the first comes down on");
	assert.ok(step(two.clip.characters[0], 1, 71) < 0.15, `two launches in a row: the hips go ${step(two.clip.characters[0], 1, 71).toFixed(3)} m a frame at most`);
	assert.match(airLines(two.clip, two.aux)[2], /13 frames on the ground short of the dip and push its take-off speed needs$/);
}
// from a seat: the hips do not dip under it, and the ground after the flight keeps its height (no jolt as it comes down)
{
	const c = build(1, [[0, "sit", { height: 0.45, over: 0 }], [30, "launch", { to: [0, 1] }], [42, "idle", {}]]).clip.characters[0];
	let low = Infinity; for (let f = 0; f < 30; f++) low = Math.min(low, hipsY(c, f));
	assert.ok(low > hipsY(c, 0) - 0.005, `the hips stay ${(hipsY(c, 0) - low).toFixed(3)} m under the seat at most`);
	assert.ok(jolt(c, 42, 71) < 0.6, `landing from a seat's height: ${jolt(c, 42, 71).toFixed(2)} m/s in a frame at most`);
}
// off a prop that moves: it leaves from where the prop has carried it
{
	const cart = { id: "cart", size: [1.5, 0.2, 1.5], at: [0, 0.1, 0], moves: true };
	const { clip } = build(1, [[0, "idle", { on: "cart" }], [30, "launch", { to: [2, 1.2] }], [42, "idle", {}]], 72, [cart], { cart: [[0, "move", { to: [0, 0.1, 4], over: 70, ease: "linear" }]] });
	assert.ok(step(clip.characters[0], 1, 71) < 0.15, `off a moving prop the hips go ${step(clip.characters[0], 1, 71).toFixed(3)} m a frame at most`);
}
// in the air on the clip's last frame: the row says so
{
	const { clip, aux } = build(1, [[0, "idle", {}], [30, "launch", {}]], 40);
	assert.match(airLines(clip, aux)[1], /in the air on the clip's last frame/);
}
// a body lifted with tilt and shift (no launch): the air row tells the one-frame change of the hips' speed; not one
// that stands on a prop there, is lifted without a jolt, or stands on its toes
{
	const lift = (over, ease, feet) => [[0, "idle", {}], [20, "pose", { tilt: [0, 0], shift: [0, 0.45, 0], ...(feet ? { footL: { at: [0.1, 0.2, -0.1] }, footR: { at: [-0.1, 0.2, -0.1] } } : {}), over, ease }], [20 + over + 2, "pose", { tilt: [0, 0], shift: [0, 0, 0], ...(feet ? { footL: "plant", footR: "plant" } : {}), over, ease: ease === "out" ? "in" : ease }]];
	const jump = build(1, lift(8, "out", true)), [t] = airStretches(jump.clip, jump.aux);
	assert.ok(t && !t.launch && t.leave > 2, `the old rows: the hips' upward speed changes by ${t?.leave.toFixed(2)} m/s as they leave`);
	assert.match(airLines(jump.clip, jump.aux)[1], /^- a f\d+-\d+ feet off, no launch: \d+ frames, hips up to 0\.\d\d m over the frame before; .*; their upward speed changes in one frame by \d\.\d\d m\/s as they leave and by \d\.\d\d m\/s as they come down$/);
	const onBox = build(1, lift(8, "out", false), 72, [{ id: "box", size: [1, 0.45, 1], at: [0, 0.225, 0] }]);
	assert.equal(airStretches(onBox.clip, onBox.aux).length, 0, "feet on a prop's box are not off the ground");
	const slow = build(1, lift(20, "inout", false));
	assert.equal(airStretches(slow.clip, slow.aux).length, 0, "a lift without a jolt is not told");
	const toes = build(1, [[0, "idle", {}], [20, "pose", { hip: [0, 0.12, 0], footL: { at: [0.09, 0.16, 0], pitch: 50 }, footR: { at: [-0.09, 0.16, 0], pitch: 50 }, over: 3 }], [50, "pose", { hip: [0, 0, 0], footL: "plant", footR: "plant", over: 3 }]]);
	assert.equal(airStretches(toes.clip, toes.aux).length, 0, "a body on its toes is not off the ground");
}
console.log("PASS verify-launch");
