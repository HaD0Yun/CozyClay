// Lying down in Pose mode: the hips' rotation rings turn the whole body (feet with it, solveSwingAngle on the hips),
// and a body drag plants only the feet under the body (ikPlantFeet). A foot level with the hips, as on a body turned
// to lie down, follows the hips down to the floor instead of folding the leg; a foot on the floor or on a table stays.
// Lowered with Body contact, a body on its side rests on its shoulder (solveHipsTranslateToFloor's contactRadii).
import * as THREE from "three";
import { resolveIkRig, createIkState, solveSwingAngle, solveHipsTranslate, solveHipsTranslateToFloor, ikPlantFeet, ikSolvePlantedFeet } from "../../src/motion/ik.js";

let failures = 0;
const check = (name, cond, detail = "") => { if (cond) console.log(`PASS ${name}`); else { failures += 1; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); } };

/* The same synthetic Mixamo-spelled T-pose rig as verify-ik.mjs: hips 1.0 m up, ankles 0.10 m up, legs 0.9 m. */
function makeRig() {
	const rig = new THREE.Object3D();
	rig.scale.setScalar(0.01);
	const mk = (name, parent, x, y, z) => {
		const b = new THREE.Bone();
		b.name = name;
		b.position.set(x, y, z);
		parent.add(b);
		return b;
	};
	const hips = mk("mixamorigHips", rig, 0, 100, 0);
	const spine = mk("mixamorigSpine", hips, 0, 15, 0);
	const chest = mk("mixamorigSpine1", spine, 0, 15, 0);
	mk("mixamorigSpine2", chest, 0, 15, 0);
	const neck = mk("mixamorigNeck", chest, 0, 30, 0);
	const head = mk("mixamorigHead", neck, 0, 15, 0);
	mk("mixamorigHeadTop_End", head, 0, 20, 0);
	const lShoulder = mk("mixamorigLeftShoulder", chest, 10, 25, 0);
	const rShoulder = mk("mixamorigRightShoulder", chest, -10, 25, 0);
	const lArm = mk("mixamorigLeftArm", lShoulder, 10, -10, 0);
	const lFore = mk("mixamorigLeftForeArm", lArm, 30, 0, 0);
	mk("mixamorigLeftHand", lFore, 30, 0, 0);
	const rArm = mk("mixamorigRightArm", rShoulder, -10, -10, 0);
	const rFore = mk("mixamorigRightForeArm", rArm, -30, 0, 0);
	mk("mixamorigRightHand", rFore, -30, 0, 0);
	const lUp = mk("mixamorigLeftUpLeg", hips, 10, 0, 0);
	const lLeg = mk("mixamorigLeftLeg", lUp, 0, -45, 0);
	const lFoot = mk("mixamorigLeftFoot", lLeg, 0, -45, 0);
	mk("mixamorigLeftToeBase", lFoot, 0, -5, 12);
	const rUp = mk("mixamorigRightUpLeg", hips, -10, 0, 0);
	const rLeg = mk("mixamorigRightLeg", rUp, 0, -45, 0);
	const rFoot = mk("mixamorigRightFoot", rLeg, 0, -45, 0);
	mk("mixamorigRightToeBase", rFoot, 0, -5, 12);
	rig.updateMatrixWorld(true);
	return rig;
}

const v = () => new THREE.Vector3();
const fresh = () => { const rig = makeRig(); const { chains, fkJoints } = resolveIkRig(rig); const ik = createIkState(); ik.chains = chains; return { chains, hips: fkJoints.get("hips"), ik }; };
const ankle = (chains, id) => chains.get(id).bones[2].getWorldPosition(v());
const turn = (hips, deg) => solveSwingAngle(hips, new THREE.Vector3(1, 0, 0), deg * Math.PI / 180, hips.bone.quaternion.clone(), hips.bone.parent.getWorldQuaternion(new THREE.Quaternion()));

{
	const { chains, hips, ik } = fresh();
	ikPlantFeet(chains, ik);
	check("standing: both feet on the floor plant", ik.plants.has("leftFoot") && ik.plants.has("rightFoot"));
	turn(hips, -90);
	const turned = ankle(chains, "leftFoot"), hipY = hips.bone.getWorldPosition(v()).y;
	check("the hips ring turns the whole body: the feet come up level with the hips", Math.abs(turned.y - hipY) < 0.02, `ankle ${turned.y.toFixed(3)} hips ${hipY.toFixed(3)}`);
	ikPlantFeet(chains, ik);
	check("turned to lie: no foot plants (and the earlier plants are dropped)", ik.plants.size === 0, JSON.stringify([...ik.plants.keys()]));
	const start = hips.bone.position.clone(), legBefore = chains.get("leftFoot").bones[1].quaternion.clone();
	solveHipsTranslate(hips, new THREE.Vector3(0, -0.85, 0), start);
	ikSolvePlantedFeet(chains, ik);
	const lying = ankle(chains, "leftFoot");
	check("lowered to the floor: the feet come down with the hips", lying.y < 0.2 && Math.abs(lying.y - hips.bone.getWorldPosition(v()).y) < 0.02, `ankle ${lying.y.toFixed(3)}`);
	check("and the legs stay straight (no folded knee)", chains.get("leftFoot").bones[1].quaternion.angleTo(legBefore) < 1e-9);
}
{
	const { chains, hips, ik } = fresh();
	solveHipsTranslate(hips, new THREE.Vector3(0, 0.8, 0), hips.bone.position.clone());
	ikPlantFeet(chains, ik);
	check("standing on a table (ankles 0.9 m up, half a leg under the hips): both feet plant", ik.plants.size === 2, `ankle ${ankle(chains, "leftFoot").y.toFixed(3)}`);
}
{
	const { chains, hips, ik } = fresh();
	ikPlantFeet(chains, ik);
	solveHipsTranslate(hips, new THREE.Vector3(0, -0.4, 0), hips.bone.position.clone());
	ikSolvePlantedFeet(chains, ik);
	ik.plants.clear();
	ikPlantFeet(chains, ik); // the next drag starts from the squat
	check("squatting (hips lowered, feet on the floor): both feet still plant", ik.plants.size === 2 && Math.abs(ik.plants.get("leftFoot").y - 0.1) < 1e-3, JSON.stringify([...ik.plants.values()].map((p) => p.y.toFixed(3))));
}
{
	const { chains, hips } = fresh();
	const shoulder = () => { let hit = null; hips.bone.traverse((n) => { if (!hit && n.name.endsWith("LeftArm")) hit = n; }); return hit.getWorldPosition(v()).y; };
	solveSwingAngle(hips, new THREE.Vector3(0, 0, 1), -Math.PI / 2, hips.bone.quaternion.clone(), hips.bone.parent.getWorldQuaternion(new THREE.Quaternion()));
	const start = hips.bone.position.clone();
	solveHipsTranslateToFloor(hips, new THREE.Vector3(0, -1.2, 0), start, 0, { Hips: 0.1 });
	const sunk = shoulder();
	solveHipsTranslateToFloor(hips, new THREE.Vector3(0, -1.2, 0), start, 0, { Hips: 0.1 }, { LeftArm: 0.05, RightArm: 0.05, LeftUpLeg: 0.08, RightUpLeg: 0.08 });
	check("on its side, the pelvis alone lets the lower shoulder sink through the floor", sunk < 0, `shoulder ${sunk.toFixed(3)}`);
	check("with the measured radii the body rests on that shoulder (its radius above the floor)", Math.abs(shoulder() - 0.05) < 1e-6 && hips.bone.getWorldPosition(v()).y >= 0.1 - 1e-6, `shoulder ${shoulder().toFixed(3)} hips ${hips.bone.getWorldPosition(v()).y.toFixed(3)}`);
	void chains;
}
if (failures) { console.error(`${failures} lie-down check(s) failed`); process.exit(1); }
console.log("all PASS lie-down");
