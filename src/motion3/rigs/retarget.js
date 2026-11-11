// A take compiled on an adapted rig (adapt.js adaptRig) played on the character's own skeleton (its raw). The rig's
// canonical bones carry the motion; each source bone the report maps (report.retarget[canonical] = { source, offset })
// turns as its canonical bone does, through the bind offset: source world rotation (canonical axes) = canonical world
// rotation x offset, and in the source's own axes T(axes) x that (report.axes: canonical = axes x source). Every other
// source bone (a root or armature above the hips, twist and roll bones, metacarpals, face bones) keeps its bind local
// rotation, so it rides its parent rigidly. The source's hips bone takes the position of the canonical Hips, back in
// the source's axes and units, as a local position under its own parent (the root above it stays at its bind).
// Positions follow from the source's own bone offsets: a mapped joint lands where its canonical joint is whenever the
// canonical bone between them has a source bone of its own (a canonical bone adapt.js made up, such as a VRM's
// missing Spine1, bends where the source has no joint, and the source's chain cannot follow that bend exactly).
import { sourcePose } from "./adapt-pose.js";
import { sub, scale, apply, mul, T, matFromQuat, quatFromMat } from "../compiler/math.js";

const unit = q => { const l = Math.hypot(...q) || 1; return q.map(v => v / l); };

/**
 * retargetPlan(raw, report, sk) -> plan for retargetPose: raw is the source skeleton adaptRig read, report its report,
 * sk the adapted rig's skeleton (skeletonFor of the registered model). Throws when a mapped source bone is not in raw.
 */
export function retargetPlan(raw, report, sk) {
	const src = sourcePose(raw), n = raw.bones.length, k = raw.units === "m" ? 1 : 0.01;
	const parent = raw.bones.map(b => (Number.isInteger(b.parent) && b.parent >= 0 && b.parent < n ? b.parent : -1));
	const restLocal = raw.bones.map(b => matFromQuat(unit(b.localQuat ?? [0, 0, 0, 1])));
	const mapped = new Map();
	for (const [canonical, { source, offset }] of Object.entries(report.retarget)) {
		const i = src.names.indexOf(source), b = sk.index[canonical];
		if (i < 0 || b === undefined) throw new Error(`retargetPlan: no source bone "${source}" or canonical bone "${canonical}"`);
		mapped.set(i, { b, offset: matFromQuat(unit(offset)) });
	}
	// parents before children
	const depth = i => (parent[i] < 0 ? 0 : 1 + depth(parent[i])), order = [...Array(n).keys()].sort((a, c) => depth(a) - depth(c));
	const B = report.axes, hips = src.names.indexOf(report.retarget.Hips.source), hb = sk.index.Hips;
	// the canonical point of a source point: apply(B, p) + shift (metres); the hips do not move in adapt.js after the axes
	const shift = sub(sk.restWorldPos[hb], apply(B, src.P[hips]));
	return { n, parent, order, restLocal, mapped, B, k, hips, hb, shift, bindP: src.P, bindR: src.R };
}

/**
 * retargetPose(plan, state) -> { quats: [x, y, z, w] or null per raw bone (null: keep its bind local rotation),
 * hips: { bone: raw index, position: local position in raw units } }. state: a pose of the adapted rig { P, R } in
 * metres (compileSpec out.frames[f].s, or compiler/skeleton.js fk of a take's frame).
 */
export function retargetPose(plan, state) {
	const W = [], quats = Array(plan.n).fill(null), Bt = T(plan.B);
	for (const i of plan.order) {
		const m = plan.mapped.get(i), p = plan.parent[i];
		W[i] = m ? mul(Bt, mul(state.R[m.b], m.offset)) : p < 0 ? plan.restLocal[i] : mul(W[p], plan.restLocal[i]);
		if (m) quats[i] = quatFromMat(p < 0 ? W[i] : mul(T(W[p]), W[i]));
	}
	const world = apply(Bt, sub(state.P[plan.hb], plan.shift)), p = plan.parent[plan.hips];
	// the hips' parent chain keeps its bind, so its world frame is the bind's
	const local = p < 0 ? world : apply(T(plan.bindR[p]), sub(world, plan.bindP[p]));
	return { quats, hips: { bone: plan.hips, position: scale(local, 1 / plan.k) } };
}
