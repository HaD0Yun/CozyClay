#!/usr/bin/env node
// Three widenings of the simple engine's prop layer and the body layer, each pinned without wall time:
// 1. A move or tip key starts where the key before it has the prop on its frame: a prop keyed key after key never stands
//    still for a frame between two keys (before: the key's first frame repeated the frame before, so every key stopped
//    the prop, and what rode it, for one frame); a key cut into goes on from where the one before has it; a key after a
//    gap starts from the target before as it did; over 0 is there at once. A key that takes over from a ride starts
//    where the ride has the prop on the key's frame (the prop does not fall behind its carrier for a frame); of keys
//    written on one frame the last drives, and starts as any other. Hands that take a prop a chain of keys moves get
//    the clip one key of the same path gives.
// 2. A body-layer action with `on: propId` is done on that prop and goes with it: the Hips joint keeps its place in the
//    prop's frame on every frame while the prop is keyed (moved and turned), carried by another body's hands, or ridden;
//    walking on it, getting on after it moved and getting off keep the body where it is, also where the prop has risen
//    or lies tipped by then (the body goes to its place over half a second, no jump); a sit's height with on; a body
//    of another scale; `on` a prop that does not move and a spec with no `on` build exactly as before; the tool says
//    when a prop's own track depends on the body on it (that body's hands move it), by how far.
// 3. hide / show keys: the clip's per-frame `shown`, kept apart from the motion keys (a prop only shown or hidden is not a
//    mover); the install writes a vis track (with the track of a moving prop, alone for a still one and for one attached
//    to a bone) that the Studio's trackShown reads, through the raw-track codec, the placed take and a timing edit;
//    the writer's inside rows and contact sheets leave a hidden prop out on the frames it is hidden.
// Every scene here is made up for this test.
import "./block-figure.mjs"; // the block figure's numbers (figure.js: the launch names the look)
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
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
	// a key that takes over from a ride: on its own frame the prop is still where the ride has it, so it does not fall
	// behind a carrier that moves on (before: it stood still for that frame and was a cart's step behind for the key's length)
	const cartKeys = []; for (let f = 10, x = 0; f < 50; f += 5) { x += 1; cartKeys.push([f, "move", { to: [x, 0.25, 0], over: 5, ease: "linear" }]); }
	const off = buildClip({ cart: cartKeys, crate: [[0, "ride", { on: "cart" }], [30, "move", { to: [5, 0.65, 0], over: 5, ease: "linear" }], [35, "move", { to: [6, 0.65, 0], over: 5, ease: "linear" }]] }, def).clip;
	const lag = f => at(propOf(off, "cart"), f)[0] - at(propOf(off, "crate"), f)[0];
	assert.ok([29, 30, 31, 33, 35, 39].every(f => Math.abs(lag(f)) < 1e-5), `a key after a ride: the crate stays over the cart as its own keys take it on (${[29, 30, 31, 35].map(f => lag(f).toFixed(3))})`);
	assert.deepEqual(off.props.find(p => p.id === "crate").by.slice(29, 32), [["cart"], ["cart"], []], "the ride carries it on the key's frame, the key from the next");
	const jump = buildClip({ cart: cartKeys, crate: [[0, "ride", { on: "cart" }], [30, "move", { to: [0, 0.65, 2], over: 0 }]] }, def).clip;
	assert.ok(dist(at(propOf(jump, "crate"), 30), [0, 0.65, 2]) < 1e-6, "a key with over 0 after a ride is there at once");
	// keys written on one frame: the last drives, and starts where the key before has the prop
	const twice = buildClip({ cart: [[10, "move", { to: [1, 0.25, 0], over: 10, ease: "linear" }], [20, "move", { to: [9, 0.25, 9], over: 10 }], [20, "move", { to: [2, 0.25, 0], over: 10, ease: "linear" }], [30, "move", { to: [3, 0.25, 0], over: 10, ease: "linear" }]] }, def).clip;
	assert.ok(steps(propOf(twice, "cart"), 11, 40).every(d => Math.abs(d - 0.1) < 1e-5), "two keys on one frame in a chain: no frame stands still");
	// hands take a prop that a chain of keys moves: the clip is the one a single key of the same path gives
	const reach = keys => buildClip({ a: [[0, "idle"], [30, "hold", { prop: "crate", hand: "both", at: { L: [-0.2, 0, 0], R: [0.2, 0, 0] }, over: 10 }], [41, "pose", { L: [0.2, 0.1, 0.4], R: [-0.2, 0.1, 0.4], over: 10 }]], crate: keys }, { ...def, characters: [{ id: "a", at: [0.6, -0.55], heading: 0 }] });
	const chain = []; for (let f = 12; f < 52; f += 5) chain.push([f, "move", { to: [0.02 * (f + 5 - 12), 0.65, 0], over: 5, ease: "linear" }]);
	const many = reach(chain), single = reach([[12, "move", { to: [0.8, 0.65, 0], over: 40, ease: "linear" }]]);
	const apart = Math.max(...Array.from({ length: 70 }, (_, f) => Math.max(dist(at(propOf(many.clip, "crate"), f), at(propOf(single.clip, "crate"), f)), dist(v3(many.clip.characters[0].pos, f * 17 + INDEX.LeftHand), v3(single.clip.characters[0].pos, f * 17 + INDEX.LeftHand)))));
	assert.ok(apart < 1e-5 && many.aux.holders.crate[40] && dist(at(propOf(many.clip, "crate"), 39), [0.54, 0.65, 0]) < 1e-5, `hands that take a prop keyed key after key: as with one key of that path (${apart} m apart)`);
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
	// getting on and off a prop that has risen, or lies tipped, by then: no jump; half a second later the body is on it
	const most = (clip, from = 1, to = clip.frameCount) => { let m = 0; for (let f = from; f < to; f++) m = Math.max(m, dist(hips(clip.characters[0], f), hips(clip.characters[0], f - 1))); return m; };
	const lift = { frames: 160, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ id: "lift", size: [2, 0.1, 2], at: [0, 0.05, 0], moves: true }] };
	const risen = buildClip({ a: [[0, "idle"], [50, "idle", { on: "lift" }], [100, "walk", { to: [0, 1.5] }]], lift: [[10, "move", { to: [0, 0.65, 0], over: 30 }]] }, lift).clip, y = f => hips(risen.characters[0], f)[1];
	assert.ok(most(risen) < 0.1 && Math.abs(y(50) - y(49)) < 0.01 && Math.abs(y(62) - y(49) - 0.6) < 1e-3 && Math.abs(y(99) - y(62)) < 0.01 && Math.abs(y(100) - y(99)) < 0.02 && Math.abs(y(130) - y(49)) < 0.05,
		`on a lift that rose 0.6 m, and off it: the hips go up and down over half a second (largest step ${most(risen)} m; y ${[49, 50, 62, 99, 100, 130].map(f => y(f).toFixed(3))})`);
	const tipped = buildClip({ a: [[0, "idle"], [50, "walk", { to: [0, 0.6], on: "lift" }], [110, "sit", { height: 0.4, on: "lift" }]], lift: [[10, "tip", { pivot: [0, 0, 0], axis: [1, 0, 0], deg: 20, over: 30 }]] }, lift).clip;
	assert.ok(most(tipped) < 0.07, `on a prop that lies tipped: no jump (largest hips step ${most(tipped)} m)`);
	const twiceOn = buildClip({ a: [[0, "idle"], [50, "idle", { on: "lift" }], [54, "idle"], [58, "idle", { on: "lift" }]], lift: [[10, "move", { to: [0, 0.65, 0], axis: [0, 1, 0], deg: 40, over: 30 }]] }, lift).clip;
	assert.ok(most(twiceOn) < 0.08 && Math.abs(hips(twiceOn.characters[0], 80)[1] - hips(twiceOn.characters[0], 49)[1] - 0.6) < 1e-3, `on, off and on again before the first has settled: no jump (${most(twiceOn)} m)`);
	// a prop whose own track depends on the body on it (its hands move it): the tool says by how far the two differ
	const dir = join(tmpdir(), `lowvis-carry-${process.pid}`), seat = { frames: 80, characters: [{ id: "a", at: [0, 0.75], heading: 180 }], props: [{ id: "box", size: [0.45, 0.45, 0.45], at: [0, 0.225, 0.3], moves: true }] };
	const told = spec => createCompileTool({ name: "carry", outDir: dir, clipFile: join(dir, "clip.json"), variant: "studio" }).call({ scene: seat, spec }).text.split("\n").filter(l => l.startsWith("carried:"));
	const own = told({ a: [[0, "sit", { on: "box", over: 0 }], [20, "hold", { prop: "box", hand: "both", at: { L: [-0.26, 0.1, 0], R: [0.26, 0.1, 0] }, over: 10 }], [40, "pose", { L: [0.3, -0.5, 0.15], R: [-0.3, -0.5, 0.15], over: 20 }]] });
	const pushed = buildClip({ a: [[0, "sit", { on: "box", over: 0 }], [20, "hold", { prop: "box", hand: "both", at: { L: [-0.26, 0.1, 0], R: [0.26, 0.1, 0] }, over: 10 }], [40, "pose", { L: [0.3, -0.5, 0.15], R: [-0.3, -0.5, 0.15], over: 20 }]] }, seat).aux.carried;
	assert.ok(pushed?.box > 0.05 && own.length === 1 && own[0].startsWith(`carried: box ends up to ${Math.round(pushed.box * 1000)} mm from where the body on it followed it`), `a body whose hands move the prop it is on: told (${own[0]})`);
	assert.deepEqual(told({ a: [[0, "sit", { on: "box", over: 0 }]], box: [[10, "move", { to: [0, 0.225, 2], over: 40 }]] }), [], "a prop that moves by itself under a body: no such line");
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
	assert.match(spec, /on: propId, on any body action: the body goes with that prop however it is moved \(moves: true\)/, "SPEC: on for any body action");
	assert.match(spec, /a key starts\n {6}where the key or the ride before it has the prop on its frame/, "SPEC: where a prop key starts");
	assert.match(spec, /hide \| show {3}from this frame the prop is not drawn/, "SPEC: hide / show");
	assert.match(systemPrompt("studio"), /sit \{height\}[^\n]*with on as well: at that height instead of the prop's top\./, "studio: a sit's height on a prop");
}
console.log("ok body carry: prop keys start where the key before has the prop; a body on a moving prop goes with it; hide / show reach the Studio");
