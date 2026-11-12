// #1185: a refusal of a UI-origin cast command ends at the UI door, logged, never in window.onerror.
// The Outliner's visibility toggle sends character.update; while another UI transaction is open (an inspector
// scrub), the bus refuses it with TARGET_BUSY at admission.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { castFixture } from './cast-fixture.mjs';

test('cast: a refused visibility toggle is logged, not thrown, and leaves the cast alone', () => {
  const f = castFixture();
  try {
    const scrub = f.run('run.begin', { id: 'character.update', args: { characterId: 'actor-a', patch: { x: 2 } } });
    assert.equal(scrub.ok, true, JSON.stringify(scrub));
    const refused = f.run('character.update', { characterId: 'actor-b', patch: { hidden: true } });
    assert.equal(refused.code, 'TARGET_BUSY', 'precondition: the open transaction refuses another cast edit');
    const before = f.snapshot();
    const warn = console.warn, warned = []; console.warn = (...args) => { warned.push(args); };
    try { assert.doesNotThrow(() => f.cast.toggleCharacterHidden('actor-b')); } finally { console.warn = warn; }
    assert.deepEqual(f.snapshot(), before, 'a refused toggle changes nothing');
    assert.equal(warned.length, 1); assert.ok(warned[0].includes('TARGET_BUSY'), JSON.stringify(warned[0]));
    assert.equal(f.run('run.cancel', { txId: scrub.txId }).ok, true);
    assert.equal(f.cast.toggleCharacterHidden('actor-b').ok, true, 'an admitted toggle still answers with its receipt');
    assert.equal(f.cast.read().find(row => row.id === 'actor-b').hidden, true);
  } finally { f.dispose(); }
});
