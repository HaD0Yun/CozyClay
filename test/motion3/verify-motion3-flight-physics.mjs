#!/usr/bin/env node
// Flight physics (#1124 and the spin fix): off the ground only gravity acts on the body. Built from the physics bench's
// sets 06 (trip run) and 07 (roof fall back) and the flip skill, since the bench's own v2 specs are not in the repo.
//   (a) a backward hop off a 3 m roof, its hips keyed on an exact 1 g parabola every frame: retime leaves the air frames
//       alone and the ballistic fix keeps the centre of mass on the arc, so the hips stay within 0.05 m of their keys and
//       the bench scorer's gravity error (test/bench/physics/checks.mjs gravityCheck) is under 0.05 m; no new REACH or
//       penetration against the same take with the flight fixes off. A hand on the body's own hip or thigh or on an object
//       the body carries changes none of it; a hand on a world point, a person or a resting object takes the arc off and
//       still keeps retime out. Cut mid-fall the take has no landing: retime still leaves the air frames as keyed, the arc stays 1 g
//       (a2) a keyed flight past the apex limit: fixed.ballistic.skipped reports it and the hips stay as keyed
//       (a3) the bench-2 parkour vault: the push-off and impact the fix made are no POP, its keyed pops there stand, no blocking group;
//       a hop whose keyed arm snap lands on the impact frames still reads it (POP, blocking) at its keyed size, and the same hop without it is clean
//       (a4) a hop keyed over a hurdle higher than its frames can carry it: the arc would enter the hurdle, so the flight
//       keeps its frames and fixed.ballistic.skipped says how far off, what it entered and the frames it fits; the same
//       hop with the frames, with no hurdle or with an allowance moves. An arc through the floor, or a carried bar's into a post, gets the same; a re-time
//       into a slab overhead is left under fixed.spin.left
//   (b) hips falling at about 2 g while the feet stand (the trip run's fall): DROP, and its hint gives sqrt(2h/g); the
//       same fall while the body turns about the vertical (a pirouette is no turn over): DROP; a stand-up that stops its
//       rise at about 1.8 g with the feet planted (a support cannot pull the body down): DROP, its hint gives v/g
//   (c) the flip skill's back tuck: the angular momentum drift is under SPIN_TOL with fix.spin and over it without; the
//       total turn between takeoff and landing within 10 deg of the keyed turn; the landing clean (QA 0); all of it with a
//       hand on the hip too. The re-timed turn follows the rate the takeoff momentum predicts, (L0 - h) / I, the keyed one does not; the
//       knee poles turn with the root (the same in the body as keyed). A 2 deg overshoot before landing is still re-timed. A rig
//       missing a segment bone is reported under fixed.spin.left, not thrown on. A tucked hop with no turn reads SPIN and the hint says fix.spin
//       has no turn to re-time; h-parkour's keyed pitch turns back in the air and reads SPIN, fix.spin.left and the hint say so
//   (d) a 360 deg spin jump that pulls the arms in mid-air: with fix.spin the body turns faster tucked than open; keyed
//       at an even rate (fix { spin: false }) QA says SPIN and its hint that fix.spin is off. Cut before it lands, fix.spin has no landing and QA still says SPIN
//   (e) the flip and float-fix tests still pass
// Prints PASS/FAIL lines; exits non-zero on a failure.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { compileMotion } from "../../src/motion3/compiler/compile.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { bakeTake } from "../../src/motion3/take.js";
import { peopleOf } from "../../src/motion3/people.js";
import { airRuns } from "../../src/motion3/qa/style.js";
import { flights, runDrift, SPIN_TOL, DROP_LIMIT } from "../../src/motion3/qa/flight-checks.js";
import { isBlocking } from "../../src/motion3/qa/blocking.js";
import { spinFix } from "../../src/motion3/fix/spin.js";
import { rotationVector, momentumOf } from "../../src/motion3/qa/inertia.js";
import { centerOfMass } from "../../src/motion3/qa/com.js";
import { mul, T, rx, ry, rz, apply, add, dot } from "../../src/motion3/compiler/math.js";
import { tiltFrame } from "../../src/motion3/compiler/pose.js";
import { gravityCheck } from "../bench/physics/checks.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const SPEC = "cozyclay.motion-spec.v1", G = 9.81 / 24 ** 2, r3 = x => Math.round(x * 1000) / 1000;
const ease = u => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };
const stand = { skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } };
const sk = skeletonFor("y-bot-tpose"), I = sk.index;
/** The standing pose standIdle keys at the origin: root, ankles and the rest of its channels. */
const pose0 = compileSpec({ schema: SPEC, fps: 24, frames: 4, use: [stand] }, { sk, scene: motionScene([]) }).out.keys.find(k => k.set.root).set;
const ANKLE = pose0.foot_l[1], HIPS = pose0.root[1];
const shift = (v, d) => [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
const flightOf = r => flights(r.out, airRuns(r.out, r.expanded.checks?.supports ?? []));
const kinds = r => new Set(r.qa.groups.map(g => g.kind));

// (a) roof fall back (bench set 07: a 6 x 3 x 6 m building, its top at 3 m, the edge at z = -1.5)
const BUILDING = { id: "building", name: "Building", renderer: "cube", x: 0, y: 0, z: 1.5, rot: 0, rotX: 0, rotZ: 0, scaleX: 6, scaleY: 3, scaleZ: 6, footprint: { width: 1, depth: 1 }, height: 1 }, building = motionScene([BUILDING]);
function roofFall() {
	const top = 3, z0 = -1.3, A = 30, vy = 0.07, vz = -0.06, base = shift(pose0.root, [0, top, z0]);
	const off = { l: [pose0.foot_l[0], ANKLE - HIPS, pose0.foot_l[2]], r: [pose0.foot_r[0], ANKLE - HIPS, pose0.foot_r[2]] };
	const keys = [], at = (f, set) => keys.push({ f, set });
	const feet = (root, dy = 0) => ({ foot_l: shift(root, [off.l[0], off.l[1] + dy, off.l[2]]), foot_r: shift(root, [off.r[0], off.r[1] + dy, off.r[2]]) });
	at(0, { ...pose0, root: base, ...feet(base) });
	at(20, { root: base, ...feet(base), fpitch_l: 0, fpitch_r: 0, aswing_l: 0, aswing_r: 0 });
	at(26, { root: shift(base, [0, -0.12, 0]), ...feet(base), aswing_l: -30, aswing_r: -30 });
	at(A, { root: base, ...feet(base), fpitch_l: 30, fpitch_r: 30, aswing_l: 20, aswing_r: 20 });
	// the flight: the hips on y = y0 + vy t - g t^2 / 2 every frame, the feet riding them (tucked 6 cm), until the ankles reach the floor
	let f = A + 1, root;
	for (;; f++) {
		const t = f - A;
		root = shift(base, [0, vy * t - G * t * t / 2, vz * t]);
		if (root[1] + off.l[1] - 0.06 * ease(t / 4) <= ANKLE) break;
		at(f, { root, ...feet(root, 0.06 * ease(t / 4)), fpitch_l: 30, fpitch_r: 30, aswing_l: 20 + 70 * ease(t / 14), aswing_r: 20 + 70 * ease(t / 14) });
	}
	const land = f, stop = shift([root[0], 0, root[2]], [0, 0.55, vz * 3]), down = { foot_l: [root[0] + off.l[0], ANKLE, root[2] + off.l[2]], foot_r: [root[0] + off.r[0], ANKLE, root[2] + off.r[2]] };
	at(land, { root: [root[0], root[1], root[2]], ...down, fpitch_l: 0, fpitch_r: 0 });
	at(land + 6, { root: stop, ...down, aswing_l: 40, aswing_r: 40 });
	at(land + 30, { root: stop, ...down, aswing_l: 0, aswing_r: 0 });
	return { spec: { schema: SPEC, fps: 24, frames: land + 32, keys }, keyed: Object.fromEntries(keys.map(k => [k.f, k.set.root])), A, land };
}
{
	const { spec, keyed, A, land } = roofFall(), compile = fix => compileSpec(fix ? { ...structuredClone(spec), fix } : structuredClone(spec), { sk, scene: building });
	const r = compile(), off = compile({ ballistic: false, spin: false }), fl = flightOf(r);
	const run = fl.find(([a, b]) => a <= A + 3 && b >= land - 3);
	expect("(a) roof fall: the air frames are one flight from takeoff to landing", Boolean(run), JSON.stringify(fl));
	const [a, b] = run ?? [A + 1, land - 1], hips = f => r.out.frames[f].s.P[I.Hips][1];
	const keyErr = Math.max(...Array.from({ length: b - a + 1 }, (_, i) => Math.abs(hips(a + i) - keyed[a + i][1])));
	expect(`(a) roof fall: the hips stay within 0.05 m of their exact 1 g keys over f${a}-f${b} (worst ${r3(keyErr)} m)`, keyErr < 0.05, r3(keyErr));
	const m = { frames: r.out.frames.map(fr => ({ com: centerOfMass(sk, fr.s) })) }, grav = gravityCheck(m, [a - 1, b]);
	expect(`(a) roof fall: the bench scorer's gravity error is under 0.05 m and the horizontal speed stays (${r3(grav.error)} m, speed change ${r3(grav.speedChange)} m/s)`, grav.error < 0.05 && Math.abs(grav.speedChange) < 0.05, JSON.stringify(grav));
	expect(`(a) roof fall: retime leaves the air frames f${a}-f${b} as keyed (the time map is the identity there; it stretched ${r.fixed.retime?.maxStretch ?? 1}x elsewhere)`, !r.out.timeMap || Array.from({ length: b - a + 1 }, (_, i) => a + i).every(f => Math.abs(r.out.timeMap(f) - f) < 1e-9), JSON.stringify(r.fixed.retime));
	expect("(a) roof fall: output.fixed.ballistic reports the run, its frames and the worst move", r.fixed.ballistic?.runs >= 1 && r.fixed.ballistic.frames >= b - a + 1 && r.fixed.ballistic.max >= 0 && Array.isArray(r.fixed.ballistic.at), JSON.stringify(r.fixed.ballistic));
	const pen = new Set(["REACH", "COLLIDE", "GROUND", "BODY"]), added = [...kinds(r)].filter(k => pen.has(k) && !kinds(off).has(k));
	expect("(a) roof fall: no new REACH or penetration (COLLIDE, GROUND, BODY) against the same take with the flight fixes off", added.length === 0, JSON.stringify(r.qa.groups.map(g => `${g.kind} ${g.subject}`)));
	expect("(a) roof fall: no DROP or SPIN on the fall, no KEY for the keys the fix moved it off", !kinds(r).has("DROP") && !kinds(r).has("SPIN") && !kinds(r).has("KEY"), JSON.stringify(r.qa.groups.map(g => `${g.kind} ${g.subject} f${g.first}-${g.last}`)));
}

/** The worst distance from 1 g (in g) of a point's fall (y per frame) over frames from..to of a compiled take. */
const fallError = (y, from, to) => {
	return Math.max(...Array.from({ length: to - from + 1 }, (_, i) => from + i).map(f => Math.abs(-(y(f + 1) - 2 * y(f) + y(f - 1)) / G - 1)));
};
const untimed = (r, from, to) => !r.out.timeMap || Array.from({ length: to - from + 1 }, (_, i) => from + i).every(f => Math.abs(r.out.timeMap(f) - f) < 1e-9);

// (a) a hand on what cannot carry the body keeps the flight; on what can, it ends the arc and still keeps retime out
{
	const { spec, A, land } = roofFall(), ball = { id: "ball", name: "Ball", renderer: "cube", x: 0.5, y: 3.2, z: -1, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.1, scaleY: 0.1, scaleZ: 0.1, footprint: { width: 1, depth: 1 }, height: 1 };
	const bSpec = { schema: SPEC, fps: 24, frames: 120, use: [{ skill: "standIdle", f0: 0, args: { at: [1, -1], heading: 0, until: 119 } }] };
	const takeB = bakeTake(sk, compileSpec(bSpec, { sk, scene: motionScene([]) }).out, { position: [1, 0, -1], yaw: 0 }, { spec: bSpec });
	const people = peopleOf([{ id: "b", subject: "B", model: "y-bot-tpose", x: 1, y: 0, z: -1, rot: 0 }, { id: "a", model: "y-bot-tpose" }], "a", id => (id === "b" ? takeB : null));
	const scene2 = { ...motionScene([BUILDING, ball]), people }, hold = { kind: "object", object: "ball", local: [0, 0, 0] };
	const prop = { p: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: {} } };
	const cases = {
		hip: { anchors: { on: { kind: "body", p: [-0.2, 0, 0.08] } }, side: "r", free: true },
		thigh: { anchors: { on: { kind: "bone", bone: "RightUpLeg", offset: [-0.1, -0.1, 0.1] } }, side: "r", free: true },
		"carried object": { anchors: { on: hold }, side: "l", props: prop, objects: { ball: { prop: "p" } }, free: true },
		"world point": { anchors: { on: { kind: "world", p: [0.3, 1, -1.5] } }, side: "r", free: false },
		person: { anchors: { on: { kind: "person", person: "b", bone: "LeftArm" } }, side: "r", free: false },
		"resting object": { anchors: { on: hold }, side: "r", free: false },
	};
	for (const [name, { anchors, side, props, objects, free }] of Object.entries(cases)) {
		const keys = spec.keys.map((k, i) => (i === 0 ? { ...k, set: { ...k.set, [`armw_${side}`]: 1, [`w_on_${side}`]: 1 } } : k));
		const r = compileSpec({ ...structuredClone(spec), keys: structuredClone(keys), anchors, ...(props ? { props } : {}), ...(objects ? { objects } : {}) }, { sk, scene: scene2 }), fl = flightOf(r);
		const air = airRuns(r.out, []).find(([a, b]) => a <= A + 3 && b >= land - 3) ?? [A + 1, land - 1], err = fallError(f => centerOfMass(sk, r.out.frames[f].s)[1], air[0] + 1, air[1] - 1);
		expect(`(a) roof fall, a hand on a ${name}: ${free ? "the flight stays and the centre of mass falls at 1 g" : "no flight, no arc"}`, free ? fl.length === 1 && r.fixed.ballistic?.frames >= 20 && err < 0.01 : fl.length === 0 && !r.fixed.ballistic, JSON.stringify({ fl, b: r.fixed.ballistic?.at, err }));
		expect(`(a) roof fall, a hand on a ${name}: retime leaves the air frames as keyed`, untimed(r, air[0], air[1]), JSON.stringify(r.fixed.retime));
	}
}

// (a) the same roof fall cut before it lands: no landing frame, so no arc, and retime still has no business in the air
for (const cut of [40, 45, 50]) {
	const { spec, A } = roofFall(), keys = spec.keys.filter(k => k.f <= cut);
	const r = compileSpec({ ...structuredClone(spec), frames: cut + 1, keys: structuredClone(keys) }, { sk, scene: building }), run = airRuns(r.out, []).at(-1), err = fallError(f => r.out.frames[f].s.P[I.Hips][1], A + 3, cut - 1);
	expect(`(a) roof fall cut at f${cut}: the air run reaches the take's end and is no flight`, run?.[1] === cut && flightOf(r).length === 0 && !r.fixed.ballistic, JSON.stringify({ run, fl: flightOf(r) }));
	expect(`(a) roof fall cut at f${cut}: retime leaves the air frames as keyed and the hips keep their keyed 1 g`, untimed(r, A + 1, cut) && err < 0.01, JSON.stringify({ retime: r.fixed.retime, err }));
}

// (a) bench-handstand-r3: the first solve has no air run at f21-f27, a later fix makes one, and retime moved all of its frames
// (stretch 1.6). The fixes start again with that run's key interval kept as keyed. Retime does not count the frames whose
// acceleration reads a held velocity (f32 and f33 read the landing): counting them left 2 frames too fast and stretched f32-f52
// until a planted foot missed its f45 key by 17 cm (KEY). The take as sent keeps its keyed air timing on both rigs, with QA no
// worse than at 28ad5074 (Y Bot 368, X Bot 371), and so does the X Bot with checks.limits.accCore 0.03
{
	const raw = JSON.parse(readFileSync(fileURLToPath(new URL("fixtures/bench-handstand-r3-spec.json", import.meta.url)), "utf8")), spec = raw.spec ?? raw;
	const runsOf = r => airRuns(r.out, r.expanded.checks?.supports ?? []).filter(([a, b]) => b - a >= 3);
	const held = compileSpec({ ...structuredClone(spec), checks: { ...spec.checks, limits: { ...spec.checks?.limits, accCore: 0.03 } } }, { sk: skeletonFor("x-bot-tpose"), scene: motionScene([]) });
	const runs = runsOf(held);
	expect(`(a) bench-handstand-r3 (X Bot, accCore 0.03): retime leaves every air run of the final take as keyed (${JSON.stringify(runs)}; ${held.fixed.retime?.air})`, runs.length === 2 && runs.every(([a, b]) => untimed(held, a - 1, b + 1)) && /^kept the key intervals of f23-f29, f196-f202/.test(held.fixed.retime?.air ?? ""), JSON.stringify({ runs, retime: held.fixed.retime }));
	for (const [rig, from, total] of [["y-bot-tpose", "f22-f29", 368], ["x-bot-tpose", "f21-f29", 371]]) {
		const r = compileSpec(structuredClone(spec), { sk: skeletonFor(rig), scene: motionScene([]) }), rr = runsOf(r);
		expect(`(a) bench-handstand-r3 as sent (${rig}): every air run of the final take keeps its keyed timing (${JSON.stringify(rr)}; ${r.fixed.retime?.air}), no KEY, QA ${r.qa.total} <= ${total}`, rr.length === 2 && rr.every(([a, b]) => untimed(r, a - 1, b + 1)) && new RegExp(`^kept the key intervals of ${from} as keyed`).test(r.fixed.retime?.air ?? "") && r.fixed.retime?.stillFast === 0 && !kinds(r).has("KEY") && r.qa.total <= total, JSON.stringify({ rr, retime: r.fixed.retime }));
	}
}

// (a2) a keyed flight past the apex limit: a 0.9 m hop held high from takeoff to landing, 0.77 m off its parabola
{
	const A = 30, B = 58, off = l => [pose0[`foot_${l}`][0], pose0[`foot_${l}`][1] - pose0.root[1], pose0[`foot_${l}`][2]], keys = [{ f: 0, set: { ...pose0 } }, { f: A - 8, set: { root: pose0.root } }];
	for (let f = A; f <= B; f++) {
		const y = f === A || f === B ? 0 : 0.9 * Math.sin(Math.PI * (f - A) / (B - A)) ** 0.3, root = shift(pose0.root, [0, y, 0]);
		keys.push({ f, set: { root, foot_l: shift(root, off("l")), foot_r: shift(root, off("r")) } });
	}
	keys.push({ f: B + 15, set: { root: pose0.root } });
	const compile = fix => compileSpec({ schema: SPEC, fps: 24, frames: B + 17, keys: structuredClone(keys), ...(fix ? { fix } : {}) }, { sk, scene: motionScene([]) });
	const on = compile(), off2 = compile({ ballistic: false, spin: false }), y = (r, f) => r.out.frames[f].s.P[I.Hips][1];
	const moved = Math.max(...Array.from({ length: B - A + 1 }, (_, i) => Math.abs(y(on, A + i) - y(off2, A + i)))), past = on.fixed.ballistic?.skipped?.[0];
	expect(`(a2) past the apex limit: fixed.ballistic.skipped gives how far off (${past?.off} m), the apex (${past?.apex} m) and the frames it fits (${past?.fits}), and the hips stay as keyed`, past?.off > 0.5 && past.apex > 0 && past.fits > 0 && on.fixed.ballistic.runs === 0 && moved < 1e-9, JSON.stringify({ b: on.fixed.ballistic, moved }));
}

// (a3) the bench-2 vault: the fix moved f36-f46, QA's own reading of the air frames starts a frame earlier once its hands
// have left their plant. Measured at 3804b63b: no blocking group, 13 issues.
{
	const vault = JSON.parse(readFileSync(new URL("./fixtures/parkour-vault-spec.json", import.meta.url), "utf8"));
	const r = compileSpec(vault, { sk, scene: motionScene([]) }), moved = r.out.flightRuns ?? [], list = gs => gs.map(g => `${g.kind} ${g.subject} ${g.worst}`);
	const blocking = r.qa.groups.filter(g => isBlocking(g));
	expect("(a3) parkour vault: flightFixes records the run it moved, whatever QA reads there afterwards", JSON.stringify(moved) === "[[36,46]]" && flightOf(r)[0]?.[0] !== 36, JSON.stringify({ moved, read: flightOf(r) }));
	// its keyed knee pops at the push-off (22 cm/f^2 at f36) stand at their keyed size, not the 25 cm/f^2 (blocking) the arc's push-off adds to them
	const keyed = compileSpec({ ...vault, fix: { ...vault.fix, ballistic: false, spin: false } }, { sk, scene: motionScene([]) }), pops = q => JSON.stringify(list(q.qa.groups.filter(g => g.kind === "POP")));
	expect("(a3) parkour vault: the POPs are the keyed take's (its push-off knees at their keyed size), no blocking group, no more issues than the 13 of the baseline", pops(r) === pops(keyed) && blocking.length === 0 && r.qa.total <= 13, JSON.stringify({ total: r.qa.total, blocking: list(blocking), all: list(r.qa.groups), keyed: pops(keyed) }));
}

// (a3) a 0.3 m hop, f30-f44, its arms keyed to snap 100 deg in one frame at f39: the overlap layer lands the hands' pop on f44-f45,
// the frames after landing the fix leaves to its impact. The snap is keyed, not the fix's: POP still reads it, blocking, at its keyed size
{
	const A = 30, N = 14, off = l => [pose0[`foot_${l}`][0], pose0[`foot_${l}`][1] - HIPS, pose0[`foot_${l}`][2]], on = () => ({ root: pose0.root, foot_l: pose0.foot_l, foot_r: pose0.foot_r });
	const up = y => { const root = shift(pose0.root, [0, y, 0]); return { root, foot_l: shift(root, shift(off("l"), [0, 0.02, 0])), foot_r: shift(root, shift(off("r"), [0, 0.02, 0])) }; };
	const hop = (snap, fix) => {
		const keys = [{ f: 0, set: { ...pose0 } }, { f: 20, set: on() }, { f: 26, set: { ...on(), root: shift(pose0.root, [0, -0.12, 0]) } }, { f: A, set: on() }, { f: A + 7, set: up(0.3) }, { f: A + N, set: on() }, { f: A + N + 6, set: { ...on(), root: shift(pose0.root, [0, -0.1, 0]) } }, { f: A + N + 16, set: on() }];
		if (snap) keys.push({ f: 39, set: { aswing_l: 0, aswing_r: 0 } }, { f: 40, set: { aswing_l: 100, aswing_r: 100 } }, { f: 41, set: { aswing_l: 100, aswing_r: 100 } });
		return compileSpec({ schema: SPEC, fps: 24, frames: A + N + 20, keys: keys.sort((p, q) => p.f - q.f), fix }, { sk, scene: motionScene([]) });
	};
	const r = hop(true, { retime: false }), keyed = hop(true, { retime: false, ballistic: false, spin: false }), plain = hop(false, { retime: false });
	const hand = q => q.qa.groups.find(g => g.kind === "POP" && /^LeftHand /.test(g.subject)), [, b] = r.out.flightRuns?.[0] ?? [0, 0], g = hand(r);
	expect(`(a3) a keyed arm snap on the impact frames f${b + 1}-f${b + 3} of a moved flight: POP LeftHand still reads it, blocking, at its keyed size (${g?.worst} at f${g?.first}-f${g?.last}, keyed ${hand(keyed)?.worst})`,
		r.out.flightRuns?.length === 1 && g && isBlocking(g) && g.worst === hand(keyed)?.worst && g.first > b && g.last <= b + 3 && !r.qa.ok, JSON.stringify({ runs: r.out.flightRuns, groups: r.qa.groups.map(x => `${x.kind} ${x.subject} f${x.first}-${x.last}`) }));
	expect("(a3) the same hop without the snap: moved by the arc and QA clean (its push-off and impact read no POP)", plain.out.flightRuns?.length === 1 && plain.qa.total === 0, JSON.stringify(plain.qa.groups.map(x => `${x.kind} ${x.subject} f${x.first}`)));
}

// (a4) a hop over a 0.1 m thick hurdle, sparse keys, the feet riding the hips: keyed over a clean 0.6 m apex in 14 frames, whose arc allows 0.417 m
const HOP_A = 30;
function hurdleHop(apex, N, H, fix, checks, people, more = {}) {
	const span = 1, z0 = -span / 2, z1 = span / 2, B = HOP_A + N, off = l => [pose0[`foot_${l}`][0], pose0[`foot_${l}`][1] - HIPS, pose0[`foot_${l}`][2]];
	const on = z => { const root = shift(pose0.root, [0, 0, z]); return { root, foot_l: shift(pose0.foot_l, [0, 0, z]), foot_r: shift(pose0.foot_r, [0, 0, z]) }; };
	const up = (y, z) => { const root = shift(pose0.root, [0, y, z]); return { root, foot_l: shift(root, shift(off("l"), [0, 0.02, 0])), foot_r: shift(root, shift(off("r"), [0, 0.02, 0])) }; };
	const low = (z, y) => ({ ...on(z), root: shift(pose0.root, [0, y, z]) });
	const keys = [{ f: 0, set: { ...pose0, ...on(z0) } }, { f: 20, set: on(z0) }, { f: 26, set: low(z0, -0.12) }, { f: HOP_A, set: on(z0) }, { f: HOP_A + Math.round(N / 2), set: up(apex, (z0 + z1) / 2) }, { f: B, set: on(z1) }, { f: B + 6, set: low(z1, -0.1) }, { f: B + 20, set: on(z1) }];
	const box = H > 0 ? [{ id: "hurdle", name: "Hurdle", renderer: "cube", x: 0, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 1.2, scaleY: H, scaleZ: 0.1, footprint: { width: 1, depth: 1 }, height: 1 }] : [];
	return compileSpec({ schema: SPEC, fps: 24, frames: B + 22, keys, ...(fix ? { fix } : {}), ...(checks ? { checks } : {}), ...more.spec }, { sk, scene: { ...motionScene([...box, ...(more.boxes ?? [])]), ...(people ? { people } : {}) } });
}
{
	const keyed = hurdleHop(0.6, 14, 0.5, { ballistic: false, spin: false }), r = hurdleHop(0.6, 14, 0.5), past = r.fixed.ballistic?.skipped?.[0], list = q => q.qa.groups.map(g => `${g.kind} ${g.subject} ${g.worst}`), y = (q, f) => q.out.frames[f].s.P[I.Hips][1];
	const moved = Math.max(...r.out.frames.map((_, f) => Math.abs(y(r, f) - y(keyed, f))));
	expect(`(a4) a hop over a hurdle, keyed clean: the arc would enter it, so the flight keeps its frames (hips moved ${moved} m, QA ${keyed.qa.total} -> ${r.qa.total}, no COLLIDE)`, keyed.qa.total === 0 && r.qa.total === 0 && moved < 1e-9 && r.fixed.ballistic?.runs === 0 && !r.out.flightRuns?.length, JSON.stringify({ moved, b: r.fixed.ballistic, on: list(r), off: list(keyed) }));
	expect(`(a4) fixed.ballistic.skipped says what the arc entered (${past?.into}, ${past?.depth} m), how far off (${past?.off} m), the apex (${past?.apex} m) and the frames it fits (${past?.fits})`, past?.into?.includes("foot_l x hurdle") && past.depth > 0.01 && past.off > 0.1 && Math.abs(past.apex - 0.417) < 0.001 && past.fits > 14 && past.at === "f31-f43", JSON.stringify(past));
	const longer = hurdleHop(0.55, 22, 0.5), bare = hurdleHop(0.6, 14, 0), allowed = hurdleHop(0.6, 14, 0.5, null, { allow: ["foot", "shin", "thigh"].map(part => ({ part, object: "hurdle", depth: 0.5 })) });
	expect(`(a4) the same hurdle with the frames its apex needs: the arc clears it (moved ${longer.fixed.ballistic?.max} m, QA ${longer.qa.total})`, longer.fixed.ballistic?.runs === 1 && !longer.fixed.ballistic.skipped && longer.qa.total === 0, JSON.stringify({ b: longer.fixed.ballistic, qa: list(longer) }));
	expect("(a4) the same hop with no hurdle, or with checks.allow for it: the arc moves it, the gate reads what QA reads", bare.fixed.ballistic?.runs === 1 && !bare.fixed.ballistic.skipped && allowed.fixed.ballistic?.runs === 1 && !allowed.fixed.ballistic.skipped, JSON.stringify({ bare: bare.fixed.ballistic, allowed: allowed.fixed.ballistic }));
	// the same hop with no hurdle and a goal at its keyed apex: the arc (0.19 m lower) would miss it, so the flight keeps its frames (pipeline.js keptRetime's rule)
	const mark = { id: "mark", name: "Mark", renderer: "cube", x: 3, y: 0, z: 3, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.1, scaleY: 0.1, scaleZ: 0.1, footprint: { width: 1, depth: 1 }, height: 1 };
	const goal = need => ({ spec: { goals: [{ name: "high", above: ["joint:Hips", "object:mark"], by: need, at: [HOP_A + 7, HOP_A + 7] }] }, boxes: [mark] });
	const kept = hurdleHop(0.6, 14, 0, null, null, null, goal(1.45)), keyedGoal = hurdleHop(0.6, 14, 0, { ballistic: false, spin: false }, null, null, goal(1.45)), low = hurdleHop(0.6, 14, 0, null, null, null, goal(1.2));
	const g = q => q.qa.goals?.[0], lost = kept.fixed.ballistic?.skipped?.[0];
	expect(`(a4) a goal the keyed apex meets (hips ${g(keyedGoal)?.value} m over the mark, needs 1.45): the arc would lose it, so the flight keeps its frames (${g(kept)?.value} m, met ${g(kept)?.ok}, QA ${kept.qa.total}; skipped lost ${lost?.lost})`,
		g(keyedGoal)?.ok && g(kept)?.ok && g(kept).value === g(keyedGoal).value && kept.qa.total === 0 && kept.fixed.ballistic?.runs === 0 && JSON.stringify(lost?.lost) === '["high"]', JSON.stringify({ b: kept.fixed.ballistic, goals: kept.qa.goals }));
	expect(`(a4) a goal the arc still meets (needs 1.2): the flight rides the arc (${g(low)?.value} m, met ${g(low)?.ok})`, low.fixed.ballistic?.runs === 1 && !low.fixed.ballistic.skipped && g(low)?.ok && low.qa.total === 0, JSON.stringify({ b: low.fixed.ballistic, goals: low.qa.goals }));
}

// (a4) a character standing under the hop: the arc would take the body deeper into them, so the flight keeps its frames
{
	const spec = { schema: SPEC, fps: 24, frames: 80, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0, until: 79 } }] };
	const take = bakeTake(sk, compileSpec(spec, { sk, scene: motionScene([]) }).out, { position: [0, 0, 0], yaw: 0 }, { spec });
	const people = peopleOf([{ id: "b", subject: "B", model: "y-bot-tpose", x: 0, y: 0, z: 0, rot: 0 }, { id: "a", model: "y-bot-tpose" }], "a", id => (id === "b" ? take : null));
	const r = hurdleHop(0.6, 14, 0, null, null, people), keyed = hurdleHop(0.6, 14, 0, { ballistic: false, spin: false }, null, people), past = r.fixed.ballistic?.skipped?.[0];
	expect(`(a4) an arc deeper into a character keeps its frames (${past?.into?.[0]}, ${past?.depth} m; QA ${keyed.qa.total} -> ${r.qa.total})`, /x person:b/.test(past?.into?.join() ?? "") && r.qa.total === keyed.qa.total, JSON.stringify({ b: r.fixed.ballistic, on: r.qa.total, off: keyed.qa.total }));
}

// (a4) the hop carrying a 0.8 m bar in the right hand over a 0.8 m post: the keyed bar clears it, the arc (0.19 m lower) puts it in,
// which only the gate's carried-object reading (qa/object-checks.js) sees: the flight keeps its frames; with no post it moves
{
	const cube = (id, x, y, z, sx, sy, sz) => ({ id, name: id, renderer: "cube", x, y, z, rot: 0, rotX: 0, rotZ: 0, scaleX: sx, scaleY: sy, scaleZ: sz, footprint: { width: 1, depth: 1 }, height: 1 });
	const bar = cube("bar", -0.3, 0.8, -0.5, 0.8, 0.05, 0.05), post = cube("post", -0.29, 0, -0.05, 0.1, 0.8, 0.3);
	const spec = { props: { p: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: {} } }, objects: { bar: { prop: "p" } } };
	const keyed = hurdleHop(0.6, 14, 0, { ballistic: false, spin: false }, null, null, { spec, boxes: [bar, post] }), r = hurdleHop(0.6, 14, 0, null, null, null, { spec, boxes: [bar, post] });
	const free = hurdleHop(0.6, 14, 0, null, null, null, { spec, boxes: [bar] }), past = r.fixed.ballistic?.skipped?.[0];
	expect(`(a4) a carried bar the arc would put into a post: the flight keeps its frames (${past?.into}, ${past?.depth} m; QA ${keyed.qa.total} -> ${r.qa.total}); with no post it moves`,
		JSON.stringify(past?.into) === '["bar x post"]' && r.fixed.ballistic.runs === 0 && keyed.qa.total === 0 && r.qa.total === 0 && free.fixed.ballistic?.runs === 1 && !free.fixed.ballistic.skipped, JSON.stringify({ b: r.fixed.ballistic, free: free.fixed.ballistic, on: r.qa.groups.map(g => g.subject) }));
}

// (a4) legs reaching down from a body keyed high: the arc would put the soles through the floor
{
	const A = 30, N = 8, low = shift(pose0.root, [0, -0.3, 0.05]), keys = [{ f: 0, set: { ...pose0 } }, { f: 20, set: { root: low } }, { f: A, set: { root: low, foot_l: pose0.foot_l, foot_r: pose0.foot_r } }];
	for (let f = A + 1; f < A + N; f++) keys.push({ f, set: { root: shift(low, [0, 0.3 * Math.sin(Math.PI * (f - A) / N), 0]), foot_l: shift(pose0.foot_l, [0, 0.04, 0]), foot_r: shift(pose0.foot_r, [0, 0.04, 0]) } });
	keys.push({ f: A + N, set: { root: low, foot_l: pose0.foot_l, foot_r: pose0.foot_r } }, { f: A + 30, set: { root: pose0.root } });
	const r = compileSpec({ schema: SPEC, fps: 24, frames: A + 32, keys }, { sk, scene: motionScene([]) }), past = r.fixed.ballistic?.skipped?.[0];
	expect(`(a4) an arc through the floor keeps its frames, no GROUND (${past?.into})`, /sole below floor/.test(past?.into?.join() ?? "") && !kinds(r).has("GROUND"), JSON.stringify({ b: r.fixed.ballistic, kinds: [...kinds(r)] }));
}

// (a4) a back tuck under a slab, the arc off: the re-timed arms would go into the slab the keyed turn stays clear of
{
	const slab = { id: "slab", name: "Slab", renderer: "cube", x: 0, y: 2.36, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 4, scaleY: 0.1, scaleZ: 4, footprint: { width: 1, depth: 1 }, height: 1 };
	const flip = fix => compileSpec({ schema: SPEC, fps: 24, frames: "auto", fix, use: [stand, { skill: "flip", f0: 6, args: { kind: "back" } }] }, { sk, scene: motionScene([slab]) });
	const on = flip({ ballistic: false }), off = flip({ ballistic: false, spin: false }), why = on.fixed.spin?.left?.[0]?.why ?? "";
	expect(`(a4) a re-time into a slab is left and reported: ${why}`, /enter .*x slab/.test(why) && on.fixed.spin.runs === 0 && on.qa.total === off.qa.total, JSON.stringify({ spin: on.fixed.spin, on: on.qa.total, off: off.qa.total }));
}

// (a5) a run (bench set 06's trip run: flights of 3 to 4 frames) keyed every frame with its hips level, 3.2 m/s, each foot 5 frames down of 16:
// 3-frame flights FLOAT does not read; the arc moves them (g N^2 / 8: 3.4 cm at most), the centre of mass then falls at 1 g. With the
// feet 4 frames down the flights are 4 frames: FLOAT reads them and its hint stages the fall, so the fixes leave them
function runGait(stance, fix) {
	const step = 8, c0 = 12, v = 3.2 / 24, keys = [{ f: 0, set: { ...pose0 } }], end = c0 + 6 * step + 4, z = f => v * (f - 6) + 0.1;
	const foot = (k, f) => {
		const first = k === "l" ? c0 : c0 + step, x = pose0[`foot_${k}`][0];
		if (f < first) return [x, ANKLE, pose0[`foot_${k}`][2] + v * Math.max(0, f - 6)];
		const c = first + 2 * step * Math.floor((f - first) / (2 * step)), t = (f - c - stance + 1) / (2 * step - stance + 1);
		return f - c < stance ? [x, ANKLE, z(c + stance / 2)] : [x, ANKLE + 0.03 + 0.12 * Math.sin(Math.PI * t), z(c + stance / 2) + (z(c + 2 * step + stance / 2) - z(c + stance / 2)) * t];
	};
	for (let f = 6; f <= end; f++) keys.push({ f, set: { root: [pose0.root[0], HIPS - 0.05, pose0.root[2] + z(f)], foot_l: foot("l", f), foot_r: foot("r", f) } });
	return compileSpec({ schema: SPEC, fps: 24, frames: end + 2, keys, ...(fix ? { fix } : {}) }, { sk, scene: motionScene([]) });
}
{
	const err = r => Math.max(...airRuns(r.out, []).filter(([, q]) => q < r.out.frames.length - 2).map(([p, q]) => fallError(f => centerOfMass(sk, r.out.frames[f].s)[1], p, q)));
	const on = runGait(5), off = runGait(5, { ballistic: false, spin: false }), four = runGait(4), lens = airRuns(on.out, []).map(([p, q]) => q - p + 1);
	expect(`(a5) a run whose flights are 3 frames, hips keyed level: the arc moves all ${on.fixed.ballistic?.runs} (centre of mass ${r3(err(off))} g off 1 g keyed, ${r3(err(on))} g after), no FLOAT`, lens.every(n => n === 3) && on.fixed.ballistic?.runs === lens.length && err(off) > 0.9 && err(on) < 0.01 && !kinds(on).has("FLOAT"), JSON.stringify({ lens, b: on.fixed.ballistic }));
	expect(`(a5) the same run with 4-frame flights: FLOAT reads them, its hint stages the fall, and the fixes leave them`, kinds(four).has("FLOAT") && !four.fixed.ballistic, JSON.stringify({ b: four.fixed.ballistic, kinds: [...kinds(four)] }));
}

// (b) a trip's fall (bench set 06): the feet stay planted while the hips drop 0.35 m at 2 g, then stop at 2 g
{
	const keys = [{ f: 0, set: { ...pose0 } }, { f: 20, set: { root: pose0.root } }], h = 0.35, acc = 2 * G, half = Math.sqrt(h / acc);
	let f = 21;
	for (let t = 1; t <= Math.ceil(2 * half); t++, f++) {
		const s = t <= half ? acc * t * t / 2 : h - acc * (2 * half - t) ** 2 / 2;
		keys.push({ f, set: { root: shift(pose0.root, [0, -Math.min(h, s), 0.3 * Math.min(h, s)]) } });
	}
	keys.push({ f: f + 20, set: { root: shift(pose0.root, [0, -h, 0.3 * h]) } });
	const r = compileSpec({ schema: SPEC, fps: 24, frames: f + 22, keys }, { sk, scene: motionScene([]) }), g = r.qa.groups.find(x => x.kind === "DROP");
	expect(`(b) hips falling at 2 g with the feet planted: DROP (worst ${g ? g.worst : "-"} g, limit ${DROP_LIMIT} g)`, g && g.count >= 2 && g.worst > 1.5, JSON.stringify(r.qa.groups.map(x => `${x.kind} ${x.subject}`)));
	const need = Math.sqrt(2 * h / 9.81), m = /the hips drop ([\d.]+) m over (\d+) frames \(f(\d+)-f(\d+)\).*sqrt\(2h\/g\) = ([\d.]+) s \((\d+) frames\).*at f(\d+) or later/.exec(g?.hint ?? "");
	expect(`(b) the DROP hint gives the drop (${h} m from f20), sqrt(2h/g) = ${r3(need)} s at 1 g, the frame its low point needs, and an earlier hand brace`,
		m && Math.abs(+m[1] - h) < 0.02 && +m[3] === 20 && Math.abs(+m[5] - need) < 0.02 && +m[6] === Math.ceil(need * 24) && +m[7] >= 20 + Math.ceil(need * 24) && /brace/.test(g.hint), g?.hint);
	// the same drop over the frames a fall needs reads clean
	const slow = keys.map(k => (k.f > 20 && k.f <= f ? { f: 20 + (k.f - 20) * 2, set: k.set } : k.f > f ? { f: k.f + f - 20, set: k.set } : k));
	const ok = compileSpec({ schema: SPEC, fps: 24, frames: slow.at(-1).f + 2, keys: slow }, { sk, scene: motionScene([]) });
	expect("(b) the same drop at half the acceleration: no DROP", !kinds(ok).has("DROP"), JSON.stringify(ok.qa.groups.map(x => `${x.kind} ${x.subject} ${x.worst}`)));
	// the same fall while the body turns about the vertical 30 deg a frame: its hips' up axis stays up, no turn over
	const spun = keys.map(k => (k.f > 20 && k.f <= f ? { f: k.f, set: { ...k.set, yaw: 30 * (k.f - 20) } } : k.f > f ? { f: k.f, set: { ...k.set, yaw: 30 * (f - 20) } } : k));
	const pir = compileSpec({ schema: SPEC, fps: 24, frames: f + 22, keys: spun }, { sk, scene: motionScene([]) });
	expect("(b) the same fall turning 30 deg a frame about the vertical: DROP (a pirouette is no turn over)", kinds(pir).has("DROP"), JSON.stringify(pir.qa.groups.map(x => `${x.kind} ${x.subject} ${x.worst}`)));
}

// (b) one key pair's fall: the curve peaks near twice its mean, so the hint's low point is past the keyed one and following it ends DROP
{
	const low = shift(pose0.root, [0, -0.5, 0.1]), fall = at => compileSpec({ schema: SPEC, fps: 24, frames: 70, keys: [{ f: 0, set: { ...pose0 } }, { f: 20, set: { root: pose0.root } }, { f: at, set: { root: low } }, { f: 68, set: { root: low } }] }, { sk, scene: motionScene([]) });
	const g = fall(28).qa.groups.find(x => x.kind === "DROP"), at = +(/at f(\d+) or later/.exec(g?.hint ?? "")?.[1] ?? 0), next = at ? fall(at) : null;
	expect(`(b) a 0.5 m fall keyed over 8 frames: DROP's hint asks for a low point past f28 (f${at}), and keyed there the DROP is gone`, at > 28 && next && !kinds(next).has("DROP"), JSON.stringify({ hint: g?.hint, next: next && [...kinds(next)] }));
}

// (b) a single frame's step in the hips is one frame over the limit: no DROP (2 frames or more)
{
	const keys = [{ f: 0, set: { ...pose0 } }];
	for (let f = 16; f <= 26; f++) keys.push({ f, set: { root: shift(pose0.root, [0, f <= 20 ? 0 : -0.03, 0]) } });
	keys.push({ f: 40, set: { root: shift(pose0.root, [0, -0.03, 0]) } });
	const r = compileSpec({ schema: SPEC, fps: 24, frames: 42, keys, fix: { retime: false } }, { sk, scene: motionScene([]) }), acc = f => -(r.out.frames[f + 1].s.P[I.Hips][1] - 2 * r.out.frames[f].s.P[I.Hips][1] + r.out.frames[f - 1].s.P[I.Hips][1]) / G;
	const over = r.out.frames.slice(1, -1).map((_, i) => i + 1).filter(f => acc(f) > DROP_LIMIT);
	expect(`(b) hips over ${DROP_LIMIT} g on one frame only (${over}): no DROP`, over.length === 1 && !kinds(r).has("DROP"), JSON.stringify({ over, kinds: [...kinds(r)] }));
}

// (b) a stand-up from a 0.3 m squat rising at 0.06 m a frame that stops on its top in two frames, the feet planted
{
	const low = shift(pose0.root, [0, -0.3, 0.05]), keys = [{ f: 0, set: { ...pose0, root: low } }, { f: 20, set: { root: low } }];
	[-0.3, -0.27, -0.21, -0.15, -0.09, -0.03, 0, 0, 0, 0].forEach((y, i) => keys.push({ f: 21 + i, set: { root: shift(pose0.root, [0, y, 0.05]) } }));
	keys.push({ f: 60, set: { root: pose0.root } });
	const r = compileSpec({ schema: SPEC, fps: 24, frames: 62, keys }, { sk, scene: motionScene([]) }), g = r.qa.groups.find(x => x.kind === "DROP");
	expect(`(b) a rise braked at about 1.8 g with the feet planted: DROP (worst ${g ? g.worst : "-"} g)`, g && g.count >= 2 && g.worst > 1.5 && /stop rising/.test(g.subject), JSON.stringify(r.qa.groups.map(x => `${x.kind} ${x.subject} ${x.worst}`)));
	const m = /stop a rise of ([\d.]+) m\/s .*v\/g = ([\d.]+) s \((\d+) frames\)/.exec(g?.hint ?? ""), v = 0.06 * 24;
	expect(`(b) the rise's DROP hint gives the speed (${v} m/s) and v/g = ${r3(v / 9.81)} s at 1 g`, m && Math.abs(+m[1] - v) < 0.05 && Math.abs(+m[2] - v / 9.81) < 0.01 && +m[3] === Math.ceil(v / 9.81 * 24), g?.hint);
}

// (c) the flip skill's back tuck, on and off fix.spin
{
	const flip = fix => compileSpec({ schema: SPEC, fps: 24, frames: "auto", use: [stand, { skill: "flip", f0: 6, args: { kind: "back" } }], ...(fix ? { fix } : {}) }, { sk, scene: motionScene([]) });
	const on = flip(), off = flip({ spin: false }), [a, b] = flightOf(on)[0] ?? [0, 0], [a0, b0] = flightOf(off)[0] ?? [0, 0];
	const dOn = runDrift(on.out, a, b), dOff = runDrift(off.out, a0, b0);
	expect(`(c) back tuck with fix.spin: the angular momentum drift ${r3(dOn)} is under SPIN_TOL ${SPIN_TOL}, no SPIN`, dOn < SPIN_TOL && !kinds(on).has("SPIN"), JSON.stringify({ dOn, groups: on.qa.groups.map(g => g.kind) }));
	expect(`(c) back tuck with fix { spin: false }: the drift ${r3(dOff)} is over SPIN_TOL and QA says SPIN`, dOff > SPIN_TOL && kinds(off).has("SPIN"), JSON.stringify({ dOff, groups: off.qa.groups.map(g => g.kind) }));
	const turned = (r, A, B) => { let s = 0; for (let f = A + 1; f <= B; f++) s += rotationVector(mul(r.out.frames[f].s.R[I.Hips], T(r.out.frames[f - 1].s.R[I.Hips])))[0]; return (s * 180) / Math.PI; };
	const keyedTurn = off.out.baked.pitch[b + 1] - off.out.baked.pitch[a - 1], got = turned(on, a - 1, b + 1);
	// pitch is a turn about +x (rx); a back tuck turns about -x
	expect(`(c) back tuck: the total turn from takeoff to landing (${r3(got)} deg) is within 10 deg of the keyed turn (${r3(keyedTurn)} deg)`, Math.abs(got - keyedTurn) < 10, `${got} vs ${keyedTurn}`);
	expect("(c) back tuck: the landing is clean (QA 0) and output.fixed.spin reports frames, the worst re-time and the drift", on.qa.total === 0 && on.fixed.spin?.frames >= b - a + 1 && on.fixed.spin.max > 0 && on.fixed.spin.drift?.[1] < on.fixed.spin.drift?.[0],
		JSON.stringify({ groups: on.qa.groups.map(g => `${g.kind} ${g.subject}`), spin: on.fixed.spin }));
	// the takeoff momentum predicts the turn: about the keyed turn's axis n, L_n = h + I w stays the value of the first air frame, so w = (L_n - h) / I
	const turnOf = (q, f) => mul(ry(q.out.baked.yaw?.[f] ?? 0), mul(rx(q.out.baked.pitch?.[f] ?? 0), rz(q.out.baked.roll?.[f] ?? 0)));
	const n = (v => v.map(x => x / Math.hypot(...v)))(Array.from({ length: b - a + 2 }, (_, i) => rotationVector(mul(turnOf(off, a + i), T(turnOf(off, a + i - 1))))).reduce((s, v) => add(s, v), [0, 0, 0]));
	const predicted = q => {
		const rows = Array.from({ length: b - a - 1 }, (_, i) => { const f = a + 1 + i, m = momentumOf(sk, q.out.frames, f, 24), In = dot(apply(m.J, n), n), w = dot(rotationVector(mul(turnOf(q, f + 1), T(turnOf(q, f - 1)))), n) * 12; return { L: dot(m.L, n), In, w }; });
		return Math.max(...rows.map(({ L, In, w }) => { const p = (rows[0].L - (L - In * w)) / In; return Math.abs(w - p) / Math.abs(p); }));
	};
	const [pOn, pOff] = [predicted(on), predicted(off)];
	expect(`(c) back tuck: the re-timed turn rate is within 20% of what the takeoff momentum predicts every air frame (worst ${r3(pOn)}), the keyed one is not (${r3(pOff)})`, pOn < 0.2 && pOff > 0.4, JSON.stringify({ pOn, pOff }));
	// the knee poles turn with the root: in the body's frame (the root's turn, pose.js's pole frame) they stay as keyed while their world direction moves
	const poleFrame = (q, f) => tiltFrame(q.out.baked.yaw?.[f] ?? 0, q.out.baked.pitch?.[f] ?? 0, q.out.baked.roll?.[f] ?? 0)?.R ?? ry(q.out.baked.yaw?.[f] ?? 0);
	const angle = (u, v) => (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / Math.hypot(...u) / Math.hypot(...v)))) * 180) / Math.PI;
	let inBody = 0, inWorld = 0;
	for (const ch of ["knee_l", "knee_r"]) for (let f = a; f <= b; f++) {
		const world = q => apply(poleFrame(q, f), q.out.baked[ch][f]);
		inBody = Math.max(inBody, angle(apply(T(turnOf(on, f)), world(on)), apply(T(turnOf(off, f)), world(off))));
		inWorld = Math.max(inWorld, angle(world(on), world(off)));
	}
	expect(`(c) back tuck: the knee poles turn with the root (in the body ${inBody.toExponential(1)} deg off keyed, in the world up to ${r3(inWorld)} deg)`, inBody < 1e-3 && inWorld > 5, JSON.stringify({ inBody, inWorld }));
	// the feet keep their aim in the body: each ankle's bend against the rest pose as keyed, frame by frame (a toe the tilt frame reads
	// past straight down rolls the foot over, near 180 deg, on the keyed frames as well: those frames are left out)
	const ankle = (q, f, S) => { const L = I[`${S}Leg`], F = I[`${S}Foot`], R0 = sk.restWorldRot, s = q.out.frames[f].s; return (Math.hypot(...rotationVector(mul(mul(T(s.R[L]), s.R[F]), T(mul(T(R0[L]), R0[F]))))) * 180) / Math.PI; };
	let flick = 0;
	for (const S of ["Left", "Right"]) for (let f = a - 1; f <= b + 1; f++) if (Math.max(ankle(on, f, S), ankle(off, f, S)) < 90) flick = Math.max(flick, Math.abs(ankle(on, f, S) - ankle(off, f, S)));
	expect(`(c) back tuck: the ankles bend as keyed in the air (worst ${r3(flick)} deg off; fpitch read against the old tilt: 33 deg)`, flick < 3, flick);
	// fix.spin turns the body about its hips, which moves the centre of mass: the second arc puts it back on the parabola
	const comFall = fallError(f => centerOfMass(sk, on.out.frames[f].s)[1], a + 1, b - 1);
	expect(`(c) back tuck: after fix.spin the centre of mass still falls at 1 g (off by ${r3(comFall)} g)`, comFall < 0.01, comFall);
	// the landing's one-frame POP goes unread only on a flight the ballistic fix moved
	const kept = flip({ ballistic: false });
	expect("(c) back tuck with fix { ballistic: false }: the landing reads POP (only a flight the ballistic fix moved is exempt)", kinds(kept).has("POP") && !kinds(on).has("POP"), JSON.stringify(kept.qa.groups.map(g => `${g.kind} ${g.subject} f${g.first}`)));
}

// (c) the back tuck with an open head_pitch keyed f36-f43, after the flight: search compiles only the frames a parameter changes, and
// that window (f25-f51) cut the flight f22-f35, a take with no takeoff, hips 0.308 m off and SPIN, so search spent 21 compiles on a
// cost the whole take does not have. The window holds every air run it reaches, 8 frames past each end
{
	const spec = { schema: SPEC, fps: 24, frames: "auto", use: [stand, { skill: "flip", f0: 6, args: { kind: "back" } }], keys: [{ f: 36, set: { head_pitch: 0 } }, { f: 38, set: { head_pitch: { range: [-10, 10] } } }, { f: 43, set: { head_pitch: 0 } }] };
	const r = compileSpec(structuredClone(spec), { sk, scene: motionScene([]) }), w = r.search?.window ?? [0, 0], [a, b] = flightOf(r)[0] ?? [0, 0];
	const out = compileMotion({ fps: 24, ...r.expanded }, { sk, scene: motionScene([]) }, { window: w }), off = Math.max(...out.frames.map((q, i) => Math.hypot(...[0, 1, 2].map(k => q.s.P[I.Hips][k] - r.out.frames[w[0] + i].s.P[I.Hips][k]))));
	expect(`(c) back tuck with an open head_pitch after the flight: search's window f${w[0]}-f${w[1]} holds the flight f${a}-f${b}, its trial reads the whole take's hips (${off.toExponential(1)} m off) and costs ${r.search?.cost} in ${r.search?.evals} compile`,
		w[0] <= a - 8 && w[1] >= b + 8 && off < 1e-9 && r.search?.cost === 0 && r.search.evals === 1 && r.qa.total === 0, JSON.stringify({ search: r.search, flight: [a, b] }));
}

// (c) the same back tuck with the right hand on its own hip: the hand rides the body, so the flight and SPIN stay
{
	const anchors = { hipR: { kind: "body", p: [-0.2, 0, 0.08] } }, base = { schema: SPEC, fps: 24, frames: "auto", anchors, use: [stand, { skill: "flip", f0: 6, args: { kind: "back" } }] };
	const n = compileSpec(structuredClone(base), { sk, scene: motionScene([]) }).out.frames.length, keys = Array.from({ length: Math.floor(n / 2) }, (_, i) => ({ f: i * 2, set: { armw_r: 1, w_hipR_r: 1 } }));
	const flip = fix => compileSpec({ ...structuredClone(base), keys: structuredClone(keys), ...(fix ? { fix } : {}) }, { sk, scene: motionScene([]) });
	const on = flip(), off = flip({ spin: false });
	expect("(c) back tuck, a hand on the hip: the flight stays, fixed.spin and fixed.ballistic report it, and QA says SPIN only with fix { spin: false }", flightOf(on).length === 1 && on.fixed.spin?.frames > 0 && on.fixed.ballistic?.frames > 0 && !kinds(on).has("SPIN") && kinds(off).has("SPIN"), JSON.stringify({ fl: flightOf(on), on: [...kinds(on)], off: [...kinds(off)] }));
}

// (c) a keyed flip that overshoots by 2 deg before it lands is one turn, not a turn back; a rig with no bone for a segment is reported, not thrown on
{
	const T0 = 18, A = 22, B = A + T0, v0 = G * T0 / 2, keys = [{ f: 0, set: { ...pose0 } }, { f: 10, set: { root: pose0.root } }, { f: 18, set: { root: shift(pose0.root, [0, -0.1, 0]) } }];
	for (let f = A; f <= B; f++) {
		const t = f - A, u = t / T0, root = shift(pose0.root, [0, v0 * t - G * t * t / 2, 0]);
		keys.push({ f, set: { root, pitch: u < 0.85 ? -362 * (u / 0.85) : -362 + 2 * ((u - 0.85) / 0.15), arm_rest: 72 } });
	}
	keys.push({ f: B + 8, set: { root: shift(pose0.root, [0, -0.08, 0]), pitch: -360 } }, { f: B + 22, set: { root: pose0.root, pitch: -360 } });
	const spec = { schema: SPEC, fps: 24, frames: B + 24, keys }, r = compileSpec(structuredClone(spec), { sk, scene: motionScene([]) });
	expect(`(c) a flip with a 2 deg overshoot: re-timed (${r.fixed.spin?.frames ?? 0} frames, not left as keyed), no SPIN`, r.fixed.spin?.frames > 0 && !r.fixed.spin.left && !kinds(r).has("SPIN"), JSON.stringify({ spin: r.fixed.spin, kinds: [...kinds(r)] }));
	const noSpine = { ...sk, index: { ...sk.index } };
	delete noSpine.index.Spine1;
	const off = compileSpec({ ...structuredClone(spec), fix: { spin: false } }, { sk, scene: motionScene([]) }), run = flightOf(off);
	const rep = spinFix({ ...off.out, ctx: { ...off.out.ctx, sk: noSpine } }, { solve() {} }, run, () => null);
	expect("(c) a rig missing a segment bone: fix.spin reports it under fixed.spin.left", rep?.runs === 0 && /no bone/.test(rep.left?.[0]?.why ?? ""), JSON.stringify(rep));
}

// (c) a turn too fast for the momentum to read (1080 deg in 12 frames): re-timing would drift more than keyed, so it stays keyed and SPIN's hint says why
{
	const T0 = 12, A = 22, B = A + T0, v0 = G * T0 / 2, keys = [{ f: 0, set: { ...pose0 } }, { f: 10, set: { root: pose0.root } }, { f: 18, set: { root: shift(pose0.root, [0, -0.1, 0]) } }];
	for (let f = A; f <= B; f++) { const t = f - A; keys.push({ f, set: { root: shift(pose0.root, [0, v0 * t - G * t * t / 2, 0]), yaw: -1080 * t / T0 } }); }
	keys.push({ f: B + 8, set: { root: shift(pose0.root, [0, -0.08, 0]), yaw: -1080 } }, { f: B + 22, set: { root: pose0.root, yaw: -1080 } });
	const compile = fix => compileSpec({ schema: SPEC, fps: 24, frames: B + 24, keys: structuredClone(keys), ...(fix ? { fix } : {}) }, { sk, scene: motionScene([]) });
	const r = compile(), off = compile({ spin: false }), [a, b] = flightOf(r)[0] ?? [0, 0], g = r.qa.groups.find(x => x.kind === "SPIN");
	expect(`(c) 1080 deg in 12 frames: fix.spin keeps no worse a drift than keyed (${r3(runDrift(r.out, a, b))} vs ${r3(runDrift(off.out, a, b))}), left and reported`, runDrift(r.out, a, b) <= runDrift(off.out, a, b) + 1e-9 && /drift more/.test(r.fixed.spin?.left?.[0]?.why ?? ""), JSON.stringify(r.fixed.spin));
	expect("(c) SPIN's hint on a flight fix.spin left names the reason, not the fix", g && /fix\.spin left this flight/.test(g.hint) && !/on by default/.test(g.hint), JSON.stringify(r.qa.groups.map(x => x.kind)));
}

// (c) a hop with no root turn whose feet tuck 0.45 m (the legs swing the body by themselves): SPIN, and fix.spin has no turn of 30 deg or
// more to re-time, so its hint says that instead of promising the fix
{
	const A = 22, T0 = 14, B = A + T0, v0 = G * T0 / 2, off = l => [pose0[`foot_${l}`][0], pose0[`foot_${l}`][1] - HIPS, pose0[`foot_${l}`][2]], end = shift(pose0.root, [0, 0, 0.25]);
	const keys = [{ f: 0, set: { ...pose0 } }, { f: 10, set: { root: pose0.root, foot_l: pose0.foot_l, foot_r: pose0.foot_r } }, { f: 18, set: { root: shift(pose0.root, [0, -0.12, 0]), foot_l: pose0.foot_l, foot_r: pose0.foot_r } }];
	for (let f = A; f <= B; f++) {
		const t = f - A, root = shift(pose0.root, [0, v0 * t - G * t * t / 2, 0.25 * t / T0]), s = Math.sin(Math.PI * t / T0) ** 2, lift = (f === A || f === B ? 0 : 0.03) + 0.45 * s;
		keys.push({ f, set: { root, foot_l: shift(root, shift(off("l"), [0, lift, 0.225 * s])), foot_r: shift(root, shift(off("r"), [0, lift, 0.225 * s])) } });
	}
	keys.push({ f: B + 6, set: { root: shift(end, [0, -0.1, 0]), foot_l: shift(pose0.foot_l, [0, 0, 0.25]), foot_r: shift(pose0.foot_r, [0, 0, 0.25]) } }, { f: B + 22, set: { root: end, foot_l: shift(pose0.foot_l, [0, 0, 0.25]), foot_r: shift(pose0.foot_r, [0, 0, 0.25]) } });
	const r = compileSpec({ schema: SPEC, fps: 24, frames: B + 24, keys }, { sk, scene: motionScene([]) }), g = r.qa.groups.find(x => x.kind === "SPIN");
	expect(`(c) a tucked hop with no turn: SPIN (worst ${g?.worst}), no fixed.spin, and the hint says the root turns under 30 deg, not that fix.spin re-times it`, g && !r.fixed.spin && /turns less than 30 deg/.test(g.hint) && !/on by default|re-timed/.test(g.hint), JSON.stringify({ spin: r.fixed.spin, hint: g?.hint }));
}

// (c) h-parkour (QA clean at 3804b63b): its flight f54-f64 keys a pitch that turns back in the air (70 -> 10 -> 15 deg), so the angular
// momentum about the centre of mass changes sign with nothing to push on (about -21 to +15 kg m^2/s): SPIN is right there. fix.spin
// leaves a turn back as keyed, and the hint names that (fix.spin's f54-f64 against QA's free span f55-f64)
{
	const hp = JSON.parse(readFileSync(new URL("./fixtures/h-parkour-spec.json", import.meta.url), "utf8")), xsk = skeletonFor(hp.model);
	const r = compileSpec(hp.spec, { sk: xsk, scene: motionScene(hp.objects) }), g = r.qa.groups.find(x => x.kind === "SPIN"), L = f => momentumOf(xsk, r.out.frames, f - (r.out.f0 ?? 0), 24).L[0];
	const Ls = Array.from({ length: 9 }, (_, i) => L(55 + i)), [lo, hi] = [Math.min(...Ls), Math.max(...Ls)];
	expect(`(c) h-parkour: the keyed pitch turns back in the air, L_x runs ${r3(lo)} to ${r3(hi)} kg m^2/s; SPIN (${g?.subject}, worst ${g?.worst}) is its only issue, fix.spin left the turn back and the hint says so`,
		g && /f55-f64$/.test(g.subject) && r.qa.total === g.count && lo < -10 && hi > 10 && /turns back/.test(r.fixed.spin?.left?.[0]?.why ?? "") && /fix\.spin left this flight .*turns back/.test(g.hint), JSON.stringify({ total: r.qa.total, groups: r.qa.groups.map(x => `${x.kind} ${x.subject}`), spin: r.fixed.spin, hint: g?.hint }));
}

// (c) a hover turning 180 deg: no fall, no flight to re-time; FLOAT's hint is the staging's fix, and neither flight fix touches it
{
	const up = shift(pose0.root, [0, 0.4, 0]), rides = l => shift(up, [pose0[`foot_${l}`][0], pose0[`foot_${l}`][1] - HIPS, pose0[`foot_${l}`][2]]), keys = [{ f: 0, set: { ...pose0 } }, { f: 10, set: { root: pose0.root } }];
	for (let f = 14; f <= 40; f += 2) keys.push({ f, set: { root: up, foot_l: rides("l"), foot_r: rides("r"), yaw: 180 * (f - 14) / 26 } });
	keys.push({ f: 44, set: { root: pose0.root, foot_l: pose0.foot_l, foot_r: pose0.foot_r, yaw: 180 } }, { f: 60, set: { root: pose0.root } });
	const r = compileSpec({ schema: SPEC, fps: 24, frames: 62, keys }, { sk, scene: motionScene([]) });
	expect("(c) a hover turning 180 deg: FLOAT, and neither fix.ballistic nor fix.spin moves it", kinds(r).has("FLOAT") && !r.fixed.ballistic && !r.fixed.spin, JSON.stringify({ b: r.fixed.ballistic, s: r.fixed.spin, kinds: [...kinds(r)] }));
}

// (d) a 360 deg spin jump: the arms out at takeoff, pulled in over the middle of the flight, out again to land
function spinJump(lean = 0) {
	const A = 22, B = 37, T0 = B - A, v0 = G * T0 / 2, keys = [{ f: 0, set: { ...pose0 } }];
	const off = { l: [pose0.foot_l[0], ANKLE - HIPS, pose0.foot_l[2]], r: [pose0.foot_r[0], ANKLE - HIPS, pose0.foot_r[2]] };
	const feet = (root, yaw, dy) => ({ foot_l: add(root, apply(ry(yaw), shift(off.l, [0, dy, 0]))), foot_r: add(root, apply(ry(yaw), shift(off.r, [0, dy, 0]))), fyaw_l: yaw, fyaw_r: yaw });
	keys.push({ f: 10, set: { root: pose0.root, ...feet(pose0.root, 0, 0), arm_rest: 72, abend_l: 0, abend_r: 0 } });
	keys.push({ f: 18, set: { root: shift(pose0.root, [0, -0.12, 0]), ...feet(pose0.root, 0, 0), arm_rest: 30 } });
	const tuck = new Set();
	for (let f = A; f <= B; f++) {
		const t = f - A, root = shift(pose0.root, [0, v0 * t - G * t * t / 2, 0]), yaw = 360 * t / T0, u = t / T0;
		const inn = u > 0.3 && u < 0.7, arm = f === A || f === B ? 5 : u < 0.3 ? 5 + 80 * Math.max(0, (u - 0.15) / 0.15) : u < 0.7 ? 85 : 85 - 80 * Math.min(1, (u - 0.7) / 0.15);
		if (inn) tuck.add(f);
		keys.push({ f, set: { root, ...feet(root, yaw, f === A || f === B ? 0 : 0.05), yaw, ...(lean ? { pitch: lean } : {}), arm_rest: arm, abend_l: inn ? 110 : 0, abend_r: inn ? 110 : 0 } });
	}
	keys.push({ f: B + 6, set: { root: shift(pose0.root, [0, -0.1, 0]), arm_rest: 60, abend_l: 0, abend_r: 0 } }, { f: B + 20, set: { root: pose0.root, arm_rest: 72 } });
	return { spec: { schema: SPEC, fps: 24, frames: B + 22, keys }, tuck, A, B };
}
{
	const { spec, tuck, A, B } = spinJump(), compile = fix => compileSpec(fix ? { ...structuredClone(spec), fix } : structuredClone(spec), { sk, scene: motionScene([]) });
	const on = compile(), off = compile({ spin: false }), fl = flightOf(on)[0];
	const rate = (r, set) => { const fs = [...set].filter(f => f > A && f < B); return fs.reduce((s, f) => s + Math.abs(r.out.baked.yaw[f + 1] - r.out.baked.yaw[f - 1]) / 2, 0) / fs.length; };
	const open = new Set(Array.from({ length: B - A - 1 }, (_, i) => A + 1 + i).filter(f => !tuck.has(f) && fl && f >= fl[0] && f <= fl[1]));
	const [tOn, oOn, tOff, oOff] = [rate(on, tuck), rate(on, open), rate(off, tuck), rate(off, open)];
	expect(`(d) spin jump with fix.spin: faster tucked (${r3(tOn)} deg/f) than open (${r3(oOn)} deg/f); keyed evenly without it (${r3(tOff)} / ${r3(oOff)})`, tOn > 1.2 * oOn && Math.abs(tOff - oOff) < 0.5, JSON.stringify(on.fixed.spin));
	expect("(d) spin jump: the keyed full turn is kept (360 deg from takeoff to landing)", Math.abs(on.out.baked.yaw[B] - on.out.baked.yaw[A] - 360) < 1e-6);
	const dOn = fl ? runDrift(on.out, fl[0], fl[1]) : 1, dOff = fl ? runDrift(off.out, fl[0], fl[1]) : 0;
	expect(`(d) spin jump: the angular momentum drift falls with fix.spin (${r3(dOff)} -> ${r3(dOn)})`, dOn < dOff && dOn < SPIN_TOL, JSON.stringify({ dOn, dOff, fl }));
	expect(`(d) spin jump keyed at an even rate (fix { spin: false }): QA says SPIN (drift ${r3(dOff)} over SPIN_TOL); with fix.spin no SPIN`, dOff > SPIN_TOL && kinds(off).has("SPIN") && !kinds(on).has("SPIN"), JSON.stringify({ off: off.qa.groups.map(g => g.kind), on: on.qa.groups.map(g => g.kind) }));
	// |L| over the air run, (max - min) / mean: a body leaning off its turn axis carries momentum across the axis in proportion to the
	// turn rate (a product of inertia), so holding L along the axis alone made |L| drift more (lean -16 deg: 29.1% keyed, 29.2% re-timed)
	const magDrift = (r, [a, b]) => { const m = Array.from({ length: b - a + 1 }, (_, i) => Math.hypot(...momentumOf(sk, r.out.frames, a + i, 24).L)); return (Math.max(...m) - Math.min(...m)) / (m.reduce((s, x) => s + x, 0) / m.length); };
	for (const lean of [0, -16]) {
		const s = spinJump(lean).spec, q = fix => compileSpec({ ...structuredClone(s), ...(fix ? { fix } : {}) }, { sk, scene: motionScene([]) }), [r, k] = [q(), q({ spin: false, ballistic: false })], run = airRuns(k.out, []).at(-1);
		expect(`(d) spin jump${lean ? `, leaning ${lean} deg` : ""}: |L| about the centre of mass drifts ${r3(magDrift(k, run) * 100)}% keyed and ${r3(magDrift(r, run) * 100)}% with fix.spin (f${run[0]}-f${run[1]})`, magDrift(r, run) < 0.5 * magDrift(k, run) && magDrift(r, run) < 0.1, JSON.stringify(r.fixed.spin));
	}
	expect("(d) spin jump with fix { spin: false }: SPIN's hint says fix.spin is off for the take", /fix\.spin is off for this take/.test(off.qa.groups.find(g => g.kind === "SPIN")?.hint ?? ""), off.qa.groups.find(g => g.kind === "SPIN")?.hint);
	// cut after the arms have opened again, so the run holds the swing of L
	const cut = B - 1, r = compileSpec({ ...structuredClone(spec), frames: cut + 1, keys: spec.keys.filter(k => k.f <= cut) }, { sk, scene: motionScene([]) }), run = airRuns(r.out, []).at(-1);
	expect(`(d) spin jump cut at f${cut}, its air run reaching the end: no fix.spin, and QA says SPIN and that the take cuts it`, run?.[1] === cut && !r.fixed.spin && kinds(r).has("SPIN") && /take cuts this flight/.test(r.qa.groups.find(g => g.kind === "SPIN")?.hint ?? ""), JSON.stringify({ run, spin: r.fixed.spin, kinds: [...kinds(r)], hint: r.qa.groups.find(g => g.kind === "SPIN")?.hint }));
}

// (d2) a 360 deg spin jump on the X Bot leaning -8 deg, keyed at an even rate on a 1 g arc (f16-f32), the arms pulled in and bent
// over its second half. Holding the momentum vector (43247d38) read 0.207 on SPIN, over its limit; the round 4 re-time about the
// turn's axis reads 0.176 (28ad5074, QA without SPIN). fix.spin keeps the axis re-time there and says so (fixed.spin.axis)
{
	const xs = skeletonFor("x-bot-tpose"), p0 = compileSpec({ schema: SPEC, fps: 24, frames: 4, use: [stand] }, { sk: xs, scene: motionScene([]) }).out.keys.find(k => k.set.root).set;
	const A = 16, B = 32, N = B - A, keys = [{ f: 0, set: { ...p0 } }], off = l => [p0[`foot_${l}`][0], p0[`foot_${l}`][1] - p0.root[1], p0[`foot_${l}`][2]];
	const feet = (root, yaw, dy) => ({ foot_l: add(root, apply(ry(yaw), shift(off("l"), [0, dy, 0]))), foot_r: add(root, apply(ry(yaw), shift(off("r"), [0, dy, 0]))), fyaw_l: yaw, fyaw_r: yaw });
	keys.push({ f: A - 8, set: { root: p0.root, ...feet(p0.root, 0, 0), arm_rest: 72, abend_l: 0, abend_r: 0 } }, { f: A - 2, set: { root: shift(p0.root, [0, -0.12, 0]), ...feet(p0.root, 0, 0), arm_rest: 30 } });
	for (let f = A; f <= B; f++) {
		const t = f - A, u = t / N, root = shift(p0.root, [0, G * N * t / 2 - G * t * t / 2, 0]), end = f === A || f === B;
		const k = u < 0.35 ? 0 : u < 0.5 ? (u - 0.35) / 0.15 : u <= 0.9 ? 1 : 1 - (u - 0.9) / 0.15;
		keys.push({ f, set: { root, ...feet(root, 360 * u, end ? 0 : 0.05), yaw: 360 * u, pitch: -8, arm_rest: end ? 5 : 5 + 80 * k, abend_l: end ? 0 : 60 * k, abend_r: end ? 0 : 60 * k } });
	}
	keys.push({ f: B + 6, set: { root: shift(p0.root, [0, -0.1, 0]), arm_rest: 60, abend_l: 0, abend_r: 0 } }, { f: B + 20, set: { root: p0.root, arm_rest: 72 } });
	const r = compileSpec({ schema: SPEC, fps: 24, frames: 58, keys }, { sk: xs, scene: motionScene([]) }), fl = flightOf(r)[0], d = fl && runDrift(r.out, fl[0], fl[1]);
	expect(`(d2) spin jump leaning -8 deg (X Bot): fix.spin keeps the axis re-time (${JSON.stringify(r.fixed.spin?.axis)}), SPIN reads ${r3(d)} as at 28ad5074 (0.176), QA has no SPIN`, r.fixed.spin?.axis?.includes("f17-f31") && Math.abs(d - 0.176) < 0.002 && !kinds(r).has("SPIN"), JSON.stringify({ spin: r.fixed.spin, fl, kinds: [...kinds(r)] }));
}

// (e) the existing flight tests
for (const name of ["verify-motion3-flip.mjs", "verify-motion3-float-fix.mjs"]) {
	const res = spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url))], { encoding: "utf8" });
	expect(`(e) ${name} still passes`, res.status === 0, (res.stdout + res.stderr).split("\n").filter(l => /FAIL/.test(l)).join("; ").slice(0, 600));
}

if (failures) { console.error(`${failures} flight physics check(s) failed`); process.exit(1); }
console.log("motion3 flight physics: all checks passed");
