#!/usr/bin/env node
// Three widenings of the simple engine's prop layer and the body layer, each pinned without wall time:
// 1. A move or tip key starts where the key before it has the prop on its frame: a prop keyed key after key never stands
//    still for a frame between two keys (before: the key's first frame repeated the frame before, so every key stopped
//    the prop, and what rode it, for one frame); a key cut into goes on from where the one before has it; a key after a
//    gap starts from the target before as it did; over 0 is there at once.
// 2. A body-layer action with `on: propId` is done on that prop and goes with it: the Hips joint keeps its place in the
//    prop's frame on every frame while the prop is keyed (moved and turned), carried by another body's hands, or ridden;
//    walking on it, getting on after it moved and getting off keep the body where it is; a sit's height with on; a body
//    of another scale; `on` a prop that does not move and a spec with no `on` build exactly as before.
// 3. hide / show keys: the clip's per-frame `shown`, kept apart from the motion keys (a prop only shown or hidden is not a
//    mover); the install writes a vis track (with the track of a moving prop, alone for a still one and for one attached
//    to a bone) that the Studio's trackShown reads, through the raw-track codec, the placed take and a timing edit;
//    the writer's inside rows and contact sheets leave a hidden prop out on the frames it is hidden.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip, validateClip } from "../../src/lowvis/clip.js";
import { INDEX, qConj, qRotate } from "../../src/lowvis/rig17.js";
import { installClip } from "../../src/lowvis/studio/install.js";
import { decodeRawTrack, encodeRawTrack } from "../../src/motion-v4/track/codec.js";
import { placedTake } from "../../src/motion-v4/track/literal.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { createTakeEdit, renderTakeEdit, setSegmentSpeed } from "../../src/motion3/take-edit.js";
import { TRACK_RIG } from "../../src/lowvis/studio/take.js";
import { trackShown } from "../../src/object-travel.js";
import { objectTracksOf } from "../../src/motion3/object-tracks.js";
import { insideRows } from "../../src/lowvis/pi/inside.mjs";
import { specFormat, systemPrompt } from "../../src/lowvis/pi/prompt.mjs";

const v3 = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]], q4 = (a, i) => [a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const propOf = (clip, id) => clip.props.find(p => p.id === id);
const at = (p, f) => v3(p.pos, p.pos.length === 3 ? 0 : f);
const hips = (c, f) => v3(c.pos, f * 17 + INDEX.Hips);
const inFrame = (p, f, x) => { const k = p.pos.length === 3 ? 0 : f; return qRotate(qConj(q4(p.quat, k)), x.map((v, i) => v - p.pos[k * 3 + i])); };
const steps = (p, from, to) => Array.from({ length: to - from }, (_, i) => dist(at(p, from + i), at(p, from + i - 1)));

// --- 1. prop keys start where the key before has the prop ---
{
	const def = { frames: 70, characters: [{ id: "a", at: [-2, 0], heading: 90 }], props: [
		{ id: "cart", size: [0.8, 0.5, 1.2], at: [0, 0.25, 0], moves: true }, { id: "crate", size: [0.3, 0.3, 0.3], at: [0, 0.65, 0], moves: true }] };
	for (const [every, ease] of [[5, "linear"], [2, "linear"], [5, "inout"], [3, "in"]]) {
		const cart = [];
		for (let f = 10, x = 0; f < 50; f += every) { x += 0.08 * every; cart.push([f, "move", { to: [x, 0.25, 0.03 * x * x], axis: [0, 1, 0], deg: 4 * x, over: every, ease }]); }
		const { clip } = buildClip({ cart, crate: [[0, "ride", { on: "cart" }]] }, def);
		const cartSteps = steps(propOf(clip, "cart"), 11, cart.at(-1)[0] + every), crateSteps = steps(propOf(clip, "crate"), 11, cart.at(-1)[0] + every);
		assert.ok(ease !== "linear" || Math.min(...cartSteps) > 0.07, `keys every ${every} frames, ${ease}: the cart moves on every frame of the move (least step ${Math.min(...cartSteps)} m)`);
		if (ease === "linear") assert.ok(Math.max(...cartSteps) - Math.min(...cartSteps) < 0.02, `keys every ${every} frames, linear: an even pace (steps ${Math.min(...cartSteps).toFixed(3)} to ${Math.max(...cartSteps).toFixed(3)} m)`);
		assert.ok(Math.min(...crateSteps) > 0 || ease !== "linear", "what rides it moves with it on every frame");
		// each key's own frame: the prop is on the target of the key before, its turn the sum of the turns before
		cart.slice(0, -1).forEach(([f, , o], i) => {
			const next = cart[i + 1][0];
			assert.ok(dist(at(propOf(clip, "cart"), next), o.to) < 1e-5, `key ${next}: starts on the target of the key at ${f}`);
		});
	}
	// a key cut into goes on from where the one before has it on its frame; a gap starts from the target before
	const cut = buildClip({ cart: [[10, "move", { to: [4, 0.25, 0], over: 20, ease: "linear" }], [20, "move", { to: [2, 0.25, 3], over: 10, ease: "linear" }], [40, "move", { to: [2, 0.25, 5], over: 10 }], [60, "move", { to: [3, 0.25, 5], over: 0 }]] }, def).clip;
	const c = propOf(cut, "cart");
	assert.ok(dist(at(c, 20), [2, 0.25, 0]) < 1e-5, "a key cut into starts where the key before has the prop on that frame");
	assert.ok(dist(at(c, 20), at(c, 19)) > 0.15, "and the prop does not stand still on that frame");
	assert.ok(dist(at(c, 40), [2, 0.25, 3]) < 1e-6 && dist(at(c, 39), [2, 0.25, 3]) < 1e-6, "after a gap a key starts from the target before");
	assert.ok(dist(at(c, 60), [3, 0.25, 5]) < 1e-6 && c.pos.every(Number.isFinite), "over 0: there at once, no NaN");
	// a key after a hand let the prop go starts where the prop is
	const handed = buildClip({ a: [[0, "pose", { R: { prop: "crate" }, over: 10 }], [10, "hold", { prop: "crate", hand: "R" }], [20, "pose", { R: [0.3, 0.3, 0.4], over: 8 }], [30, "release", { prop: "crate" }]], crate: [[5, "move", { to: [0, 0.65, 0.2], over: 4 }], [32, "move", { to: [-1, 0.15, 0], over: 10 }]] }, { ...def, characters: [{ id: "a", at: [0, -0.5], heading: 0 }] }).clip;
	const cr = propOf(handed, "crate");
	assert.ok(dist(at(cr, 32), at(cr, 31)) < 1e-6, "a key after a release starts where the hand left the prop");
}

// --- 2. a body on a moving prop ---
const report = (clip, who, on, from, to) => {
	const c = clip.characters.find(x => x.id === who), p = propOf(clip, on), l0 = inFrame(p, from, hips(c, from));
	let drift = 0, step = 0;
	for (let f = from; f < to; f++) drift = Math.max(drift, dist(inFrame(p, f, hips(c, f)), l0));
	for (let f = 1; f < clip.frameCount; f++) step = Math.max(step, dist(hips(c, f), hips(c, f - 1)));
	return { drift, step };
};
{
	const bikeKeys = [];
	for (let f = 10, a = 0; f < 70; f += 5) { a += 6; const t = a * Math.PI / 180; bikeKeys.push([f, "move", { to: [8 * Math.sin(t), 0.45, 8 - 8 * Math.cos(t)], axis: [0, 1, 0], deg: 6, over: 5, ease: "linear" }]); }
	const bike = { frames: 90, characters: [{ id: "rider", at: [0, -0.1], heading: 0 }], props: [{ id: "bike", size: [0.5, 0.9, 1.6], at: [0, 0.45, 0], moves: true }] };
	const sat = buildClip({ rider: [[0, "sit", { on: "bike", height: 0.75, over: 0 }]], bike: bikeKeys }, bike);
	assert.ok(validateClip(sat.clip).ok, "valid clip");
	const r = report(sat.clip, "rider", "bike", 0, 90), bikeStep = Math.max(...steps(propOf(sat.clip, "bike"), 1, 90));
	assert.ok(r.drift < 1e-4, `sit on a keyed bike that turns: the hips keep their place on it (drift ${r.drift} m)`);
	assert.ok(r.step < bikeStep * 1.3, `the hips step no more than the bike carries them (${r.step} vs ${bikeStep} m)`);
	assert.ok(Math.abs(hips(sat.clip.characters[0], 0)[1] - 0.88) < 0.01, "sit {on, height}: at that height");
	assert.ok(sat.aux.contacts.rider.every(([l, rr]) => !l && !rr), "a body on a moving prop does not stand on the floor (no foot-slide contact)");
	// getting off: stand on it, then walk off in the world
	const off = buildClip({ rider: [[0, "sit", { on: "bike", over: 0 }], [72, "stand", { on: "bike", over: 10 }], [82, "walk", { to: [5, 3] }]], bike: bikeKeys }, { ...bike, frames: 140 }).clip;
	const o = report(off, "rider", "bike", 0, 72);
	assert.ok(o.drift < 1e-4 && o.step < 0.25, `get off: on the bike until the stand, then on from there (drift ${o.drift}, largest hips step ${o.step} m)`);
	assert.ok(dist(hips(off.characters[0], 139), [5, hips(off.characters[0], 139)[1], 3]) < 0.25, "the walk off reaches its world `to`");
	// walking on a moving deck, and getting on a deck that has moved away from its scene place
	const deck = { frames: 120, characters: [{ id: "a", at: [-1, 0], heading: 90 }], props: [{ id: "deck", size: [4, 0.2, 2], at: [0, 0.1, 0], moves: true }] };
	const walk = buildClip({ a: [[0, "idle", { on: "deck" }], [20, "walk", { to: [1.2, 0], on: "deck" }], [70, "idle", { on: "deck" }]], deck: [[0, "move", { to: [6, 0.1, 0], over: 120, ease: "linear" }]] }, deck).clip;
	const w = report(walk, "a", "deck", 0, 20), end = inFrame(propOf(walk, "deck"), 119, hips(walk.characters[0], 119));
	assert.ok(w.drift < 2e-3, `idle on a moving deck: keeps its place on it (${w.drift} m)`);
	assert.ok(Math.abs(end[0] - 1.2 - 0.1) < 0.2 && Math.abs(end[2]) < 0.1, `walk {to, on}: ends at that place of the deck as the scene puts it (${end.map(v => v.toFixed(2))})`);
	const moved = buildClip({ a: [[0, "walk", { to: [3, 0] }], [50, "idle", { on: "deck" }]], deck: [[0, "move", { to: [4, 0.1, 0], over: 40 }], [60, "move", { to: [8, 0.1, 2], over: 60 }]] }, deck).clip;
	const m = report(moved, "a", "deck", 50, 120);
	assert.ok(m.drift < 3e-3 && dist(hips(moved.characters[0], 50), hips(moved.characters[0], 49)) < 0.05, `get on a deck that moved: goes on from where it stands, then with the deck (${m.drift} m)`);
	// on a prop another body carries, and a body of scale 0.8
	const held = { frames: 100, characters: [{ id: "a", at: [0, 0], heading: 0, scale: 0.8 }, { id: "b", at: [0, 0.8], heading: 180 }], props: [{ id: "board", size: [0.6, 0.1, 1.2], at: [0, 0.6, 0.4], moves: true }] };
	const carried = buildClip({ a: [[0, "sit", { on: "board", over: 0 }]], b: [[0, "carry", { prop: "board" }], [10, "walk", { to: [0, 3] }]] }, held);
	const h = report(carried.clip, "a", "board", 0, 100);
	assert.ok(h.drift < 1e-4 && dist(at(propOf(carried.clip, "board"), 99), at(propOf(carried.clip, "board"), 0)) > 2, `on a prop another body carries, at scale 0.8: with it (${h.drift} m)`);
	assert.equal(carried.aux.carried, undefined, "the board's track is the one the body followed");
	// on a still prop, and with no on: exactly as before (one build)
	const chair = { frames: 60, characters: [{ id: "a", at: [0, 0.6], heading: 180 }], props: [{ id: "chair", size: [0.45, 0.45, 0.45], at: [0, 0.225, 0.3] }] };
	assert.equal(serializeClip(buildClip({ a: [[0, "sit", { on: "chair", over: 20 }]] }, chair).clip), serializeClip(buildClip({ a: [[0, "sit", { on: "chair", over: 20 }]] }, { ...chair, props: [{ ...chair.props[0], moves: false }] }).clip), "on a prop that does not move: the same clip");
}

// --- 3. hide / show ---
{
	const F = 48, def = { frames: F, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [
		{ id: "puff", size: [0.2, 0.2, 0.2], at: [0, 0.1, 1.2], shape: "sphere" },
		{ id: "box", size: [0.3, 0.3, 0.3], at: [1, 0.15, 0], moves: true },
		{ id: "badge", size: [0.06, 0.06, 0.02], at: [0, 1.4, 0.2], moves: true },
		{ id: "wall", size: [0.2, 1.4, 1.2], at: [0, 0.7, 0] }] };
	const spec = { a: [[0, "walk", { to: [0, 1.5] }]], puff: [[0, "hide"], [20, "show"], [30, "hide"]], box: [[0, "move", { to: [2, 0.15, 0], over: 40 }], [10, "hide"], [12, "show"]], badge: [[0, "ride", { joint: "Head", of: "a" }], [24, "hide"]] };
	const { clip, aux } = buildClip(spec, def);
	const shown = id => Array.from(propOf(clip, id).shown).join("");
	assert.equal(shown("puff"), "0".repeat(20) + "1".repeat(10) + "0".repeat(18), "hidden, shown from 20, hidden again from 30");
	assert.equal(shown("box"), "1".repeat(10) + "00" + "1".repeat(36), "drawn until a hide");
	assert.equal(propOf(clip, "wall").shown, undefined, "a prop with no hide / show key has no shown");
	assert.ok(dist(at(propOf(clip, "box"), 40), [2, 0.15, 0]) < 1e-6 && aux.keyed.box.slice(0, 40).every(Boolean), "a hide key does not stop the prop's move");
	assert.ok(validateClip(clip).ok && JSON.parse(serializeClip(clip)).props.find(p => p.id === "puff").shown.length === F, "shown is kept in the clip file");
	assert.ok(!validateClip({ ...clip, props: clip.props.map(p => p.id === "puff" ? { ...p, shown: [1, 0] } : p) }).ok, "a shown of the wrong length is refused");
	// the writer's inside rows leave a hidden prop out: the puff hidden inside the wall, then shown there
	const puffIn = { ...def, props: def.props.map(p => p.id === "puff" ? { ...p, at: [0, 0.7, 0], moves: true } : p) };
	const wallRows = s => insideRows(buildClip(s, puffIn).clip, buildClip(s, puffIn).aux, { def: puffIn, spec: s, look: "block" }).filter(r => r.part === "puff" && r.prop === "wall");
	assert.equal(wallRows({ puff: [[0, "hide"]] }).length, 0, "a prop hidden on every frame is not told inside another");
	assert.equal(wallRows({ puff: [[0, "hide"], [30, "show"]] })[0]?.frames, F - 30, "it is told on the frames it is shown");
	// install: vis tracks the Studio reads
	const parsed = JSON.parse(serializeClip(clip)), raws = {}, sk = skeletonFor(TRACK_RIG);
	let n = 0;
	const out = await installClip(parsed, async (action, args) => {
		if (action === "motion.v4.install") raws[args.characterId] = args.raw;
		return { affectedIds: [action === "character.add" ? args.character.id : action === "object.attach" ? args.objectId : `obj-${++n}`] };
	});
	assert.equal(out.ok, true);
	const raw = decodeRawTrack(Object.values(raws)[0], sk), id = name => out.placed[name];
	assert.deepEqual(Object.keys(raw.objects[id("puff")]), ["vis"], "a still prop it hides: a vis track alone");
	assert.deepEqual(Object.keys(raw.objects[id("box")]).sort(), ["pos", "quat", "vis"], "a moving prop it hides: its track with vis");
	assert.ok(out.attached?.some(e => e.id === id("badge")) && Object.keys(raw.objects[id("badge")]).join() === "vis", "a prop attached to a bone: attached, with a vis track alone");
	assert.equal(raw.objects[id("wall")], undefined, "a still prop it never hides: no track");
	assert.deepEqual(out.moving, [id("box")], "moving names only what a track moves");
	assert.deepEqual(encodeRawTrack(raw).objects, Object.values(raws)[0].objects, "the codec reads back what it wrote");
	const take = placedTake(raw, { position: [0, 0, 0], yaw: 0 }), cast = [{ id: "c" }], tracks = objectTracksOf({ motionFor: () => take }, cast);
	const studio = { objectTracks: tracks };
	assert.deepEqual([5, 25, 35].map(f => trackShown(id("puff"), f, studio)), [false, true, false], "the Studio hides the still prop on the frames the clip does");
	assert.deepEqual([9, 11, 13].map(f => trackShown(id("box"), f, studio)), [true, false, true], "and the moving one");
	assert.deepEqual([20, 30].map(f => trackShown(id("badge"), f, studio)), [true, false], "and the attached one");
	const slow = renderTakeEdit({ ...take, edit: setSegmentSpeed(createTakeEdit(F), "motion-0", 0.5) });
	assert.equal(trackShown(id("puff"), 50, { objectTracks: objectTracksOf({ motionFor: () => slow }, cast) }), true, "a timing edit retimes the vis track (frame 50 at half speed is the clip's 25)");
	assert.ok(raw.objects[id("puff")].vis && !raw.objects[id("puff")].pos && !take.objects[id("puff")].world, "a vis-only track moves nothing (no world flag)");
}

// --- 4. the manual says the new words ---
{
	const spec = specFormat();
	assert.match(spec, /on: propId, on any body action: done on that prop, going with it where the prop moves/, "SPEC: on for any body action");
	assert.match(spec, /a key starts\n {6}where the key before it has the prop on its frame/, "SPEC: where a prop key starts");
	assert.match(spec, /hide \| show {3}from this frame the prop is not drawn/, "SPEC: hide / show");
	assert.match(systemPrompt("studio"), /sit \{height\}[^\n]*with on as well, at that height on that prop\./, "studio: a sit's height on a prop");
}
console.log("ok body carry: prop keys start where the key before has the prop; a body on a moving prop goes with it; hide / show reach the Studio");
