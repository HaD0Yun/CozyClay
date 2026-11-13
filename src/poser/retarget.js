// Writing a solved pose onto a character's bones, and reading its bones back, over plain data. Transforms are rigid `{ R, t }` with R a
// flat row-major 3x3 and t in armature units. Output per touched bone: armature-space `pose` (Pose4), `basis`
// (relative to rest) and the three.js-style parent-relative `local` (quaternion + position).
import { cross, dot, mul, mulTA, mulTB, mulTVec, mulVec, norm, shortestArc, sub, identity } from "./mat3.js";
import { fk, poseBuffers, restLayout } from "./skeleton.js";

const LIMBS = { 13: [11, 12, 13], 19: [17, 18, 19], 24: [22, 23, 24], 28: [26, 27, 28] };
const FEET = new Set([24, 28]);

const compose = (a, b) => ({ R: mul(new Float64Array(9), 0, a.R, 0, b.R, 0), t: mulVec([0, 0, 0], 0, a.R, 0, b.t, 0).map((v, i) => v + a.t[i]) });
const invert = (a) => ({ R: mulTA(new Float64Array(9), 0, a.R, 0, identity(), 0), t: mulTVec([0, 0, 0], 0, a.R, 0, a.t, 0).map((v) => -v) });
const restOf = (rig, b) => ({ R: rig.bones[b].rest, t: rig.bones[b].head });
const unit = (v) => { const n = norm(v); return v.map((x) => x / n); };

function boneDepth(rig, b) { let d = 0; for (let k = rig.bones[b].parent; k >= 0; k = rig.bones[k].parent) d += 1; return d; }

/** Armature-space bone orientation for each written joint's bone: `Rarm_j = Rᵀ G_j R E_j`. */
function armatureRotations(rig, G) {
	const rarm = new Map(), tmp = new Float64Array(9), tmp2 = new Float64Array(9);
	rig.written.forEach((on, j) => {
		if (!on) return;
		mulTA(tmp, 0, rig.R, 0, G, 9 * j);
		mul(tmp2, 0, tmp, 0, rig.R, 0);
		rarm.set(rig.boneOf[j], mul(new Float64Array(9), 0, tmp2, 0, rig.E, 9 * j));
	});
	return rarm;
}

// compose Pose4 for written bones (parents first) and the bones held at rest between them
function composePoses(rig, rarm, rootPos) {
	const writtenBones = new Set(rarm.keys()), rootBone = rig.boneOf[0], poses = new Map(), basis = new Map();
	const order = [...writtenBones].sort((a, b) => boneDepth(rig, a) - boneDepth(rig, b) || a - b);
	for (const b of order) {
		let a = rig.bones[b].parent;
		const between = [];
		while (a >= 0 && !writtenBones.has(a)) { between.push(a); a = rig.bones[a].parent; }
		let base = restOf(rig, b);
		if (a >= 0) {
			const carry = compose(poses.get(a), invert(restOf(rig, a)));
			base = compose(carry, base);
			for (const k of between) { poses.set(k, compose(carry, restOf(rig, k))); basis.set(k, { R: identity(), t: [0, 0, 0] }); }
		}
		const pose = { R: rarm.get(b), t: b === rootBone ? rootPos : base.t };
		poses.set(b, pose);
		basis.set(b, compose(invert(base), pose));
	}
	return { poses, basis };
}

/** Turn the upper and lower limb bones so the end bone's head lands on `t` (armature space). */
function fitLimb(rig, rarm, poses, limb, t) {
	const [upper, lower, end] = limb.map((j) => rig.boneOf[j]);
	const Ap = poses.get(upper).t, Bp = poses.get(lower).t, Cp = poses.get(end).t;
	const l1 = norm(sub(Bp, Ap)), l2 = norm(sub(Cp, Bp));
	let d = norm(sub(t, Ap));
	if (l1 < 1e-8 || l2 < 1e-8 || d < 1e-8 || norm(sub(t, Cp)) < 1e-6) return;
	d = Math.max(Math.abs(l1 - l2) + 1e-5, Math.min(l1 + l2 - 1e-5, d));
	const u = unit(sub(t, Ap)), ab = sub(Bp, Ap), abu = dot(ab, u);
	let v = [ab[0] - abu * u[0], ab[1] - abu * u[1], ab[2] - abu * u[2]];
	if (norm(v) < 1e-6) {
		const w = cross(sub(Cp, Ap), u);
		v = norm(w) > 1e-6 ? cross(w, u) : cross(u, Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
	}
	v = unit(v);
	const cosA = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))), sinA = Math.sqrt(1 - cosA * cosA);
	const B2 = [0, 1, 2].map((i) => Ap[i] + l1 * (cosA * u[i] + sinA * v[i]));
	const [Ra] = shortestArc(ab, sub(B2, Ap));
	const C2 = mulVec([0, 0, 0], 0, Ra, 0, sub(Cp, Bp), 0).map((x, i) => x + B2[i]);
	const [Rb] = shortestArc(sub(C2, B2), [0, 1, 2].map((i) => Ap[i] + d * u[i] - B2[i]));
	rarm.set(upper, mul(new Float64Array(9), 0, Ra, 0, rarm.get(upper), 0));
	const RbRa = mul(new Float64Array(9), 0, Rb, 0, Ra, 0);
	rarm.set(lower, mul(new Float64Array(9), 0, RbRa, 0, rarm.get(lower), 0));
}

/** Where hands and feet must land after writing (armature space): their tight places; feet at the solved height. */
function limbPins(rig, world, effectors, { floor = true } = {}) {
	const pins = [];
	for (const e of effectors) {
		if (e.type !== 0 || !LIMBS[e.joint] || !((e.tol ?? 0.005) <= 0.02)) continue;
		const p = [...e.target];
		if (FEET.has(e.joint) && floor) p[1] = Math.max(p[1], world.joints[3 * e.joint + 1]);
		pins.push({ joint: e.joint, target: mulTVec([0, 0, 0], 0, rig.R, 0, p, 0).map((x) => x / rig.s) });
	}
	return pins;
}

/**
 * The world-frame pose (`world.joints` [90], `world.rot6dGlobal` or `world.G`; world frame after the floor
 * shift) and the effectors that were sent (skeleton frame, before the floor shift) -> bone transforms.
 */
export function writePose(rig, world, effectors = [], options = {}) {
	const rarm = armatureRotations(rig, world.G);
	const rootPos = mulTVec([0, 0, 0], 0, rig.R, 0, world.joints, 0).map((x) => x / rig.s);
	let { poses, basis } = composePoses(rig, rarm, rootPos);
	const pins = rig.limbFitNeeded ? limbPins(rig, world, effectors, options) : [];
	if (pins.length) {
		for (const pin of pins) if (LIMBS[pin.joint].every((j) => rig.written[j])) fitLimb(rig, rarm, poses, LIMBS[pin.joint], pin.target);
		({ poses, basis } = composePoses(rig, rarm, rootPos));
	}
	const bones = [...poses.keys()].sort((a, b) => a - b).map((b) => {
		const parent = rig.bones[b].parent, rest = restOf(rig, b), bb = basis.get(b);
		const local = compose(parent >= 0 ? compose(invert(restOf(rig, parent)), rest) : rest, bb);
		return { name: rig.bones[b].name, pose: toMat4(poses.get(b)), basis: toMat4(bb), quaternion: quatOf(local.R), position: local.t };
	});
	return { bones, pins };
}

/**
 * Read the character's current pose back. `posed(name)` returns the bone's armature-space `{ R, t }`.
 * Returns skeleton-frame `{ L, G, P, root }` on the measured-length layout.
 */
export function readPose(sk, rig, posed) {
	const pose = poseBuffers(), tmp = new Float64Array(9), tmp2 = new Float64Array(9);
	for (let j = 0; j < 30; j += 1) {
		if (!rig.written[j]) { pose.G.copyWithin(9 * j, 9 * sk.parents[j], 9 * sk.parents[j] + 9); continue; }
		mulTB(tmp, 0, posed(rig.bones[rig.boneOf[j]].name).R, 0, rig.E, 9 * j);
		mul(tmp2, 0, rig.R, 0, tmp, 0);
		mulTB(pose.G, 9 * j, tmp2, 0, rig.R, 0);
	}
	for (let j = 0; j < 30; j += 1) {
		if (j === 0) pose.L.set(pose.G.subarray(0, 9), 0);
		else mulTA(pose.L, 9 * j, pose.G, 9 * sk.parents[j], pose.G, 9 * j);
	}
	const head = posed(rig.bones[rig.boneOf[0]].name).t;
	pose.root.set(mulVec([0, 0, 0], 0, rig.R, 0, head, 0).map((x) => x * rig.s));
	fk(sk, pose.L, pose.root, restLayout(sk, rig.measured), pose.G, pose.P);
	return pose;
}

function toMat4({ R, t }) {
	return [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1];
}

/** Rotation matrix (row-major) -> quaternion [x, y, z, w]. */
export function quatOf(m) {
	const tr = m[0] + m[4] + m[8];
	let x, y, z, w;
	if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (m[7] - m[5]) * s; y = (m[2] - m[6]) * s; z = (m[3] - m[1]) * s; }
	else if (m[0] > m[4] && m[0] > m[8]) { const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]); w = (m[7] - m[5]) / s; x = 0.25 * s; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s; }
	else if (m[4] > m[8]) { const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]); w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = 0.25 * s; z = (m[5] + m[7]) / s; }
	else { const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]); w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = 0.25 * s; }
	return [x, y, z, w];
}
