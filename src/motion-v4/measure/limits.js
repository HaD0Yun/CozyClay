// Joint limits and speed peaks of the v4 measure tool.
// limits, per frame, merged into runs of the same joint:
//   knee_<k>, elbow_<k>            fold (degrees between the two segments, 0 straight) past KNEE_STOP
//                                  160 and ELBOW_STOP 150 (compiler/limbs.js)
//   knee_<k>_back, elbow_<k>_back  bend the wrong way about the joint's hinge axis (the knee's shin
//                                  forward, the elbow's forearm backward) past BACK degrees
//   wrist_<k>_flex|dev|twist       the hand on its forearm (arm-orient.js wristNeed, the neutral of
//                                  qa/wrist-checks.js) past WRIST_LIMITS
//   neck                           Spine2->Neck against Neck->Head past 60 degrees
// speed: local rotation speed per bone (the angle between its local rotations at f - 1 and f, times
// fps) over 400 deg/s for the trunk and head, 1200 for arms and legs, 1500 for hands and feet
// (fingers and end bones skipped), merged into runs; and the top 5 linear speed and acceleration
// peaks of the Hips joint and the COM.
import { ELBOW_STOP, KNEE_STOP, palmAxes } from "../../motion3/compiler/limbs.js";
import { WRIST_LIMITS, wristNeed } from "../../motion3/compiler/arm-orient.js";
import { apply, sub, scale, dot, cross, len, norm, mul, T } from "../../motion3/compiler/math.js";
import { centerOfMass, bodyCentre } from "../../motion3/qa/com.js";

const DEG = 180 / Math.PI, OVER = 0.5, BACK = 5, NECK = 60;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const SIDES = [["l", "Left"], ["r", "Right"]];
const angleOf = (u, w) => Math.acos(Math.max(-1, Math.min(1, dot(u, w) / (len(u) * len(w) || 1)))) * DEG;

const hinges = new WeakMap();

// The hinge joints of sk: the upper bone carries the hinge axis, which a normal bend turns about
// positively (the knee's shin goes back, the elbow's forearm forward at rest, facing +Z).
function hingesOf(sk) {
	if (hinges.has(sk)) return hinges.get(sk);
	const I = sk.index, P = sk.restWorldPos, list = [];
	for (const [k, S] of SIDES) for (const [joint, a, m, e, stop, bend] of [["knee", "UpLeg", "Leg", "Foot", KNEE_STOP, [0, 0, -1]], ["elbow", "Arm", "ForeArm", "Hand", ELBOW_STOP, [0, 0, 1]]]) {
		const ia = I[S + a], im = I[S + m], ie = I[S + e];
		if ([ia, im, ie].includes(undefined)) continue;
		list.push({ joint: `${joint}_${k}`, a: ia, m: im, e: ie, stop, axis: apply(T(sk.restWorldRot[ia]), norm(cross(sub(P[im], P[ia]), bend))) });
	}
	hinges.set(sk, list);
	return list;
}

/** Limit rows of one frame: { f, joint, angle, limit, past }. */
function frameRows(sk, s, f) {
	const rows = [], I = sk.index, push = (joint, angle, limit, past) => past > OVER && rows.push({ f, joint, angle, limit, past });
	for (const h of hingesOf(sk)) {
		const u = sub(s.P[h.m], s.P[h.a]), w = sub(s.P[h.e], s.P[h.m]), fold = angleOf(u, w);
		const signed = Math.atan2(dot(cross(u, w), apply(s.R[h.a], h.axis)), dot(u, w)) * DEG;
		push(h.joint, fold, h.stop, fold - h.stop);
		push(`${h.joint}_back`, -signed, BACK, -signed - BACK);
	}
	for (const [k, S] of SIDES) {
		const hb = I[`${S}Hand`], fa = I[`${S}ForeArm`], rw = sk.restWorldRot;
		if (hb === undefined || fa === undefined || I[`${S}HandMiddle1`] === undefined) continue;
		const axT = scale(sub(s.P[hb], s.P[fa]), 1 / Math.max(1e-9, len(sub(s.P[hb], s.P[fa])))), neutral = mul(s.R[fa], mul(T(rw[fa]), rw[hb]));
		const need = wristNeed(neutral, s.R[hb], axT, apply(mul(neutral, T(s.R[hb])), palmAxes(sk, s, S).l));
		for (const [axis, [lo, hi]] of Object.entries(WRIST_LIMITS)) {
			const v = need[axis];
			push(`wrist_${k}_${axis}`, v, v >= 0 ? hi : lo, v >= 0 ? v - hi : lo - v);
		}
	}
	if (I.Spine2 !== undefined && I.Neck !== undefined && I.Head !== undefined) {
		const neck = angleOf(sub(s.P[I.Neck], s.P[I.Spine2]), sub(s.P[I.Head], s.P[I.Neck]));
		push("neck", neck, NECK, neck - NECK);
	}
	return rows;
}

/** Rows of one key, consecutive frames merged: { key, from, to, f (worst), ...worst row }. */
function mergeRuns(rows, key, worse) {
	const runs = [], last = new Map();
	for (const r of rows) {
		const run = last.get(r[key]);
		if (run && run.to === r.f - 1) {
			run.to = r.f;
			if (worse(r, run)) Object.assign(run, r, { f: r.f, from: run.from, to: r.f });
		} else {
			const fresh = { ...r, from: r.f, to: r.f };
			runs.push(fresh);
			last.set(r[key], fresh);
		}
	}
	return runs;
}

/** limitRows(out, { from, to }) -> { runs: [{ joint, from, to, f, angle, limit, past }] }, worst first. */
export function limitRows(out, { from = 0, to = out.frames.length - 1 } = {}) {
	const rows = [];
	for (let f = from; f <= to; f++) rows.push(...frameRows(out.ctx.sk, out.frames[f].s, f));
	const runs = mergeRuns(rows, "joint", (a, b) => a.past > b.past)
		.map(r => ({ joint: r.joint, from: r.from, to: r.to, f: r.f, angle: round(r.angle, 1), limit: r.limit, past: round(r.past, 1) }));
	return { runs: runs.sort((a, b) => b.past - a.past) };
}

/** The speed limit (deg/s) of a bone, or 0 for a bone the table skips. */
function speedLimit(sk, b) {
	const name = sk.names[b];
	if (!sk.children[b].length || /Hand(Thumb|Index|Middle|Ring|Pinky)/.test(name)) return 0;
	if (/^(Hips|Spine\d?|Neck|Head)$/.test(name)) return 400;
	return /(Hand|Foot|ToeBase)$/.test(name) ? 1500 : 1200;
}

/** Local rotation matrices of a pose (the parent's world rotation undone). */
const localsOf = (sk, s) => s.R.map((R, b) => (sk.parent[b] < 0 ? R : mul(T(s.R[sk.parent[b]]), R)));

/** Rotation angle (deg) between rotations A and B: acos((trace(A^T B) - 1) / 2). */
function turn(A, B) {
	let tr = 0;
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tr += A[i][j] * B[i][j];
	return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * DEG;
}

/** The `n` largest values of list [{ f, v }], at least 3 frames apart. */
function topPeaks(list, n = 5) {
	const picked = [];
	for (const p of [...list].sort((a, b) => b.v - a.v)) {
		if (picked.length >= n) break;
		if (picked.every(q => Math.abs(q.f - p.f) >= 3)) picked.push(p);
	}
	return picked;
}

/** Linear speed (central difference, m/s) and acceleration (second difference, m/s^2) peaks of a point track. */
function linearPeaks(track, from, to, fps) {
	const at = i => track[Math.max(0, Math.min(track.length - 1, i))], speed = [], accel = [];
	for (let f = from; f <= to; f++) {
		const a = at(f - 1), b = at(f + 1), span = Math.min(track.length - 1, f + 1) - Math.max(0, f - 1) || 1;
		speed.push({ f, v: len(sub(b, a)) * fps / span });
		if (f > 0 && f < track.length - 1) accel.push({ f, v: len(sub(sub(b, track[f]), sub(track[f], a))) * fps * fps });
	}
	return { speed: topPeaks(speed).map(p => ({ f: p.f, v: round(p.v, 3) })), accel: topPeaks(accel).map(p => ({ f: p.f, a: round(p.v, 2) })) };
}

/**
 * speedPeaks(out, { from, to }) -> { peaks: [{ bone, from, to, f, speed, limit }] (worst share of the
 * limit first), linear: { hips: { speed: [{ f, v }], accel: [{ f, a }] }, com: { ... } } }
 */
export function speedPeaks(out, { from = 0, to = out.frames.length - 1 } = {}) {
	const sk = out.ctx.sk, fps = out.fps ?? 24, limits = sk.names.map((_, b) => speedLimit(sk, b)), rows = [];
	let prev = from > 0 ? localsOf(sk, out.frames[from - 1].s) : null;
	for (let f = from; f <= to; f++) {
		const cur = localsOf(sk, out.frames[f].s);
		if (prev) limits.forEach((limit, b) => {
			const speed = limit ? turn(prev[b], cur[b]) * fps : 0;
			if (limit && speed > limit) rows.push({ f, bone: sk.names[b], speed, limit });
		});
		prev = cur;
	}
	const peaks = mergeRuns(rows, "bone", (a, b) => a.speed > b.speed)
		.map(r => ({ bone: r.bone, from: r.from, to: r.to, f: r.f, speed: Math.round(r.speed), limit: r.limit }))
		.sort((a, b) => b.speed / b.limit - a.speed / a.limit);
	const hips = out.frames.map(fr => fr.s.P[sk.index.Hips]), com = out.frames.map(fr => centerOfMass(sk, fr.s) ?? bodyCentre(sk, fr.s));
	return { peaks, linear: { hips: linearPeaks(hips, from, to, fps), com: linearPeaks(com, from, to, fps) } };
}
