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
//       (a3) the bench-2 parkour vault: the push-off and impact the fix made are no POP, no blocking group
//   (b) hips falling at about 2 g while the feet stand (the trip run's fall): DROP, and its hint gives sqrt(2h/g); the
//       same fall while the body turns about the vertical (a pirouette is no turn over): DROP; a stand-up that stops its
//       rise at about 1.8 g with the feet planted (a support cannot pull the body down): DROP, its hint gives v/g
//   (c) the flip skill's back tuck: the angular momentum drift is under SPIN_TOL with fix.spin and over it without; the
//       total turn between takeoff and landing within 10 deg of the keyed turn; the landing clean (QA 0); all of it with a
//       hand on the hip too. A 2 deg overshoot before landing is still re-timed. A rig
//       missing a segment bone is reported under fixed.spin.left, not thrown on
//   (d) a 360 deg spin jump that pulls the arms in mid-air: with fix.spin the body turns faster tucked than open; keyed
//       at an even rate (fix { spin: false }) QA says SPIN. Cut before it lands, fix.spin has no landing and QA still says SPIN
//   (e) the flip and float-fix tests still pass
// Prints PASS/FAIL lines; exits non-zero on a failure.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { bakeTake } from "../../src/motion3/take.js";
import { peopleOf } from "../../src/motion3/people.js";
import { airRuns } from "../../src/motion3/qa/style.js";
import { flights, runDrift, SPIN_TOL, DROP_LIMIT } from "../../src/motion3/qa/flight-checks.js";
import { isBlocking } from "../../src/motion3/qa/blocking.js";
import { spinFix } from "../../src/motion3/fix/spin.js";
import { rotationVector } from "../../src/motion3/qa/inertia.js";
import { centerOfMass } from "../../src/motion3/qa/com.js";
import { mul, T, ry, apply, add } from "../../src/motion3/compiler/math.js";
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
	expect(`(a) roof fall: the bench scorer's gravity error is under 0.05 m (${r3(grav.error)} m, speed change ${r3(grav.speedChange)} m/s)`, grav.error < 0.05, JSON.stringify(grav));
	expect(`(a) roof fall: retime leaves the air frames f${a}-f${b} as keyed (the time map is the identity there; it stretched ${r.fixed.retime?.maxStretch ?? 1}x elsewhere)`, !r.out.timeMap || Array.from({ length: b - a + 1 }, (_, i) => a + i).every(f => Math.abs(r.out.timeMap(f) - f) < 1e-9), JSON.stringify(r.fixed.retime));
	expect("(a) roof fall: output.fixed.ballistic reports the run, its frames and the worst move", r.fixed.ballistic?.runs >= 1 && r.fixed.ballistic.frames >= b - a + 1 && r.fixed.ballistic.max >= 0 && Array.isArray(r.fixed.ballistic.at), JSON.stringify(r.fixed.ballistic));
	const pen = new Set(["REACH", "COLLIDE", "GROUND", "BODY"]), added = [...kinds(r)].filter(k => pen.has(k) && !kinds(off).has(k));
	expect("(a) roof fall: no new REACH or penetration (COLLIDE, GROUND, BODY) against the same take with the flight fixes off", added.length === 0, JSON.stringify(r.qa.groups.map(g => `${g.kind} ${g.subject}`)));
	expect("(a) roof fall: no DROP or SPIN on the fall", !kinds(r).has("DROP") && !kinds(r).has("SPIN"), JSON.stringify(r.qa.groups.map(g => `${g.kind} ${g.subject} f${g.first}-${g.last}`)));
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
	expect("(a3) parkour vault: no POP on its push-off and impact frames, no blocking group, no more issues than the 13 of the baseline", r.qa.groups.every(g => g.kind !== "POP" || g.last < 35) && blocking.length === 0 && r.qa.total <= 13, JSON.stringify({ total: r.qa.total, blocking: list(blocking), all: list(r.qa.groups) }));
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
		m && Math.abs(+m[1] - h) < 0.02 && +m[3] === 20 && Math.abs(+m[5] - need) < 0.02 && +m[6] === Math.ceil(need * 24) && +m[7] === 20 + Math.ceil(need * 24) && /brace/.test(g.hint), g?.hint);
	// the same drop over the frames a fall needs reads clean
	const slow = keys.map(k => (k.f > 20 && k.f <= f ? { f: 20 + (k.f - 20) * 2, set: k.set } : k.f > f ? { f: k.f + f - 20, set: k.set } : k));
	const ok = compileSpec({ schema: SPEC, fps: 24, frames: slow.at(-1).f + 2, keys: slow }, { sk, scene: motionScene([]) });
	expect("(b) the same drop at half the acceleration: no DROP", !kinds(ok).has("DROP"), JSON.stringify(ok.qa.groups.map(x => `${x.kind} ${x.subject} ${x.worst}`)));
	// the same fall while the body turns about the vertical 30 deg a frame: its hips' up axis stays up, no turn over
	const spun = keys.map(k => (k.f > 20 && k.f <= f ? { f: k.f, set: { ...k.set, yaw: 30 * (k.f - 20) } } : k.f > f ? { f: k.f, set: { ...k.set, yaw: 30 * (f - 20) } } : k));
	const pir = compileSpec({ schema: SPEC, fps: 24, frames: f + 22, keys: spun }, { sk, scene: motionScene([]) });
	expect("(b) the same fall turning 30 deg a frame about the vertical: DROP (a pirouette is no turn over)", kinds(pir).has("DROP"), JSON.stringify(pir.qa.groups.map(x => `${x.kind} ${x.subject} ${x.worst}`)));
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
	// the landing's one-frame POP goes unread only on a flight the ballistic fix moved
	const kept = flip({ ballistic: false });
	expect("(c) back tuck with fix { ballistic: false }: the landing reads POP (only a flight the ballistic fix moved is exempt)", kinds(kept).has("POP") && !kinds(on).has("POP"), JSON.stringify(kept.qa.groups.map(g => `${g.kind} ${g.subject} f${g.first}`)));
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
	const rep = spinFix({ ...off.out, ctx: { ...off.out.ctx, sk: noSpine } }, { solve() {} }, run);
	expect("(c) a rig missing a segment bone: fix.spin reports it under fixed.spin.left", rep?.runs === 0 && /no bone/.test(rep.left?.[0]?.why ?? ""), JSON.stringify(rep));
}

// (d) a 360 deg spin jump: the arms out at takeoff, pulled in over the middle of the flight, out again to land
function spinJump() {
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
		keys.push({ f, set: { root, ...feet(root, yaw, f === A || f === B ? 0 : 0.05), yaw, arm_rest: arm, abend_l: inn ? 110 : 0, abend_r: inn ? 110 : 0 } });
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
	// cut after the arms have opened again, so the run holds the swing of L
	const cut = B - 1, r = compileSpec({ ...structuredClone(spec), frames: cut + 1, keys: spec.keys.filter(k => k.f <= cut) }, { sk, scene: motionScene([]) }), run = airRuns(r.out, []).at(-1);
	expect(`(d) spin jump cut at f${cut}, its air run reaching the end: no fix.spin, and QA says SPIN`, run?.[1] === cut && !r.fixed.spin && kinds(r).has("SPIN"), JSON.stringify({ run, spin: r.fixed.spin, kinds: [...kinds(r)] }));
}

// (e) the existing flight tests
for (const name of ["verify-motion3-flip.mjs", "verify-motion3-float-fix.mjs"]) {
	const res = spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url))], { encoding: "utf8" });
	expect(`(e) ${name} still passes`, res.status === 0, (res.stdout + res.stderr).split("\n").filter(l => /FAIL/.test(l)).join("; ").slice(0, 600));
}

if (failures) { console.error(`${failures} flight physics check(s) failed`); process.exit(1); }
console.log("motion3 flight physics: all checks passed");
