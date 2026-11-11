import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motionFixture, seedMotion } from './motion-fixture.mjs';
test('motion: the shipped IK drag handler previews before Apply and records the pre-drag rig', () => {
  const f = motionFixture();
  try {
    f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
    const hook = f.renderMotion(), before = f.snapshot(), rig = f.actual.snapshotExportRig(f.rigs['actor-a']);
    const chain = f.scope.ikStateRef.current.chains.get('leftHand');
    const target = chain.bones[2].getWorldPosition(chain.bones[2].position.clone());
    target.y += 0.04;
    hook.beginGesture(); hook.ikSolve('chain', 'leftHand', target);
    hook.ikDragEnd(); hook.finishGesture();
    assert.equal(hook.layer('actor-a').ikKeys.length, 0, 'drag end is preview-only');
    target.y += 0.02;
    hook.beginGesture(); hook.ikSolve('chain', 'leftHand', target); hook.ikDragEnd(); hook.finishGesture();
    assert.equal(hook.layer('actor-a').ikKeys.length, 0, 'a second drag does not auto-apply the first');
    assert.deepEqual(hook.documentStore.depths(), { past: 0, future: 0 });
    assert.equal(hook.applyPendingIkEdit(), true, 'Apply commits the preview');
    assert.deepEqual(hook.layer('actor-a').ikKeys.map(key => key.frame), [0, 47]);
    assert.deepEqual(hook.documentStore.depths(), { past: 1, future: 0 }); assert.equal(f.cast.documentStore.depths().past, 0, 'IK does not duplicate history in cast');
    f.actual.undoScene();
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
  } finally { f.dispose(); }
});
test('motion: cancelling a preview restores the rig and leaves no authored keys or history', () => {
  const f = motionFixture();
  try {
    f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
    const hook = f.renderMotion(), before = f.snapshot(), rig = f.actual.snapshotExportRig(f.rigs['actor-a']);
    const chain = f.scope.ikStateRef.current.chains.get('leftHand');
    const target = chain.bones[2].getWorldPosition(chain.bones[2].position.clone()); target.y += 0.04;
    hook.ikSolve('chain', 'leftHand', target); hook.ikDragEnd();
    assert.notDeepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
    assert.equal(hook.cancelPendingIkEdit(), true);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
    assert.deepEqual(hook.documentStore.depths(), { past: 0, future: 0 });
    assert.equal(hook.applyPendingIkEdit(), false);
  } finally { f.dispose(); }
});
test('motion: Ctrl+Z right after an IK drag backs out the un-applied preview', () => {
  const f = motionFixture();
  try {
    f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
    const hook = f.renderMotion(), before = f.snapshot(), rig = f.actual.snapshotExportRig(f.rigs['actor-a']);
    const chain = f.scope.ikStateRef.current.chains.get('leftHand');
    const target = chain.bones[2].getWorldPosition(chain.bones[2].position.clone()); target.y += 0.04;
    hook.beginGesture(); hook.ikSolve('chain', 'leftHand', target); hook.ikDragEnd(); hook.finishGesture();
    assert.equal(f.actual.undoScene().status, 'done');
    assert.deepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(hook.applyPendingIkEdit(), false, 'nothing left to apply');
  } finally { f.dispose(); }
});
test('motion: Ctrl+Z after an authored edit made the IK preview stale undoes that edit', () => {
  const f = motionFixture();
  try {
    f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
    const hook = f.renderMotion();
    const chain = f.scope.ikStateRef.current.chains.get('leftHand');
    const target = chain.bones[2].getWorldPosition(chain.bones[2].position.clone()); target.y += 0.04;
    hook.beginGesture(); hook.ikSolve('chain', 'leftHand', target); hook.ikDragEnd(); hook.finishGesture();
    f.run('ik.setKey', { characterId: 'actor-a', frame: 0, tracks: { head: { q: [{ x: 0, y: 0.2, z: 0, w: Math.sqrt(0.96) }] } } });
    assert.equal(hook.layer('actor-a').ikKeys.length, 1, 'the authored key landed');
    assert.equal(f.actual.undoScene().status, 'undone', 'the first Ctrl+Z undoes the authored key, not the stale preview');
    assert.equal(hook.layer('actor-a').ikKeys.length, 0);
  } finally { f.dispose(); }
});
test('motion: with no take, Ctrl+Z after an IK drag restores the pre-drag rig', () => {
  const f = motionFixture();
  try {
    f.motion.load([{ id: 'actor-a', take: null }]);
    const hook = f.renderMotion(), rig = f.actual.snapshotExportRig(f.rigs['actor-a']);
    const chain = f.scope.ikStateRef.current.chains.get('leftHand');
    const target = chain.bones[2].getWorldPosition(chain.bones[2].position.clone()); target.y += 0.04;
    hook.ikSolve('chain', 'leftHand', target); hook.ikDragEnd();
    assert.equal(hook.layer('actor-a').ikKeys.length, 1, 'the drag keys the playhead');
    f.actual.undoScene();
    assert.equal(hook.layer('actor-a').ikKeys.length, 0);
    assert.deepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
  } finally { f.dispose(); }
});
test('motion: range Apply covers the whole compiled take and persists the span', () => {
  const f = motionFixture();
  try {
    const take = seedMotion();
    f.motion.load([{ id: 'actor-a', take }]);
    f.scope.tlFrame = 30;
    const hook = f.renderMotion(), chain = f.scope.ikStateRef.current.chains.get('leftHand');
    const target = chain.bones[2].getWorldPosition(chain.bones[2].position.clone()); target.y += 0.04;
    hook.ikSolve('chain', 'leftHand', target); hook.ikDragEnd(); hook.applyPendingIkEdit();
    const keys = hook.layer('actor-a').ikKeys;
    assert.deepEqual(keys.map(key => key.frame), [0, 47]);
    assert.ok(keys.every(key => key.tracks.leftHand.correctionRange.start === 0 && key.tracks.leftHand.correctionRange.end === 47));
    const saved = JSON.parse(JSON.stringify(f.snapshot().motion));
    f.motion.load(saved);
    assert.deepEqual(f.scope.ikStateRef.current.keys.get(0).get('leftHand').correctionRange, { start: 0, end: 47 });
  } finally { f.dispose(); }
});
