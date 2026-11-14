import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { shotsFixture, seedShot, framing } from './shots-fixture.mjs';
import { createShotAuthoringDocument } from '../../src/shot-authoring.js';
import { STUDIO_PATCHABLE_PATHS } from '../../src/studio-agent-protocol.js';
import { scanTree } from './verify-bus-coverage.mjs';
import { fileURLToPath } from 'node:url';
import { declarations } from '../../src/commands/shot.js';

const origins = ['ui', 'agent', 'mcp', 'cli'];
const inputs = {
  'shot.create': {}, 'shot.split': { shotId: 'shot-a' }, 'shot.duplicate': { shotId: 'shot-a' }, 'shot.remove': { shotId: 'shot-a' },
  'shot.setRange': { shotId: 'shot-a', range: { startFrame: 1, endFrameExclusive: 23 } },
  'shot.reorder': { shotId: 'shot-a', startFrame: 25 },
  'shot.setCameraRail': { shotId: 'shot-a', points: [{ x: -2, z: 4 }, { x: 2, z: 4 }] },
  'shot.clearCameraRail': { shotId: 'shot-a' },
  'shot.rename': { shotId: 'shot-a', name: 'Wide' }, 'shot.setCameraMode': { shotId: 'shot-a', mode: 'follow' },
  'shot.createStill': { caption: 'Panel' }, 'shot.setCaption': { shotId: 'shot-a', caption: 'Panel' },
  'shot.setCastOverride': { shotId: 'shot-a', characterId: 'actor-a', override: { x: 1, z: 2, rot: 0 } }, 'shot.setHold': { shotId: 'shot-a', hold: 12 },
  'shot.set': { id: 'shot-a', set: { targetModel: 'seedance-2.5' } },
  'shot.frame': { subjectIds: ['actor-a'], keyAtFrame: 5, framing: { exact: { position: { x: 1, y: 2, z: 6 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35 } } },
};
assert.deepEqual(Object.keys(inputs).sort(), declarations.filter(row => row.kind === 'mutation' && row.exposure !== 'ui-only').map(row => row.id).sort());
function owned(f) { assert.ok(f.shots.documentStore?.owns('shot'), 'the shipped useShots hook must own the shot slice'); }
function seed(f, command) {
  const shot = seedShot();
  if (['shot.setHold', 'shot.createStill'].includes(command)) shot.kind = 'still';
  if (command === 'shot.clearCameraRail') Object.assign(shot.camera, { mode: 'rail', cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }] });
  f.shots.load({ shots: [shot], frameCount: 120, camera: f.actual.readStudioState().camera });
  f.live.current.timeline.currentFrame = command === 'shot.create' ? 30 : 12;
}
test('1: every shot action and origin runs the six parity checks through real App wiring', async () => {
  for (const [command, args] of Object.entries(inputs)) for (const origin of origins) {
    const f = shotsFixture();
    try {
      owned(f); seed(f, command);
      const before = f.snapshot(), receipt = f.run(command, args, origin);
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      assert.equal(receipt.revision.after, receipt.revision.before + 1);
      assert.ok(receipt.undo?.historyEntryId);
      assert.ok(receipt.affectedIds.length);
      assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }, origin).status, 'undone');
      assert.deepEqual(f.snapshot(), before);
      const expired = f.run(command, args, origin);
      for (let i = 0; i < 51; i++) assert.equal(f.run('shot.setTimeline', { frameCount: 200 + i }).ok, true);
      assert.equal(f.run('edit.undo', { receiptId: expired.receiptId }, origin).code, 'UNDO_EXPIRED');
      seed(f, command);
      const saved = f.snapshot();
      const tx = f.run('run.begin', { id: command, args }, origin);
      assert.equal(tx.ok, true, JSON.stringify(tx));
      assert.equal(f.run('run.update', { txId: tx.txId, args }, origin).ok, true);
      assert.equal(f.run('run.cancel', { txId: tx.txId }, origin).ok, true);
      assert.deepEqual(f.snapshot(), saved);
      const revision = f.binding.refresh().revision;
      f.run('shot.setTimeline', { frameCount: 180 });
      const stale = f.run(command, args, origin, { expectedRevision: revision });
      assert.equal(origin === 'ui' ? stale.ok : stale.code, origin === 'ui' ? true : 'STALE_SCENE');
      seed(f, command);
      let release;
      const ready = new Promise(resolve => { release = resolve; });
      f.registry.register({ id: 'fixture.shotJob', label: 'Shot job', description: 'Shot job', kind: 'job', domain: 'shot',
        input: { type: 'object', properties: {}, required: [], additionalProperties: false }, available: () => true,
        run: async (_args, context) => { await ready; context.commit(() => f.shots.setShots([])); return { affectedIds: ['shot-a'], summary: 'Prepared shot' }; } });
      const job = f.run('fixture.shotJob', {}, origin);
      f.run(command, args, origin);
      release();
      assert.equal((await job).code, 'STALE_TARGET');
      console.log(`PASS real shots parity ${command} ${origin}: receipt, undo, expiry, cancel, stale revision, concurrent job`);
    } finally { f.dispose(); }
  }
});
test('2: a UI keyframe drag commits one history entry and one authored receipt; cancellation restores', () => {
  const f = shotsFixture();
  try {
    owned(f); const before = f.snapshot(), depth = f.shots.documentStore.depths().past;
    const tx = f.run('run.begin', { id: 'shot.moveKey', args: { shotId: 'shot-a', keyId: 'key-a', frame: 0 } });
    for (const frame of [3, 6, 9]) {
      const preview = f.run('run.update', { txId: tx.txId, args: { shotId: 'shot-a', keyId: 'key-a', frame } });
      assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(preview.authored, false); assert.equal(preview.undo, null);
    }
    const committed = f.run('run.commit', { txId: tx.txId });
    assert.equal(committed.undo.entries, 1);
    assert.equal(f.shots.documentStore.depths().past, depth + 1);
    assert.equal(f.live.current.shots[0].cameraKeys[0].frame, 9);
    assert.equal(f.run('edit.undo', { receiptId: committed.receiptId }).status, 'undone');
    assert.deepEqual(f.snapshot(), before);
    const cancel = f.run('run.begin', { id: 'shot.moveKey', args: { shotId: 'shot-a', keyId: 'key-a', frame: 0 } });
    f.run('run.update', { txId: cancel.txId, args: { shotId: 'shot-a', keyId: 'key-a', frame: 4 } });
    f.run('run.cancel', { txId: cancel.txId }); assert.deepEqual(f.snapshot(), before);
  } finally { f.dispose(); }
});
test('3: every patchable shot path shares normalization and readback with patch_elements', async () => {
  const values = { 'shot.cameraKeys': [{ id: 'key-b', frame: 8, framing }], 'shot.subjectIds': ['actor-a', 'actor-b'], 'shot.targetModel': 'seedance-2.5' };
  assert.deepEqual(Object.keys(values).sort(), [...STUDIO_PATCHABLE_PATHS.shot].sort());
  for (const [path, value] of Object.entries(values)) {
    const a = shotsFixture(), b = shotsFixture();
    try {
      owned(a); owned(b);
      const set = { [path.slice(5)]: value };
      const direct = a.run('shot.set', { id: 'shot-a', set }, 'agent');
      const alias = await b.call('patch_elements', b.request('patch_elements', { ops: [{ target: { kind: 'shot', id: 'shot-a' }, set }] }));
      assert.equal(direct.ok, true, JSON.stringify(direct)); assert.equal(alias.ok, true, JSON.stringify(alias));
      assert.deepEqual(a.shots.read(), b.shots.read());
      for (const key of ['status', 'authored', 'revision', 'affectedIds']) assert.deepEqual(direct[key], alias[key], key);
      assert.deepEqual(direct.delta[0].after.patched.filter(row => row.path === path), alias.delta[0].after.patched);
      assert.equal(direct.undo.entries, alias.undo.entries);
    } finally { a.dispose(); b.dispose(); }
  }
});
test('4: inspect document returns the persisted shot projection and schema, including id filtering', async () => {
  const f = shotsFixture();
  try {
    const inspected = await f.call('inspect_studio', { scope: 'document', select: ['shots'] });
    assert.deepEqual(inspected.document.shots, createShotAuthoringDocument({ shots: f.live.current.shots, frameCount: f.live.current.timeline.frameCount }).shots);
    assert.ok(inspected.schema.shots);
    const selected = await f.call('inspect_studio', { scope: 'document', ids: ['shot-a'] });
    assert.deepEqual(selected.document.shots, inspected.document.shots);
  } finally { f.dispose(); }
});
test('5: agent frame_shot aliases shot.frame; the set_camera preset uses the same command and camera undoes', async () => {
  const a = shotsFixture(), b = shotsFixture();
  try {
    owned(a); owned(b);
    const args = { subjectIds: ['actor-a'], framing: { exact: { position: { x: 1, y: 2, z: 6 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35 } } };
    const before = a.actual.readStudioState().camera;
    const direct = a.run('shot.frame', args, 'agent');
    const alias = await b.call('frame_shot', b.request('frame_shot', args));
    assert.equal(direct.ok, true, JSON.stringify(direct)); assert.equal(alias.ok, true, JSON.stringify(alias));
    for (const key of ['action', 'status', 'authored', 'affectedIds', 'delta']) assert.deepEqual(direct[key], alias[key]);
    assert.equal(a.run('edit.undo', { receiptId: direct.receiptId }).status, 'undone');
    assert.deepEqual(a.actual.readStudioState().camera, before);
    const preset = a.shots.setLiveCamera({ preset: 'mocapInteraction' });
    const same = b.run('shot.frame', { preset: 'mocapInteraction' }, 'agent');
    assert.equal(preset.ok, true, JSON.stringify(preset)); assert.equal(same.ok, true, JSON.stringify(same));
    for (const key of ['action', 'status', 'authored', 'affectedIds', 'delta']) assert.deepEqual(preset[key], same[key]);
    assert.equal(a.run('edit.undo', { receiptId: preset.receiptId }).status, 'undone');
    assert.deepEqual(a.actual.readStudioState().camera, before);
  } finally { a.dispose(); b.dispose(); }
});
test('6: the facade alias is gone; direct shots writes throw; scene load is non-authored', () => {
  const f = shotsFixture();
  try {
    owned(f); assert.equal(f.scope.appContext.recordShotUndo, undefined);
    assert.throws(() => f.shots.setShots([]), /requires a bus run/);
    f.run('shot.remove', { shotId: 'shot-a' });
    f.scope.appContext.loadStoreDomains({ shot: { shots: [seedShot()], frameCount: 240 },
      objects: f.store.current.objects, cast: f.characterRef.current, stage: f.live.current.stage });
    assert.equal(f.shots.documentStore.depths().past, 0);
    assert.equal(f.live.current.timeline.frameCount, 240);
    assert.deepEqual(f.live.current.shots, createShotAuthoringDocument({ shots: [seedShot()], frameCount: 240 }).shots);
  } finally { f.dispose(); }
});
test('7: measured writer references shrink, shots baseline entries leave, and owned UI routes through run', () => {
  const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url)));
  assert.deepEqual(Object.keys(baseline.writers).filter(key => key.startsWith('domains/shots.js::')), []);
  const count = scanTree(fileURLToPath(new URL('../../src/', import.meta.url))).length;
  assert.ok(count < 214, `writer count ${count} must shrink`);
  const panel = readFileSync(new URL('../../src/panels/CameraPanel.jsx', import.meta.url), 'utf8');
  assert.ok([...panel.matchAll(/on[A-Z][A-Za-z]+[\s\S]{0,240}?\brun\s*\(/g)].length >= 1);
  assert.deepEqual(JSON.parse(readFileSync(new URL('./parity-pending/shots.json', import.meta.url))).pending, []);
});
test('setCameraMode: an agent sets a shot camera to keys after its rail is gone; rail needs a rail', () => {
  const f = shotsFixture();
  try {
    owned(f); seed(f, 'shot.clearCameraRail');
    const mode = () => f.shots.read().find(shot => shot.id === 'shot-a').camera.mode;
    assert.equal(f.run('shot.clearCameraRail', { shotId: 'shot-a' }, 'agent').ok, true);
    assert.equal(mode(), 'follow', 'deleting a rail leaves follow');
    assert.equal(f.run('shot.setCameraMode', { shotId: 'shot-a', mode: 'rail' }, 'agent').code, 'TARGET_NOT_READY');
    const keys = f.run('shot.setCameraMode', { shotId: 'shot-a', mode: 'keys' }, 'agent');
    assert.equal(keys.ok, true, JSON.stringify(keys));
    assert.equal(mode(), 'keys');
    assert.equal(f.run('shot.rename', { shotId: 'shot-a', name: 'Wide opener' }, 'agent').ok, true);
    assert.equal(f.shots.read().find(shot => shot.id === 'shot-a').name, 'Wide opener');
    console.log('PASS setCameraMode and rename from the agent');
  } finally { f.dispose(); }
});
