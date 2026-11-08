// Two-bone limb IK, foot orientation, wrist and finger posing on a world-space state.
// Every edit rotates a bone's subtree about that bone's own joint, so the result maps
// exactly back to local quaternions (skeleton.js toLocal).
import { add, sub, scale, dot, len, norm, cross, clamp, apply, T, align, axisRot, ry, rx } from "./math.js";
import { rotateSubtree, restState } from "./skeleton.js";
import { GRASP_POINTS } from "./vocab.js";

/** Direction fixed to bone b that points along `restDir` in the rest pose. */
export const carried = (sk, s, b, restDir) => apply(s.R[b], apply(T(sk.restWorldRot[b]), restDir));

// Elbow flexion: degrees between the upper arm and the forearm (0 straight), read on the joints as QA
// reads it (Arm->ForeArm against ForeArm->Hand). Active flexion ends near 145 deg (clinical norms
// 140-150: AMA 140, Kendall 145, AAOS 150), where the forearm's muscle meets the upper arm's; the
// passive fold stops a few degrees on. An arm IK follows its wrist target freely to ELBOW_FOLD, eases
// onto ELBOW_STOP (armReach) and leaves a target nearer the shoulder as a residual (REACH), like one
// out of reach. Before, twoBone folded an arm flat: the forearm lay in the upper arm and the bend plane
// was any plane at all (session df6acdcc, 171 deg).
export const ELBOW_FOLD = 145, ELBOW_STOP = 150;
// Knee flexion, read on the joints as QA reads it (UpLeg->Leg against Leg->Foot, 0 straight). Active
// flexion ends near 135-140 deg (AAOS 135); past it the knee folds only passively, under the body's
// weight, until the thigh rests on the calf: a deep squat with the heels down reaches 150-160 deg, and
// passive flexion stops near 160 (the heel at the buttock). A leg IK follows its ankle target freely to
// KNEE_FOLD (the squats the sessions keyed bend 125-138 deg), eases onto KNEE_STOP as the thigh presses
// on the calf, and leaves a target nearer the hip as a residual (REACH leg_miss). Before, twoBone folded
// a knee flat: the shin went into the thigh.
export const KNEE_FOLD = 150, KNEE_STOP = 160;
/** The flexion (deg) that puts the wrist d metres from the shoulder of an arm with bones a, b (180 at |a - b| or nearer). */
export const flexionAt = (a, b, d) => (Math.acos(clamp((d * d - a * a - b * b) / (2 * a * b), -1, 1)) * 180) / Math.PI;
/** The shoulder-wrist distance of an arm with bones a, b folded `deg` degrees. */
export const reachAt = (a, b, deg) => Math.sqrt(a * a + b * b + 2 * a * b * Math.cos((deg * Math.PI) / 180));
/**
 * The shoulder-wrist distance an arm with bones a, b takes for a wrist target d metres away: d while
 * the elbow folds ELBOW_FOLD or less (d >= k), then d + (k - d)^2 / 4w (w = k - the ELBOW_STOP distance)
 * down to d = k - 2w, and the stop beyond. The wrist slows at a constant rate (C1, no kink as it
 * engages: half the peak deceleration of an exponential ease as wide) and sits on the stop once the
 * target is 2w inside. A leg passes KNEE_FOLD and KNEE_STOP (the hip-ankle distance).
 */
export function armReach(a, b, d, fold = ELBOW_FOLD, stop = ELBOW_STOP) {
	const k = reachAt(a, b, fold);
	if (d >= k) return d;
	const w = k - reachAt(a, b, stop);
	return d > k - 2 * w ? d + ((k - d) * (k - d)) / (4 * w) : k - w;
}
/**
 * The wrist point an arm (shoulder S, bones a, b) reaches for a wrist target T: T while the elbow
 * folds ELBOW_FOLD or less, else the point armReach(|T - S|) from the shoulder on the ray from the fold
 * centre C through T. No point can stand for every target inside the stop and still move smoothly (a
 * ball has no continuous retraction onto its boundary): the nearest point (the ray from the shoulder)
 * whips round the shoulder as a target passes near it (session df6acdcc: 120 deg in 2 frames). So C
 * sits on the stop's sphere straight behind the shoulder (`back`, the chest's -Z), in the back, where
 * no hand reaches, and a target passing in front of, above, below or beside the shoulder glides.
 * A leg passes the knee's fold and stop, and `back` is the pelvis's up (upOf): no foot goes into the
 * pelvis, and a squat's ankle target under the hip goes on down from it.
 */
export function foldPoint(S, T, a, b, back, fold = ELBOW_FOLD, stop = ELBOW_STOP) {
	const k = reachAt(a, b, fold), d = len(sub(T, S));
	if (d >= k) return T;
	const r = armReach(a, b, d, fold, stop), m = scale(back, reachAt(a, b, stop)), C = add(S, m), e = sub(T, C);
	const u = len(e) > 1e-9 ? norm(e) : scale(back, -1), em = dot(u, m);
	return add(C, scale(u, -em + Math.sqrt(Math.max(0, em * em - dot(m, m) + r * r))));
}
/** The direction behind the shoulders on pose s (the chest bone's rest -Z), where foldPoint's rays start. */
export const backOf = (sk, s) => carried(sk, s, sk.index.Spine2 ?? sk.index.Hips, [0, 0, -1]);
/** The direction up from the hips on pose s (the pelvis's rest +Y), where a knee's foldPoint rays start. */
const upOf = (sk, s) => carried(sk, s, sk.index.Hips, [0, 1, 0]);
/** The flexion (deg) an arm with bones a, b takes when `deg` is asked (armReach as an angle). */
export const elbowFold = (a, b, deg) => flexionAt(a, b, armReach(a, b, reachAt(a, b, deg)));
/** The flexion (deg) a wrist target asks of the arm of `side` on pose s (a leg's ankle target: bones UpLeg, Leg, Foot). */
export function askedFold(sk, s, side, target, [u, m, e] = ["Arm", "ForeArm", "Hand"]) {
	const S = s.P[sk.index[`${side}${u}`]], E = s.P[sk.index[`${side}${m}`]], W = s.P[sk.index[`${side}${e}`]];
	return flexionAt(len(sub(E, S)), len(sub(W, E)), len(sub(target, S)));
}

/** Ease an elbow folded past ELBOW_FOLD (an FK abend) back as the IK would (elbowFold), the forearm turning in its bend plane. */
export function limitFold(sk, s, side) {
	const a = sk.index[`${side}Arm`], fa = sk.index[`${side}ForeArm`], up = sub(s.P[fa], s.P[a]), down = sub(s.P[sk.index[`${side}Hand`]], s.P[fa]);
	const deg = (Math.acos(clamp(dot(norm(up), norm(down)), -1, 1)) * 180) / Math.PI, n = cross(up, down);
	if (deg > ELBOW_FOLD && len(n) > 1e-12) rotateSubtree(sk, s, fa, s.P[fa].slice(), axisRot(n, elbowFold(len(up), len(down), deg) - deg));
}

/** The stops twoBone keeps to: the free fold and the stop (deg), and the fold centre's direction on pose s. */
const STOPS = { elbow: [ELBOW_FOLD, ELBOW_STOP, backOf], knee: [KNEE_FOLD, KNEE_STOP, upOf] };

/** Solve root-mid-end so `end` lands on `target` (clamped to reach), bending toward `pole`.
 * `pole0` is the limb's current bend reference carried by the upper bone. Returns the miss (m).
 * `stop`: "elbow" or "knee", the mid joint folds no further than armReach allows with that joint's
 * fold and stop (foldPoint), and the miss is the residual either way (out of reach, or nearer the
 * shoulder or hip than the fold). */
export function twoBone(sk, s, root, mid, end, target, pole, restBend, stop = null) {
	const Rt = s.P[root], M = s.P[mid], E = s.P[end];
	const a = len(sub(M, Rt)), b = len(sub(E, M)), lim = STOPS[stop];
	// a joint folds no further than armReach lets it: the end goes to foldPoint, and misses the target by the rest
	const W = lim ? foldPoint(Rt, target, a, b, lim[2](sk, s), lim[0], lim[1]) : target, inside = W === target ? 0 : len(sub(W, target));
	const v = sub(W, Rt), d = len(v), u = scale(v, 1 / Math.max(d, 1e-9));
	const dc = clamp(d, Math.abs(a - b) + 1e-4, (a + b) * 0.9995);
	const l = (a * a - b * b + dc * dc) / (2 * dc), h = Math.sqrt(Math.max(a * a - l * l, 0));
	const pv = norm(sub(pole, scale(u, dot(pole, u))));
	const Mn = add(Rt, add(scale(u, l), scale(pv, h)));
	const p0 = carried(sk, s, root, restBend);
	rotateSubtree(sk, s, root, Rt.slice(), align(sub(M, Rt), p0, sub(Mn, Rt), pv));
	const p1 = carried(sk, s, mid, restBend);
	const Tn = add(Rt, scale(u, dc));
	rotateSubtree(sk, s, mid, s.P[mid].slice(), align(sub(s.P[end], s.P[mid]), p1, sub(Tn, s.P[mid]), pv));
	return inside || d - dc;
}

/**
 * Aim a foot: Foot->ToeBase along yaw/pitch of its rest direction, sole kept level. With `tilt` (pose.js tiltFrame: a body
 * turned well past upright) the yaw and pitch are read in that frame and the sole levels to its up, so a foot in a flip
 * points with the shin instead of staying flat to the floor; no toe-off then (the toes are off the ground).
 */
export function orientFoot(sk, s, side, yawDeg, pitchDeg, tilt = null) {
	const foot = sk.index[`${side}Foot`], toe = sk.index[`${side}ToeBase`];
	const rest = sub(sk.restWorldPos[toe], sk.restWorldPos[foot]);
	const want = tilt ? apply(tilt.R, apply(ry(yawDeg - tilt.yaw), apply(rx(pitchDeg), rest))) : apply(ry(yawDeg), apply(rx(pitchDeg), rest));
	const up = tilt ? apply(tilt.R, [0, 1, 0]) : [0, 1, 0];
	// level the sole: the foot's own carried up vector goes to world up (no roll from the leg IK)
	rotateSubtree(sk, s, foot, s.P[foot].slice(), align(sub(s.P[toe], s.P[foot]), carried(sk, s, foot, [0, 1, 0]), want, up));
	// Toe-off: bend the toe joint so the toes stay flat on the ground while the heel rises.
	const tip = sk.index[`${side}Toe_End`];
	if (!tilt && pitchDeg > 0 && tip !== undefined) {
		const seg = sub(s.P[tip], s.P[toe]), flat = [seg[0], 0, seg[2]];
		if (len(flat) > 1e-6) rotateSubtree(sk, s, toe, s.P[toe].slice(), align(seg, [0, 1, 0], flat, [0, 1, 0]));
	}
}

export function palmAxes(sk, s, side) {
	const h = sk.index[`${side}Hand`], m1 = sk.index[`${side}HandMiddle1`];
	const d = norm(sub(s.P[m1], s.P[h]));
	let l = sub(s.P[sk.index[`${side}HandIndex1`]], s.P[sk.index[`${side}HandPinky1`]]);
	l = norm(sub(l, scale(d, dot(l, d))));
	return { d, l, n: cross(d, l) };
}

/**
 * The palm's own point for a grasp that presses a face (vocab.js PALM_GRASPS): [d, l, n] on the palm axes from the
 * knuckles of the index and middle fingers, where GRASP_POINTS puts it from the finger middles with the fingers flat on
 * the rig's rest pose. The finger middles move as the fingers curl: a grip on a palm grasp put the point 2.9 cm toward
 * the palm and stood the palm 4 cm off the box (A/B T2 run t2h3, 2026-11-04), a fist 3.5 cm; the knuckles stay on the
 * palm, so the point does too whatever the fingers do. Cached per rig and side.
 */
const PALM_POINTS = new WeakMap();
export function palmPoint(sk, side, grasp) {
	const key = `${side}:${grasp}`;
	let m = PALM_POINTS.get(sk);
	if (!m) PALM_POINTS.set(sk, (m = new Map()));
	if (!m.has(key)) {
		const s = restState(sk), P = j => s.P[sk.index[`${side}Hand${j}`]];
		fingers(sk, s, side, { flat: 1 });
		// the grasp offsets are the X Bot hand's: an adapted rig scales them by its hand (rigs/adapt-measure.js)
		const ax = palmAxes(sk, s, side), k = sk.landmarks?.scale?.hand ?? 1, g = (GRASP_POINTS[grasp] ?? [0, 0, 0]).map(v => v * k), n = side === "Right" ? -g[2] : g[2];
		const p = add(scale(add(P("Index2"), P("Middle2")), 0.5), add(scale(ax.d, g[0]), add(scale(ax.l, g[1]), scale(ax.n, n))));
		const v = sub(p, scale(add(P("Index1"), P("Middle1")), 0.5));
		m.set(key, [dot(v, ax.d), dot(v, ax.l), dot(v, ax.n)]);
	}
	return m.get(key);
}

/**
 * How far the flat fingers reach past a grasp's palm point (palmPoint) along the palm axis d, m: the farthest of the four
 * fingertips on the rig's rest pose with the fingers flat (finger-close straightens a support hold's hooked fingers off
 * the box once the palm leaves the bottom edge, compiler/anchors.js supportAt). Cached per rig, side and grasp.
 */
const FINGER_REACHES = new WeakMap();
export function fingerReach(sk, side, grasp, preset = "flat") {
	const key = `${side}:${grasp}:${preset}`;
	let m = FINGER_REACHES.get(sk);
	if (!m) FINGER_REACHES.set(sk, (m = new Map()));
	if (!m.has(key)) {
		const s = restState(sk), P = j => s.P[sk.index[`${side}Hand${j}`]], pp = palmPoint(sk, side, grasp);
		fingers(sk, s, side, { [preset]: 1 });
		const ax = palmAxes(sk, s, side), knuckles = scale(add(P("Index1"), P("Middle1")), 0.5);
		const p = add(knuckles, add(scale(ax.d, pp[0]), add(scale(ax.l, pp[1]), scale(ax.n, pp[2]))));
		// flat: along d (how far the straight fingers run down the face); curled: the whole distance, which way the curl
		// points depends on the hand's turn (a hook set down with the fingers level points its tips down: 6.4-6.8 cm, T2)
		m.set(key, Math.max(...["Index", "Middle", "Ring", "Pinky"].map(x => (preset === "flat" ? dot(sub(P(`${x}4`), p), ax.d) : len(sub(P(`${x}4`), p))))));
	}
	return m.get(key);
}

/** Turn the elbow `deg` about the shoulder-wrist line: the hand keeps its place and its world turn. */
export function swivelElbow(sk, s, side, deg) {
	const a = sk.index[`${side}Arm`], h = sk.index[`${side}Hand`], R = axisRot(sub(s.P[h], s.P[a]), deg);
	rotateSubtree(sk, s, a, s.P[a].slice(), R);
	rotateSubtree(sk, s, h, s.P[h].slice(), T(R));
}

/** Wrist twist (about the forearm) and flex (about the knuckle line), degrees, clamped. */
export function wrist(sk, s, side, twistDeg, flexDeg) {
	if (!twistDeg && !flexDeg) return;
	const h = sk.index[`${side}Hand`], fa = sk.index[`${side}ForeArm`];
	const axT = norm(sub(s.P[h], s.P[fa]));
	const { l } = palmAxes(sk, s, side);
	const axF = norm(sub(l, scale(axT, dot(l, axT))));
	rotateSubtree(sk, s, h, s.P[h].slice(), axisRot(axF, clamp(flexDeg, -70, 70)));
	rotateSubtree(sk, s, h, s.P[h].slice(), axisRot(axT, clamp(twistDeg, -85, 85)));
}

// Finger curl presets, degrees per phalanx (1, 2, 3); thumb is [opposition, curl, curl]. A fist and a grip keep the
// relaxed thumb here and close it with THUMB_WRAP: these thumb curls turn about the knuckle line and the hand's long axis,
// which only swings a thumb out to the side (a fist read as a thumbs-up).
const FINGER_PRESETS = {
	relaxed: { Index: [12, 18, 10], Middle: [15, 20, 12], Ring: [18, 22, 12], Pinky: [20, 24, 14], Thumb: [15, 10, 8] },
	fist: { Index: [80, 95, 60], Middle: [85, 95, 60], Ring: [85, 95, 60], Pinky: [85, 95, 60], Thumb: [15, 10, 8] },
	grip: { Index: [55, 60, 35], Middle: [60, 62, 35], Ring: [62, 62, 35], Pinky: [65, 62, 35], Thumb: [15, 10, 8] },
	cigarette: { Index: [8, 10, 6], Middle: [10, 12, 8], Ring: [60, 75, 45], Pinky: [65, 80, 45], Thumb: [35, 25, 20] },
	point: { Index: [0, 0, 0], Middle: [80, 95, 60], Ring: [85, 95, 60], Pinky: [85, 95, 60], Thumb: [40, 30, 30] },
	spherical: { Index: [35, 40, 25], Middle: [38, 42, 25], Ring: [40, 42, 25], Pinky: [42, 44, 25], Thumb: [15, 10, 8] },
	// flat: the fingers lie on the face a palm presses (relaxed curls them 3 cm into it); hook: knuckles straight, the
	// fingers bent at the middle joints round an edge or a handle (a box carried by its bottom edges, a bucket)
	flat: { Index: [3, 4, 2], Middle: [3, 4, 2], Ring: [3, 4, 2], Pinky: [3, 4, 2], Thumb: [55, 3, 2] },
	hook: { Index: [5, 85, 25], Middle: [5, 88, 25], Ring: [5, 88, 25], Pinky: [5, 85, 25], Thumb: [55, 5, 3] },
};
// A ball's fingers fan out round it (#816): each finger turns about the palm normal at its knuckle, degrees toward the
// thumb side (+), by preset weight; the index leads the thumb round one side, the little finger the other.
export const SPREAD = { spherical: { Index: 9, Middle: 2, Ring: -5, Pinky: -12 } };

// Two presets keyed at 1 together (a reach's grip over a held fist) would add their curls: 137 deg at the PIP. Past a
// sum of 1 the weights share it, so a blend never curls further than its strongest preset.
export function shares(weights) {
	const sum = Object.entries(weights ?? {}).reduce((acc, [p, w]) => acc + (p === "relaxed" ? 0 : w || 0), 0);
	return sum > 1 ? Object.fromEntries(Object.entries(weights).map(([p, w]) => [p, p === "relaxed" ? w : (w || 0) / sum])) : weights;
}

/** Degrees phalanx k (0..2) of finger f curls at preset weights `weights` (blended over relaxed). */
export function fingerCurl(weights, f, k) {
	const base = FINGER_PRESETS.relaxed;
	return base[f][k] + Object.entries(shares(weights) ?? {}).reduce((acc, [p, w]) => acc + (w || 0) * ((FINGER_PRESETS[p]?.[f]?.[k] ?? base[f][k]) - base[f][k]), 0);
}
/** The fist's curl of phalanx k of finger f: as far as a finger closes. */
export const fistCurl = (f, k) => FINGER_PRESETS.fist[f][k];

/** Blend presets by weight over `relaxed` and curl every finger toward the palm. */
export function fingers(sk, s, side, given) {
	const weights = shares(given), sign = side === "Left" ? -1 : 1, curl = (f, k) => fingerCurl(weights, f, k);
	for (const f of ["Index", "Middle", "Ring", "Pinky"]) {
		const spread = Object.entries(weights ?? {}).reduce((acc, [p, w]) => acc + (w || 0) * (SPREAD[p]?.[f] ?? 0), 0), j = sk.index[`${side}Hand${f}1`];
		if (spread && j !== undefined) rotateSubtree(sk, s, j, s.P[j].slice(), axisRot(palmAxes(sk, s, side).n, spread));
	}
	for (const f of ["Index", "Middle", "Ring", "Pinky", "Thumb"]) {
		for (let k = 0; k < 3; k++) {
			const j = sk.index[`${side}Hand${f}${k + 1}`];
			if (j === undefined) continue;
			const { l, d } = palmAxes(sk, s, side);
			const ax = f === "Thumb" && k === 0 ? d : l;
			rotateSubtree(sk, s, j, s.P[j].slice(), axisRot(ax, sign * curl(f, k)));
		}
	}
	const wrap = [0, 1, 2, 3].map(i => Object.entries(weights ?? {}).reduce((acc, [p, w]) => acc + (w || 0) * (THUMB_WRAP[p]?.[i] ?? 0), 0));
	if (wrap.some(Boolean)) wrapThumb(sk, s, side, wrap);
}

// A closing hand's thumb, by preset weight after the relaxed one, degrees: turned in about the hand's long axis toward the
// palm and across it, then flexed at its two joints about their own axes (bone x palm normal). The fist's thumb lies over
// the index and middle fingers' middle phalanges; the grip's closes around a handle against the index finger. Searched on
// both rigs within the joints' ranges (thumb tip to the index's middle phalanx: fist 8.4 -> 3.7 cm Y Bot, 6.9 -> 2.4 X Bot).
export const THUMB_WRAP = { fist: [-70, -5, 5, 80], grip: [-30, -30, 30, 10], spherical: [-40, -20, 20, 10] };
function wrapThumb(sk, s, side, [oppose, across, flex2, flex3]) {
	const sign = side === "Left" ? -1 : 1, J = k => sk.index[`${side}HandThumb${k}`];
	if (J(1) === undefined) return;
	const { d, n } = palmAxes(sk, s, side);
	rotateSubtree(sk, s, J(1), s.P[J(1)].slice(), axisRot(d, sign * oppose));
	// n = d x l flips with the mirror, so the turn across the palm keeps its sign on both hands
	rotateSubtree(sk, s, J(1), s.P[J(1)].slice(), axisRot(n, across));
	for (const [k, deg] of [[2, flex2], [3, flex3]]) {
		const ax = norm(cross(norm(sub(s.P[J(k + 1)], s.P[J(k)])), n));
		rotateSubtree(sk, s, J(k), s.P[J(k)].slice(), axisRot(ax, sign * deg));
	}
}

