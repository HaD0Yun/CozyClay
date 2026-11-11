// object.duplicate's copies form through the real objects domain: many varied copies in one call and one undo
// entry, in the order given, for a primitive, a sculpt and a group root; invalid input refused with the allowed
// values; the 100-object receipt cap; one copy re-sculpted alone. The one-copy form keeps working.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { objectsFixture } from './objects-fixture.mjs';

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const refused = (receipt, pattern) => { assert.equal(receipt.ok, false, JSON.stringify(receipt)); assert.equal(receipt.code, 'INVALID_ARGUMENT'); assert.match(receipt.message, pattern); return receipt; };
const row = (f, id) => f.objects.read().find(object => object.id === id);
const pillar = { version: 1, parts: [{ id: 'body', shape: 'cylinder', size: [0.4, 1.2, 0.4], position: [0, 0.6, 0], color: '#8a7a6a' }] };

test('copies of a primitive land in order, varied, as one undo entry', () => {
  const f = objectsFixture();
  try {
    const before = f.objects.read().length;
    const copies = [{ x: 1, z: 2, rot: 45, scale: 2, color: '#f00' }, { x: -3, z: 0.5, y: 0.25, scale: [1, 2, 0.5] }, { x: 4, z: -4, rot: -90 }];
    const receipt = ok(f.run('object.duplicate', { objectId: 'cube', copies }));
    assert.equal(receipt.affectedIds.length, 3);
    assert.equal(f.objects.read().length, before + 3);
    const [a, b, c] = receipt.affectedIds.map(id => row(f, id));
    assert.deepEqual([a.x, a.z, a.rot, a.scaleX, a.scaleY, a.color], [1, 2, 45, 2, 2, '#ff0000']);
    assert.deepEqual([b.x, b.y, b.z, b.scaleX, b.scaleY, b.scaleZ], [-3, 0.25, 0.5, 1, 2, 0.5]);
    assert.equal(b.color, row(f, 'cube').color, 'no colour keeps the source colour');
    assert.equal(c.rot, -90);
    assert.equal(new Set(receipt.affectedIds).size, 3);
    assert.equal(new Set(f.objects.read().map(object => object.name)).size, f.objects.read().length, 'names stay unique');
    ok(f.run('edit.undo', {}));
    assert.equal(f.objects.read().length, before, 'one undo takes every copy back');
  } finally { f.dispose(); }
});

test('inside a turn the answer lists each copy with its size, in order', () => {
  const f = objectsFixture();
  try {
    ok(f.run('agent.turn.begin', { turnId: 't1' }, 'agent', { turnId: 't1' }));
    const receipt = ok(f.run('object.duplicate', { objectId: 'cube', copies: [{ x: 0, z: 3, scale: 0.5 }, { x: 2, z: 3, scale: [1, 3, 1] }] }, 'agent', { turnId: 't1' }));
    assert.equal(receipt.status, 'completed');
    const [first, second] = receipt.output.copies;
    assert.deepEqual(receipt.output.copies.map(copy => copy.id), receipt.affectedIds);
    assert.deepEqual(first.scale, [0.5, 0.5, 0.5]);
    assert.equal(second.size.height, row(f, 'cube').height * 3);
    ok(f.run('agent.turn.finish', { turnId: 't1' }, 'agent', { turnId: 't1' }));
  } finally { f.dispose(); }
});

test('invalid copies are refused, not clamped, and the message names the allowed values', () => {
  const f = objectsFixture();
  try {
    const before = JSON.stringify(f.objects.read());
    const run = copies => f.run('object.duplicate', { objectId: 'cube', copies });
    refused(run([{ x: 300, z: 0 }]), /copies\[0\]\.x: 300 is outside -240\.\.240 m/);
    refused(run([{ x: 0, z: 0 }, { x: 0, z: 0, scale: 20 }]), /copies\[1\]\.scale: 20 is outside 0\.1\.\.10/);
    refused(run([{ x: 0, z: 0, scale: [1, 0, 1] }]), /scale\[1\]: 0 is outside 0\.1\.\.10/);
    refused(run([{ x: 0, z: 0, rot: 720 }]), /rot: 720 is outside -360\.\.360/);
    refused(run([{ x: 0, z: 0, y: -1 }]), /y: -1 is outside 0\.\.240/);
    refused(run([{ x: 0, z: 0, color: 'leafy' }]), /#rrggbb/);
    refused(run([]), /copies/);
    refused(run(Array.from({ length: 65 }, (_, x) => ({ x, z: 0 }))), /64/);
    refused(run([{ x: 0 }]), /z/);
    assert.equal(JSON.stringify(f.objects.read()), before, 'nothing was written');
  } finally { f.dispose(); }
});

test('a group root copies its whole subtree, scaled uniformly about its pivot and turned rigidly', () => {
  const f = objectsFixture();
  try {
    ok(f.run('object.set', { id: 'cube', set: { position: { x: 0, y: 0, z: 0 } } }));
    ok(f.run('object.set', { id: 'sphere', set: { position: { x: 1, y: 0, z: 0 } } }));
    ok(f.run('object.set', { id: 'cylinder', set: { position: { x: 0, y: 0, z: 2 } } }));
    ok(f.run('object.group', { parent: 'cube', children: ['sphere', 'cylinder'] }));
    const receipt = ok(f.run('object.duplicate', { objectId: 'cube', copies: [{ x: 10, z: 10, rot: 90, scale: 2 }] }));
    assert.equal(receipt.affectedIds.length, 3, 'root and both members');
    const [root, ...members] = receipt.affectedIds.map(id => row(f, id));
    assert.deepEqual([root.x, root.z, root.rot, root.scaleX], [10, 10, 90, 2]);
    assert.ok(members.every(member => member.parent === root.id), 'members hang off the new root');
    const sphere = members.find(member => member.renderer === 'sphere');
    // Offset (1, 0, 0) doubled and yawed 90 degrees: (0, 0, -2) from the new pivot.
    assert.ok(Math.abs(sphere.x - 10) < 1e-6 && Math.abs(sphere.z - 8) < 1e-6, JSON.stringify(sphere));
    assert.equal(sphere.scaleX, 2);
    assert.equal(row(f, 'sphere').parent, 'cube', 'the source group is untouched');
    refused(f.run('object.duplicate', { objectId: 'cube', copies: [{ x: 0, z: 0, scale: [1, 2, 1] }] }), /group copy scales uniformly/);
  } finally { f.dispose(); }
});

test('one call makes at most 100 objects: a group of 3 copies 33 times, not 34', () => {
  const f = objectsFixture();
  try {
    ok(f.run('object.group', { parent: 'cube', children: ['sphere', 'cylinder'] }));
    const many = n => Array.from({ length: n }, (_, i) => ({ x: i - 20, z: 5 }));
    refused(f.run('object.duplicate', { objectId: 'cube', copies: many(34) }), /group of 3 objects, so one call makes at most 33 copies/);
    assert.equal(ok(f.run('object.duplicate', { objectId: 'cube', copies: many(33) })).affectedIds.length, 99);
    assert.equal(ok(f.run('object.duplicate', { objectId: 'sphere', copies: many(64) })).affectedIds.length, 64);
  } finally { f.dispose(); }
});

test('sculpt copies share the recipe; re-sculpting one copy changes only that copy', () => {
  const f = objectsFixture();
  try {
    const id = ok(f.run('object.sculpt', { recipe: pillar })).affectedIds[0];
    const copies = ok(f.run('object.duplicate', { objectId: id, copies: Array.from({ length: 6 }, (_, i) => ({ x: i, z: -3, scale: 1 + i / 10 })) })).affectedIds;
    // Equal recipes share one build (src/shared-sculpt.js keys builds by content).
    for (const copy of copies) assert.deepEqual(row(f, copy).recipe, row(f, id).recipe);
    ok(f.run('object.sculpt', { id: copies[2], edits: [{ set: 'body', color: '#d94a4a' }] }));
    assert.equal(row(f, copies[2]).recipe.parts[0].color, '#d94a4a');
    for (const other of [id, ...copies.filter(copy => copy !== copies[2])]) assert.equal(row(f, other).recipe.parts[0].color, '#8a7a6a');
  } finally { f.dispose(); }
});

test('the one-copy form still places one copy half a metre beside the source', () => {
  const f = objectsFixture();
  try {
    const receipt = ok(f.run('object.duplicate', { objectId: 'cube' }));
    assert.equal(receipt.affectedIds.length, 1);
    assert.equal(row(f, receipt.affectedIds[0]).x, row(f, 'cube').x + 0.5);
  } finally { f.dispose(); }
});
