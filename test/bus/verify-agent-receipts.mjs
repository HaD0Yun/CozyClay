// Edit receipts make failures visible: findings reach the receipt, silent
// ignores and clamps are named, readback carries the transform actually kept,
// and verify_result measures a receipt that carries no placement evidence.
import assert from 'node:assert/strict';
import { objectsFixture } from './objects-fixture.mjs';
import { coplanarConflicts } from '../../src/coplanar-depth.js';

const f = objectsFixture([]);
const arrange = ops => f.binding.handlers.arrange_objects(f.request('arrange_objects', { ops }));
const create = (name, world, scale, extra = {}) => ({ op: 'create', source: { kind: 'cube' }, name, position: { world }, ...(scale ? { scale } : {}), ...extra });
const find = (receipt, code) => receipt.warnings.filter(w => w.code === code);
try {
  // 1. An overlap the arrangement measured is a warning on the receipt, with evidence.
  const first = arrange([create('Crate A', { x: 6, y: 0, z: 6 })]);
  assert.equal(first.status, 'applied', JSON.stringify(first));
  assert.deepEqual(find(first, 'FOOTPRINT_OVERLAP'), []);
  const second = arrange([create('Crate B', { x: 6.2, y: 0, z: 6 })]);
  assert.equal(second.status, 'applied', JSON.stringify(second));
  const [overlap] = find(second, 'FOOTPRINT_OVERLAP');
  assert.equal(overlap?.id, first.affectedIds[0], JSON.stringify(second));
  assert.match(overlap.message, /Crate B overlaps Crate A by 0\.8 m/);
  assert.deepEqual(second.checks.overlapIds, [first.affectedIds[0]]);
  assert.ok(second.checks.maximumFootprintOverlapM > 0.7);
  console.log('PASS overlap warning and evidence reach the receipt');

  // 2. object.update: a key nothing reads is an error for the wire, lenient for the UI.
  // The agent's index leaves the command out (object.set and arrange_objects declare
  // every key); the wire keeps it for MCP's update_object and the CLI, and names the
  // unknown key instead of ignoring it.
  const [crateA, crateB] = [first.affectedIds[0], second.affectedIds[0]];
  const revision = f.binding.refresh().revision;
  assert.ok(!f.binding.context().actionIndex.some(row => row.id === 'object.update'), 'the agent index omits object.update');
  const unknown = f.run('object.update', { id: crateB, patch: { scale: 2, foo: 1, x: 7 } }, 'agent');
  assert.equal(unknown.ok, false, JSON.stringify(unknown));
  assert.equal(unknown.code, 'INVALID_ARGUMENT');
  assert.match(unknown.message, /cannot set scale/); assert.match(unknown.message, /Supported fields/);
  assert.equal(f.run('object.update', { id: crateB, patch: { foo: 1 } }, 'ui').status, 'noop', 'the UI door stays lenient');
  console.log('PASS object.update names an unknown key on the wire and stays lenient for the UI');

  // 3. Clamps are warnings, in object.update and in arrange_objects.
  const clamped = f.run('object.update', { id: crateB, patch: { scaleY: 0.0025, x: 6.2 } }, 'ui');
  assert.equal(clamped.status, 'applied', JSON.stringify(clamped));
  assert.deepEqual(find(clamped, 'CLAMPED').map(w => [w.id, w.message]), [[crateB, 'Clamped: scaleY 0.0025→0.01 (minimum 0.01)']]);
  assert.equal(f.run('object.update', { id: crateB, patch: { scaleY: 0.01 } }, 'ui').status, 'noop');
  const far = f.run('object.update', { id: crateB, patch: { x: 900 } }, 'ui');
  assert.match(find(far, 'CLAMPED')[0].message, /x 900→240 \(maximum 240 m\)/);
  const squash = arrange([create('Slab', { x: -6, y: 0, z: -6 }, { x: 1, y: 0.0025, z: 1 })]);
  assert.match(find(squash, 'CLAMPED')[0].message, /scaleY 0\.0025→0\.01 \(minimum 0\.01\)/, JSON.stringify(squash.warnings));
  console.log('PASS clamps are CLAMPED warnings');

  // 4. Readback: transform kept, group links, world box.
  const [crate] = squash.affectedIds;
  const row = f.objects.read().find(o => o.id === crate);
  const readback = squash.delta[0].after, path = name => readback.patched.find(p => p.path === `object.${name}`);
  assert.deepEqual(path('rotation').vec, { x: 0, y: 0, z: 0 });
  assert.deepEqual(path('scale').vec, { x: 1, y: 0.01, z: 1 }, 'scale reads back after the clamp');
  assert.equal(path('parent').text, null);
  assert.equal(readback.childIds, undefined);
  // The slab asked for y 0 is lifted 3 mm off the deck (#1075) and says so.
  assert.deepEqual(readback.bounds, { min: { x: -6 - row.footprint.width / 2, y: 0.003, z: -6 - row.footprint.depth / 2 }, max: { x: -6 + row.footprint.width / 2, y: Number((0.003 + row.height * 0.01).toFixed(4)), z: -6 + row.footprint.depth / 2 } });
  assert.equal(find(squash, 'FLOOR_LIFT')[0].id, crate);
  const many = arrange(Array.from({ length: 10 }, (_, i) => create(`Bulk ${i}`, { x: 20 + i * 3, y: 0, z: -20 })));
  assert.equal(many.delta.length, 8);
  const truncated = find(many, 'READBACK_TRUNCATED');
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0].count, 2, 'the receipt says how many readbacks it left out');
  assert.equal(many.affectedIds.length, 10);
  // A batch whose readback and findings overflow 8 KiB sheds extras instead of failing an applied edit.
  const huge = arrange(Array.from({ length: 100 }, (_, i) => create(`Prop ${i} ${'x'.repeat(100)}`, { x: 40, y: 0, z: 40 }, { x: 1, y: 0.001, z: 1 })));
  assert.equal(huge.status, 'applied', JSON.stringify(huge).slice(0, 300));
  assert.equal(huge.affectedIds.length, 100);
  assert.ok(find(huge, 'CLAMPED').length > 0 && find(huge, 'READBACK_TRUNCATED').length === 1, 'the findings that fit still lead');
  assert.ok(JSON.stringify(huge).length <= 8192);
  console.log('PASS readback carries rotation, scale, parent, children and bounds; truncation is stated');

  // 5. verify_result(receiptId) measures a receipt that has no placement evidence.
  const moved = f.run('object.update', { id: crateB, patch: { x: 6.1 } }, 'ui');
  assert.equal(moved.status, 'applied');
  assert.equal(moved.checks.overlapIds, undefined, 'an update receipt carries no overlap measurement');
  const verified = await f.binding.handlers.verify_result(f.request('verify_result', { receiptId: moved.receiptId, checks: ['placement'], visual: 'none' }));
  assert.notEqual(verified.ok, false, JSON.stringify(verified));
  assert.equal(verified.checks.coverage, 'current-scene-targets');
  assert.deepEqual(verified.checks.placement.overlapIds, [crateA]);
  assert.ok(verified.checks.placement.maximumFootprintOverlapM > 0);
  assert.deepEqual(verified.unsupportedChecks, []);
  // An arrange receipt already measured placement: its own evidence is returned, not re-derived.
  const own = await f.binding.handlers.verify_result(f.request('verify_result', { receiptId: second.receiptId, checks: ['placement'], visual: 'none' }));
  assert.deepEqual(own.checks, second.checks);
  console.log('PASS verify_result measures a receipt without placement evidence');

  // 6. Same-group parts touch on purpose (no FOOTPRINT_OVERLAP) but coplanar faces are reported.
  const truck = arrange([
    create('Truck', { x: -2.2, y: 0, z: -3 }),
    create('Hood', { x: -2.2, y: 0.6, z: 1.7 }, { x: 0.95, y: 0.45, z: 1.3 }, { parent: 'Truck' }),
    create('Grille', { x: -2.2, y: 0.6, z: 2.37 }, { x: 0.75, y: 0.45, z: 0.1 }, { parent: 'Truck' }),
  ]);
  assert.equal(truck.status, 'applied', JSON.stringify(truck));
  assert.deepEqual(find(truck, 'FOOTPRINT_OVERLAP'), [], 'assembly parts are not footprint overlaps');
  const [coplanar] = find(truck, 'COPLANAR_FACES');
  assert.match(coplanar?.message ?? '', /^Hood and Grille tops coincide at y=1\.05/, JSON.stringify(truck.warnings));
  assert.equal(find(truck, 'COPLANAR_FACES').length, 1);
  const rootId = truck.affectedIds.find(id => f.objects.read().find(o => o.id === id).name === 'Truck');
  const rootReadback = truck.delta.find(d => d.id === rootId).after;
  assert.deepEqual([...rootReadback.childIds].sort(), truck.affectedIds.filter(id => id !== rootId).sort(), 'a group root reads back its children');
  assert.equal(truck.delta.find(d => d.id !== rootId).after.patched.find(p => p.path === 'object.parent').text, rootId);
  assert.ok(truck.delta.every(d => d.after.bounds.min.y <= d.after.bounds.max.y));
  const hood = f.objects.read().find(o => o.name === 'Hood');
  assert.deepEqual(f.binding.handlers.arrange_objects(f.request('arrange_objects', { ops: [{ op: 'update', id: hood.id, position: { world: { x: -2.2, y: 0.6, z: 1.7 } } }] })).warnings.filter(w => w.code === 'COPLANAR_FACES'), [], 'an untouched pair is not reported again');
  const lifted = arrange([{ op: 'update', id: f.objects.read().find(o => o.name === 'Grille').id, scale: { x: 0.75, y: 0.5, z: 0.1 } }]);
  assert.deepEqual(find(lifted, 'COPLANAR_FACES').map(w => w.message), ['Hood and Grille bottoms coincide at y=0.6'], 'a taller grille no longer shares the top plane, only the bottom one');
  // The helper itself: two stacked cubes touch on opposite faces (not coplanar); same-facing ones are.
  const cube = (id, extra) => ({ id, renderer: 'cube', x: 0, y: 0, z: 0, scaleX: 1, scaleY: 1, scaleZ: 1, rot: 0, rotX: 0, rotZ: 0, ...extra });
  assert.deepEqual(coplanarConflicts([cube('a'), cube('b', { y: 1 })]), [], 'a cube resting on a cube shares opposite faces only');
  assert.deepEqual(coplanarConflicts([cube('a'), cube('b', { scaleX: 0.5 })]).map(p => [p.a, p.b, p.planes.map(q => `${q.face}@${q.axis}${q.at}`)]), [['a', 'b', ['tops@y1', 'bottoms@y0', '+z faces@z0.5', '-z faces@z-0.5']]]);
  console.log('PASS coplanar faces inside an assembly are reported');
} finally { f.dispose(); }
