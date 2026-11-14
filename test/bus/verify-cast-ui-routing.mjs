import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { castFixture } from './cast-fixture.mjs';

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
test('an empty cast has no invented active character identity', () => {
  const f = castFixture();
  try {
    f.cast.load([]);
    const empty = f.renderCast();
    assert.deepEqual(empty.characters, []);
    assert.equal(empty.activeChar.id, null);
    assert.equal(empty.activeRig, null);
  } finally { f.dispose(); }
});

test('visibility edits name one member and preserve its two neighbors', () => {
  const f = castFixture();
  try {
    ok(f.run('character.add', { character: { id: 'actor-third', x: 8 } }));
    const before = f.snapshot();
    const hidden = ok(f.run('character.update', { characterId: 'actor-b', patch: { hidden: true } }));
    assert.deepEqual(f.cast.read().map(c => [c.id, c.hidden]), [['actor-a', false], ['actor-b', true], ['actor-third', false]]);
    ok(f.run('edit.undo', { receiptId: hidden.receiptId }));
    assert.deepEqual(f.snapshot(), before);
  } finally { f.dispose(); }
});

test('row and raw-pick routing preserve dotted and prefixed stable IDs', () => {
  const f = castFixture();
  try {
    const ids = ['actor.v1', 'char:side', 'side'];
    f.cast.load(ids.map(id => ({ id })));
    const cast = f.renderCast();
    for (const [index, id] of ids.entries()) {
      const row = cast.rowIdForCharIndex(index);
      assert.equal(cast.charKeyToHierarchyId(id), row);
      assert.equal(cast.charIdFromHierarchyId(row), id);
      assert.equal(cast.charIdFromHierarchyId(`${row}.rig.rightHand`), id);
    }
    assert.equal(cast.rowIdForCharIndex(0), 'character:actor%2Ev1');
    assert.equal(cast.rowIdForCharIndex(1), 'character:char%3Aside');
  } finally { f.dispose(); }
});

test('cast panels route their authored handlers through run rather than native snapshot callbacks', () => {
  const panels = ['SubjectsPanel', 'CharacterTransformPanel', 'RigPanel', 'PosePanel'];
  let sites = 0;
  for (const name of panels) {
    const source = readFileSync(new URL(`../../src/panels/${name}.jsx`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(?:recordCharacterUndo|recordSessionUndo|beginGestureUndo)\b/, name);
    sites += [...source.matchAll(/on[A-Z][A-Za-z]+[\s\S]{0,240}?\brun\s*\(/g)].length;
  }
  assert.ok(sites >= 14, `measured cast panel run sites: ${sites}`);
});

test('cast UI gestures and legacy mutators use retained commands without creating native cast history', () => {
  const f = castFixture();
  try {
    const before = f.snapshot();
    f.cast.beginGesture();
    for (const x of [0.5, 1, 1.5]) ok(f.cast.updateCharacterAt(0, { x }));
    const receipt = ok(f.cast.finishGesture());
    assert.deepEqual(f.cast.documentStore.depths(), { past: 1, future: 0 }, 'the scrub has exactly one store entry');
    ok(f.run('edit.undo', { receiptId: receipt.receiptId })); assert.deepEqual(f.snapshot(), before);
    const handlers = f.cast.createLegacyCastHandlers((args, keys) => Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]])),
      (rows, ref) => rows.find(row => row.id === ref));
    const added = handlers.add_character({ subject: 'Added from legacy', x: 2 });
    assert.ok(f.cast.read().some(row => row.id === added.id));
    handlers.update_character({ ref: added.id, subject: 'Updated from legacy' });
    assert.equal(f.cast.read().find(row => row.id === added.id).subject, 'Updated from legacy');
    handlers.remove_character({ ref: added.id }); assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.cast.documentStore.depths(), { past: 3, future: 0 }, 'add, update and remove each own one entry');
  } finally { f.dispose(); }
});

test('pose library save and removal compose with every affected character and survive undo', () => {
  const f = castFixture();
  try {
    const before = f.snapshot(), pose = { id: 'saved-pose', bones: {}, custom: true, label: 'Saved' };
    const saved = ok(f.run('cast.savePose', { pose, characterId: 'actor-b' }));
    assert.equal(f.cast.state().customPoses[0].id, pose.id);
    assert.equal(f.cast.read()[1].pose.id, pose.id);
    ok(f.run('edit.undo', { receiptId: saved.receiptId })); assert.deepEqual(f.snapshot(), before);
    ok(f.run('cast.savePose', { pose, characterId: 'actor-b' }));
    const withPose = f.snapshot();
    const removed = ok(f.run('cast.removePose', { id: pose.id }));
    assert.equal(f.cast.state().customPoses.length, 0); assert.notEqual(f.cast.read()[1].pose?.id, pose.id);
    ok(f.run('edit.undo', { receiptId: removed.receiptId })); assert.deepEqual(f.snapshot(), withPose);
  } finally { f.dispose(); }
});
