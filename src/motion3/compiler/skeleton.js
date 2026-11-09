// Rig skeleton for the motion3 compiler: bind data from src/motion3/rigs/<model>.json
// (extracted by tools/motion3/extract-rig.mjs), in METRES, rig root at the origin
// facing +Z with +X on the character's left.
import { apply, add, sub, mul, T, matFromQuat, quatFromMat } from "./math.js";

const CM = 0.01;

export function createSkeleton(rigJson) {
	const bones = rigJson.bones;
	const names = bones.map(b => b.name);
	const index = Object.fromEntries(names.map((n, i) => [n, i]));
	const parent = bones.map(b => b.parent);
	const children = names.map(() => []);
	parent.forEach((p, i) => { if (p >= 0) children[p].push(i); });
	// subtree[i] = i and every descendant, parents before children
	const subtree = names.map((_, i) => {
		const out = [], stack = [i];
		while (stack.length) { const j = stack.shift(); out.push(j); stack.unshift(...children[j]); }
		return out;
	});
	const restLocalPos = bones.map(b => b.localPos.map(v => v * CM));
	const restLocalRot = bones.map(b => matFromQuat(b.localQuat));
	const restWorldPos = bones.map(b => b.worldPos.map(v => v * CM));
	const restWorldRot = bones.map(b => matFromQuat(b.worldQuat));
	const L = rigJson.landmarks;
	const head = index.Head;
	// Landmarks re-expressed in the Head bone's rest frame, so they ride the head.
	const toHead = p => apply(T(restWorldRot[head]), sub(p.map(v => v * CM), restWorldPos[head]));
	const landmarks = {
		mouth: toHead(L.mouth),
		headCentre: toHead(L.headEllipsoid.centre),
		headRadii: L.headEllipsoid.radii.map(v => v * CM),
		// how far the skin's sole lies below the ToeBase / Toe_End joints at bind (m; qa/geometry.js solePoints)
		sole: { ball: (L.sole?.ball ?? 0) * CM, tip: (L.sole?.tip ?? 0) * CM, ...(L.sole?.heel ? { heel: L.sole.heel.map(v => v * CM) } : {}) },
		// an adapted rig's proportions to the X Bot (rigs/adapt-measure.js): { foot, hand, arm, hips, girth }; absent on the X/Y Bot
		...(L.scale ? { scale: { ...L.scale } } : {}),
	};
	return { model: rigJson.model, names, index, parent, children, subtree, restLocalPos, restLocalRot, restWorldPos, restWorldRot, landmarks };
}

/**
 * Rig sk's size over the X Bot's for body part `part` (landmarks.scale, rigs/adapt-measure.js: foot, hand, arm, hips,
 * girth), for the body sizes the compiler and QA hold in metres; 1 on the X/Y Bot, which carry none (x 1 is exact).
 */
export const rigScale = (sk, part) => sk?.landmarks?.scale?.[part] ?? 1;

/** [back, up] of the heel point from the ankle at bind (m): landmarks.sole.heel on an adapted rig, else the X/Y Bot's. */
export const soleHeel = sk => sk.landmarks?.sole?.heel ?? [0.045, 0.005];

/** Rest pose as a mutable world-space state { P, R }. */
export function restState(sk) {
	return { P: sk.restWorldPos.map(p => p.slice()), R: sk.restWorldRot.map(r => r.map(row => row.slice())) };
}

/** Rigidly rotate bone `b`'s subtree by world rotation R about world point `pivot`. */
export function rotateSubtree(sk, s, b, pivot, R) {
	for (const j of sk.subtree[b]) {
		s.P[j] = add(pivot, apply(R, sub(s.P[j], pivot)));
		s.R[j] = mul(R, s.R[j]);
	}
}

/** World state -> per-bone LOCAL quaternions [x,y,z,w] plus the hips local position (m). */
export function toLocal(sk, s) {
	const quats = sk.names.map((_, j) => {
		const p = sk.parent[j];
		return quatFromMat(p < 0 ? s.R[j] : mul(T(s.R[p]), s.R[j]));
	});
	return { quats, hips: s.P[sk.index.Hips].slice() };
}

/** Forward kinematics from local quaternions + hips position back to a world state. */
export function fk(sk, quats, hips) {
	const P = [], R = [];
	for (const j of sk.subtree[sk.index.Hips]) {
		const p = sk.parent[j], Lr = matFromQuat(quats[j]);
		if (p < 0) { R[j] = Lr; P[j] = hips.slice(); continue; }
		R[j] = mul(R[p], Lr);
		P[j] = add(P[p], apply(R[p], sk.restLocalPos[j]));
	}
	return { P, R };
}

/** Point fixed to a bone, given in that bone's own frame (e.g. a landmark). */
export const bonePoint = (s, b, local) => add(s.P[b], apply(s.R[b], local));
