// The capsule look: the box look's segments as capsules, a sphere head with a nose cone, dark toe caps.
import * as THREE from "three";
import { DEFAULT_TINT, PARTS, accentColor, clayMaterial, createJointRig, span } from "./parts.js";

/** A capsule along +Y of total length `length`, squashed to `w` across X and `d` across Z. */
function capsule(w, length, d, material) {
	const r = Math.min(d / 2, length / 2 - 0.001);
	const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.002, length - r * 2), 6, 16), material);
	m.scale.set(w / (r * 2), 1, d / (r * 2));
	return m;
}

export function capsuleLook({ tint = DEFAULT_TINT } = {}) {
	const rig = createJointRig();
	const clay = clayMaterial(tint);
	const dark = clayMaterial(accentColor(tint));

	for (const part of PARTS) {
		if (part.from) {
			const s = span(part.from, part.to);
			// The round ends overlap at the joint so the limb reads as one chain.
			const m = capsule(part.w, s.length + Math.min(part.w, part.d) * 0.55, part.d, clay);
			m.quaternion.copy(s.quaternion);
			rig.attach(part.joint, m, s.centre);
			continue;
		}
		const [cx, cy, cz] = part.centre, [w, h, d] = part.size;
		if (part.head) {
			const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), clay);
			head.scale.set(w * 1.08, h, d * 1.08);
			rig.attach(part.joint, head, part.centre);
			const nose = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.07, 12), dark);
			nose.rotation.x = Math.PI / 2; // the cone's tip points to +Z
			rig.attach(part.joint, nose, [cx, cy - h * 0.03, cz + d * 0.54 + 0.02]);
		} else if (part.foot) {
			const foot = capsule(w, d, h, clay);
			foot.rotation.x = Math.PI / 2; // lies along Z
			rig.attach(part.joint, foot, part.centre);
			const cap = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), dark);
			cap.scale.set(w + 0.02, h + 0.02, 0.1);
			rig.attach(part.joint, cap, [cx, cy, cz + d / 2 - 0.045]);
		} else {
			rig.attach(part.joint, capsule(w, h + 0.05, d, clay), part.centre);
		}
	}
	return { object3D: rig.object3D, setPose: rig.setPose };
}
