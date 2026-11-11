// Is each finger a finger a hand can make? grasp-checks.js judges a finger only against what the hand holds: a phalanx
// into it, a fingertip off it. A finger bent backwards, curled past its range or lying in its neighbour passed while the
// other three tips still touched, and a hand with nothing in it was not judged at all (30 finger mutations of the can and
// ball takes: 16 passed). These checks read the pose alone, on every frame of either hand:
//   FINGER_ROM   "<Bone> bent back" / "<Bone> curled past range": a joint's flexion about the hand's knuckle line, each
//                phalanx against the one before (the first against the palm's finger axis), outside its band in degrees
//                (MCP, PIP, DIP; active ranges of motion: flexion 85-90 / 100-115 / 80-90, extension 30-45 / 0 / 20)
//   FINGER_SELF  "<Bone> into <Bone>": two phalanges of different fingers (the thumb aside: it lies on the index by
//                design) closer than two phalanx radii less PEN, as FINGER_PEN measures a phalanx in a held thing; the
//                radius and PEN scale with the rig's hand (rigScale "hand"), so a hand of 0.7 the X Bot's is judged as its own
// A rig without finger joints is not judged.
import { add, sub, scale, dot, cross, norm } from "../compiler/math.js";
import { palmAxes } from "../compiler/limbs.js";
import { rigScale } from "../compiler/skeleton.js";

const PHALANX = 0.009, PEN = 0.004, SIDES = ["Left", "Right"], FINGERS = ["Index", "Middle", "Ring", "Pinky"];
// degrees per joint (1 MCP, 2 PIP, 3 DIP): [most extension, most flexion]
const ROM = [[-45, 100], [-5, 115], [-20, 90]];
const deg = r => (r * 180) / Math.PI;

/** Signed angle (deg) from a to b about unit axis, both projected on the plane normal to it. */
function turn(a, b, axis) {
	const pa = norm(sub(a, scale(axis, dot(a, axis)))), pb = norm(sub(b, scale(axis, dot(b, axis))));
	return deg(Math.atan2(dot(cross(pa, pb), axis), dot(pa, pb)));
}

/** The flexion (deg) of joints 1..3 of finger f of hand S on pose s; null when the rig lacks the finger. */
export function fingerFlexion(sk, s, S, f) {
	const J = [1, 2, 3, 4].map(i => sk.index[`${S}Hand${f}${i}`]);
	if (J.some(j => j === undefined)) return null;
	const { d, l } = palmAxes(sk, s, S), knuckle = scale(l, S === "Left" ? -1 : 1);
	const bone = [0, 1, 2].map(i => norm(sub(s.P[J[i + 1]], s.P[J[i]])));
	return [d, bone[0], bone[1]].map((prev, i) => turn(prev, bone[i], knuckle));
}

function segmentGap(p1, q1, p2, q2) {
	const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), c = dot(d1, r), b = dot(d1, d2);
	const den = a * e - b * b, clamp = x => Math.min(1, Math.max(0, x));
	let s = den > 1e-12 ? clamp((b * f - c * e) / den) : 0, t = e > 1e-12 ? (b * s + f) / e : 0;
	if (t < 0) { t = 0; s = clamp(-c / a); } else if (t > 1) { t = 1; s = clamp((b - c) / a); }
	return Math.hypot(...sub(add(p1, scale(d1, s)), add(p2, scale(d2, t))));
}

function handIssues(sk, s, S, push, frame) {
	for (const f of FINGERS) {
		const flex = fingerFlexion(sk, s, S, f);
		if (!flex) return;
		flex.forEach((a, i) => {
			const [lo, hi] = ROM[i], bone = `${S}Hand${f}${i + 1}`;
			if (a < lo) push("FINGER_ROM", `${bone} bent back`, frame, -a, -lo);
			else if (a > hi) push("FINGER_ROM", `${bone} curled past range`, frame, a, hi);
		});
	}
	const P = name => s.P[sk.index[`${S}Hand${name}`]], k = rigScale(sk, "hand"), touch = 2 * PHALANX * k, pen = PEN * k;
	for (let i = 0; i < FINGERS.length; i++) for (let j = i + 1; j < FINGERS.length; j++) {
		let worst = null;
		for (let a = 1; a <= 3; a++) for (let b = 1; b <= 3; b++) {
			const overlap = touch - segmentGap(P(`${FINGERS[i]}${a}`), P(`${FINGERS[i]}${a + 1}`), P(`${FINGERS[j]}${b}`), P(`${FINGERS[j]}${b + 1}`));
			if (overlap > pen && (!worst || overlap > worst.overlap)) worst = { overlap, a, b };
		}
		if (worst) push("FINGER_SELF", `${S}Hand${FINGERS[i]}${worst.a} into ${S}Hand${FINGERS[j]}${worst.b}`, frame, worst.overlap, pen);
	}
}

/** FINGER_ROM and FINGER_SELF issues of both hands on every frame (frames index out.frames, as every check's). */
export function fingerChecks(sk, out) {
	const issues = [], push = (kind, msg, frame, value, limit) => issues.push({ kind, msg, frame, value: +value.toFixed(4), limit });
	const sides = SIDES.filter(S => sk.index[`${S}Hand`] !== undefined);
	out.frames.forEach((fr, i) => { for (const S of sides) handIssues(sk, fr.s, S, push, i); });
	return issues;
}

export const fingerHints = {
	FINGER_ROM(X, g) {
		const k = g.subject.startsWith("Left") ? "l" : "r";
		return { cause: X.cause(`fingers_${k}`, g.worstFrame), hint: `fingers_${k}: a joint is past what a finger does (${g.subject}); keep the preset weights summing to at most 1 and do not turn a phalanx past its curl` };
	},
	FINGER_SELF(X, g) {
		const k = g.subject.startsWith("Left") ? "l" : "r";
		return { cause: X.cause(`fingers_${k}`, g.worstFrame), hint: `fingers_${k}: two fingers lie in each other (${g.subject}); give them one preset so they curl side by side` };
	},
};
