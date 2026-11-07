#!/usr/bin/env node
// Lane socket: an object anchor with `grasp` takes the hand by a socket of its object and the compiler turns the hand
// (src/motion3/sockets.js, compiler/socket-grip.js). Sessions 02263581 (a barbell held ~90 deg off, the bar through the
// palm) and 38322b5d (a rifle's second hand measured by hand off the first). Pins: the knuckle line runs along the bar,
// grip and magazine with the bar in the palm; the carried object keeps that grasp; the left hand rides the rifle the
// right hand carries through a walk without wrist issues or pops; a stored socket's `from` sets the palm; the record
// field saves; the validator names sockets and grasps.
import assert from "node:assert/strict";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { objectPoseAt } from "../../src/motion3/object-pose.js";
import { normalizeSceneObject, updateSceneObject } from "../../src/scene-objects.js";
import { STUDIO_PATCH_SET_SCHEMAS, validateStudioSchema } from "../../src/studio-agent-protocol.js";
import { BARBELL, barbellSpec, RIFLE, rifleSpec } from "./fixtures/grasp-scenes.mjs";

const check = (name, fn) => { fn(); console.log(`ok - ${name}`); };
const sk = skeletonFor("y-bot-tpose"), I = sk.index;
const sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0), len = a => Math.hypot(...a), norm = a => a.map(v => v / len(a));
const flat = (v, n) => sub(v, n.map(x => x * dot(v, n))), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const deg = x => (Math.acos(Math.max(-1, Math.min(1, x))) * 180) / Math.PI;

/** Hand k on pose s: the knuckle line l (pinky to index), the palm side (limbs.js palmAxes: -n right, +n left), the finger middles. */
function hand(s, k) {
	const S = k === "l" ? "Left" : "Right", P = s.P, d = norm(sub(P[I[`${S}HandMiddle1`]], P[I[`${S}Hand`]])), l = norm(flat(sub(P[I[`${S}HandIndex1`]], P[I[`${S}HandPinky1`]]), d));
	const n = cross(d, l);
	return { l, palm: k === "l" ? n : n.map(v => -v), F: P[I[`${S}HandIndex2`]].map((v, i) => (v + P[I[`${S}HandMiddle2`]][i]) / 2) };
}
/** How hand k holds part `id` (its long local axis `axis`) at frame f: knuckle-line angle to the axis (deg), the axis's offset from the finger middles (m) and its side (dot with the palm side). */
function hold(r, scene, k, id, f, axis = 1) {
	const pose = objectPoseAt(r.out, id, f), a = norm([0, 1, 2].map(i => pose.R[i][axis])), c = pose.pos.map((v, i) => v + pose.R[i][1] * scene.objects[id].half[1]);
	const H = hand(r.out.frames[f].s, k), off = flat(sub(c, H.F), a);
	return { knuckle: deg(Math.abs(dot(H.l, a))), off: len(off), side: dot(norm(off), H.palm) };
}
const groups = (r, re) => r.qa.groups.filter(g => re.test(`${g.kind}:${g.subject}`));

// ---- the barbell: the session's spec, its anchors given a power grasp --------------------------------------------
const bar = motionScene(BARBELL), before = compileSpec(barbellSpec(), { sk, scene: bar }), after = compileSpec(barbellSpec("power"), { sk, scene: bar });
const HELD = [32, 60, 90, 120, 160, 200];
check("today the knuckle lines cross the bar (the session's complaint): the carrying hand 55 deg off", () => {
	const r = HELD.map(f => hold(before, bar, "r", "cylinder", f).knuckle);
	assert.ok(Math.min(...r) > 40, JSON.stringify(r));
});
// the session's keys leave the grab 8 cm short of the bar (its own REACH): the grasp still turns both hands onto it
check("with grasp power the carrying hand's knuckle line runs along the bar on every held frame", () => {
	for (const f of HELD) {
		const h = hold(after, bar, "r", "cylinder", f);
		assert.ok(h.knuckle < 10, `f${f} ${JSON.stringify(h)}`);
	}
});
check("the other hand on the bar the right hand carries takes the same grasp", () => {
	for (const f of HELD) {
		const h = hold(after, bar, "l", "cylinder", f);
		assert.ok(h.knuckle < 10, `f${f} ${JSON.stringify(h)}`);
	}
});
// the same kinds on both sides: the grasp-quality kinds (FINGER_PEN, FINGER_GAP, SUPPORT, #816; PALM_GAP, a power grip's palm
// centre off its bar, #1113) judge only a hand that takes a grasp
const sameKinds = r => r.qa.groups.filter(g => !/^(FINGER_PEN|FINGER_GAP|SUPPORT|PALM_GAP)$/.test(g.kind)).length;
check("the grasp leaves the take no worse: fewer QA problems than the same spec without it", () => assert.ok(sameKinds(after) <= sameKinds(before), `${sameKinds(before)} -> ${sameKinds(after)}`));

// ---- the rifle through a walk: right on the pistol grip, left on the magazine -------------------------------------
const rifle = motionScene(RIFLE), path = compileSpec({ ...rifleSpec(), use: rifleSpec().use.filter(u => u.skill !== "reachGrip") }, { sk, scene: rifle });
const off = sub(rifle.groups.rifle.pos, path.out.frames[30].s.P[I.Hips]), q = [0, Math.sin(-Math.PI / 4), 0, Math.cos(-Math.PI / 4)];
// keys to the last frame: a carry whose keys end before the take eases out of them in one frame there (object-keys.js)
const keys = [...Array.from({ length: 29 }, (_, i) => 30 + 6 * i), 199].map(f => ({ f, pos: path.out.frames[f].s.P[I.Hips].map((v, i) => +(v + off[i]).toFixed(4)), rot: q }));
const plain = compileSpec(rifleSpec(null, keys), { sk, scene: rifle }), held = compileSpec(rifleSpec("power", keys), { sk, scene: rifle });
const WALKING = [50, 70, 90, 110, 130, 150, 170, 190];
check("the right hand holds the pistol grip across the palm through the walk", () => {
	for (const f of [30, ...WALKING]) {
		const h = hold(held, rifle, "r", "pgrip", f);
		assert.ok(h.knuckle < 5 && h.off < 0.03 && h.side > 0.5, `f${f} ${JSON.stringify(h)}`);
	}
});
check("the left hand stays on the magazine of the rifle the right hand carries, the magazine in its palm", () => {
	for (const f of WALKING) {
		const h = hold(held, rifle, "l", "mag", f);
		assert.ok(h.off < 0.03 && h.side > 0.5, `f${f} ${JSON.stringify(h)}`);
	}
});
check("the left hand takes its grasp without a wrist issue or a pop, where the bare point left its knuckles across the magazine", () => {
	assert.deepEqual(groups(held, /^(WRIST|POP):.*(hand_l|LeftHand|LeftForeArm)/).map(g => g.subject), []);
	const was = WALKING.map(f => hold(plain, rifle, "l", "mag", f)), now = WALKING.map(f => hold(held, rifle, "l", "mag", f));
	assert.ok(now.every(h => h.side > 0.5) && was.some(h => !(h.side > 0.5)), JSON.stringify({ was: was.map(h => +h.side.toFixed(2)), now: now.map(h => +h.side.toFixed(2)) }));
});

// ---- a stored socket: its `from` sets the palm, and the record field saves ---------------------------------------
const BOX = [{ id: "crate", name: "Crate", renderer: "cube", x: 0.25, y: 0, z: 0.45, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.3, scaleY: 0.9, scaleZ: 0.3, footprint: { width: 1, depth: 1 }, height: 1,
	grasp: { top: { at: [0, 0.9, 0], from: [0, 1, 0] } } }];
check("a palm grasp on a stored socket presses the palm down onto the crate's top", () => {
	const scene = motionScene(BOX.map(normalizeSceneObject));
	assert.deepEqual(scene.objects.crate.grasp, { top: { at: [0, 0.9, 0], from: [0, 1, 0] } });
	const r = compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 50, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } },
		{ skill: "reachGrip", f0: 5, args: { anchor: "lid", side: "l", reach: 20, hold: 20, define: { kind: "object", object: "crate", socket: "top", grasp: "palm" } } }] }, { sk, scene });
	const H = hand(r.out.frames[30].s, "l");
	assert.ok(deg(dot(H.palm, [0, -1, 0])) < 15, `palm ${deg(dot(H.palm, [0, -1, 0])).toFixed(1)} deg off straight down`);
});
check("a stored socket whose side runs along its axis still compiles: the palm faces against the side", () => {
	const scene = motionScene([{ ...BOX[0], grasp: { top: { at: [0, 0.9, 0], axis: [0, 1, 0], from: [0, 1, 0] } } }].map(normalizeSceneObject));
	const r = compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 50, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } },
		{ skill: "reachGrip", f0: 5, args: { anchor: "lid", side: "l", reach: 20, hold: 20, define: { kind: "object", object: "crate", socket: "top", grasp: "power" } } }] }, { sk, scene });
	assert.ok(r.out.frames.every(fr => fr.s.P.every(p => p.every(Number.isFinite))), "a pose went NaN");
	assert.ok(deg(dot(hand(r.out.frames[30].s, "l").palm, [0, -1, 0])) < 25);
});
check("an agent's object set carries grasp sockets and the store normalizes them (unit directions, named, null removes)", () => {
	const value = { handle: { at: [0, 0.5, 0.15], axis: [2, 0, 0], from: [0, 0, 3] }, "bad name": { at: [0, 0, 0] } };
	const set = validateStudioSchema(STUDIO_PATCH_SET_SCHEMAS.object, { grasp: value }, "INVALID_ARGUMENT", "set");
	const [crate] = updateSceneObject([normalizeSceneObject(BOX[0])], "crate", set);
	assert.deepEqual(crate.grasp, { handle: { at: [0, 0.5, 0.15], axis: [1, 0, 0], from: [0, 0, 1] } });
	assert.equal(updateSceneObject([crate], "crate", { grasp: null })[0].grasp, null);
});

// ---- the validator names sockets and grasps ------------------------------------------------------------------------
const refusal = spec => { try { compileSpec(spec, { sk, scene: rifle }); return ""; } catch (error) { return error.message; } };
check("a wrong grasp or socket is refused with the choices", () => {
	const at = define => ({ ...rifleSpec(), use: [rifleSpec().use[0], { skill: "reachGrip", f0: 8, args: { anchor: "grip", side: "r", define } }] });
	assert.match(refusal(at({ kind: "object", object: "rifle", grasp: "squeeze" })), /grasp must be one of power, pinch, hook, palm/);
	assert.match(refusal(at({ kind: "object", object: "rifle", socket: "trigger", grasp: "power" })), /has no socket "trigger" \(sockets: [^)]*mag, pgrip\)/);
	assert.match(refusal(at({ kind: "object", object: "rifle", socket: "pgrip" })), /socket needs grasp/);
	assert.equal(refusal(at({ kind: "object", object: "rifle", socket: "pgrip", grasp: "power" })), "");
});
console.log("verify-motion3-socket: all checks passed");
