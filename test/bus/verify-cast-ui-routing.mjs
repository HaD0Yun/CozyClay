import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { castFixture } from './cast-fixture.mjs';

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
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

