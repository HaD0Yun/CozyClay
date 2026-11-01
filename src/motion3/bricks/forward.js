// SOMA world joints (CozyClay space, soma.js toCozyPoint) -> motion-spec channels, one object per frame.
// The body and head go to angle channels (frame-relative YXZ Euler), the limbs to IK targets and poles:
// the spec has no per-bone rotations, so the wrists and ankles are read as points and the knees and elbows
// as the direction they bend toward. wtwist/wflex and fingers are not produced (fingers come from presets).
import { add, sub, scale, dot, cross, norm, apply, mul, T, ry } from "../compiler/math.js";
import { SID } from "./soma.js";

const DEG = 180 / Math.PI;
/** The X Bot's hip-socket midpoint from its Hips joint, standing, body frame [left, up, fwd] (m). */
export const XBOT_HIPMID = [0, -0.0675, -0.016];
/** The eye midpoint sits up 4.45 cm and forward 8.15 cm of the SOMA Head joint, so the eye line tilts the head frame by this. */
const EYE_ALPHA = Math.atan2(4.45, 8.15);
/** A planted SOMA foot's ankle->toe pitch and its heading off the body yaw (deg, median of planted model frames, mirrored): a flat,
 * straight X Bot foot keys fpitch 0 and fyaw = yaw, so both are read relative to these. */
const FOOT_FLAT = { pitch: { l: 20.8, r: 20.8 }, yaw: { l: 16.8, r: -16.8 } };

const cols = (a, b, c) => [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];
const at = (P, n) => P[SID[n]];

function frameFrom(left, up) {
	const f = norm(cross(left, up)), l = norm(cross(up, f));
	return cols(l, norm(up), f);
}

function headFrame(P) {
	const left = norm(sub(at(P, "LeftEye"), at(P, "RightEye")));
	let v = sub(scale(add(at(P, "LeftEye"), at(P, "RightEye")), 0.5), at(P, "Head"));
	v = norm(sub(v, scale(left, dot(v, left))));
	const w = cross(v, left), c = Math.cos(EYE_ALPHA), s = Math.sin(EYE_ALPHA);
	return cols(left, add(scale(v, s), scale(w, c)), sub(scale(v, c), scale(w, s)));
}

/** R = Ry(a) Rx(b) Rz(c) -> [a, b, c] degrees (pose.js applies the body as ry(yaw) rx(pitch) rz(roll)). */
function eulerYXZ(R) {
	return [Math.atan2(R[0][2], R[2][2]) * DEG, Math.asin(Math.max(-1, Math.min(1, -R[1][2]))) * DEG, Math.atan2(R[1][0], R[1][1]) * DEG];
}

/**
 * Where the middle joint sits off the root-end line, in the yaw-only body frame. A nearly straight limb's offset is a few mm
 * of noise, so a small default component (eps m along `def`, body frame) keeps a straight leg on the default forward pole.
 */
function pole(P, a, b, c, yaw, def, eps = 0.02) {
	const A = at(P, a), ab = norm(sub(at(P, c), A)), v0 = sub(at(P, b), A), v = sub(v0, scale(ab, dot(v0, ab)));
	return norm(add(apply(T(ry(yaw)), v), scale(norm(def), eps)));
}

const r5 = v => Math.round(v * 1e5) / 1e5;
const r4 = v => Math.round(v * 1e4) / 1e4;

/** One frame's channels. P: 30 SOMA joints in CozyClay space. */
export function frameChannels(P) {
	const ch = {};
	const Fp = frameFrom(sub(at(P, "LeftLeg"), at(P, "RightLeg")), sub(at(P, "Spine1"), at(P, "Hips")));
	const hipmid = scale(add(at(P, "LeftLeg"), at(P, "RightLeg")), 0.5);
	ch.root = sub(hipmid, apply(Fp, XBOT_HIPMID));
	const Fc = frameFrom(sub(at(P, "LeftShoulder"), at(P, "RightShoulder")), sub(at(P, "Neck1"), at(P, "Chest")));
	[ch.yaw, ch.pitch, ch.roll] = eulerYXZ(Fp);
	[ch.spine_yaw, ch.spine_pitch, ch.spine_roll] = eulerYXZ(mul(T(Fp), Fc));
	[ch.head_yaw, ch.head_pitch, ch.head_roll] = eulerYXZ(mul(T(Fc), headFrame(P)));
	for (const [k, S] of [["l", "Left"], ["r", "Right"]]) {
		ch[`foot_${k}`] = at(P, `${S}Foot`).slice();
		ch[`hand_${k}`] = at(P, `${S}Hand`).slice();
		ch[`knee_${k}`] = pole(P, `${S}Leg`, `${S}Shin`, `${S}Foot`, ch.yaw, [0, 0, 1]);
		ch[`elbow_${k}`] = pole(P, `${S}Arm`, `${S}ForeArm`, `${S}Hand`, ch.yaw, [0, -1, -0.3]);
		const d = sub(at(P, `${S}ToeBase`), at(P, `${S}Foot`));
		ch[`fyaw_${k}`] = Math.atan2(d[0], d[2]) * DEG - FOOT_FLAT.yaw[k];
		ch[`fpitch_${k}`] = Math.atan2(-d[1], Math.hypot(d[0], d[2])) * DEG - FOOT_FLAT.pitch[k];
	}
	return ch;
}

const ANGLES = ["yaw", "fyaw_l", "fyaw_r"];
/** Unwraps the heading channels along a series (a turn past 180 keeps counting) starting near `from` (a channel object). */
export function unwrapSeries(frames, from = null) {
	for (const k of ANGLES) {
		let prev = from?.[k];
		for (const ch of frames) {
			if (prev !== undefined) ch[k] += 360 * Math.round((prev - ch[k]) / 360);
			prev = ch[k];
		}
	}
	return frames;
}

/** Rounds a channel object the way a spec stores it (points 5 decimals, angles 4). */
export const roundChannels = ch => Object.fromEntries(Object.entries(ch).map(([k, v]) => [k, Array.isArray(v) ? v.map(r5) : r4(v)]));
