#!/usr/bin/env node
// Each character's take draws the props that character handles (src/lowvis/studio/install.js): a timing edit of one
// character's take (motion-timing.js, take-edit.js renderTakeEdit) moves the props that character holds with that
// character, and leaves the props other characters hold with theirs. Measured as the Studio plays it: the clip installed
// through installClip, each take decoded and placed as motion.v4.install does, the edit rendered, the object tracks
// merged across the cast (object-tracks.js), the hand played by forward kinematics. On every timeline frame a holder holds
// a prop, the prop stays where it is against that hand at the same moment of the unedited clip.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { installClip } from "../../src/lowvis/studio/install.js";
import { TRACK_RIG } from "../../src/lowvis/studio/take.js";
import { decodeRawTrack } from "../../src/motion-v4/track/codec.js";
import { placedTake } from "../../src/motion-v4/track/literal.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { fk } from "../../src/motion3/compiler/skeleton.js";
import { createTakeEdit, renderTakeEdit, setSegmentSpeed, splitTakeEdit, timelineToSource } from "../../src/motion3/take-edit.js";
import { objectTracksOf } from "../../src/motion3/object-tracks.js";

const sk = skeletonFor(TRACK_RIG), HAND = sk.index.RightHand;

/** The clip of a spec on a scene, as the Studio reads it (serialized and parsed), with the engine's aux. */
const build = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), scene); return { aux: b.aux, clip: JSON.parse(serializeClip(b.clip)) }; };

/** installClip with a Studio that records: { takes: { <clip character id>: placed take }, objectOf: { <prop id>: Studio id } }. */
async function install(clip) {
	const placements = {}, raws = {};
	let n = 0;
	const run = async (action, args) => {
		if (action === "character.add") { placements[args.character.id] = { position: [args.character.x, 0, args.character.z], yaw: args.character.rot }; return { affectedIds: [args.character.id] }; }
		if (action === "motion.v4.install") { raws[args.characterId] = args.raw; return { affectedIds: [args.characterId] }; }
		return { affectedIds: [`obj-${++n}`] };
	};
	const out = await installClip(clip, run);
	assert.equal(out.ok, true);
	const takes = Object.fromEntries(clip.characters.map(c => { const id = `lowvis-${c.id}`; return [c.id, { id, take: placedTake(decodeRawTrack(raws[id], sk), placements[id]) }]; }));
	// drawnBy: { <prop id>: [the clip characters whose take holds its track] }
	const drawnBy = Object.fromEntries(Object.entries(out.placed).map(([prop, id]) => [prop, Object.entries(takes).filter(([, t]) => t.take.objects[id]).map(([cid]) => cid)]));
	return { takes, objectOf: out.placed, drawnBy };
}

/** The world place of the right hand in a (rendered) take at frame f. */
function hand(take, f) {
	const B = take.bones.length, quats = take.bones.map((_, b) => Array.from(take.rot.slice((f * B + b) * 4, (f * B + b) * 4 + 4)));
	const p = fk(sk, quats, Array.from(take.hips.slice(f * 3, f * 3 + 3))).P[HAND], yaw = take.placement.yaw * Math.PI / 180, cs = Math.cos(yaw), sn = Math.sin(yaw), at = take.placement.position;
	return [cs * p[0] + sn * p[2] + at[0], p[1] + at[1], -sn * p[0] + cs * p[2] + at[2]];
}

/** The merged object tracks the Studio plays with `edits` ({ <clip character id>: edit }) on the takes. */
function play(takes, edits = {}) {
	const shown = new Map(Object.entries(takes).map(([cid, t]) => [t.id, { takeOf: cid, take: renderTakeEdit(edits[cid] ? { ...t.take, edit: edits[cid] } : t.take) }]));
	return { shown, tracks: objectTracksOf({ motionFor: id => shown.get(id)?.take }, [...shown.keys()].map(id => ({ id }))) };
}
const at = (track, f) => [track.pos[f * 3], track.pos[f * 3 + 1], track.pos[f * 3 + 2]];
const lerpAt = (fn, s) => { const i0 = Math.floor(s), i1 = Math.ceil(s), a = fn(i0), b = fn(i1), t = s - i0; return a.map((v, k) => v + (b[k] - v) * t); };
const sub = (a, b) => a.map((v, k) => v - b[k]);
const dist = (a, b) => Math.hypot(...sub(a, b));

/**
 * The worst distance, over the timeline frames of character `who`'s take that show a source frame where `who` holds
 * prop `prop`, between the prop's place against `who`'s hand as played with `edits` and as in the unedited clip at the
 * same source moment. { worst, frames }.
 */
function drift(case_, who, prop, edits) {
	const base = play(case_.takes), edited = play(case_.takes, edits), id = case_.objectOf[prop], me = case_.takes[who];
	const taken = edited.shown.get(me.id).take, plain = base.shown.get(me.id).take, edit = edits[who];
	const ref = f => sub(at(base.tracks.get(id), f), hand(plain, f));
	let worst = 0, frames = 0;
	for (let t = 0; t < taken.frameCount; t++) {
		const s = edit ? timelineToSource(edit, t) : t, held = [Math.floor(s), Math.ceil(s)].every(k => String(case_.aux.holders[prop][k] ?? "").split("+").some(h => h.split(":")[0] === who));
		if (!held) continue;
		frames++;
		const track = edited.tracks.get(id), now = sub(at(track, Math.min(t, track.pos.length / 3 - 1)), hand(taken, t));
		worst = Math.max(worst, dist(now, lerpAt(ref, s)));
	}
	return { worst, frames };
}

const box = (id, at) => ({ id, size: [0.3, 0.3, 0.3], at, moves: true });
const F = 120;
// two characters side by side, each with a box in the right hand from frame 0, walking off at different times
const SCENE = { frames: F, characters: [{ id: "a", at: [-1, 0], heading: 0 }, { id: "b", at: [1, 0], heading: 0 }], props: [box("boxA", [-1.25, 0.85, 0.3]), box("boxB", [0.75, 0.85, 0.3])] };
const SPEC = {
	a: [[0, "hold", { prop: "boxA", hand: "R" }], [10, "walk", { to: [-1, 2] }]],
	b: [[0, "hold", { prop: "boxB", hand: "R" }], [40, "walk", { to: [1, 2.5] }], [100, "release", { prop: "boxB" }]],
};
const built = build(SPEC, SCENE), installed = { ...built, ...(await install(built.clip)) };
const speedUp = (() => { const split = splitTakeEdit(createTakeEdit(F), 30); return setSegmentSpeed(split, split[1].id, 2); })();
const TOL = 0.002, mm = v => (v * 1000).toFixed(2), failed = [];

for (const [edited, other] of [["a", "b"], ["b", "a"]]) {
	const edits = { [edited]: speedUp };
	for (const [who, prop] of [[edited, `box${edited.toUpperCase()}`], [other, `box${other.toUpperCase()}`]]) {
		const d = drift(installed, who, prop, edits);
		assert.ok(d.frames > 20, `${who} holds ${prop} on frames of the take (${d.frames})`);
		const line = `${edited} sped up: ${prop} in ${who}'s hand, worst ${mm(d.worst)} mm off its place against the hand over ${d.frames} held frames (want under ${mm(TOL)} mm)`;
		console.log(`${d.worst < TOL ? "ok" : "FAIL"} ${line}`);
		if (d.worst >= TOL) failed.push(line);
	}
}
assert.equal(failed.length, 0, `each prop stays in its holder's hand after a timing edit of either take:\n${failed.join("\n")}`);
assert.deepEqual(installed.drawnBy, { boxA: ["a"], boxB: ["b"] }, "each box's track is in its holder's take, and in no other");

// --- who handles a prop, case by case: the take that draws each moving prop ---
const ROOM = (characters, props, frames = 140) => ({ frames, characters, props });
const stand = (id, x, z = 0, heading = 0) => ({ id, at: [x, z], heading });
const CASES = [
	{ name: "three characters, the middle one handles nothing: each box stays with its holder",
		scene: ROOM([stand("a", -1.5), stand("b", 0), stand("c", 1.5)], [box("boxA", [-1.75, 0.85, 0.3]), box("boxC", [1.25, 0.85, 0.3])]),
		spec: { a: [[0, "hold", { prop: "boxA", hand: "R" }], [20, "walk", { to: [-1.5, 2] }]], b: [[10, "walk", { to: [0, 1.5] }]], c: [[0, "hold", { prop: "boxC", hand: "R" }], [50, "walk", { to: [1.5, 2] }]] },
		drawn: { boxA: ["a"], boxC: ["c"] }, steps: [["a", "boxA"], ["c", "boxC"]] },
	{ name: "let go with a roll: the ball stays with the one who let it go; a crate moved by its own keys stays with the first character",
		scene: ROOM([stand("a", -1), stand("b", 1)], [{ id: "ball", shape: "sphere", size: [0.22, 0.22, 0.22], at: [0.75, 0.85, 0.3], moves: true }, box("crate", [3, 0.15, 3]), { id: "wall", size: [0.3, 1, 0.3], at: [0, 0.5, -3] }]),
		spec: { b: [[0, "hold", { prop: "ball", hand: "R" }], [10, "walk", { to: [1, 1.5] }], [40, "release", { prop: "ball", roll: true }]], a: [[0, "walk", { to: [-1, 1] }]], crate: [[20, "move", { to: [3, 0.15, 4], over: 40 }]] },
		drawn: { ball: ["b"], crate: ["a"], wall: [] }, steps: [["b", "ball"]] },
	{ name: "a cup rides a tray: it goes with whoever holds the tray; a hat rides a joint of a body: it goes with that body",
		scene: ROOM([stand("a", -1), stand("b", 1)], [box("tray", [0.75, 0.85, 0.3]), { id: "cup", size: [0.08, 0.1, 0.08], at: [0.75, 1.05, 0.3], moves: true }, { id: "hat", size: [0.25, 0.1, 0.25], at: [-1, 1.85, 0], moves: true }]),
		spec: { b: [[0, "hold", { prop: "tray", hand: "R" }], [30, "walk", { to: [1, 2] }]], a: [[0, "walk", { to: [-1, 1.5] }]], cup: [[0, "ride", { on: "tray" }]], hat: [[0, "ride", { joint: "Head", of: "a" }]] },
		drawn: { tray: ["b"], cup: ["b"], hat: ["a"] }, steps: [["b", "tray"]] },
	{ name: "a board both carry together: one take, the earlier character",
		scene: ROOM([stand("p", -1.05, 0.55, 180), stand("q", 1.05, 0.55, 180)], [{ id: "board", size: [2.6, 0.06, 0.4], at: [0, 0.6, 0], moves: true }, { id: "stool", size: [0.3, 0.57, 0.3], at: [0, 0.285, 0] }], 200),
		spec: Object.fromEntries(["p", "q"].map(who => [who, [[10, "pose", { bow: 35, over: 20 }], [20, "hold", { prop: "board", hand: "both", at: who === "p" ? { L: [-1.2, 0, 0.18], R: [-0.9, 0, 0.18] } : { L: [0.9, 0, 0.18], R: [1.2, 0, 0.18] }, over: 14 }],
			[50, "pose", { hands: [0.16, 0.25, 0.32], bow: 0, over: 24 }], [80, "walk", { to: [who === "p" ? -1.05 : 1.05, -1.6] }], [175, "release", { prop: "board" }]]])),
		drawn: { board: ["p"], stool: [] }, steps: [["p", "board"]] },
	{ name: "a box handed over: the one who carries it on more of the frames it moves",
		scene: ROOM([stand("a", -0.5, 0, 90), stand("b", 0.5, 0, -90)], [box("box", [-0.2, 0.85, 0.25])], 160),
		spec: { a: [[0, "hold", { prop: "box", hand: "R" }], [50, "release", { prop: "box" }], [60, "walk", { to: [-2, 0] }]], b: [[40, "hold", { prop: "box", hand: "L" }], [70, "walk", { to: [2, 1] }]] },
		drawn: { box: ["b"] }, steps: [] },
];
for (const c of CASES) {
	const b = build(c.spec, c.scene), got = { ...b, ...(await install(b.clip)) };
	assert.deepEqual(got.drawnBy, c.drawn, `${c.name}: the take that draws each prop`);
	for (const [who, prop] of c.steps) for (const edited of Object.keys(got.takes)) {
		const edits = { [edited]: speedUp }, d = drift(got, who, prop, edits);
		assert.ok(d.frames > 10 && d.worst < TOL, `${c.name}: with ${edited}'s take sped up, ${prop} stays in ${who}'s hand (worst ${mm(d.worst)} mm over ${d.frames} frames)`);
	}
	console.log(`ok ${c.name}: ${Object.entries(got.drawnBy).map(([p, w]) => `${p} -> ${w.join(",") || "no track"}`).join(", ")}`);
}

// --- a clip without `by` (made before it): every moving prop in the first character's take, as before ---
{
	const old = { ...built.clip, props: built.clip.props.map(p => { const q = { ...p }; delete q.by; return q; }) }, got = await install(old);
	assert.deepEqual(got.drawnBy, { boxA: ["a"], boxB: ["a"] });
	console.log("ok a clip without by: both boxes in the first character's take, as before");
}
console.log("PASS verify-prop-owner");
