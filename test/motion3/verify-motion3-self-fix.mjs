#!/usr/bin/env node
// Issue 1154: the self repair (fix/self-repair.js, part of spec.fix.self after fix/self.js). An arm part still in the
// character's own torso, hips, head, thigh or other arm past QA's BODY or FACE limit moves out (its IK, or its FK
// angles), deepest first, spread
// over a window of frames, and a span stands only where QA is no worse. The takes are keyed here on the X Bot and Y Bot
// (no rig, model or dataset is downloaded); "before" is the same expanded spec compiled with opts.selfRepair = false
// (fix.self's elbow plan and skin pushes, without the repair), so each property reads against the take the repair started from.
//   (a) the cases clear: a hand swung down past the thigh (3.6 cm left after fix.self's elbow plan), a forearm across the
//       belly reaching for the far hip (12.1 cm), a hand into the head (7.5 and 5.8 cm) and through the back of the head
//       (10.1 cm): no BODY or FACE left, the last but one frame under 2 cm
//   (b) the spread pops nothing: no POP or FLIP group the take did not have, none worse
//   (c) never worse: a goal the hand met, or a contact the elbow kept, that the repair would break gets the span back,
//       exactly (the take equals the one without the repair to 1e-9) and fixed.self.left says why
//   (d) the take's own contacts stay: a hand in a pocket (a bone anchor) and a hand held on a world anchor keep their
//       place on the frames they are held (only the elbow may turn); a declared checks.allow is not repaired
//   (e) a take with no arm in the body comes out identical to 1e-9, and fixed.self has no repair fields
//   (f) fix.self false turns it off; the BODY and FACE hints say repaired, left (why) or off
//   (g) the report: spans [{ at, depth }], depth [before, after], iterations, left [{ at, side, why }]
//   (h) deterministic: the same spec twice gives the same take; two repaired takes pinned to 1e-9 (arm64 and x86_64)
//   (i) hands keyed onto the hips (hand targets into the thighs): repaired, and the frames the keys hold still stay still
//   (j) the move guard: on fast reaches to the face the depth guard and the pop guard decide a move, and the repair still
//       clears; a wrist pop that gets harder while the elbow's eases is a pop; FACE is read as QA reads it (no checks.allow)
//   (k) bodyDistance on a state that changed in place after its grid centres were read prunes as before (body.js)
//   (l) FK arms move by their angles (the arm out from the body, the elbow bent): a swing with the arms hanging close
//       and a walk with armSwing 45 at arm_rest 98 clear with each hand's swing amplitude and timing kept; an arm half on
//       its IK takes both kinds; a clean FK swing is untouched
//   (m) crossed arms (hand targets on the opposite shoulders inside the chest): both arms repaired, taking turns, the
//       hands not into each other
//   (n) the wider moves on what the first leave: a hand swept into the far thigh, a forearm across the belly to the far
//       hip, the hand through the back of the X Bot's head (undone in round 1)
// Prints PASS/FAIL lines; exits non-zero on a failure.
import { createHash } from "node:crypto";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { compileMotion } from "../../src/motion3/compiler/compile.js";
import { runMotionQa } from "../../src/motion3/qa/index.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { armMotion, moveWorse } from "../../src/motion3/fix/self-guard.js";
import { bodyFor, bodyDistance } from "../../src/motion3/body.js";
import { groupKey } from "../../src/motion3/qa/severity.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const SPEC = "cozyclay.motion-spec.v1", scene = { objects: {} };
const cm = x => +(x * 100).toFixed(1);
const nano = v => (typeof v === "number" ? Math.round(v * 1e9) / 1e9 : v.map(nano));
const digest = out => createHash("sha256").update(JSON.stringify(out.frames.map(({ s }) => nano([s.P, s.R])))).digest("hex").slice(0, 16);
/** The largest joint position difference (m) between two takes on frame indices lo..hi (all by default), joints `only` or all. */
function moved(a, b, lo = 0, hi = a.frames.length - 1, only = null) {
	let d = 0;
	for (let f = lo; f <= hi; f++) a.frames[f].s.P.forEach((p, j) => { if (!only || only.includes(j)) d = Math.max(d, Math.hypot(p[0] - b.frames[f].s.P[j][0], p[1] - b.frames[f].s.P[j][1], p[2] - b.frames[f].s.P[j][2])); });
	return d;
}

/** The right hand's keyed path, rig-relative (heights as a share of the hips' height). */
function takes(sk) {
	const P = sk.restWorldPos, I = sk.index, H = P[I.Hips][1], ank = P[I.LeftFoot][1], fx = P[I.LeftFoot][0], tx = P[I.LeftUpLeg][0];
	const st = { root: [0, H - 0.01, 0], foot_l: [fx, ank, 0], foot_r: [-fx, ank, 0] }, y = s => +(H * s).toFixed(3);
	const k = (f, set) => ({ f, set: { ...st, armw_r: 1, armw_l: 0, ...set } });
	const there = (rest, mid, extra = {}) => [k(0, { hand_r: rest }), k(24, { hand_r: mid, ...extra }), k(47, { hand_r: rest })];
	return {
		thigh: { keys: [k(0, { hand_r: [-tx - 0.05, y(0.95), 0.35] }), k(24, { hand_r: [-tx + 0.01, y(0.74), 0] }), k(47, { hand_r: [-tx - 0.05, y(0.9), -0.32] })] },
		belly: { keys: there([-0.35, y(0.95), 0.3], [0.2, y(1.02), 0.08], { elbow_r: [-0.3, -1, 0.4] }) },
		head: { keys: there([-0.3, y(1.3), 0.35], [-0.02, y(1.58), 0.04]) },
		scratch: { keys: there([-0.35, y(1.4), 0.2], [0, y(1.63), -0.06]) },
		pinned: { anchors: { spot: { kind: "world", p: [0.2, y(1.02), 0.08] } }, keys: [k(0, { hand_r: [-0.35, y(0.95), 0.3], w_spot_r: 0 }), k(20, { w_spot_r: 1 }), k(28, { w_spot_r: 1 }), k(47, { hand_r: [-0.35, y(0.95), 0.3], w_spot_r: 0 })] },
		pocket: { anchors: { pocket: { kind: "bone", bone: "RightUpLeg", offset: [0, -0.15, 0.02] } }, keys: [k(0, { hand_r: [-0.3, y(1.0), 0.25], w_pocket_r: 0 }), k(20, { w_pocket_r: 1 }), k(28, { w_pocket_r: 1 }), k(47, { hand_r: [-0.3, y(1.0), 0.25], w_pocket_r: 0 })] },
		clean: { keys: there([-0.4, y(1.4), 0.2], [-0.5, y(1.6), 0.1]) },
	};
}
const specOf = (t, extra = {}) => ({ schema: SPEC, fps: 24, frames: t.frames ?? 48, keys: t.keys, ...(t.anchors ? { anchors: t.anchors } : {}), ...(t.use ? { use: t.use } : {}), ...extra });

/** The take through the pipeline, and the same expanded spec without the repair: { r, before, qa0, self }. */
function run(sk, spec) {
	// pipeline.js keeps retime only where QA is no worse with it: the take without it is compiled with fix.retime false
	const r = compileSpec(spec, { sk, scene }), exp = { fps: 24, ...r.expanded, ...(r.fixed?.retime?.kept === false ? { fix: { ...r.expanded.fix, retime: false } } : {}) };
	const before = compileMotion(exp, { sk, scene }, { selfRepair: false });
	return { r, before, qa0: runMotionQa(sk, before, r.expanded, { explain: false }), self: r.fixed?.self ?? null };
}
const own = qa => qa.groups.filter(g => g.kind === "BODY" || g.kind === "FACE");
const worstOwn = qa => Math.max(0, ...own(qa).map(g => g.worst));
const groupsOf = (qa, kinds) => new Map(qa.groups.filter(g => kinds.includes(g.kind)).map(g => [groupKey(g), g.severity ?? 0]));

const X = skeletonFor("x-bot-tpose"), Y = skeletonFor("y-bot-tpose"), TX = takes(X), TY = takes(Y);

// (a) the deep cases clear, (b) no new POP or FLIP, (g) the report
const cases = [["x-bot", X, "thigh", TX.thigh], ["x-bot", X, "belly", TX.belly], ["x-bot", X, "head", TX.head], ["y-bot", Y, "head", TY.head], ["y-bot", Y, "scratch", TY.scratch]];
const runs = {};
for (const [rig, sk, name, t] of cases) {
	const c = runs[`${rig} ${name}`] = run(sk, specOf(t)), { r, qa0, self } = c;
	console.log(`  ${rig} ${name}: BODY/FACE worst ${cm(worstOwn(qa0))} cm -> ${cm(worstOwn(r.qa))} cm, QA ${qa0.total} -> ${r.qa.total}, fixed.self ${JSON.stringify({ spans: self?.spans, depth: self?.depth, iterations: self?.iterations, left: self?.left })}`);
	// the hand through the back of the Y Bot's head leaves its upper arm 1 mm past the limit on one frame
	const rest = name === "scratch" ? g => g.worst < 0.02 && g.count <= 1 : () => false;
	expect(`(a) ${rig} ${name}: the arm read ${cm(worstOwn(qa0))} cm in the body before the repair and no BODY or FACE is left${name === "scratch" ? " but one frame under 2 cm" : ""}`,
		worstOwn(qa0) > 0.03 && own(r.qa).every(rest), JSON.stringify(own(r.qa).map(g => [g.subject, g.count, g.worst])));
	const was = groupsOf(qa0, ["POP", "FLIP"]), now = groupsOf(r.qa, ["POP", "FLIP"]);
	expect(`(b) ${rig} ${name}: the spread adds no POP or FLIP and makes none worse`, [...now].every(([key, sev]) => was.has(key) && sev <= was.get(key) + 1e-9), JSON.stringify([[...was], [...now]]));
	expect(`(g) ${rig} ${name}: fixed.self reports its spans with depth [before, after], the deepest hit before and after, and its iterations`,
		self?.spans?.length > 0 && self.spans.every(s => /^f\d+-f\d+$/.test(s.at) && s.depth[1] < s.depth[0]) && self.depth[0] > self.depth[1] && self.iterations > 0 && self.elbowFrames !== undefined, JSON.stringify(self));
}
expect("(a) the deep cases were 6 cm or deeper before (forearm across the belly, hand into and through the head)", ["x-bot belly", "x-bot head", "y-bot scratch"].every(c => worstOwn(runs[c].qa0) >= 0.06), JSON.stringify(Object.fromEntries(Object.entries(runs).map(([c, v]) => [c, cm(worstOwn(v.qa0))]))));

// (c) never worse: a goal the hand met at the reach, and a contact the elbow kept there
const belly = runs["x-bot belly"], hand = belly.before.frames[24].s.P[X.index.RightHand], elbow = belly.before.frames[24].s.P[X.index.RightForeArm];
const goal = run(X, specOf(TX.belly, { anchors: { mark: { kind: "world", p: hand } }, goals: [{ name: "hand on the mark", near: ["joint:RightHand", "anchor:mark"], tol: 0.02, at: [23, 25] }] }));
console.log(`  goal: fixed.self ${JSON.stringify({ spans: goal.self?.spans, left: goal.self?.left })}`);
expect("(c) a goal the hand met that the repair would break: the span is undone (fixed.self.left says the goal), the goal holds", goal.self?.spans?.length === 0 && goal.self.left?.some(l => /^undone: goal "hand on the mark"/.test(l.why)) && goal.r.qa.goals[0].ok, JSON.stringify(goal.self));
expect("(c) ... and the take is the one without the repair, to 1e-9", digest(goal.r.out) === digest(goal.before), String(moved(goal.r.out, goal.before)));
const contact = run(X, specOf(TX.belly, { anchors: { mark: { kind: "world", p: elbow } }, checks: { contacts: [{ name: "elbow on the mark", point: "joint:RightForeArm", target: "anchor:mark", tol: 0.02, when: [22, 26] }] } }));
console.log(`  contact: fixed.self ${JSON.stringify({ spans: contact.self?.spans, left: contact.self?.left })}; QA before ${JSON.stringify(contact.qa0.groups.map(g => g.kind))}`);
expect("(c) a contact the elbow kept that the repair would break: the span is undone and the contact holds (no CONTACT group)", contact.self?.spans?.length === 0 && contact.self.left?.some(l => /^undone: /.test(l.why)) && !contact.r.qa.groups.some(g => g.kind === "CONTACT")
	&& !contact.qa0.groups.some(g => g.kind === "CONTACT"), JSON.stringify([contact.self, contact.r.qa.groups.map(g => g.kind)]));
expect("(c) ... and the take is the one without the repair, to 1e-9", digest(contact.r.out) === digest(contact.before), String(moved(contact.r.out, contact.before)));

// (d) the take's own contacts stay
for (const [rig, sk, T] of [["x-bot", X, TX], ["y-bot", Y, TY]]) {
	const hands = [sk.index.RightHand];
	for (const name of ["pocket", "pinned"]) {
		const c = run(sk, specOf(T[name])), d = moved(c.r.out, c.before, 20, 28, hands);
		console.log(`  ${rig} ${name}: wrist moved ${d.toExponential(2)} m on the held frames f20-f28; BODY/FACE ${cm(worstOwn(c.qa0))} -> ${cm(worstOwn(c.r.qa))} cm; left ${JSON.stringify(c.self?.left ?? null)}`);
		expect(`(d) ${rig} ${name}: the held hand keeps its place on f20-f28 (wrist within 1e-6 m of the take without the repair)`, d < 1e-6, String(d));
		if (name === "pinned") expect(`(d) ${rig} pinned: the frames the elbow cannot clear are left, with why`, c.self?.left?.some(l => /the hand stays on its target/.test(l.why)), JSON.stringify(c.self?.left));
	}
}
// the belly reach, the hand then easing onto a world anchor where it was (f28-f32 in, held f32-f36): the wrist pushes the
// repair spreads past f24 fade with that weight, so the hand stays on the anchor while it is held
const late = { anchors: { late: { kind: "world", p: belly.before.frames[34].s.P[X.index.RightHand] } },
	keys: [...TX.belly.keys.map(k => ({ f: k.f, set: { ...k.set, w_late_r: 0 } })), ...[[28, 0], [32, 1], [36, 1], [40, 0]].map(([f, w]) => ({ f, set: { w_late_r: w } }))].sort((a, b) => a.f - b.f) };
const eased = run(X, specOf(late)), dLate = moved(eased.r.out, eased.before, 32, 36, [X.index.RightHand]);
console.log(`  x-bot belly onto an anchor: wrist moved ${dLate.toExponential(2)} m on f32-f36; fixed.self ${JSON.stringify({ spans: eased.self?.spans, left: eased.self?.left })}`);
expect("(d) a hand easing onto an anchor after the repaired reach: repaired, and the wrist keeps the anchor on its held frames (1e-6 m)", eased.self?.spans?.length > 0 && dLate < 1e-6, String(dLate));
const allowed = run(X, specOf(TX.belly, { checks: { allow: [{ part: "farm_r", object: "torso_lo", depth: 0.15 }, { part: "uarm_r", object: "torso_lo", depth: 0.15 }, { part: "farm_r", object: "hips", depth: 0.15 }] } }));
expect("(d) a declared checks.allow is the take's: nothing to repair, the take is the one without the repair", !allowed.self?.spans && digest(allowed.r.out) === digest(allowed.before), JSON.stringify(allowed.self));

// (e) a take with no arm in the body is untouched
for (const [rig, sk, T] of [["x-bot", X, TX], ["y-bot", Y, TY]]) {
	const c = run(sk, specOf(T.clean));
	expect(`(e) ${rig} clean wave: identical to the take without the repair (1e-9), no repair fields in fixed.self`, digest(c.r.out) === digest(c.before) && !("spans" in (c.self ?? {})) && !("depth" in (c.self ?? {})), JSON.stringify(c.self));
}

// (f) the switch and the hints
const off = compileSpec(specOf(TX.belly, { fix: { self: false } }), { sk: X, scene }), offBody = off.qa.groups.find(g => g.kind === "BODY");
expect("(f) fix.self false: no fixed.self, BODY stays, and its hint says fix.self is off", off.fixed.self === undefined && /fix\.self is off for this take/.test(offBody?.hint ?? ""), offBody?.hint);
const pinned = run(X, specOf(TX.pinned)), pinnedBody = pinned.r.qa.groups.find(g => g.kind === "BODY" && /_r into/.test(g.subject));
expect("(f) a BODY the repair left: its hint says fix.self left the frames and why", /fix\.self left f\d+-f\d+ \(the hand stays on its target/.test(pinnedBody?.hint ?? ""), pinnedBody?.hint);
const goalBody = goal.r.qa.groups.find(g => g.kind === "BODY" && /_r into/.test(g.subject));
expect("(f) a BODY whose repair was undone: its hint says fix.self left the frames, undone, and why", /fix\.self left f\d+-f\d+ \(undone: goal/.test(goalBody?.hint ?? ""), goalBody?.hint);
// the hand through the back of the X Bot's head: round 1 undid it (QA read 6 problems against 5); the wider moves tried
// on what the first moves leave clear it
const xs = run(X, specOf(TX.scratch));
console.log(`  x-bot scratch: BODY/FACE ${cm(worstOwn(xs.qa0))} -> ${cm(worstOwn(xs.r.qa))} cm, QA ${xs.qa0.total} -> ${xs.r.qa.total}, fixed.self ${JSON.stringify({ spans: xs.self?.spans, depth: xs.self?.depth, left: xs.self?.left })}`);
expect("(n) x-bot hand through the back of the head (11.8 cm, undone in round 1): repaired, no BODY or FACE left", worstOwn(xs.qa0) > 0.1 && own(xs.r.qa).length === 0 && xs.self?.spans?.length > 0, JSON.stringify(own(xs.r.qa).map(g => [g.subject, g.worst])));

// (b) the guard each move passes (fix/self-guard.js): a wrist pop on one frame of a repaired take reads as one
const popped = { ...belly.r.out, frames: belly.r.out.frames.map((fr, f) => (f === 24 ? { ...fr, s: { ...fr.s, P: fr.s.P.map((p, j) => (j === X.index.RightHand ? [p[0], p[1] + 0.1, p[2]] : p)) } } : fr)) };
expect("(b) the move guard reads a 10 cm wrist pop on one frame as a pop, and the take itself as none", moveWorse(armMotion(belly.r.out, "r", 14, 34), armMotion(popped, "r", 14, 34)) === "a pop" && moveWorse(armMotion(belly.r.out, "r", 0, 47), armMotion(belly.r.out, "r", 0, 47)) === "");

// (i) hands keyed onto the hips by hand targets (no anchor), elbows out, held f16-f32: the hands sit in the thighs. The
// repair clears it, and on the frames the keys hold an arm still (its channels as the frame before) that arm moves no
// faster than without the repair (1 mm a frame): a hand held on the body takes one constant move, not a wave of eased ones
const akimbo = (() => {
	const P = Y.restWorldPos, I = Y.index, H = P[I.Hips][1], st = { root: [0, H - 0.01, 0], foot_l: [P[I.LeftFoot][0], P[I.LeftFoot][1], 0], foot_r: [-P[I.LeftFoot][0], P[I.LeftFoot][1], 0], armw_r: 1, armw_l: 1 };
	const y = s => +(H * s).toFixed(3), hx = P[I.LeftUpLeg][0] + 0.09, out = { hand_l: [0.4, y(0.95), 0.2], hand_r: [-0.4, y(0.95), 0.2] };
	const on = { hand_l: [hx, y(1.02), 0], hand_r: [-hx, y(1.02), 0], elbow_l: [1, 0, -0.3], elbow_r: [-1, 0, -0.3] };
	return { keys: [[0, out], [16, on], [32, on], [47, out]].map(([f, set]) => ({ f, set: { ...st, ...set } })) };
})();
const ak = run(Y, specOf(akimbo)), thighs = own(ak.qa0).filter(g => /^hand_[lr] into thigh_[lr]$/.test(g.subject));
const speed = (o, j, f) => { const a = o.frames[f - 1].s.P[j], b = o.frames[f].s.P[j]; return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };
let drift = 0;
for (const [k, S] of [["l", "Left"], ["r", "Right"]]) for (let f = 1; f < 48; f++) {
	const a = ak.r.out.frames[f - 1].c, b = ak.r.out.frames[f].c, still = Object.keys(b).filter(nm => !nm.endsWith(k === "l" ? "_r" : "_l")).every(nm => JSON.stringify(a[nm]) === JSON.stringify(b[nm]));
	if (still) for (const j of [`${S}ForeArm`, `${S}Hand`]) drift = Math.max(drift, speed(ak.r.out, Y.index[j], f) - speed(ak.before, Y.index[j], f));
}
console.log(`  y-bot hands on the hips: thighs ${JSON.stringify(thighs.map(g => [g.subject, cm(g.worst)]))} -> BODY/FACE ${cm(worstOwn(ak.r.qa))} cm; held frames move up to ${cm(drift)} cm a frame faster; fixed.self ${JSON.stringify({ spans: ak.self?.spans, left: ak.self?.left })}`);
expect("(i) y-bot hands keyed on the hips: the hands read 3 cm or more in the thighs before, and the repair clears them", thighs.some(g => g.worst >= 0.03) && ak.self?.spans?.length > 0 && worstOwn(ak.r.qa) === 0, JSON.stringify([thighs.map(g => g.worst), own(ak.r.qa).map(g => [g.subject, g.worst])]));
expect("(i) ... and on the frames the keys hold an arm still, it moves no faster than without the repair (1 mm a frame)", drift <= 0.001, `${cm(drift)} cm a frame`);

// (j) fast 24-frame reaches to the face (keys f0, f12, f23): on the first a move that would deepen the window's deepest hit
// is turned down, on the second one that would make the wrist's POP harder; each still clears with no new POP or FLIP
for (const [what, mid] of [["the depth guard", [-0.02, 1.5, -0.04]], ["the pop guard", [0.02, 1.5, -0.04]]]) {
	const H = X.restWorldPos[X.index.Hips][1], rest = [-0.4, +(H * 1.0).toFixed(3), 0.25], to = [mid[0], +(H * mid[1]).toFixed(3), mid[2]];
	const st = TX.head.keys[0].set, c = run(X, specOf({ keys: [[0, rest], [12, to], [23, rest]].map(([f, p]) => ({ f, set: { ...st, hand_r: p } })) }, { frames: 24 }));
	const was = groupsOf(c.qa0, ["POP", "FLIP"]), now = groupsOf(c.r.qa, ["POP", "FLIP"]);
	console.log(`  x-bot fast face reach (${what}): BODY/FACE ${cm(worstOwn(c.qa0))} -> ${cm(worstOwn(c.r.qa))} cm, QA ${c.qa0.total} -> ${c.r.qa.total}, fixed.self ${JSON.stringify({ spans: c.self?.spans, left: c.self?.left })}`);
	expect(`(j) x-bot fast face reach (${what} decides a move): repaired, no BODY or FACE left, no POP or FLIP added or worse`, worstOwn(c.qa0) > 0.03 && c.self?.spans?.length > 0 && own(c.r.qa).length === 0
		&& [...now].every(([key, sev]) => was.has(key) && sev <= was.get(key) + 1e-9), JSON.stringify([own(c.r.qa).map(g => [g.subject, g.worst]), [...was], [...now]]));
}
// the guard per joint: an elbow pop that eases does not hide a wrist pop that gets harder on the same frame
const spike = (dE, dW) => ({ ...belly.r.out, frames: belly.r.out.frames.map((fr, f) => (f === 24 ? { ...fr, s: { ...fr.s, P: fr.s.P.map((p, j) => (j === X.index.RightForeArm ? [p[0], p[1] + dE, p[2]] : j === X.index.RightHand ? [p[0], p[1] + dW, p[2]] : p)) } } : fr)) });
expect("(j) the move guard reads each joint: an elbow pop 10 -> 0 cm with a wrist pop 5 -> 8 cm on that frame is a pop", moveWorse(armMotion(spike(0.1, 0.05), "r", 14, 34), armMotion(spike(0, 0.08), "r", 14, 34)) === "a pop");
// QA's FACE has no checks.allow (qa/checks.js generalChecks; a hand meant at the face is on an anchor or a fit): with a
// checks.allow of the hand in the head (which BODY honours) QA still reads FACE, and the repair reads and clears it
const faceAllow = run(X, specOf(TX.head, { checks: { allow: [{ part: "hand_r", object: "head", depth: 0.2 }] } }));
expect("(j) a checks.allow of the hand in the head: QA still reads FACE before, and the repair clears it (it reads what QA reads)",
	faceAllow.qa0.groups.some(g => g.kind === "FACE") && faceAllow.self?.spans?.length > 0 && !faceAllow.r.qa.groups.some(g => g.kind === "FACE"), JSON.stringify([faceAllow.self, faceAllow.r.qa.groups.map(g => [g.kind, g.subject])]));

// (k) body.js caches a state's grid centres the first time it is read; a solver then changes the state in place. A grid is
// pruned only where its cached centre is farther than the best reading so far: each grid read alone on a fresh copy of the
// state, pruned that way, is the same reading (a prune at the skin instead loses grids that hold the point, de7a4776)
{
	const body = bodyFor(X), I = X.index, copy = st => ({ P: st.P.map(p => [...p]), R: st.R.map(R => R.map(r => [...r])) });
	const s = copy(belly.before.frames[0].s), s0 = copy(s), b = I.RightForeArm, A = s.P[b], ax = s.P[I.RightHand].map((v, c) => v - A[c]), L = Math.hypot(...ax);
	bodyDistance(body, s, s.P[I.Hips]);
	s.P[b] = A.map((v, c) => v + (ax[c] / L) * 0.12);
	const centre = g => [0, 1, 2].map(i => s0.P[g.b][i] + s0.R[g.b][i][0] * g.centre[0] + s0.R[g.b][i][1] * g.centre[1] + s0.R[g.b][i][2] * g.centre[2]);
	const ref = p => body.grids.reduce((best, g) => {
		const c = centre(g);
		if (Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) - g.reach > best.d) return best;
		const d = bodyDistance({ ...body, grids: [g] }, copy(s), p).d;
		return d < best.d ? { d, bone: g.b } : best;
	}, { d: 0.1, bone: -1 });
	let n = 0, bad = 0;
	for (let i = 0; i <= 40; i++) for (const off of [[0, 0.03, 0], [0, -0.03, 0], [0, 0, 0.03], [0, 0, -0.03], [0, 0, 0]]) {
		const p = s.P[b].map((v, c) => v + (ax[c] / L) * (L * (i / 40) * 1.1 - 0.02) + off[c]), a = bodyDistance(body, s, p), z = ref(p);
		n++; if (Math.abs(a.d - z.d) > 1e-12 || a.bone !== z.bone) bad++;
	}
	expect(`(k) bodyDistance on a state changed in place after its centres were read: the base prune's reading on ${n} points along the forearm`, bad === 0, `${bad} of ${n} differ`);
}

// (l) FK arms (armw 0) move by their angles: an arm swing with the arms hanging close (arm_rest 98: the hands sweep
// through the thighs, the upper arms in the belly), a walk with armSwing 45 at arm_rest 98, and the swing with the right
// arm half on its IK. Repaired with no BODY or FACE left, no POP or FLIP added or worse, and each hand's forward swing
// (its path along the facing, from the hips) keeps its amplitude (10%) and its timing (2 frames)
function fkTakes(sk) {
	const P = sk.restWorldPos, I = sk.index, H = P[I.Hips][1], st = { root: [0, H - 0.01, 0], foot_l: [P[I.LeftFoot][0], P[I.LeftFoot][1], 0], foot_r: [-P[I.LeftFoot][0], P[I.LeftFoot][1], 0] };
	const sw = (f, i, extra = {}) => ({ f, set: { ...st, armw_l: 0, armw_r: 0, arm_hang: 1, arm_rest: 98, aswing_l: [-35, 0, 35, 0, -35][i], aswing_r: [35, 0, -35, 0, 35][i], abend_l: 10, abend_r: 10, ...extra } });
	const F = [0, 12, 24, 36, 47];
	return {
		swing: { keys: F.map((f, i) => sw(f, i)) },
		half: { keys: F.map((f, i) => sw(f, i, { armw_r: 0.5, hand_r: [-P[I.LeftUpLeg][0] - 0.01, +(H * 0.62).toFixed(3), 0] })) },
		walk: { frames: 110, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 0, args: { heading: 0, steps: 4, armSwing: 45 } }], keys: [{ f: 0, set: { arm_rest: 98 } }] },
		clean: { keys: F.map((f, i) => ({ f, set: { ...st, armw_l: 0, armw_r: 0, arm_hang: 1, aswing_l: [-25, 0, 25, 0, -25][i], aswing_r: [25, 0, -25, 0, 25][i] } })) },
	};
}
/** Hand n's forward offset from the hips along the facing, per frame. */
const forward = (o, sk, n) => o.frames.map(fr => { const y = ((fr.c.yaw ?? 0) * Math.PI) / 180, P = fr.s.P, a = P[sk.index[n]], h = P[sk.index.Hips]; return (a[0] - h[0]) * Math.sin(y) + (a[2] - h[2]) * Math.cos(y); });
/** { amp: after / before amplitude, lag: frames (the shift of the best correlation, within 3) } of series a -> b. */
function swingOf(a, b) {
	const amp = x => Math.max(...x) - Math.min(...x), m = x => x.reduce((s, v) => s + v, 0) / x.length, ma = m(a), mb = m(b);
	let best = -Infinity, lag = 0;
	for (let d = -3; d <= 3; d++) { let c = 0; for (let f = 3; f < a.length - 3; f++) c += (a[f] - ma) * (b[f + d] - mb); if (c > best) { best = c; lag = d; } }
	return { amp: amp(b) / amp(a), lag };
}
const fk = {};
for (const [rig, sk] of [["x-bot", X], ["y-bot", Y]]) {
	const T = fkTakes(sk);
	for (const name of rig === "x-bot" ? ["swing", "walk", "half"] : ["swing", "walk"]) {
		const c = fk[`${rig} ${name}`] = run(sk, specOf(T[name])), { r, qa0, self, before } = c;
		const sws = ["LeftHand", "RightHand"].map(n => swingOf(forward(before, sk, n), forward(r.out, sk, n)));
		const was = groupsOf(qa0, ["POP", "FLIP"]), now = groupsOf(r.qa, ["POP", "FLIP"]), fkFrames = ["l", "r"].reduce((n, k) => n + r.out.ctx.fkArm[k].size, 0);
		console.log(`  ${rig} FK ${name}: BODY/FACE ${cm(worstOwn(qa0))} -> ${cm(worstOwn(r.qa))} cm, QA ${qa0.total} -> ${r.qa.total}, swing ${JSON.stringify(sws.map(x => [+x.amp.toFixed(3), x.lag]))}, FK levers on ${fkFrames} frame-arms, spans ${JSON.stringify(self?.spans)}`);
		expect(`(l) ${rig} FK ${name}: the arms read 5 cm or more in the body before and the repair clears them with FK moves`, worstOwn(qa0) >= 0.05 && own(r.qa).length === 0 && fkFrames > 0 && self?.spans?.length > 0, JSON.stringify(own(r.qa).map(g => [g.subject, g.worst])));
		expect(`(l) ${rig} FK ${name}: no POP or FLIP added or worse`, [...now].every(([key, sev]) => was.has(key) && sev <= was.get(key) + 1e-9), JSON.stringify([[...was], [...now]]));
		if (name !== "half") expect(`(l) ${rig} FK ${name}: each hand's swing keeps its amplitude (10%) and its timing (2 frames)`, sws.every(x => Math.abs(x.amp - 1) <= 0.1 && Math.abs(x.lag) <= 2), JSON.stringify(sws));
	}
	const c = run(sk, specOf(T.clean));
	expect(`(l) ${rig} clean FK swing (arm_rest 72): identical to the take without the repair (1e-9), no repair fields`, digest(c.r.out) === digest(c.before) && !("spans" in (c.self ?? {})), JSON.stringify(c.self));
}
// the half-IK arm moves both ways: its FK angles and its IK levers, each as far as the arm is on them
// ... and a half-IK arm whose hand eases onto a world anchor in the thigh (from f16, held from f24) keeps it there: FK
// moves on its free frames fade with the anchor's weight (they would move the FK hand its target blends from)
{
	const T = fkTakes(X), H = X.restWorldPos[X.index.Hips][1], spot = [-X.restWorldPos[X.index.LeftUpLeg][0] - 0.01, +(H * 0.62).toFixed(3), 0];
	const w = f => (f <= 16 ? 0 : f >= 24 ? 1 : null), keys = T.half.keys.map(k => ({ f: k.f, set: { ...k.set, ...(w(k.f) === null ? {} : { w_spot_r: w(k.f) }) } }));
	const c = run(X, specOf({ anchors: { spot: { kind: "world", p: spot } }, keys: [...keys, { f: 16, set: { w_spot_r: 0 } }].sort((a, b) => a.f - b.f) }));
	const d = moved(c.r.out, c.before, 24, 47, [X.index.RightHand]), early = [...c.r.out.ctx.fkArm.r.keys()].filter(f => f < 24).length;
	console.log(`  x-bot FK swing, right arm half on its IK onto an anchor from f16: wrist moved ${d.toExponential(2)} m on f24-f47; FK levers on the right before f24 on ${early} frames; fixed.self ${JSON.stringify({ spans: c.self?.spans })}`);
	expect("(l) x-bot half-IK arm easing onto an anchor: FK moves on its free frames, and the wrist keeps the anchor where it is held (1e-6 m)", early > 0 && d < 1e-6, String(d));
}
const half = fk["x-bot half"].r.out.ctx;
expect("(l) x-bot FK swing with the right arm half on its IK: the right arm takes FK angles and IK levers", half.fkArm.r.size > 0 && half.skinPush.r.size + half.swivel.r.size > 0, JSON.stringify([half.fkArm.r.size, half.skinPush.r.size, half.swivel.r.size]));

// (m) both arms at once: the hands crossed onto the opposite shoulders, their targets inside the chest. Each arm reads
// the other's upper arm and forearm too, so the arms take turns, the deeper first, and stack on the chest instead of
// undoing; no move takes the hands into each other
const cross = (() => {
	const P = X.restWorldPos, I = X.index, H = P[I.Hips][1], st = { root: [0, H - 0.01, 0], foot_l: [P[I.LeftFoot][0], P[I.LeftFoot][1], 0], foot_r: [-P[I.LeftFoot][0], P[I.LeftFoot][1], 0] };
	const y = v => +(H * v).toFixed(3), down = { hand_l: [0.3, y(0.95), 0.25], hand_r: [-0.3, y(0.95), 0.25] }, on = { hand_l: [-0.14, y(1.36), -0.08], hand_r: [0.14, y(1.36), -0.08] };
	return { keys: [{ f: 0, set: { ...st, armw_l: 1, armw_r: 1, ...down } }, { f: 18, set: on }, { f: 30, set: on }, { f: 47, set: down }] };
})();
const cr = run(X, specOf(cross)), crSelf = q => q.groups.filter(g => g.kind === "SELF").map(g => g.subject);
console.log(`  x-bot crossed arms: BODY/FACE ${cm(worstOwn(cr.qa0))} -> ${cm(worstOwn(cr.r.qa))} cm, QA ${cr.qa0.total} -> ${cr.r.qa.total}, SELF ${JSON.stringify([crSelf(cr.qa0), crSelf(cr.r.qa)])}, fixed.self ${JSON.stringify({ spans: cr.self?.spans, left: cr.self?.left })}`);
const crMoved = ["l", "r"].map(k => ["skinPush", "swivel"].reduce((n, m) => n + cr.r.out.ctx[m][k].size, 0) - ["skinPush", "swivel"].reduce((n, m) => n + cr.before.ctx[m][k].size, 0));
expect("(m) x-bot crossed arms: 10 cm or more before; both arms moved, the deepest under 7 cm and QA under half", worstOwn(cr.qa0) >= 0.1 && worstOwn(cr.r.qa) < 0.07 && cr.r.qa.total * 2 < cr.qa0.total
	&& cr.self?.spans?.length > 0 && crMoved.every(n => n > 0), JSON.stringify([worstOwn(cr.r.qa), cr.r.qa.total, crMoved, cr.self?.spans]));
const crWas = groupsOf(cr.qa0, ["POP", "FLIP", "SELF"]), crNow = groupsOf(cr.r.qa, ["POP", "FLIP", "SELF"]);
expect("(m) ... the hands do not go into each other (no SELF hands overlap) and no POP or FLIP is added or worse", !crSelf(cr.r.qa).includes("hands overlap") && [...crNow].every(([key, sev]) => crWas.has(key) && sev <= crWas.get(key) + 1e-9), JSON.stringify([[...crWas], [...crNow]]));

// (n) where the first moves leave a hit, the wider set: the wrist over the skin (forward, up, out to the arm's side, as
// well as along the normal) by the depth times the lever from the shoulder, up to 0.3 m, and the elbow turned 120-150
// deg. A hand swept across the front into the far thigh, and a forearm across the belly to the far hip
const wideTakes = sk => {
	const P = sk.restWorldPos, I = sk.index, H = P[I.Hips][1], st = { root: [0, H - 0.01, 0], foot_l: [P[I.LeftFoot][0], P[I.LeftFoot][1], 0], foot_r: [-P[I.LeftFoot][0], P[I.LeftFoot][1], 0], armw_l: 0, armw_r: 1 };
	const y = v => +(H * v).toFixed(3), tx = P[I.LeftUpLeg][0], rest = [-0.35, y(0.95), 0.3];
	const sweep = (to, extra = {}) => ({ keys: [{ f: 0, set: { ...st, hand_r: rest } }, { f: 24, set: { hand_r: to, ...extra } }, { f: 47, set: { hand_r: rest } }] });
	return { far: sweep([tx + 0.06, y(0.65), 0.02]), far2: sweep([tx + 0.08, y(0.7), 0.04]), belly2: sweep([0.2, y(0.98), 0.02], { elbow_r: [-0.3, -1, 0.4] }) };
};
const WX = wideTakes(X), WY = wideTakes(Y);
for (const [rig, sk, name, t, most] of [["x-bot", X, "far thigh", WX.far2, 0.04], ["y-bot", Y, "far thigh", WY.far, 0], ["x-bot", X, "belly", WX.belly2, 0]]) {
	const c = run(sk, specOf(t)), was = groupsOf(c.qa0, ["POP", "FLIP"]), now = groupsOf(c.r.qa, ["POP", "FLIP"]);
	console.log(`  ${rig} ${name}: BODY/FACE ${cm(worstOwn(c.qa0))} -> ${cm(worstOwn(c.r.qa))} cm, QA ${c.qa0.total} -> ${c.r.qa.total}, fixed.self ${JSON.stringify({ spans: c.self?.spans, iterations: c.self?.iterations, left: c.self?.left })}`);
	expect(`(n) ${rig} ${name}: 10 cm or more before; ${most ? `under ${cm(most)} cm` : "no BODY or FACE"} after, no POP or FLIP added or worse`, worstOwn(c.qa0) >= 0.1 && worstOwn(c.r.qa) <= most
		&& [...now].every(([key, sev]) => was.has(key) && sev <= was.get(key) + 1e-9), JSON.stringify([own(c.r.qa).map(g => [g.subject, g.worst]), [...was], [...now]]));
}

// (h) deterministic
const again = run(X, specOf(TX.belly));
expect("(h) the same spec twice: the same take", digest(again.r.out) === digest(belly.r.out));
// computed on macOS arm64; the box run checks them on Linux x86_64
const PINS = { "x-bot belly": "e9e5cf191f768bc5", "y-bot head": "6744752ee95fae1d", "x-bot FK walk": "83caef65278b4240" };
const takesPinned = { ...Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.r.out])), "x-bot FK walk": fk["x-bot walk"].r.out };
for (const key of Object.keys(PINS)) {
	const d = digest(takesPinned[key]);
	expect(`(h) ${key}: the repaired take's digest is pinned to 1e-9 (${d})`, d === PINS[key], `${d} != ${PINS[key]}`);
}

if (failures) { console.error(`${failures} self repair check(s) failed`); process.exit(1); }
console.log("motion3 self repair: all checks passed");
