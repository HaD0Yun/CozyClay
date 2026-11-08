#!/usr/bin/env node
// Lane reach (grasp round 2): reachGrip moves like a person's reach to grasp (src/motion3/skills/reach-human.js).
// Session 7f15b4ae ("컵만들고 컵 손으로 잡아봐", the installed spec): the wrist's speed peaked late (57 % of the reach),
// the fingers closed from the first frame (thumb tip to index tip 11.5 -> 3 cm by mid-reach, under the 8 cm cup) and
// the head never turned to the cup (66 deg off). Pins: an early-peaked transport ending in a slow approach, the hand open
// wider than a can through the transport, the head on the cup before the hand, one planned grasp turn (no wrist jump), the old ease for a wide
// box and for a reach to a moving prop, and a head the spec keys left alone.
import assert from "node:assert/strict";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { signedDistance } from "../../src/motion3/shapes.js";

const check = (name, fn) => { fn(); console.log(`ok - ${name}`); };
const sub = (a, b) => a.map((v, i) => v - b[i]), len = a => Math.hypot(...a), dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = a => a.map(v => v / len(a)), deg = x => (Math.acos(Math.max(-1, Math.min(1, x))) * 180) / Math.PI;
const rec = (id, r, x, y, z, sx, sy, sz) => ({ id, name: id, renderer: r, x, y, z, rot: 0, rotX: 0, rotZ: 0, scaleX: sx, scaleY: sy, scaleZ: sz, footprint: { width: 1, depth: 1 }, height: 1 });
const TABLE = rec("cube", "cube", -0.1, 0, 0.62, 0.7, 0.75, 0.5), CUP = rec("cylinder", "cylinder", -0.2, 0.75, 0.43, 0.08, 0.1, 0.08);
const F0 = 10, REACH = 22;
const spec = (anchor, keys) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto", label: "grab cup", anchors: { cup: anchor }, ...(keys ? { keys } : {}),
	use: [{ skill: "standIdle", args: { at: [-0.03, 0.08], heading: 0 }, f0: 0 }, { skill: "reachGrip", args: { anchor: "cup", side: "r", reach: REACH, hold: 30, release: 14 }, f0: F0 }] });
const run = (sk, objs, s) => compileSpec(s, { sk, scene: motionScene(objs) });

function measure(sk, r, target) {
	const I = sk.index, F = r.out.frames, P = f => F[f].s.P, wrist = f => P(f)[I.RightHand];
	const speed = Array.from({ length: REACH + 4 }, (_, i) => len(sub(wrist(F0 + i + 1), wrist(F0 + i))));
	const top = Math.max(...speed), on = speed.findIndex(v => v > 0.05 * top), off = speed.length - 1 - [...speed].reverse().findIndex(v => v > 0.05 * top);
	const aperture = f => len(sub(P(f)[I.RightHandThumb4], P(f)[I.RightHandIndex4]));
	const R0 = F[0].s.R[I.Head], col = (R, j) => [R[0][j], R[1][j], R[2][j]];
	const j = [0, 1, 2].reduce((m, i) => (Math.abs(col(R0, i)[2]) > Math.abs(col(R0, m)[2]) ? i : m), 0), sg = Math.sign(col(R0, j)[2]);
	const gaze = f => deg(dot(col(F[f].s.R[I.Head], j).map(v => v * sg), norm(sub(target, P(f)[I.Head]))));
	return { peakAt: (speed.indexOf(top) - on) / (off - on), speed, aperture, gaze };
}

const cupMid = [CUP.x, CUP.y + CUP.scaleY / 2, CUP.z];
for (const rig of ["y-bot-tpose", "x-bot-tpose"]) {
	const sk = skeletonFor(rig), session = run(sk, [TABLE, CUP], spec({ kind: "world", p: cupMid })), m = measure(sk, session, cupMid);
	check(`${rig}: the wrist's speed peaks early, about a third into the reach, and the slow approach takes the rest`, () => assert.ok(m.peakAt <= 0.45 && m.peakAt >= 0.2, `${m.peakAt}`));
	// a can (6.6 cm) fits both rigs' open hands with the margin (Y Bot 11.5 cm, X Bot 9.7 cm; the 8 cm cup only the Y Bot's)
	check(`${rig}: the hand stays open wider than a can through the fast transport, then closes on it in the slow approach`, () => {
		const can = rec("cylinder", "cylinder", -0.18, 0.75, 0.42, 0.066, 0.122, 0.066), took = run(sk, [TABLE, can], spec({ kind: "object", object: "cylinder", local: [0, 0.06, 0], grasp: "power" })), c = measure(sk, took, cupMid);
		for (let f = F0; f <= F0 + Math.round(0.38 * REACH); f++) assert.ok(c.aperture(f) >= 0.066 + 0.015, `f${f} ${c.aperture(f)}`);
		// closes on it: the aperture shrinks, or (fingers that stop on the can, #816) the thumb and index tips are on its side
		// (the X Bot's arm is short of the can at this stance: fix.reach leans the body to it, fix/reach-body.js, and the hand
		// wraps it, the index tip 2 cm off its side)
		const end = took.out.frames[F0 + REACH].s.P, onCan = (b, tol = 0.008) => signedDistance(took.out.ctx.objectsAt(F0 + REACH).cylinder, end[sk.index[b]]) - 0.009 <= tol;
		const leaned = took.fixed.reachBody && !took.qa.groups.some(g => g.kind === "REACH") && onCan("RightHandThumb4", 0.012) && onCan("RightHandIndex4", 0.012);
		assert.ok(c.aperture(F0 + REACH) < c.aperture(F0) - 0.02 || (onCan("RightHandThumb4") && onCan("RightHandIndex4")) || leaned, `${c.aperture(F0 + REACH)}`);
	});
	check(`${rig}: the head turns to the cup before the hand gets there and stays on it`, () => {
		assert.ok(m.gaze(F0) > 45, `start ${m.gaze(F0)}`);
		for (const f of [F0 + 9, F0 + REACH, F0 + REACH + 20]) assert.ok(m.gaze(f) < 25, `f${f} ${m.gaze(f)}`);
	});
	// the fingers are measured against the scene since #1113 (finger-collide.js): the Y Bot's fingertips go 1.9 cm into the cup the
	// session's world anchor (the cup's middle) puts the fingers' point on, a third problem; no deeper, and the hand stays out
	check(`${rig}: the session's take is no worse in QA: its 2 problems (REACH, CONTACT) and the fingertips at most 2 cm in the cup, no hand in it`, () => {
		const fingers = session.qa.groups.filter(g => g.kind === "COLLIDE" && g.subject === "fingers_r x cylinder"), line = session.qa.groups.map(g => `${g.kind}:${g.subject}`).join(" | ");
		assert.ok(session.qa.problems - fingers.length <= 2 && fingers.every(g => g.worst <= 0.02), line);
		assert.ok(!session.qa.groups.some(g => g.kind === "COLLIDE" && !fingers.includes(g)), line);
	});
}

const sk = skeletonFor("y-bot-tpose"), I = sk.index;
check("a cup taken by grasp: the grasp turn is planned once, so the wrist never jumps in a frame (5.5 cm at the close before)", () => {
	const r = run(sk, [TABLE, CUP], spec({ kind: "object", object: "cylinder", local: [0, 0.05, 0], grasp: "power" }));
	for (let f = F0; f < F0 + REACH + 4; f++) {
		const step = len(sub(r.out.frames[f + 1].s.P[I.RightHand], r.out.frames[f].s.P[I.RightHand]));
		assert.ok(step < 0.045, `f${f} ${step}`);
	}
	assert.ok(!r.qa.groups.some(g => g.kind === "POP"), r.qa.groups.map(g => `${g.kind}:${g.subject}`).join(" | "));
});
check("a 10 cm box the open hand cannot clear closes along the reach (open fingers would sweep into it)", () => {
	const box = rec("box", "cube", -0.2, 0.75, 0.43, 0.1, 0.1, 0.1), r = run(sk, [TABLE, box], spec({ kind: "object", object: "box", local: [0, 0.05, 0], grasp: "power" })), m = measure(sk, r, cupMid);
	assert.ok(m.aperture(F0 + 11) < m.aperture(F0) - 0.02, `${m.aperture(F0)} -> ${m.aperture(F0 + 11)}`);
	assert.ok(!r.qa.groups.some(g => g.kind === "COLLIDE" && /box/.test(g.subject)), r.qa.groups.map(g => `${g.kind}:${g.subject}`).join(" | "));
});
check("a head the spec keys during the reach is left alone", () => {
	const r = run(sk, [TABLE, CUP], spec({ kind: "world", p: cupMid }, [{ f: 20, set: { head_yaw: -20, head_pitch: 0 } }]));
	assert.ok(Math.abs((r.out.frames[F0 + REACH].c.head_yaw ?? 0) + 20) < 1e-6, `${r.out.frames[F0 + REACH].c.head_yaw}`);
});
check("a thing spec.objects moves during the reach is not planned from where it started: no gaze keys, the plain ease", () => {
	const moving = { ...spec({ kind: "object", object: "cylinder", local: [0, 0.05, 0] }), objects: { cylinder: { keys: [{ f: 0, pos: [CUP.x, CUP.y, CUP.z] }, { f: 20, pos: [CUP.x + 0.1, CUP.y, CUP.z] }] } } };
	const r = run(sk, [TABLE, CUP], moving), keyed = r.out.keys.filter(k => /reachGrip/.test(k.src ?? "") && k.f > F0 && k.f < F0 + REACH);
	assert.ok(!keyed.some(k => k.set?.head_yaw !== undefined || k.set?.[`w_cup_r`] !== undefined), JSON.stringify(keyed.map(k => [k.f, Object.keys(k.set)])));
});
