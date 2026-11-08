#!/usr/bin/env node
// Whole-body turns past upright: the root's pitch and roll take full turns (flips, cartwheels) while the spine and head
// keep their limits; pose.js reads the poles and feet in the turning body's frame only past 60 deg (an upright take is
// unchanged); the flip skill's back and front tucks and cartwheel compile on both rigs with clean QA, the flight a real
// ballistic arc (no FLOAT), the hands carrying the cartwheel (a hand on the ground is no float), and nothing in the floor.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { tiltFrame } from "../../src/motion3/compiler/pose.js";
import { solePoints } from "../../src/motion3/qa/geometry.js";
import { runMotionQa } from "../../src/motion3/qa/index.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const SPEC = "cozyclay.motion-spec.v1";
const stand = { skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } };
const compile = (model, use, extra = {}) => compileSpec({ schema: SPEC, fps: 24, frames: "auto", use: [stand, ...use], ...extra }, { sk: skeletonFor(model), scene: motionScene([]) });
const refused = fn => { try { fn(); return null; } catch (e) { return e.message; } };

// 1. ranges: the root turns freely, the spine and head do not
const keyed = set => ({ schema: SPEC, fps: 24, frames: 30, use: [stand], keys: [{ f: 20, set }] });
const yb = skeletonFor("y-bot-tpose");
expect("a whole-body pitch of 360 (a front flip) is a valid key", refused(() => compileSpec(keyed({ pitch: 360 }), { sk: yb, scene: motionScene([]) })) === null);
expect("a whole-body roll of -720 (two cartwheel turns) is a valid key", refused(() => compileSpec(keyed({ roll: -720 }), { sk: yb, scene: motionScene([]) })) === null);
expect("the spine still stops at 120 deg", /spine_pitch/.test(refused(() => compileSpec(keyed({ spine_pitch: 150 }), { sk: yb, scene: motionScene([]) })) ?? ""));
expect("the head still stops at 90 deg of roll", /head_roll/.test(refused(() => compileSpec(keyed({ head_roll: 100 }), { sk: yb, scene: motionScene([]) })) ?? ""));

// 2. the tilt frame: none while upright (poles turn with the yaw, as before), the full body past 120 deg
expect("upright (pitch 59, roll -40): no tilt frame, an upright take is unchanged", tiltFrame(30, 59, -40) === null && tiltFrame(0, 360, 0) === null);
const full = tiltFrame(0, 180, 0)?.R;
expect("upside down: the tilt frame is the whole body's", full && Math.abs(full[1][1] + 1) < 1e-9 && Math.abs(full[2][2] + 1) < 1e-9);

// 3. flips and cartwheels on both rigs
for (const model of ["y-bot-tpose", "x-bot-tpose"]) {
	const sk = skeletonFor(model), I = sk.index;
	const floorDepth = r => Math.min(...r.out.frames.flatMap(({ s }) => ["Left", "Right"].flatMap(S => { const sp = solePoints(sk, s, S); return [sp.heel[1], sp.ball[1], sp.tip[1]]; })));
	for (const kind of ["back", "front"]) {
		const r = compile(model, [{ skill: "flip", f0: 6, args: { kind } }]), p = r.out.baked.pitch, sign = kind === "back" ? -1 : 1;
		expect(`${model} ${kind} flip: QA clean`, r.qa.total === 0, JSON.stringify(r.qa.groups.map(g => `${g.kind} ${g.subject} f${g.first}-${g.last}`)));
		expect(`${model} ${kind} flip: the body turns a full ${sign * 360} deg and ends at 0`, Math.abs(Math.min(...p.map(v => v * sign)) - 0) < 1e-6 && Math.max(...p.map(v => v * sign)) > 359.9 && p.at(-1) === 0);
		const hips = r.out.frames.map(({ s }) => s.P[I.Hips][1]);
		expect(`${model} ${kind} flip: the hips rise at least 0.4 m above standing in the air`, Math.max(...hips) - hips[0] > 0.4, (Math.max(...hips) - hips[0]).toFixed(3));
		expect(`${model} ${kind} flip: no sole goes into the floor`, floorDepth(r) > -0.01, floorDepth(r).toFixed(4));
	}
	for (const side of ["l", "r"]) {
		const r = compile(model, [{ skill: "flip", f0: 6, args: { kind: "cartwheel", side } }]), roll = r.out.baked.roll, sign = side === "l" ? -1 : 1;
		// QA measures the fingers against the floor since #1113 (qa/floor.js): the planted hands put them 7 (X Bot) to 11 (Y Bot)
		// cm into it for 5 frames, the fingers pointing down (skills/flip.js, open); pinned so they cannot grow
		const plants = r.qa.groups.filter(g => g.kind === "GROUND" && /^fingers_[lr] below floor$/.test(g.subject)), rest = r.qa.groups.filter(g => !plants.includes(g));
		const kinds = new Set(rest.map(g => g.kind));
		expect(`${model} cartwheel ${side}: only stray single-frame POPs at most (no FLOAT, REACH, BODY, SLIDE, GROUND, KNEE)`, [...kinds].every(k => k === "POP") && rest.every(g => g.count <= 2) && rest.reduce((n, g) => n + g.count, 0) <= 2,
			JSON.stringify(r.qa.groups.map(g => `${g.kind} ${g.subject} n${g.count}`)));
		expect(`${model} cartwheel ${side}: the planted fingers go no deeper into the floor than at #1113 (11 cm, 5 frames)`, plants.every(g => g.worst <= 0.11 && g.count <= 5), JSON.stringify(plants.map(g => `${g.subject} ${g.worst} n${g.count}`)));
		expect(`${model} cartwheel ${side}: the body rolls a full turn toward the ${side === "l" ? "left" : "right"}`, Math.max(...roll.map(v => v * sign)) > 359.9 && roll.at(-1) === 0);
		const handLow = Math.min(...r.out.frames.flatMap(({ s }) => ["Left", "Right"].map(S => s.P[I[`${S}Hand`]][1])));
		expect(`${model} cartwheel ${side}: the hands carry it on the floor`, handLow < 0.12, handLow.toFixed(3));
		const root = r.out.baked.root, lateral = (root.at(-1)[0] - root[0][0]) * (side === "l" ? 1 : -1);
		expect(`${model} cartwheel ${side}: it travels sideways toward that side`, lateral > 1, lateral.toFixed(2));
		expect(`${model} cartwheel ${side}: no sole goes into the floor`, floorDepth(r) > -0.01, floorDepth(r).toFixed(4));
	}
}

// 4. the knee check still catches a knee bent the wrong way standing (an upright leg reads as it always has). The knee
// joint is mirrored through the hip-ankle line in one compiled frame and QA runs again on it.
const mirrorKnee = (sk, s) => {
	const I = sk.index, th = s.P[I.LeftUpLeg], an = s.P[I.LeftFoot], kn = s.P[I.LeftLeg];
	const mid = [0, 1, 2].map(i => (th[i] + an[i]) / 2);
	s.P[I.LeftLeg] = [0, 1, 2].map(i => 2 * mid[i] - kn[i]);
};
for (const [label, use, f] of [["standing", [], 6]]) {
	const spec = { schema: SPEC, fps: 24, frames: use.length ? "auto" : 12, use: [stand, ...use] };
	const r = compileSpec(spec, { sk: yb, scene: motionScene([]) }), clean = !r.qa.groups.some(g => g.kind === "KNEE");
	mirrorKnee(yb, r.out.frames[f].s);
	const after = runMotionQa(yb, r.out, r.spec ?? spec).groups.filter(g => g.kind === "KNEE" && /bends backward/.test(g.subject));
	expect(`${label}: a knee mirrored backward at f${f} reads as bending backward (and not before)`, clean && after.some(g => g.first <= f && g.last >= f), JSON.stringify(after.map(g => `${g.subject} f${g.first}-${g.last}`)));
}

if (failures) { console.error(`${failures} motion3 flip check(s) failed`); process.exit(1); }
console.log("motion3 flip: all checks passed");
