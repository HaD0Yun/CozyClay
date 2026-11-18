#!/usr/bin/env node
// A turned prop (src/lowvis/engine-simple, the scene's `turn`): a box [1, 0.5, 0.4] at turn 90 and a box [0.4, 0.5, 1]
// at turn 0 stand on the same footprint, so sitting on it, carrying it and pushing it give the same character joints.
// Without `turn` an existing scene builds as it did before turned props existed: the seven engine demos and the three
// scenes here match fingerprints taken from the engine at the commit before that change.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { DEMO_IDS } from "../../src/lowvis/demos.js";

const scene = (prop, character) => ({ frames: 96, characters: [{ id: "a", ...character }], props: [{ id: "box", ...prop }] });
const TURNED = { size: [1, 0.5, 0.4], turn: 90 }, SQUARE = { size: [0.4, 0.5, 1] };
const CASES = {
	"sit on it": { character: { at: [0, 0.45], heading: 0 }, at: [0, 0.25, 0], moves: false,
		spec: { a: [[0, "idle"], [12, "sit", { on: "box" }], [70, "stand"]] } },
	"carry it": { character: { at: [0, -0.75], heading: 0 }, at: [0, 0.25, 0], moves: true,
		spec: { a: [[0, "idle"], [10, "pose", { hands: { prop: "box" }, bow: 40, over: 14 }], [26, "carry", { prop: "box", at: [0, 1.0, 0.45], over: 14 }], [44, "walk", { to: [0, 0.4] }]] } },
	"push it": { character: { at: [0, -0.85], heading: 0 }, at: [0, 0.25, 0], moves: true,
		spec: { a: [[0, "idle"], [8, "pose", { hands: { prop: "box", face: true }, over: 10 }], [20, "carry", { prop: "box", slide: true }], [24, "push", { to: [0, 0.6] }]] } },
};

const joints = clip => clip.characters.flatMap(c => Array.from(c.pos));
const worst = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
/** Sum and sum of absolute values of every character and prop position: a fingerprint that survives the last-bit
 *  differences between machines (each sum is compared within 1e-6 per value). */
const fingerprint = clip => {
	const values = [...joints(clip), ...clip.props.flatMap(p => Array.from(p.pos))];
	return { n: values.length, sum: values.reduce((s, v) => s + v, 0), abs: values.reduce((s, v) => s + Math.abs(v), 0) };
};

const PRINT = process.argv.includes("--print"), built = {};
for (const [name, c] of Object.entries(CASES)) {
	const turned = buildClip(structuredClone({ ...c.spec, demo: "x" }), scene({ ...TURNED, at: c.at, moves: c.moves }, c.character)).clip;
	const square = buildClip(structuredClone({ ...c.spec, demo: "x" }), scene({ ...SQUARE, at: c.at, moves: c.moves }, c.character)).clip;
	built[name] = square;
	if (PRINT) continue;
	const off = worst(joints(turned), joints(square));
	const unturned = buildClip(structuredClone({ ...c.spec, demo: "x" }), scene({ size: TURNED.size, at: c.at, moves: c.moves }, c.character)).clip;
	const apart = worst(joints(unturned), joints(square)); // the turn is read: the same box left unturned gives another carry and push (a sit reads only the top and the centre)
	assert.ok(off < 0.001, `${name}: the turned box and the square box give the same joints within 1 mm (worst ${(off * 1000).toFixed(3)} mm)`);
	const moved = Math.hypot(...[0, 1, 2].map(k => square.props[0].pos.at(-3 + k) - square.props[0].pos[k]));
	if (c.moves) assert.ok(apart > 0.005, `${name}: the box [1, 0.5, 0.4] without its turn gives other joints (worst ${(apart * 1000).toFixed(1)} mm)`);
	if (c.moves) assert.ok(moved > 0.2, `${name}: the box moves (${moved.toFixed(3)} m)`);
	console.log(`ok ${name}: worst joint offset ${(off * 1000).toFixed(4)} mm (unturned ${(apart * 1000).toFixed(0)} mm)${c.moves ? `, box moved ${moved.toFixed(2)} m` : ""}`);
}

// fingerprints from the engine before turned props (tag plan-before), for scenes without `turn`
const BEFORE = {
	"demo locomotion": { n: 17136, sum: 28131.24091937811, abs: 28401.80087036852 },
	"demo sit": { n: 19590, sum: 16988.58993812318, abs: 17320.271679534184 },
	"demo object": { n: 40323, sum: 55091.27338733278, abs: 55316.25554604278 },
	// duo, chop and bowl pinned again with the counted walk (verify-counted-walk.mjs); were sum 33296.306707722404,
	// 8217.462717724167, 24537.719764461508 and abs 34465.81906765248, 8963.464780009705, 35987.17491706315; again with its
	// repairs (were sum 33293.887403702, 8220.99382688072, 24526.158710004675); duo again when a burst was fitted to how
	// far its feet trail the hips (was sum 33295.85354092025, abs 34465.521872106176)
	"demo duo": { n: 36720, sum: 33152.77082839731, abs: 34324.063255972105 },
	"demo push": { n: 18144, sum: 16378.90072069702, abs: 16937.86911301625 },
	"demo chop": { n: 17787, sum: 8219.455195052107, abs: 8965.554830944 },
	"demo bowl": { n: 22179, sum: 24537.662118600478, abs: 35986.80608473104 },
	"sit on it": { n: 4899, sum: 1932.92509540655, abs: 2080.8489820194295 },
	"carry it": { n: 5184, sum: 1297.472180864108, abs: 2676.4528935573157 },
	"push it": { n: 5184, sum: 644.6375135840353, abs: 1815.2169889187685 },
};
const now = {};
for (const demo of DEMO_IDS) {
	const { default: spec } = await import(`../../src/lowvis/engine-simple/demos/${demo}.js`);
	now[`demo ${demo}`] = fingerprint(buildClip(spec).clip);
}
for (const name of Object.keys(CASES)) now[name] = fingerprint(built[name]);
if (PRINT) { console.log(JSON.stringify(now, null, 1)); process.exit(0); }
for (const [name, want] of Object.entries(BEFORE)) {
	const got = now[name];
	assert.ok(got, `${name}: built`);
	assert.equal(got.n, want.n, `${name}: same number of values`);
	assert.ok(Math.abs(got.sum - want.sum) < 1e-6 * want.n && Math.abs(got.abs - want.abs) < 1e-6 * want.n, `${name}: the same motion as before turned props (sum ${got.sum} vs ${want.sum}, abs ${got.abs} vs ${want.abs})`);
}
console.log(`ok without turn: ${Object.keys(BEFORE).length} scenes build as before turned props`);
console.log("PASS verify-prop-turn");
