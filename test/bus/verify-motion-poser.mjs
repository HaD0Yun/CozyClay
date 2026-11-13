// The Auto Pose tool on the real motion domain and the real Y Bot FBX rig: the rig bridge agrees with the rig file, a
// drag writes live and keys on release through the shipped IK drag path (ik.setKey without a take, the
// preview-then-apply flow with one), every release comes back with a single undo, and whole-pose actions key alike.
// A stand-in network (rest pose) is used; the IK refinement still meets the handles.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import yBot from '../../src/motion3/rigs/y-bot-tpose.json' with { type: 'json' };
import { createPoser } from '../../src/poser/poser.js';
import { createPoserController } from '../../src/poser/ui/poser-controller.js';
import { getPoserState, updatePoserState } from '../../src/poser/ui/poser-store.js';
import { createRigBridge, POSER_KEY_TRACKS } from '../../src/poser/ui/rig-bridge.js';
import { motionFixture, seedMotion } from './motion-fixture.mjs';

const restNetwork = { run: async () => { const rot6d = new Float32Array(180); for (let j = 0; j < 30; j += 1) rot6d.set([1, 0, 0, 0, 1, 0], 6 * j); const draft = new Float32Array(90); draft[1] = 0.95; return { draft, rot6d }; } };
const poser = createPoser({ network: restNetwork });
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

let runs = 0;
function setup(take = null) {
  const f = motionFixture();
  f.motion.load([{ id: 'actor-a', take }]);
  const hook = f.renderMotion(), rig = f.rigs['actor-a'];
  const bridge = createRigBridge(rig, 'y-bot-tpose', poser);
  // handle state is kept per character id for the page's life: a fresh id per test starts from the default handles
  const characterId = `actor-a:${(runs += 1)}`;
  updatePoserState({ characterId });
  const ctrl = createPoserController({ characterId, bridge, poser, host: { solve: hook.ikSolve, dragEnd: hook.ikDragEnd } });
  return { f, hook, rig, bridge, ctrl };
}

test('poser: the rig bridge reads the FBX bind exactly as the rig file states it', () => {
  const { f, rig, bridge } = setup();
  try {
    const byName = new Map(yBot.bones.map((b) => [b.name, b]));
    for (const [bone, bind] of rig.userData.poseBind) { bone.quaternion.set(bind.x, bind.y, bind.z, bind.w); bone.position.set(bind.position.x, bind.position.y, bind.position.z); }
    for (const name of ['Hips', 'Spine2', 'LeftForeArm', 'RightUpLeg', 'LeftToeBase']) {
      const j = bridge.facts.bones.findIndex((b) => b.name === name), bone = bridge.facts.bones[j];
      const file = byName.get(name), q = new THREE.Quaternion(...file.worldQuat);
      const R = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
      assert.ok(near(bone.head, file.worldPos) < 1e-6, `${name} head`);
      [R[0], R[4], R[8], R[1], R[5], R[9], R[2], R[6], R[10]].forEach((v, k) => assert.ok(Math.abs(v - bone.rest[k]) < 1e-6, `${name} rest ${k}`));
    }
    // the live bind pose read back: hands where the rig file has them, metres in the poser frame
    const hand = bridge.jointPoser(13), file = byName.get('LeftHand').worldPos.map((v) => v / 100);
    assert.ok(near(hand, file) < 1e-4, `left hand ${hand} vs ${file}`);
    const pose = bridge.readPose();
    assert.ok(Math.abs(pose.root[1] - 0.998) < 0.001, 'hips height');
  } finally { f.dispose(); }
});

test('poser: a drag writes live, keys once on release through ik.setKey, and one undo restores the rig', async () => {
  const { f, hook, rig, bridge, ctrl } = setup();
  try {
    const before = f.actual.snapshotExportRig(rig), start = bridge.jointPoser(19), feet = [bridge.jointPoser(24), bridge.jointPoser(28)];
    const chest = rig.getObjectByName('mixamorigSpine2').quaternion, chestBefore = chest.clone();
    assert.equal(ctrl.press('rightHand'), true);
    for (let i = 1; i <= 6; i += 1) ctrl.move([start[0] - 0.01 * i, start[1] + 0.025 * i, start[2] + 0.035 * i]);
    assert.equal(hook.layer('actor-a').ikKeys.length, 0, 'no key while dragging');
    await ctrl.release();
    const target = [start[0] - 0.06, start[1] + 0.15, start[2] + 0.21];
    assert.ok(near(bridge.jointPoser(19), target) < 0.02, `right hand within 2 cm of the handle: ${near(bridge.jointPoser(19), target)}`);
    feet.forEach((p, i) => assert.ok(near(bridge.jointPoser([24, 28][i]), p) < 0.01, 'held feet stay within 1 cm'));
    assert.ok(ctrl.stats.solves.length <= 6, 'moves while a solve ran were coalesced');
    assert.ok(Math.abs(chest.dot(chestBefore)) > 1 - 1e-9, 'the upper chest, which no key stores, is held where playback puts it');
    const keys = hook.layer('actor-a').ikKeys;
    assert.equal(keys.length, 1);
    assert.equal(keys[0].frame, 0);
    assert.deepEqual(Object.keys(keys[0].tracks).sort(), [...POSER_KEY_TRACKS].sort(), 'body tracks keyed; upper chest and toes have none');
    const arm = rig.getObjectByName('mixamorigRightForeArm').quaternion, keyed = keys[0].tracks.rightHand.q[1];
    assert.ok(Math.abs(arm.x * keyed.x + arm.y * keyed.y + arm.z * keyed.z + arm.w * keyed.w) > 1 - 1e-9, 'the key holds the written forearm');
    const s = getPoserState().handles.rightHand;
    assert.equal(s.held && s.left, true, 'the dragged hand stays held where it was left');
    assert.deepEqual(hook.documentStore.depths(), { past: 1, future: 0 }, 'one release, one undo step');
    f.actual.undoScene();
    assert.equal(hook.layer('actor-a').ikKeys.length, 0);
    assert.deepEqual(f.actual.snapshotExportRig(rig), before, 'undo restores the pre-drag rig');
    ctrl.refreshStale();
    assert.equal(getPoserState().handles.rightHand.left, false, 'after undo the place left is stale and dropped');
  } finally { f.dispose(); }
});

test('poser: with a take the release is a preview; Apply keys it and Undo reverts it', async () => {
  const { f, hook, rig, bridge, ctrl } = setup(seedMotion());
  try {
    const before = f.actual.snapshotExportRig(rig), start = bridge.jointPoser(13);
    ctrl.press('leftHand');
    ctrl.move([start[0], start[1] + 0.1, start[2] + 0.1]);
    await ctrl.release();
    assert.equal(hook.layer('actor-a').ikKeys.length, 0, 'drag end is preview-only');
    assert.notDeepEqual(f.actual.snapshotExportRig(rig), before);
    assert.equal(hook.applyPendingIkEdit(), true);
    assert.deepEqual(hook.layer('actor-a').ikKeys.map((k) => k.frame), [0, 47]);
    f.actual.undoScene();
    assert.deepEqual(f.actual.snapshotExportRig(rig), before);
  } finally { f.dispose(); }
});

test('poser: switching a handle off re-solves; zero position handles is refused and changes nothing', async () => {
  const { f, hook, rig, ctrl } = setup();
  try {
    await ctrl.setEnabled('leftHand', false);
    assert.equal(hook.layer('actor-a').ikKeys.length, 1, 'switching off re-solved and keyed');
    for (const id of ['hips', 'rightHand', 'leftFoot', 'rightFoot']) await ctrl.setEnabled(id, false);
    const keys = hook.layer('actor-a').ikKeys.length, pose = f.actual.snapshotExportRig(rig);
    ctrl.press('lookAt');
    ctrl.move([0.3, 1.5, 1]);
    await ctrl.release();
    assert.equal(getPoserState().hint, 'no-position-effector');
    assert.equal(hook.layer('actor-a').ikKeys.length, keys, 'nothing keyed');
    assert.deepEqual(f.actual.snapshotExportRig(rig), pose, 'pose unchanged');
  } finally { f.dispose(); }
});

test('poser: reset, flip and paste each key one undoable step', async () => {
  const { f, hook, rig, bridge, ctrl } = setup();
  try {
    const start = bridge.jointPoser(13);
    ctrl.press('leftHand'); ctrl.move([start[0] - 0.2, start[1] + 0.25, start[2] + 0.2]); await ctrl.release();
    const raised = bridge.jointPoser(13);
    ctrl.copy();
    ctrl.flip();
    const flipped = bridge.jointPoser(19), flippedHips = bridge.jointPoser(0);
    assert.ok(near(flipped, [-raised[0], raised[1], raised[2]]) < 0.03, `flip puts the right hand where the left was: ${near(flipped, [-raised[0], raised[1], raised[2]])}`);
    ctrl.reset();
    const arm = rig.getObjectByName('mixamorigLeftArm'), bind = rig.userData.poseBind.get(arm), atRest = bridge.jointPoser(13);
    assert.ok(Math.abs(arm.quaternion.x * bind.x + arm.quaternion.y * bind.y + arm.quaternion.z * bind.z + arm.quaternion.w * bind.w) > 1 - 1e-9, 'reset puts the bones back to rest');
    assert.equal(getPoserState().handles.leftHand.held, false, 'reset restores the start handle state');
    assert.equal(ctrl.paste({ reversed: true }), true);
    const rel = (a, b) => a.map((v, i) => v - b[i]), pasted = rel(bridge.jointPoser(19), bridge.jointPoser(0));
    assert.ok(near(pasted, rel(flipped, flippedHips)) < 0.01, `paste reversed = the flipped pose, relative to the hips (stay in place): ${near(pasted, rel(flipped, flippedHips))}`);
    assert.equal(hook.documentStore.depths().past, 4, 'drag, flip, reset, paste: four steps');
    f.actual.undoScene();
    assert.ok(near(bridge.jointPoser(13), atRest) < 1e-4, 'undoing the paste returns to rest');
  } finally { f.dispose(); }
});

test('poser: a gesture whose release never arrived does not block the tool; Back to T-pose still works', async () => {
  const { f, hook, rig, bridge, ctrl } = setup();
  try {
    const start = bridge.jointPoser(19);
    ctrl.press('rightHand');
    ctrl.move([start[0], start[1] + 0.1, start[2] + 0.1]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ctrl.dragging, 'rightHand', 'the pointer release was lost');
    ctrl.reset();
    assert.equal(ctrl.dragging, null, 'Reset ended the leftover gesture');
    const arm = rig.getObjectByName('mixamorigLeftArm'), bind = rig.userData.poseBind.get(arm);
    assert.ok(Math.abs(arm.quaternion.x * bind.x + arm.quaternion.y * bind.y + arm.quaternion.z * bind.z + arm.quaternion.w * bind.w) > 1 - 1e-9, 'the bones are at rest');
    for (const id of ['hips', 'leftFoot', 'rightFoot', 'leftHand', 'rightHand']) assert.equal(getPoserState().handles[id].left, false, `${id} sits on its joint`);
    assert.ok(bridge.jointPoser(24)[1] > 0 && bridge.jointPoser(24)[1] < 0.15, 'standing on the floor');
    assert.equal(ctrl.press('leftHand'), true, 'a new press works');
    await ctrl.release();
    assert.ok(hook.layer('actor-a').ikKeys.length >= 1);
  } finally { f.dispose(); }
});

test('poser: an out-of-reach drag keeps the held feet, says so, and leaves the handle on the hand', async () => {
  const { f, bridge, ctrl } = setup();
  try {
    const start = bridge.jointPoser(19), feet = [bridge.jointPoser(24), bridge.jointPoser(28)];
    ctrl.press('rightHand');
    for (let i = 1; i <= 8; i += 1) ctrl.move([start[0] - 0.1 * i, start[1] + 0.3 * i, start[2]]);
    await ctrl.release();
    feet.forEach((p, i) => assert.ok(near(bridge.jointPoser([24, 28][i]), p) < 0.03 + 1e-9, `foot ${i} held within 3 cm: ${near(bridge.jointPoser([24, 28][i]), p)}`));
    assert.ok(['out-of-reach', 'held-moved'].includes(getPoserState().hint), getPoserState().hint);
    const place = getPoserState().handles.rightHand.place;
    assert.ok(near(place, bridge.jointPoser(19)) < 0.03, 'the handle stays where the hand got to, not 2 m above it');
  } finally { f.dispose(); }
});

test('poser: characters at stage scale 0.5, 0.8, 1 and 2 pose alike; the network sees each body at its own size', async () => {
  for (const scale of [0.5, 0.8, 1, 2]) {
    const f = motionFixture();
    f.motion.load([{ id: 'actor-a', take: null }]);
    const hook = f.renderMotion(), rig = f.rigs['actor-a'];
    rig.scale.multiplyScalar(scale); // the stage applies stature on the rig root (stage-characters.jsx)
    const bridge = createRigBridge(rig, 'y-bot-tpose', poser), characterId = `actor-a:${(runs += 1)}`;
    updatePoserState({ characterId });
    const ctrl = createPoserController({ characterId, bridge, poser, host: { solve: hook.ikSolve, dragEnd: hook.ikDragEnd } });
    try {
      assert.equal(bridge.facts.s, 0.01, `scale ${scale}: poser metres are the body's own`);
      assert.ok(Math.abs(bridge.stature - scale) < 1e-9, `scale ${scale}: stature read from the rig root`);
      const start = bridge.jointPoser(19), target = [start[0] - 0.06, start[1] + 0.15, start[2] + 0.21];
      const handW = bridge.jointWorld(19, new THREE.Vector3()), feetW = [24, 28].map((j) => bridge.jointWorld(j, new THREE.Vector3()));
      assert.equal(ctrl.press('rightHand'), true);
      ctrl.move(target);
      await ctrl.release();
      const targetW = bridge.toWorld(target), hand = bridge.jointWorld(19, new THREE.Vector3());
      assert.equal(ctrl.stats.refused, 0, `scale ${scale}: no solve refused (${getPoserState().hint})`);
      assert.ok(hand.distanceTo(targetW) < 0.02 * scale, `scale ${scale}: hand within 2 cm (body size) of its handle: ${hand.distanceTo(targetW)}`);
      assert.ok(Math.abs(hand.distanceTo(handW) - targetW.distanceTo(handW)) < 0.02 * scale, `scale ${scale}: the hand moved as far as the stage handle`);
      feetW.forEach((p, i) => assert.ok(bridge.jointWorld([24, 28][i], new THREE.Vector3()).distanceTo(p) < 0.01 * scale, `scale ${scale}: held foot ${i} stays`));
      assert.equal(hook.layer('actor-a').ikKeys.length, 1, `scale ${scale}: one key`);
    } finally { f.dispose(); }
  }
});

test('poser: a solve that lands after the active character changed writes nothing and keys nothing', async () => {
  const { f, hook, rig, bridge, ctrl } = setup();
  try {
    const before = f.actual.snapshotExportRig(rig), start = bridge.jointPoser(19), other = new THREE.Group();
    assert.equal(ctrl.press('rightHand'), true);
    f.scope.activeRig = other; // another character became active while the first solve ran
    ctrl.move([start[0] - 0.06, start[1] + 0.15, start[2] + 0.21]);
    await ctrl.release();
    assert.equal(hook.layer('actor-a').ikKeys.length, 0, 'no key');
    assert.deepEqual(hook.documentStore.depths(), { past: 0, future: 0 }, 'no undo step');
    assert.deepEqual(f.actual.snapshotExportRig(rig), before, 'the rig the solve was for is unchanged');
    f.scope.activeRig = rig;
  } finally { f.dispose(); }
});
