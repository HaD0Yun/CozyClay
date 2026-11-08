#!/usr/bin/env node
// Flight physics (#1124 and the spin fix): off the ground only gravity acts on the body. Built from the physics bench's
// sets 06 (trip run) and 07 (roof fall back) and the flip skill, since the bench's own v2 specs are not in the repo.
//   (a) a backward hop off a 3 m roof, its hips keyed on an exact 1 g parabola every frame: retime leaves the air frames
//       alone and the ballistic fix keeps the centre of mass on the arc, so the hips stay within 0.05 m of their keys and
//       the bench scorer's gravity error (test/bench/physics/checks.mjs gravityCheck) is under 0.05 m; no new REACH or
//       penetration against the same take with the flight fixes off
//   (b) hips falling at about 2 g while the feet stand (the trip run's fall): DROP, and its hint gives sqrt(2h/g)
//   (c) the flip skill's back tuck: the angular momentum drift is under SPIN_TOL with fix.spin and over it without; the
//       total turn between takeoff and landing within 10 deg of the keyed turn; the landing clean (QA 0)
//   (d) a 360 deg spin jump that pulls the arms in mid-air: with fix.spin the body turns faster tucked than open
//   (e) the flip and float-fix tests still pass
// Prints PASS/FAIL lines; exits non-zero on a failure.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { airRuns } from "../../src/motion3/qa/style.js";
import { flights, runDrift, SPIN_TOL, DROP_LIMIT } from "../../src/motion3/qa/flight-checks.js";
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
const building = motionScene([{ id: "building", name: "Building", renderer: "cube", x: 0, y: 0, z: 1.5, rot: 0, rotX: 0, rotZ: 0, scaleX: 6, scaleY: 3, scaleZ: 6, footprint: { width: 1, depth: 1 }, height: 1 }]);
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
	expect("(a) roof fall: retime leaves the flight's frames as keyed (no time map inside it)", !r.out.timeMap || Array.from({ length: b - a + 3 }, (_, i) => a - 1 + i).every(f => Math.abs(r.out.timeMap(f) - f) < 1e-9), JSON.stringify(r.fixed.retime));
	expect("(a) roof fall: output.fixed.ballistic reports the run, its frames and the worst move", r.fixed.ballistic?.runs >= 1 && r.fixed.ballistic.frames >= b - a + 1 && r.fixed.ballistic.max >= 0 && Array.isArray(r.fixed.ballistic.at), JSON.stringify(r.fixed.ballistic));
	const pen = new Set(["REACH", "COLLIDE", "GROUND", "BODY"]), added = [...kinds(r)].filter(k => pen.has(k) && !kinds(off).has(k));
	expect("(a) roof fall: no new REACH or penetration (COLLIDE, GROUND, BODY) against the same take with the flight fixes off", added.length === 0, JSON.stringify(r.qa.groups.map(g => `${g.kind} ${g.subject}`)));
	expect("(a) roof fall: no DROP or SPIN on the fall", !kinds(r).has("DROP") && !kinds(r).has("SPIN"), JSON.stringify(r.qa.groups.map(g => `${g.kind} ${g.subject} f${g.first}-${g.last}`)));
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
}

// (e) the existing flight tests
for (const name of ["verify-motion3-flip.mjs", "verify-motion3-float-fix.mjs"]) {
	const res = spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url))], { encoding: "utf8" });
	expect(`(e) ${name} still passes`, res.status === 0, (res.stdout + res.stderr).split("\n").filter(l => /FAIL/.test(l)).join("; ").slice(0, 600));
}

if (failures) { console.error(`${failures} flight physics check(s) failed`); process.exit(1); }
console.log("motion3 flight physics: all checks passed");
