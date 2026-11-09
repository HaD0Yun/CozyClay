import * as THREE from "three";
import {
	resolveIkRig,
	createIkState,
	ikSeedTargets,
	ikSnapshot,
	ikRestore,
	ikTouch,
	ikBakeKeyframe,
	ikRemoveKeyframe,
	ikKeyframes,
	ikEvaluate,
	solveIk,
	solveMidJoint,
	solveSwingAngle,
	solveEffectorSwing,
	solveHipsTranslate,
	solveHipsTranslateToFloor,
	ikPlantFeet,
	ikSolvePlantedFeet,
	applyBodyContact,
	clampIkTargetToFloor,
	measureContactRadii,
	bindWorldPosition,
	restWorldPosition,
	IK_TRACKS,
	MID_TRACKS,
	FK_TRACKS,
	ikControlIsExposed,
} from "../../src/motion/ik.js";
import { primeBindPose, applyPose, POSE_BONES, DEFAULT_POSE } from "../../src/poses.js";

/** app-stage.jsx's REST_BONES: every joint at zero, i.e. the bind pose. */
const REST_ZERO = Object.fromEntries(POSE_BONES.map((bone) => [bone.id, [0, 0, 0]]));

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
	}
}

check(
	"every IK control declares an occlusion allowance",
	[...IK_TRACKS, ...MID_TRACKS, ...FK_TRACKS].every(
		(track) => Number.isFinite(track.visibilityDepth) && track.visibilityDepth > 0
	),
);
check(
	"full-body controls include torso, head, neck, and both shoulders",
	["hips", "spine", "chest", "neck", "head", "leftShoulder", "rightShoulder"]
		.every((id) => FK_TRACKS.some((track) => track.id === id)),
);
check("a control before the first blocker stays exposed", ikControlIsExposed(2, 2.1, 0.1));
check("a shallow under-skin control stays exposed", ikControlIsExposed(2, 1.85, 0.16));
check("a far-side control is hidden", !ikControlIsExposed(2, 1.6, 0.16));

/* Synthetic Mixamo-spelled rig in a T-pose: arms along ±X, legs along -Y,
 * toes forward (+Z) so the character faces +Z. Rig scaled 0.01 (cm → m). */
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

const rig = makeRig();
const resolved = resolveIkRig(rig);
const chains = resolved ? resolved.chains : null;
const fkJoints = resolved ? resolved.fkJoints : null;
check("resolve finds all four chains", !!chains && chains.size === 4);
check("resolve finds the FK swing joints", !!fkJoints && fkJoints.has("neck") && fkJoints.has("head") && fkJoints.has("hips") && fkJoints.size === 7);

const eff = new THREE.Vector3();
const v = () => new THREE.Vector3();
const arm = chains.get("leftHand");
arm.bones[2].getWorldPosition(eff);
const wristStart = eff.clone();
const shoulder = arm.bones[0].getWorldPosition(v());

/* --- ikSeedTargets: handles appear at the effectors, nothing moves ------- */
const ik = createIkState();
ik.chains = chains;
const quatBefore = arm.bones[0].quaternion.clone();
ikSeedTargets(chains, ik);
check("seedTargets places the handle on the effector", ik.targets.get("leftHand").distanceTo(wristStart) < 1e-9);
check("seeding changes no bone", arm.bones[0].quaternion.angleTo(quatBefore) < 1e-12);

/* --- generated positional playback → authored FK chain ------------------- */
// ARDY playback can write each mapped bone's local translation independently.
// IK must use those lengths without resetting the clip to a different body.
arm.bones[0].position.add(new THREE.Vector3(0.04, -0.02, 0.03));
arm.bones[1].position.multiplyScalar(1.35);
arm.bones[2].position.multiplyScalar(0.7);
rig.updateMatrixWorld(true);
const clipLocals = arm.bones.map((bone) => bone.position.clone());
const clipTarget = wristStart.clone().add(new THREE.Vector3(-0.25, 0.3, 0.1));
solveIk(arm, clipTarget);
check(
	"IK solve preserves positional-playback chain translations",
	arm.bones.every((bone, index) => bone.position.equals(clipLocals[index]))
);
check("IK reaches the target using the clip's segment lengths", arm.bones[2].getWorldPosition(v()).distanceTo(clipTarget) < 1e-6);
// The following bind-rig checks still exercise the original 30 cm segments.
arm.bones.forEach((bone, index) => {
	bone.position.copy(arm.bindPositions[index]);
	bone.quaternion.identity();
});
rig.updateMatrixWorld(true);

/* --- direct solve: pull the left wrist up/back, reachable ---------------- */
const target = wristStart.clone().add(new THREE.Vector3(-0.25, 0.3, 0.1));
check("test target is reachable", shoulder.distanceTo(target) < 0.58, `reach=${shoulder.distanceTo(target).toFixed(3)}`);
solveIk(arm, target);
arm.bones[2].getWorldPosition(eff);
check("IK reaches a bent target within 2 cm", eff.distanceTo(target) < 0.02, `err=${eff.distanceTo(target).toFixed(4)}`);

const p = [v(), v(), v()];
arm.bones[0].getWorldPosition(p[0]);
arm.bones[1].getWorldPosition(p[1]);
arm.bones[2].getWorldPosition(p[2]);
const lenErr = Math.abs(p[0].distanceTo(p[1]) - 0.3) + Math.abs(p[1].distanceTo(p[2]) - 0.3);
check("IK preserves segment lengths", lenErr < 1e-6, `err=${lenErr.toExponential(2)}`);
check("straight chain falls back to pole (elbow backward)", p[1].z < p[0].z - 0.02, `elbowZ=${p[1].z.toFixed(3)}`);

/* --- unreachable: stretch straight to full length ------------------------ */
const far = wristStart.clone().add(new THREE.Vector3(2, 0, 0));
solveIk(arm, far);
arm.bones[2].getWorldPosition(eff);
const reachDir = far.clone().sub(shoulder).normalize();
const fullReach = shoulder.clone().addScaledVector(reachDir, 0.6 - 1e-6);
check("unreachable target stretches to full length, no NaN", Number.isFinite(eff.x) && eff.distanceTo(fullReach) < 0.02, `err=${eff.distanceTo(fullReach).toFixed(4)}`);

/* --- soft maximum-extension clamp (Holden's TwoBoneInverseKinematics) ----- */
// A capped far target must land inside [cap − softening, cap]: the exponential
// saturation approaches the cap asymptotically and never crosses it, so a
// locked foot cannot straighten the leg past the cap. The three-bone arm is
// the same chain the reach checks above use; lengths are 0.3 + 0.3 m.
const softening = 0.01;
const l0l1 = arm.lengths[0] + arm.lengths[1];
const maxExtension = 0.8 * l0l1;
solveIk(arm, far, { maxExtension });
arm.bones[2].getWorldPosition(eff);
const cappedReach = shoulder.distanceTo(eff);
check(
	"maxExtension softly caps the far reach",
	cappedReach <= maxExtension + 1e-6 && cappedReach >= maxExtension - softening - 1e-6,
	`reach=${cappedReach.toFixed(5)} cap=${maxExtension.toFixed(3)}`,
);
check(
	"without maxExtension the far reach is the old full-length reach",
	(() => {
		solveIk(arm, far);
		arm.bones[2].getWorldPosition(eff);
		return Math.abs(shoulder.distanceTo(eff) - l0l1) < 1e-5;
	})(),
	`reach=${shoulder.distanceTo(eff).toFixed(6)} l0+l1=${l0l1}`,
);
// A target well inside the soft zone must be reached exactly — the clamp is
// invisible for ordinary reachable targets, only saturating past the cap.
const inner = shoulder.clone().addScaledVector(new THREE.Vector3(0.2, 0.5, -0.3).normalize(), 0.5 * maxExtension);
solveIk(arm, inner, { maxExtension });
arm.bones[2].getWorldPosition(eff);
check("maxExtension is inactive inside the soft zone", eff.distanceTo(inner) < 1e-6, `err=${eff.distanceTo(inner).toExponential(2)}`);
// Monotonicity: a farther over-cap target never pulls the effector BACK
// toward the root — saturation is non-decreasing in d and both stay ≤ cap.
// Each solve starts from a STRAIGHT chain (bind rotations): continuing a bent
// elbow whose offset is nearly parallel to the new target line degrades the
// one-step aim by up to ~1 cm of pre-existing slop, which would measure the
// solver, not the clamp.
const straighten = () => {
	arm.bones[0].quaternion.identity();
	arm.bones[1].quaternion.identity();
	rig.updateMatrixWorld(true);
};
straighten();
const monoA = shoulder.clone().addScaledVector(reachDir, maxExtension + 0.05);
solveIk(arm, monoA, { maxExtension });
arm.bones[2].getWorldPosition(eff);
const reachA = shoulder.distanceTo(eff);
straighten();
const monoB = shoulder.clone().addScaledVector(reachDir, maxExtension + 0.30);
solveIk(arm, monoB, { maxExtension });
arm.bones[2].getWorldPosition(eff);
const reachB = shoulder.distanceTo(eff);
check(
	"maxExtension clamp is monotone in target distance",
	reachB >= reachA && reachA <= maxExtension && reachB <= maxExtension,
	`reachA=${reachA.toFixed(5)} reachB=${reachB.toFixed(5)} cap=${maxExtension.toFixed(3)}`,
);

/* --- continuity: drag across the bone line, elbow keeps its side --------- */
// reset to bind, bend once (pole → elbow backward), then sweep the target
// across the bone line; the elbow must NOT mirror-flip (z stays negative)
arm.bones[0].quaternion.identity();
arm.bones[1].quaternion.identity();
rig.updateMatrixWorld(true);
solveIk(arm, target); // bend once, elbow z<0
let maxFlip = 0;
let prevElbowZ = null;
for (let i = 0; i <= 20; i += 1) {
	const sweep = target.clone().lerp(wristStart.clone().add(new THREE.Vector3(-0.2, -0.1, -0.05)), i / 20);
	solveIk(arm, sweep);
	const ez = arm.bones[1].getWorldPosition(v()).z;
	if (prevElbowZ !== null) maxFlip = Math.max(maxFlip, Math.abs(ez - prevElbowZ));
	if (i === 20) check("elbow stays on its own side through the sweep", ez < -0.005, `elbowZ=${ez.toFixed(4)}`);
	prevElbowZ = ez;
}
check("no elbow flip jump through the sweep", maxFlip < 0.15, `maxStep=${maxFlip.toFixed(4)}`);

/* --- quat keys: bake stores b0/b1 local rotations, sparse ---------------- */
solveIk(arm, target);
ikTouch(ik, "leftHand");
ikBakeKeyframe(chains, ik, 10, fkJoints);
const q10b0 = arm.bones[0].quaternion.clone();
solveIk(arm, wristStart);
ikBakeKeyframe(chains, ik, 30, fkJoints);
const q30b0 = arm.bones[0].quaternion.clone();
check("key frames sorted", JSON.stringify(ikKeyframes(ik)) === JSON.stringify([10, 30]));
check("key stores only the tracked chain", ik.keys.get(10).has("leftHand") && !ik.keys.get(10).has("rightHand"));
const sameQ = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) + Math.abs(a.w - b.w) < 1e-12;
check("key stores b0/b1/b2 local quats", ik.keys.get(10).get("leftHand").q.length === 3 && sameQ(ik.keys.get(10).get("leftHand").q[0], q10b0));

/* --- slerp evaluation: f20 = exact midpoint of the two keys -------------- */
arm.bones[0].quaternion.identity();
arm.bones[1].quaternion.identity();
arm.bones[0].position.add(new THREE.Vector3(0.03, 0.01, -0.02));
arm.bones[1].position.multiplyScalar(1.2);
arm.bones[2].position.multiplyScalar(0.8);
rig.updateMatrixWorld(true);
ikEvaluate(chains, ik, 20, fkJoints);
const expect = q10b0.clone().slerp(q30b0, 0.5);
const deg = (a, b) => (a.angleTo(b) * 180) / Math.PI;
check("f20 bone rotation is the slerp midpoint (<0.5°)", deg(arm.bones[0].quaternion, expect) < 0.5, `err=${deg(arm.bones[0].quaternion, expect).toFixed(4)}°`);
check(
	"IK evaluation restores positional-playback chain translations to bind",
	arm.bones.every((bone, index) => bone.position.distanceTo(arm.bindPositions[index]) < 1e-9)
);

/* untracked chain untouched by evaluate */
const rArm = chains.get("rightHand").bones[0];
const rQ = rArm.quaternion.clone();
ikEvaluate(chains, ik, 20, fkJoints);
check("untracked chain is never written by evaluate", rArm.quaternion.angleTo(rQ) < 1e-12);

/* keys are position-independent: no re-anchor needed (local rotations) */
rig.position.x += 0.5; // character moved
rig.updateMatrixWorld(true);
ikEvaluate(chains, ik, 10, fkJoints);
check("moved character keeps the keyed local rotations", deg(arm.bones[0].quaternion, q10b0) < 0.5, `err=${deg(arm.bones[0].quaternion, q10b0).toFixed(4)}°`);
rig.position.x -= 0.5;
rig.updateMatrixWorld(true);

/* --- snapshot / restore --------------------------------------------------- */
const snap = ikSnapshot(chains, fkJoints);
solveIk(arm, wristStart.clone().add(new THREE.Vector3(0, 0.3, 0)));
ikRestore(chains, snap, fkJoints);
check("restore returns the chain to the snapshot", sameQ(arm.bones[0].quaternion, snap.get("leftHand").quats[0]));

ikRemoveKeyframe(ik, 10);
check("removeKeyframe drops the frame", JSON.stringify(ikKeyframes(ik)) === JSON.stringify([30]));

/* --- mid-joint drag: elbow moves freely even on a STRAIGHT chain --------- */
// THE fix: a straight chain has zero elbow freedom in both-ends-pinned
// models; the sphere-clamp reposition works regardless.
arm.bones[0].quaternion.identity();
arm.bones[1].quaternion.identity();
rig.updateMatrixWorld(true);
const elbowStart = arm.bones[1].getWorldPosition(v());
const foreDirStart = arm.bones[2].getWorldPosition(v()).sub(elbowStart).normalize();
const midTarget = elbowStart.clone().add(new THREE.Vector3(-0.06, 0.12, -0.05));
const clamped = solveMidJoint(arm, midTarget);
const elbowAfter = arm.bones[1].getWorldPosition(v());
check("mid-joint drag moves the elbow on a STRAIGHT chain (> 5 cm)", elbowAfter.distanceTo(elbowStart) > 0.05, `moved=${elbowAfter.distanceTo(elbowStart).toFixed(4)}`);
check("mid-joint drag lands the elbow on the clamped point", elbowAfter.distanceTo(clamped) < 1e-6);
check("clamped point sits on the root sphere (|p0→p1| = l0)", Math.abs(arm.bones[0].getWorldPosition(v()).distanceTo(elbowAfter) - 0.3) < 1e-6);
// forearm keeps its world direction: the wrist follows, parallel to before
const foreDirAfter = arm.bones[2].getWorldPosition(v()).sub(elbowAfter).normalize();
check("mid-joint drag keeps the forearm direction", foreDirAfter.dot(foreDirStart) > 0.999, `dot=${foreDirAfter.dot(foreDirStart).toFixed(4)}`);
check("mid-joint drag preserves segment lengths", Math.abs(elbowAfter.distanceTo(arm.bones[2].getWorldPosition(v())) - 0.3) < 1e-6);

/* far mid drag: clamps radially, no NaN */
const farMid = elbowStart.clone().add(new THREE.Vector3(2, 2, 2));
const clampedFar = solveMidJoint(arm, farMid);
const elbowFar = arm.bones[1].getWorldPosition(v());
check("far mid-joint drag clamps, no NaN", Number.isFinite(elbowFar.x) && elbowFar.distanceTo(clampedFar) < 1e-6);
check("far mid-joint drag keeps lengths", Math.abs(arm.bones[0].getWorldPosition(v()).distanceTo(elbowFar) - 0.3) < 1e-6);

/* --- measured mesh contact radii ----------------------------------------- */
const radiusRig = new THREE.Object3D();
const radiusHips = new THREE.Bone();
radiusHips.name = "mixamorigHips";
const radiusSpine = new THREE.Bone();
radiusSpine.name = "mixamorigSpine";
radiusSpine.position.y = 0.2;
radiusHips.add(radiusSpine);
radiusRig.add(radiusHips);
const radiusGeometry = new THREE.BufferGeometry();
radiusGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
	0, 0, 0,
	0.03, 0, 0,
], 3));
radiusGeometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0], 4));
radiusGeometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0], 4));
const radiusMesh = new THREE.SkinnedMesh(radiusGeometry, new THREE.MeshBasicMaterial());
radiusMesh.name = "radiusMesh";
radiusRig.add(radiusMesh);
radiusMesh.bind(new THREE.Skeleton([radiusHips, radiusSpine]));
radiusRig.updateMatrixWorld(true);
const measured = measureContactRadii(radiusRig);
check("mesh contact radii are measured and clamped to the sane range", measured.Hips >= 0.029 && measured.Hips <= 0.25, `hipsRadius=${measured.Hips}`);
check("missing contact bones fall back to a small measured default", measured.LeftHand >= 0.01 && measured.LeftHand <= 0.03, `handRadius=${measured.LeftHand}`);

/* --- floor-only body contact: deterministic, stateless geometric pass ---- */
const contactRig = makeRig();
const contactResolved = resolveIkRig(contactRig);
const contactChains = contactResolved.chains;
const contactFkJoints = contactResolved.fkJoints;
const contactArm = contactChains.get("leftHand");
const contactWrist = contactArm.bones[2].getWorldPosition(v());
solveIk(contactArm, contactWrist.clone().setY(-0.18));
applyBodyContact(contactChains, contactFkJoints);
const contactHand = contactArm.bones[2].getWorldPosition(v());
check(
	"body contact lifts a hand below the floor to its marker radius",
	contactHand.y >= contactResolved.contactRadii.LeftHand - 1e-5,
	`handY=${contactHand.y.toFixed(4)}`,
);

const untouchedRig = makeRig();
const untouchedResolved = resolveIkRig(untouchedRig);
const untouchedHand = untouchedResolved.chains.get("leftHand").bones[2];
const untouchedHips = untouchedResolved.fkJoints.get("hips").bone;
const handBeforeContact = untouchedHand.getWorldPosition(v());
const hipsBeforeContact = untouchedHips.position.clone();
check("body contact is a zero-cost no-op above the floor", !applyBodyContact(untouchedResolved.chains, untouchedResolved.fkJoints));
check("body contact leaves an above-floor hand untouched", untouchedHand.getWorldPosition(v()).distanceTo(handBeforeContact) < 1e-9);
check("body contact leaves above-floor hips untouched", untouchedHips.position.distanceTo(hipsBeforeContact) < 1e-9);

const hipsRig = makeRig();
const hipsResolved = resolveIkRig(hipsRig);
const hipsBone = hipsResolved.fkJoints.get("hips").bone;
const hipsStart = hipsBone.position.clone();
solveHipsTranslateToFloor(hipsResolved.fkJoints.get("hips"), new THREE.Vector3(0, -2, 0), hipsStart, 0, hipsResolved.contactHeights);
check(
	"hips drag clamps the pelvis contact height",
	hipsBone.getWorldPosition(v()).y >= hipsResolved.contactHeights.Hips - 1e-5,
	`hipsY=${hipsBone.getWorldPosition(v()).y.toFixed(4)}`,
);
const dragBelowFloor = clampIkTargetToFloor("leftHand", new THREE.Vector3(1, -2, 3), 0, contactResolved.contactHeights);
check("drag targets clamp at the measured hand floor height", dragBelowFloor.y === contactResolved.contactHeights.LeftHand);
const holdRig = makeRig();
const holdResolved = resolveIkRig(holdRig);
const holdArm = holdResolved.chains.get("leftHand");
solveIk(holdArm, holdArm.bones[2].getWorldPosition(v()).setY(-1));
applyBodyContact(holdResolved.chains, holdResolved.fkJoints, 0, { skipFeet: true });
check("drag-time chain hold keeps a hand above its contact height", holdArm.bones[2].getWorldPosition(v()).y >= holdResolved.contactHeights.LeftHand - 1e-5);

/* --- FK swing as trackball rotation: exact angle, exact axis -------------- */
const neck = fkJoints.get("neck");
const headBone = fkJoints.get("head").bone;
const neckOrigin = neck.bone.getWorldPosition(v());
const startQuat = neck.bone.quaternion.clone();
const startParentQuat = neck.bone.parent.getWorldQuaternion(new THREE.Quaternion());
const axis = new THREE.Vector3(0, 0, 1); // rotate about world Z
const angle = 0.5;
solveSwingAngle(neck, axis, angle, startQuat, startParentQuat);
// the applied rotation must be EXACTLY `angle` about `axis` from the start
const appliedDelta = startParentQuat.clone().multiply(neck.bone.quaternion);
const expectedDelta = new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(startParentQuat.clone().multiply(startQuat));
check("FK swing applies the exact rotation from drag start", deg(appliedDelta, expectedDelta) < 0.01, `err=${deg(appliedDelta, expectedDelta).toFixed(5)}°`);
// repeated application from the same start state does NOT compound
solveSwingAngle(neck, axis, angle, startQuat, startParentQuat);
check("FK swing is absolute, never compounds", deg(appliedDelta.clone().copy(startParentQuat).multiply(neck.bone.quaternion), expectedDelta) < 0.01);
check("FK swing does not translate the joint", neck.bone.getWorldPosition(v()).distanceTo(neckOrigin) < 1e-9);
// the head sits 0.15 m above the neck; a 0.5 rad rotation swings it ~7 cm
const headStartPos = new THREE.Vector3(0, 1.75, 0);
const headMovedSwing = headBone.getWorldPosition(v()).distanceTo(headStartPos);
check("FK swing visibly moves the head", headMovedSwing > 0.05 && headMovedSwing < 0.2, `d=${headMovedSwing.toFixed(3)}`);

for (const id of ["spine", "chest", "neck", "head", "leftShoulder", "rightShoulder"]) {
	const joint = fkJoints.get(id);
	const start = joint.bone.quaternion.clone();
	const parentWorld = joint.bone.parent.getWorldQuaternion(new THREE.Quaternion());
	solveSwingAngle(joint, new THREE.Vector3(0, 0, 1), 0.2, start, parentWorld);
	check(`${id} control changes its joint rotation`, joint.bone.quaternion.angleTo(start) > 0.05);
	joint.bone.quaternion.copy(start);
	rig.updateMatrixWorld(true);
}

/* --- FK keys: touch fk, bake, slerp evaluate ------------------------------ */
const ik2 = createIkState();
ik2.chains = chains;
solveSwingAngle(neck, axis, angle, neck.bone.quaternion.clone(), startParentQuat);
const neckQ1 = neck.bone.quaternion.clone();
ikTouch(ik2, "neck");
ikBakeKeyframe(chains, ik2, 10, fkJoints);
neck.bone.quaternion.identity();
rig.updateMatrixWorld(true);
ikBakeKeyframe(chains, ik2, 30, fkJoints);
const neckQ2 = neck.bone.quaternion.clone();
neck.bone.quaternion.identity();
rig.updateMatrixWorld(true);
ikEvaluate(chains, ik2, 20, fkJoints);
const expectNeck = neckQ1.clone().slerp(neckQ2, 0.5);
check("FK key slerp midpoint (<0.5°)", deg(neck.bone.quaternion, expectNeck) < 0.5, `err=${deg(neck.bone.quaternion, expectNeck).toFixed(4)}°`);

/* FK snapshot/restore */
const snap2 = ikSnapshot(chains, fkJoints);
solveSwingAngle(neck, new THREE.Vector3(1, 0, 0), 0.3, neck.bone.quaternion.clone(), startParentQuat);
ikRestore(chains, snap2, fkJoints);
check("FK restore returns the joint to the snapshot", sameQ(neck.bone.quaternion, snap2.get("neck").quats[0]));

/* --- body root: hips translate = crouch/lean, keys carry the position ----- */
const hips = fkJoints.get("hips");
const hipsWorldBefore = hips.bone.getWorldPosition(v()).clone();
const hipsLocalBefore = hips.bone.position.clone();
check("hips joint carries its bind local position", !!hips.bindPos && hips.bindPos.distanceTo(hipsLocalBefore) < 1e-9);
solveHipsTranslate(hips, new THREE.Vector3(0, -0.4, 0), hips.bindPos.clone()); // crouch 40 cm
const hipsWorldAfter = hips.bone.getWorldPosition(v());
check("hips translate lowers the body 0.4 m in world", Math.abs(hipsWorldBefore.y - hipsWorldAfter.y - 0.4) < 1e-3, `dy=${(hipsWorldBefore.y - hipsWorldAfter.y).toFixed(4)}`);
check("hips translate converted through the cm scale (local Δ = 40 cm)", Math.abs(hipsLocalBefore.y - hips.bone.position.y - 40) < 1e-3, `dy_local=${(hipsLocalBefore.y - hips.bone.position.y).toFixed(3)}`);
// the whole skeleton follows: the head sinks by the same 0.4 m as the hips
const headDropBefore = fkJoints.get("head").bone.getWorldPosition(v()).y;
solveHipsTranslate(hips, new THREE.Vector3(0, -0.4, 0), hips.bone.position.clone());
const headDropAfter = fkJoints.get("head").bone.getWorldPosition(v()).y;
check("hips translate moves the whole skeleton with it", Math.abs(headDropBefore - headDropAfter - 0.4) < 1e-3, `headDy=${(headDropBefore - headDropAfter).toFixed(4)}`);
solveHipsTranslate(hips, new THREE.Vector3(0, 0.4, 0), hips.bone.position.clone());

// yaw conversion: rotate the rig 90° about Y, world +X delta maps to local Z
rig.rotation.y = Math.PI / 2;
rig.updateMatrixWorld(true);
const before2 = hips.bone.position.clone();
solveHipsTranslate(hips, new THREE.Vector3(0.2, 0, 0), before2.clone());
check("hips translate converts world delta through parent yaw", Math.abs(Math.abs(hips.bone.position.z - before2.z) - 20) < 1e-2 && Math.abs(hips.bone.position.x - before2.x) < 1e-2, `localΔ=(${(hips.bone.position.x - before2.x).toFixed(2)},${(hips.bone.position.z - before2.z).toFixed(2)})`);
rig.rotation.y = 0;
rig.updateMatrixWorld(true);

// keys carry the hips local position; evaluation lerps it
const ik3 = createIkState();
ik3.chains = chains;
hips.bone.position.copy(hips.bindPos);
rig.updateMatrixWorld(true);
ikTouch(ik3, "hips");
ikBakeKeyframe(chains, ik3, 10, fkJoints);
const hipsKeyLow = hips.bone.position.clone();
solveHipsTranslate(hips, new THREE.Vector3(0, -0.4, 0), hips.bone.position.clone());
ikBakeKeyframe(chains, ik3, 30, fkJoints);
const hipsKeyHigh = hips.bone.position.clone();
check("hips key stores the local position", ik3.keys.get(30).get("hips").p && sameQ(ik3.keys.get(30).get("hips").p, hipsKeyHigh) === false && ik3.keys.get(30).get("hips").p.distanceTo(hipsKeyHigh) < 1e-9);
hips.bone.position.copy(hips.bindPos);
rig.updateMatrixWorld(true);
ikEvaluate(chains, ik3, 20, fkJoints);
const expectedHips = hipsKeyLow.clone().lerp(hipsKeyHigh, 0.5);
check("hips position lerps between keys", hips.bone.position.distanceTo(expectedHips) < 1e-6, `err=${hips.bone.position.distanceTo(expectedHips).toExponential(2)}`);

// restore puts the bind position back
const snap3 = ikSnapshot(chains, fkJoints);
solveHipsTranslate(hips, new THREE.Vector3(0, -0.5, 0), hips.bone.position.clone());
ikRestore(chains, snap3, fkJoints);
check("restore returns the hips bind position", hips.bone.position.distanceTo(snap3.get("hips").pos) < 1e-9);

/* --- foot planting: hips drop, ankles stay at their plants ----------------- */
// reset the hips and the left leg to bind
hips.bone.position.copy(hips.bindPos);
const lLeg = chains.get("leftFoot");
lLeg.bones[0].quaternion.identity();
lLeg.bones[1].quaternion.identity();
rig.updateMatrixWorld(true);
const ik4 = createIkState();
ik4.chains = chains;
const anklePlant = lLeg.bones[2].getWorldPosition(v()).clone();
ikPlantFeet(chains, ik4);
check("plantFeet captures both ankle positions", ik4.plants.has("leftFoot") && ik4.plants.has("rightFoot") && ik4.plants.get("leftFoot").distanceTo(anklePlant) < 1e-9);
// drop the hips 0.3 m — the feet would normally follow through the floor
solveHipsTranslate(hips, new THREE.Vector3(0, -0.3, 0), hips.bone.position.clone());
const ankleDropped = lLeg.bones[2].getWorldPosition(v()).clone();
check("without the planted solve the ankle follows the hips down", ankleDropped.y < anklePlant.y - 0.2, `dy=${(ankleDropped.y - anklePlant.y).toFixed(3)}`);
ikSolvePlantedFeet(chains, ik4);
const ankleSolved = lLeg.bones[2].getWorldPosition(v());
check("planted solve returns the ankle to its plant", ankleSolved.distanceTo(anklePlant) < 1e-6, `err=${ankleSolved.distanceTo(anklePlant).toExponential(2)}`);
// the knee must have bent to compensate (it moved off the straight line)
const kneeAfter = lLeg.bones[1].getWorldPosition(v());
const hipAfter = hips.bone.getWorldPosition(v());
const lineT = kneeAfter.clone().sub(hipAfter);
const lineLen = lineT.length();
const toAnkle = ankleSolved.clone().sub(hipAfter).normalize();
const toKnee = lineT.divideScalar(lineLen);
check("the knee bent to keep the foot planted", toKnee.dot(toAnkle) < 0.999, `dot=${toKnee.dot(toAnkle).toFixed(4)}`);
// with no plants captured, the planted solve is a no-op
const ik5 = createIkState();
ik5.chains = chains;
const ankleBeforeNoop = lLeg.bones[2].getWorldPosition(v()).clone();
solveHipsTranslate(hips, new THREE.Vector3(0, -0.1, 0), hips.bone.position.clone());
ikSolvePlantedFeet(chains, ik5);
check("no plants → planted solve does nothing", lLeg.bones[2].getWorldPosition(v()).distanceTo(ankleBeforeNoop) > 0.05);

/* --- effector swing: hand/foot rotation editing -------------------------- */
{
	const chains2 = resolved.chains;
	const lHand = chains2.get("leftHand");
	const handBone = lHand.bones[2];
	const b1Before = lHand.bones[1].quaternion.clone();
	const startQuat = handBone.quaternion.clone();
	const startParentQuat = handBone.parent.getWorldQuaternion(new THREE.Quaternion());
	// 90° twist around world Z, absolute from the start orientation
	solveEffectorSwing(lHand, new THREE.Vector3(0, 0, 1), Math.PI / 2, startQuat, startParentQuat);
	const twisted = handBone.getWorldQuaternion(new THREE.Quaternion());
	const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
		.multiply(startParentQuat.clone().multiply(startQuat));
	check("effector swing twists the hand by the drag angle", twisted.angleTo(expected) < 1e-6, `err=${twisted.angleTo(expected).toExponential(2)}`);
	check("effector swing leaves the forearm alone", lHand.bones[1].quaternion.angleTo(b1Before) < 1e-6);
	check("zero-angle swing is a no-op", (() => {
		const q = handBone.quaternion.clone();
		solveEffectorSwing(lHand, new THREE.Vector3(1, 0, 0), 0, handBone.quaternion.clone(), startParentQuat);
		return handBone.quaternion.angleTo(q) < 1e-6;
	})());

	// the bake now stores the effector quaternion with the chain's, and the
	// evaluation puts it back: twist, bake at frame 7, untwist, evaluate.
	const ik6 = createIkState();
	ik6.chains = chains2;
	ikTouch(ik6, "leftHand");
	ikBakeKeyframe(chains2, ik6, 7, null);
	check("baked chain key stores three quats (b0, b1, b2)", ik6.keys.get(7).get("leftHand").q.length === 3);
	handBone.quaternion.identity();
	handBone.updateMatrixWorld(true);
	ikEvaluate(chains2, ik6, 7, null);
	check("evaluate restores the authored effector rotation", handBone.quaternion.angleTo(ik6.keys.get(7).get("leftHand").q[2]) < 1e-6,
		`err=${handBone.quaternion.angleTo(ik6.keys.get(7).get("leftHand").q[2]).toExponential(2)}`);
	// pre-rotation keys (b0/b1 only) still evaluate without touching b2
	ik6.keys.get(7).get("leftHand").q = ik6.keys.get(7).get("leftHand").q.slice(0, 2);
	const q2 = handBone.quaternion.clone();
	ikEvaluate(chains2, ik6, 7, null);
	check("two-quat legacy keys leave the effector as-is", handBone.quaternion.angleTo(q2) < 1e-6);
}

/* --- REGRESSION (R1/R3): island-aware correction weighting ----------------- */
/* The old rule was "weight 1 everywhere between a track's first and last key",
 * which turned every sparse correction into a whole-clip rewrite: two keys
 * 20 frames apart absolutely-slerped the 19 frames of authored motion between
 * them (on the QA walk, two keys at 129 and 322 pinned a 193-frame slerp and
 * threw an ankle 53.7 cm off the clip). Keys further apart than the blend
 * window are now separate islands with clip in between. */
{
	const islandRig = makeRig();
	const islandResolved = resolveIkRig(islandRig);
	const islandChains = islandResolved.chains;
	const islandJoints = islandResolved.fkJoints;
	const joint = islandJoints.get("neck");
	const BLEND = 6;
	const qA = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.6);
	const qB = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.6);
	const clipQ = new THREE.Quaternion(); // the "motion" under the correction
	const bake = (state, frame, q) => {
		joint.bone.quaternion.copy(q);
		joint.bone.updateMatrixWorld(true);
		ikBakeKeyframe(islandChains, state, frame, islandJoints);
	};
	const evaluateFrom = (state, frame, blend) => {
		joint.bone.quaternion.copy(clipQ);
		joint.bone.updateMatrixWorld(true);
		ikEvaluate(islandChains, state, frame, islandJoints, blend);
		return joint.bone.quaternion.clone();
	};

	const far = createIkState();
	ikTouch(far, "neck");
	bake(far, 0, qA);
	bake(far, 20, qB);
	check("a frame mid-gap between two key islands keeps the clip pose",
		deg(evaluateFrom(far, 10, BLEND), clipQ) < 1e-6,
		`err=${deg(evaluateFrom(far, 10, BLEND), clipQ).toExponential(2)}°`);
	check("a frame one window past an island edge is fully back on the clip",
		deg(evaluateFrom(far, 6, BLEND), clipQ) < 1e-6);
	// Inside the window the ease is unchanged: weight 1 − d/blend from the edge.
	const eased = evaluateFrom(far, 3, BLEND);
	const sampledAt3 = qA.clone().slerp(qB, 3 / 20);
	check("the ease into an island still ramps from its edge key",
		deg(eased, clipQ.clone().slerp(sampledAt3, 1 - 3 / BLEND)) < 0.01,
		`err=${deg(eased, clipQ.clone().slerp(sampledAt3, 1 - 3 / BLEND)).toFixed(4)}°`);
	// Authoring mode (no motion underneath) must keep the old semantics EXACTLY.
	check("authoring mode (blendFrames 0) still holds the whole keyed envelope",
		deg(evaluateFrom(far, 10, 0), qA.clone().slerp(qB, 0.5)) < 0.01,
		`err=${deg(evaluateFrom(far, 10, 0), qA.clone().slerp(qB, 0.5)).toFixed(4)}°`);

	const near = createIkState();
	ikTouch(near, "neck");
	bake(near, 10, qA);
	bake(near, 14, qB);
	check("keys within one blend window are one island (full-weight interpolation)",
		deg(evaluateFrom(near, 12, BLEND), qA.clone().slerp(qB, 0.5)) < 0.01,
		`err=${deg(evaluateFrom(near, 12, BLEND), qA.clone().slerp(qB, 0.5)).toFixed(4)}°`);
	check("a single key is an island of one, easing both ways", (() => {
		const solo = createIkState();
		ikTouch(solo, "neck");
		bake(solo, 10, qA);
		return deg(evaluateFrom(solo, 10, BLEND), qA) < 1e-6
			&& deg(evaluateFrom(solo, 13, BLEND), clipQ.clone().slerp(qA, 0.5)) < 0.01
			&& deg(evaluateFrom(solo, 16, BLEND), clipQ) < 1e-6;
	})());
}

/* --- REGRESSION (R2): the hips blend is a DELTA, not an absolute splice ----- */
/* Easing the hips toward a neighbouring key's ABSOLUTE local position splices
 * that key's height onto the frames around it — a planted toe rose 30 cm
 * because the frame next to a jump key inherited a share of the jump's hips
 * height. A key baked with its clip pose (`basePos`) instead contributes only
 * what the correction changed. */
{
	const deltaRig = makeRig();
	const deltaResolved = resolveIkRig(deltaRig);
	const deltaChains = deltaResolved.chains;
	const deltaJoints = deltaResolved.fkJoints;
	const deltaHips = deltaJoints.get("hips");
	const BLEND = 6;
	// Frame 10 of the clip has the hips here; the correction lifts them 12 cm.
	const clipAt10 = deltaHips.bindPos.clone().add(new THREE.Vector3(0, 0, 0));
	const lift = new THREE.Vector3(0, 12, 0); // bone-local cm (rig scale 0.01)
	const state = createIkState();
	ikTouch(state, "hips");
	deltaHips.bone.position.copy(clipAt10).add(lift);
	deltaHips.bone.updateMatrixWorld(true);
	ikBakeKeyframe(deltaChains, state, 10, deltaJoints, ["hips"], new Map([["hips", clipAt10]]));
	check("the bake records the pose the key was made over",
		state.keys.get(10).get("hips").basePos?.distanceTo(clipAt10) < 1e-9);

	// Frame 10 itself: clipPos + (p − basePos)·1 must be the baked pose exactly.
	deltaHips.bone.position.copy(clipAt10);
	ikEvaluate(deltaChains, state, 10, deltaJoints, BLEND);
	check("the keyed frame reproduces the baked position exactly",
		deltaHips.bone.position.distanceTo(clipAt10.clone().add(lift)) < 1e-9,
		`err=${deltaHips.bone.position.distanceTo(clipAt10.clone().add(lift)).toExponential(2)}`);

	// Frame 12 of the clip is somewhere else entirely (the character walked on).
	const clipAt12 = clipAt10.clone().add(new THREE.Vector3(40, -25, 15));
	const w = 1 - 2 / BLEND;
	deltaHips.bone.position.copy(clipAt12);
	ikEvaluate(deltaChains, state, 12, deltaJoints, BLEND);
	const wantedDelta = clipAt12.clone().addScaledVector(lift, w);
	const wantedAbsolute = clipAt12.clone().lerp(clipAt10.clone().add(lift), w);
	check("an in-window frame gets clip + eased delta",
		deltaHips.bone.position.distanceTo(wantedDelta) < 1e-9,
		`err=${deltaHips.bone.position.distanceTo(wantedDelta).toExponential(2)}`);
	check("an in-window frame is NOT lerped toward the key's absolute position",
		deltaHips.bone.position.distanceTo(wantedAbsolute) > 1,
		`splice=${deltaHips.bone.position.distanceTo(wantedAbsolute).toFixed(3)}`);

	// Keys without a base pose (saved projects, authoring) keep the old blend.
	const legacy = createIkState();
	ikTouch(legacy, "hips");
	deltaHips.bone.position.copy(clipAt10).add(lift);
	ikBakeKeyframe(deltaChains, legacy, 10, deltaJoints);
	deltaHips.bone.position.copy(clipAt12);
	ikEvaluate(deltaChains, legacy, 12, deltaJoints, BLEND);
	check("a key with no base pose still uses the absolute blend",
		deltaHips.bone.position.distanceTo(wantedAbsolute) < 1e-9);
}

/* --- REGRESSION (R4): a bake can name exactly what it wrote ---------------- */
{
	const bakeRig = makeRig();
	const bakeResolved = resolveIkRig(bakeRig);
	const state = createIkState();
	ikTouch(state, "leftHand");
	ikTouch(state, "neck");
	ikBakeKeyframe(bakeResolved.chains, state, 5, bakeResolved.fkJoints);
	check("the default bake still writes the whole tracked set",
		state.keys.get(5).has("leftHand") && state.keys.get(5).has("neck"));
	ikBakeKeyframe(bakeResolved.chains, state, 40, bakeResolved.fkJoints, ["leftFoot"]);
	check("onlyIds bakes exactly the named parts",
		state.keys.get(40).has("leftFoot") && !state.keys.get(40).has("leftHand") && !state.keys.get(40).has("neck"),
		`ids=${[...state.keys.get(40).keys()].join(",")}`);
	check("onlyIds touches its parts into the tracked set", state.tracked.has("leftFoot"));
}

/* --- REGRESSION (R7): contact radii are measured in the BIND pose ---------- */
/* measureContactRadii caches forever off whichever frame calls it first, and
 * ARDY playback rewrites child bone translations per frame — so a first call
 * mid-clip measured its segments against a shortened limb and inflated the
 * radius (+79% at a 30%-shortened child on the probe). Bind-pose endpoints
 * against bind-pose vertices make the answer frame-independent. */
{
	const makeArmRig = () => {
		const rig = new THREE.Object3D();
		const fore = new THREE.Bone();
		fore.name = "mixamorigLeftForeArm";
		const hand = new THREE.Bone();
		hand.name = "mixamorigLeftHand";
		hand.position.set(1, 0, 0);
		fore.add(hand);
		rig.add(fore);
		const positions = [];
		const weights = [];
		for (let i = 0; i < 10; i += 1) {
			positions.push(0.1 * i, 0.05, 0);
			weights.push(1, 0, 0, 0);
		}
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
		geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(40).fill(0), 4));
		geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
		const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
		rig.add(mesh);
		mesh.bind(new THREE.Skeleton([fore, hand]));
		rig.updateMatrixWorld(true);
		primeBindPose(rig); // this untouched pose is the bind, as at clone time
		return { rig, hand };
	};
	const atBind = makeArmRig();
	const bindRadius = measureContactRadii(atBind.rig).LeftForeArm;
	check("the bind measurement finds the mesh's actual radius",
		Math.abs(bindRadius - 0.05) < 1e-6, `r=${bindRadius}`);

	const midClip = makeArmRig();
	midClip.hand.position.set(0.1, 0, 0); // positional skinning, 90% shorter
	midClip.rig.updateMatrixWorld(true);
	const posedRadius = measureContactRadii(midClip.rig).LeftForeArm;
	check("a first measurement taken mid-clip reports the bind-pose radius",
		Math.abs(posedRadius - bindRadius) < 1e-6, `bind=${bindRadius} posed=${posedRadius}`);
}

/* --- REGRESSION (Defect B): chain keys blend as DELTAS, not absolutes ------ */
/* The ±6-frame window used to ease each bone toward the key's ABSOLUTE
 * rotation, so the smear on a clean neighbour was proportional to how far the
 * clip had moved since the keyed frame — the whole stride, six frames into a
 * walk. Browser QA on /demo/walk-then-stop.npz measured unkeyed frames moving
 * up to 197.9 mm for a sub-2 cm fix, a swing-phase foot lift flattened by
 * 95.9 mm, and 14 unkeyed frames finishing with feet under the floor. Storing
 * the clip's own rotations on the key turns the blend into
 * `clipCurrent ∘ slerp(identity, baseQ⁻¹ ∘ q, w)`, whose worst case is the
 * correction itself. */
{
	const BLEND = 6;
	const FIRST_KEY = 129;
	const SECOND_KEY = 141; // 12 apart: two islands, with clip in between
	const RANGE = [120, 150];

	// A fast leg swing — the ankle covers ~30 cm in six frames, which is what
	// makes an absolute blend so destructive — plus per-bone translation
	// wobble, the positional playback ARDY actually writes.
	const swingAt = (frame) => 1.1 * Math.sin((Math.PI * (frame - 120)) / 15);
	const buildTake = () => {
		const takeRig = makeRig();
		const resolvedTake = resolveIkRig(takeRig);
		const leg = resolvedTake.chains.get("leftFoot");
		const poseClip = (frame) => {
			const wobble = 1 + 0.005 * Math.sin(frame * 0.7);
			leg.bones.forEach((bone, index) => {
				bone.position.copy(leg.bindPositions[index]).multiplyScalar(wobble);
				bone.quaternion.identity();
			});
			leg.bones[0].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), swingAt(frame));
			leg.bones[1].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.5 * Math.abs(swingAt(frame)));
			takeRig.updateMatrixWorld(true);
		};
		return { rig: takeRig, chains: resolvedTake.chains, fkJoints: resolvedTake.fkJoints, leg, poseClip };
	};

	// The pristine clip every unkeyed frame must still reproduce.
	const reference = buildTake();
	const rawAt = (frame) => {
		reference.poseClip(frame);
		return reference.leg.bones.map((b) => b.getWorldPosition(v()));
	};

	/** Bake a 1 cm ankle lift at `frame`, optionally recording the clip's own
	 * rotations so the key becomes a delta. Read the target on the same clip
	 * translations the solver preserves, as the collision driver does. */
	const bakeCorrection = (take, state, frame, withBase) => {
		take.poseClip(frame);
		const baseQuats = new Map([["leftFoot", take.leg.bones.map((b) => b.quaternion.clone())]]);
		const lifted = take.leg.bones[2].getWorldPosition(v()).add(new THREE.Vector3(0, 0.010, 0));
		solveIk(take.leg, lifted);
		ikBakeKeyframe(take.chains, state, frame, take.fkJoints, ["leftFoot"], null, withBase ? baseQuats : null);
		return take.leg.bones.map((b) => b.getWorldPosition(v()));
	};

	const measure = (withBase) => {
		const take = buildTake();
		const state = createIkState();
		const solvedAt = new Map();
		solvedAt.set(FIRST_KEY, bakeCorrection(take, state, FIRST_KEY, withBase));
		solvedAt.set(SECOND_KEY, bakeCorrection(take, state, SECOND_KEY, withBase));
		// How far the correction itself moved each bone, against the raw clip —
		// the yardstick every unkeyed frame has to stay under.
		const correction = [...solvedAt].reduce((worst, [frame, solved]) => {
			const raw = rawAt(frame);
			return solved.map((point, index) => Math.max(worst[index], point.distanceTo(raw[index])));
		}, [0, 0, 0]);
		let worstEffector = 0;
		let worstAnyBone = 0;
		let worstFootDrop = 0;
		let keyedError = 0;
		for (let frame = RANGE[0]; frame <= RANGE[1]; frame += 1) {
			const raw = rawAt(frame);
			take.poseClip(frame);
			ikEvaluate(take.chains, state, frame, take.fkJoints, BLEND);
			const now = take.leg.bones.map((b) => b.getWorldPosition(v()));
			if (solvedAt.has(frame)) {
				keyedError = Math.max(keyedError, ...now.map((point, index) => point.distanceTo(solvedAt.get(frame)[index])));
				continue;
			}
			worstEffector = Math.max(worstEffector, now[2].distanceTo(raw[2]));
			worstAnyBone = Math.max(worstAnyBone, ...now.map((point, index) => point.distanceTo(raw[index]) - correction[index]));
			worstFootDrop = Math.max(worstFootDrop, raw[2].y - now[2].y);
		}
		return { worstEffector, worstAnyBone, worstFootDrop, keyedError, correction };
	};

	const legacy = measure(false);
	const delta = measure(true);
	check("the correction under test is the small one the criterion names (< 2 cm)",
		Math.max(...delta.correction) < 0.02,
		`correction=${delta.correction.map((c) => (c * 1000).toFixed(1)).join("/")}mm`);
	check("the fixture reproduces the absolute blend's smear (the test is not vacuous)",
		legacy.worstEffector > 0.05,
		`legacy worst unkeyed foot drift=${(legacy.worstEffector * 1000).toFixed(1)}mm`);
	check("no unkeyed frame's foot moves more than 1 cm from the raw clip",
		delta.worstEffector < 0.01,
		`delta=${(delta.worstEffector * 1000).toFixed(1)}mm vs legacy=${(legacy.worstEffector * 1000).toFixed(1)}mm`);
	check("every bone's smear is bounded by that bone's own correction",
		delta.worstAnyBone <= 1e-9,
		`excess=${(delta.worstAnyBone * 1000).toFixed(2)}mm (legacy ${(legacy.worstAnyBone * 1000).toFixed(1)}mm)`);
	check("no unkeyed frame is dragged below its own clip foot height by 5 mm",
		delta.worstFootDrop < 0.005,
		`drop=${(delta.worstFootDrop * 1000).toFixed(1)}mm legacy=${(legacy.worstFootDrop * 1000).toFixed(1)}mm`);
	check("the keyed frames still reproduce the solved pose exactly",
		delta.keyedError < 1e-9, `err=${delta.keyedError.toExponential(2)}`);
	check("legacy keys with no base rotation keep the old absolute blend",
		legacy.keyedError < 1e-9 && legacy.worstEffector > delta.worstEffector * 5,
		`legacy=${(legacy.worstEffector * 1000).toFixed(1)}mm delta=${(delta.worstEffector * 1000).toFixed(1)}mm`);
}

/* --- baseQ bookkeeping ---------------------------------------------------- */
{
	const baseRig = makeRig();
	const baseResolved = resolveIkRig(baseRig);
	const arm = baseResolved.chains.get("leftHand");
	const state = createIkState();
	const clipQuats = arm.bones.map((b) => b.quaternion.clone());
	solveIk(arm, arm.bones[2].getWorldPosition(v()).add(new THREE.Vector3(0, 0.05, 0)));
	ikBakeKeyframe(baseResolved.chains, state, 10, baseResolved.fkJoints, ["leftHand"], null,
		new Map([["leftHand", clipQuats]]));
	const entry = state.keys.get(10).get("leftHand");
	check("a chain key stores the clip rotations it was solved from",
		entry.baseQ?.length === entry.q.length
			&& entry.baseQ.every((q, i) => q.angleTo(clipQuats[i]) < 1e-12));
	// 1e-6 rad, not zero: quaternions are float32 and the invert/multiply
	// round trip costs ~4e-8 rad. Anything visible is orders of magnitude above.
	check("baseQ ∘ delta reconstructs the authored rotation",
		entry.q.every((q, i) => entry.baseQ[i].clone().multiply(entry.baseQ[i].clone().invert().multiply(q)).angleTo(q) < 1e-6));

	// A bake given no bases, or partial ones, must not fabricate a delta.
	ikBakeKeyframe(baseResolved.chains, state, 20, baseResolved.fkJoints, ["leftHand"]);
	check("a bake with no bases stores no baseQ", !state.keys.get(20).get("leftHand").baseQ);
	ikBakeKeyframe(baseResolved.chains, state, 30, baseResolved.fkJoints, ["leftHand"], null,
		new Map([["leftHand", [clipQuats[0], null, clipQuats[2]]]]));
	check("a partial base array is refused rather than half-applied",
		!state.keys.get(30).get("leftHand").baseQ);
	// Authoring mode never takes the delta path, whatever the key carries.
	arm.bones.forEach((b, i) => b.quaternion.copy(clipQuats[i]));
	baseRig.updateMatrixWorld(true);
	ikEvaluate(baseResolved.chains, state, 10, baseResolved.fkJoints, 0);
	check("blendFrames 0 still applies the key absolutely",
		arm.bones.every((b, i) => b.quaternion.angleTo(entry.q[i]) < 1e-6));
}

/* --- REGRESSION (Defect A): the REST pose, not the bind pose --------------- */
/* poseBind is a T-POSE; the pose the app puts on screen is DEFAULT_POSE, arms
 * hanging at the sides. Calibrating capsule proxies against bind alone left the
 * arm-beside-torso pairs at zero allowance, which is exactly where the proxies
 * overlap. restWorldPosition composes the rest pose virtually so the calibration
 * can see it without touching the live rig. */
{
	const shoulderQ = (sign) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sign * Math.PI / 2);
	// Mixamo-like shoulder frames: the arm hangs from a rotated shoulder, so
	// DEFAULT_POSE's X-axis delta swings it DOWN. On an identity-local rig the
	// same delta spins the bone around its own axis and nothing moves.
	const restRig = new THREE.Object3D();
	restRig.scale.setScalar(0.01);
	const mk = (name, parent, x, y, z, quat) => {
		const b = new THREE.Bone();
		b.name = name;
		b.position.set(x, y, z);
		if (quat) b.quaternion.copy(quat);
		parent.add(b);
		return b;
	};
	const rHips = mk("mixamorigHips", restRig, 0, 100, 0);
	const rSpine = mk("mixamorigSpine", rHips, 0, 15, 0);
	const rChest = mk("mixamorigSpine1", rSpine, 0, 15, 0);
	mk("mixamorigSpine2", rChest, 0, 15, 0);
	const rNeck = mk("mixamorigNeck", rChest, 0, 30, 0);
	mk("mixamorigHead", rNeck, 0, 15, 0);
	const lSh = mk("mixamorigLeftShoulder", rChest, 10, 25, 0, shoulderQ(1));
	const lUpArm = mk("mixamorigLeftArm", lSh, 0, -10, 4);
	const lFore = mk("mixamorigLeftForeArm", lUpArm, 0, 0, 30);
	mk("mixamorigLeftHand", lFore, 0, 0, 30);
	const rSh = mk("mixamorigRightShoulder", rChest, -10, 25, 0, shoulderQ(-1));
	const rUpArm = mk("mixamorigRightArm", rSh, 0, -10, 4);
	const rFore = mk("mixamorigRightForeArm", rUpArm, 0, 0, 30);
	mk("mixamorigRightHand", rFore, 0, 0, 30);
	restRig.updateMatrixWorld(true);
	primeBindPose(restRig);

	const bindFore = bindWorldPosition(restRig, lFore, v());
	const restFore = restWorldPosition(restRig, lFore, v());
	check("the bind pose is a T-pose (forearm out to the side)",
		bindFore.x > 0.4 && Math.abs(bindFore.y - 1.45) < 1e-6,
		`bind=(${bindFore.toArray().map((n) => n.toFixed(3)).join(",")})`);
	check("the composed REST pose hangs the arm at the side",
		restFore.x < 0.2 && restFore.y < 1.2,
		`rest=(${restFore.toArray().map((n) => n.toFixed(3)).join(",")})`);
	check("the two poses are far apart — bind cannot stand in for rest",
		bindFore.distanceTo(restFore) > 0.25, `gap=${bindFore.distanceTo(restFore).toFixed(3)}`);

	// The rest composition must reproduce what applyPose would actually do.
	applyPose(restRig, { ...REST_ZERO, ...DEFAULT_POSE.bones });
	restRig.updateMatrixWorld(true);
	check("restWorldPosition matches the pose applyPose really writes",
		lFore.getWorldPosition(v()).distanceTo(restFore) < 1e-9,
		`err=${lFore.getWorldPosition(v()).distanceTo(restFore).toExponential(2)}`);
	check("composing the rest pose never disturbed the live rig", (() => {
		const before = lFore.getWorldPosition(v());
		restWorldPosition(restRig, lFore, v());
		bindWorldPosition(restRig, lFore, v());
		return lFore.getWorldPosition(v()).distanceTo(before) < 1e-12;
	})());
	check("a rig with no bind snapshot composes nothing and reads current", (() => {
		const bare = makeRig();
		const bone = bare.getObjectByName("mixamorigLeftForeArm");
		return restWorldPosition(bare, bone, v()).distanceTo(bone.getWorldPosition(v())) < 1e-12;
	})());
}

/* --- exactHinge: one solve reaches a reachable target from a BENT chain -- */
// The continuity hinge uses the elbow's raw offset from the new line point,
// which keeps an along-line part; p1 leaves the l0 sphere and the hand lands
// short, converging only over repeated solves. exactHinge (range pins) drops
// that part; the default stays as fix-collisions is tuned on.
{
	const run = (options) => {
		const bentRig = makeRig();
		const bent = resolveIkRig(bentRig).chains.get("rightHand");
		bent.bones[0].quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.9);
		bent.bones[1].quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -1.1);
		bentRig.updateMatrixWorld(true);
		const root = bent.bones[0].getWorldPosition(v());
		const elbowBefore = bent.bones[1].getWorldPosition(v());
		let worst = 0;
		let sideKept = true;
		for (const offset of [[0, -0.08, 0.05], [0.1, 0.02, 0], [0, 0.12, -0.06], [-0.05, -0.1, 0.1]]) {
			const target = bent.bones[2].getWorldPosition(v()).add(new THREE.Vector3(...offset));
			const elbow = bent.bones[1].getWorldPosition(v()).sub(root);
			const line = target.clone().sub(root).normalize();
			const sideBefore = elbow.addScaledVector(line, -elbow.dot(line));
			solveIk(bent, target, options);
			worst = Math.max(worst, bent.bones[2].getWorldPosition(v()).distanceTo(target));
			const after = bent.bones[1].getWorldPosition(v()).sub(root);
			if (after.addScaledVector(line, -after.dot(line)).dot(sideBefore) <= 0) sideKept = false;
		}
		return { worst, sideKept, moved: bent.bones[1].getWorldPosition(v()).distanceTo(elbowBefore) };
	};
	const exact = run({ exactHinge: true });
	const legacy = run(undefined);
	check("fixture: the default hinge lands short from a bent chain (> 1 mm)", legacy.worst > 0.001, `worst=${(legacy.worst * 1000).toFixed(3)}mm`);
	check("exactHinge reaches each reachable target in ONE solve (< 1e-6 m)", exact.worst < 1e-6, `worst=${(exact.worst * 1000).toFixed(3)}mm`);
	check("exactHinge keeps the elbow on its side of the line", exact.sideKept && exact.moved > 0.01);
}

// Keep the measured translation-step regression in the registered IK suite.
await import("./translation-step.mjs");

if (failures) {
	console.log(`${failures} FAIL`);
	process.exit(1);
}
console.log("all PASS");
