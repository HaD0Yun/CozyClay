// Rig facts: the plain JSON the rig library is built from (bone names and parents, the rest pose,
// bone lengths, joint limits, mass segments, collision capsules, sole and palm landmarks, the
// character placement and the scene boxes). Metres, rig origin, +Y up, the rig faces +Z.
import { quatFromMat, apply, T, sub, len, scale } from "../../motion3/compiler/math.js";
import { restState } from "../../motion3/compiler/skeleton.js";
import { SEGMENT_FRACTIONS } from "../../motion3/qa/com.js";
import { CAPSULES, solePoints } from "../../motion3/qa/geometry.js";
import { WRIST_LIMITS } from "../../motion3/compiler/arm-orient.js";
import { ELBOW_STOP, KNEE_STOP } from "../../motion3/compiler/limbs.js";
import { axisEnd } from "../../motion3/body.js";
import { motionScene } from "../../motion3/scene.js";

const copy = v => v.slice();

/** A point given in world rest coordinates, expressed in bone b's rest frame: [b, local]. */
const restLocal = (sk, b, p) => [b, apply(T(sk.restWorldRot[b]), sub(p, sk.restWorldPos[b]))];

function soleLandmarks(sk, side) {
	const I = sk.index, s = solePoints(sk, restState(sk), side), toe = I[`${side}ToeBase`];
	return { heel: restLocal(sk, I[`${side}Foot`], s.heel), ball: restLocal(sk, toe, s.ball), tip: restLocal(sk, I[`${side}Toe_End`] ?? toe, s.tip) };
}

function sceneFacts(records) {
	const scene = motionScene(records ?? []);
	const objects = Object.fromEntries(Object.entries(scene.objects).map(([id, o]) => [id, { pos: o.pos, R: o.R, half: o.half, ancestors: o.ancestors }]));
	const groups = Object.fromEntries(Object.entries(scene.groups).map(([id, g]) => [id, { pos: g.pos, R: g.R, children: g.children }]));
	return { objects, groups };
}

/**
 * Rig facts for skeleton sk (skeletonFor(model)), the motion subject character { id, model, position, yaw }
 * and the authored scene records (the shape motionScene takes).
 */
export function rigFacts(sk, character, records) {
	if (!sk?.names) throw new Error("rigFacts: no skeleton for this character");
	const I = sk.index;
	const lengths = sk.names.map((_, b) => {
		const c = axisEnd(sk, b);
		return c === undefined ? 0 : len(sk.restLocalPos[c]);
	});
	const palm = side => {
		const h = I[`${side}Hand`];
		return [h, scale(sk.restLocalPos[I[`${side}HandMiddle1`]], 0.5)];
	};
	const segments = SEGMENT_FRACTIONS.map(s => ({ id: s.id, start: I[s.start], end: I[s.end], mass: s.mass }));
	if (segments.some(s => s.start === undefined || s.end === undefined)) throw new Error(`rigFacts: ${sk.model} lacks a mass segment bone`);
	return {
		model: sk.model ?? character?.model, fps: 24,
		names: sk.names.slice(), parent: sk.parent.slice(), children: sk.children.map(copy),
		restLocalPos: sk.restLocalPos.map(copy), restLocalQuat: sk.restLocalRot.map(quatFromMat),
		restWorldPos: sk.restWorldPos.map(copy), restWorldQuat: sk.restWorldRot.map(quatFromMat),
		lengths,
		placement: { position: (character?.position ?? [0, 0, 0]).slice(0, 3).map(v => Number(v) || 0), yaw: Number(character?.yaw) || 0 },
		limits: { elbow: { fold: [0, ELBOW_STOP] }, knee: { fold: [0, KNEE_STOP] }, wrist: { flex: WRIST_LIMITS.flex.slice(), dev: WRIST_LIMITS.dev.slice(), twist: WRIST_LIMITS.twist.slice() } },
		segments,
		capsules: CAPSULES.map(([part, a, b, r]) => [part, I[a], I[b], r]),
		landmarks: {
			sole: { Left: soleLandmarks(sk, "Left"), Right: soleLandmarks(sk, "Right") },
			palm: { Left: palm("Left"), Right: palm("Right") },
			headTop: I.HeadTop_End ?? I.Head,
		},
		scene: sceneFacts(records),
	};
}
