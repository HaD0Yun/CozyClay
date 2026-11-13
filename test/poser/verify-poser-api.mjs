// Poser public API on CozyClay's own Y Bot rig JSON: createPoser().solve plumbing, rejection, handle sends, the
// sends of one drag, read-back and the three.js-style local transforms. A stand-in network (the rest pose) answers,
// so no model is needed; verify-poser-goldens.mjs covers the real network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EFFECTOR, floorShift } from "../../src/poser/encode.js";
import { dragSends, effectorsFromSends, HANDLES, headingOf } from "../../src/poser/handles.js";
import { createPoser } from "../../src/poser/poser.js";
import { readPose, writePose } from "../../src/poser/retarget.js";
import { characterFromRigJson, mixamoJointToBone, placementFrame } from "../../src/poser/ybot.js";

let calls = 0;
// rest pose: identity locals, root at the network-length hips height
const restNetwork = { run: async () => { calls += 1; const rot6d = new Float32Array(180); for (let j = 0; j < 30; j += 1) rot6d.set([1, 0, 0, 0, 1, 0], 6 * j); const draft = new Float32Array(90); draft[1] = 0.95; return { draft, rot6d }; } };
const poser = createPoser({ network: restNetwork }), sk = poser.skeleton;
const character = characterFromRigJson();
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test("Mixamo bone names map onto the poser joints", () => {
	const map = mixamoJointToBone(character.bones.map((b) => b.name));
	assert.equal(map.shin_l, "LeftLeg");
	assert.equal(map.neck_top, null, "a joint the rig lacks stays unmapped");
});

test("a solve meets its handles and writes the mapped bones", async () => {
	const sends = [
		{ id: "hips", position: [0, 0.95, 0] }, { id: "leftHand", position: [0.55, 1.38, 0.05] },
		{ id: "leftFoot", position: [0.1, 0.08, 0] }, { id: "rightFoot", position: [-0.1, 0.08, 0] },
	];
	const pose = await poser.solve(sends, character);
	assert.ok(pose.ok, pose.reason);
	close(pose.joints[3 * 13], 0.55, 0.01, "left hand x");
	close(pose.joints[3 * 13 + 1], 1.38, 0.01, "left hand y");
	assert.ok(pose.joints.every((v, i) => i % 3 !== 1 || v >= -1e-6), "every joint on or above the floor");
	assert.equal(pose.bones.length, 22);
	const hand = pose.bones.find((b) => b.name === "LeftHand");
	const shoulder = pose.bones.find((b) => b.name === "LeftArm").pose, reach = 27.40 + 27.61; // Y Bot arm, cm
	assert.ok(Math.hypot(55 - shoulder[3], 138 - shoulder[7], 5 - shoulder[11]) < reach, "target within the character's reach");
	[55, 138, 5].forEach((v, a) => close(hand.pose[4 * a + 3], v, 1e-3, "the limb fit puts the written hand on its target (cm)"));
	assert.deepEqual(pose.warnings, []);
	assert.ok(pose.timings.totalMs >= pose.timings.ikMs);
});

test("three.js locals compose back to the armature-space poses", async () => {
	const pose = await poser.solve([{ id: "hips", position: [0.1, 0.9, 0] }, { id: "rightHand", position: [-0.4, 1.5, 0.2] }], character);
	const byName = new Map(pose.bones.map((b) => [b.name, b])), parentOf = new Map(character.bones.map((b) => [b.name, character.bones[b.parent]?.name]));
	const m4 = ({ quaternion: [x, y, z, w], position: t }) => [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), t[0], 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), t[1], 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), t[2], 0, 0, 0, 1];
	const mul4 = (a, b) => Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].reduce((s, k) => s + a[4 * Math.floor(i / 4) + k] * b[4 * k + (i % 4)], 0));
	for (const bone of pose.bones) {
		const parent = byName.get(parentOf.get(bone.name));
		if (!parent) continue;
		mul4(parent.pose, m4(bone)).forEach((v, i) => close(v, bone.pose[i], 1e-6, `${bone.name}[${i}]`));
	}
});

test("zero position handles: rejected, no network call; one or two: solved with a warning", async () => {
	const before = calls;
	const rejected = await poser.solve([{ id: "lookAt", lookAt: [0, 1.6, 1] }, { id: "spineLow", rotation: [1, 0, 0, 0, 1, 0] }], character);
	assert.equal(rejected.ok, false);
	assert.equal(rejected.reason, "no-position-effector");
	assert.equal(calls, before, "a rejected query never reaches the network");
	assert.deepEqual((await poser.solve([{ id: "head", position: [0, 1.6, 0] }], character)).warnings, ["few-position-effectors"]);
	assert.throws(() => effectorsFromSends([{ id: "spineLow", position: [0, 1, 0] }]), /cannot send position/);
	assert.throws(() => effectorsFromSends([{ id: "tail", position: [0, 1, 0] }]), /unknown handle/);
});

test("duplicate (joint, type) keeps the tighter tolerance; rotations come in as 6D or 3x3", () => {
	const effectors = effectorsFromSends([{ id: "head", rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], rotTol: 0.02 }, { id: "lookAt", lookAt: [0, 1.6, 1], rotation: [1, 0, 0, 0, 1, 0], rotTol: 0.01 }]);
	assert.deepEqual(effectors.filter((e) => e.type === EFFECTOR.rotation).map((e) => e.rot6d), [[1, 0, 0, 0, 1, 0], [1, 0, 0, 0, 1, 0]]);
	assert.equal(HANDLES.length, 20);
});

test("one drag's sends: the dragged handle, held feet, the hips hint, an unplaced look-at", () => {
	const state = Object.fromEntries(HANDLES.filter((h) => h.start).map((h) => [h.id, { enabled: true, held: !!h.held, tolerance: 0.005, place: [0, 1, 0], turn: [1, 0, 0, 0, 1, 0, 0, 0, 1] }]));
	const sends = dragSends(state, { id: "leftHand", target: [0.4, 1.2, 0.2] });
	const byId = Object.fromEntries(sends.map((s) => [s.id, s]));
	assert.deepEqual(Object.keys(byId).sort(), ["hips", "leftFoot", "leftHand", "rightFoot"]);
	assert.equal(byId.leftHand.tol, 0.005);
	assert.equal(byId.leftFoot.tol, 0.005);
	assert.equal(byId.hips.tol, 0.06);
	assert.equal(byId.hips.rotTol, 0.08);
	assert.equal(byId.rightHand, undefined, "a following hand sends nothing");
	close(headingOf([0, 0, 1, 0, 1, 0, -1, 0, 0]), Math.PI / 2, 1e-12, "heading of R_y(90 deg)");
	state.hips.turn = [0, 0, 1, 0, 1, 0, -1, 0, 0];
	dragSends(state, { id: "leftHand", target: [0.4, 1.2, 0.2] }).find((s) => s.id === "hips").rotation.forEach((v, i) => close(v, state.hips.turn[i], 1e-12, "hips heading hint"));
});

test("reading the bones back inverts writing them, for every written joint", async () => {
	const pose = await poser.solve([{ id: "hips", position: [0, 0.9, 0.1] }, { id: "head", position: [0.1, 1.5, 0.2] }], character);
	const rig = poser.prepare(character), written = writePose(rig, { joints: pose.joints, G: pose.G });
	const byName = new Map(written.bones.map((b) => [b.name, { R: [0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => b.pose[i]), t: [b.pose[3], b.pose[7], b.pose[11]] }]));
	const back = readPose(sk, rig, (name) => byName.get(name));
	rig.written.forEach((on, j) => { if (on) for (let k = 0; k < 9; k += 1) close(back.G[9 * j + k], pose.G[9 * j + k], 1e-6, `G ${sk.names[j]}`); });
	for (let a = 0; a < 3; a += 1) close(back.root[a], pose.root[a], 1e-6, "root");
});

test("floor reference shift and placement frame", () => {
	const effectors = [{ joint: 0, type: 0, target: [0, 2.0, 0], tol: 0.005 }, { joint: 6, type: 1, rot6d: [1, 0, 0, 0, 1, 0] }];
	assert.equal(floorShift(effectors, 0.1, { airborne: false }).effectors[0].target[1], 1.9);
	const lifted = floorShift(effectors, 0, { airborne: true });
	close(lifted.shift, 2.0 - 0.95 - 0.5, 1e-12, "airborne lift");
	assert.equal(lifted.effectors[1], effectors[1], "rotation effectors are never shifted");
	const frame = placementFrame({ x: 1, y: 0.2, z: -3, rot: 90 }), p = [0.3, 1.1, 0.7], q = frame.toStage(frame.toPoser(p));
	p.forEach((v, i) => close(q[i], v, 1e-12, "placement round trip"));
	const forward = frame.toStage([0, 0, 1]);
	close(forward[0], 2, 1e-12, "rot 90 turns the character's +Z to stage +X");
});

test("the core keeps the caller's metres at any body size: scales 0.5, 0.8, 1 and 2", async () => {
	for (const scale of [0.5, 0.8, 1, 2]) {
		const scaled = characterFromRigJson(undefined, { scale }), rig = poser.prepare(scaled), m = 0.01 * scale;
		assert.equal(rig.s, m, `scale ${scale}: the caller's scale is kept`);
		const rest = (name) => scaled.bones.find((b) => b.name === name).head.map((v) => v * m);
		const lf = rest("LeftFoot"), rf = rest("RightFoot"), lh = rest("LeftHand"), target = [lh[0] - 0.3 * scale, lh[1] - 0.25 * scale, lh[2] + 0.3 * scale];
		const pose = await poser.solve([{ id: "hips", position: rest("Hips"), tol: 0.06 }, { id: "leftFoot", position: lf }, { id: "rightFoot", position: rf }, { id: "leftHand", position: target }], scaled);
		const at = (name) => { const b = pose.bones.find((x) => x.name === name); return [b.pose[3] * m, b.pose[7] * m, b.pose[11] * m]; };
		const miss = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		// the rest-pose stand-in leaves about 2 cm per body metre at every size; a size error would show as metres
		assert.ok(miss(at("LeftHand"), target) < 0.025 * scale, `scale ${scale}: hand on its handle (${miss(at("LeftHand"), target)} m)`);
		for (const [name, p] of [["LeftFoot", lf], ["RightFoot", rf]]) assert.ok(miss(at(name), p) < 0.015 * scale, `scale ${scale}: ${name} held`);
		assert.ok(pose.joints.every((v, i) => i % 3 !== 1 || v >= -1e-6), `scale ${scale}: nothing below the floor`);
	}
	assert.equal(poser.prepare(characterFromRigJson()).size, 1, "a body of ordinary size is solved as it is");
	assert.ok(poser.prepare(characterFromRigJson(undefined, { scale: 0.5 })).size < 1 && poser.prepare(characterFromRigJson(undefined, { scale: 2 })).size > 1);
});
