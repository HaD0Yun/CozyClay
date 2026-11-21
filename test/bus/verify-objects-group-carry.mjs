import assert from 'node:assert/strict';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { objectsFixture } from './objects-fixture.mjs';
import { createSceneObject, rotatePatch, translatePatch } from '../../src/scene-objects.js';
import { characterRowId } from '../../src/hierarchy-model.js';

// Every authored transform edit of a group root carries its parts rigidly (records are flat world
// space): object.set, patch_elements, object.update, the inspector and the gizmo. The move is the
// bat-kit edit of session 9dcf19c5 (lines 35-43), which left the kit's parts behind and came back
// "partial" with object.rotation dropped although the rotation landed.
const DEG = Math.PI / 180;
const scene = () => [
  { ...createSceneObject('empty'), id: 'grp', name: 'Bat', x: -0.3, y: 0.9, z: 0.3 },
  { ...createSceneObject('cube'), id: 'body', name: 'Bat body', parent: 'grp', x: -0.3, y: 0.9, z: 0.3, rot: 10, scaleX: 0.07, scaleY: 0.84, scaleZ: 0.07 },
  { ...createSceneObject('sphere'), id: 'cap', name: 'Bat cap', parent: 'body', x: -0.3, y: 1.72, z: 0.3, scaleX: 0.07, scaleY: 0.03, scaleZ: 0.07 },
  { ...createSceneObject('cylinder'), id: 'other', name: 'Other', x: 2, y: 0, z: -2 },
];
const MOVE = { position: { x: -0.1, y: 1.32, z: 0.32 }, rotation: { x: -17.53, y: -52.53, z: 0 } };
const matrixOf = row => new Matrix4().compose(new Vector3(row.x, row.y, row.z),
  new Quaternion().setFromEuler(new Euler(row.rotX * DEG, row.rot * DEG, row.rotZ * DEG, 'XYZ')), new Vector3(1, 1, 1));
/** Each part's pose in its parent's frame: a rigid carry keeps these. */
const local = rows => Object.fromEntries(rows.filter(row => row.parent).map(row => {
  const parent = rows.find(other => other.id === row.parent);
  return [row.id, new Matrix4().copy(matrixOf(parent)).invert().multiply(matrixOf(row)).elements];
}));
const at = (f, id) => f.objects.read().find(row => row.id === id);
function carried(f, label, before) {
  const root = at(f, 'grp');
  assert.ok(Math.abs(root.x + 0.1) < 1e-9 && Math.abs(root.y - 1.32) < 1e-9 && Math.abs(root.z - 0.32) < 1e-9, `${label}: the root moved ${JSON.stringify(root)}`);
  assert.ok(Math.abs(root.rotX + 17.53) < 1e-9 && Math.abs(root.rot + 52.53) < 1e-9 && root.rotZ === 0, `${label}: the root turned ${JSON.stringify(root)}`);
  const was = local(before), now = local(f.objects.read());
  for (const id of ['body', 'cap']) assert.ok(was[id].every((v, i) => Math.abs(v - now[id][i]) < 1e-6), `${label}: ${id} keeps its pose in its parent's frame`);
  assert.ok(Math.abs(at(f, 'cap').y - 1.72) > 0.05 && Math.abs(at(f, 'body').x + 0.3) > 0.05, `${label}: the parts moved with the root`);
  assert.deepEqual(at(f, 'other'), before.find(row => row.id === 'other'), `${label}: an unrelated record stays`);
  for (const id of ['body', 'cap']) assert.deepEqual([at(f, id).scaleX, at(f, id).scaleY], [before.find(row => row.id === id).scaleX, before.find(row => row.id === id).scaleY], `${label}: scale is not carried`);
  return f.objects.read();
}
const results = {};
function path(label, edit) {
  const f = objectsFixture(scene());
  try {
    const before = structuredClone(f.objects.read()), depth = f.objects.store.depths().past;
    const receipt = edit(f);
    results[label] = { rows: carried(f, label, before), receipt };
    assert.equal(f.objects.store.depths().past, depth + 1, `${label}: one undo entry`);
    f.actual.undoScene();
    assert.deepEqual(f.objects.read(), before, `${label}: one undo puts the parts back with the root`);
  } finally { f.dispose(); }
}
const flat = { x: MOVE.position.x, y: MOVE.position.y, z: MOVE.position.z, rotX: MOVE.rotation.x, rot: MOVE.rotation.y, rotZ: MOVE.rotation.z };

path('object.set', f => f.run('object.set', { id: 'grp', set: MOVE }));
path('patch_elements', f => f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [{ target: { kind: 'object', id: 'grp' }, set: MOVE }] })));
path('object.update', f => f.run('object.update', { id: 'grp', patch: flat }));
path('inspector', f => {
  const elements = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.children].flat(Infinity).flatMap(elements)] : [];
  const tree = f.panel('ObjectTransformPanel', { ...f.objects, selectedSceneObject: at(f, 'grp'), matteEditorRef: f.scope.matteEditorRef,
    hierarchyReparent: { onDrop: f.objects.reparentSceneObject }, setToast: f.scope.setToast });
  const [position, rotation] = elements(tree).filter(node => node.props?.fields).map(node => node.props.fields);
  const token = position[0].onScrubStart({ owner: 'inspector', cancel: () => {} });
  [flat.x, flat.y, flat.z].forEach((value, i) => position[i].onChange(value, token));
  [flat.rotX, flat.rot, flat.rotZ].forEach((value, i) => rotation[i].onChange(value, token));
  return position[0].onScrubEnd(token, { commit: true });
});
path('gizmo', f => {
  const token = f.objects.beginSceneTransaction({ owner: 'gizmo', cancel: () => {} });
  const start = structuredClone(at(f, 'grp'));
  // a plane drag in x/z, an axis drag in y, then the rings: x, then y, each from the pose the drag started on
  f.objects.changeSceneObject('grp', { ...translatePatch(start, 'x', flat.x - start.x, 0), ...translatePatch(start, 'z', flat.z - start.z, 0) }, token);
  f.objects.changeSceneObject('grp', translatePatch(at(f, 'grp'), 'y', flat.y - start.y, 0), token);
  f.objects.changeSceneObject('grp', rotatePatch(at(f, 'grp'), 'x', flat.rotX, 0), token);
  f.objects.changeSceneObject('grp', rotatePatch(at(f, 'grp'), 'y', flat.rot, 0), token);
  return f.objects.endSceneTransaction(token, { commit: true });
});

// every path lands the same records (the gizmo's rings compose in world space, so its Euler path differs; its poses agree)
for (const label of ['patch_elements', 'object.update', 'inspector']) assert.deepEqual(results[label].rows, results['object.set'].rows, `${label} lands the records object.set lands`);
const pose = rows => rows.map(row => [row.id, ...matrixOf(row).elements.map(v => +v.toFixed(6))]);
assert.deepEqual(pose(results.gizmo.rows), pose(results['object.set'].rows), 'the gizmo lands the same poses');
console.log('PASS object.set, patch_elements, object.update, the inspector and the gizmo carry a group root\'s parts rigidly (one undo each)');

// the agent's receipt: applied, nothing dropped, and the carried parts named with where they went
const patch = results.patch_elements.receipt;
assert.equal(patch.status, 'applied', JSON.stringify(patch));
assert.deepEqual(patch.ops, [{ index: 0, status: 'applied' }], 'the rotation that landed (-17.529999999999973 after the wrap) is not dropped');
assert.deepEqual([...patch.affectedIds].sort(), ['body', 'cap', 'grp']);
const body = patch.delta.find(row => row.id === 'body')?.after.patched;
assert.deepEqual(body?.map(row => row.path), ['object.position', 'object.rotation', 'object.scale'], JSON.stringify(patch.delta));
const landed = results.patch_elements.rows.find(row => row.id === 'body');
assert.deepEqual(body[0].vec, { x: landed.x, y: landed.y, z: landed.z }, 'the readback is where the part went');
const set = results['object.set'].receipt;
assert.deepEqual([...set.affectedIds].sort(), ['body', 'cap', 'grp'], 'run_action object.set names the carried parts too');
console.log('PASS the patch receipt is applied (no false droppedPaths) and reads back the carried parts');

// what landed is not dropped: a whole turn away (190 -> -170, 180 -> -180) or float dust; a clamp still is
{
  const f = objectsFixture(scene());
  try {
    const patchOne = set => f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [{ target: { kind: 'object', id: 'other' }, set }] }));
    const wrapped = patchOne({ rotation: { x: 190, y: 180, z: -0.1 + 0.3 } });
    assert.equal(wrapped.status, 'applied', JSON.stringify(wrapped));
    assert.deepEqual([at(f, 'other').rotX, at(f, 'other').rot], [-170, -180]);
    const clamped = patchOne({ position: { x: 1, y: -1, z: 1 }, rotation: { x: 0, y: 30, z: 0 } });
    assert.equal(clamped.status, 'partial', JSON.stringify(clamped));
    assert.deepEqual(clamped.ops, [{ index: 0, status: 'partial', droppedPaths: ['object.position'] }], 'a clamped floor height is still dropped');
    const scaled = patchOne({ scale: { x: 0.001, y: 1, z: 1 } });
    assert.deepEqual(scaled.ops, [{ index: 0, status: 'partial', droppedPaths: ['object.scale'] }], 'a clamped scale is still dropped');
  } finally { f.dispose(); }
  console.log('PASS droppedPaths: a rotation that landed one turn away or within float dust is kept; clamps are still dropped');
}

// a big group: the receipt reads back 8 rows and names a detail cursor; a clamp on the root is still a valid partial receipt
{
  const parts = Array.from({ length: 10 }, (_, i) => ({ ...createSceneObject('cube'), id: `part-${i}`, name: `Part ${i}`, parent: 'grp', x: -0.3 + i * 0.1, y: 0.9, z: 0.3 }));
  const f = objectsFixture([...scene(), ...parts]);
  try {
    const moved = f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [{ target: { kind: 'object', id: 'grp' }, set: { position: { x: 0, y: 1, z: 0 } } }] }));
    assert.equal(moved.status, 'applied', JSON.stringify(moved).slice(0, 400));
    assert.equal(moved.affectedIds.length, 13);
    assert.equal(moved.delta.length, 8);
    assert.equal(moved.delta[0].id, 'grp', 'the target reads back first');
    assert.ok(moved.detailCursor, 'more parts than the readback holds name a detail cursor');
    assert.ok(Math.abs(at(f, 'part-9').x - (0.6 + 0.3)) < 1e-9 && Math.abs(at(f, 'part-9').y - 1) < 1e-9, JSON.stringify(at(f, 'part-9')));
    const clamped = f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [{ target: { kind: 'object', id: 'grp' }, set: { position: { x: 0, y: -1, z: 0 } } }] }));
    assert.equal(clamped.status, 'partial', JSON.stringify(clamped).slice(0, 400));
    assert.deepEqual(clamped.ops, [{ index: 0, status: 'partial', droppedPaths: ['object.position'] }]);
    assert.ok(Math.abs(at(f, 'part-9').y - 0) < 1e-9, 'the parts go down with the root to where it landed (y 0)');
  } finally { f.dispose(); }
  console.log('PASS a group of 12 parts: 8 rows of readback with a detail cursor; a clamped root move is partial and carries its parts to where it landed');
}

{
  const f = objectsFixture(scene()), calls = [];
  try {
    const ids = ['first', 'second', 'third'];
    f.scope.characters = ids.map(id => ({ id }));
    f.scope.runStudioAction = (action, input) => { calls.push({ action, input }); };
    for (const id of ids) f.objects.reparentSceneObject('object:other', `${characterRowId(id)}.rig.rightHand`);
    assert.deepEqual(calls, ids.map(characterId => ({ action: 'object.attach', input: { objectId: 'other', characterId, bone: 'rightHand' } })), 'bone-row drops keep the named bone for every member');
    calls.length = 0;
    for (const id of ids) f.objects.reparentSceneObject('object:other', characterRowId(id));
    assert.deepEqual(calls, ids.map(characterId => ({ action: 'object.attach', input: { objectId: 'other', characterId } })), 'character-row drops still attach to the animated root');
  } finally { f.dispose(); }
  console.log('PASS hierarchy drops distinguish character roots from bones for all three members');
}
