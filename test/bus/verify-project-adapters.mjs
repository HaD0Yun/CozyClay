import assert from 'node:assert/strict';
import { projectFixture, ok } from './project-fixture.mjs';
import { createStudioAppActions } from '../../src/commands/index.js';
import { SCENES_VERSION } from '../../src/scenes.js';
import { telemetrySeam } from '../../src/command-bus-telemetry.js';

const f = projectFixture();
try {
  const unmounted = createStudioAppActions({ state: () => f.registry.state() });
  assert.doesNotThrow(() => unmounted.list(), 'unmounted owners report unavailable with a reason');
  assert.equal(unmounted.list().find(row => row.id === 'project.rename').available, false);
  ok(await f.run('stage.setStyle', { style: 'Other department edit' }));
  const before = f.project.documentStore.depths();
  const noop = ok(await f.run('scene.rename', { sceneId: 'scene', name: 'First' }));
  assert.equal(noop.status, 'noop', 'renaming to the same name never snapshots other domains into scene history');
  assert.deepEqual(f.project.documentStore.depths(), before);
  const legacy = await f.project.loadLiveScenes({ document: { version: SCENES_VERSION, activeSceneId: 'scene-b', scenes: f.project.snapshotActiveScene() } });
  assert.equal(legacy.activeSceneId, 'scene-b', 'legacy load retains its successful result shape');
  ok(await f.run('project.new', { name: 'Fresh' }));
  f.project.refreshProjectDirty();
  assert.equal(f.project.dirtyStore.read('projectDirty'), false, 'a new project is clean after the first dirty refresh');
  const previousWindow = globalThis.window;
  const sent = [], restore = telemetrySeam({ track: (event, props) => sent.push({ event, props }) });
  const refused = () => sent.splice(0).filter(row => row.event === 'studio:refused').map(row => `${row.props.command}:${row.props.code}`);
  const abort = async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
  try {
    // #1041: the user closing a picker or keeping their changes is a cancel, never a studio:refused.
    globalThis.window = { showSaveFilePicker: abort, showOpenFilePicker: abort };
    assert.equal((await f.run('project.open')).code, 'CANCELLED', 'closing the picker must not claim an opened document');
    assert.equal((await f.run('project.saveAs', { name: 'Heist' })).code, 'CANCELLED', 'closing the save picker is a cancel');
    ok(await f.run('project.rename', { name: 'Unsaved edit' }));
    f.project.refreshProjectDirty();
    assert.equal(f.project.dirtyStore.read('projectDirty'), true);
    globalThis.window = { ...globalThis.window, confirm: () => false };
    assert.equal((await f.run('project.openStarter', { id: 'missing-starter' })).code, 'CANCELLED', 'keeping unsaved changes is a cancel');
    assert.deepEqual(refused(), [], 'a user cancel sends no studio:refused');
    // A real failure still refuses: a file the reader cannot parse.
    globalThis.window = { showSaveFilePicker: abort, showOpenFilePicker: async () => [{ getFile: async () => ({ name: 'bad.cclayproject', text: async () => 'not json', lastModified: 0 }) }] };
    assert.equal((await f.run('project.open')).code, 'TARGET_NOT_READY', 'an unreadable project file is still refused');
    assert.deepEqual(refused(), ['project.open:TARGET_NOT_READY']);
  } finally { globalThis.window = previousWindow; restore(); }
  console.log('PASS project adapters: unmounted discovery, cross-domain noop, legacy output, clean new project, cancelled pickers, real open failure');
} finally { f.dispose(); }
