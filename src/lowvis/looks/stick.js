// The stick look: bones as thin lines between the clip's joint POSITIONS (so a stretching clip shows as stretch),
// a dot on every joint, and short lines for what a joint's rotation alone decides: head top, nose, hands, feet.
import * as THREE from "three";
import { INDEX, JOINT_COUNT, PARENT, REST, TIPS } from "../rig17.js";
import { DEFAULT_TINT, accentColor } from "./parts.js";

const LINE_RADIUS = 0.011, DOT_RADIUS = 0.026;
const UP = new THREE.Vector3(0, 1, 0);

// Points that ride on a joint: [joint, rest position].
const headJ = REST[INDEX.Head];
const RIDERS = [
	["Head", TIPS.Head],
	["Head", [headJ[0], headJ[1] + 0.09, headJ[2] + 0.15]], // nose: where the face points
	["LeftHand", TIPS.LeftHand], ["RightHand", TIPS.RightHand],
	["LeftFoot", TIPS.LeftFoot], ["RightFoot", TIPS.RightFoot],
].map(([name, p]) => ({ joint: INDEX[name], offset: new THREE.Vector3().fromArray(p).sub(new THREE.Vector3().fromArray(REST[INDEX[name]])) }));
// The nose line starts in the middle of the head, not at the head joint.
const NOSE = 1, NOSE_ROOT = new THREE.Vector3(0, 0.09, 0.02);

export function stick({ tint = DEFAULT_TINT } = {}) {
	const object3D = new THREE.Group();
	const lineMat = new THREE.MeshBasicMaterial({ color: accentColor(tint, 0.7) });
	const dotMat = new THREE.MeshBasicMaterial({ color: accentColor(tint, 0.3) });
	const lineGeo = new THREE.CylinderGeometry(LINE_RADIUS, LINE_RADIUS, 1, 8);
	const dotGeo = new THREE.SphereGeometry(DOT_RADIUS, 12, 8);
	const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; object3D.add(m); return m; };

	const dots = Array.from({ length: JOINT_COUNT }, () => add(dotGeo, dotMat));
	const bones = Array.from({ length: JOINT_COUNT }, (_, j) => (PARENT[j] < 0 ? null : add(lineGeo, lineMat)));
	const riders = RIDERS.map(() => add(lineGeo, lineMat));

	const a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Quaternion();
	function stretch(mesh, from, to) {
		const length = from.distanceTo(to);
		mesh.position.copy(from).add(to).multiplyScalar(0.5);
		mesh.scale.set(1, Math.max(length, 1e-4), 1);
		if (length > 1e-6) mesh.quaternion.setFromUnitVectors(UP, b.copy(to).sub(from).divideScalar(length));
	}
	const from = new THREE.Vector3(), to = new THREE.Vector3();
	function setPose(pos, quat, frame = 0) {
		const p = frame * JOINT_COUNT * 3, qo = frame * JOINT_COUNT * 4;
		for (let j = 0; j < JOINT_COUNT; j++) {
			dots[j].position.fromArray(pos, p + j * 3);
			if (bones[j]) stretch(bones[j], from.fromArray(pos, p + PARENT[j] * 3), to.fromArray(pos, p + j * 3));
		}
		RIDERS.forEach((r, i) => {
			q.fromArray(quat, qo + r.joint * 4);
			from.fromArray(pos, p + r.joint * 3);
			to.copy(r.offset).applyQuaternion(q).add(from);
			if (i === NOSE) from.add(a.copy(NOSE_ROOT).applyQuaternion(q));
			stretch(riders[i], from, to);
		});
	}
	setPose(REST.flat(), Array.from({ length: JOINT_COUNT }, () => [0, 0, 0, 1]).flat(), 0);
	return { object3D, setPose };
}
