import assert from 'node:assert/strict';
import { createSceneDocument, readSceneDocument, serializeSceneDocument } from '../../src/scenes.js';
import { stageFixture } from './stage-fixture.mjs';
const f = stageFixture();
try {
  const receipt = f.binding.handlers.run_action(f.request('run_action', { action: 'stage.set', args: { keyLight: { intensity: 500 } } }));
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(f.stage.read().keyLight.intensity, 4);
  assert.equal(receipt.undo.entries, 1);
  assert.equal(f.stage.documentStore.depths().past, 1);
  const before = f.stage.read();
  assert.equal(f.run('stage.set', { keyLight: { intensity: 'bright' } }, 'agent').ok, false);
  assert.equal(f.stage.read(), before);
  assert.equal(f.run('stage.setStyle', { style: '' }, 'agent').ok, true, 'text can be cleared');
  // A floor edit must survive the same document path and history as other stage edits.
  const floorEdit = f.run('stage.set', { floor: false }, 'agent');
  assert.equal(floorEdit.ok, true, JSON.stringify(floorEdit));
  assert.equal(f.stage.read().floor, false);
  const document = createSceneDocument();
  document.scenes[0].stage = f.stage.document().stage;
  assert.equal(readSceneDocument(serializeSceneDocument(document)).document.scenes[0].stage.floor, false);
  assert.equal(f.run('edit.undo', { receiptId: floorEdit.receiptId }, 'agent').status, 'undone');
  assert.equal(f.stage.read().floor, true);
  console.log('PASS stage.set agent clamp, typed boundary, one receipt and clearable text');
} finally { f.dispose(); }
