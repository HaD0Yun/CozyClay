#!/usr/bin/env node
// #1196: a project whose stored object is off the physics fingerprint schema
// (scale 0, a negative height, more than six route marks) opens without the
// Studio protocol refusal escaping, and the Studio binding keeps working.
import assert from 'node:assert/strict';
import { projectFixture, ok } from './bus/project-fixture.mjs';
import { createProjectDocument } from '../src/project.js';
import { SCENES_VERSION } from '../src/scenes.js';
import { createSceneObject } from '../src/scene-objects.js';

const route = { points: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }], speed: 1, faceTravel: false, loop: false, extend: false, timing: null,
  marks: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] };
const cases = [['scale 0', { scaleX: 0 }], ['height -1', { height: -1 }], ['eight route marks', { path: route }]];
for (const [label, patch] of cases) {
  const f = projectFixture();
  try {
    const scene = { ...f.project.snapshotActiveScene()[1], id: 'incoming', objects: [{ ...createSceneObject('cube'), id: 'stored', ...patch }] };
    const serialized = JSON.stringify(createProjectDocument({ name: 'Incoming', scenesDocument: { version: SCENES_VERSION, activeSceneId: 'incoming', scenes: [scene] } }));
    let opened, escaped = null;
    try { opened = await f.run('project.open', { serialized }); } catch (error) { escaped = error; }
    assert.equal(escaped, null, `${label}: opening the project must not throw (${escaped?.message})`);
    ok(opened);
    assert.equal(f.scope.activeSceneIdRef.current, 'incoming', `${label}: the project opened`);
    assert.doesNotThrow(() => f.binding.refresh(), `${label}: the Studio binding refreshes after the open`);
    const [stored] = f.objects.store.objects;
    assert.ok(stored.scaleX > 0 && stored.height >= 0 && (stored.path?.marks?.length ?? 0) <= 6, `${label}: the stored object reads within the editor's limits`);
    ok(await f.run('object.update', { id: 'stored', patch: { x: 1 } }));
    assert.equal(f.objects.store.objects[0].x, 1, `${label}: the binding still edits the opened project`);
    console.log(`PASS project open with an off-schema stored object (${label}) does not throw and the binding keeps working`);
  } finally { f.dispose(); }
}
