import assert from 'node:assert/strict';
import { test } from 'node:test';
import { castFixture } from './cast-fixture.mjs';
import { STUDIO_PATCHABLE_PATHS } from '../../src/studio-agent-protocol.js';
import { createCharacterEntry } from '../../src/scenes.js';

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const owned = f => assert.ok(f.cast.documentStore?.owns('cast'), 'useCast owns its document slice');
const waypoint = { id: 'waypoint-a', frame: 12, x: 1, z: 2 };
const cases = {
  'character.add': { character: { id: 'actor-c', subject: 'Third actor' } },
  'character.remove': { characterId: 'actor-b' },
  'character.update': { characterId: 'actor-a', patch: { x: 1 } },
  'character.setPose': { characterId: 'actor-a', pose: 'pose-wave' },
  'character.set': { id: 'actor-a', set: { subject: 'Changed' } },
  'character.addWaypoint': { characterId: 'actor-a', frame: 24, position: { x: 1, z: 0 } },
  'character.moveWaypoint': { characterId: 'actor-a', frame: 24, position: { x: 0.8, z: 0 } },
  'character.removeWaypoint': { characterId: 'actor-a', frame: 24 },
  'character.clearWaypoints': { characterId: 'actor-a' },
  'characters.arrange': { ops: [{ op: 'update', characterId: 'actor-a', position: { world: { x: 1, y: 0, z: 0 } } }] },
};
function seed(f, command) {
  if (['character.moveWaypoint', 'character.removeWaypoint', 'character.clearWaypoints'].includes(command))
    ok(f.run('character.addWaypoint', { characterId: 'actor-a', frame: 24, position: { x: 1, z: 0 } }));
}

test('cast: every exposed mutation and origin exercises receipt, undo, expiry, cancellation, revision and concurrent-job fences', async () => {
  for (const [command, args] of Object.entries(cases)) for (const origin of ['ui', 'agent', 'mcp', 'cli']) {
    const f = castFixture();
    try {
      owned(f); seed(f, command);
      const before = f.snapshot();
      const receipt = ok(f.run(command, args, origin));
      assert.equal(receipt.revision.after, receipt.revision.before + 1);
      assert.ok(receipt.affectedIds.length); assert.equal(receipt.undo.entries, 1);
      assert.equal(ok(f.run('edit.undo', { receiptId: receipt.receiptId }, origin)).status, 'undone');
      assert.deepEqual(f.snapshot(), before);
      const expired = ok(f.run(command, args, origin));
      for (let n = 0; n < 51; n++) ok(f.run('character.update', { characterId: 'actor-a', patch: { subject: `Retention ${n}` } }));
      assert.equal(f.run('edit.undo', { receiptId: expired.receiptId }, origin).code, 'UNDO_EXPIRED');
      f.cast.load(before.cast);
      const tx = ok(f.run('run.begin', { id: command, args }, origin));
      ok(f.run('run.update', { txId: tx.txId, args }, origin));
      ok(f.run('run.cancel', { txId: tx.txId }, origin)); assert.deepEqual(f.snapshot(), before);
      const revision = f.binding.refresh().revision;
      ok(f.run('character.update', { characterId: 'actor-a', patch: { subject: 'Concurrent' } }));
      const stale = f.run(command, args, origin, { expectedRevision: revision });
      assert.equal(origin === 'ui' ? stale.ok : stale.code, origin === 'ui' ? true : 'STALE_SCENE');
      f.cast.load(before.cast);
      let release;
      const ready = new Promise(resolve => { release = resolve; });
      f.registry.register({ id: 'fixture.castJob', label: 'Cast job', description: 'Prepared cast write', kind: 'job', domain: 'cast',
        input: { type: 'object', properties: {}, required: [], additionalProperties: false }, available: () => true,
        run: async (_args, context) => { await ready; context.commit(() => f.cast.write([])); return { affectedIds: ['actor-a'], summary: 'Prepared' }; } });
      const pending = f.run('fixture.castJob', {}, origin);
      ok(f.run(command, args, origin)); release();
      assert.equal((await pending).code, 'STALE_TARGET');
      console.log(`PASS real cast parity ${command} ${origin}: all six checks`);
    } finally { f.dispose(); }
  }
});

test('cast: selection changes only the layer projection, never the inspected document', async () => {
  const f = castFixture();
  try {
    owned(f); ok(f.run('character.addWaypoint', { characterId: 'actor-a', frame: 24, position: { x: 1, z: 0 } }));
    ok(f.run('character.addWaypoint', { characterId: 'actor-b', frame: 36, position: { x: 6, z: 0 } }));
    const before = await f.call('inspect_studio', { scope: 'document' });
    const depth = f.cast.documentStore.depths().past;
    f.cast.setActiveCharacterId('actor-b'); f.cast.switchActiveCharacterLayer();
    assert.equal(f.scope.loadedLayerCharRef.current, 'actor-b');
    assert.equal(f.buffer.current.waypoints[0].frame, 36);
    const after = await f.call('inspect_studio', { scope: 'document' });
    assert.deepEqual(after.document, before.document);
    assert.equal(f.cast.documentStore.depths().past, depth);
    assert.deepEqual(after.document.characters, f.cast.read().map(createCharacterEntry));
  } finally { f.dispose(); }
});

test('cast: every patchable path matches patch_elements normalization and field receipts', async () => {
  const values = { position: { x: 500, y: -3, z: 2 }, rot: 380, scale: 8, subject: 'A lead', hidden: true,
    model: 'x-bot-tpose', posture: 'lie', tint: '#123456', identityImage: 'data:image/png;base64,QQ==', pose: 'pose-wave',
    parent: 'cylinder' };
  assert.deepEqual(Object.keys(values).map(key => `character.${key}`).sort(), [...STUDIO_PATCHABLE_PATHS.character].sort());
  for (const [path, value] of Object.entries(values)) {
    const a = castFixture(), b = castFixture();
    try {
      owned(a); owned(b);
      // A character groups under an object that exists (#655).
      if (path === 'parent') for (const f of [a, b]) ok(f.run('object.add', { kind: 'cylinder' }));
      const set = path.split('.').reduceRight((value, key) => ({ [key]: value }), value);
      const direct = ok(a.run('character.set', { id: 'actor-a', set }, 'agent'));
      const alias = ok(await b.call('patch_elements', b.request('patch_elements', { ops: [{ target: { kind: 'character', id: 'actor-a' }, set: { [path]: value } }] })));
      assert.deepEqual(a.cast.read(), b.cast.read(), path);
      assert.deepEqual(direct.delta[0].after.patched.filter(row => row.path === `character.${path}`), alias.delta[0].after.patched, path);
      assert.equal(direct.undo.entries, alias.undo.entries);
    } finally { a.dispose(); b.dispose(); }
  }
});

test('cast: a character groups only under an object that is in the scene (#655)', () => {
  const f = castFixture();
  try {
    owned(f);
    const before = structuredClone(f.cast.read());
    assert.equal(f.run('character.set', { id: 'actor-a', set: { parent: 'missing' } }, 'agent').code, 'STALE_TARGET');
    assert.equal(f.run('character.update', { characterId: 'actor-a', patch: { parent: 'missing' } }).code, 'STALE_TARGET');
    assert.deepEqual(f.cast.read(), before);
  } finally { f.dispose(); }
});

test('cast: a pose with a bone outside POSE_BONES is refused and leaves the cast as it was (#773)', () => {
  const f = castFixture();
  try {
    owned(f);
    const before = structuredClone(f.cast.read());
    const refused = f.run('character.setPose', { characterId: 'actor-a', pose: { id: 'probe', bones: { mixamorigRightArm: [0, 0, 1] } } }, 'agent');
    assert.equal(refused.code, 'INVALID_ARGUMENT');
    assert.match(refused.message, /mixamorigRightArm.*rArm/);
    assert.equal(f.run('character.set', { id: 'actor-a', set: { pose: { id: 'probe', bones: { __probe__: [0, 0, 0] } } } }, 'agent').code, 'INVALID_ARGUMENT');
    assert.deepEqual(f.cast.read(), before);
    const library = structuredClone(f.cast.state().customPoses);
    assert.equal(f.run('cast.savePose', { pose: { id: 'bad', bones: { mixamorigRightArm: [0, 0, 1] } } }).code, 'INVALID_ARGUMENT');
    assert.equal(f.run('cast.setCustomPoses', { poses: [...library, { id: 'bad', bones: { __probe__: [0, 0, 0] } }] }).code, 'INVALID_ARGUMENT');
    assert.deepEqual(f.cast.state().customPoses, library, 'no malformed entry reaches the pose library');
    ok(f.run('character.setPose', { characterId: 'actor-a', pose: { id: 'probe', bones: { rArm: [0, 0, 1] } } }, 'agent'));
  } finally { f.dispose(); }
});

test('cast: moving an object carries the characters grouped under it, in one undo (#655)', () => {
  const f = castFixture();
  try {
    owned(f);
    ok(f.run('object.add', { kind: 'cylinder', placement: { x: 0, z: 0 } }));
    ok(f.run('object.add', { kind: 'cube', parent: 'cylinder', placement: { x: 0, z: 1 } }));
    ok(f.run('character.update', { characterId: 'actor-a', patch: { x: 0.2, z: 0.5, parent: 'cylinder' } }));
    ok(f.run('character.update', { characterId: 'actor-b', patch: { x: 0.1, z: 1, parent: 'cube' } }));
    const seat = () => f.cast.read().map(({ id, x, y, z }) => ({ id, x, y, z }));
    const before = seat();
    const moved = ok(f.run('object.update', { id: 'cylinder', patch: { x: 2, y: 0.5, z: -1 } }));
    const after = seat();
    assert.deepEqual(after.find(row => row.id === 'actor-a'), { id: 'actor-a', x: 2.2, y: 0.5, z: -0.5 });
    // A rider of a part rides the part, which the car's move carried along.
    assert.deepEqual(after.find(row => row.id === 'actor-b'), { id: 'actor-b', x: 2.1, y: 0.5, z: 0 });
    assert.equal(f.run('edit.undo', { receiptId: moved.receiptId }).status, 'undone');
    assert.deepEqual(seat(), before);
    assert.equal(f.store.current.objects.find(row => row.id === 'cylinder').x, 0);
    // Ungrouped, the same move leaves the character where it stands.
    ok(f.run('character.update', { characterId: 'actor-a', patch: { parent: null } }));
    ok(f.run('object.update', { id: 'cylinder', patch: { x: 3 } }));
    assert.equal(f.cast.read().find(row => row.id === 'actor-a').x, 0.2);
  } finally { f.dispose(); }
});

test('cast: raw setters are guarded and scene load resets history without authoring', () => {
  const f = castFixture();
  try {
    owned(f); assert.equal(f.cast.setCharacters, undefined, 'the raw hook setter is retired');
    assert.throws(() => f.cast.write([]), /requires a bus run/);
    ok(f.run('character.update', { characterId: 'actor-a', patch: { x: 1 } }));
    const incoming = [createCharacterEntry({ id: 'loaded', layer: { waypoints: [waypoint] } })];
    f.scope.appContext.loadStoreDomains({ cast: incoming, objects: f.store.current.objects,
      stage: f.live.current.stage, shot: f.scope.shotsDomain.state() });
    assert.deepEqual(f.cast.read(), incoming); assert.equal(f.cast.documentStore.depths().past, 0);
    assert.deepEqual(f.buffer.current.waypoints, incoming[0].layer.waypoints);
  } finally { f.dispose(); }
});

test('cast: the UI may replace the cast with an empty one, and an external apply never throws (#1040)', () => {
  const f = castFixture();
  try {
    owned(f);
    const emptied = ok(f.run('cast.replace', { characters: [] }));
    assert.deepEqual(f.cast.read(), [], 'the last character can go: an empty stage is legal');
    assert.equal(ok(f.run('edit.undo', { receiptId: emptied.receiptId })).status, 'undone');
    assert.equal(f.cast.read().length, 2);
    // The cross-tab scene subscription feeds the cast straight from a store callback.
    assert.doesNotThrow(() => f.cast.applyExternalCharacters([]));
    assert.deepEqual(f.cast.read(), []);
    const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
    try { assert.doesNotThrow(() => f.cast.applyExternalCharacters('not a cast')); } finally { console.warn = warn; }
    assert.equal(warned, 1, 'a refused external cast is logged, not thrown into window.onerror');
  } finally { f.dispose(); }
});
