// General motion checks (every take): scene collisions (the fingers too: finger-collide.js), ground (the soles here,
// the rest of the body's skin in floor.js), IK reach, planted-foot slide,
// bone length, one-frame pops (style.js), knee and elbow flips, knees bending backward, knees and
// elbows folded past their stop (KNEE: the shin in the thigh; ELBOW: the forearm in the upper arm,
// compiler/limbs.js), self contact, hands and held props entering the head (and the torso,
// contact-checks.js; arms into any other body part on the fitted skin, body-checks.js). Speed, acceleration, knee bend and balance are style: style.js measures them
// and checks them only when the spec names their limit (checks.limits).
import { add, sub, scale, apply, len, dist, cross, norm, dot, angle } from "../compiler/math.js";
import { CAPSULES, segPoints, sdBox, segDist, headDepth, solePoints } from "./geometry.js";
import { contactChecks } from "./contact-checks.js";
import { bodyChecks } from "./body-checks.js";
import { popChecks } from "./style.js";
import { groundSole } from "./ground.js";
import { footChecks } from "./foot-checks.js";
import { fingerCollide } from "./finger-collide.js";
import { floorParts } from "./floor.js";
import { ELBOW_STOP, KNEE_STOP, carried } from "../compiler/limbs.js";

export const QA_LIMITS = { allow: 0.005, groundAllow: 0.01, reach: 0.01, slide: 0.0015, plantH: 0.012,
	speedCore: 0.04, speedLimb: 0.16, accCore: 0.015, accLimb: 0.05, flip: 60, knee: 150, headAllow: 0.003, self: 0,
	body: 0.005, skin: 0.015, hands: 0.01, object: 0.005, grab: 0.03, balance: 0.08 };
/** FLIP reads a bend plane only where the limb is bent this far (deg) from straight and from folded flat. */
const FLIP_BEND = 20;
/** A throw's FLIP allowance starts this many frames before its release (throwSweeps). */
const SWEEP_BEFORE = 4;
/** KNEE (folds) and ELBOW: degrees past KNEE_STOP or ELBOW_STOP that count (the IK sits on the stop to rounding). */
const STOP_TOL = 0.01;
/** KNEE (bends backward): a hinge more than this share of its length to the pelvis's right, and a bend more than acos of it (120 deg) from the knee's front (kneeBack). */
const KNEE_BACK = -0.5;
/** kneeFront reads no front for a thigh nearer than this (cos) to the opposite of its rest direction on the pelvis (26 deg). */
const SWING_MIN = -0.9;

/**
 * The front of leg S's knee on pose s (unit, across `toward`): the pelvis's forward (the rig's rest +Z, carried by the
 * hips) swung with the leg from its rest direction down the pelvis to `toward` (the hip to the knee; a hint passes the hip
 * to the ankle). The hip turns the thigh a little about itself and the knee bends toward this front; the toe says nothing
 * of it (a kneel's pointed foot runs back along the shin). Null for a leg within SWING_MIN of straight up the pelvis.
 */
export function kneeFront(sk, s, S, toward) {
	const I = sk.index, rest = norm(sub(sk.restWorldPos[I[`${S}Leg`]], sk.restWorldPos[I[`${S}UpLeg`]]));
	const u = norm(carried(sk, s, I.Hips, rest)), v = norm(toward), c = dot(u, v);
	if (c < SWING_MIN) return null;
	// the shortest turn from u to v (Rodrigues with w = u x v) applied to the pelvis's forward
	const fw = carried(sk, s, I.Hips, [0, 0, 1]), w = cross(u, v);
	const front = add(add(scale(fw, c), cross(w, fw)), scale(w, dot(w, fw) / (1 + c)));
	return norm(sub(front, scale(v, dot(front, v))));
}

/**
 * KNEE (bends backward), judged on leg S itself at pose s: its hinge (thigh x shin) points to the pelvis's left for a knee
 * bent the right way (either leg), so a hinge more than KNEE_BACK of its length to the right is backward, and so is a bend
 * more than 120 deg from the knee's front (kneeFront). A hip far out to the side or folded far up leaves the knee turned
 * differently on the two readings (flexion then abduction, or the shortest swing), so a knee is backward when both say so;
 * with the thigh straight up the pelvis (no front) the hinge alone. Bench v2, the agents' compiles replayed: the trip-run
 * knee its agent keyed backward and handstand r1's shins folded onto the belly read -0.8 to -1 and 120-180 deg; the army
 * crawl's frog legs turn to 105 deg, handstand r3's straddle reads 161 deg but +0.33, a wall climb's -0.52 but 92 deg.
 * Before, the toe's heading was the front, and a kneel's pointed foot, its toe back along the shin, read as a knee bent
 * backward (bench v2: 14 runs, 74 min open).
 */
function kneeBack(sk, s, S, bend) {
	const I = sk.index, th = s.P[I[`${S}UpLeg`]], kn = s.P[I[`${S}Leg`]], an = s.P[I[`${S}Foot`]], thigh = sub(kn, th);
	if (bend <= 3 || dot(norm(cross(thigh, sub(an, kn))), carried(sk, s, I.Hips, [1, 0, 0])) >= KNEE_BACK) return false;
	const front = kneeFront(sk, s, S, thigh), mid = sub(kn, scale(add(th, an), 0.5)), v = norm(thigh);
	return !front || dot(norm(sub(mid, scale(v, dot(mid, v)))), front) < KNEE_BACK;
}

export const allowance = (allow, part, obj) => {
	for (const a of allow ?? []) if (part.startsWith(a.part) && (a.object === obj || (a.object.endsWith("*") && obj.startsWith(a.object.slice(0, -1))))) return a.depth;
	return null;
};

/**
 * What the world says of the body at frame f: COLLIDE (capsules, feet and fingers in the scene bodies `objs`, out.objectsAt),
 * GROUND (soles and skin under the floor) and REACH. fix/flight-gate.js reads the same before and after a flight fix.
 */
export function worldChecks(sk, { s, diag }, f, objs, L, allow, push) {
	const I = sk.index;
	// bounding spheres of the boxes: a capsule farther away than its own reach cannot touch one
	const spheres = Object.entries(objs).filter(([, box]) => box.half && !box.ignore)
		.map(([id, box]) => [id, box, add(box.pos, apply(box.R, [0, box.half[1], 0])), len(box.half)]);
	for (const [part, a, b, r] of CAPSULES) {
		const A = s.P[I[a]], B = s.P[I[b]], mid = scale(add(A, B), 0.5), reach = r + dist(A, B) / 2;
		let pts = null;
		for (const [id, box, c, rb] of spheres) {
			const lim = allowance(allow, part, id) ?? L.allow;
			if (reach - (dist(mid, c) - rb) <= lim) continue;
			pts ??= segPoints(A, B);
			const pen = r - Math.min(...pts.map(p => sdBox(p, box)));
			if (pen > lim) push("COLLIDE", `${part} x ${id}`, f, pen, lim);
		}
	}
	footChecks(sk, s, f, spheres, L, (part, id) => allowance(allow, part, id), push);
	fingerCollide(sk, s, f, spheres, L, (part, id) => allowance(allow, part, id), push);
	for (const side of ["Left", "Right"]) {
		const sp = solePoints(sk, s, side), low = Math.min(sp.heel[1], sp.ball[1], sp.tip[1]);
		if (low < -L.groundAllow) push("GROUND", `${side} sole below floor`, f, -low, L.groundAllow);
	}
	// the rest of the body under the floor: palms, fingers, arms, knees, hips, torso, head (floor.js)
	for (const [part, depth] of floorParts(sk, s, L.groundAllow)) push("GROUND", `${part} below floor`, f, depth, L.groundAllow);
	for (const [k, v] of Object.entries(diag)) if (/miss_[lr]$/.test(k) && v > L.reach) push("REACH", k, f, v, L.reach);
}

export function generalChecks(sk, out, opts = {}) {
	const L = { ...QA_LIMITS, ...opts.limits }, issues = [], I = sk.index, F = out.frames, n = F.length;
	const push = (kind, msg, f, value, limit) => issues.push({ kind, msg, frame: f, value: +value.toFixed(4), limit });
	for (let f = 0; f < n; f++) {
		const { s, diag } = F[f];
		worldChecks(sk, F[f], f, out.objectsAt(f), L, opts.allow, push);
		// hands, forearms and held props must stay out of the head
		const probes = [];
		for (const S of ["Left", "Right"]) probes.push(...segPoints(s.P[I[`${S}Hand`]], s.P[I[`${S}HandMiddle3`]], 5).map(p => [`hand_${S[0].toLowerCase()}`, p, 0.022]));
		for (const [pn, pts] of Object.entries(diag.props ?? {})) for (const [k, p] of Object.entries(pts)) if (Array.isArray(p) && k !== "origin" && !(opts.mouthPoints ?? []).includes(`${pn}.${k}`)) probes.push([`prop_${pn}`, p, 0.004]);
		for (const [nm, p, r] of probes) { const d = headDepth(sk, s, p) + r; if (d > L.headAllow) push("FACE", `${nm} into head`, f, d, L.headAllow); }
		if (segDist(s.P[I.LeftLeg], s.P[I.LeftFoot], s.P[I.RightLeg], s.P[I.RightFoot]) < 0.1 + L.self) push("SELF", "shins touch", f, 0.1, 0.1);
		if (segDist(s.P[I.LeftUpLeg], s.P[I.LeftLeg], s.P[I.RightUpLeg], s.P[I.RightLeg]) < 0.135 + L.self) push("SELF", "thighs overlap", f, 0.135, 0.135);
		for (const S of ["Left", "Right"]) {
			const th = s.P[I[`${S}UpLeg`]], kn = s.P[I[`${S}Leg`]], an = s.P[I[`${S}Foot`]];
			const bend = angle(sub(kn, th), sub(an, kn));
			// the leg itself in any body orientation (a flip, lying), not the toe's heading (kneeBack)
			if (kneeBack(sk, s, S, bend)) push("KNEE", `${S} knee bends backward`, f, bend, 0);
			// a knee folded past its stop puts the shin in the thigh (the solver stops at KNEE_STOP)
			if (bend > KNEE_STOP + STOP_TOL) push("KNEE", `${S} knee folds ${bend.toFixed(0)}deg`, f, bend, KNEE_STOP);
			// an elbow folded past its stop puts the forearm in the upper arm (the solver stops at ELBOW_STOP)
			const fold = angle(sub(s.P[I[`${S}ForeArm`]], s.P[I[`${S}Arm`]]), sub(s.P[I[`${S}Hand`]], s.P[I[`${S}ForeArm`]]));
			if (fold > ELBOW_STOP + STOP_TOL) push("ELBOW", `${S} elbow folds ${fold.toFixed(0)}deg`, f, fold, ELBOW_STOP);
		}
	}
	const allowed = (part, into) => allowance(opts.allow, part, into);
	contactChecks(sk, out, L, push, allowed);
	bodyChecks(sk, out, L, push, allowed);
	// temporal checks; a planted heel or ball is low over the ground under it, the floor or an object's top (ground.js)
	for (const S of ["Left", "Right"]) {
		const sole = F.map((_, f) => groundSole(out, f, S));
		for (let f = 1; f < n; f++) {
			const a = sole[f - 1], b = sole[f];
			for (const key of ["heel", "ball"]) {
				const planted = b[key][1] < L.plantH && a[key][1] < L.plantH && Math.abs(b[key][1] - a[key][1]) < 0.0005;
				const hv = Math.hypot(b[key][0] - a[key][0], b[key][2] - a[key][2]);
				if (planted && hv > L.slide) push("SLIDE", `${S} ${key} slides`, f, hv, L.slide);
			}
		}
	}
	for (let j = 0; j < sk.names.length; j++) {
		const p = sk.parent[j]; if (p < 0) continue;
		const L0 = dist(sk.restWorldPos[j], sk.restWorldPos[p]);
		const drift = Math.max(...F.map(fr => Math.abs(dist(fr.s.P[j], fr.s.P[p]) - L0)));
		if (drift > 0.001) push("LENGTH", `${sk.names[p]}-${sk.names[j]}`, 0, drift, 0.001);
	}
	popChecks(sk, out, L, push);
	flipChecks(sk, F, L, push, throwSweeps(sk, out), out.f0 ?? 0);
	return issues;
}

/**
 * FLIP: a knee's or elbow's bend plane turns more than L.flip degrees a frame. The plane is read
 * only on frames the limb is bent FLIP_BEND or more from straight and from folded flat: near
 * either end a few millimetres set it, so the hand or foot moving a few centimetres turns it any
 * way (session df6acdcc: the right elbow folded to 171 deg as the wrist passed the shoulder, and
 * its plane turned 71 deg in a frame while the elbow moved 3 cm). Across the frames between, the
 * turn is shared out per frame, so a pole that flips while the limb is straight still shows.
 * `flips` ({ bone, from, to, limit }, throwSweeps) raises the limit on a throwing arm about its release.
 */
/** A carry let go with a fall velocity (a throw) sweeps its hand round the shoulder at about |v| / (shoulder to wrist) a
 * frame, and the elbow's bend plane turns with it: at the baseball throw's 12.5 m/s that is 55 deg a frame at the release
 * against L.flip 60, the throwObject spec 64 deg at f64. From SWEEP_BEFORE frames before the release to the frame after
 * it, that arm's FLIP limit is twice the sweep. */
function throwSweeps(sk, out) {
	const objects = out.ctx?.spec?.objects ?? {}, props = out.ctx?.spec?.props ?? {}, f0 = out.f0 ?? 0, fps = out.ctx?.spec?.fps ?? 24, flips = [];
	for (const o of Object.values(objects)) {
		const v = o.fall?.v, side = props[o.prop]?.hand, rel = o.release, fr = out.frames[rel - f0];
		if (!Array.isArray(v) || (side !== "l" && side !== "r") || !Number.isInteger(rel) || !fr) continue;
		const S = side === "l" ? "Left" : "Right", r = dist(fr.s.P[sk.index[`${S}Hand`]], fr.s.P[sk.index[`${S}Arm`]]);
		if (r > 0.05) flips.push({ bone: `${S}ForeArm`, from: rel - SWEEP_BEFORE, to: rel + 1, limit: (2 * len(v) * 180) / (fps * r * Math.PI) });
	}
	return flips;
}

function flipChecks(sk, F, L, push, flips, f0) {
	const I = sk.index, bent = Math.sin(FLIP_BEND * Math.PI / 180);
	for (const S of ["Left", "Right"]) for (const [a, b, c] of [[`${S}UpLeg`, `${S}Leg`, `${S}Foot`], [`${S}Arm`, `${S}ForeArm`, `${S}Hand`]]) {
		let prev = null, at = 0;
		for (let f = 0; f < F.length; f++) {
			const P = F[f].s.P, up = sub(P[I[b]], P[I[a]]), down = sub(P[I[c]], P[I[b]]), nv = cross(up, down);
			if (len(nv) < bent * len(up) * len(down)) continue;
			const u = norm(nv), turn = prev ? angle(u, prev) : 0, gap = f - at;
			const lim = Math.max(L.flip, ...flips.filter(x => x.bone === b && f + f0 >= x.from && f + f0 <= x.to).map(x => x.limit));
			if (turn / gap > lim) push("FLIP", `${b} bend plane jumps ${turn.toFixed(0)}deg${gap > 1 ? ` over ${gap} frames` : ""}`, f, turn / gap, lim);
			prev = u; at = f;
		}
	}
}
