import assert from 'node:assert/strict';
import { parseSync } from 'rolldown/experimental';
import * as cuts from '../../src/cuts.js';
import { createSceneObject } from '../../src/scene-objects.js';
import { STUDIO_ACTIONS } from '../../src/studio-actions.js';
import { appFixture } from './app-fixture.mjs';
import { readStudioSource } from './verify-domain-modules.mjs';
const app = readStudioSource();
const functions = new Map();
const visit = node => { if (!node || typeof node !== 'object') return; if (node.type === 'FunctionDeclaration') functions.set(node.id.name, app.slice(node.start, node.end)); for (const [key, child] of Object.entries(node)) if (key !== 'parent') Array.isArray(child) ? child.forEach(visit) : visit(child); };
visit(parseSync('App.jsx', app).program);
const unit = { x: 0, y: 0, z: 0, w: 1 };
const inputs = {
 'shot.create': {}, 'shot.split': { shotId: 'shot-1' }, 'shot.duplicate': { shotId: 'shot-1' }, 'shot.remove': { shotId: 'shot-1' },
 'shot.setRange': { shotId: 'shot-1', range: { startFrame: 1, endFrameExclusive: 15 } }, 'shot.reorder': { shotId: 'shot-1', startFrame: 2 },
 'shot.setCameraRail': { shotId: 'shot-1', points: [{ x: -2, z: 4 }, { x: 3, z: 4 }] }, 'shot.clearCameraRail': { shotId: 'shot-1' },
 'shot.setCameraMode': { shotId: 'shot-1', mode: 'follow' }, 'shot.rename': { shotId: 'shot-1', name: 'Renamed' },
 'shot.createStill': { caption: 'Panel' }, 'shot.setCaption': { shotId: 'shot-1', caption: 'Panel' },
 'shot.setCastOverride': { shotId: 'shot-1', characterId: 'actor-a', override: { x: 1, z: 2, rot: 0 } }, 'shot.setHold': { shotId: 'shot-1', hold: 24 },
 'character.move': { characterId: 'actor-a', x: 1, z: 0, rot: 0 },
 'character.addWaypoint': { characterId: 'actor-a', position: { x: 0, z: 2 }, frame: 40 },
 'character.moveWaypoint': { characterId: 'actor-a', position: { x: 0, z: 1.1 }, frame: 24 },
 'character.removeWaypoint': { characterId: 'actor-a', frame: 24 }, 'character.clearWaypoints': { characterId: 'actor-a' },
 'character.setIkKey': { characterId: 'actor-a', frame: 12, tracks: { head: { q: [unit] } } },
 'character.removeIkKey': { characterId: 'actor-a', frame: 12 }, 'character.clearIkKeys': { characterId: 'actor-a' },
 'object.attach': { objectId: 'object-1', characterId: 'actor-a' }, 'object.detach': { objectId: 'object-1' }, 'object.duplicate': { objectId: 'object-1' },
 'asset.import': { source: 'data:image/png;base64,AAAA', name: 'poster.png', placeAs: 'cutout' },
};
for (const action of STUDIO_ACTIONS.filter(entry => entry.kind === 'mutation')) {
 const f = appFixture();
 try {
  const shot = { ...cuts.createShot('Test', 0, 15, [], { mode: 'rail', cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }] }), id: 'shot-1', ...(['shot.setHold', 'shot.createStill'].includes(action.id) ? { kind: 'still' } : {}) };
  f.scope.setShots([shot]); f.live.current.shots = [shot];
  const object = { ...createSceneObject('cube', []), id: 'object-1', ...(action.id === 'object.detach' ? { parent: 'parent-1' } : {}) };
  f.store.current.applyAtomic(() => action.id === 'object.detach' ? [{ ...createSceneObject('cube', []), id: 'parent-1' }, object] : [object]);
  for (const name of ['addTimelineShot', 'splitTimelineShot', 'duplicateTimelineShot', 'removeTimelineShot', 'setTimelineShotRange', 'moveTimelineShot']) {
   f.actionHandlers.current[name] = (...args) => {
    const scope = { ...f.scope, ...cuts, ...f.actual, shots: f.live.current.shots, tlFrame: action.id === 'shot.create' ? 24 : 8 };
    scope.appContext = f.scope.appContext.forRender(scope);
    return new Function(...Object.keys(scope), `${functions.get(name)}; return ${name};`)(...Object.values(scope))(...args);
   };
  }
  const oldState = f.actionHandlers.current.state;
  f.actionHandlers.current.state = () => ({ ...oldState(), frame: action.id === 'shot.create' ? 24 : 8 });
  if (action.id.startsWith('character.') && action.undoDomain === 'cast') assert.equal(f.binding.bus.run('character.addWaypoint', { characterId: 'actor-a', position: { x: 0, z: 1 }, frame: 24 }).ok, true);
  if (['character.removeIkKey', 'character.clearIkKeys'].includes(action.id)) assert.equal(f.binding.bus.run('character.setIkKey', { characterId: 'actor-a', frame: 12, tracks: { head: { q: [unit] } } }).ok, true);
  const snapshot = () => action.undoDomain === 'objects' ? f.store.current.objects : f.actual.snapshotStudioDomain(action.undoDomain, 'actor-a');
  const before = snapshot();
  const receipt = await f.actual.runStudioAction(action.id, inputs[action.id]);
  assert.equal(receipt?.ok, true, `${action.id}: ${JSON.stringify(receipt)}`);
  assert.ok(receipt.undo?.historyEntryId, action.id);
  const undo = await f.binding.bus.run('edit.undo', { receiptId: receipt.receiptId }, { origin: 'ui' });
  assert.equal(undo.status, 'undone', `${action.id}: ${JSON.stringify(undo)}`);
  assert.deepEqual(snapshot(), before, `${action.id} restores its native pre-image`);
 } finally { f.dispose(); }
}
console.log('PASS bus acceptance 8: every registered mutation round-trips through the actual App UI bus and native Undo');
