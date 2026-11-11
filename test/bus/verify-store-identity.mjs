// A write keeps the identity of every record it did not change. Work keyed on identity (a sculpt's mesh is built in a
// useMemo on its recipe) is then redone for the changed record only: before this, every edit rebuilt every sculpt in the
// scene, about 0.25 s each, so one agent action cost 4-5 s in a scene of 15 sculpts.
import assert from 'node:assert/strict';
import { createDocumentStore } from '../../src/document-store.js';

const recipe = id => ({ version: 1, parts: [{ id, shape: 'box', size: [1, 1, 1] }] });
for (const dev of [true, false]) {
  const store = createDocumentStore({ owned: { objects: [{ id: 'a', x: 0, recipe: recipe('a') }, { id: 'b', x: 0, recipe: recipe('b') }], stage: { fog: 0 } }, dev });
  const before = store.read('objects');
  store.recordAction('objects', () => store.write('objects', rows => rows.map(row => (row.id === 'a' ? { ...row, x: 1 } : row))));
  const after = store.read('objects');
  assert.notEqual(after, before, 'the slice is a new value');
  assert.equal(after[1], before[1], 'the untouched record keeps its identity');
  assert.equal(after[1].recipe, before[1].recipe);
  assert.notEqual(after[0], before[0], 'the changed record is new');
  assert.equal(after[0].x, 1);
  assert.equal(after[0].recipe, before[0].recipe, 'and what it did not change inside it is kept');
  assert.equal(store.read('stage'), store.getSnapshot().slices.stage);
  // undo brings back the very records of the earlier snapshot
  store.undo();
  assert.equal(store.read('objects')[0], before[0]);
  store.redo();
  assert.equal(store.read('objects')[0], after[0]);
  // a value from outside is still copied and checked, so a caller cannot reach into the store through it
  const mine = { id: 'c', x: 0, recipe: recipe('c') };
  store.recordAction('objects', () => store.write('objects', rows => [...rows, mine]));
  mine.x = 9; mine.recipe.parts.push({ id: 'late' });
  const added = store.read('objects')[2];
  assert.notEqual(added, mine);
  assert.equal(added.x, 0);
  assert.equal(added.recipe.parts.length, 1);
  assert.throws(() => store.recordAction('objects', () => store.write('objects', rows => [...rows, { id: 'd', keys: new Map() }])), /plain authored/);
  if (dev) assert.throws(() => { store.read('objects')[1].x = 5; }, TypeError);
  store.dispose();
}
console.log('store identity: ok');
