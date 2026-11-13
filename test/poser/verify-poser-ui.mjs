// Auto Pose tool logic without a browser: handle state, coalesced live solving, flip left and right, copy and paste,
// back to T-pose, screen-space picking and the solve guard. Pure data on CozyClay's own Y Bot
// rig JSON; no model needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import yBot from "../../src/motion3/rigs/y-bot-tpose.json" with { type: "json" };
import { axisAngle } from "../../src/poser/mat3.js";
import { createPoser } from "../../src/poser/poser.js";
import { characterFromRigJson } from "../../src/poser/ybot.js";
import { afterDrag, canMove, canTurn, forgetLeft, heldPlace, initialHandles, pressHandles, setEnabled, setHoldsRotation, setHeld, setTolerance } from "../../src/poser/ui/handle-state.js";
import { copyPose, flipPose, pastePose, poseFromLocals, restBones, twinTable } from "../../src/poser/ui/pose-ops.js";
import { pickHandle, pickRing } from "../../src/poser/ui/poser-pick.js";
import { createSolveLoop } from "../../src/poser/ui/solve-loop.js";

const poser = createPoser({ network: { run: async () => { throw new Error("no network in this test"); } } });
const sk = poser.skeleton, facts = poser.prepare(characterFromRigJson()), I9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const rot = (x, y, z, t) => Array.from(axisAngle(new Float64Array(9), 0, x, y, z, t));
const press = (state) => pressHandles(state, { jointAt: (j) => [j / 100, 1, 0], turnAt: () => I9, lookHome: [0, 1.6, 0.45] });

test("start state: the six core handles on, feet and toes held, default tolerance", () => {
	const s = initialHandles();
	assert.equal(Object.keys(s).length, 19, "every handle but the whole-body mover");
	assert.deepEqual(Object.keys(s).filter((id) => s[id].enabled).sort(), ["hips", "leftFoot", "leftHand", "lookAt", "rightFoot", "rightHand"]);
	assert.deepEqual(Object.keys(s).filter((id) => s[id].held).sort(), ["leftFoot", "leftToes", "rightFoot", "rightToes"]);
	assert.ok(Object.values(s).every((h) => h.tolerance === 0.005 && !h.holdsRotation && !h.placed));
	assert.equal(canMove("spineLow"), false);
	assert.equal(canTurn("spineLow"), true);
	assert.equal(canMove("lookAt"), true);
});

test("switching on does not re-solve, switching off does; tolerance is clamped", () => {
	let s = initialHandles();
	const on = setEnabled(s, "leftElbow", true);
	assert.equal(on.resolve, false);
	assert.equal(on.state.leftElbow.enabled, true);
	const off = setEnabled(on.state, "leftElbow", false);
	assert.equal(off.resolve, true);
	assert.equal(setEnabled(s, "leftElbow", false).resolve, false, "already off: nothing to do");
	s = setTolerance(s, "leftHand", 9);
	assert.equal(s.leftHand.tolerance, 0.5);
	s = setTolerance(s, "leftHand", 0, { rotation: true });
	assert.equal(s.leftHand.rotTolerance, 0.001);
});

test("press reads places and turns from the pose; places and turns the user left stay until stale", () => {
	let s = press(initialHandles());
	assert.deepEqual(s.leftHand.place, [0.13, 1, 0]);
	assert.deepEqual(s.lookAt.place, [0, 1.6, 0.45], "an unplaced look-at sits in front of the head");
	s = afterDrag(s, { id: "rightHand", target: [-0.4, 1.3, 0.3], pressTurn: I9 });
	assert.equal(s.rightHand.held, true, "a dragged handle stays held (sticky)");
	assert.equal(s.rightHand.left, true);
	assert.deepEqual(heldPlace(s, "rightHand"), [-0.4, 1.3, 0.3]);
	assert.equal(heldPlace(s, "leftHand"), null, "a following handle sits on its joint");
	s = press(s);
	assert.deepEqual(s.rightHand.place, [-0.4, 1.3, 0.3], "the next press keeps the place the user left");
	s = press(forgetLeft(s));
	assert.deepEqual(s.rightHand.place, [0.19, 1, 0], "after an outside change it reads the joint again");
	assert.equal(s.rightHand.held, true, "it stays held");
	s = setHeld(afterDrag(s, { id: "rightHand", target: [0, 1, 0] }), "rightHand", false);
	assert.equal(s.rightHand.left, false, "unpinning lets it follow the body again");
});

test("dragging a switched-off guide turns it on; a real turn holds the rotation; a dragged look target stays put", () => {
	let s = afterDrag(press(initialHandles()), { id: "leftKnee", target: [0.1, 0.5, 0.2] });
	assert.equal(s.leftKnee.enabled, true);
	s = afterDrag(s, { id: "leftHand", turn: rot(0, 1, 0, (1 * Math.PI) / 180), pressTurn: I9 });
	assert.equal(s.leftHand.holdsRotation, false, "1 degree does not keep the turn");
	const turn = rot(0, 1, 0, (3 * Math.PI) / 180);
	s = afterDrag(s, { id: "leftHand", turn, pressTurn: I9 });
	assert.equal(s.leftHand.holdsRotation, true, "3 degrees keeps it");
	assert.deepEqual(press(s).leftHand.turn, turn, "the kept turn survives the next press");
	assert.equal(setHoldsRotation(s, "leftHand", false).leftHand.turnSet, false);
	s = afterDrag(s, { id: "lookAt", target: [0.3, 1.5, 1] });
	assert.equal(s.lookAt.placed, true);
	assert.deepEqual(heldPlace(s, "lookAt"), [0.3, 1.5, 1]);
	assert.deepEqual(forgetLeft(s).lookAt.place, [0.3, 1.5, 1], "a placed look-at is a world point and stays");
});

test("live solving is coalesced: one solve in flight, the latest request wins, results stay in order", async () => {
	const ran = [], landed = [];
	let release = null;
	const loop = createSolveLoop((job) => { ran.push(job); return new Promise((resolve) => { release = () => resolve(job * 10); }); }, { onResult: (r) => landed.push(r) });
	for (let i = 1; i <= 10; i += 1) loop.request(i);
	assert.deepEqual(ran, [1], "the first move starts a solve");
	assert.equal(loop.busy, true);
	let idle = false;
	loop.idle().then(() => { idle = true; });
	release();
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(ran, [1, 10], "moves 2-9 were dropped for the latest one");
	assert.equal(idle, false, "still busy with the latest move");
	release();
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(landed, [10, 100]);
	assert.equal(idle, true);
	assert.deepEqual(loop.stats, { requested: 10, run: 2, dropped: 8 });
	const errors = [];
	const failing = createSolveLoop(async () => { throw new Error("boom"); }, { onError: (e) => errors.push(e.message) });
	failing.request(1);
	await failing.idle();
	assert.deepEqual(errors, ["boom"]);
});

// A pose with the left arm swung forward and the head turned, on the Y Bot's measured lengths.
function samplePose() {
	const L = new Float64Array(9 * 30);
	for (let j = 0; j < 30; j += 1) L.set(I9, 9 * j);
	L.set(rot(0, 1, 0, 0.3), 0); // whole body turned 17 degrees
	L.set(rot(1, 0, 0, -1.1), 9 * sk.index.uarm_l);
	L.set(rot(0, 1, 0, 0.5), 9 * sk.index.head);
	return poseFromLocals(sk, facts, L, [0.2, 0.95, -0.1]);
}
const at = (P, j) => [P[3 * j], P[3 * j + 1], P[3 * j + 2]];

test("flip: left and right swap across the body's own plane; twice is the identity", () => {
	assert.equal(twinTable(sk)[sk.index.hand_l], sk.index.hand_r);
	assert.equal(twinTable(sk)[sk.index.head], sk.index.head);
	const pose = samplePose(), once = flipPose(sk, facts, pose), twice = flipPose(sk, facts, once);
	pose.G.forEach((v, k) => close(twice.G[k], v, 1e-9, `G ${k}`));
	once.root.forEach((v, a) => close(v, pose.root[a], 1e-12, "the root stays"));
	// reflect the original left hand across the plane through the hips with normal n = G_Hips x
	const n = [pose.G[0], pose.G[3], pose.G[6]], hips = at(pose.P, 0), left = at(pose.P, sk.index.hand_l);
	const d = left.reduce((s, v, a) => s + (v - hips[a]) * n[a], 0), reflected = left.map((v, a) => v - 2 * d * n[a]);
	at(once.P, sk.index.hand_r).forEach((v, a) => close(v, reflected[a], 0.01, "the right hand lands where the left was, reflected"));
});

test("copy and paste: same character round trip, stay in place, reversed, another stature", () => {
	const pose = samplePose(), clip = copyPose(facts, pose, "a");
	const current = poseFromLocals(sk, facts, Float64Array.from({ length: 270 }, (_, k) => (k % 9 === 0 || k % 9 === 4 || k % 9 === 8 ? 1 : 0)), [1.5, 0.95, 2]);
	const pasted = pastePose(sk, facts, clip, current, { source: "a" });
	pose.G.forEach((v, k) => close(pasted.G[k], v, 1e-12, `G ${k}`));
	assert.deepEqual([pasted.root[0], pasted.root[2]], [1.5, 2], "stay in place keeps the current X and Z");
	close(pasted.root[1], 0.95, 1e-12, "height from the pasted pose");
	const reversed = pastePose(sk, facts, clip, current, { source: "a", reversed: true }), flipped = flipPose(sk, facts, pasted);
	flipped.G.forEach((v, k) => close(reversed.G[k], v, 1e-12, "reversed = flipped paste"));
	const tall = poser.prepare(characterFromRigJson(yBot, { scale: 1.2 }));
	close(pastePose(sk, tall, clip, current, { source: "b" }).root[1], 0.95 * 1.2, 1e-9, "another character scales the root by rest hips height");
	const facing = pastePose(sk, facts, clip, current, { source: "a", faceAsNow: true });
	close(Math.atan2(facing.G[2], facing.G[8]), 0, 1e-9, "face as now turns the paste to the current heading");
});

test("back to T-pose: every written bone back to the rig file's bind transform", () => {
	const bones = restBones(facts), byName = new Map(yBot.bones.map((b) => [b.name, b]));
	assert.equal(bones.length, 22);
	const leftArm = bones.find((b) => b.name === "LeftArm"), file = byName.get("LeftArm"), parent = yBot.bones[file.parent];
	// rest local = parent⁻¹ · bone in the rig file (quaternions [x, y, z, w])
	const [px, py, pz, pw] = parent.worldQuat, [bx, by, bz, bw] = file.worldQuat;
	const q = [pw * bx - px * bw - py * bz + pz * by, pw * by + px * bz - py * bw - pz * bx, pw * bz - px * by + py * bx - pz * bw, pw * bw + px * bx + py * by + pz * bz];
	const dotq = q.reduce((s, v, i) => s + v * leftArm.quaternion[i], 0);
	close(Math.abs(dotq), 1, 1e-6, "LeftArm rest local rotation");
	bones.find((b) => b.name === "Hips").position.forEach((v, a) => close(v, byName.get("Hips").worldPos[a], 1e-9, "hips rest position"));
});

test("picking: nearest handle in reach, an enabled one wins a near tie; rings by their drawn line", () => {
	const handles = [{ id: "a", x: 100, y: 100, reach: 20, enabled: false }, { id: "b", x: 106, y: 100, reach: 20, enabled: true }, { id: "c", x: 300, y: 300, reach: 10, enabled: true }];
	assert.equal(pickHandle(handles, 102, 100).id, "b", "2 px vs 4 px, but b is on");
	assert.equal(pickHandle(handles, 96, 100).id, "a");
	assert.equal(pickHandle(handles, 200, 200), null);
	const square = (axis, r) => ({ axis, points: [[100 - r, 100 - r, true], [100 + r, 100 - r, true], [100 + r, 100 + r, true], [100 - r, 100 + r, true]] });
	assert.equal(pickRing([square("x", 50), square("y", 30)], 131, 110), "y");
	assert.equal(pickRing([square("x", 50), square("y", 30)], 100, 100), null);
	assert.equal(pickRing([{ axis: "z", points: [[0, 0, false], [10, 0, false]] }], 5, 0), null, "outline behind the camera");
});

test("solve guard: refuses non-finite results, a thrown body and a held handle pulled away; reports a handle out of reach", async () => {
	const { checkSolve, writtenJoints } = await import("../../src/poser/ui/solve-guard.js");
	const { bonesForPose: bones } = await import("../../src/poser/ui/pose-ops.js");
	const pose = samplePose(), result = { joints: Array.from(pose.P), bones: bones(facts, pose) }, on = writtenJoints(facts, result.bones);
	// where the character's own bones put the joints (its proportions, not the network's)
	const foot = on(sk.index.foot_l), hand = on(sk.index.hand_r), root = on(0);
	const press = { root, miss: {} }, held = (dx, tol = 0.005) => [{ id: "leftFoot", position: [foot[0] + dx, foot[1], foot[2]], tol }];
	assert.deepEqual(checkSolve(facts, result, { sends: held(0), drag: { id: "rightHand", target: hand }, press }), { ok: true });
	const moved = checkSolve(facts, result, { sends: held(0.1), drag: { id: "rightHand" }, press });
	assert.equal(moved.reason, "held-moved");
	assert.equal(moved.id, "leftFoot");
	close(moved.cm, 10, 0.5, "how far the held handle would move (cm)");
	assert.equal(checkSolve(facts, result, { sends: held(0.1, 0.2), drag: { id: "rightHand" }, press }).ok, true, "a loose held handle may give");
	assert.equal(checkSolve(facts, result, { sends: held(0.1), drag: { id: "rightHand" }, press: { root, miss: { leftFoot: 0.095 } } }).ok, true, "a held handle already that far off at the press does not block");
	assert.equal(checkSolve(facts, result, { sends: [], drag: { id: "rightHand" }, press: { root: [root[0] + 2, root[1], root[2]], miss: {} } }).reason, "root-jump");
	assert.equal(checkSolve(facts, { ...result, joints: [NaN, ...result.joints.slice(1)] }, { sends: [], drag: null, press }).reason, "not-finite");
	const short = checkSolve(facts, result, { sends: [], drag: { id: "rightHand", target: [hand[0], hand[1] + 0.2, hand[2]] }, press: { root, place: hand, miss: {} } });
	assert.equal(short.ok, true);
	close(short.reach.cm, 20, 0.5, "hand short of its dot (cm)");
});

test("floor on the character: a written joint under y = 0 lifts the whole body by that much", async () => {
	const { liftToFloor, writtenJoints } = await import("../../src/poser/ui/solve-guard.js");
	const { bonesForPose: bones } = await import("../../src/poser/ui/pose-ops.js");
	const pose = samplePose();
	pose.root[1] -= 0.2;
	const sunk = poseFromLocals(sk, facts, pose.L, pose.root), list = bones(facts, sunk), low = (b) => { const at = writtenJoints(facts, b); return Math.min(...facts.written.flatMap((on, j) => (on ? [at(j)[1]] : []))); };
	assert.ok(low(list) < -0.05, "the test pose is under the floor");
	const { bones: lifted, lift } = liftToFloor(facts, list);
	close(low(lifted), 0, 1e-9, "lowest joint on the floor");
	close(lift, -low(list), 1e-12, "lift");
	assert.equal(liftToFloor(facts, lifted).lift, 0, "nothing to do above the floor");
});
