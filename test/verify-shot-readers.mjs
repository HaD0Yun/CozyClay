import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PerspectiveCamera } from 'three';
import { readStudioFunction } from './bus/verify-domain-modules.mjs';
import { createShotSubjectSampler } from '../src/camera-direction.js';
import { subjectsCenter } from '../src/shot-subjects.js';
import { composePrompt, deriveShot, SUBJECT_HEIGHT_M, CUSTOM_MOVE } from '../src/shot.js';
import { promptSubjects } from '../src/prompt-cast.js';
import { promptDescription } from '../src/character-name.js';
import { resolveOverShot, heldReport } from '../src/commands/shot-held.js';
import { compileSpec } from '../src/motion3/pipeline.js';
import { motionScene } from '../src/motion3/scene.js';
import { skeletonFor } from '../src/motion3/rigs/index.js';
import { heldIssues, placedOut } from '../src/motion3/shot-framing.js';
import { focalMmToFov } from '../src/shot.js';
import { frameDraft } from '../src/studio-agent-commands.js';
import { useShotCameraTracks } from '../src/use-shot-camera-tracks.js';
import { sampleAt } from '../src/sample-at.js';
import { createSceneObject } from '../src/scene-objects.js';
import { castFixture } from './bus/cast-fixture.mjs';
import { shotsFixture } from './bus/shots-fixture.mjs';

const filmback = { sensorId: 'fullFrame', aspectRatio: 16 / 9 };
const cast = () => [
  { id: 'first', x: -8, z: 0, rot: 0, scale: 1 },
  { id: 'second', x: 4, z: 0, rot: 0, scale: 1 },
  { id: 'third', x: 12, z: 0, rot: 90, scale: 1 },
];
const shot = (id, startFrame, endFrame, subjectIds) => ({ id, startFrame, endFrame, subjectIds,
  camera: { mode: 'follow', followCam: { distance: 3 } }, cameraKeys: [] });
function tracks(characters, shots, extra = {}) {
  let result;
  function Mount() {
    result = useShotCameraTracks({ characters, shots, objects: [], frameCount: 48, fps: 24, filmback,
      activeId: 'first', motion: null, subjectId: 'first', yawDeg: 0,
      subjectTrack: Array.from({ length: 48 }, () => ({ x: -8, z: 0 })), ...extra });
    return null;
  }
  renderToStaticMarkup(createElement(Mount));
  return result;
}
const near = (actual, expected, name) => assert.ok(Math.abs(actual - expected) < 0.01, `${name}: ${actual} != ${expected}`);

test('follow cameras resolve the third, group center and active fallback independently per shot', () => {
  const result = tracks(cast(), [shot('third-shot', 0, 15, ['third']), shot('group-shot', 16, 31, ['second', 'third']), shot('active-shot', 32, 47, [])]);
  near(result[0].pos.x, 9, 'third-character yaw places the camera behind x12');
  near(result[0].pos.z, 0, 'third-character yaw is not the first character yaw');
  near(result[16].pos.x, 8, 'the group follows the mean of x4 and x12');
  near(result[16].pos.z, -3, 'the group uses its named reference heading');
  near(result[32].pos.x, -8, 'an unnamed shot follows the active member');
});

test('hidden or missing named subjects never silently follow the active member', () => {
  const characters = cast(); characters[2].hidden = true;
  const result = tracks(characters, [shot('hidden', 0, 15, ['third']), shot('missing', 16, 31, ['removed']), shot('remaining', 32, 47, ['second', 'third'])]);
  assert.equal(result[0], null);
  assert.equal(result[16], null);
  near(result[32].pos.x, 4, 'only the visible named member remains');
  assert.ok(tracks([], [shot('empty', 0, 47, [])], { activeId: null }).every(point => point === null));
});

test('a non-active third member follows its own take and its own moving parent', () => {
  const characters = cast();
  characters[2] = { ...characters[2], parent: 'carrier', sessionMotion: {
    frameCount: 3, hips: new Float32Array([0, 1, 0, 0, 1, 1, 0, 1, 2]),
  } };
  const carrier = { ...createSceneObject('cube'), id: 'carrier', x: 0, y: 0, z: 0,
    path: { points: [{ x: 0, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }], faceTravel: false } };
  const result = tracks(characters, [shot('carried', 0, 47, ['third'])], { objects: [carrier] });
  near(result[0].pos.x, 9, 'the camera starts behind the third member');
  assert.ok(result.at(-1).pos.x - result[0].pos.x > 3, 'the camera travels with that member, not the idle active actor');
});

test('an explicitly world-aimed rail remains usable with no cast', () => {
  const aimed = { ...shot('world-rail', 0, 47, []), camera: { mode: 'rail',
    cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }], aim: { point: { x: 0, y: 1, z: 0 } }, focalMm: 35 } };
  const result = tracks([], [aimed], { activeId: null });
  near(result[0].pos.x, -2, 'an empty cast does not disable an authored world aim');
  assert.ok(result.at(-1).pos.x > 1.2);
});

test('keyed playback uses the shot anchor track without replacing the active animation subject', () => {
  const characters = cast(), center = characters[2];
  const orbit = { ...shot('orbit', 0, 48, ['third']), camera: { mode: 'keys' }, cameraKeys: [
    { frame: 0, framing: { pos: { x: 12, y: 1.6, z: 3 }, yaw: 0, pitch: 0, fovDeg: 40 } },
    { frame: 48, framing: { pos: { x: 15, y: 1.6, z: 0 }, yaw: Math.PI / 2, pitch: 0, fovDeg: 40 } },
  ] };
  const scene = { frameCount: 49, subject: characters[0], cameraAnchor: characters[0], filmback,
    subjectTrack: Array.from({ length: 49 }, () => ({ x: -8, z: 0 })),
    cameraAnchorTrack: Array.from({ length: 49 }, () => ({ x: center.x, z: center.z })) };
  const at = sampleAt(scene, orbit, 24);
  near(Math.hypot(at.camera.pos.x - 12, at.camera.pos.z), 3, 'the orbit holds its own third-character anchor');
  assert.deepEqual(at.subject, { x: -8, z: 0 }, 'the active editing layer keeps its own played root');
});

function threeMemberShots() {
  const f = shotsFixture(castFixture());
  const added = f.run('character.add', { character: { id: 'actor-third', model: 'proxy-figure', x: 12, z: 0, rot: 90 } });
  assert.equal(added.ok, true, JSON.stringify(added));
  return f;
}
test('a preset honors a shot naming the third member instead of the active first member', () => {
  const f = threeMemberShots();
  try {
    assert.equal(f.run('shot.set', { id: 'shot-a', set: { subjectIds: ['actor-third'] } }).ok, true);
    const framed = f.run('shot.frame', { preset: 'mocapInteraction' });
    assert.equal(framed.ok, true, JSON.stringify(framed));
    near(f.actual.readStudioState().camera.lookAt.x, 12, 'the preset aims at the named third member');
    assert.deepEqual(f.shots.read()[0].subjectIds, ['actor-third']);
  } finally { f.dispose(); }
});

test('camera capture measures follow settings against all named members', () => {
  const f = threeMemberShots();
  try {
    assert.equal(f.run('shot.set', { id: 'shot-a', set: { subjectIds: ['actor-b', 'actor-third'] } }).ok, true);
    const camera = new PerspectiveCamera(40); camera.position.set(5, 1.6, 0);
    f.scope.shotCamRef.current = camera;
    Object.assign(f.scope.look.current, { yaw: -Math.PI / 2, pitch: -Math.atan2(0.25, 3) });
    const captured = f.run('shot.captureCamera', { shotId: 'shot-a' });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    const follow = f.shots.read()[0].camera.followCam;
    near(follow.distance, 3, 'distance is measured from group center x8');
    near(follow.orbitOffsetDeg, -90, 'orbit is measured from the named reference heading');
  } finally { f.dispose(); }
});

test('a preset keeps hidden named references while framing the visible third member', () => {
  const f = threeMemberShots();
  try {
    const ids = ['actor-b', 'actor-third'];
    assert.equal(f.run('shot.set', { id: 'shot-a', set: { subjectIds: ids } }).ok, true);
    assert.equal(f.run('character.update', { characterId: 'actor-b', patch: { hidden: true } }).ok, true);
    const framed = f.run('shot.frame', { preset: 'mocapInteraction' });
    assert.equal(framed.ok, true, JSON.stringify(framed));
    assert.deepEqual(f.shots.read()[0].subjectIds, ids, 'temporarily hidden members remain named for when they are shown again');
  } finally { f.dispose(); }
});

function heldFixture() {
  const characters = cast().map(entry => ({ ...entry, model: 'y-bot-tpose', rot: 0 }));
  const sk = skeletonFor('y-bot-tpose'), spec = { schema: 'cozyclay.motion-spec.v1', fps: 24, frames: 8, flow: false,
    keys: [{ f: 0, set: { root: [0, sk.restWorldPos[sk.index.Hips][1], 0] } }] };
  const takes = new Map(characters.map(c => [c.id, { schema: 'cozyclay.take.v3', rig: c.model, frameCount: 8, fps: 24, spec, placement: { position: [0, 0, 0], yaw: 0 } }]));
  const framing = { pos: { x: -8, y: 1.6, z: 5 }, yaw: 0, pitch: -0.1, fovDeg: 40 };
  const heldShot = { id: 'held', startFrame: 0, endFrame: 7, cameraKeys: [{ frame: 0, framing }] };
  const raw = { characters, objects: [], frameCount: 8, view: { frame: 0 }, filmback, camera: { focalMm: 35 } };
  const ports = { state: () => raw, storeDomain: () => ({ motionFor: id => takes.get(id) }) };
  const outs = characters.map(c => placedOut(compileSpec(spec, { sk, scene: motionScene([]) }, { lenient: true }).out, takes.get(c.id).placement, c));
  return { raw, ports, shot: heldShot, outs, framing };
}

test('a held camera fits all three installed takes rather than the first alone', () => {
  const f = heldFixture(), subjectIds = f.raw.characters.map(c => c.id);
  const resolved = resolveOverShot({ subjectIds, over: 'shot', shotId: 'held',
    framing: { intent: { size: 'wide shot', level: 'eye', view: 'front', side: 'left', focalMm: 35 } } }, { raw: f.raw, shots: [f.shot], ports: f.ports });
  const camera = resolved.args.framing.exact, cam = { eye: Object.values(camera.position), lookAt: Object.values(camera.lookAt) };
  const lens = { tanV: Math.tan(focalMmToFov(camera.focalMm, filmback.sensorId, filmback.aspectRatio) / 2), aspect: filmback.aspectRatio };
  for (const out of f.outs) assert.deepEqual(heldIssues(out, cam, [0, 7], lens).outOfFrame, [], 'each real compiled body is in the held image');
});

test('whole-shot framing replaces an existing moving camera with one held key', () => {
  const f = heldFixture();
  f.shot.cameraKeys.push({ id: 'moving-end', frame: 7, framing: { ...f.framing, pos: { x: -6, y: 1.6, z: 4 } } });
  const args = { subjectIds: f.raw.characters.map(c => c.id), over: 'shot', shotId: 'held',
    framing: { intent: { size: 'wide shot', level: 'eye', view: 'front', side: 'left', focalMm: 35 } } };
  const resolved = resolveOverShot(args, { raw: f.raw, shots: [f.shot], ports: f.ports });
  const bounds = ({ entity }) => {
    const points = f.outs[f.raw.characters.findIndex(c => c.id === entity.id)].frames[0].s.P;
    return { min: Object.fromEntries(['x', 'y', 'z'].map((axis, i) => [axis, Math.min(...points.map(p => p[i]))])),
      max: Object.fromEntries(['x', 'y', 'z'].map((axis, i) => [axis, Math.max(...points.map(p => p[i]))])) };
  };
  const plan = frameDraft({ name: 'frame_shot', args: resolved.args }, { ...f.raw, frame: 0, shotDocument: { shots: [f.shot] } }, { bounds });
  assert.equal(plan.draft.shotDocument.shots[0].cameraKeys.length, 1, 'over:"shot" must not leave an old endpoint moving the camera');
});

test('held-shot evidence reports an omitted third take even when the first is visible', () => {
  const f = heldFixture();
  const report = heldReport({ details: { subjectIds: f.raw.characters.map(c => c.id), framing: f.framing } }, f.shot, { raw: f.raw, ports: f.ports });
  assert.ok(report.held?.outOfFrame.length > 0);
  assert.equal(report.warning?.code, 'HELD_SHOT');
});

test('a static named neighbor does not suppress an installed take held-shot warning', () => {
  const f = heldFixture(), owner = f.ports.storeDomain();
  f.ports.storeDomain = () => ({ motionFor: id => id === 'first' ? owner.motionFor(id) : null });
  const report = heldReport({ details: { subjectIds: f.raw.characters.map(c => c.id), framing: { ...f.framing, yaw: Math.PI } } }, f.shot, { raw: f.raw, ports: f.ports });
  assert.ok(report.held?.outOfFrame.length > 0);
  assert.equal(report.warning?.code, 'HELD_SHOT');
});

test('the real generation reader gives the composer the third shot subject geometry', () => {
  const generate = readStudioFunction('generate');
  const characters = cast().map(entry => ({ ...entry, subject: `Performer ${entry.id}` }));
  const framing = { pos: { x: 12, y: 1.6, z: 4 }, yaw: 0, pitch: 0, fovDeg: 40 };
  const activeShot = { ...shot('prompt-third', 0, 47, ['third']), camera: { mode: 'keys' }, name: 'Third' };
  const cameraSubjectsAt = createShotSubjectSampler({ characters, objects: [], shots: [activeShot], frameCount: 48, fps: 24, activeId: 'first', clipOf: () => null });
  let measured;
  const scope = { mode: 'video', activeCamera: activeShot.camera, activeShot, moveSequence: null, followTrack: null,
    cameraKeys: [{ frame: 0, framing }], subjectTrack: [{ x: -8, z: 0 }], charA: characters[0], activeChar: characters[0],
    characters, cameraSubjectsAt, subjectsCenter, deriveShot, SUBJECT_HEIGHT_M, filmback, tlFrame: 0, fovDeg: 40,
    shot: deriveShot(framing.pos, characters[0], 40 * Math.PI / 180, SUBJECT_HEIGHT_M, filmback),
    composePrompt: args => { measured = args.shot; return composePrompt(args); }, promptSubjects, promptDescription,
    environment: '', style: '', cameraMove: 'Static / locked-off', CUSTOM_MOVE, customMove: '', hasCharSheet: false, hasEnvSheet: false,
    shotAspectKey: '16:9', tlFps: 24, shotOutput: { label: '16:9' }, partColoursEnabled: false,
    captureFramingPng: () => null, captureRef: { current: null }, setResult() {}, setResultOpen() {}, setCopied() {}, setRecordedVideoName() {}, copyPrompt() {} };
  const result = new Function('scope', `with(scope){return (${generate})();}`)(scope);
  near(measured.distance, Math.hypot(4, 0.3), 'the real composer receives the distance to x12, not active x-8');
  assert.equal(typeof result.prompt, 'string');
  assert.equal(result.subjects.length, 3);
});
