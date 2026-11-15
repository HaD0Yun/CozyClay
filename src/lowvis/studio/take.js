// A lowvis clip character as a raw track of the Studio's own X Bot skeleton (motion-v4/track: a take v3 in the world
// frame), so the Studio can install it on a cast member like any other take (motion.v4.install).
// The 17 joints of the lowvis figure are X Bot bones with the X Bot's rest places (tools/lowvis/make-rig17.mjs), so
// the track is exact: each of the 17 bones takes the clip joint's world rotation, every other bone (Spine1, the
// shoulders, fingers, toes) keeps its bind rotation, and the 17 joints then stand where the clip has them.
// Browser-safe and node-safe: no three.js, no node:* import.
import xBot from "../../motion3/rigs/x-bot-tpose.json" with { type: "json" };
import { INDEX, JOINT_COUNT, qConj, qMul } from "../rig17.js";

export const TRACK_RIG = "x-bot-tpose";
const BONES = xBot.bones, NAMES = BONES.map(bone => bone.name), JOINT_OF = BONES.map(bone => INDEX[bone.name] ?? -1);

/**
 * clipTrack(clip, index) -> RawTrack { schema, fps, frameCount, rig, bones, rot, hips, objects } for character `index`
 * of a lowvis.clip.v1: rot holds 65 local quaternions per frame (the Hips one is its world rotation), hips the world
 * place of the Hips joint in metres. objects is empty: the clip's props are not Studio objects here.
 */
export function clipTrack(clip, index) {
	const character = clip.characters[index], F = clip.frameCount, B = BONES.length;
	const rot = new Float32Array(F * B * 4), hips = new Float32Array(F * 3), world = new Array(B);
	for (let f = 0; f < F; f++) {
		for (let b = 0; b < B; b++) {
			const bone = BONES[b], j = JOINT_OF[b], at = (f * JOINT_COUNT + j) * 4;
			// a clip joint's quaternion is its world rotation from rest: world = that x the rest world rotation
			world[b] = j >= 0 ? qMul([character.quat[at], character.quat[at + 1], character.quat[at + 2], character.quat[at + 3]], bone.worldQuat)
				: bone.parent < 0 ? bone.worldQuat : qMul(world[bone.parent], bone.localQuat);
			const local = bone.parent < 0 ? world[b] : j >= 0 ? qMul(qConj(world[bone.parent]), world[b]) : bone.localQuat;
			const n = Math.hypot(local[0], local[1], local[2], local[3]) || 1;
			for (let k = 0; k < 4; k++) rot[(f * B + b) * 4 + k] = local[k] / n;
		}
		for (let k = 0; k < 3; k++) hips[f * 3 + k] = character.pos[f * JOINT_COUNT * 3 + k]; // joint 0 is the Hips
	}
	return { schema: "cozyclay.take.v3", fps: clip.fps ?? 24, frameCount: F, rig: TRACK_RIG, bones: NAMES.slice(), rot, hips, objects: {} };
}
