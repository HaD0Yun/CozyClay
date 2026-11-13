import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Euler, Vector3 } from 'three';
import { createSceneObject } from '../src/scene-objects.js';
import { createCharacterEntry } from '../src/scenes.js';
import { createShotAuthoringDocument } from '../src/shot-authoring.js';
import { validateReceipt, validateStudioCommand } from '../src/studio-agent-protocol.js';
import { physicsFingerprintInput } from '../src/studio-agent-context.js';
import { arrangement, frameDraft, placementChecks, framingChecks, createStudioCommandJournal, studioObjectCatalogue } from '../src/studio-agent-commands.js';
import { createShot } from '../src/cuts.js';
import { DECK_LIFT_M } from '../src/studio-support-gap.js';
import { declarations as shotDeclarations } from '../src/commands/shot.js';

// These are the shared domain planners now, not the retired agent executor.
// Receipt/admission/replay/undo remain exercised through the real bus in the
// binding, tool-alias, objects, cast and shots suites. Geometry assertions below
// inspect the planner's evidence directly instead of inventing a second receipt.
function fixture() {
  const state = { host: { workspaceId: 'workspace', documentEpoch: 'document', sceneId: 'scene', sceneEpoch: 'epoch' },
    frame: 0, frameCount: 144, floorY: 0, activeCharacterId: 'alex', selectedShotId: null,
    objects: [], characters: [createCharacterEntry({ id: 'alex', subject: 'Alex' })],
    shotDocument: createShotAuthoringDocument({ frameCount: 144 }),
    camera: { position: { x: 0, y: 1.6, z: 5 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35 },
    filmback: { sensorId: 'fullFrame', aspectRatio: 16 / 9 }, manual: false };
  const ports = { bounds: ({ entity, frame }) => {
    assert.equal(frame, state.frame);
    if (entity.id === 'unready') return null;
    const scale = entity.scale ?? 1;
    return { min: { x: entity.x - 0.25 * scale, y: entity.y, z: entity.z - 0.15 * scale },
      max: { x: entity.x + 0.25 * scale, y: entity.y + 1.8 * scale, z: entity.z + 0.15 * scale } };
  } };
  function prepare(name, args) {
    const before = structuredClone(state);
    try { return (name === 'frame_shot' ? frameDraft : arrangement)(validateStudioCommand({ name, args }), state, ports); }
    finally { assert.deepEqual(state, before, 'preparing geometry must not publish or mutate its input'); }
  }
  function apply(name, args) {
    const plan = prepare(name, args);
    if (plan.domain === 'shot') Object.assign(state, plan.draft);
    else state[plan.domain === 'objects' ? 'objects' : 'characters'] = plan.draft;
    return plan;
  }
  const refuse = (name, args, code) => assert.throws(() => prepare(name, args), error => error.code === code, `${name}: ${code}`);
  return { state, ports, prepare, apply, refuse };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const relative = basis => ({ relativeTo: 'alex', basis, side: 'left', gapM: 0.5, support: 'floor' });
const prop = basis => ({ op: 'create', source: { kind: 'cylinder' }, position: relative(basis), facing: { towardId: 'alex' } });
const framing = { intent: { size: 'medium shot', view: 'front', level: 'eye', side: 'right', focalMm: 35 } };
const seed = (f, patch = {}) => f.state.objects.push({ ...createSceneObject('cube'), ...patch });

test('geometry: bases, yaw, anisotropic extents, between and the scaled authored seat', () => {
  assert.equal(createSceneObject('cylinder').height, 1); assert.equal(createSceneObject('cylinder').supportY, 1);
  for (const [basis, x, yaw] of [['world', -1.25, 90], ['subject', 1.25, -90], ['shot_camera', -1.25, 90]]) {
    const f = fixture(), plan = f.apply('arrange_objects', { ops: [prop(basis)] });
    near(f.state.objects[0].x, x); near(f.state.objects[0].rot, yaw); near(plan.checks.actualGapM, 0.5);
    assert.deepEqual({ x: f.state.objects[0].x, y: f.state.objects[0].y, z: f.state.objects[0].z }, { x, y: DECK_LIFT_M, z: 0 });
  }
  for (const yaw of [90, 180]) {
    const f = fixture(); f.state.characters[0].rot = yaw;
    f.apply('arrange_objects', { ops: [{ ...prop('subject'), facing: { yawDeg: 0 } }] });
    if (yaw === 90) { near(f.state.objects[0].x, 0); near(f.state.objects[0].z, -1.15); }
    else { near(f.state.objects[0].x, -1.25); near(f.state.objects[0].z, 0); }
  }
  const f = fixture(); f.apply('arrange_objects', { ops: [{ ...prop('world'), scale: { x: 2, y: 3, z: 4 }, facing: { yawDeg: 90 } }] });
  near(f.state.objects[0].x, -2.75); assert.equal(f.state.objects[0].scaleY, 3);
  f.apply('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, position: { onObject: 'cylinder' } }] }); near(f.state.objects[1].y, DECK_LIFT_M + 3);
  // An authored seat below the record's top (supportY) is what onObject lands on, scaled.
  const seat = fixture(); seat.state.objects.push({ ...createSceneObject('cylinder'), id: 'seat', height: 1.15, supportY: 0.495, scaleY: 3 });
  seat.apply('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, position: { onObject: 'seat' } }] }); near(seat.state.objects[1].y, 1.485);
  const g = fixture(); seed(g, { x: 4, z: 2 });
  g.apply('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cylinder' }, position: { between: ['alex', 'cube'], fraction: 0.25, support: 'floor' } }] });
  near(g.state.objects[1].x, 1); near(g.state.objects[1].z, 0.5);
});
test('geometry: operation-two atomicity, missing targets, support readiness and avoid grammar', () => {
  const f = fixture();
  f.refuse('arrange_objects', { ops: [prop('world'), { op: 'create', source: { kind: 'not-a-kind' }, position: { world: { x: 2, y: 0, z: 0 } } }] }, 'INVALID_ARGUMENT');
  for (const position of [{ ...relative('world'), relativeTo: 'missing' }, { onObject: 'missing' }]) f.refuse('arrange_objects', { ops: [{ ...prop('world'), position }] }, 'AMBIGUOUS_TARGET');
  f.state.camera.lookAt = { ...f.state.camera.position, y: 0 }; f.refuse('arrange_objects', { ops: [prop('shot_camera')] }, 'AMBIGUOUS_BASIS');
  f.state.characters[0].id = 'unready'; f.state.activeCharacterId = 'unready';
  f.refuse('arrange_objects', { ops: [{ ...prop('world'), position: { ...relative('world'), relativeTo: 'unready' }, facing: { yawDeg: 0 } }] }, 'TARGET_NOT_READY');
  for (const patch of [{ path: { points: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }] } }, { attach: { characterId: 'alex', bone: null } }, { rotX: 10 }, { renderer: 'cutout' }, { renderer: 'sphere' }, { hidden: true }]) {
    const g = fixture(); g.state.objects = [{ ...createSceneObject('cylinder'), ...patch }];
    g.refuse('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, position: { onObject: 'cylinder' } }] }, 'TARGET_NOT_READY');
  }
  for (const position of [{ world: { x: 0, y: 0, z: 0 } }, { between: ['alex', 'other'], fraction: 0.5, support: 'floor' }, { onObject: 'cylinder' }]) fixture().refuse('arrange_objects', { collisionPolicy: 'avoid', ops: [{ op: 'create', source: { kind: 'cylinder' }, position }] }, 'INVALID_ARGUMENT');
});
test('geometry: measured overlaps, bounded avoidance, and hidden-parent exclusion', () => {
  const f = fixture(); seed(f, { x: -0.685, scaleX: 0.37, scaleZ: 0.4 });
  const plan = f.prepare('arrange_objects', { ops: [prop('shot_camera')] });
  near(plan.checks.maximumFootprintOverlapM, 0.12); assert.deepEqual(plan.checks.overlapIds, ['cube']);
  const avoided = f.apply('arrange_objects', { collisionPolicy: 'avoid', ops: [prop('shot_camera')] });
  near(f.state.objects[1].x, -1.37); near(avoided.checks.actualGapM, 0.62); assert.deepEqual(avoided.checks.overlapIds, []);
  const g = fixture(); seed(g, { x: -1.05 }); g.refuse('arrange_objects', { collisionPolicy: 'avoid', ops: [prop('world')] }, 'VERIFICATION_FAILED');
  for (const parent of [false, true]) {
    const h = fixture(); seed(h, { x: -0.685, scaleX: 0.37, scaleZ: 0.4, hidden: true });
    if (parent) h.state.objects.push({ ...h.state.objects[0], id: 'child', hidden: false, parent: 'cube' });
    assert.deepEqual(h.prepare('arrange_objects', { ops: [prop('shot_camera')] }).checks.overlapIds, []);
  }
  const h = fixture(); seed(h, { x: -0.685, scaleX: 0.37, scaleZ: 0.4 }); const placed = h.apply('arrange_objects', { ops: [prop('shot_camera')] });
  const { coverage, overlapIds, maximumFootprintOverlapM } = placed.checks;
  assert.deepEqual(placementChecks(['cylinder'], h.state, h.ports), { coverage, overlapIds, maximumFootprintOverlapM, supportGapM: { cylinder: DECK_LIFT_M }, unsupportedIds: [] });
  assert.deepEqual(placementChecks(['alex'], h.state, h.ports), { coverage, overlapIds: [], maximumFootprintOverlapM: 0, supportGapM: {}, unsupportedIds: [] }, 'a character has no support gap');
});
test('geometry: a floor-resting object is lifted off the deck plane; stacked and raised ones keep their y (#1075)', () => {
  const f = fixture(), bottom = o => Math.min(...boxCorners(o).map(p => p.y));
  const plan = f.apply('arrange_objects', { ops: [
    { op: 'create', source: { kind: 'cube' }, name: 'Street', scale: { x: 20, y: 0.05, z: 20 }, position: { world: { x: 0, y: 0, z: 0 } } },
    { op: 'create', source: { kind: 'cube' }, name: 'Near', position: { world: { x: 30, y: 0.0008, z: 0 } } },
    { op: 'create', source: { kind: 'cube' }, name: 'Raised', position: { world: { x: 33, y: 0.002, z: 0 } } },
    { op: 'create', source: { kind: 'cube' }, name: 'Crate', position: { world: { x: 36, y: 0, z: 0 } } },
    { op: 'create', source: { kind: 'cube' }, name: 'Box', scale: { x: 0.5, y: 0.5, z: 0.5 }, position: { onObject: 'Crate' } },
    { op: 'create', source: { kind: 'cylinder' }, name: 'Side', position: { relativeTo: 'Crate', basis: 'world', side: 'right', gapM: 0.2, support: 'floor' } },
    { op: 'create', source: { kind: 'cube' }, name: 'Tilted', rotationDeg: { x: 0, y: 0, z: 20 }, position: { relativeTo: 'Crate', basis: 'world', side: 'left', gapM: 0.5, support: 'floor' } },
    { op: 'create', source: { kind: 'empty' }, name: 'Rig', position: { world: { x: 40, y: 0, z: 0 } } },
  ] });
  const by = n => f.state.objects.find(o => o.name === n);
  for (const name of ['Street', 'Near', 'Crate', 'Side', 'Tilted']) near(bottom(by(name)), DECK_LIFT_M);
  near(by('Raised').y, 0.002); near(by('Rig').y, 0);
  near(by('Box').y, by('Crate').y + by('Crate').supportY * by('Crate').scaleY);
  assert.deepEqual(plan.warnings.filter(w => w.code === 'CLAMPED'), [], 'the lift is not a clamp of y');
  assert.deepEqual(plan.warnings.filter(w => w.code === 'FLOOR_LIFT').map(w => w.count), [5]);
  // Moving a lifted object again is idempotent, and one lift names its object.
  assert.strictEqual(f.prepare('arrange_objects', { ops: [{ op: 'update', id: by('Crate').id, position: { world: { x: 36, y: 0, z: 0 } } }] }).draft, f.state.objects);
  const one = fixture().apply('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, name: 'Solo', position: { world: { x: 0, y: 0, z: 0 } } }] });
  assert.match(one.warnings.find(w => w.code === 'FLOOR_LIFT').message, /^Solo lifted 3 mm off the deck/);
});
test('geometry: placement reports how far each object, a group as one unit, stands off its support', () => {
  const f = fixture(), part = (id, parent, patch) => seed(f, { id, parent, ...patch }), small = s => ({ scaleX: s, scaleY: s, scaleZ: s });
  seed(f, { id: 'crate', x: 3 }); seed(f, { id: 'onCrate', x: 3, y: 1, ...small(0.3) });
  seed(f, { id: 'onFloor', x: 0, z: 3 }); seed(f, { id: 'hover', x: 6, y: 0.05, ...small(0.3) });
  f.state.objects.push({ ...createSceneObject('empty'), id: 'rifle', x: 9, y: 0.5 });
  part('stock', 'rifle', { x: 9, y: 0.3, ...small(0.2) }); part('mag', 'rifle', { x: 9.05, y: 0.016, ...small(0.1) });
  f.state.objects.push({ ...createSceneObject('light'), id: 'lamp', x: 0, y: 2, z: -3 });
  seed(f, { id: 'held', x: 12, y: 1, attach: { characterId: 'alex', bone: 'RightHand' } });
  seed(f, { id: 'inHand', x: 15, y: 1.32, ...small(0.2) }); seed(f, { id: 'later', x: 18, y: 0.5, ...small(0.2) });
  seed(f, { id: 'door', x: 21, y: 0.4, ...small(0.2) });
  f.state.objects.push({ ...createSceneObject('empty'), id: 'kit', x: 24, y: 1 }); part('kitPart', 'kit', { x: 24, y: 1, ...small(0.1) });
  const spec = { objects: { inHand: { prop: 'grip' }, later: { prop: 'grip', grab: 30 }, door: { pivot: [0, 0, 0], axis: [0, 1, 0], channel: 'door' }, kit: { follow: 'joint:Hips' } } };
  const takes = new Map([['alex', { motion: { schema: 'cozyclay.take.v3', spec } }]]);
  const ids = ['crate', 'onCrate', 'onFloor', 'hover', 'stock', 'mag', 'rifle', 'lamp', 'held', 'inHand', 'later', 'door', 'kitPart', 'alex'];
  const { supportGapM, unsupportedIds } = placementChecks(ids, f.state, { ...f.ports, takes });
  assert.deepEqual(supportGapM, { crate: 0, onCrate: 0, onFloor: 0, hover: 0.05, rifle: 0.016, later: 0.5 },
    'resting on the floor or a top reads 0; a group is judged once by its lowest part; lights, attached records and what a take moves are left out, a carry grabbed later is measured at its scene pose');
  assert.deepEqual(unsupportedIds, ['hover', 'rifle', 'later']);
  assert.deepEqual(placementChecks(['inHand'], f.state, f.ports).supportGapM, { inHand: 1.32 }, 'without the takes every object is measured at its scene pose');
});
test('geometry: one batch builds a grouped assembly by parent name and moves as one body', () => {
  const f = fixture(), at = x => ({ world: { x, y: 0, z: 2 } });
  const plan = f.apply('arrange_objects', { ops: [
    { op: 'create', source: { kind: 'cube' }, name: 'Truck', position: at(5) },
    { op: 'create', source: { kind: 'cube' }, name: 'Truck Cab', position: at(5.2), parent: 'Truck' },
    { op: 'create', source: { kind: 'cylinder' }, name: 'Truck Wheel', position: at(5.1), parent: 'Truck Cab' },
  ] });
  const [body, cab, wheel] = f.state.objects;
  assert.deepEqual([body.parent, cab.parent, wheel.parent], [null, body.id, cab.id]);
  assert.deepEqual(plan.checks.overlapIds, [], 'parts of one assembly do not report overlapping each other');
  f.apply('arrange_objects', { ops: [{ op: 'update', id: body.id, position: at(8) }] });
  near(f.state.objects[1].x, 8.2); near(f.state.objects[2].x, 8.1);
  seed(f, { id: 'barrel', x: 8, z: 2 });
  assert.deepEqual(placementChecks([body.id], f.state, f.ports).overlapIds, ['barrel'], 'a separate body still overlaps');
  f.apply('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, name: 'Mirror', position: at(8), parent: body.id }] });
  assert.equal(f.state.objects[4].parent, body.id, 'an existing id is a valid parent');
  f.refuse('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, position: at(0), parent: 'Ghost' }] }, 'AMBIGUOUS_TARGET');
  f.refuse('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, name: 'Loop', position: at(0), parent: 'Loop' }] }, 'INVALID_ARGUMENT');
});
const boxCorners = o => { const e = new Euler(o.rotX * Math.PI / 180, o.rot * Math.PI / 180, o.rotZ * Math.PI / 180, 'XYZ'), w = o.footprint.width * o.scaleX / 2, d = o.footprint.depth * o.scaleZ / 2;
  return [-w, w].flatMap(x => [0, o.height * o.scaleY].flatMap(y => [-d, d].map(z => new Vector3(x, y, z).applyEuler(e).add(new Vector3(o.x, o.y, o.z))))); };
const car = () => [
  { op: 'create', source: { kind: 'cube' }, name: 'Chassis', scale: { x: 2, y: 0.5, z: 4 }, position: { world: { x: 6, y: 0, z: 3 } } },
  { op: 'create', source: { kind: 'cube' }, name: 'Hood', scale: { x: 1, y: 0.2, z: 1 }, position: { onObject: 'Chassis', offsetXZ: { x: 0, z: 1 } }, parent: 'Chassis' },
  { op: 'create', source: { kind: 'cube' }, name: 'Right Fender', scale: { x: 0.3, y: 0.2, z: 1 }, position: { relativeTo: 'Hood', basis: 'world', side: 'right', gapM: 0.1, support: { objectId: 'Chassis' } } },
  { op: 'create', source: { kind: 'cube' }, name: 'Badge', scale: { x: 0.1, y: 0.1, z: 0.1 }, position: { between: ['Hood', 'Right Fender'], fraction: 0.5, support: 'floor' } },
  { op: 'create', source: { kind: 'cube' }, name: 'Windshield', scale: { x: 1, y: 0.6, z: 0.05 }, rotationDeg: { x: -30, y: 0, z: 0 }, position: { onObject: 'Chassis', offsetXZ: { x: 0, z: 0 } } },
];
test('geometry: a batch references parts created earlier in the same batch (onObject / relativeTo / between / rotationDeg)', () => {
  const f = fixture(), plan = f.apply('arrange_objects', { ops: car() });
  const by = n => f.state.objects.find(o => o.name === n);
  const [chassis, hood, fender, badge, shield] = ['Chassis', 'Hood', 'Right Fender', 'Badge', 'Windshield'].map(by);
  near(hood.y, chassis.y + chassis.supportY * chassis.scaleY); near(hood.x, chassis.x); near(hood.z, chassis.z + 1); assert.equal(hood.parent, chassis.id);
  near(fender.x, hood.x + hood.footprint.width * hood.scaleX / 2 + 0.1 + fender.footprint.width * fender.scaleX / 2);
  near(fender.z, hood.z);
  assert.ok(plan.details.some(d => d.id === fender.id && Math.abs(d.actualGapM - 0.1) < 1e-8), 'relation readback resolves the in-batch name');
  near(badge.x, (hood.x + fender.x) / 2); near(badge.z, (hood.z + fender.z) / 2);
  assert.deepEqual([shield.rotX, shield.rot, shield.rotZ], [-30, 0, 0]);
  near(Math.min(...boxCorners(shield).map(p => p.y)), chassis.y + chassis.supportY * chassis.scaleY);
  // The same batch is deterministic.
  const g = fixture(); g.apply('arrange_objects', { ops: car() });
  assert.deepEqual(g.state.objects, f.state.objects);
  // A reference to a part created LATER, a missing name, an ambiguous name and a self reference teach the fix.
  fixture().refuse('arrange_objects', { ops: [car()[1], car()[0]] }, 'AMBIGUOUS_TARGET');
  assert.throws(() => fixture().prepare('arrange_objects', { ops: [car()[0], { ...car()[1], position: { onObject: 'Bonnet' } }] }), e => e.code === 'AMBIGUOUS_TARGET' && /'Bonnet' not found; .*created EARLIER in this batch by its name/.test(e.message));
  const h = fixture(); h.state.objects.push({ ...createSceneObject('cube'), id: 'a', name: 'Twin' }, { ...createSceneObject('cube'), id: 'b', name: 'Twin' });
  assert.throws(() => h.prepare('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, position: { onObject: 'Twin' } }] }), e => e.code === 'AMBIGUOUS_TARGET' && /matches 2 objects by name/.test(e.message));
  h.refuse('arrange_objects', { ops: [{ op: 'update', id: 'a', position: { onObject: 'Twin' } }] }, 'AMBIGUOUS_TARGET');
  h.refuse('arrange_objects', { ops: [{ op: 'update', id: 'a', position: { onObject: 'a' } }] }, 'INVALID_ARGUMENT');
  // Facing targets resolve against the draft too.
  const k = fixture(); k.apply('arrange_objects', { ops: [car()[0], { op: 'create', source: { kind: 'cylinder' }, name: 'Seat', position: { world: { x: 0, y: 0, z: 0 } }, facing: { towardId: 'Chassis' } }] });
  near(k.state.objects[1].rot, Math.atan2(6, 3) * 180 / Math.PI);
});
test('geometry: create takes rotationDeg, exclusive with facing, and avoid accepts in-batch references', () => {
  const f = fixture();
  f.apply('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, name: 'Tilt', rotationDeg: { x: 10, y: 20, z: 30 }, position: { world: { x: 1, y: 0, z: 1 } } }, { op: 'create', source: { kind: 'cube' }, name: 'Flat', rotationDeg: { x: 0, y: 45, z: 0 }, position: { world: { x: 3, y: 0, z: 3 } } }] });
  assert.deepEqual(f.state.objects.map(o => [o.rotX, o.rot, o.rotZ]), [[10, 20, 30], [0, 45, 0]]);
  fixture().refuse('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, rotationDeg: { x: 0, y: 0, z: 0 }, facing: { yawDeg: 0 }, position: { world: { x: 0, y: 0, z: 0 } } }] }, 'INVALID_ARGUMENT');
  assert.throws(() => validateStudioCommand({ name: 'arrange_objects', args: { ops: [{ op: 'create', source: { kind: 'cube' }, rotationDeg: { x: 0, y: 0, z: 0 }, facing: { yawDeg: 0 }, position: { world: { x: 0, y: 0, z: 0 } } }] } }), e => /rotationDeg \{x,y,z\}/.test(e.message));
  const g = fixture();
  const avoided = g.apply('arrange_objects', { collisionPolicy: 'avoid', ops: [
    { op: 'create', source: { kind: 'cube' }, name: 'Base', position: { world: { x: 6, y: 0, z: 3 } } },
    { op: 'create', source: { kind: 'cylinder' }, name: 'Side', position: { relativeTo: 'Base', basis: 'world', side: 'right', gapM: 0.2, support: 'floor' } }] });
  near(avoided.details[0].actualGapM, 0.2);
  fixture().refuse('arrange_objects', { collisionPolicy: 'avoid', ops: [{ op: 'create', source: { kind: 'cube' }, position: { world: { x: 0, y: 0, z: 0 } } }] }, 'INVALID_ARGUMENT');
});
test('geometry: grouping, carried children, removal, no-op and preserved cast layers/selection', () => {
  const f = fixture(); f.apply('arrange_objects', { ops: [prop('world'), { op: 'create', source: { kind: 'cube' }, position: { world: { x: 3, y: 0, z: 0 } } }] });
  f.apply('arrange_objects', { ops: [{ op: 'group', parentId: 'cylinder', childIds: ['cube'] }, { op: 'update', id: 'cylinder', position: { world: { x: 0, y: 0, z: 0 } } }] });
  near(f.state.objects[1].x, 4.25); assert.equal(f.state.objects[1].parent, 'cylinder');
  f.refuse('arrange_objects', { ops: [{ op: 'group', parentId: 'cube', childIds: ['cylinder'] }] }, 'INVALID_ARGUMENT');
  f.apply('arrange_objects', { ops: [{ op: 'remove', id: 'cylinder' }] }); assert.equal(f.state.objects[0].parent, null);
  assert.strictEqual(f.prepare('arrange_objects', { ops: [{ op: 'update', id: 'cube', position: { world: { x: 4.25, y: 0, z: 0 } } }] }).draft, f.state.objects);
  f.apply('arrange_objects', { ops: [{ op: 'update', id: 'cube', hidden: true }] }); assert.equal(f.state.objects[0].hidden, true);
  f.apply('arrange_characters', { ops: [{ op: 'create', name: 'Bob', position: relative('world'), scale: 2 }] });
  const bob = f.state.characters[1], layer = structuredClone(bob.layer); near(bob.x, -1.25); assert.equal(bob.scale, 2); assert.equal(f.state.activeCharacterId, 'alex');
  f.apply('arrange_characters', { ops: [{ op: 'update', characterId: bob.id, name: 'Robert', hidden: true }] }); assert.deepEqual(f.state.characters[1].layer, layer);
  f.apply('arrange_characters', { ops: [{ op: 'remove', characterId: bob.id }] }); assert.equal(f.state.characters.length, 1);
  f.refuse('arrange_characters', { ops: [{ op: 'remove', characterId: 'alex' }] }, 'INVALID_ARGUMENT');
  f.refuse('arrange_characters', { ops: [{ op: 'create', name: 'Alex', position: { world: { x: 1, y: 0, z: 0 } } }] }, 'DUPLICATE_NAME');
  const g = fixture(); seed(g, { x: 4 });
  g.refuse('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cylinder' }, position: { ...relative('world'), relativeTo: 'cube' } }, { op: 'update', id: 'cube', position: { world: { x: 5, y: 0, z: 0 } } }] }, 'STALE_SCENE');
  assert.deepEqual(g.state.objects.map(({ id, x, z }) => ({ id, x, z })), [{ id: 'cube', x: 4, z: 0 }]);
});
test('geometry: measured default skin, scale=2, exact clearance and strict support refusals', () => {
  const measured = { min: { x: -0.25069919668017837, y: -0.00010230400198583725, z: -0.22550816444218705 }, max: { x: 0.25061193225927636, y: 1.8046321105951333, z: 0.20375764888362347 } };
  const bounds = ({ entity }) => Object.fromEntries(['min', 'max'].map(edge => [edge, Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, entity[axis] + measured[edge][axis] * entity.scale]))]));
  const create = { op: 'create', name: 'B', position: { relativeTo: 'alex', basis: 'shot_camera', side: 'right', gapM: 2, support: 'floor' } };
  for (const scale of [1, 2]) {
    const f = fixture(); f.ports.bounds = bounds;
    const cube = f.apply('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, position: { ...create.position, side: 'left', gapM: 1 } }] }); near(cube.checks.actualGapM, 1);
    const objects = structuredClone(f.state.objects), plan = f.apply('arrange_characters', { ops: [{ ...create, scale }] });
    const second = f.state.characters[1], skin = bounds({ entity: second }); assert.equal(second.y, 0); assert.ok(Math.abs(skin.min.y) <= 0.005);
    near(skin.min.x - bounds({ entity: f.state.characters[0] }).max.x, 2); near(plan.checks.actualGapM, 2); near(plan.checks.baseY, 0); assert.equal(plan.checks.support, 'floor');
    assert.deepEqual(f.state.objects, objects); assert.equal(f.state.activeCharacterId, 'alex');
  }
  for (const scenario of ['tilted-support', 'unavailable', 'unavailable-after-measurement', 'clamped', 'unresponsive-bounds', 'batch-failure']) {
    const f = fixture(); f.ports.bounds = bounds; let ops = [create], code = 'TARGET_NOT_READY';
    if (scenario === 'tilted-support') { f.state.objects = [{ ...createSceneObject('cylinder'), rotX: 10 }]; ops = [{ ...create, position: { onObject: 'cylinder' } }]; }
    if (scenario === 'unavailable') f.ports.bounds = () => null;
    if (scenario === 'unavailable-after-measurement') { let measured = false; f.ports.bounds = input => { if (input.entity.id !== 'alex' && measured) return null; if (input.entity.id !== 'alex') measured = true; return bounds(input); }; }
    if (['clamped', 'unresponsive-bounds'].includes(scenario)) f.ports.bounds = input => { const box = bounds(input); if (input.entity.id !== 'alex') box.min.y = input.entity.y + (scenario === 'clamped' ? 0.1 : -0.0051); return box; };
    if (scenario === 'batch-failure') { ops = [create, { ...create, name: 'Alex' }]; code = 'DUPLICATE_NAME'; }
    f.refuse('arrange_characters', { ops }, code);
  }
});
test('framing: independent filmback inversion, key/lens/aim boundaries and measured projection', () => {
  const f = fixture(), plan = f.apply('frame_shot', { subjectIds: ['alex'], framing, keyAtFrame: 48 }), shot = f.state.shotDocument.shots[0];
  assert.equal(shot.name, 'Shot 1'); assert.equal(shot.startFrame, 0); assert.equal(shot.endFrame, 143); assert.equal(shot.cameraKeys[0].frame, 48); near(f.state.camera.position.y, 1.65);
  const distance = 1.8 * 35 / (0.975 * 20.25); near(f.state.camera.position.z, Math.sqrt(distance ** 2 - 0.35 ** 2)); near(shot.cameraKeys[0].framing.fovDeg, 2 * Math.atan(20.25 / 70) * 180 / Math.PI);
  assert.equal(plan.checks.derivedSize, 'medium shot'); assert.equal(plan.details.created, true); assert.deepEqual(framingChecks(['alex'], f.state, f.ports), plan.checks);
  f.state.camera = null; assert.throws(() => framingChecks(['alex'], f.state, f.ports), error => error.code === 'TARGET_NOT_READY');
  const g = fixture(); g.state.frameCount = 0; g.refuse('frame_shot', { subjectIds: ['alex'], framing }, 'TARGET_NOT_READY');
  // The empty-timeline refusal names only commands an agent may call: no ui-only shot command.
  let empty; try { g.prepare('frame_shot', { subjectIds: ['alex'], framing }); } catch (error) { empty = error; }
  const uiOnly = shotDeclarations.filter(entry => entry.exposure === 'ui-only').map(entry => entry.id);
  for (const named of empty.message.match(/\b[a-z]+\.[a-zA-Z]+\b/g) ?? []) assert.ok(!uiOnly.includes(named), `the empty-timeline refusal names the ui-only ${named}: ${empty.message}`);
  assert.match(empty.message, /motion\.compile/, empty.message);
  g.state.frameCount = 144; g.state.shotDocument.shots = [createShot('Later', 60, 100)]; g.refuse('frame_shot', { subjectIds: ['alex'], framing }, 'AMBIGUOUS_TARGET');
  g.state.selectedShotId = g.state.shotDocument.shots[0].id; g.refuse('frame_shot', { subjectIds: ['alex'], framing, keyAtFrame: 101 }, 'INVALID_RANGE');
  const exact = { exact: { position: { x: 3, y: 2, z: 4 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35 } };
  g.apply('frame_shot', { subjectIds: ['alex'], framing: exact, keyAtFrame: 80 }); assert.deepEqual(g.state.camera.position, exact.exact.position); assert.deepEqual(g.state.camera.lookAt, exact.exact.lookAt);
  g.refuse('frame_shot', { subjectIds: ['alex'], framing: { intent: { ...framing.intent, focalMm: 1 } }, keyAtFrame: 80 }, 'INVALID_ARGUMENT');
  const fractions = [0, 4].map(z => fixture().prepare('frame_shot', { subjectIds: ['alex'], framing: { exact: { position: { x: 0, y: 1, z: 5 }, lookAt: { x: 0, y: 1, z }, focalMm: 35 } } }).checks.screenFraction);
  near(...fractions);
});
test('framing: measured occlusion and camera side instead of an unmeasured warning', () => {
  const exact = position => ({ exact: { position, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35 } });
  const f = fixture(), clear = f.prepare('frame_shot', { subjectIds: ['alex'], framing: exact({ x: 0, y: 1.6, z: 5 }) });
  assert.equal(clear.checks.occluded, false); assert.equal(clear.checks.cameraSide, undefined, 'one character has no line to be on a side of');
  assert.deepEqual(clear.warnings, [], 'a clear sight line warns nothing');
  seed(f, { id: 'crate', x: 0, z: 2.5, scaleY: 2 });
  const blocked = f.prepare('frame_shot', { subjectIds: ['alex'], framing: exact({ x: 0, y: 1.6, z: 5 }) });
  assert.equal(blocked.checks.occluded, true); assert.deepEqual(blocked.warnings, [{ code: 'OCCLUDED', id: 'crate' }]);
  f.state.characters.push(createCharacterEntry({ id: 'bea', subject: 'Bea', x: 2, z: 0 }));
  const right = f.apply('frame_shot', { subjectIds: ['alex'], framing: exact({ x: 1, y: 1.6, z: 5 }) });
  assert.equal(right.checks.cameraSide, 'right'); assert.equal(f.prepare('frame_shot', { subjectIds: ['alex'], framing: exact({ x: 1, y: 1.6, z: -5 }) }).checks.cameraSide, 'left');
  assert.deepEqual(framingChecks(['alex'], f.state, f.ports), right.checks, 'verify measures what the receipt reported');
  const { coverage, screenFraction, derivedSize, behindCamera, clipped } = right.checks;
  assert.deepEqual(Object.keys(right.checks), ['coverage', 'screenFraction', 'derivedSize', 'behindCamera', 'clipped', 'occluded', 'cameraSide']);
  assert.ok(coverage && screenFraction > 0 && derivedSize && behindCamera === false && typeof clipped === 'boolean');
});
test('shared journal: retained outcomes, in-flight protection, deterministic expiry and host isolation', () => {
  const host = fixture().state.host; let clock = 0, retain = true;
  const journal = createStudioCommandJournal({ host, now: () => clock, isRetained: () => retain, maxCompleted: 1 });
  const receipt = validateReceipt({ ok: true, commandId: 'view', receiptId: 'view-receipt', host, status: 'transient', authored: false, revision: { before: 1, after: 1 }, affectedIds: ['alex'], delta: [{ id: 'alex', after: { activeCharacterId: 'alex' } }], checks: { coverage: 'view-only' }, view: { before: 0, after: 1 }, undo: null, warnings: [] });
  journal.begin('view'); journal.record(receipt); journal.begin('in-flight'); clock = 600001; journal.prune();
  assert.deepEqual(journal.reconcile({ commandId: 'view' }), { status: 'not_applied', receipt });
  assert.equal(journal.begin('view'), false); assert.equal(journal.reconcile({ commandId: 'missing' }).status, 'unknown');
  assert.equal(journal.reconcile({ commandId: 'view', host: { ...host, documentEpoch: 'reloaded' } }).status, 'unknown');
  retain = false; journal.prune(); assert.equal(journal.reconcile({ commandId: 'view' }).status, 'unknown'); assert.equal(journal.begin('in-flight'), false);
});
test('shared contract: physical target/IK fingerprint changes, view exclusion and normalized defaults', () => {
  const input = { objects: [], characters: [{ id: 'alex', incarnation: 'incarnation', modelId: 'y-bot-tpose', rigId: 'rig', rigReady: true, hidden: false, position: { x: 0, y: 0, z: 0 }, yawDeg: 0, scale: 1, takeId: null, sessionMotionId: null, motionRevision: 0, calibrationRevision: 0, ikRevision: 0, waypoints: [] }], floor: { model: 'flat', y: 0 }, frameCount: 144 };
  const before = physicsFingerprintInput(input); assert.deepEqual(physicsFingerprintInput({ ...input, frame: 99, selection: 'other', camera: { x: 2 } }), before);
  input.characters[0].ikRevision++; assert.notDeepEqual(physicsFingerprintInput(input), before);
  const ik = physicsFingerprintInput(input); input.characters[0].position.x = 1; assert.notDeepEqual(physicsFingerprintInput(input), ik);
  assert.equal(validateStudioCommand({ name: 'arrange_objects', args: { ops: [prop('world')] } }).args.collisionPolicy, 'report'); assert.deepEqual(studioObjectCatalogue().imageRefs, []);
});

test('framing #1042: crew words and defaults land on the first call; a wrong subject says which ids work', () => {
  const words = validateStudioCommand({ name: 'frame_shot', args: { subjectIds: 'alex', framing: { intent: { size: 'Medium', view: 'side', level: 'eye level' } } } }).args;
  assert.deepEqual(words.subjectIds, ['alex'], 'a lone id becomes the one-item list');
  assert.deepEqual(words.framing.intent, { size: 'medium shot', view: 'profile', level: 'eye', side: 'left' }, 'spellings read as the declared words; side defaults');
  assert.deepEqual(validateStudioCommand({ name: 'frame_shot', args: { subjectIds: ['alex'], framing: { intent: { size: 'wide shot' } } } }).args.framing.intent,
    { size: 'wide shot', view: 'front', level: 'eye', side: 'left' }, 'size alone is a whole intent');
  for (const [size, want] of [['CU', 'close-up'], ['close up', 'close-up'], ['MCU', 'medium close-up'], ['wide', 'wide shot'], ['full shot', 'wide shot'], ['medium wide', 'medium-wide shot'], ['establishing', 'extreme wide shot']])
    assert.equal(validateStudioCommand({ name: 'frame_shot', args: { subjectIds: ['alex'], framing: { intent: { size } } } }).args.framing.intent.size, want, size);
  assert.throws(() => validateStudioCommand({ name: 'frame_shot', args: { subjectIds: ['alex'], framing: { intent: { size: 'huge' } } } }),
    error => error.code === 'INVALID_ARGUMENT' && /\$\.args\.framing\.intent\.size: "huge" is not one of: extreme close-up, close-up/.test(error.message) && error.details.rule === 'enum', 'an unknown size lists the allowed ones');
  assert.deepEqual(validateStudioCommand({ name: 'frame_shot', args: { subjectIds: ['alex', 'blair'], framing: { intent: { size: 'wide shot' } } } }).args.subjectIds,
    ['alex', 'blair'], 'a group framing keeps every named subject');

  const f = fixture();
  seed(f, { id: 'table' });
  assert.throws(() => f.prepare('frame_shot', { subjectIds: ['table'], framing }),
    error => error.code === 'INVALID_ARGUMENT' && /table is an object; frame_shot frames a character\. Visible character ids: alex\./.test(error.message) && error.details.path === '$.args.subjectIds[]');
  assert.throws(() => f.prepare('frame_shot', { subjectIds: ['ghost'], framing }), error => error.code === 'STALE_TARGET' && /no character ghost in this scene\. Visible character ids: alex\./.test(error.message));
  f.state.characters[0].hidden = true;
  assert.throws(() => f.prepare('frame_shot', { subjectIds: ['alex'], framing }), error => error.code === 'TARGET_NOT_READY' && /alex is hidden.*hidden: false/.test(error.message));
  const g = fixture(); g.state.camera = null;
  assert.throws(() => g.prepare('frame_shot', { subjectIds: ['alex'], framing }), error => error.code === 'TARGET_NOT_READY' && /still loading.*send the same frame_shot again/.test(error.message), 'not ready says wait and retry');
});
