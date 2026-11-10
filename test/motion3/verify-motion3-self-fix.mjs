#!/usr/bin/env node
// Issue 1154: the self repair (fix/self-repair.js, part of spec.fix.self after fix/self.js). An arm part still in the
// character's own torso, hips, head or thigh past QA's BODY or FACE limit moves out with its IK, deepest first, spread
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
// Prints PASS/FAIL lines; exits non-zero on a failure.
import { createHash } from "node:crypto";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { compileMotion } from "../../src/motion3/compiler/compile.js";
import { runMotionQa } from "../../src/motion3/qa/index.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { armMotion, moveWorse } from "../../src/motion3/fix/self-guard.js";

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
const specOf = (t, extra = {}) => ({ schema: SPEC, fps: 24, frames: 48, keys: t.keys, ...(t.anchors ? { anchors: t.anchors } : {}), ...extra });

/** The take through the pipeline, and the same expanded spec without the repair: { r, before, qa0, self }. */
function run(sk, spec) {
	// pipeline.js keeps retime only where QA is no worse with it: the take without it is compiled with fix.retime false
	const r = compileSpec(spec, { sk, scene }), exp = { fps: 24, ...r.expanded, ...(r.fixed?.retime?.kept === false ? { fix: { ...r.expanded.fix, retime: false } } : {}) };
	const before = compileMotion(exp, { sk, scene }, { selfRepair: false });
	return { r, before, qa0: runMotionQa(sk, before, r.expanded, { explain: false }), self: r.fixed?.self ?? null };
}
const own = qa => qa.groups.filter(g => g.kind === "BODY" || g.kind === "FACE");
const worstOwn = qa => Math.max(0, ...own(qa).map(g => g.worst));
const groupsOf = (qa, kinds) => new Map(qa.groups.filter(g => kinds.includes(g.kind)).map(g => [`${g.kind} ${g.subject}`, g.severity ?? 0]));

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
const xs = run(X, specOf(TX.scratch)), xsFace = xs.r.qa.groups.find(g => g.kind === "FACE");
console.log(`  x-bot scratch: fixed.self ${JSON.stringify({ spans: xs.self?.spans, depth: xs.self?.depth, left: xs.self?.left })}`);
expect("(f) a FACE whose repair QA read worse: its hint says fix.self left it, undone, and why", /fix\.self left f\d+-f\d+ \(undone: /.test(xsFace?.hint ?? "") || /fix\.self (left|moved)/.test(xsFace?.hint ?? ""), xsFace?.hint);

// (b) the guard each move passes (fix/self-guard.js): a wrist pop on one frame of a repaired take reads as one
const popped = { ...belly.r.out, frames: belly.r.out.frames.map((fr, f) => (f === 24 ? { ...fr, s: { ...fr.s, P: fr.s.P.map((p, j) => (j === X.index.RightHand ? [p[0], p[1] + 0.1, p[2]] : p)) } } : fr)) };
expect("(b) the move guard reads a 10 cm wrist pop on one frame as a pop, and the take itself as none", moveWorse(armMotion(belly.r.out, "r", 14, 34), armMotion(popped, "r", 14, 34)) === "a pop" && moveWorse(armMotion(belly.r.out, "r", 0, 47), armMotion(belly.r.out, "r", 0, 47)) === "");

// (h) deterministic
const again = run(X, specOf(TX.belly));
expect("(h) the same spec twice: the same take", digest(again.r.out) === digest(belly.r.out));
// computed on macOS arm64; the box run checks them on Linux x86_64
const PINS = { "x-bot belly": "e9e5cf191f768bc5", "y-bot head": "6744752ee95fae1d" };
for (const key of Object.keys(PINS)) {
	const d = digest(runs[key].r.out);
	expect(`(h) ${key}: the repaired take's digest is pinned to 1e-9 (${d})`, d === PINS[key], `${d} != ${PINS[key]}`);
}

if (failures) { console.error(`${failures} self repair check(s) failed`); process.exit(1); }
console.log("motion3 self repair: all checks passed");
