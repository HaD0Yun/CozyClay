// #1185: a refusal of a UI-origin objects command ends at the UI door, logged, never in window.onerror.
// The cross-tab scene subscription feeds objects.replace straight from a store callback; while the user holds
// a drag, the bus refuses it with TARGET_BUSY at admission.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { objectsFixture } from './objects-fixture.mjs';
import { createSceneObject } from '../../src/scene-objects.js';

test('objects: a refused cross-tab objects.replace is logged, not thrown, and leaves the objects alone', () => {
  const f = objectsFixture();
  try {
    const drag = f.run('run.begin', { id: 'object.update', args: {} });
    assert.equal(drag.ok, true, JSON.stringify(drag));
    const before = structuredClone(f.objects.read());
    const incoming = [createSceneObject('cone', [], { x: 7 })];
    const refused = f.run('objects.replace', { objects: incoming });
    assert.equal(refused.code, 'TARGET_BUSY', 'precondition: the open drag refuses objects.replace');
    const warn = console.warn, warned = []; console.warn = (...args) => { warned.push(args); };
    try { assert.doesNotThrow(() => f.objects.applyExternalObjects(incoming)); } finally { console.warn = warn; }
    assert.deepEqual(f.objects.read(), before, 'a refused replace changes nothing');
    assert.equal(warned.length, 1, 'the refusal is logged once');
    assert.ok(warned[0].includes('TARGET_BUSY'), JSON.stringify(warned[0]));
    assert.equal(f.run('run.cancel', { txId: drag.txId }).ok, true);
    const applied = f.objects.applyExternalObjects(incoming);
    assert.equal(applied.ok, true, 'an admitted replace still answers with its receipt');
    assert.deepEqual(f.objects.read(), incoming);
  } finally { f.dispose(); }
});
