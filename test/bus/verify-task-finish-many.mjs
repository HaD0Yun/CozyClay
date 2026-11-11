// A task whose edits touched more than 100 objects finishes normally: the receipt names the first 100 ids (the
// protocol's cap on affectedIds) and output.affectedCount says how many in all. It used to fail at its finish with
// INVALID_RECEIPT ($.affectedIds: expected at most 100 items) although the scene was fine. Cancel and undo-task too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { objectsFixture } from './objects-fixture.mjs';
import { validateReceipt } from '../../src/studio-agent-protocol.js';

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 600)); return receipt; };

function taskOver100(f, taskId) {
  const run = (action, args) => f.run(action, args, 'agent', { taskId, expectedRevision: 0 });
  ok(run('task.begin', { taskId, scope: ['object:cube'] }));
  for (let i = 0; i < 104; i++) ok(run('object.duplicate', { objectId: 'cube' }));
  return run;
}

test('a task that touched 104 objects finishes, naming 100 ids and the true count', () => {
  const f = objectsFixture();
  try {
    const before = f.objects.read().length, run = taskOver100(f, 'task-many');
    const finished = ok(run('task.finish', { taskId: 'task-many' }));
    assert.equal(finished.affectedIds.length, 100);
    assert.equal(finished.output.affectedCount, 104);
    assert.equal(f.objects.read().length, before + 104, 'every copy stays');
    // undo-task still knows every id, not just the 100 the receipt names
    const undone = ok(f.run('task.undo', { taskId: 'task-many' }, 'agent'));
    assert.equal(undone.output.affectedCount, 104);
    assert.equal(f.objects.read().length, before);
  } finally { f.dispose(); }
});

test('cancel of a task over 100 objects answers too', () => {
  const f = objectsFixture();
  try {
    const before = f.objects.read().length, run = taskOver100(f, 'task-cancel');
    const cancelled = ok(run('task.cancel', { taskId: 'task-cancel' }));
    assert.ok(cancelled.affectedIds.length <= 100);
    assert.equal(f.objects.read().length, before);
  } finally { f.dispose(); }
});

test('an ordinary receipt over 100 ids is still refused by the protocol', () => {
  assert.throws(() => validateReceipt({ ok: true, status: 'noop', commandId: 'c', receiptId: 'r', host: { workspaceId: 'w', documentEpoch: 'd', sceneId: 's', sceneEpoch: 'e' },
    authored: false, mutated: false, revision: { before: 1, after: 1 }, affectedIds: Array.from({ length: 101 }, (_, i) => `id-${i}`), delta: [], checks: { coverage: 'test' }, undo: null, warnings: [] }),
  /affectedIds/);
});
