#!/usr/bin/env node
// The balance assist of engine-simple (src/lowvis/engine-simple/balance.js, LOWVIS_BALANCE_ASSIST=1): with the switch
// on, a body that stands at rest on its feet with its centre of mass outside its supports is made balanced while the
// clip is built, so the balance row (src/lowvis/pi/balance.mjs) tells nothing for it. Checked here, each clip built
// with the switch off and on:
//  - the fixtures (one body, 96 frames) and the stock demos: the balance rows off and on (the table below);
//  - supports: a foot a key puts down on the floor holds the body up, one a key lifts or sends past the leg's reach does not;
//  - planted feet stay where they are off (0.1 mm x scale);
//  - hands: on every frame a hand with a target of its action (a body-frame point) is no more than 2 mm x scale further
//    from it than off, and so on the frames of its reach rows (the build's aux.reach);
//  - smooth: no jump row (pi/measure.mjs) that the clip off does not have, and the Hips' largest step change between
//    frames (m / frame^2) at most 5 mm x scale more than off;
//  - left alone, the same to the last bit as off: sitting, kneeling, lying, a deep crouch, a flight, a walk, run and
//    push, a body on a prop and riding one, tilted, holding a prop, carrying one with another body, a prop riding a joint;
//  - scale: with the switch on, a scene at body scale s gives every joint s times the unit scene (verify-body-size.mjs's bar);
//  - switch off: the clip is the one the engine builds with the switch unset.
import assert from "node:assert/strict";
import { serializeClip } from "../../src/lowvis/clip.js";
import { DEMOS, DEMO_IDS } from "../../src/lowvis/demos.js";
import { buildClip, expandRepeats } from "../../src/lowvis/engine-simple/engine.js";
import { buildBodySized } from "../../src/lowvis/engine-simple/size.js";
import { partBoxes, resolveParts } from "../../src/lowvis/engine-simple/spec-layers.js";
import { balanceRows } from "../../src/lowvis/pi/balance.mjs";
import { measure } from "../../src/lowvis/pi/measure.mjs";
import { INDEX as J, JOINT_COUNT, qAxisAngle, qRotate } from "../../src/lowvis/rig17.js";

const KEY = "LOWVIS_BALANCE_ASSIST", WAS = process.env[KEY];
const FIXTURES = {
	"one-foot": [[0, "idle"], [12, "pose", { footL: [0.1, 0.35, 0.25], over: 14 }]],
	"side-shift": [[0, "idle"], [12, "pose", { hip: [0.2, 0, 0], over: 16 }]],
	"one-foot-reach": [[0, "idle"], [12, "pose", { footR: [-0.1, 0.4, -0.35], bow: 35, hands: [0.2, 0.15, 0.55], over: 16 }]],
	"flamingo": [[0, "idle"], [12, "pose", { footL: [0.05, 0.5, 0.1], hands: [0.5, 0.3, 0], over: 16 }], [70, "pose", { footL: [0.05, 0.6, 0.15], hands: [0.3, 0.6, 0.1], over: 12 }]],
	"kick-hold": [[0, "idle"], [12, "pose", { footR: [-0.12, 0.55, 0.5], lean: -8, over: 12 }]],
	"arabesque": [[0, "idle"], [12, "pose", { footL: [0.1, 0.45, -0.5], bow: 30, hands: [0.2, 0.2, 0.6], over: 18 }]],
	"side-leg": [[0, "idle"], [12, "pose", { footR: [-0.55, 0.35, 0], over: 14 }]],
	"knee-up-reach": [[0, "idle"], [12, "pose", { footL: [0.1, 0.4, 0.3], L: [0.5, 0.1, 0.2], over: 14 }]],
	"wide-lean": [[0, "idle"], [12, "pose", { footL: [0.3, 0, 0], footR: [-0.3, 0, 0], hip: [0.25, -0.05, 0], over: 16 }]],
	"walk-then-crane": [[0, "idle"], [10, "walk", { to: [0, 1.2] }], [50, "pose", { footR: [-0.1, 0.4, 0.2], hands: [0.4, 0.4, 0], over: 14 }]],
	"pick-up-floor": [[0, "idle"], [12, "pose", { bow: 70, hands: [0.1, -0.9, 0.5], hip: [0, -0.15, -0.1], over: 20 }]],
	"bow-reach": [[0, "idle"], [12, "pose", { bow: 55, hands: [0.2, 0.25, 0.6], over: 18 }]],
	"lean-back": [[0, "idle"], [12, "pose", { lean: -30, bow: -10, over: 18 }]],
	"squat-shift": [[0, "idle"], [12, "pose", { hip: [0.12, -0.25, 0.05], bow: 20, over: 16 }]],
	"look-back": [[0, "idle"], [12, "pose", { look: [0, 1.6, -3], lean: 5, hip: [0.15, 0, 0], over: 16 }]],
};
const BALANCED = new Set(["bow-reach", "lean-back", "squat-shift", "look-back"]); // no row with the switch off either
const scene = (s = 1, props = [], frames = 96, more = []) => ({ frames, characters: [{ id: "a", at: [0, 0], heading: 0, ...(s === 1 ? {} : { scale: s }) }, ...more], props });

/** Builds with the switch as given (null: unset): the parsed clip, aux, the balance rows and the jump rows. */
function build(spec, def, on) {
	if (on == null) delete process.env[KEY]; else process.env[KEY] = on ? "1" : "0";
	const { clip, aux } = buildClip(structuredClone(spec), structuredClone(def)), text = serializeClip(clip), parsed = JSON.parse(text);
	const asBuilt = resolveParts(expandRepeats(spec, def.frames).spec, def);
	return { clip: parsed, raw: clip, aux, text, rows: balanceRows(parsed, aux, asBuilt, def), jumps: measure(parsed, aux, { spec: asBuilt }).filter(r => r.short === "jump") };
}
const at = (c, f, j) => [0, 1, 2].map(k => c.pos[(f * JOINT_COUNT + j) * 3 + k]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mm = v => (v * 1000).toFixed(1);
const rowText = b => b.rows.map(r => `${r.who} ${r.value.toFixed(1)} mm @f${r.frame}`).join(", ") || "none";
/** The largest change of the Hips' step between frames, m / frame^2. */
const peakAcc = c => { let a = 0; for (let f = 1; f + 1 < c.pos.length / JOINT_COUNT / 3; f++) a = Math.max(a, dist(at(c, f + 1, J.Hips).map((v, k) => v - at(c, f, J.Hips)[k]), at(c, f, J.Hips).map((v, k) => v - at(c, f - 1, J.Hips)[k]))); return a; };

/** The checks of planted feet, hands and smoothness between a clip built off and on. def: its scene, spec: its spec. */
function compareOnOff(name, off, on, spec, def) {
	const out = { foot: 0, reach: 0, hand: 0, acc: [0, 0] };
	off.clip.characters.forEach((c0, n) => {
		const c1 = on.clip.characters[n], s = c0.scale ?? 1, F = off.clip.frameCount;
		for (let f = 0; f < F; f++) {
			[J.LeftFoot, J.RightFoot].forEach((j, i) => { if (off.aux.contacts[c0.id][f][i]) out.foot = Math.max(out.foot, dist(at(c0, f, j), at(c1, f, j)) / s); });
			for (let i = 0; i < 6; i++) { const a = off.aux.reach[c0.id][f]?.[i], b = on.aux.reach[c0.id][f]?.[i]; if (i < 2 && a && b) out.reach = Math.max(out.reach, (b.d - a.d) / s); }
		}
		// every frame of a body-frame hand target: from its key to the next key of that hand
		const acts = (spec[c0.id] ?? []).slice().sort((a, b) => a[0] - b[0]), one = def.characters.find(x => x.id === c0.id);
		const props = Object.fromEntries(def.props.map(p => [p.id, { id: p.id, size: p.size, parts: partBoxes(p), c: p.at.slice(), turn: (p.turn ?? 0) * Math.PI / 180 }])), layer = buildBodySized(one, acts, F, { props, ground: () => 0 }, s);
		for (const [i, pick] of [[0, o => o.L ?? o.hands], [1, o => o.R ?? (Array.isArray(o.hands) ? [-o.hands[0], o.hands[1], o.hands[2]] : o.hands)]]) {
			const keys = acts.filter(a => a[1] === "pose" && pick(a[2]) !== undefined);
			keys.forEach((k, n2) => {
				const to = pick(k[2]);
				if (!Array.isArray(to)) return;
				for (let f = k[0]; f < (keys[n2 + 1]?.[0] ?? F); f++) {
					const B = layer[f], t = B.p.map((v, q) => v + qRotate(qAxisAngle([0, 1, 0], B.yaw), to)[q]), j = i ? J.RightHand : J.LeftHand;
					out.hand = Math.max(out.hand, (dist(at(c1, f, j), t) - dist(at(c0, f, j), t)) / s);
				}
			});
		}
		out.acc = [Math.max(out.acc[0], peakAcc(c0) / s), Math.max(out.acc[1], peakAcc(c1) / s)];
	});
	assert.ok(out.foot <= 1e-4, `${name}: planted feet stay where they are off (${mm(out.foot)} mm)`);
	assert.ok(out.reach <= 0.002 && out.hand <= 0.002, `${name}: hands no more than 2 mm further from their targets (reach rows ${mm(out.reach)} mm, every frame ${mm(out.hand)} mm)`);
	const before = new Set(off.jumps.map(r => r.key)), extra = on.jumps.filter(r => !before.has(r.key));
	assert.equal(extra.length, 0, `${name}: no new jump rows (${extra.map(r => `${r.key} ${r.value} cm @f${r.frame}`)})`);
	assert.ok(out.acc[1] - out.acc[0] <= 0.005, `${name}: the Hips' peak acceleration rises at most 5 mm / frame^2 (${mm(out.acc[0])} -> ${mm(out.acc[1])})`);
	return out;
}

/** The fixture's spec with its lengths times s (foot, hand and hip points, the walk's destination, a look point). */
const sized = (list, s) => list.map(([f, verb, o]) => [f, verb, o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) && ["footL", "footR", "hands", "L", "R", "hip", "to", "look"].includes(k) ? v.map(x => x * s) : v]))]);

try {
	// --- the fixtures: rows off as the table has them, none on; feet, hands and smoothness ---
	const table = [];
	for (const [name, a] of Object.entries(FIXTURES)) {
		const spec = { demo: name, a }, def = scene(), off = build(spec, def, false), on = build(spec, def, true);
		assert.equal(off.rows.length, BALANCED.has(name) ? 0 : 1, `${name}: off, the balance rows are those of the table (${rowText(off)})`);
		assert.equal(on.rows.length, 0, `${name}: on, no balance row (${rowText(on)})`);
		const r = compareOnOff(name, off, on, spec, def);
		table.push(`${name.padEnd(16)} off ${rowText(off).padEnd(18)} on ${rowText(on).padEnd(5)} feet ${mm(r.foot)} hands +${mm(Math.max(r.reach, r.hand, 0))} mm, Hips peak acc ${mm(r.acc[0])} -> ${mm(r.acc[1])} mm/f2`);
		if (name === "one-foot") assert.equal(build(spec, def, null).text, off.text, "the switch unset builds the clip the switch at 0 builds");
	}
	// --- the stock demos: the bowl's row goes, the others have none either way ---
	for (const id of DEMO_IDS) {
		const { default: spec } = await import(`../../src/lowvis/engine-simple/demos/${id}.js`), off = build(spec, DEMOS[id], false), on = build(spec, DEMOS[id], true);
		assert.equal(off.rows.length, id === "bowl" ? 1 : 0, `demo ${id}: off, the rows of the table (${rowText(off)})`);
		assert.equal(on.rows.length, 0, `demo ${id}: on, no balance row (${rowText(on)})`);
		compareOnOff(`demo ${id}`, off, on, spec, DEMOS[id]);
		table.push(`demo ${id.padEnd(11)} off ${rowText(off).padEnd(18)} on ${rowText(on)}`);
	}
	console.log(table.join("\n"));

	// --- supports: a foot down on the floor holds the body up; a foot lifted, or sent past the leg's reach, does not ---
	{
		const spec = y => ({ demo: "x", a: [[0, "idle"], [12, "pose", { footL: [0.3, y, 0.05], hip: [0.2, 0, 0], over: 16 }]] });
		const down = [build(spec(0), scene(), false), build(spec(0), scene(), true)], up = [build(spec(0.15), scene(), false), build(spec(0.15), scene(), true)];
		assert.equal(down[0].rows.length, 0, `a foot put down on the floor: balanced off (${rowText(down[0])})`);
		assert.equal(down[1].text, down[0].text, "a foot put down on the floor is a support: the assist leaves the body as it is");
		assert.ok(up[0].rows.length === 1 && up[1].rows.length === 0, `the same foot 0.15 m up: off ${rowText(up[0])}, on ${rowText(up[1])}`);
		const shift = at(up[1].clip.characters[0], 80, J.Hips)[0] - at(up[0].clip.characters[0], 80, J.Hips)[0];
		assert.ok(shift < -0.05, `the foot 0.15 m up is no support: the pelvis goes over the other foot (${mm(shift)} mm along x)`);
		// wide-lean: the right foot's target on the floor lies past the leg's reach; it hangs, and the body goes over the left foot
		const wide = build({ demo: "x", a: FIXTURES["wide-lean"] }, scene(), true), c = wide.clip.characters[0], low = at(c, 80, J.RightFoot)[1] - at(c, 0, J.RightFoot)[1];
		assert.ok(low > 0.01 && at(c, 80, J.Hips)[0] > at(build({ demo: "x", a: FIXTURES["wide-lean"] }, scene(), false).clip.characters[0], 80, J.Hips)[0] + 0.02, `wide-lean: the right foot hangs ${mm(low)} mm up and is no support; the pelvis goes left`);
	}

	// --- left alone: the same clip of that body as off (whole clip, or the frames named) ---
	{
		const box = { id: "box", size: [0.45, 0.45, 0.45], at: [0, 0.225, -0.45] }, step = { id: "step", size: [1.2, 0.2, 1.2], at: [0, 0.1, 0], parts: [{ name: "top", at: [0, 0, 0], size: [1.2, 0.2, 1.2] }] }, cart = { id: "cart", size: [0.8, 0.2, 0.8], at: [0, 0.1, 0], moves: true };
		const bag = { id: "bag", size: [0.3, 0.3, 0.2], at: [0.35, 0.6, 0.25], moves: true }, crate = { id: "crate", size: [0.5, 0.3, 0.3], at: [0, 0.9, 0.55], moves: true }, stick = { id: "stick", size: [0.04, 0.04, 0.5], at: [0, 1.2, 0.3], moves: true };
		const lean = { hip: [0.2, 0, 0], footL: [0.1, 0.3, 0.25], over: 12 }; // off balance where the assist would act
		const cases = [
			["sitting", scene(1, [box], 80), [[0, "sit", { on: "box", over: 20 }], [30, "pose", lean]]],
			["kneeling", scene(1, [], 80), [[0, "kneel", { over: 20 }], [30, "pose", { bow: 60, hands: [0.2, 0.3, 0.6], over: 12 }]]],
			["lying", scene(1, [], 80), [[0, "lie", { at: [0, -0.8], over: 20 }], [40, "pose", { footL: [0.1, 0.4, 0.2], over: 12 }]]],
			["a deep crouch", scene(1, [], 80), [[0, "idle"], [0, "pose", { hip: [0.15, -0.62, 0.1], over: 0 }], [20, "pose", { footL: [0.15, 0.15, 0.3], over: 12 }]], c => assert.ok(at(c, 60, J.Hips)[1] < 0.45, `the crouch is deep (${mm(at(c, 60, J.Hips)[1])} mm)`)],
			["in the air", scene(1, [], 60), [[0, "launch", { vel: [0, 3.2, 0] }], [3, "pose", { footL: [0.1, 0.4, 0.2], over: 6 }]], null, on => on.aux.flights[0].f1],
			["walking", scene(1, [], 90), [[0, "walk", { to: [0, 2] }], [0, "pose", { hip: [0.2, 0, 0], over: 0 }]], null, lastMoved],
			["running", scene(1, [], 90), [[0, "run", { to: [0, 3] }], [0, "pose", { footL: [0.1, 0.3, 0.2], over: 0 }]], null, lastMoved],
			["pushing", scene(1, [], 90), [[0, "push", { to: [0, 1.2] }], [0, "pose", { hip: [0.2, 0, 0], over: 0 }]], null, lastMoved],
			["standing on a prop", scene(1, [step], 80), [[0, "idle", { on: "step" }], [10, "pose", lean]], c => assert.ok(at(c, 40, J.RightFoot)[1] > 0.2, "it stands on the step")],
			["riding a prop", scene(1, [cart], 80), [[0, "idle", { on: "cart" }], [10, "pose", lean]], null, null, { cart: [[20, "move", { to: [0.5, 0.1, 0.5], over: 40 }]] }],
			["tilted", scene(1, [], 80), [[0, "pose", { tilt: [10, 0], over: 0 }], [10, "pose", lean]]],
			["holding a prop", scene(1, [bag], 80), [[0, "hold", { prop: "bag", hand: "L" }], [10, "pose", lean]]],
			["carrying with another", scene(1, [crate], 80, [{ id: "b", at: [0, 1.1], heading: 180 }]), [[0, "hold", { prop: "crate", hand: "both", at: { L: [0.25, 0, 0], R: [-0.25, 0, 0] }, over: 10 }], [20, "pose", lean]], null, null, { b: [[0, "hold", { prop: "crate", hand: "both", at: { L: [-0.25, 0, 0.1], R: [0.25, 0, 0.1] }, over: 10 }], [20, "pose", { hip: [-0.2, 0, 0], footR: [-0.1, 0.3, 0.25], over: 12 }]] }],
			["a prop riding a joint", scene(1, [stick], 80), [[0, "idle"], [10, "pose", lean]], null, null, { stick: [[0, "ride", { joint: "RightHand", of: "a" }]] }],
		];
		function lastMoved(on) { const c = on.clip.characters[0]; let last = 0; for (let f = 1; f < on.clip.frameCount; f++) if (dist(at(c, f, J.LeftFoot), at(c, f - 1, J.LeftFoot)) + dist(at(c, f, J.RightFoot), at(c, f - 1, J.RightFoot)) > 1e-4) last = f; return last; }
		for (const [name, def, a, extra, until, more = {}] of cases) {
			const spec = { demo: "x", a, ...more }, off = build(spec, def, false), on = build(spec, def, true), end = until ? until(on) : def.frames;
			for (const id of def.characters.map(c => c.id)) {
				const c0 = off.clip.characters.find(c => c.id === id), c1 = on.clip.characters.find(c => c.id === id);
				const n = end * JOINT_COUNT, same = c0.pos.slice(0, n * 3).every((v, k) => v === c1.pos[k]) && c0.quat.slice(0, n * 4).every((v, k) => v === c1.quat[k]);
				assert.ok(same, `${name}: ${id} is the same as off${end < def.frames ? ` up to f${end}` : ""}`);
			}
			if (end === def.frames) assert.equal(on.text, off.text, `${name}: the same clip as off`);
			extra?.(on.clip.characters[0]);
		}
	}

	// --- scale: a scene at body scale s with the switch on is the unit scene's times s ---
	process.env[KEY] = "1";
	for (const s of [0.5, 0.85, 1.6, 2]) {
		let worst = 0;
		for (const [name, a] of Object.entries(FIXTURES)) {
			const unit = build({ demo: name, a }, scene(), true), big = build({ demo: name, a: sized(a, s) }, scene(s), true);
			unit.raw.characters[0].pos.forEach((v, k) => { worst = Math.max(worst, Math.abs(v * s - big.raw.characters[0].pos[k]) / s); }); // as built, before the clip's text rounds it
			assert.equal(big.rows.length, 0, `${name} at scale ${s}: no balance row (${rowText(big)})`);
		}
		assert.ok(worst < 1e-5, `scale ${s}: every joint is ${s} times the unit scene's (worst ${worst.toExponential(2)} m per metre)`);
	}
} finally {
	if (WAS === undefined) delete process.env[KEY]; else process.env[KEY] = WAS;
}
console.log("PASS verify-balance-assist");
