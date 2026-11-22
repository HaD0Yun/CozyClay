// Which clip props ride one bone of one body for the whole clip, read from the clip (rule 6: from what the engine made,
// not from names). Such a prop becomes a child of that Studio bone (object.attach with its place in the bone's frame)
// instead of getting a baked track, so it follows the drawn body under a timing edit, a scale change or another look
// with nothing to keep in step. A prop whose carrier changes (picked up, put down, handed over, thrown, shared) keeps
// its track (install.js): the Studio has no attachment that changes over time.
// The Studio's attach frame of a bone (src/stage-attach-frames.js attachFrameMatrix) is the bone's world place and turn,
// unscaled. For the bones that are lowvis joints that is the clip joint's place and its world rotation times the
// bone's rest world rotation (take.js), so the frame is known here on every frame without a rig.
// Browser-safe and node-safe: no three.js, no node:* import.
import xBot from "../../motion3/rigs/x-bot-tpose.json" with { type: "json" };
import { INDEX, JOINT_COUNT, qConj, qMul, qRotate } from "../rig17.js";

/** Lowvis joint -> the Studio's attach bone on it (src/stage-attach-frames.js MIXAMO_ATTACH_BONES read the other way),
 *  in the order a carrier is chosen when two bones hold a prop equally still (hands and the head first). The chest
 *  (Spine1) is no lowvis joint: a prop on Spine2 keeps its track. */
export const ATTACH_BONE_OF = Object.freeze({
	RightHand: "rightHand", LeftHand: "leftHand", Head: "head", Neck: "neck", RightForeArm: "rightElbow", LeftForeArm: "leftElbow",
	RightArm: "rightShoulder", LeftArm: "leftShoulder", Spine: "spine", Hips: "hips", RightFoot: "rightFoot", LeftFoot: "leftFoot", RightLeg: "rightKnee", LeftLeg: "leftKnee",
});
/** The most a prop's place (m) and turn (degrees) in a bone's frame may vary over the clip for it to ride that bone.
 *  Measured on engine clips of a prop held in one hand the whole clip: its place varies by 0.02 mm and its turn by up to
 *  0.5 degrees (the hand joint turns a little against what it holds as it moves), so 1 degree takes a held prop and
 *  leaves one that slips in the grip (the engine's gripTurn row) on its track. */
export const STILL = Object.freeze({ place: 0.002, turn: 1 });
const REST = Object.fromEntries(xBot.bones.map(bone => [bone.name, bone.worldQuat]));
const DEG = 180 / Math.PI, EPS = 1e-4;
const r6 = v => Math.round(v * 1e6) / 1e6;

/** A unit quaternion as the Studio's XYZ Euler angles in degrees { rotX, rot, rotZ } (three.js Euler order XYZ). */
function eulerXYZ([x, y, z, w]) {
	const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - w * z), m13 = 2 * (x * z + w * y), m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - w * x), m32 = 2 * (y * z + w * x), m33 = 1 - 2 * (x * x + y * y);
	const ry = Math.asin(Math.max(-1, Math.min(1, m13)));
	const [rx, rz] = Math.abs(m13) < 0.9999999 ? [Math.atan2(-m23, m33), Math.atan2(-m12, m11)] : [Math.atan2(m32, m22), 0];
	return { rotX: r6(rx * DEG), rot: r6(ry * DEG), rotZ: r6(rz * DEG) };
}

/** The Studio attach frame of joint j of clip character c at frame f: { p, q } (world metres, unit quaternion). */
function boneFrame(c, j, f, name) {
	const i = f * JOINT_COUNT + j;
	return { p: [c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]], q: qMul([c.quat[i * 4], c.quat[i * 4 + 1], c.quat[i * 4 + 2], c.quat[i * 4 + 3]], REST[name]) };
}
/** Pose { p, q } in frame { p, q }: the pose's place and turn in that frame. */
function localIn(frame, pose) {
	const inv = qConj(frame.q), d = [0, 1, 2].map(k => pose.p[k] - frame.p[k]);
	return { p: qRotate(inv, d), q: qMul(inv, pose.q) };
}
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * DEG;

/** The characters (indices) that carry prop `p` on frame f: what its `by` names, through the props it rides. */
function carriersAt(clip, p, f, seen = new Set([p.id])) {
	const index = new Map(clip.characters.map((c, i) => [c.id, i])), props = new Map((clip.props ?? []).map(q => [q.id, q]));
	return [...new Set((p.by?.[f] ?? []).flatMap(id => index.has(id) ? [index.get(id)] : props.has(id) && !seen.has(id) ? carriersAt(clip, props.get(id), f, new Set([...seen, id])) : []))];
}

/**
 * attachOf(clip, prop, poseAt) -> null, or { index, joint, bone, local: { x, y, z, rotX, rot, rotZ }, drift: { place, turn } }:
 * the first bone (ATTACH_BONE_OF order) of the one character that carries the prop on every frame of the clip (its `by`)
 * over which the prop's place and turn in that bone's frame vary by no more than STILL. poseAt(f) -> { pos, quat }: the
 * Studio object's world pose at frame f (install.js: its base pivot, its own turn included). local: its pose in the
 * bone's frame on frame 0 (what object.attach { local } takes); drift: how far that pose varies over the clip (m, degrees).
 * null for a prop that does not move, a clip without `by`, a frame on which no character or another one carries it,
 * and a prop no bone holds still (a hand that slips, a prop on the chest).
 */
export function attachOf(clip, prop, poseAt) {
	const n = prop.pos.length / 3, F = clip.frameCount;
	if (n < F || !Array.isArray(prop.by)) return null;
	let index = -1, moved = false;
	for (let f = 0; f < F; f++) {
		const now = carriersAt(clip, prop, f);
		if (now.length !== 1 || (index >= 0 && now[0] !== index)) return null;
		index = now[0];
		if (f > 0) for (let k = 0; k < 3; k++) if (Math.abs(prop.pos[f * 3 + k] - prop.pos[k]) > EPS) moved = true;
	}
	if (!moved) for (let f = 1; f < F && !moved; f++) for (let k = 0; k < 4; k++) if (Math.abs(prop.quat[f * 4 + k] - prop.quat[k]) > EPS) moved = true;
	if (index < 0 || !moved) return null;
	const c = clip.characters[index], poses = Array.from({ length: F }, (_, f) => { const at = poseAt(f); return { p: at.pos, q: at.quat }; });
	for (const [joint, bone] of Object.entries(ATTACH_BONE_OF)) {
		const j = INDEX[joint], first = localIn(boneFrame(c, j, 0, joint), poses[0]);
		let place = 0, turn = 0;
		for (let f = 1; f < F && place <= STILL.place && turn <= STILL.turn; f++) {
			const at = localIn(boneFrame(c, j, f, joint), poses[f]);
			place = Math.max(place, Math.hypot(...at.p.map((v, k) => v - first.p[k])));
			turn = Math.max(turn, angle(at.q, first.q));
		}
		if (place > STILL.place || turn > STILL.turn) continue;
		const qn = Math.hypot(...first.q) || 1;
		return { index, joint, bone, local: { x: r6(first.p[0]), y: r6(first.p[1]), z: r6(first.p[2]), ...eulerXYZ(first.q.map(v => v / qn)) }, drift: { place: r6(place), turn: Math.round(turn * 1000) / 1000 } };
	}
	return null;
}
