#!/usr/bin/env node
// #635: rig-only features refuse a capsule figure by name; rigged characters
// in the same scene keep every feature.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { characterCapabilities, kindRefusal, refuseRigOnly, capabilityRefusal, importedRefusal, CHARACTER_CAPABILITIES } from '../src/character-kind.js';
import { planPoseEntry } from '../src/pose-entry.js';
import { createCharacterEntry, PROXY_FIGURE_MODEL } from '../src/scenes.js';
import { isKo } from '../src/locale.js';
import { motionFixture, seedMotion } from './bus/motion-fixture.mjs';
import { PROXY_ID } from './bus/cast-fixture.mjs';

const proxy = createCharacterEntry({ id: 'p', model: PROXY_FIGURE_MODEL });
const rigged = createCharacterEntry({ id: 'r', model: 'y-bot-tpose' });
const tracks = { head: { q: [{ x: 0, y: Math.sin(0.2), z: 0, w: Math.cos(0.2) }] } };
const refused = (receipt, feature) => {
  assert.equal(receipt.ok, false, JSON.stringify(receipt));
  assert.equal(receipt.code, 'TARGET_NOT_READY');
  assert.equal(receipt.message, kindRefusal(feature, false));
};

test('capabilities: all false for a capsule figure, all true for a rigged character', () => {
  assert.deepEqual(CHARACTER_CAPABILITIES, ['rig', 'ik', 'pose', 'motion']);
  assert.deepEqual({ ...characterCapabilities(proxy) }, Object.fromEntries(CHARACTER_CAPABILITIES.map(name => [name, false])));
  assert.deepEqual({ ...characterCapabilities(rigged) }, Object.fromEntries(CHARACTER_CAPABILITIES.map(name => [name, true])));
});

// an imported character (character-rig.js) by its model id: it plays takes on its own bones, but Pose mode and IK
// write the X Bot's bones and rest pose
const imported = { id: 'i', model: 'rig-0123456789abcdef-auto' };
test('capabilities: an imported character keeps its rig and motion, and has no IK or Pose mode', () => {
  assert.deepEqual({ ...characterCapabilities(imported) }, { rig: true, ik: false, pose: false, motion: true });
  assert.equal(importedRefusal('pose', false), 'Imported characters play compiled takes on their own bones - Pose mode works on the X Bot and Y Bot only.');
  assert.equal(capabilityRefusal(imported, 'pose'), importedRefusal('pose', false));
  assert.equal(capabilityRefusal(imported, 'motion'), null);
  assert.equal(capabilityRefusal(proxy, 'pose'), kindRefusal('pose', false));
  assert.equal(capabilityRefusal(rigged, 'pose'), null);
  for (const feature of ['ik', 'pose']) assert.throws(() => refuseRigOnly(imported, feature), { code: 'TARGET_NOT_READY', message: importedRefusal(feature, false), uiMessage: importedRefusal(feature, isKo) });
  assert.equal(refuseRigOnly(imported, 'motion'), undefined);
  // the Pose tab with the imported character active: the one posable character (the Y Bot) is selected instead
  assert.deepEqual(planPoseEntry([imported, rigged], imported, importedRefusal('pose')), { selectId: rigged.id });
  assert.equal(planPoseEntry([imported], imported, importedRefusal('pose')).reason, importedRefusal('pose'));
});

test('kindRefusal: exact en/ko sentences', () => {
  assert.equal(kindRefusal('Pose mode', false), 'Capsule figures have no rig - Pose mode works on rigged characters only.');
  assert.equal(kindRefusal('Pose mode', true), '캡슐 인물은 리그가 없어요 - Pose mode는 리그 인물에서만 됩니다.');
  assert.equal(kindRefusal('motion', false), 'Capsule figures have no rig - Compiled motion works on rigged characters only.');
  assert.equal(kindRefusal('motion', true), '캡슐 인물은 리그가 없어요 - 모션 컴파일는 리그 인물에서만 됩니다.');
  assert.throws(() => refuseRigOnly(proxy, 'ik'), { code: 'TARGET_NOT_READY', message: kindRefusal('ik', false), uiMessage: kindRefusal('ik', isKo) });
  assert.equal(refuseRigOnly(rigged, 'ik'), undefined);
});

test('bus: motion.compile refuses a capsule figure and compiles for a rig', async () => {
  const f = motionFixture({ proxy: true });
  try {
    assert.equal(f.cast.read().find(row => row.id === PROXY_ID).model, PROXY_FIGURE_MODEL);
    const before = f.snapshot();
    const spec = { schema: 'cozyclay.motion-spec.v1', fps: 24, frames: 24, keys: [] };
    const proxyReceipt = await f.run('motion.compile', { characterId: PROXY_ID, spec, install: false }, 'agent');
    assert.equal(proxyReceipt.ok, false, JSON.stringify(proxyReceipt));
    assert.equal(proxyReceipt.code, 'TARGET_NOT_READY');
    assert.deepEqual(f.snapshot(), before);
    const rig = await f.run('motion.compile', { characterId: 'actor-a', spec, install: false }, 'agent');
    assert.equal(rig.ok, true, JSON.stringify(rig));
  } finally { f.dispose(); }
});

test('bus: IK keys and poses refuse a capsule figure; the rig keeps them', async () => {
  const f = motionFixture({ proxy: true });
  try {
    const take = seedMotion();
    f.motion.load([{ id: 'actor-a', take, fullTake: take }, { id: 'actor-b' }, { id: PROXY_ID }]);
    const before = f.snapshot();
    for (const id of ['character.setIkKey', 'ik.setKey']) refused(f.run(id, { characterId: PROXY_ID, frame: 0, tracks }, 'agent'), 'ik');
    refused(f.run('ik.applyPose', { characterId: PROXY_ID, frame: 0, pose: { bones: {}, rootY: 0 } }, 'agent'), 'pose');
    assert.deepEqual(f.snapshot(), before);
    const keyed = f.run('ik.setKey', { characterId: 'actor-a', frame: 0, tracks }, 'agent');
    assert.equal(keyed.ok, true, JSON.stringify(keyed));
    assert.equal(f.motion.layer('actor-a').ikKeys.length, 1);
  } finally { f.dispose(); }
});
