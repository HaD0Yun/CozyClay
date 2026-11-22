// What the agent can edit that the UI already can: an attached object in its bone frame,
// a child placed under a moving parent, and the timeline length.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { createSceneObject, normalizeSceneObject } from '../src/scene-objects.js';
import { createCharacterEntry } from '../src/scenes.js';
import { validateStudioCommand, StudioProtocolError } from '../src/studio-agent-protocol.js';
import { arrangement, localTransformReadback } from '../src/studio-agent-commands.js';
import { sceneObjectTravelMatrixAt } from '../src/object-travel.js';
import { declarations } from '../src/commands/shot.js';
import { shotsFixture } from './bus/shots-fixture.mjs';

const DEG = Math.PI / 180;
const state = rows => ({ host: { workspaceId: 'w', documentEpoch: 'd', sceneId: 's', sceneEpoch: 'e' }, frame: 0, frameCount: 96, floorY: 0, activeCharacterId: 'mara', selectedShotId: null,
  objects: rows, characters: [createCharacterEntry({ id: 'mara', subject: 'Mara' })], shotDocument: { shots: [] }, camera: null, filmback: null, manual: false });
const ports = { bounds: ({ entity }) => ({ min: { x: entity.x - 0.1, y: entity.y, z: entity.z - 0.1 }, max: { x: entity.x + 0.1, y: entity.y + 0.1, z: entity.z + 0.1 } }) };
const plan = (rows, ops) => arrangement(validateStudioCommand({ name: 'arrange_objects', args: { ops } }), state(rows), ports);
const run = (rows, ops) => plan(rows, ops).draft;
const near = (a, b, label, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${label}: ${a} != ${b}`);
const refused = (code, pattern) => error => error instanceof StudioProtocolError && error.code === code && pattern.test(error.message);
// A badge riding the chest bone: its channels are its place and turn in that frame.
const badge = (patch = {}) => ({ ...createSceneObject('cube'), id: 'badge', name: 'Badge', x: 0.05, y: 0.12, z: 0.1, rotX: 0, rot: 0, rotZ: 0, scaleX: 0.05, scaleY: 0.05, scaleZ: 0.01, attach: { characterId: 'mara', bone: 'chest' }, ...patch });

test('an attached object is moved, turned and scaled in its bone frame and reads back there', () => {
  const rows = run([badge()], [{ op: 'update', id: 'badge', position: { world: { x: -0.04, y: 0.2, z: 0.13 } }, rotationDeg: { x: 10, y: 20, z: -5 }, scale: { x: 0.08, y: 0.08, z: 0.02 }, space: 'parent' }]);
  const kept = rows.find(o => o.id === 'badge');
  assert.deepEqual([kept.x, kept.y, kept.z, kept.rotX, kept.rot, kept.rotZ, kept.scaleX, kept.scaleY, kept.scaleZ], [-0.04, 0.2, 0.13, 10, 20, -5, 0.08, 0.08, 0.02], 'the channels are written as given');
  assert.deepEqual(kept.attach, { characterId: 'mara', bone: 'chest' }, 'it still rides the bone');
  assert.deepEqual(localTransformReadback(kept, rows), { position: { x: -0.04, y: 0.2, z: 0.13 }, rotationDeg: { x: 10, y: 20, z: -5 } });
  const turned = run([badge({ rotX: 7, rotZ: 3 })], [{ op: 'update', id: 'badge', facing: { yawDeg: 45 }, space: 'parent' }]).find(o => o.id === 'badge');
  assert.deepEqual([turned.rotX, turned.rot, turned.rotZ, turned.x], [7, 45, 3, 0.05], 'facing.yawDeg sets the local yaw only');
});

test('frame-free fields of an attached object need no space; a world place on it is refused with its frame named', () => {
  const rows = run([badge()], [{ op: 'update', id: 'badge', scale: { x: 0.1, y: 0.1, z: 0.1 }, color: '#aa2233', name: 'Pin', hidden: true }]);
  const kept = rows.find(o => o.id === 'badge');
  assert.deepEqual([kept.scaleX, kept.color, kept.name, kept.hidden, kept.x], [0.1, '#aa2233', 'Pin', true, 0.05]);
  assert.throws(() => run([badge()], [{ op: 'update', id: 'badge', position: { world: { x: 1, y: 1, z: 1 } } }]), refused('INVALID_ARGUMENT', /rides mara's chest.*space "parent"/));
  assert.throws(() => run([badge()], [{ op: 'update', id: 'badge', position: { relativeTo: 'mara', basis: 'world', side: 'left', gapM: 0.1, support: 'floor' }, space: 'parent' }]), refused('INVALID_ARGUMENT', /world space/));
  assert.throws(() => run([badge()], [{ op: 'update', id: 'badge', color: '#000000', space: 'parent' }]), refused('INVALID_ARGUMENT', /none was given/));
});

test('a bone-frame place below the bone is not lifted off the floor', () => {
  const kept = run([badge()], [{ op: 'update', id: 'badge', position: { world: { x: 0, y: 0, z: 0.1 } }, space: 'parent' }]).find(o => o.id === 'badge');
  assert.equal(kept.y, 0);
  const receipt = plan([badge()], [{ op: 'update', id: 'badge', position: { world: { x: 0, y: 0, z: 0.1 } }, space: 'parent' }]);
  assert.ok(!receipt.warnings.some(w => w.code === 'FLOOR_LIFT'), JSON.stringify(receipt.warnings));
});

// A cart that drives a route: what is placed under it in its frame rides it on every frame.
const cart = () => normalizeSceneObject({ ...createSceneObject('cube'), id: 'cart', name: 'Cart', x: 1, y: 0, z: 2, rot: 30, scaleX: 2, scaleY: 1.5, scaleZ: 3,
  path: { points: [{ x: 0, y: 0, z: 0 }, { x: 6, y: 0, z: 4 }, { x: 10, y: 0, z: 12 }], speed: 2, faceTravel: true } });
test('a child placed in a routed parent frame rides it at that local pose on every frame', () => {
  const p = cart();
  assert.ok(p.path, 'the parent travels');
  const rows = run([p], [{ op: 'create', source: { kind: 'point-light' }, name: 'Lamp', position: { world: { x: 0.3, y: 1.4, z: 0.8 } }, rotationDeg: { x: 0, y: 15, z: 0 }, parent: 'cart', space: 'parent' }]);
  const lamp = rows.find(o => o.name === 'Lamp');
  assert.equal(lamp.parent, 'cart');
  const back = localTransformReadback(lamp, rows);
  near(back.position.x, 0.3, 'readback x', 1e-4); near(back.position.y, 1.4, 'readback y', 1e-4); near(back.position.z, 0.8, 'readback z', 1e-4); near(back.rotationDeg.y, 15, 'readback yaw', 1e-4);
  const local = new Matrix4().compose(new Vector3(0.3, 1.4, 0.8), new Quaternion().setFromEuler(new Euler(0, 15 * DEG, 0)), new Vector3(lamp.scaleX, lamp.scaleY, lamp.scaleZ));
  const take = { frameCount: 96, fps: 24 };
  let travelled = 0;
  for (const frame of [0, 12, 30, 60, 95]) {
    const drawn = sceneObjectTravelMatrixAt(rows, 'cart', frame, take), child = sceneObjectTravelMatrixAt(rows, lamp.id, frame, take);
    assert.ok(drawn && child, `frame ${frame} travels`);
    const parentFrame = new Matrix4(), at = new Vector3(), q = new Quaternion(), s = new Vector3();
    drawn.decompose(at, q, s); parentFrame.compose(at, q, new Vector3(1, 1, 1));
    const want = parentFrame.multiply(local), w = new Vector3(), g = new Vector3(), wq = new Quaternion(), gq = new Quaternion();
    want.decompose(w, wq, new Vector3()); child.decompose(g, gq, new Vector3());
    near(g.distanceTo(w), 0, `frame ${frame} lamp place`, 1e-6); near(Math.abs(gq.dot(wq)), 1, `frame ${frame} lamp turn`, 1e-6);
    travelled = Math.max(travelled, at.distanceTo(new Vector3(0, 0, 0)));
  }
  assert.ok(travelled > 5, `the cart moved ${travelled} m`);
});

test('a parent that rides a character carries no child: placing in its frame is refused with the way that works', () => {
  assert.throws(() => run([badge()], [{ op: 'create', source: { kind: 'point-light' }, name: 'Glint', position: { world: { x: 0, y: 0.02, z: 0 } }, parent: 'badge', space: 'parent' }]),
    refused('CAPABILITY_MISSING', /badge rides mara's chest.*does not follow.*object\.attach/));
});

test('the agent sets the timeline length; the answer names the length and the shots it cut', async () => {
  const entry = declarations.find(row => row.id === 'shot.setTimeline');
  assert.notEqual(entry.exposure, 'ui-only');
  const f = shotsFixture();
  try {
    const longer = await f.run('shot.setTimeline', { frameCount: 720 }, 'agent');
    assert.equal(longer.ok, true, JSON.stringify(longer));
    assert.equal(f.shots.state().frameCount, 720);
    assert.match(longer.summary, /720 frames \(30\.0 s\)\.$/);
    const shorter = await f.run('shot.setTimeline', { frameCount: 30 }, 'agent');
    assert.equal(shorter.ok, true, JSON.stringify(shorter));
    assert.equal(f.shots.state().frameCount, 30);
    assert.doesNotMatch(shorter.summary, /cut/, 'the 24-frame shot ends inside 30 frames');
    assert.equal((await f.run('shot.setTimeline', { frameCount: 120 }, 'agent')).ok, true);
    assert.equal((await f.run('shot.setRange', { shotId: 'shot-a', range: [0, 100] }, 'agent')).ok, true);
    const cutting = await f.run('shot.setTimeline', { frameCount: 48 }, 'agent');
    assert.match(cutting.summary, /Hero \[0, 48\).*48 frames \(2\.0 s\); 1 shot cut to end inside it\.$/);
    assert.equal(f.shots.read()[0].endFrame, 47);
    assert.equal((await f.run('edit.undo', { receiptId: cutting.receiptId }, 'agent')).status, 'undone');
    assert.equal(f.shots.state().frameCount, 120, 'one undo takes the length back');
    assert.equal(f.shots.read()[0].endFrame, 99, 'and the shot');
  } finally { f.dispose(); }
});
