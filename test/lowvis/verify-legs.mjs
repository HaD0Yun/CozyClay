// The two legs of a posture change (engine-simple/legs.js, posture.js, legs-told.js):
//  1. a kneel written with nothing else brings its knees to the floor on different frames, the leading one first
//  2. a stand after a kneel ends standing
//  3. feet: a foot steps where it is set and stays planted there; a kneel's knees both go down unless one foot is over
//     about 0.66 m ahead of the other: that knee stays up
//  4. the words are checked, and the tool's legs lines say what each leg did, from the clip
//  5. a foot set further than the legs reach is set as far as they reach (no body on the floor), and the line says so
//  6. over 0 with feet: in the posture at once, the feet on their spots
//  7. feet stepped while kneeling: the body stands up between its feet, and leaves the pose it held without a jump
//  8. a lag over half the change is half the change; a change with more frames than its action is played in them
//  9. on a prop that carries the body the foot's line is not the prop's travel
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { legLines } from "../../src/lowvis/engine-simple/legs-told.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";

const SCENE = { frames: 120, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [] };
const build = (a, scene = SCENE, more = {}) => buildClip({ demo: "x", a, ...more }, structuredClone(scene));
const P = (clip, f, j) => Array.from(clip.characters[0].pos.slice((f * JOINT_COUNT + j) * 3, (f * JOINT_COUNT + j) * 3 + 3));
const down = (clip, j) => { for (let f = 0; f < clip.frameCount; f++) if (P(clip, f, j)[1] < 0.1) return f; return null; };
const lowest = clip => { let m = Infinity; for (let f = 0; f < clip.frameCount; f++) for (const j of [J.LeftLeg, J.RightLeg, J.LeftFoot, J.RightFoot]) m = Math.min(m, P(clip, f, j)[1]); return m; };
const jolt = clip => { let m = 0; for (let f = 1; f + 1 < clip.frameCount; f++) { const a = P(clip, f - 1, 0), b = P(clip, f, 0), c = P(clip, f + 1, 0); m = Math.max(m, Math.hypot(a[0] + c[0] - 2 * b[0], a[1] + c[1] - 2 * b[1], a[2] + c[2] - 2 * b[2])); } return m; };

{
	const { clip } = build([[0, "idle"], [20, "kneel", { over: 30 }], [100, "idle"]]), r = down(clip, J.RightLeg), l = down(clip, J.LeftLeg);
	assert.ok(r != null && l != null && r < l, `kneel: the right knee (leading) at the floor first, then the left (${r}, ${l})`);
	const { clip: same } = build([[0, "idle"], [20, "kneel", { over: 30, lag: 0 }], [100, "idle"]]);
	assert.equal(down(same, J.RightLeg), down(same, J.LeftLeg), "kneel lag 0: both knees together");
	console.log("ok 1: a kneel's knees come down one after the other; lag 0 together");
}
{
	const { clip } = build([[0, "idle"], [10, "kneel", { over: 30 }], [60, "stand", { over: 30 }], [110, "idle"]]);
	assert.ok(Math.abs(P(clip, 119, J.Hips)[1] - P(clip, 0, J.Hips)[1]) < 0.005, "stand after kneel: standing at the end");
	console.log("ok 2: stand after a kneel stands up");
}
{
	const { clip, aux } = build([[0, "idle"], [10, "kneel", { over: 44, feet: { L: [0, -0.9] } }], [100, "idle"]]);
	const a0 = P(clip, 0, J.LeftFoot), a1 = P(clip, 21, J.LeftFoot);
	assert.ok(Math.abs(a1[2] - a0[2] + 0.9) < 0.02, "feet: the left foot stepped 0.9 m back");
	assert.ok(down(clip, J.LeftLeg) != null && down(clip, J.RightLeg) == null && P(clip, 80, J.RightLeg)[1] > 0.4, "the right foot is over 0.66 m ahead: its knee stays up, the left goes down");
	const k = P(clip, 80, J.RightLeg), an = P(clip, 80, J.RightFoot), shin = Math.atan2(Math.abs(k[2] - an[2]), k[1] - an[1]) * 180 / Math.PI;
	assert.ok(shin < 31, `the shin over that flat foot leans under 31 degrees (${shin.toFixed(1)})`);
	const lines = legLines(clip, aux);
	assert.match(lines[1], /left knee at the floor from f\d+; right knee not at the floor by f54/);
	assert.ok(!/from where feet set it/.test(lines[1]), "the foot is where feet set it");
	// nearer than that, both knees go down, the one behind first, the hips as low as both thighs reach
	const near = build([[0, "idle"], [10, "kneel", { over: 40, feet: { L: [0, -0.4] } }], [100, "idle"]]).clip;
	assert.ok(down(near, J.LeftLeg) < down(near, J.RightLeg), "0.4 m apart: both knees at the floor, the leg behind first");
	assert.ok(P(near, 80, J.LeftLeg)[1] < 0.08 && P(near, 80, J.RightLeg)[1] < 0.08, "both knees rest on the floor");
	// on either side of where the other knee comes down (0.66 m): 0.64 both down, 0.68 the front knee up
	for (const [d, up] of [[0.64, false], [0.68, true]]) {
		const y = P(build([[0, "idle"], [10, "kneel", { over: 40, feet: { R: [0, d] } }], [100, "idle"]]).clip, 80, J.RightLeg)[1];
		assert.ok(up ? y > 0.3 : y < 0.08, `a foot ${d} m ahead: its knee ${up ? "up" : "at the floor"} (${y.toFixed(3)} m)`);
	}
	console.log("ok 3: feet step and stay; a foot far ahead keeps its knee up, a nearer one goes down too");
}
{
	assert.throws(() => build([[0, "kneel", { feet: { L: 0.3 } }]]), /feet wants \{L\?: \[left, forward\]/);
	assert.throws(() => build([[0, "sit", { height: 0.4, lead: "left" }]]), /lead wants "L" or "R"/);
	assert.throws(() => build([[0, "kneel", { lag: -1 }]]), /lag wants a number of frames >= 0/);
	const { aux } = build([[0, "idle"], [10, "sit", { height: 0.45 }]]);
	assert.ok(aux.legs?.length === 1 && aux.legs[0].lead === 1, "a sit records its legs (the right leads by default)");
	console.log("ok 4: the words are checked; each change records its legs");
}
{
	for (const rows of [[[0, "idle"], [10, "kneel", { over: 40, feet: { R: [0, 1.6] } }]], [[0, "sit", { height: 0.45, over: 0 }], [10, "idle", { feet: { R: [0, 0.8] } }]], [[0, "kneel", { over: 0 }], [10, "idle", { feet: { R: [0, -0.4] } }]], [[0, "idle"], [10, "idle", { feet: { R: [0, 2.5] } }]]]) {
		const { clip, aux } = build(rows), name = JSON.stringify(rows.at(-1));
		assert.ok(lowest(clip) > -0.01, `${name}: no knee or ankle under the floor (${lowest(clip).toFixed(3)})`);
		assert.ok(P(clip, 119, J.Hips)[1] > 0.4, `${name}: the hips are not on the floor (${P(clip, 119, J.Hips)[1].toFixed(3)})`);
		assert.match(legLines(clip, aux).join("\n"), /right foot \d+ mm from where feet set it/, `${name}: the line says how far short the foot is`);
	}
	console.log("ok 5: a foot set past the legs' reach is set as far as they reach, and told");
}
{
	const { clip } = build([[0, "kneel", { over: 0, feet: { L: [0, -0.4] } }], [60, "idle"]]), still = build([[0, "idle"]]).clip;
	assert.ok(P(clip, 0, J.Hips)[1] < 0.7 && Math.abs(P(clip, 0, J.Hips)[1] - P(clip, 50, J.Hips)[1]) < 1e-6, "over 0: kneeling on frame 0");
	assert.ok(P(clip, 0, J.LeftFoot)[2] < P(still, 0, J.LeftFoot)[2] - 0.1 && jolt(clip) < 0.001, "the left foot is on its spot at once; nothing moves after");
	console.log("ok 6: over 0 with feet is in the posture at once");
}
{
	const { clip } = build([[0, "idle"], [10, "kneel", { over: 36, feet: { R: [0, 0.9] } }], [60, "kneel", { over: 30, feet: { R: [0, -0.9] } }], [110, "stand", { over: 30 }], [150, "idle"]], { ...SCENE, frames: 170 });
	const l = down(clip, J.LeftLeg), r = down(clip, J.RightLeg), mid = (P(clip, 169, J.LeftFoot)[2] + P(clip, 169, J.RightFoot)[2]) / 2, still = build([[0, "idle"]]).clip;
	assert.ok(l != null && r != null && r - l > 12, `one knee, then the other (${l}, ${r})`);
	assert.ok(Math.abs(P(clip, 169, J.Hips)[1] - P(still, 0, J.Hips)[1]) < 0.005, "it ends standing");
	assert.ok(Math.abs((P(clip, 169, J.Hips)[2] - mid) - (P(still, 0, J.Hips)[2] - P(still, 0, J.LeftFoot)[2])) < 0.01, "over the middle of its feet, as a body stands");
	const stepped = build([[0, "idle"], [10, "kneel", { over: 24 }], [50, "idle", { feet: { R: [0, 0.5] } }], [90, "stand", { over: 30 }]]).clip;
	assert.ok(jolt(stepped) < 0.04, `a foot stepped while kneeling: the rise leaves that pose without a jump (${(jolt(stepped) * 1000).toFixed(0)} mm)`);
	console.log("ok 7: after feet stepped while kneeling the body stands up between them");
}
{
	const text = rows => serializeClip(build(rows).clip);
	assert.equal(text([[0, "idle"], [10, "kneel", { over: 30, lag: 500 }]]), text([[0, "idle"], [10, "kneel", { over: 30, lag: 15 }]]), "a lag over half the change is half the change");
	const { clip, aux } = build([[0, "idle"], [10, "kneel", { feet: { L: [0, -0.35], R: [0, 0.1] } }], [24, "idle"]]);
	assert.match(legLines(clip, aux).join("\n"), /more frames than its action has: played faster/);
	assert.ok(Math.abs(P(clip, 23, J.Hips)[1] - P(clip, 40, J.Hips)[1]) < 0.06, `the change ends in its action's frames: the hold after it does not jump (${(P(clip, 23, J.Hips)[1] - P(clip, 40, J.Hips)[1]).toFixed(3)} m)`);
	console.log("ok 8: lag is at most half the change; steps and a change that do not fit are played faster");
}
{
	const raft = { frames: 120, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ id: "raft", size: [3, 0.2, 3], at: [0, 0.1, 0], moves: true }] };
	const { clip, aux } = build([[0, "idle", { on: "raft" }], [10, "kneel", { on: "raft", over: 40, feet: { L: [0, -0.4] } }]], raft, { raft: [[0, "move", { to: [1.5, 0.1, 0.5], over: 110 }]] });
	const lines = legLines(clip, aux).join("\n");
	assert.ok(!/from where feet set it/.test(lines), `on a moving prop the foot is where feet set it on the prop (${lines})`);
	assert.match(lines, /left knee at the floor from f\d+; right knee at the floor from f\d+/);
	console.log("ok 9: a body carried by a prop: knees against its own feet, the foot against its spot on the prop");
}
console.log("PASS verify-legs");
