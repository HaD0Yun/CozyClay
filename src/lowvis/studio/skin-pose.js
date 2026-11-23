// How a lowvis look follows a Studio rig (skin.jsx): the 17 lowvis joints are X Bot bones (tools/lowvis/make-rig17.mjs),
// and the figure takes their world places and rotations as one clip frame.
// The figure poses itself whenever its world matrices are updated, which every render does first (WebGLRenderer.render
// calls scene.updateMatrixWorld): the stage's frame loop, and every capture that writes a frame's bones and renders at
// once without a frame of that loop (check pictures, own-camera views, exports). So each picture shows the body at the
// pose its bones hold for that render.
import * as THREE from "three";
import { normalizeBoneName } from "../../poses.js";
import { JOINTS, JOINT_COUNT, SOURCE_REST_QUAT } from "../rig17.js";

/** The rig's control bone of each lowvis joint (the first bone of that name, as motion3/playback.js picks them). */
export function jointBones(rig) {
	const first = new Map();
	rig.traverse(node => {
		if (!node.isBone) return;
		const name = normalizeBoneName(node.name);
		if (!first.has(name)) first.set(name, node);
	});
	return JOINTS.map(joint => {
		const target = normalizeBoneName(joint);
		for (const [name, bone] of first) if (name === target || name.endsWith(target)) return bone;
		return null;
	});
}

/** followBones(body, bones, scale) -> undo: body ({ object3D, setPose }, a look) poses from `bones` at each matrix update.
 *  scale: the character's (its rig is that large): the look is drawn that large about its joints. */
export function followBones(body, bones, scale = 1) {
	const pos = new Float32Array(JOINT_COUNT * 3), quat = new Float32Array(JOINT_COUNT * 4), p = new THREE.Vector3(), q = new THREE.Quaternion();
	const fromRest = SOURCE_REST_QUAT.map(r => new THREE.Quaternion(r[0], r[1], r[2], r[3]).invert());
	const root = body.object3D, update = root.updateMatrixWorld;
	root.scale.setScalar(scale);
	root.updateMatrixWorld = function poseFromBones(force) {
		bones.forEach((bone, j) => {
			if (!bone) return;
			bone.getWorldPosition(p).divideScalar(scale).toArray(pos, j * 3); // the look's joints, which its own scale takes back to the bones' places
			// a clip joint's quaternion is its world rotation from rest
			bone.getWorldQuaternion(q).multiply(fromRest[j]).toArray(quat, j * 4);
		});
		body.setPose(pos, quat, 0);
		return update.call(this, force);
	};
	return () => { root.updateMatrixWorld = update; root.scale.setScalar(1); };
}
