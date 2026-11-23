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
import { sceneShapes } from "../../src/lowvis/pi/shapes.mjs";
import { systemPrompt } from "../../src/lowvis/pi/prompt.mjs";
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
	const inside = (b, home) => [0, 1, 2].every(k => Math.abs(b.at[k] - home.at[k]) + b.size[k] / 2 <= home.size[k] / 2 + 0.0011);
	for (const b of forty) {
		const home = merged.find(m => m.name.split("+").includes(b.name)) ?? merged.find(m => / more$/.test(m.name) && inside(b, m));
		assert.ok(home && inside(b, home), `${b.name} lies inside the part it went into`);
	}
	const chars = JSON.stringify(merged).length;
	assert.ok(chars < 2500, `40 parts in ${chars} characters`);
	assert.equal(new Set(merged.map(m => m.name)).size, merged.length, "every part has a name of its own");
	// many parts with long names: still MAX_PARTS, a merged name lists 6 names and counts the rest, in bounded time and text
	const many = Array.from({ length: 2000 }, (_, i) => ({ name: `a_mesh_with_a_name_of_forty_characters_${String(i).padStart(4, "0")}`.slice(0, 40), at: [Math.sin(i) * 2, (i % 11) * 0.1, Math.cos(i * 1.7)], size: [0.05, 0.02 + (i % 3) * 0.04, 0.04] }));
	const t0 = performance.now(), told = mergeParts(many), text = JSON.stringify(told);
	assert.equal(told.length, MAX_PARTS);
	assert.ok(text.length < 6000 && performance.now() - t0 < 2000, `2000 parts in ${text.length} characters, ${Math.round(performance.now() - t0)} ms`);
	assert.ok(told.every(m => m.name.split("+").length <= 7) && told.some(m => /\+\d+ more$/.test(m.name)), "a merged name lists 6 names, then the count of the rest");
	for (const b of many) assert.ok(told.some(m => inside(b, m)), `${b.name} lies inside a told part`);
	console.log(`ok mergeParts: 40 parts -> ${merged.length}, ${chars} characters of JSON; 2000 parts -> ${told.length}, ${text.length} characters; each part inside its merged box`);
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
	// names: an empty sculpt part id falls to the mesh's name, a second "part" is part_2 and never the name another mesh has, a long name is cut
	const named = new THREE.Group(), mesh = (name, x, part) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)); m.position.set(x, 0.05, 0); m.name = name; if (part !== undefined) m.userData.sculptPart = part; named.add(m); };
	mesh("", 0); mesh("part_2", 0.2); mesh("", 0.4); mesh("wing", 0.6, ""); mesh("x".repeat(60), 0.8);
	assert.deepEqual(objectParts(named).map(b => b.name), ["part", "part_2", "part_3", "wing", "x".repeat(40)]);
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
	// the bag rides a's back (a joint) while a walks: b's hand stays on the handle where the walk takes it
	const rode = { a: [[0, "walk", { to: [0, 1.5] }]], b: spec.b, bag: [[0, "ride", { joint: "Spine2", of: "a", at: [0, 0, -0.25] }]] }, r2 = build(def, rode);
	const t = inProp(r2.clip, "bag", 36, r2.aux.reach.b[36][0].t), moved = propAt(r2.clip, "bag", 36).c[2] - propAt(r2.clip, "bag", 0).c[2];
	assert.ok(moved > 1 && partDistance(boxes[1], t) <= 1e-6, `b's target on the handle of a bag that rides a body joint (moved ${moved.toFixed(2)} m)`);
	console.log("ok hold at a part, ride on a part, a hand of another body on a carried prop's part and on one that rides a joint");
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
	const base = PARTS.map(b => ({ ...b, at: [b.at[0], b.at[1] + 0.5, b.at[2]] })), shapes = { cart: { h: 1, parts: base }, crate: null };
	const tool = createCompileTool({ name: "parts", outDir: dir, clipFile: join(dir, "clip.json"), variant: "studio", shapes });
	const scene = { frames: 24, characters: [{ id: "a", at: [-0.3, 0], heading: 90 }], props: [{ id: "cart", size: BOX, at: [0, 0.5, 0] }] };
	const r1 = tool.call({ scene, spec: { a: [[0, "sit", { on: "cart", part: "deck", over: 0 }]] } });
	assert.equal(r1.status, "ok", r1.text);
	assert.deepEqual(tool.state.last.scene.props[0].parts, PARTS.map(b => ({ ...b, at: [b.at[0], Math.round(b.at[1] * 1000) / 1000, b.at[2]] })), "the tool sets the parts from the centre of the box");
	assert.doesNotMatch(r1.text, /parts of cart/, "parts as the request told them are not told again");
	assert.deepEqual(sceneShapes(tool.state.last.scene), { cart: { h: 1, parts: base.map(b => ({ ...b, at: b.at.map(v => Math.round(v * 1000) / 1000) })) } }, "the compiled scene gives the shapes back from the box's base (a kept motion's, motion-run.mjs)");
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
	// with a Studio behind the tool its shapes are the only parts: parts a scene itself gives are not read (nor checked),
	// on a prop the Studio draws as its box and on one it draws otherwise
	const own = tool.call({ scene: { ...scene, props: [{ id: "crate", size: [1, 1, 1], at: [3, 0.5, 0], parts: [{ name: "x", at: [0, 0], size: [1, 1, 1] }] }, { ...scene.props[0], parts: [{ name: "mine", at: [0, 0, 0], size: [1, 1, 1] }] }] } });
	assert.equal(own.status, "ok", own.text);
	assert.deepEqual(tool.state.last.scene.props.map(p => p.parts?.map(b => b.name).join()), [undefined, PARTS.map(b => b.name).join()], "the crate has no parts, the cart the Studio's");
	const lid = tool.call({ spec: { a: [[0, "pose", { R: { on: "crate", part: "x" } }]] } });
	assert.match(lid.text, /crate has no parts \(the Studio has drawn none for it, or its shape is its box\); give at from its centre instead/);
	const none = tool.call({ scene, spec: { a: [[0, "pose", { R: { on: "cart", part: "wheel" } }]] } });
	assert.match(none.text, /engine error: engine-simple: a pose at frame 0: cart has no part "wheel"; its parts: deck/);
	// what the Studio lists now replaces its last; a prop it no longer lists (on a bone, hidden) keeps its last shape; one it
	// draws as its box now has no parts, and the writer is told
	tool.setShapes({ crate: null });
	const kept = tool.call({ spec: { a: [[0, "sit", { on: "cart", part: "deck", over: 0 }]] } });
	assert.equal(kept.status, "ok", kept.text);
	assert.doesNotMatch(kept.text, /parts of cart/);
	tool.setShapes({ cart: null });
	const gone = tool.call({ spec: { a: [[0, "sit", { on: "cart", over: 0 }]] } });
	assert.match(gone.text, /\nparts of cart: none now \(the Studio draws it as its box\)\n/);
	assert.equal(tool.state.last.scene.props[0].parts, undefined);
	// a part target out of the arm's reach: the reach rows say why, the gap rows how far the hands end from the drawn
	tool.setShapes({ cart: { h: 1, parts: [...base, { name: "far", at: [0.95, 0.9, 0], size: [0.03, 0.03, 0.6] }] } });
	const far = tool.call({ spec: { a: [[0, "sit", { on: "cart", part: "deck", over: 0 }], [0, "pose", { L: { on: "cart", part: "far", at: [0, 0, 0.25] }, R: { on: "cart", part: "far", at: [0, 0, -0.25] }, over: 8 }]] } });
	assert.match(far.text, /\n- hand off its target: [\d.]+ mm @f\d+ a \(L hand[^\n]*beyond the arm's reach/);
	assert.match(far.text, /\n- a's L hand to the drawn cart: [\d.]+ mm @f\d+ a \(nearest part [^;]+; past 30 mm on \d+ frames, from f\d+ to f\d+\)/);
	// a hold at a part: the rows read the spec as the engine read it (its places on parts written as the prop's own)
	tool.setShapes({ bag: { h: 0.3, parts: [{ name: "body", at: [0, 0.1, 0], size: [0.4, 0.2, 0.2] }, { name: "handle", at: [0, 0.27, 0], size: [0.2, 0.02, 0.02] }] } });
	const held = tool.call({ scene: { ...scene, props: [...scene.props, { id: "bag", size: [0.4, 0.3, 0.2], at: [-0.3, 0.8, 0.4], moves: true }] }, spec: { a: [[0, "hold", { prop: "bag", hand: "R", at: { part: "handle" }, over: 8 }], [10, "pose", { L: { on: "bag", part: "body", at: [0, 0, 0.1] }, over: 6 }]] } });
	assert.equal(held.status, "ok", held.text);
	const bare = createCompileTool({ name: "parts-bare", outDir: dir, clipFile: join(dir, "clip2.json"), variant: "base" });
	const mine = bare.call({ scene: { ...scene, props: [cart()] }, spec: { a: [[0, "sit", { on: "cart", part: "deck", over: 0 }]] } });
	assert.equal(mine.status, "ok", mine.text);
	const bad = bare.call({ scene: { ...scene, props: [{ id: "crate", size: [1, 1, 1], at: [3, 0.5, 0], parts: [{ name: "x", at: [0, 0], size: [1, 1, 1] }] }, cart()] } });
	assert.equal(bad.status, "rejected");
	assert.match(bad.text, /scene\.props\[0\]\.parts\[0\]: want \{ name, at: \[x, y, z\], size: \[w, h, d\] over 0/);
	console.log("ok the motion tool: the Studio's shapes are the only parts, set at the writer's height, told when they differ from what was told or go; a part out of reach is told; without a Studio a scene's own parts");
}
// --- the manual: the words for parts only where props are told with parts (the tops step) ---
{
	const studio = systemPrompt("studio"), off = systemPrompt("studio", ["tops"]), base = systemPrompt("base");
	for (const word of ["{on:propId, part, at?}", "A prop with parts", "{on, part?, at?, pitch:deg}", "ride {on:propId, part?}", " parts (told by the Studio's scene and the tool", "- to the drawn:"]) {
		assert.ok(studio.includes(word), `the studio manual has ${word}`);
		assert.ok(!off.includes(word) && !base.includes(word), `without the tops step no manual has ${word}`);
	}
	assert.ok(base.includes("{on, at?, pitch:deg} (a place on a prop as for a hand)") && !/\bpart\?|, part,/.test(base) && !/\bpart\?|, part,/.test(off), "a foot on a prop is a word of every manual; the part words are not");
	assert.doesNotMatch(studio, /parts\? \}\] \}/, "parts are no field of the scene the writer sends");
	console.log(`ok the manual: studio ${studio.length} characters, with the tops step off ${off.length}, base ${base.length}`);
}
console.log("PASS verify-prop-parts");
