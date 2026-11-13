// Checks a solve before it is written to the character: a result that is not finite, that throws the body far, or
// that pulls a held handle away from its place is refused (the pose stays as it was), and a dragged handle the body
// cannot reach is reported. Pure data; positions in the poser frame (metres).
import { mulTVec, mulVec } from "../mat3.js";
import { HANDLES } from "../handles.js";

/** How far a held handle may end from its place before the solve is refused (metres). */
const HOLD_DRIFT = 0.03;
/** A dragged handle further than this from its joint is reported as out of reach (metres). */
export const REACH_MARGIN = 0.02;
/** The root may move this much beyond the dragged handle's own move in one solve (metres). */
const ROOT_MARGIN = 0.5;

const JOINT_OF = new Map(HANDLES.map((h) => [h.id, h.joint]));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const finite = (list) => list.every((v) => Number.isFinite(v));

/** Where written bones put each joint on the character: `(joint) -> [x, y, z]` or null when the joint is not written. */
export function writtenJoints(facts, bones) {
	const byName = new Map(bones.map((b) => [b.name, b.pose]));
	return (j) => {
		const bone = facts.boneOf[j] >= 0 ? facts.bones[facts.boneOf[j]] : null, pose = bone && byName.get(bone.name);
		return pose ? mulVec([0, 0, 0], 0, facts.R, 0, [pose[3], pose[7], pose[11]], 0).map((v) => v * facts.s) : null;
	};
}

/**
 * `sends`: what the solve was asked (handles.js dragSends); `drag`: `{ id, target? }`; `press`: `{ root, miss }` with
 * the root and each held handle's distance from its place at the press. Returns `{ ok: true, reach? }` or
 * `{ ok: false, reason: "not-finite" | "root-jump" | "held-moved", id?, cm? }`. `reach` names a dragged handle left short.
 */
export function checkSolve(facts, result, { sends, drag, press }) {
	if (!finite(result.joints) || !result.bones.every((b) => finite(b.quaternion) && finite(b.position))) return { ok: false, reason: "not-finite" };
	const at = writtenJoints(facts, result.bones), root = at(0) ?? [result.joints[0], result.joints[1], result.joints[2]];
	const moved = drag?.target && press.place ? dist(drag.target, press.place) : 0;
	const jump = dist(root, press.root);
	if (jump > ROOT_MARGIN + moved) return { ok: false, reason: "root-jump", cm: jump * 100 };
	let worst = null;
	for (const send of sends) {
		if (!send.position || send.id === drag?.id || (send.tol ?? 0) > HOLD_DRIFT) continue;
		const joint = at(JOINT_OF.get(send.id));
		if (!joint) continue;
		const miss = dist(joint, send.position), allowed = Math.max(HOLD_DRIFT, (press.miss?.[send.id] ?? 0) + 0.01);
		if (miss > allowed && (!worst || miss > worst.miss)) worst = { id: send.id, miss };
	}
	if (worst) return { ok: false, reason: "held-moved", id: worst.id, cm: worst.miss * 100 };
	const dragged = drag?.target && JOINT_OF.has(drag.id) && drag.id !== "lookAt" ? at(JOINT_OF.get(drag.id)) : null;
	const short = dragged ? dist(dragged, drag.target) : 0;
	return short > REACH_MARGIN ? { ok: true, reach: { id: drag.id, cm: short * 100 } } : { ok: true };
}

/**
 * The floor on the character: the network body is kept above y = 0 (hard floor), but the character's own proportions
 * and the limb fit can still put a written joint a few millimetres under it. Lift the whole body by that much.
 * Returns the bones (root position and every armature pose moved up) and the lift in metres.
 */
export function liftToFloor(facts, bones) {
	const at = writtenJoints(facts, bones);
	let low = Infinity;
	facts.written.forEach((on, j) => { const p = on ? at(j) : null; if (p) low = Math.min(low, p[1]); });
	if (!(low < 0)) return { bones, lift: 0 };
	const up = mulTVec([0, 0, 0], 0, facts.R, 0, [0, -low, 0], 0).map((v) => v / facts.s), root = facts.bones[facts.boneOf[0]].name;
	const raise = (pose) => pose.map((v, i) => (i === 3 ? v + up[0] : i === 7 ? v + up[1] : i === 11 ? v + up[2] : v));
	return {
		lift: -low,
		bones: bones.map((b) => ({ ...b, pose: raise(b.pose), ...(b.name === root ? { position: b.position.map((v, i) => v + up[i]) } : {}) })),
	};
}
