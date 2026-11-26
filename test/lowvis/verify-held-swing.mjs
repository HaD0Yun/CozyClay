// A body-frame hand target keyed before a travel moves with the gait's arm where a free hand would be (held-swing.js);
// keyed on the travel's first frame, far from where a free hand hangs, on a hand that holds a prop or on an arm with an
// elbow target it holds still. Only the arm moves, no reach row is measured against a hand the gait moves, and what
// begins in the travel goes on from where the hand is. A pose shift with no tilt is read.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { INDEX as J, JOINTS } from "../../src/lowvis/rig17.js";
import { len, qConj, qRotate, sub } from "../../src/lowvis/engine-simple/math.js";
import { systemPrompt } from "../../src/lowvis/pi/prompt.mjs";

const def = (props = []) => ({ frames: 200, characters: [{ id: "a", at: [0, 0], heading: 0 }], props });
const walk = [60, "walk", { to: [0, 6] }], run = [60, "run", { to: [0, 24] }], STANCE = { L: [0.24, -0.11, 0.14], R: [-0.24, -0.14, -0.10] };
const stick = { id: "stick", at: [-0.3, 0.9, 0.3], size: [0.04, 0.04, 0.6], moves: true };
const built = (acts, props) => buildClip({ demo: "t", a: acts }, structuredClone(def(props)));
const at = (clip, f, j) => { const c = clip.characters[0], i = f * 17 + j; return { p: [...c.pos.slice(i * 3, i * 3 + 3)], q: [...c.quat.slice(i * 4, i * 4 + 4)] }; };
/** A hand against its shoulder in the chest's frame on frame f. */
const inChest = (clip, f, side) => qRotate(qConj(at(clip, f, J.Spine2).q), sub(at(clip, f, J[`${side}Hand`]).p, at(clip, f, J[`${side}Arm`]).p));
/** A hand's fore-aft range in the chest's frame over the steady travel (m). */
const foreAft = (clip, side = "Left") => { const z = []; for (let f = 84; f < 144; f++) z.push(inChest(clip, f, side)[2]); return Math.max(...z) - Math.min(...z); };
/** The largest change of a hand's move from one frame to the next over frames a..b (m). */
const pop = (clip, side, a, b) => { let most = 0; for (let f = a; f <= b; f++) most = Math.max(most, len(sub(sub(inChest(clip, f, side), inChest(clip, f - 1, side)), sub(inChest(clip, f - 1, side), inChest(clip, f - 2, side))))); return most; };
/** The joints whose place differs between two clips by over 1e-6 m on any frame. */
const differ = (x, y) => JOINTS.filter((_, j) => { for (let f = 0; f < 200; f++) if (len(sub(at(x, f, j).p, at(y, f, j).p)) > 1e-6) return true; return false; });
const ARMS = ["LeftForeArm", "LeftHand", "RightForeArm", "RightHand"];

const free = foreAft(built([walk]).clip), held = built([[30, "pose", STANCE], walk]), stance = foreAft(held.clip);
const onStart = foreAft(built([[60, "pose", STANCE], walk]).clip), overhead = foreAft(built([[30, "pose", { L: [0.15, 0.95, 0.05] }], walk]).clip);
assert.ok(free > 0.12, `a free hand swings (${free.toFixed(3)} m)`);
assert.ok(stance > 0.75 * free, `a hand keyed near where it hangs before the walk swings with it: ${stance.toFixed(3)} of the free ${free.toFixed(3)} m`);
assert.ok(onStart < 0.06, `keyed on the walk's first frame it holds: ${onStart.toFixed(3)} m`);
assert.ok(overhead < 0.06, `keyed overhead it holds: ${overhead.toFixed(3)} m`);
console.log(`ok held hands: free ${free.toFixed(3)}, keyed before ${stance.toFixed(3)}, on the first frame ${onStart.toFixed(3)}, overhead ${overhead.toFixed(3)} m fore-aft`);

// only the arm moves: every other joint is where the key held still has it (the key on the travel's first frame, the
// same place), and the reach assist does not follow the gait's arm
for (const [name, travel] of [["walk", walk], ["run", run]]) {
	const moved = built([[30, "pose", STANCE], travel]), still = built([[30, "pose", STANCE], [60, "pose", { ...STANCE, over: 0 }], travel]);
	assert.deepEqual(differ(moved.clip, still.clip).filter(n => !ARMS.includes(n)), [], `${name}: no joint but the elbows and wrists moves with the gait's arm`);
	assert.ok(differ(moved.clip, still.clip).includes("LeftHand"), `${name}: the wrist does`);
	// no reach row against a hand the gait moves: its key's point is not where it is meant to be
	const rows = moved.aux.reach.a.slice(84, 144).map(r => r[0] ?? r[1]).filter(Boolean);
	assert.equal(rows.length, 0, `${name}: no reach row of a hand the gait moves`);
	assert.ok(still.aux.reach.a[100][0], `${name}: a hand held still has its row`);
}
console.log("ok held hands: only the arm moves, no reach row against a moved hand");

// a hand that holds a prop, alone or as one of the hands that share it, keeps its place; so does an arm with an elbow target
for (const hold of [[10, "hold", { prop: "stick", hand: "R" }], [10, "hold", { prop: "stick", hand: "both", at: { L: [0, 0, 0.2], R: [0, 0, -0.2] }, over: 10 }]]) {
	const a = built([hold, [30, "pose", STANCE], run], [stick]), b = built([hold, [30, "pose", STANCE], [60, "pose", { ...STANCE, over: 0 }], run], [stick]);
	assert.deepEqual(differ(a.clip, b.clip).filter(n => n.startsWith("Right")), [], `hold ${hold[2].hand}: the holding hand does not move with the gait`);
	assert.ok(a.clip.props[0].pos.every((v, n) => Math.abs(v - b.clip.props[0].pos[n]) < 1e-6), `hold ${hold[2].hand}: the prop is where the hand held still has it`);
}
const elbow = built([[30, "pose", { ...STANCE, elbowL: [0.4, 0.2, -0.1] }], run]), elbowStill = built([[30, "pose", { ...STANCE, elbowL: [0.4, 0.2, -0.1] }], [60, "pose", { L: STANCE.L, over: 0 }], run]);
assert.deepEqual(differ(elbow.clip, elbowStill.clip).filter(n => n.startsWith("Left")), [], "an arm with an elbow target does not move with the gait");
console.log("ok held hands: a holding hand and an arm with an elbow target hold");

// what begins in the travel goes on from where the hand is: a carry, an elbow key and a let-go make no jump of the hand
const steady = pop(held.clip, "Left", 86, 100);
const jumps = { carry: [[90, "carry", { prop: "box", at: [0, 0.1, 0.3] }]], "elbow key": [[90, "pose", { elbowL: [0.4, 0.2, -0.1] }]] };
for (const [name, more] of Object.entries(jumps)) {
	const p = pop(built([[30, "pose", STANCE], walk, ...more], [{ id: "box", at: [0, 0.3, 2.5], size: [0.3, 0.3, 0.3], moves: true }]).clip, "Left", 88, 94);
	assert.ok(p < steady + 0.01, `a ${name} that begins in the walk makes no jump of the hand: ${p.toFixed(3)} m beside ${steady.toFixed(3)} m of the swing`);
}
const letGo = built([[5, "hold", { prop: "stick", hand: "R" }], [30, "pose", STANCE], walk, [90, "release", { prop: "stick" }]], [stick]);
assert.ok(foreAft(letGo.clip, "Right") < 0.06, `a hand that held a prop into the walk and lets go in it stays as keyed (${foreAft(letGo.clip, "Right").toFixed(3)} m)`);
console.log(`ok held hands: a carry and an elbow key in the walk go on from the moving hand (the swing's own change of pace: ${steady.toFixed(3)} m)`);

// the manual says where it does not apply
const manual = systemPrompt("studio");
assert.ok(/keyed before a walk or run begins moves through it as the gait moves a free hand: fully where\s+a free hand hangs and swings, not at all from 0\.15 m off that \(times the body's scale\), with a\s+prop in that hand or an elbow target on that arm/.test(manual), "the manual says when a held hand moves with the gait");

const hipsY = acts => at(built(acts).clip, 40, J.Hips).p[1];
const up = hipsY([[10, "pose", { shift: [0, 0.4, 0] }]]) - hipsY([]);
assert.ok(Math.abs(up - 0.4) < 1e-6, `a shift with no tilt moves the body (${up.toFixed(3)} m)`);
const kept = hipsY([[0, "pose", { tilt: [0, 0], shift: [0, 0.2, 0], over: 0 }], [10, "pose", { shift: [0, 0.4, 0] }]]) - hipsY([]);
assert.ok(Math.abs(kept - 0.4) < 1e-6, `a shift alone after a tilt key replaces its shift (${kept.toFixed(3)} m)`);
// a shift alone is the key with the tilt and about before it written out
const alone = built([[5, "pose", { tilt: [30, 10], about: "feet", shift: [0, 0.1, 0] }], [40, "pose", { shift: [0, 0.3, 0.2] }]]), out = built([[5, "pose", { tilt: [30, 10], about: "feet", shift: [0, 0.1, 0] }], [40, "pose", { tilt: [30, 10], about: "feet", shift: [0, 0.3, 0.2] }]]);
assert.deepEqual(differ(alone.clip, out.clip), [], "a shift alone keeps the tilt and about of the tilt key before it");
console.log("ok shift: read with no tilt");
console.log("PASS verify-held-swing");
