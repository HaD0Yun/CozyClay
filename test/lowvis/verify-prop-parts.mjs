#!/usr/bin/env node
// A prop's drawn parts: what the Studio measures of a drawn object (src/lowvis/studio/tops.js objectParts, parts.js),
// what the motion tool sets on the writer's scene (src/lowvis/pi/shapes.mjs), the words that aim a hand, a foot, a hold,
// a ride and a seat at a part (src/lowvis/engine-simple/parts.js), a body standing on the drawn tops, and the rows that
// tell the gaps to the parts and the depth inside them (src/lowvis/pi/gaps.mjs, inside.mjs). Every scene here is made up
// for this test; no object kind or part name has a word of its own.
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { partBoxes, partDistance, resolveParts } from "../../src/lowvis/engine-simple/parts.js";
import { SEAT_UP } from "../../src/lowvis/engine-simple/posture.js";
import { MAX_PARTS, mergeParts, propParts } from "../../src/lowvis/studio/parts.js";
import { objectParts } from "../../src/lowvis/studio/tops.js";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { gapRows } from "../../src/lowvis/pi/gaps.mjs";
import { insideRows } from "../../src/lowvis/pi/inside.mjs";
import { INDEX as J } from "../../src/lowvis/rig17.js";
import { add, qConj, qRotate } from "../../src/lowvis/engine-simple/math.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

const near = (a, b, tol, what) => [].concat(a).forEach((v, i) => assert.ok(Math.abs(v - [].concat(b)[i]) <= tol, `${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`));
const joint = (clip, id, f, j) => { const c = clip.characters.find(x => x.id === id), i = (f * 17 + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const propAt = (clip, id, f) => { const p = clip.props.find(x => x.id === id), i = p.pos.length === 3 ? 0 : f; return { c: Array.from(p.pos.slice(i * 3, i * 3 + 3)), q: Array.from(p.quat.slice(i * 4, i * 4 + 4)) }; };
const inProp = (clip, id, f, v) => { const { c, q } = propAt(clip, id, f); return qRotate(qConj(q), [v[0] - c[0], v[1] - c[1], v[2] - c[2]]); };
const build = (def, spec) => buildClip(structuredClone({ ...spec, demo: "parts" }), structuredClone(def));

// A made-up vehicle: a box mostly air, its drawn shape six parts (a deck plate, a thin bar turned 20 degrees about Z, two
// pegs, a hollow tub of four walls, a mast that stands off the top of the box).
const BOX = [2, 1, 0.8];
const PARTS = [
	{ name: "deck", at: [0, -0.3, 0], size: [1.6, 0.04, 0.6] },
	{ name: "bar", at: [0.45, 0.25, 0], size: [0.03, 0.03, 0.6], turn: [0, 0, 20] },
	{ name: "pegL", at: [0.1, -0.4, 0.33], size: [0.08, 0.02, 0.08] },
	{ name: "pegR", at: [0.1, -0.4, -0.33], size: [0.08, 0.02, 0.08] },
	{ name: "tubFront+tubBack", at: [-0.5, -0.1, 0], size: [0.6, 0.4, 0.6] },
	{ name: "mast", at: [-0.9, 0.6, 0], size: [0.05, 0.6, 0.05] },
];
const cart = extra => ({ id: "cart", size: BOX, at: [0, 0.5, 0], parts: PARTS, ...extra });

// --- the Studio side: measured parts, merged, as a prop's ---
{
	// 40 boxes merge down to MAX_PARTS; every box lies inside the part it went into; the JSON stays small
	const forty = Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, at: [Math.sin(i) * 0.8, 0.3 + (i % 7) * 0.1, Math.cos(i * 1.3) * 0.4], size: [0.05 + (i % 5) * 0.03, 0.02 + (i % 3) * 0.04, 0.04] }));
	const merged = mergeParts(forty);
	assert.equal(merged.length, MAX_PARTS, "40 parts are told as MAX_PARTS");
	for (const b of forty) {
		const home = merged.find(m => m.name.split("+").includes(b.name));
		assert.ok(home, `${b.name} is in a merged part`);
		[0, 1, 2].forEach(k => assert.ok(Math.abs(b.at[k] - home.at[k]) + b.size[k] / 2 <= home.size[k] / 2 + 0.0011, `${b.name} inside ${home.name} along ${k}`));
	}
	const chars = JSON.stringify(merged).length;
	assert.ok(chars < 2500, `40 parts in ${chars} characters`);
	console.log(`ok mergeParts: 40 parts -> ${merged.length}, ${chars} characters of JSON; each part inside its merged box`);
	// a part turned a quarter about Y is told square, its sides in order; five parts stay five
	assert.deepEqual(mergeParts([{ name: "a", at: [0, 0, 0], size: [1, 0.2, 0.1], turn: [0, 90, 0] }]), [{ name: "a", at: [0, 0, 0], size: [0.1, 0.2, 1] }]);
	assert.equal(mergeParts(PARTS.slice(0, 5)).length, 5);
	// one part that is the box adds nothing; one off the box is kept; a turned prop square to the world gives none
	assert.equal(propParts([{ name: "box", at: [0, 0.5, 0], size: [1, 1, 1] }], { size: [1, 1, 1] }), null, "a stand-in is its box");
	const off = propParts([{ name: "body", at: [0, 0.5, 0], size: [1, 1, 1] }, { name: "flag", at: [0, 1.6, 0], size: [0.02, 0.4, 0.3] }], { size: [1, 1, 1] });
	near(off.centre[1].at, [0, 1.1, 0], 1e-9, "a part over the box, from its centre");
	assert.equal(propParts(PARTS, { size: BOX, own: false, yaw: 30 }), null, "square to the world at 30 degrees: no parts");
	console.log("ok propParts: a box is its own shape, a part off the box stays, no parts for a turned square box");
}
{
	// what the Studio draws: a seat box and a bar (a capsule turned to lie along X), the object placed, turned and scaled
	const group = new THREE.Group();
	const seat = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.3)); seat.position.set(-0.2, 0.6, 0); seat.userData.sculptPart = "seat";
	const bar = new THREE.Mesh(new THREE.CapsuleGeometry(0.015, 0.6, 4, 8)); bar.position.set(0.6, 0.9, 0); bar.rotation.z = Math.PI / 2; bar.name = "bar";
	const tilted = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 0.04)); tilted.position.set(0.5, 0.5, 0); tilted.rotation.z = 0.35;
	group.add(seat, bar, tilted);
	group.position.set(2, 0, 1); group.rotation.y = Math.PI / 6; group.scale.setScalar(1.5);
	const parts = objectParts(group);
	assert.deepEqual(parts.map(b => b.name), ["seat", "bar", "part"]);
	near(parts[0].at, [-0.3, 0.9, 0], 1e-6, "the seat in the object's own frame, its scale applied");
	near(parts[0].size, [0.9, 0.15, 0.45], 1e-6, "the seat's sides");
	near(parts[1].size, [0.945, 0.045, 0.045], 1e-3, "the bar along X: told square, sides in the frame's order");
	assert.equal(parts[1].turn, undefined);
	near(parts[2].turn, [0, 0, 20.1], 0.05, "a strut that leans keeps its turn");
	assert.deepEqual(objectParts(null), []);
	console.log(`ok objectParts: ${JSON.stringify(parts)}`);
}

// --- the words ---
{
	// two hands on the bar, a foot on a peg, the seat on the deck, on a cart that moves and turns; both bodies at scales 0.5 and 3
	for (const s of [1, 0.5, 3]) {
		const def = { frames: 60, characters: [{ id: "a", at: [0.3, 0], heading: 90, ...(s === 1 ? {} : { scale: s }) }], props: [cart({ moves: true })] };
		const spec = {
			a: [[0, "sit", { on: "cart", part: "deck", over: 0 }], [0, "idle", { on: "cart" }],
				[0, "pose", { L: { on: "cart", part: "bar", at: [0, 0, 0.25] }, R: { on: "cart", part: "bar", at: [0, 0, -0.25] }, footL: { on: "cart", part: "pegL", at: [0, 0.08, 0] }, over: 10 }]],
			cart: [[10, "move", { to: [1.5, 0.5, 0.5], axis: [0, 1, 0], deg: 40, over: 40 }]],
		};
		const { clip, aux } = build(def, spec), boxes = partBoxes(cart()), f = 55;
		const hips = inProp(clip, "cart", f, joint(clip, "a", f, J.Hips)), deck = boxes[0];
		near(hips[1], deck.c[1] + deck.h[1] + SEAT_UP * s, 0.002, `scale ${s}: the Hips over the deck's top by the seat height`);
		for (const [i, place] of [[0, [0, 0, 0.25]], [1, [0, 0, -0.25]]]) {
			const e = aux.reach.a[f][i], at = inProp(clip, "cart", f, e.t);
			assert.equal(e.on, "cart");
			assert.ok(partDistance(boxes[1], at) <= 1e-6, `scale ${s}: hand ${i}'s target lies in the bar`);
			near(at[2], place[2], 1e-6, "at the place asked along the bar");
			if (s === 1) assert.ok(e.d < 0.03, `the hand reaches the bar (${e.d})`);
		}
		const foot = inProp(clip, "cart", f, joint(clip, "a", f, J.LeftFoot));
		if (s === 1) near(foot, add(boxes[2].c, [0, 0.08, 0]), 0.005, "the left ankle 8 cm over the peg");
		const rows = gapRows(clip, aux, { def, spec });
		console.log(`ok scale ${s}: seat on the deck, hands on the bar, foot on the peg of a moving, turning cart; gap rows: ${rows.map(r => `${r.limb} ${r.value.toFixed(0)}`).join(", ") || "none"}`);
		if (s === 1) assert.deepEqual(rows, [], "nothing off the drawn parts at scale 1");
	}
}
{
	// sit {on} with parts: on the highest drawn top under the hips (the tub, not the box top); without parts, the box top
	const def = { frames: 30, characters: [{ id: "a", at: [-0.2, 0], heading: 90 }], props: [cart()] };
	const spec = { a: [[0, "sit", { on: "cart", over: 0 }]] };
	const drawn = joint(build(def, spec).clip, "a", 20, J.Hips)[1], plain = joint(build({ ...def, props: [cart({ parts: undefined })] }, spec).clip, "a", 20, J.Hips)[1];
	near(drawn, 0.5 + 0.1 + SEAT_UP, 0.002, "the tub's top under the hips");
	assert.ok(plain - drawn > 0.25, `without parts: toward the box top, as before (the solver lowers the hips until the feet reach: ${plain})`);
	// a body on the cart stands on the deck (the drawn top under its feet), over 0.5 m up at most per step
	const stand = build({ frames: 30, characters: [{ id: "b", at: [0.3, 0], heading: 0 }], props: [cart()] }, { b: [[0, "idle", { on: "cart" }]] }).clip;
	const ankle = joint(stand, "b", 20, J.LeftFoot)[1], floor = joint(build({ frames: 30, characters: [{ id: "b", at: [0.3, 0], heading: 0 }], props: [cart({ parts: undefined })] }, { b: [[0, "idle", { on: "cart" }]] }).clip, "b", 20, J.LeftFoot)[1];
	near(ankle - floor, 0.5 - 0.3 + 0.02, 0.002, "the feet stand on the deck top, not on the floor");
	console.log(`ok seat and stand on the drawn tops: hips ${drawn.toFixed(3)} (box top: ${plain.toFixed(3)}), ankle ${floor.toFixed(3)} -> ${ankle.toFixed(3)}`);
}
{
	// a hold at a part and a ride on a part; a prop with parts riding a joint, a hand of another body on its part
	const def = { frames: 40, characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [0.8, 0.5], heading: -90 }],
		props: [{ id: "bag", size: [0.4, 0.3, 0.2], at: [0.3, 0.8, 0.3], moves: true, parts: [{ name: "body", at: [0, -0.05, 0], size: [0.4, 0.2, 0.2] }, { name: "handle", at: [0, 0.12, 0], size: [0.2, 0.02, 0.02] }] }, { id: "tag", size: [0.05, 0.05, 0.01], at: [0, 0, 0], moves: true }] };
	const spec = { a: [[0, "hold", { prop: "bag", hand: "R", at: { part: "handle" }, over: 8 }]], b: [[12, "pose", { L: { on: "bag", part: "handle", at: [-0.08, 0, 0] }, over: 8 }]], tag: [[0, "ride", { on: "bag", part: "body", at: [0, 0, 0.12] }]] };
	const { clip, aux } = build(def, spec), boxes = partBoxes(def.props[0]), f = 30;
	const wrist = inProp(clip, "bag", f, joint(clip, "a", f, J.RightHand));
	assert.ok(partDistance(boxes[1], wrist) < 0.035, `the holding hand at the handle (${partDistance(boxes[1], wrist).toFixed(3)} m)`);
	near(inProp(clip, "bag", f, propAt(clip, "tag", f).c), [0, -0.05, 0.12], 1e-6, "the tag rides at its place from the body part's centre");
	assert.ok(partDistance(boxes[1], inProp(clip, "bag", f, aux.reach.b[f][0].t)) <= 1e-9, "b's hand target on the handle, as the bag moves in a's hand");
	console.log("ok hold at a part, ride on a part, a hand of another body on a carried prop's part");
}
{
	// a part that is not there, a prop with none, a part with no prop: refusals that say what there is
	const def = { frames: 10, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [cart(), { id: "crate", size: [0.5, 0.5, 0.5], at: [1, 0.25, 0] }] };
	assert.throws(() => resolveParts({ a: [[0, "pose", { R: { on: "cart", part: "wheel" } }]] }, def), /cart has no part "wheel"; its parts: deck, bar, pegL, pegR, tubFront\+tubBack, mast/);
	assert.throws(() => resolveParts({ a: [[0, "pose", { R: { on: "crate", part: "lid" } }]] }, def), /crate has no parts/);
	assert.throws(() => resolveParts({ a: [[0, "pose", { R: { part: "deck" } }]] }, def), /\{part\} wants on: propId/);
	assert.throws(() => resolveParts({ a: [[0, "sit", { on: "cart", part: "roof" }]] }, def), /cart has no part "roof"/);
	near(resolveParts({ a: [[0, "pose", { R: { on: "cart", part: "tubBack", at: [0, 0.25, 0] } }]] }, def).a[0][2].R.at, [-0.5, 0.15, 0], 1e-9, "one name of a merged part names it; at from its centre");
	console.log("ok refusals: no such part (with the parts there are), a prop with no parts, a part with no prop");
}
{
	// no part words: a scene with parts and a spec that does not use them is the clip of the scene without them; hidden too
	const def = { frames: 40, characters: [{ id: "a", at: [1.5, 0], heading: -90 }], props: [cart({ moves: true })] };
	const spec = { a: [[0, "walk", { to: [1.2, 0] }], [20, "pose", { R: { on: "cart", at: [1, 0.2, 0] }, over: 10 }]], cart: [[5, "hide"], [25, "show"]] };
	const a = build(def, spec).clip, b = build({ ...def, props: [cart({ moves: true, parts: undefined })] }, spec).clip;
	assert.deepEqual([Array.from(a.characters[0].pos), Array.from(a.props[0].pos)], [Array.from(b.characters[0].pos), Array.from(b.props[0].pos)], "the same clip");
	console.log("ok parts that no word uses change nothing of the clip");
}

// --- the rows ---
{
	// a hand on the box's top far from any part, a seat over the tub, legs through the box's air: told against the parts
	const def = { frames: 40, characters: [{ id: "a", at: [-0.2, 0], heading: 90 }], props: [cart()] };
	const spec = { a: [[0, "sit", { over: 0, height: 0.9 }], [0, "pose", { R: { on: "cart", at: [0.3, 0.5, -0.25] }, over: 8 }]] };
	const { clip, aux } = build(def, spec), rows = gapRows(clip, aux, { def, spec });
	const hand = rows.find(r => r.limb === "R hand");
	assert.ok(hand && hand.part === "bar", `the right hand is told off the drawn cart, nearest the bar: ${JSON.stringify(hand)}`);
	// the told gap is the nearest of the hand's points to the parts: checked here against the wrist alone (an upper bound)
	const wrist = inProp(clip, "cart", hand.frame, joint(clip, "a", hand.frame, J.RightHand)), bound = Math.min(...partBoxes(cart()).map(b => Math.max(0, partDistance(b, wrist)))) * 1000;
	assert.ok(hand.value <= bound + 1e-6 && hand.value > 30, `told ${hand.value.toFixed(1)} mm, wrist ${bound.toFixed(1)} mm`);
	assert.ok(!rows.some(r => r.limb === "seat"), "no seat row: a sit {height} on no prop is no seat on the cart");
	const seated = { a: [[0, "sit", { on: "cart", over: 0 }], [0, "pose", { hip: [0, 0.2, 0], over: 0 }]] };
	const s2 = build(def, seated), seat = gapRows(s2.clip, s2.aux, { def, spec: seated }).find(r => r.limb === "seat");
	near(seat?.value ?? 0, 200, 5, `the seat raised 0.2 m by hip floats 200 mm over the tub (${seat?.value})`);
	// inside: a body standing in the box's air past the end of the deck is told against the box, not against the parts;
	// one whose legs go through the deck is told against both
	for (const [x, both] of [[0.93, false], [0.5, true]]) {
		const still = { frames: 12, characters: [{ id: "b", at: [x, 0], heading: 0 }], props: [cart()] }, plain = { ...still, props: [cart({ parts: undefined })] }, c3 = build(still, {});
		const boxed = insideRows(c3.clip, c3.aux, { def: plain, spec: {}, look: null }), parted = insideRows(c3.clip, c3.aux, { def: still, spec: {}, look: null });
		assert.ok(boxed.some(r => r.who === "b"), `b at x ${x} is inside the box`);
		assert.equal(parted.some(r => r.who === "b"), both, `b at x ${x} ${both ? "is" : "is not"} inside the drawn parts: ${JSON.stringify(parted)}`);
	}
	console.log(`ok gap rows: hand ${hand.value.toFixed(0)} mm off nearest ${hand.part}; seat ${seat.value.toFixed(0)} mm over the tub; inside rows read the parts`);
}

// --- the motion tool ---
{
	const dir = mkdtempSync(join(tmpdir(), "lowvis-parts-"));
	const base = PARTS.map(b => ({ ...b, at: [b.at[0], b.at[1] + 0.5, b.at[2]] })), shapes = { cart: { h: 1, parts: base } };
	const tool = createCompileTool({ name: "parts", outDir: dir, clipFile: join(dir, "clip.json"), variant: "studio", shapes });
	const scene = { frames: 24, characters: [{ id: "a", at: [-0.3, 0], heading: 90 }], props: [{ id: "cart", size: BOX, at: [0, 0.5, 0] }] };
	const r1 = tool.call({ scene, spec: { a: [[0, "sit", { on: "cart", part: "deck", over: 0 }]] } });
	assert.equal(r1.status, "ok", r1.text);
	assert.deepEqual(tool.state.last.scene.props[0].parts, PARTS.map(b => ({ ...b, at: [b.at[0], Math.round(b.at[1] * 1000) / 1000, b.at[2]] })), "the tool sets the parts from the centre of the box");
	assert.doesNotMatch(r1.text, /parts of cart/, "parts as the request told them are not told again");
	// the writer gives the box another height: the parts lie as far from its base, and are told
	const r2 = tool.call({ scene: { ...scene, props: [{ id: "cart", size: [2, 1.4, 0.8], at: [0, 0.7, 0] }] } });
	assert.match(r2.text, /\nparts of cart \(the shape the Studio draws for it now[^\n]*"name":"deck","at":\[0,-0\.5,0\]/);
	// the Studio draws it anew between two calls (a stand-in given its look): told on the next call, the clip follows
	tool.setShapes({ cart: { h: 1, parts: base.map(b => (b.name === "deck" ? { ...b, at: [0, 0.4, 0] } : b)) } });
	const before = joint(tool.state.last.scene && build(tool.state.last.scene, { a: [[0, "sit", { on: "cart", part: "deck", over: 0 }]] }).clip, "a", 10, J.Hips)[1];
	const r3 = tool.call({ look: { frames: [10] } });
	assert.match(r3.text, /"name":"deck","at":\[0,-0\.3,0\]/);
	const after = joint(build(tool.state.last.scene, { a: [[0, "sit", { on: "cart", part: "deck", over: 0 }]] }).clip, "a", 10, J.Hips)[1];
	near(after - before, 0.2, 0.002, "the seat follows the deck the Studio moved");
	// parts that cannot be read, a part word that names none
	const bad = tool.call({ scene: { ...scene, props: [{ id: "crate", size: [1, 1, 1], at: [3, 0.5, 0], parts: [{ name: "x", at: [0, 0], size: [1, 1, 1] }] }, scene.props[0]] } });
	assert.equal(bad.status, "rejected");
	assert.match(bad.text, /scene\.props\[0\]\.parts\[0\]: want \{ name, at: \[x, y, z\], size: \[w, h, d\] over 0/);
	const none = tool.call({ scene, spec: { a: [[0, "pose", { R: { on: "cart", part: "wheel" } }]] } });
	assert.match(none.text, /engine error: engine-simple: a pose at frame 0: cart has no part "wheel"; its parts: deck/);
	console.log("ok the motion tool: parts set at the writer's height, told when they differ from what was told, the Studio's new shape on the next call, refusals");
}
console.log("PASS verify-prop-parts");
