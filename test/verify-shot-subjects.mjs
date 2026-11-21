import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCharacterEntry } from '../src/scenes.js';
import { createShotAuthoringDocument } from '../src/shot-authoring.js';
import { frameDraft } from '../src/studio-agent-commands.js';
import { validateStudioCommand, validateStudioSchema, StudioSchemas } from '../src/studio-agent-protocol.js';
import { shotGeometryFacts } from '../src/studio-geometry-facts.js';
import { planDiagramLayout } from '../src/plan-diagram.js';
import { createSceneObject } from '../src/scene-objects.js';
import { shotSubjects, subjectsCenter } from '../src/shot-subjects.js';
import { cutAtFrame, duplicateShot } from '../src/cuts.js';

const ids = ['first', 'second', 'third'];
function fixture() {
  const characters = ids.map((id, index) => createCharacterEntry({ id, x: index * 3, z: 0 }));
  const framing = { pos: { x: 3, y: 1.6, z: 6 }, yaw: 0, pitch: 0, fovDeg: 45 };
  const state = { frame: 0, frameCount: 48, activeCharacterId: 'first', objects: [], characters,
    shotDocument: createShotAuthoringDocument({ frameCount: 48, shots: [{ id: 'group', startFrame: 0, endFrame: 47,
      subjectIds: ids, cameraKeys: [{ id: 'key', frame: 0, framing }] }] }),
    camera: { position: framing.pos, lookAt: { x: 3, y: 1.3, z: 0 }, focalMm: 35 },
    filmback: { sensorId: 'fullFrame', aspectRatio: 16 / 9 } };
  const ports = { bounds: ({ entity }) => ({ min: { x: entity.x - 0.25, y: 0, z: entity.z - 0.15 },
    max: { x: entity.x + 0.25, y: 1.8, z: entity.z + 0.15 } }) };
  return { state, ports };
}

test('shot subject IDs survive normalization and an empty legacy shot', () => {
  const { state } = fixture();
  assert.deepEqual(state.shotDocument.shots[0].subjectIds, ids);
  const normalized = createShotAuthoringDocument({ frameCount: 48, shots: [
    { ...state.shotDocument.shots[0], subjectIds: ['third', '', 'third', null, 'second'] },
  ] });
  assert.deepEqual(normalized.shots[0].subjectIds, ['third', 'second']);
  const legacy = createShotAuthoringDocument({ frameCount: 48, shots: [{ id: 'legacy', startFrame: 0, endFrame: 47 }] });
  assert.equal(Object.hasOwn(legacy.shots[0], 'subjectIds'), false);
  const many = Array.from({ length: 28 }, (_, index) => `performer-${index + 1}`);
  const command = validateStudioCommand({ name: 'frame_shot', args: { subjectIds: many,
    framing: { intent: { size: 'wide shot' } } } });
  assert.deepEqual(command.args.subjectIds, many);
  assert.deepEqual(createShotAuthoringDocument({ frameCount: 48, shots: [{ ...legacy.shots[0], subjectIds: many }] }).shots[0].subjectIds, many);
});

test('shot subject resolution uses named visible members and never substitutes for hidden names', () => {
  const { state } = fixture();
  assert.deepEqual(shotSubjects({ subjectIds: ['third', 'second', 'third'] }, state.characters, 'first').map(entry => entry.id), ['third', 'second']);
  assert.deepEqual(subjectsCenter(shotSubjects({ subjectIds: ['second', 'third'] }, state.characters, 'first')), { x: 4.5, y: 0, z: 0, rot: 0 });
  state.characters[2].hidden = true;
  assert.deepEqual(shotSubjects({ subjectIds: ['third'] }, state.characters, 'first'), []);
  assert.deepEqual(shotSubjects({ subjectIds: ['removed'] }, state.characters, 'first'), []);
  assert.deepEqual(shotSubjects({}, state.characters, 'second').map(entry => entry.id), ['second']);
  assert.equal(subjectsCenter([]), null);
  const objects = [{ id: 'hidden-parent', hidden: true }];
  state.characters[1].parent = 'hidden-parent';
  assert.deepEqual(shotSubjects({ subjectIds: ['second'] }, state.characters, 'first', objects), []);
  assert.deepEqual(shotSubjects({}, [], null), []);
});

test('splitting and duplicating a shot retains independent subject lists', () => {
  const { state } = fixture(), shot = state.shotDocument.shots[0];
  const cut = cutAtFrame([shot], shot.id, 24, shot.cameraKeys[0].framing);
  assert.deepEqual(cut[1].subjectIds, ids);
  const duplicate = duplicateShot([shot], shot.id, 96)[1];
  assert.deepEqual(duplicate.subjectIds, ids);
  duplicate.subjectIds.pop();
  assert.deepEqual(shot.subjectIds, ids);
});

test('frame_shot measures and persists all three subjects, not only the first', () => {
  const { state, ports } = fixture();
  const command = validateStudioCommand({ name: 'frame_shot', args: { subjectIds: ids,
    framing: { intent: { size: 'wide shot', view: 'front', level: 'eye', side: 'right', focalMm: 35 } } } });
  const before = structuredClone(state);
  const plan = frameDraft(command, state, ports);
  assert.deepEqual(state, before);
  assert.deepEqual(plan.draft.shotDocument.shots[0].subjectIds, ids);
  assert.deepEqual(plan.details.subjectIds, ids);
  assert.equal(plan.checks.clipped, false);
  assert.ok(Math.abs(plan.draft.camera.lookAt.x - 3) < 1e-9);
});

test('geometry facts and the plan measure occlusion for a third named character', () => {
  const { state, ports } = fixture();
  state.objects = [{ ...createSceneObject('cube'), id: 'third-blocker', x: 4.5, z: 3, scaleY: 2 }];
  const facts = shotGeometryFacts(state, { ports });
  validateStudioSchema(StudioSchemas.GeometryFacts, facts);
  assert.deepEqual(facts.shots[0].subjectIds, ids);
  assert.ok(facts.shots[0].occluders.some(hit => hit.subjectId === 'third' && hit.byObjectId === 'third-blocker'));
  const layout = planDiagramLayout(state, { ports });
  assert.ok(layout.primitives.some(item => item.kind === 'occluder' && item.subjectId === 'third' && item.byObjectId === 'third-blocker'));
});
