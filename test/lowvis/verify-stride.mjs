// A walk, run or push straight into a launch hands its speed on (gait.js travel `onward`), and a flight that leaves
// from a stride has the legs of captured running jumps (air-legs.js): the run does not slow down or stand before the
// take-off, one foot pushes while the other knee is up, in the air the two legs differ, the push foot comes down after
// the lead foot, and no foot goes under the floor. A run that is not followed by a launch stops as before. A flight of
// fewer frames than the captured ones has as much less of their legs, a travel with `first` is handed on too, and a push
// in place (no speed to hand on) launches as before.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { ANKLE_HEIGHT, INDEX as J, JOINT_COUNT, REST } from "../../src/lowvis/rig17.js";

const build = (s, acts, frames = 120) => buildClip({ a: acts }, { demo: "x", frames, characters: [{ id: "a", at: [0, 0], heading: 0, ...(s === 1 ? {} : { scale: s }) }], props: [] });
const at = (c, f, j) => Array.from(c.pos.slice((f * JOINT_COUNT + j) * 3, (f * JOINT_COUNT + j) * 3 + 3));
const sub = (a, b) => a.map((v, i) => v - b[i]), len = a => Math.hypot(...a);
const LEG = len(sub(REST[J.LeftLeg], REST[J.LeftUpLeg])) + len(sub(REST[J.LeftFoot], REST[J.LeftLeg])) + ANKLE_HEIGHT;
const along = (c, f) => len([at(c, f, J.Hips)[0] - at(c, f - 1, J.Hips)[0], 0, at(c, f, J.Hips)[2] - at(c, f - 1, J.Hips)[2]]) * 24;
const knee = (c, f, side) => { const [h, k, a] = side ? [J.RightUpLeg, J.RightLeg, J.RightFoot] : [J.LeftUpLeg, J.LeftLeg, J.LeftFoot]; const u = sub(at(c, f, k), at(c, f, h)), v = sub(at(c, f, a), at(c, f, k)); return Math.acos(Math.max(-1, Math.min(1, u.reduce((n, x, i) => n + x * v[i], 0) / len(u) / len(v)))) * 180 / Math.PI; };

for (const s of [0.6, 1, 1.4]) {
	const { clip, aux } = build(s, [[0, "idle", {}], [10, "run", { to: [0, 5 * s] }], [50, "launch", { to: [0, 7.5 * s] }], [64, "idle", {}]]), c = clip.characters[0], a = aux.flights[0].f0 - 1, b = aux.flights[0].f1;
	let mean = 0; for (let f = a - 23; f <= a - 12; f++) mean += along(c, f) / 12;
	for (let f = a - 11; f <= a; f++) assert.ok(along(c, f) > 0.85 * mean, `scale ${s}: f${f} the run does not slow before the take-off (${along(c, f).toFixed(2)} of ${mean.toFixed(2)} m/s)`);
	const last = side => { let f = a; while (f > 0 && !aux.contacts.a[f][side]) f--; return f; }, push = last(0) > last(1) ? 0 : 1, lead = 1 - push;
	assert.ok(last(push) - last(lead) >= 2, `scale ${s}: the feet leave the ground frames apart (f${last(lead)}, f${last(push)})`);
	assert.ok(knee(c, a, lead) > 60, `scale ${s}: the lead knee is up at the take-off (${knee(c, a, lead).toFixed(0)} deg)`);
	let most = 0; for (let f = a + 1; f < b; f++) most = Math.max(most, knee(c, f, push));
	assert.ok(most > 110, `scale ${s}: the push leg folds in the air (${most.toFixed(0)} deg)`);
	const touch = side => { for (let f = b; f < 120; f++) if (aux.contacts.a[f][side]) return f; return null; };
	assert.ok(touch(push) > touch(lead), `scale ${s}: the push foot comes down after the lead foot (f${touch(lead)}, f${touch(push)})`);
	for (let f = 0; f < 120; f++) for (const j of [J.LeftFoot, J.RightFoot]) assert.ok(at(c, f, j)[1] > 0.05 * s, `scale ${s}: f${f} an ankle stays over the floor`);
	// a run that is not followed by a launch stops as it did: the same frames whatever follows the stand
	const stop = build(s, [[0, "idle", {}], [10, "run", { to: [0, 5 * s] }], [50, "idle", {}]]).clip.characters[0], stopPose = build(s, [[0, "idle", {}], [10, "run", { to: [0, 5 * s] }], [50, "kneel", {}]]).clip.characters[0];
	for (let f = 0; f < 44; f++) assert.ok(len(sub(at(stop, f, J.Hips), at(stopPose, f, J.Hips))) < 1e-9, `scale ${s}: f${f} a run into a kneel stops as a run into a stand (to where the frames beside the kneel smooth it)`);
	// a flight of 4 frames: no ankle moves from the hips in one frame further than the captured legs' fastest (0.29 leg lengths)
	const hop = build(s, [[0, "idle", {}], [10, "run", { to: [0, 5 * s] }], [50, "launch", { to: [0, 5.5 * s] }], [53, "idle", {}]]), h = hop.clip.characters[0], fl = hop.aux.flights[0];
	for (let f = fl.f0; f <= fl.f1; f++) for (const j of [J.LeftFoot, J.RightFoot]) {
		const move = len(sub(sub(at(h, f, j), at(h, f, J.Hips)), sub(at(h, f - 1, j), at(h, f - 1, J.Hips)))) / (LEG * s);
		assert.ok(move < 0.3, `scale ${s}: f${f} in a flight of ${fl.f1 - fl.f0 + 1} frames an ankle moves ${move.toFixed(2)} leg lengths from the hips in one frame`);
	}
}
// a travel with `first` is handed on as any other; a push in place hands nothing on and launches
{
	const { clip, aux } = build(1, [[0, "idle", {}], [10, "run", { to: [0, 5], first: "R" }], [50, "launch", { to: [0, 7.5] }], [64, "idle", {}]]), c = clip.characters[0], a = aux.flights[0].f0 - 1;
	let mean = 0; for (let f = a - 23; f <= a - 12; f++) mean += along(c, f) / 12;
	for (let f = a - 11; f <= a; f++) assert.ok(along(c, f) > 0.85 * mean, `first: f${f} the run does not slow before the take-off`);
	const still = build(1, [[0, "idle", {}], [10, "push", { to: [0, 0] }], [40, "launch", { to: [0, 0.8] }], [52, "idle", {}]]);
	assert.equal(still.aux.flights.length, 1, "a push in place into a launch builds and flies");
}
