// Shared measurement definitions of the physical motion bench (docs/qa/physics-bench.md, PR 3; plan 2.1). They read a
// take.json only, so one code path measures both tools. Every number is a starting value (plan 7: tuned on two trial
// tasks, then frozen). Diagnostic only: the human verdicts decide quality (plan 4.2).
// Geometry reuses CozyClay's QA proxies: body capsules (qa/geometry.js CAPSULES), segment masses (qa/com.js), the
// support polygon (convexHull, supportMargin) and the one-frame pop test (qa/style.js popChecks with QA_LIMITS).
import { QA_LIMITS } from "../../../src/motion3/qa/checks.js";
import { centerOfMass, supportMargin } from "../../../src/motion3/qa/com.js";
import { CAPSULES, segPoints } from "../../../src/motion3/qa/geometry.js";
import { popChecks } from "../../../src/motion3/qa/style.js";
import { skeletonFor } from "../../../src/motion3/rigs/index.js";
import { landmarksAt, objectMatrixAt, unmat4 } from "./take.mjs";

export const sk = skeletonFor("y-bot-tpose");
export const DEF = { contact: 0.03, plant: QA_LIMITS.plantH, penetration: 0.02, slide: 0.02, airborne: 3, gravityError: 0.05, gravitySpeed: 0.3, g: 9.81,
	stillSpeed: 0.1, balanceMargin: 0.08, standTol: 0.03, boneLength: 0.01, bodyMass: 70 };
export const STAND_HIPS = sk.restWorldPos[sk.index.Hips][1];
const FPS = 24, DT = 1 / FPS;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const apply = (R, v) => [0, 1, 2].map(i => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]);
const T = R => [0, 1, 2].map(i => [R[0][i], R[1][i], R[2][i]]);
const len = v => Math.hypot(v[0], v[1], v[2]);
export const dist = (a, b) => len(sub(a, b));
const AXIS = { x: 0, y: 1, z: 2 };

/** Signed distance from p to an object surface: { kind: "box" | "cylinder", c, R, half, axis }. */
export function sd(p, s) {
	const q = apply(T(s.R), sub(p, s.c));
	if (s.kind === "cylinder") {
		const a = AXIS[s.axis], r = s.half[(a + 1) % 3], h = s.half[a];
		const radial = Math.hypot(...q.filter((_, i) => i !== a)) - r, along = Math.abs(q[a]) - h;
		return Math.hypot(Math.max(radial, 0), Math.max(along, 0)) + Math.min(Math.max(radial, along), 0);
	}
	const d = q.map((v, i) => Math.abs(v) - s.half[i]);
	return Math.hypot(...d.map(v => Math.max(v, 0))) + Math.min(Math.max(...d), 0);
}

/** One take measured frame by frame: poses, landmarks, the bodies of the set at each frame, contacts, COM. */
export function measure(take, set, id = "char-a") {
	const F = take.frames, bodies = set.objects.filter(o => o.shape !== "group");
	const frames = [];
	for (let f = 0; f < F; f++) {
		const ms = take.characters[id].bones[f].map(unmat4), s = { P: ms.map(m => m.p), R: ms.map(m => m.R) };
		const surfaces = bodies.filter(o => take.objects[o.id]?.matrix?.length).map(o => {
			const { R, p } = unmat4(objectMatrixAt(take, o.id, f));
			return { id: o.id, kind: o.shape, axis: o.axis, c: p, R, half: o.size.map(v => v / 2) };
		});
		const L = landmarksAt(take, id, f);
		// touch: within DEF.contact of a surface (plan 2.1); planted: within the QA plant height, the stricter contact
		// a slide is measured on (a swing foot that passes low over the floor is touching but not planted)
		const touch = {}, planted = {};
		for (const [name, p] of Object.entries(L)) {
			let best = { id: "floor", d: p[1] };
			for (const surf of surfaces) { const d = sd(p, surf); if (d < best.d) best = { id: surf.id, d }; }
			touch[name] = best.d <= DEF.contact ? best.id : null;
			planted[name] = best.d <= DEF.plant ? best.id : null;
		}
		frames.push({ s, L, surfaces, touch, planted, com: centerOfMass(sk, s) });
	}
	return { take, set, F, frames };
}

const surfaceOf = (fr, id) => fr.surfaces.find(s => s.id === id);
/** A point in the frame of surface `id` at that frame (the floor is the world). */
const local = (fr, id, p) => { const s = surfaceOf(fr, id); return s ? apply(T(s.R), sub(p, s.c)) : p; };

/** Spans [a, b] (inclusive) where pred(f) holds for at least `min` frames. */
export function spans(F, pred, min = 1) {
	const out = [];
	for (let f = 0, a = -1; f <= F; f++) {
		if (f < F && pred(f)) { if (a < 0) a = f; } else if (a >= 0) { if (f - a >= min) out.push([a, f - 1]); a = -1; }
	}
	return out;
}

/** Frames where no landmark touches any surface, in spans of at least DEF.airborne frames. */
export const airborneSpans = m => spans(m.F, f => Object.values(m.frames[f].touch).every(t => t === null), DEF.airborne);

/** Gravity check of a span: COM height fit to a + b·t − ½gt² (max error) and the horizontal speed change. */
export function gravityCheck(m, [a, b]) {
	const ys = [], ts = [];
	for (let f = a; f <= b; f++) { const t = (f - a) * DT; ts.push(t); ys.push(m.frames[f].com[1] + 0.5 * DEF.g * t * t); }
	const n = ts.length, mt = ts.reduce((x, y) => x + y, 0) / n, my = ys.reduce((x, y) => x + y, 0) / n;
	const slope = ts.reduce((acc, t, i) => acc + (t - mt) * (ys[i] - my), 0) / (ts.reduce((acc, t) => acc + (t - mt) ** 2, 0) || 1);
	const error = Math.max(...ts.map((t, i) => Math.abs(ys[i] - (my + slope * (t - mt)))));
	const vh = f => { const p = m.frames[Math.min(b, f + 1)].com, q = m.frames[Math.max(a, f - 1)].com, k = (Math.min(b, f + 1) - Math.max(a, f - 1)) * DT; return [(p[0] - q[0]) / k, (p[2] - q[2]) / k]; };
	const v0 = vh(a), v1 = vh(b), speedChange = Math.hypot(v1[0] - v0[0], v1[1] - v0[1]);
	return { span: [a, b], error, speedChange, pass: error <= DEF.gravityError && speedChange <= DEF.gravitySpeed };
}

/** Largest capsule depth (m) inside an object or the floor at frame f, and where. `only` limits the surfaces. */
export function capsuleDepth(m, f, only = null) {
	const fr = m.frames[f], I = sk.index;
	let best = { depth: 0, part: null, surface: null };
	for (const [part, a, b, r] of CAPSULES) {
		for (const p of segPoints(fr.s.P[I[a]], fr.s.P[I[b]], 7)) {
			if (!only || only.includes("floor")) { const d = r - p[1]; if (d > best.depth) best = { depth: d, part, surface: "floor" }; }
			for (const s of fr.surfaces) if (!only || only.includes(s.id)) { const d = r - sd(p, s); if (d > best.depth) best = { depth: d, part, surface: s.id }; }
		}
	}
	return best;
}

/** Largest slide (m) of `names` while each stays planted on one surface, measured in that surface's frame. Hands
 * and knees on a body use the touch distance (their landmark sits inside the limb, a palm 2 cm under the skin). */
export function slide(m, names, from = 0, to = m.F - 1) {
	let worst = { slide: 0, name: null, frame: null };
	for (const name of names) {
		let id = null, p0 = null;
		for (let f = from; f <= to; f++) {
			const fr = m.frames[f], t = (FOOT.has(name) ? fr.planted : fr.touch)[name];
			if (!t) { id = null; continue; }
			if (t !== id) { id = t; p0 = local(fr, id, fr.L[name]); continue; } // a new contact starts here
			const d = sub(local(fr, id, fr.L[name]), p0), along = id === "floor" ? Math.hypot(d[0], d[2]) : len(d);
			if (along > worst.slide) worst = { slide: along, name, frame: f };
		}
	}
	return worst;
}

const SOLES = { l: ["heel_l", "ball_l", "toe_tip_l"], r: ["heel_r", "ball_r", "toe_tip_r"] }, FOOT = new Set([...SOLES.l, ...SOLES.r]);
export const footDown = (fr, k, where = null) => SOLES[k].some(n => fr.touch[n] !== null && (!where || fr.touch[n] === where));
/** Support polygon points [x, z]: every landmark touching the floor or the top of a body. */
function supportPoints(fr, names = Object.keys(fr.L)) {
	return names.filter(n => fr.touch[n] === "floor" || (fr.touch[n] && local(fr, fr.touch[n], fr.L[n])[1] > 0)).map(n => [fr.L[n][0], fr.L[n][2]]);
}

/** Support height under the feet at frame f: the highest surface top a sole touches (0 on the floor). */
function groundUnder(fr) {
	let h = 0;
	for (const n of [...SOLES.l, ...SOLES.r]) if (fr.touch[n] && fr.touch[n] !== "floor") h = Math.max(h, fr.L[n][1]);
	return h;
}
/** Standing: hips at the rig's standing height (± DEF.standTol) over the ground under the feet, both feet down. */
export const standing = (m, f) => { const fr = m.frames[f]; return footDown(fr, "l") && footDown(fr, "r") && Math.abs(fr.s.P[sk.index.Hips][1] - groundUnder(fr) - STAND_HIPS) <= DEF.standTol; };

/** Frames where the COM is still (speed < DEF.stillSpeed) and sits outside its support polygon by more than the margin,
 * or has no support at all. */
export function balanceFails(m, frames, com = f => m.frames[f].com, names) {
	const out = [];
	for (const f of frames) {
		if (f < 1 || f >= m.F - 1) continue;
		const v = dist(com(f + 1), com(f - 1)) / (2 * DT);
		if (v >= DEF.stillSpeed) continue;
		const pts = supportPoints(m.frames[f], names);
		// a still body held up by nothing fails: both callers require support over the frames they pass
		if (!pts.length) { out.push({ frame: f, margin: -Infinity, unsupported: true }); continue; }
		const c = com(f), { margin } = supportMargin([c[0], c[2]], pts);
		if (margin < -DEF.balanceMargin) out.push({ frame: f, margin });
	}
	return out;
}

/** Elbow angle (degrees) of side "l" | "r" at frame f: 180 is straight. */
export function elbowAngle(m, f, k) {
	const S = k === "l" ? "Left" : "Right", P = m.frames[f].s.P, I = sk.index;
	const u = sub(P[I[`${S}Arm`]], P[I[`${S}ForeArm`]]), v = sub(P[I[`${S}Hand`]], P[I[`${S}ForeArm`]]);
	return (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (len(u) * len(v))))) * 180) / Math.PI;
}

/** The violations every task is measured on (plan 2.1): penetration, pops, bone length, hovering, foot slide. */
export function shared(m) {
	let pen = { depth: 0 };
	const penFrames = [];
	for (let f = 0; f < m.F; f++) { const d = capsuleDepth(m, f); if (d.depth > DEF.penetration) penFrames.push(f); if (d.depth > pen.depth) pen = { ...d, frame: f }; }
	const pops = [];
	popChecks(sk, { frames: m.frames.map(fr => ({ s: fr.s })) }, QA_LIMITS, (kind, msg, f) => pops.push({ frame: f, msg }));
	let bone = { change: 0 };
	for (let b = 1; b < sk.names.length; b++) {
		const p = sk.parent[b], rest = dist(sk.restWorldPos[b], sk.restWorldPos[p]);
		if (rest < 0.01) continue;
		for (let f = 0; f < m.F; f++) { const c = Math.abs(dist(m.frames[f].s.P[b], m.frames[f].s.P[p]) / rest - 1); if (c > bone.change) bone = { change: c, bone: sk.names[b], frame: f }; }
	}
	const hover = airborneSpans(m).map(sp => gravityCheck(m, sp)).filter(g => !g.pass);
	return { penetration: { depth: pen.depth, part: pen.part, surface: pen.surface, frame: pen.frame, frames: penFrames.length }, pops: pops.length,
		boneLength: bone, hovering: hover.map(h => ({ span: h.span, error: h.error, speedChange: h.speedChange })), footSlide: slide(m, [...SOLES.l, ...SOLES.r]) };
}

export const PALMS = ["palm_l", "palm_r"];
