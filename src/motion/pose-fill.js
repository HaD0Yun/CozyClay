// Pose mode's Key and Fill: K keys the whole body plus where the character stands at the playhead; Fill turns the keyed
// frames into authored spec keys and runs motion.fill (MotionBricks between them), which compiles, runs QA and installs.
// A keyed frame is read off the live rig posed at that frame (motion owner poseRigAt), in the character's own space; its
// placement key puts it on the floor (relative to the character's stage spot, the space a compiled take is baked in).
import * as THREE from "three";
import { skeletonFor } from "../motion3/rigs/index.js";
import { normalizeBoneName } from "../poses.js";
import { samplePlacement, placementRows } from "./placement-keys.js";
import { placeState, authoredChannels, authoredFrames, authoredSpec } from "../motion3/bricks/authored-keys.js";
import { ry, apply } from "../motion3/compiler/math.js";

/** The posed rig as a compiler frame state: world rotations under the hips' parent, positions in the character group (m). */
function rigState(rig, sk) {
	const first = new Map();
	rig.traverse(o => { if (o.isBone) { const n = normalizeBoneName(o.name); if (!first.has(n)) first.set(n, o); } });
	const find = name => { const t = normalizeBoneName(name); for (const [n, b] of first) if (n === t || n.endsWith(t)) return b; return null; };
	const hips = find("Hips"), under = hips.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
	const toGroup = (rig.parent ?? rig).matrixWorld.clone().invert(), p = new THREE.Vector3(), q = new THREE.Quaternion(), m = new THREE.Matrix4();
	const P = [], R = [];
	for (const name of sk.names) {
		const bone = find(name) ?? hips;
		bone.getWorldPosition(p).applyMatrix4(toGroup); P.push([p.x, p.y, p.z]);
		const e = m.makeRotationFromQuaternion(q.copy(under).multiply(bone.getWorldQuaternion(new THREE.Quaternion()))).elements;
		R.push([[e[0], e[4], e[8]], [e[1], e[5], e[9]], [e[2], e[6], e[10]]]);
	}
	return { P, R };
}

/** Where the character stands at `frame` (its placement keys, else its stage spot). */
export const placementOf = (entry, ikKeys, frame) => samplePlacement(placementRows(ikKeys), frame) ?? { x: entry.x ?? 0, z: entry.z ?? 0, rot: entry.rot ?? 0 };

/** The authored spec of a character's keyed frames: { spec, frames (authored), keyed }. */
export function poseKeysSpec({ entry, ikKeys, take, frameCount, poseRigAt }) {
	const keyed = [...new Set(ikKeys.map(row => row.frame))];
	const frames = authoredFrames(keyed), sk = skeletonFor(entry.model);
	if (!sk) throw new Error(`${entry.model} is not a rig the fill can drive`);
	const keys = frames.map(f => {
		const rig = poseRigAt(f);
		if (!rig) throw new Error("The character rig is not loaded.");
		let s = rigState(rig, sk);
		// without a take the body stands at its placement key; a take already carries its root travel in the hips
		if (!take) {
			const at = placementOf(entry, ikKeys, f), d = apply(ry(-(entry.rot ?? 0)), [at.x - (entry.x ?? 0), 0, at.z - (entry.z ?? 0)]);
			s = placeState(s, { x: d[0], z: d[2], rot: at.rot - (entry.rot ?? 0) });
		}
		return { f, set: authoredChannels(sk, s) };
	});
	return { spec: authoredSpec(Math.max(frameCount, frames.at(-1) + 1), keys), frames, keyed: keyed.sort((a, b) => a - b) };
}
