import "../lowvis/block-figure.mjs"; // the rig's own body: scale 1 of the block figure (figure.js: the launch names the look)
import assert from 'node:assert/strict';
import { projectFixture, ok } from './project-fixture.mjs';
import { SCENES_STORAGE_KEY } from '../../src/scenes.js';

const f = projectFixture();
try {
  const before = f.scope.appContext.live.scenes.find(scene => scene.id === 'scene').name;
  const receipt = ok(await f.run('scene.rename', { sceneId: 'scene', name: 'Renamed' }, 'agent'));
  assert.ok(receipt.undo?.historyEntryId, 'agent scene.rename retains one undo entry');
  assert.equal(receipt.revision.after, receipt.revision.before + 1);
  assert.equal((await f.run('edit.undo', { receiptId: receipt.receiptId }, 'agent')).status, 'undone');
  assert.equal(f.scope.appContext.live.scenes[0].name, before);
  assert.equal(JSON.parse(f.storage.get(SCENES_STORAGE_KEY)).scenes[0].name, before, 'undo persists the restored scene');
  assert.throws(() => f.project.setScenes([]), /bus run|store-owned/);
  assert.throws(() => { f.scope.appContext.live.scenes[0].name = 'outside'; }, TypeError);
  ok(await f.run('scene.reorder', { sceneId: 'scene-b', order: 0 }, 'cli'));
  assert.deepEqual(f.scope.appContext.live.scenes.map(row => row.id), ['scene-b', 'scene']);
  const renamed = ok(await f.run('project.rename', { name: '  New project  ' }, 'mcp'));
  assert.ok(renamed.undo?.historyEntryId);
  const saved = JSON.parse(await f.project.collectProjectSerialized('New project'));
  const inspected = f.binding.handlers.inspect_studio({ scope: 'document' });
  assert.deepEqual(inspected.document.scenes, saved.scenes.scenes);
  assert.equal(inspected.document.project.name, saved.name);
  assert.equal(inspected.document.project.activeSceneId, saved.scenes.activeSceneId);
  assert.equal(inspected.schema.scenes.properties.set.properties.order.type, 'number');
  assert.equal(f.project.documentStore.owns('scenes'), true);
  assert.equal(f.project.documentStore.owns('project'), true);
  assert.equal(f.project.dirtyStore.owns('projectDirty'), true);
  assert.equal((await f.run('edit.undo', { receiptId: renamed.receiptId }, 'mcp')).status, 'undone');
  assert.equal(f.binding.handlers.inspect_studio({ scope: 'document' }).document.project.name, 'Heist');
  console.log('PASS real project ownership: rename/undo, reorder, project rename, saved projection, write guard');
} finally { f.dispose(); }
