import * as THREE from "three";
import { resolveIkRig } from "../../src/motion/ik.js";
import { solveDragTarget } from "../../src/motion/ik-drag.js";

/* A Pose mode drag (domains/motion.js ikSolve) solves a hand or foot chain toward its handle with solveDragTarget, and
 * the key a drag leaves is that solved pose. One solve must put the effector on a reachable handle from a BENT limb, in
 * the world, for every limb, whatever the character's placement and turn. Measured on an installed take before this:
 * a hand asked up 0.2 m moved 0.31-0.46 m (15-18 cm off the handle) because the drag used a hinge that lands short. */

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else { failures += 1; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

/* Mixamo-spelled T-pose rig (cm, scaled 0.01), placed and turned the way the Studio stands a cast member: a group at
 * (0.4, 0, 1.5) turned 180 degrees about Y. */
function makeRig() {
	const place = new THREE.Group();
	place.position.set(0.4, 0, 1.5);
	place.rotation.y = Math.PI;
	const rig = new THREE.Object3D();
	rig.scale.setScalar(0.01);
	place.add(rig);
	const mk = (name, parent, x, y, z) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); parent.add(b); return b; };
	const hips = mk("mixamorigHips", rig, 0, 100, 0);
	const spine = mk("mixamorigSpine", hips, 0, 15, 0);
	const chest = mk("mixamorigSpine1", spine, 0, 15, 0);
	mk("mixamorigSpine2", chest, 0, 15, 0);
	const neck = mk("mixamorigNeck", chest, 0, 30, 0);
	const head = mk("mixamorigHead", neck, 0, 15, 0);
	mk("mixamorigHeadTop_End", head, 0, 20, 0);
	for (const [side, s] of [["Left", 1], ["Right", -1]]) {
		const shoulder = mk(`mixamorig${side}Shoulder`, chest, 10 * s, 25, 0);
		const arm = mk(`mixamorig${side}Arm`, shoulder, 10 * s, -10, 0);
		const fore = mk(`mixamorig${side}ForeArm`, arm, 28 * s, 0, 0);
		mk(`mixamorig${side}Hand`, fore, 28 * s, 0, 0);
		const up = mk(`mixamorig${side}UpLeg`, hips, 10 * s, 0, 0);
		const leg = mk(`mixamorig${side}Leg`, up, 0, -45, 0);
		const foot = mk(`mixamorig${side}Foot`, leg, 0, -45, 0);
		mk(`mixamorig${side}ToeBase`, foot, 0, -5, 12);
	}
	place.updateMatrixWorld(true);
	return { place, rig };
}

const { place, rig } = makeRig();
const { chains } = resolveIkRig(rig);
const v = () => new THREE.Vector3();
const q = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
/** Bent limb poses (local rotations of b0 and b1), the kind a take holds at different frames. */
const POSES = [
	[q(0.2, 0.3, 0.9), q(0, -1.1, 0)],
	[q(-0.4, 0.1, -0.3), q(0.2, 0.6, 0.1)],
	[q(0.1, -0.5, 0.2), q(0.9, 0, 0)],
	[q(0.6, 0.2, 0.1), q(-0.3, 0.2, 0.5)],
	[q(-0.2, 0.7, -0.5), q(0, 0, -0.8)],
];
const OFFSETS = [[0, 0.2, 0], [0, -0.1, 0.12], [0.15, 0, -0.1], [0, 0.1, 0], [0.05, 0.05, 0.05], [-0.08, 0, 0.06], [0, 0, 0.9]];

for (const [id, chain] of chains) {
	const [b0, b1, b2] = chain.bones;
	const reach = chain.lengths[0] + chain.lengths[1];
	let worst = 0, cases = 0, stretched = 0, far = 0;
	for (const [r0, r1] of POSES) {
		for (const offset of OFFSETS) {
			b0.quaternion.copy(r0); b1.quaternion.copy(r1); place.updateMatrixWorld(true);
			const root = b0.getWorldPosition(v()), target = b2.getWorldPosition(v()).add(new THREE.Vector3(...offset));
			solveDragTarget("chain", chain, target);
			place.updateMatrixWorld(true);
			const hand = b2.getWorldPosition(v());
			const d = root.distanceTo(target);
			if (d > Math.abs(chain.lengths[0] - chain.lengths[1]) + 0.01 && d < reach - 0.01) { worst = Math.max(worst, hand.distanceTo(target)); cases += 1; }
			else if (d > reach) {
				// out of reach: the limb stretches straight at the handle, as far as it goes
				const along = target.clone().sub(root).normalize(), got = hand.clone().sub(root);
				far += 1;
				if (Math.abs(got.length() - reach) < 1e-3 && got.normalize().dot(along) > 0.9999) stretched += 1;
			}
		}
	}
	check(`${id}: one drag solve lands on every reachable handle (${cases} cases, < 2 mm)`, cases >= 10 && worst < 0.002, `worst ${(worst * 1000).toFixed(1)} mm over ${cases}`);
	check(`${id}: an unreachable handle stretches the limb straight at it`, far >= 5 && stretched === far, `${stretched} of ${far} stretched`);
}

if (failures) { console.log(`${failures} FAIL`); process.exit(1); }
console.log("all PASS");
