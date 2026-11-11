// Rest-pose work for adapt.js: a source skeleton's bind joints brought onto the canonical (Mixamo X Bot) bind the
// compiler assumes. All in metres. The steps, in order:
//   sourcePose      forward kinematics of the raw bones (any bone axis convention, any root above the hips).
//   facingAxes      the source's up (feet to head) and left (right hip to left hip) as the canonical +Y and +X, +Z
//                   forward; each snapped to the nearest world axis when within 25 deg, so a Z-up export turns upright
//                   and a slight lean or turn is kept, not straightened: a source yawed under 25 deg keeps its trunk
//                   yawed while normalise puts its arms and feet on the X Bot's directions.
//   normalise       each arm, leg and foot turned at its root joint onto the X Bot's bind direction: the upper arm,
//                   forearm and hand (an A-pose's arms go up to the T-pose's horizontal; the palm turns to the X Bot's
//                   by its knuckle line), the thigh and shin, and the foot's heading. A foot keeps its own pitch through
//                   the leg's turns, so a flat foot stays flat. The spine, neck and head keep the source's posture.
//   fillMissing     canonical bones the source lacks: a missing spine or neck joint on the line between its neighbours
//                   at the X Bot's spacing; a collarbone, toe, head top or finger at the X Bot's offset from its parent,
//                   scaled by its region (hand, foot, head, shoulder width); a fingertip (joint 4) past joint 3 along
//                   the last phalanx at the X Bot's ratio.
//   canonicalFrames each bone's bind rotation: the X Bot's, turned by the least rotation taking the X Bot's bone
//                   (joint to axis child) onto this one; the hips by their hip line too and the hand by its knuckles.
import { add, sub, scale, dot, cross, len, dist, norm, mul, apply, T, axisRot, align, angle, matFromQuat, I3 } from "../compiler/math.js";

const SIDES = ["Left", "Right"], TRUNK = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"], SNAP = Math.cos(25 * Math.PI / 180);
const at = (ref, n) => ref.restWorldPos[ref.index[n]];
const lerp = (a, b, t) => add(a, scale(sub(b, a), t));
const flat = v => [v[0], 0, v[2]];

/** The least rotation taking direction a onto direction b (identity when they already agree). */
function swing(a, b) {
	const axis = cross(a, b), c = dot(norm(a), norm(b));
	if (len(a) < 1e-9 || len(b) < 1e-9) return I3();
	if (len(axis) > 1e-12 * len(a) * len(b)) return axisRot(axis, angle(a, b));
	return c > 0 ? I3() : axisRot(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]), 180);
}

/** World bind of raw bones (adapt.js): { names, P (m), R }. */
export function sourcePose(raw) {
	const k = raw.units === "m" ? 1 : 0.01, bones = raw.bones, P = [], R = [];
	const visit = (i, depth = 0) => {
		if (P[i]) return;
		if (depth > bones.length) throw new Error(`adaptRig: bone "${bones[i].name}" is its own ancestor`);
		const b = bones[i], p = b.parent, q = b.localQuat ?? [0, 0, 0, 1], ql = Math.hypot(...q) || 1;
		const L = matFromQuat(q.map(v => v / ql)), t = scale(b.localPos ?? [0, 0, 0], k);
		if (p < 0) { R[i] = L; P[i] = t; return; }
		visit(p, depth + 1);
		R[i] = mul(R[p], L);
		P[i] = add(P[p], apply(R[p], t));
	};
	bones.forEach((_, i) => visit(i));
	return { names: bones.map(b => String(b.name)), P, R };
}

function snap(v) {
	const k = [0, 1, 2].reduce((m, i) => (Math.abs(v[i]) > Math.abs(v[m]) ? i : m), 0);
	return Math.abs(v[k]) >= SNAP ? [0, 1, 2].map(i => (i === k ? Math.sign(v[k]) : 0)) : null;
}

/** Rows [left, up, forward] of the source: a canonical point is apply(B, source point). pos(name) gives a source joint. */
export function facingAxes(pos) {
	const up = norm(sub(pos("Head"), scale(add(pos("LeftFoot"), pos("RightFoot")), 0.5)));
	const side = sub(pos("LeftUpLeg"), pos("RightUpLeg")), left = norm(sub(side, scale(up, dot(side, up))));
	const B = [left, up, cross(left, up)], snapped = B.map(snap);
	return snapped.every(Boolean) && new Set(snapped.map(v => v.findIndex(x => x !== 0))).size === 3 ? snapped : B;
}

/** Turns canonical bone `name`'s subtree (the X Bot's hierarchy) about its joint by Rm: joints and source frames. */
function turnSubtree(ref, pose, name, Rm) {
	const pivot = pose.J[name];
	for (const j of ref.subtree[ref.index[name]]) {
		const n = ref.names[j];
		if (pose.J[n]) pose.J[n] = add(pivot, apply(Rm, sub(pose.J[n], pivot)));
		if (pose.SR[n]) pose.SR[n] = mul(Rm, pose.SR[n]);
	}
}

const alignBone = (ref, pose, a, b) => pose.J[a] && pose.J[b] && turnSubtree(ref, pose, a, swing(sub(pose.J[b], pose.J[a]), sub(at(ref, b), at(ref, a))));

/** A vector's part across `axis` (unit). */
const across = (v, axis) => sub(v, scale(axis, dot(v, axis)));

function alignHand(ref, pose, S) {
	const h = `${S}Hand`, m = `${S}HandMiddle1`, i = `${S}HandIndex1`, p = `${S}HandPinky1`;
	if (!pose.J[m]) return;
	alignBone(ref, pose, h, m);
	if (!pose.J[i] || !pose.J[p]) return;
	const axis = norm(sub(at(ref, m), at(ref, h)));
	turnSubtree(ref, pose, h, swing(across(sub(pose.J[i], pose.J[p]), axis), across(sub(at(ref, i), at(ref, p)), axis)));
}

/**
 * Brings the limbs of pose { J, SR } onto the X Bot's bind directions (see the head of this file); returns how far the
 * upper arms hung below horizontal before (deg, the mean of both sides).
 */
export function normalise(ref, pose) {
	const J = pose.J, down = SIDES.map(S => { const d = sub(J[`${S}ForeArm`], J[`${S}Arm`]); return Math.atan2(-d[1], Math.hypot(d[0], d[2])) * 180 / Math.PI; });
	for (const S of SIDES) {
		const f = `${S}Foot`, t = `${S}ToeBase`, sourceFoot = J[t] && sub(J[t], J[f]);
		alignBone(ref, pose, `${S}Arm`, `${S}ForeArm`);
		alignBone(ref, pose, `${S}ForeArm`, `${S}Hand`);
		alignHand(ref, pose, S);
		alignBone(ref, pose, `${S}UpLeg`, `${S}Leg`);
		alignBone(ref, pose, `${S}Leg`, `${S}Foot`);
		if (!J[t]) continue;
		turnSubtree(ref, pose, f, swing(sub(J[t], J[f]), sourceFoot));
		turnSubtree(ref, pose, f, swing(flat(sub(J[t], J[f])), flat(sub(at(ref, t), at(ref, f)))));
	}
	return (down[0] + down[1]) / 2;
}

/** Length ratio (this skeleton / X Bot) of the joint chain `names`. */
const chain = (ref, J, names) => names.slice(1).reduce((s, n, i) => s + dist(J[n], J[names[i]]), 0) / names.slice(1).reduce((s, n, i) => s + dist(at(ref, n), at(ref, names[i])), 0);

/** Size ratios to the X Bot read off the joints present: { body, head, width, arm: {Left, Right}, leg, hand, foot }. */
export function ratios(ref, J, mapped) {
	const per = f => Object.fromEntries(SIDES.map(S => [S, f(S)]));
	const body = chain(ref, J, ["Hips", "Head"]), arm = per(S => chain(ref, J, [`${S}Arm`, `${S}ForeArm`, `${S}Hand`])), leg = per(S => chain(ref, J, [`${S}UpLeg`, `${S}Leg`, `${S}Foot`]));
	const knuckle = S => [`${S}HandMiddle1`, `${S}HandIndex1`, `${S}HandRing1`].find(n => mapped.has(n));
	return {
		body, arm, leg,
		head: mapped.has("HeadTop_End") ? chain(ref, J, ["Head", "HeadTop_End"]) : body,
		width: dist(J.LeftArm, J.RightArm) / dist(at(ref, "LeftArm"), at(ref, "RightArm")),
		hand: per(S => (knuckle(S) ? chain(ref, J, [`${S}Hand`, knuckle(S)]) : arm[S])),
		foot: per(S => (mapped.has(`${S}ToeBase`) ? chain(ref, J, [`${S}Foot`, `${S}ToeBase`]) : leg[S])),
	};
}

const FINGER = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)(\d)$/;

/** Adds every canonical joint J lacks (see the head of this file). r = ratios(...). */
export function fillMissing(ref, J, r) {
	const cum = TRUNK.map((_, i) => TRUNK.slice(1, i + 1).reduce((s, n, k) => s + dist(at(ref, n), at(ref, TRUNK[k])), 0));
	for (let i = 1; i < TRUNK.length - 1; i++) {
		if (J[TRUNK[i]]) continue;
		let b = i + 1;
		while (!J[TRUNK[b]]) b += 1;
		J[TRUNK[i]] = lerp(J[TRUNK[i - 1]], J[TRUNK[b]], (cum[i] - cum[i - 1]) / (cum[b] - cum[i - 1]));
	}
	ref.names.forEach((n, j) => {
		if (J[n]) return;
		const S = n.startsWith("Left") ? "Left" : "Right", f = FINGER.exec(n);
		if (f && f[3] === "4" && J[`${S}Hand${f[2]}3`] && J[`${S}Hand${f[2]}2`]) {
			const a = J[`${S}Hand${f[2]}2`], b = J[`${S}Hand${f[2]}3`], k = dist(b, a) / dist(at(ref, `${S}Hand${f[2]}3`), at(ref, `${S}Hand${f[2]}2`));
			J[n] = add(b, scale(norm(sub(b, a)), dist(at(ref, n), at(ref, `${S}Hand${f[2]}3`)) * k));
			return;
		}
		if (/Shoulder$/.test(n)) { J[n] = add(J[`${S}Arm`], scale(sub(at(ref, n), at(ref, `${S}Arm`)), r.width)); return; }
		const p = ref.names[ref.parent[j]], k = f ? r.hand[S] : /Toe/.test(n) ? r.foot[S] : n === "HeadTop_End" ? r.head : r.body;
		J[n] = add(J[p], scale(sub(at(ref, n), at(ref, p)), k));
	});
}

/** The bone a canonical bone points along: a hand's middle knuckle, else its first child (the X Bot's order). */
const axisChild = (ref, j) => (/Hand$/.test(ref.names[j]) ? ref.index[`${ref.names[j]}Middle1`] : ref.children[j][0]);

/** Bind world rotation of every canonical bone for joints J (see the head of this file). */
export function canonicalFrames(ref, J) {
	const R = {};
	ref.names.forEach((n, j) => {
		const c = axisChild(ref, j), Rr = ref.restWorldRot[j];
		if (c === undefined) { const p = ref.parent[j]; R[n] = mul(mul(R[ref.names[p]], T(ref.restWorldRot[p])), Rr); return; }
		const d0 = sub(ref.restWorldPos[c], ref.restWorldPos[j]), d1 = sub(J[ref.names[c]], J[n]);
		const second = n === "Hips" ? ["LeftUpLeg", "RightUpLeg"] : /Hand$/.test(n) ? [`${n}Index1`, `${n}Pinky1`] : null;
		R[n] = mul(second ? align(d0, sub(at(ref, second[0]), at(ref, second[1])), d1, sub(J[second[0]], J[second[1]])) : swing(d0, d1), Rr);
	});
	return R;
}
