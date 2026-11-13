// The box look: one rigid clay box per body segment, a small gap and a dark knuckle at every limb joint, a dark
// visor and a nose on the face, dark toe caps. Front and back, left and right foot heading read from a distance.
import * as THREE from "three";
import { DEFAULT_TINT, KNUCKLES, PARTS, accentColor, clayMaterial, createJointRig, restOf, span } from "./parts.js";

const GAP = 0.012; // m cut from each end of a limb box

export function box({ tint = DEFAULT_TINT } = {}) {
	const rig = createJointRig();
	const clay = clayMaterial(tint);
	const dark = clayMaterial(accentColor(tint));
	const mesh = (size, material = clay) => new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);

	for (const part of PARTS) {
		if (part.from) {
			const s = span(part.from, part.to);
			const m = mesh([part.w, s.length - GAP * 2, part.d]);
			m.quaternion.copy(s.quaternion);
			rig.attach(part.joint, m, s.centre);
			continue;
		}
		rig.attach(part.joint, mesh(part.size), part.centre);
		const [cx, cy, cz] = part.centre, [w, h, d] = part.size;
		if (part.head) {
			// Visor band across the eyes and a nose under it: both on the +Z face only.
			rig.attach(part.joint, mesh([w * 0.86, h * 0.2, 0.012], dark), [cx, cy + h * 0.16, cz + d / 2 + 0.004]);
			rig.attach(part.joint, mesh([0.04, 0.06, 0.045], clay), [cx, cy - h * 0.05, cz + d / 2 + 0.02]);
		}
		if (part.foot) rig.attach(part.joint, mesh([w + 0.004, h + 0.004, 0.075], dark), [cx, cy, cz + d / 2 - 0.0355]);
	}
	for (const [joint, size] of KNUCKLES) rig.attach(joint, mesh([size, size, size], dark), restOf(joint));

	return { object3D: rig.object3D, setPose: rig.setPose };
}
