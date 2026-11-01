// The editor's busy predicate (src/studio-busy.js): which editor states refuse an agent or task command with the
// gesture TARGET_BUSY, and which never do. Through the real App binding: the user's drag transaction is busy, a task
// may still begin and finish under it, and nothing else the user does (a click, a selection, playback) counts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { studioBusy, uiTransactionOpen } from '../../src/studio-busy.js';
import { objectsFixture } from './objects-fixture.mjs';

const GESTURE = 'Finish the current editor gesture first.';

test('the predicate: drags, IK body drags and recording are busy; nothing else is', () => {
  assert.equal(studioBusy(), false);
  assert.equal(studioBusy({}), false);
  assert.equal(studioBusy({ uiTransaction: false, ikBodyDrag: false, recording: null }), false);
  assert.equal(studioBusy({ uiTransaction: true }), true);
  assert.equal(studioBusy({ ikBodyDrag: true }), true);
  assert.equal(studioBusy({ recording: { id: 'rec' } }), true);
});

test('only a transaction the user opened is a gesture', () => {
  assert.equal(uiTransactionOpen(new Map()), false);
  assert.equal(uiTransactionOpen(new Map([['a', { origin: 'agent' }]])), false);
  assert.equal(uiTransactionOpen(new Map([['a', { origin: 'agent' }], ['u', { origin: 'ui' }]])), true);
});

test('through the App: a user drag refuses a task edit, lets the task begin and finish, and frees on commit', () => {
  const f = objectsFixture();
  try {
    const cube = f.store.current.objects.find(o => o.renderer === 'cube').id;
    const sphere = f.store.current.objects.find(o => o.renderer === 'sphere').id;
    const task = (action, args = {}) => f.run(action, args, 'agent', { taskId: 'task-a', expectedRevision: 0 });
    const move = (objectId, x) => task('object.set', { id: objectId, set: { position: { x, y: 0, z: 0 } } });
    // Nothing held: a selection or view change by the user is no gesture.
    assert.equal(f.binding.refresh().busy, false);
    // The user grabs the sphere: its drag holds a UI transaction until release.
    const drag = f.run('run.begin', { id: 'object.update', args: {} });
    assert.equal(drag.ok, true, JSON.stringify(drag));
    assert.equal(f.binding.refresh().busy, true);
    const begun = task('task.begin', { taskId: 'task-a', scope: [`object:${cube}`] });
    assert.equal(begun.ok, true, JSON.stringify(begun));
    const refused = move(cube, 1);
    assert.equal(refused.ok, false); assert.equal(refused.code, 'TARGET_BUSY'); assert.equal(refused.message, GESTURE);
    assert.equal(f.run('run.update', { txId: drag.txId, args: { id: sphere, patch: { x: 2 } } }).ok, true);
    assert.equal(f.run('run.commit', { txId: drag.txId }).ok, true);
    // Released: the same command now lands.
    assert.equal(f.binding.refresh().busy, false);
    assert.equal(move(cube, 1).ok, true);
    // Another drag opened before the task finishes: finish still closes the task.
    const second = f.run('run.begin', { id: 'object.update', args: {} });
    assert.equal(task('task.finish', { taskId: 'task-a' }).ok, true);
    f.run('run.cancel', { txId: second.txId });
    assert.equal(f.binding.refresh().busy, false);
  } finally { f.dispose(); }
});
