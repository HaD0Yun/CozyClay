// Parallel Studio tasks, P1 (the command bus), through the real App: several tasks edit one scene at once, each inside
// its scope of keys. The plan's cases that live in the bus: 1 a busy key waits (SCOPE_BUSY), 2 a write outside the scope
// is refused (SCOPE_DENIED) and the scope can grow, 3 timeline and scene are exclusive, 5 the user's edit wins and the
// task hears of it once (STALE_TARGET), 6 Ctrl+Z stops at a running task's entry, 7 cancel restores only the task's own
// keys, 9 a task that reads a key hears when another task changes it; plus undo-task, a mark and its rollback, undo of
// the task's newest edit, created ids joining the task, and a single agent turn excluding tasks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { objectsFixture } from './objects-fixture.mjs';
import { motionFixture } from './motion-fixture.mjs';
import { castFixture, proxyCast } from './cast-fixture.mjs';
import { appFixture } from './app-fixture.mjs';
import { commandKeys, scopeConflict, isScopeKey } from '../../src/bus-task-scopes.js';
import { createBusTasks } from '../../src/bus-tasks.js';
import { skeletonFor } from '../../src/motion3/rigs/index.js';

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const refused = (receipt, code) => { assert.equal(receipt.ok, false, JSON.stringify(receipt)); assert.equal(receipt.code, code, receipt.message); return receipt; };
function setup() {
  const f = objectsFixture(), id = kind => f.store.current.objects.find(o => o.renderer === kind || o.id === kind).id;
  const ids = { cube: id('cube'), sphere: id('sphere'), cylinder: id('cylinder') };
  // A task's command carries no fresh scene revision: another task's edits move it all the time.
  const task = taskId => (action, args = {}) => f.run(action, args, 'agent', { taskId, expectedRevision: 0 });
  const begin = (taskId, scope, extra = {}) => task(taskId)('task.begin', { taskId, scope, ...extra });
  const x = objectId => f.store.current.objects.find(o => o.id === objectId)?.x;
  const move = (run, objectId, value) => run('object.set', { id: objectId, set: { position: { x: value, y: 0, z: 0 } } });
  return { f, ids, task, begin, x, move };
}

test('two tasks edit disjoint objects at once; a busy key waits; outside the scope is refused until granted', () => {
  const { f, ids, task, begin, x, move } = setup();
  try {
    const a = task('task-a'), b = task('task-b');
    ok(begin('task-a', [`object:${ids.cube}`], { title: 'cube' }));
    ok(begin('task-b', [`object:${ids.sphere}`]));
    ok(move(a, ids.cube, 1)); ok(move(b, ids.sphere, 2)); ok(move(a, ids.cube, 3));
    assert.equal(x(ids.cube), 3); assert.equal(x(ids.sphere), 2);
    refused(begin('task-c', [`object:${ids.cube}`]), 'SCOPE_BUSY');
    refused(move(a, ids.sphere, 9), 'SCOPE_DENIED');
    refused(a('task.requestScope', { taskId: 'task-a', scope: [`object:${ids.sphere}`] }), 'SCOPE_BUSY');
    ok(a('task.requestScope', { taskId: 'task-a', scope: [`object:${ids.cylinder}`] }));
    ok(move(a, ids.cylinder, 4));
    refused(move((action, args) => f.run(action, args, 'agent'), ids.cube, 5), 'SCOPE_BUSY');
    ok(a('task.finish', { taskId: 'task-a' })); ok(b('task.finish', { taskId: 'task-b' }));
  } finally { f.dispose(); }
});

test('timeline and scene are exclusive; a task and an agent turn never run together', () => {
  const { f, ids, task, begin } = setup();
  try {
    ok(begin('task-a', [`object:${ids.cube}`]));
    refused(begin('task-t', ['timeline']), 'SCOPE_BUSY');
    refused(f.run('agent.turn.begin', { turnId: 'turn-1' }, 'agent', { turnId: 'turn-1' }), 'TARGET_BUSY');
    ok(task('task-a')('task.finish', { taskId: 'task-a' }));
    ok(begin('task-t', ['timeline']));
    refused(begin('task-b', [`object:${ids.sphere}`]), 'SCOPE_BUSY');
    ok(task('task-t')('task.cancel', { taskId: 'task-t' }));
    ok(f.run('agent.turn.begin', { turnId: 'turn-1' }, 'agent', { turnId: 'turn-1' }));
    refused(begin('task-b', [`object:${ids.sphere}`]), 'TARGET_BUSY');
    ok(f.run('agent.turn.finish', { turnId: 'turn-1' }, 'agent', { turnId: 'turn-1' }));
  } finally { f.dispose(); }
});

test("the user's edit wins and the task hears it once; Ctrl+Z stops at a running task's entry", () => {
  const { f, ids, task, begin, x, move } = setup();
  try {
    const a = task('task-a');
    ok(begin('task-a', [`object:${ids.cube}`]));
    ok(move(a, ids.cube, 1));
    refused(f.run('edit.undo', {}), 'TARGET_BUSY');
    ok(move((action, args) => f.run(action, args, 'ui'), ids.cube, 7));
    assert.equal(x(ids.cube), 7, 'the UI is never refused');
    const stale = refused(move(a, ids.cube, 2), 'STALE_TARGET');
    assert.match(stale.message, /changed outside this task/);
    ok(move(a, ids.cube, 2));
    ok(a('task.finish', { taskId: 'task-a' }));
    ok(f.run('edit.undo', {}));
  } finally { f.dispose(); }
});

test("cancel restores only the task's keys and removes what it created; undo-task after finish; conflicts named", () => {
  const { f, ids, task, begin, x, move } = setup();
  try {
    const a = task('task-a'), b = task('task-b'), x0 = x(ids.cube), count = f.store.current.objects.length;
    ok(begin('task-a', [`object:${ids.cube}`])); ok(begin('task-b', [`object:${ids.sphere}`]));
    ok(move(a, ids.cube, 1));
    const made = ok(a('object.duplicate', { objectId: ids.cube }));
    assert.equal(f.store.current.objects.length, count + 1);
    const madeId = made.affectedIds.find(id => ![ids.cube, ids.sphere, ids.cylinder].includes(id));
    ok(move(a, madeId, 6));
    ok(move(b, ids.sphere, 2));
    const cancelled = ok(a('task.cancel', { taskId: 'task-a' }));
    assert.equal(x(ids.cube), x0, 'the cube is back');
    assert.equal(f.store.current.objects.length, count, 'the duplicate is gone');
    assert.equal(x(ids.sphere), 2, "the other task's edit stays");
    assert.ok(cancelled.authored);
    ok(b('task.finish', { taskId: 'task-b' }));
    ok(move((action, args) => f.run(action, args, 'ui'), ids.sphere, 8));
    refused(f.run('task.undo', { taskId: 'task-b' }), 'UNDO_CONFLICT');
    ok(begin('task-c', [`object:${ids.cylinder}`]));
    ok(move(task('task-c'), ids.cylinder, 3));
    ok(task('task-c')('task.finish', { taskId: 'task-c' }));
    const undone = ok(f.run('task.undo', { taskId: 'task-c' }));
    assert.notEqual(x(ids.cylinder), 3); assert.ok(undone.authored);
    refused(f.run('task.undo', { taskId: 'task-c' }), 'UNDO_EXPIRED');
  } finally { f.dispose(); }
});

test("a mark and its rollback; undo_edit of the task's newest edit; a reader hears of a change", () => {
  const { f, ids, task, begin, x, move } = setup();
  try {
    const a = task('task-a'), b = task('task-b');
    ok(begin('task-a', [`object:${ids.cube}`, `object:${ids.cylinder}`]));
    ok(begin('task-b', [`object:${ids.sphere}`], { reads: [`object:${ids.cube}`] }));
    ok(move(a, ids.cube, 1));
    ok(a('task.mark', { taskId: 'task-a' }));
    ok(move(a, ids.cube, 2)); ok(move(a, ids.cylinder, 5));
    ok(a('task.rollback', { taskId: 'task-a' }));
    assert.equal(x(ids.cube), 1, 'back to the mark'); assert.notEqual(x(ids.cylinder), 5);
    const newest = ok(move(a, ids.cube, 4)), older = ok(move(a, ids.cylinder, 6));
    refused(a('edit.undo', { receiptId: newest.receiptId }), 'UNDO_CONFLICT');
    ok(a('edit.undo', { receiptId: older.receiptId }));
    ok(a('edit.undo', { receiptId: newest.receiptId }));
    assert.equal(x(ids.cube), 1);
    const heard = ok(move(b, ids.sphere, 2));
    assert.ok(heard.warnings.some(w => w.code === 'DEPENDENCY_CHANGED'), JSON.stringify(heard.warnings));
    ok(a('task.finish', { taskId: 'task-a' })); ok(b('task.finish', { taskId: 'task-b' }));
  } finally { f.dispose(); }
});

for (const { name, reads, notified } of [
  { name: 'whole character', reads: ['character:actor-a'], notified: true },
  { name: 'same layer', reads: ['character:actor-a:placement'], notified: true },
  { name: 'whole character and its layer', reads: ['character:actor-a', 'character:actor-a:placement'], notified: true },
  { name: 'different layer', reads: ['character:actor-a:take'], notified: false },
  { name: 'different character', reads: ['character:actor-b'], notified: false },
]) test(`dependency notice for ${name}`, () => {
  const f = castFixture(appFixture({ characters: proxyCast() }));
  const events = [];
  const stop = f.binding.bus.subscribe(event => { if (event?.type === 'task.dependencyChanged') events.push(event); });
  const task = taskId => (action, args = {}) => f.run(action, args, 'agent', { taskId, expectedRevision: 0 });
  try {
    const writer = task('writer'), reader = task('reader');
    ok(writer('task.begin', { taskId: 'writer', scope: ['character:actor-a:placement'] }));
    ok(reader('task.begin', { taskId: 'reader', scope: ['character:actor-b:placement'], reads }));
    const observedX = f.cast.read().find(row => row.id === 'actor-a').x;
    ok(writer('character.move', { characterId: 'actor-a', x: 3, z: 0, rot: 0 }));
    const receipt = ok(reader('character.move', { characterId: 'actor-b', x: observedX + 1.5, z: 0, rot: 0 }));
    const warnings = receipt.warnings.filter(warning => warning.code === 'DEPENDENCY_CHANGED');
    assert.equal(warnings.length, notified ? 1 : 0, JSON.stringify(receipt.warnings));
    assert.deepEqual(events, notified ? [{ type: 'task.dependencyChanged', taskId: 'reader', key: 'character:actor-a:placement', by: 'writer' }] : []);
    if (notified) assert.match(warnings[0].message, /character:actor-a:placement/);
    const next = ok(reader('character.move', { characterId: 'actor-b', x: 4.5, z: 0, rot: 0 }));
    assert.equal(next.warnings.filter(warning => warning.code === 'DEPENDENCY_CHANGED').length, 0, 'the notice is delivered once');
    ok(writer('task.finish', { taskId: 'writer' }));
    ok(reader('task.finish', { taskId: 'reader' }));
  } finally { stop(); f.dispose(); }
});

test('what a command writes, known before it runs', () => {
  const state = { objects: [{ id: 'g' }, { id: 'p', parent: 'g' }], selectedShotId: 's1' };
  assert.deepEqual(commandKeys('object.set', { id: 'g' }, state), ['object:g', 'object:p'], 'a group carries its subtree');
  assert.deepEqual(commandKeys('object.add', {}, state), [], 'a creation needs no key');
  assert.deepEqual(commandKeys('motion.compile', { characterId: 'a' }, state, { kind: 'job' }), ['character:a:take', 'character:a:ik']);
  assert.deepEqual(commandKeys('motion.qa', { characterId: 'a' }, state, { kind: 'job', readOnly: true }), [], 'a read needs no key');
  assert.deepEqual(commandKeys('shot.placeCamera', {}, state), ['shot:s1']);
  assert.deepEqual(commandKeys('shot.setRange', { shotId: 's1' }, state), ['timeline']);
  assert.deepEqual(commandKeys('stage.applyLighting', {}, state), ['stage']);
  assert.deepEqual(commandKeys('scene.switch', { sceneId: 'b' }, state, { kind: 'document' }), ['scene']);
  assert.deepEqual(commandKeys('objects.arrange', { ops: [{ op: 'create' }, { op: 'update', id: 'p' }] }, state), ['object:p']);
  assert.deepEqual(commandKeys('some.newCommand', {}, state, { kind: 'mutation' }), ['scene'], 'an unknown command writes scene');
});

test('the panel hears a task\'s scope grow and the user editing inside it (task.scope, task.userEdit)', () => {
  const { f, ids, task, begin, move } = setup();
  const heard = [];
  const stop = f.binding.bus.subscribe(event => { if (/^task\./.test(event?.type)) heard.push(event); });
  try {
    const a = task('task-a');
    ok(begin('task-a', [`object:${ids.cube}`], { title: 'cube' }));
    ok(a('task.requestScope', { taskId: 'task-a', scope: [`object:${ids.cylinder}`] }));
    ok(move((action, args) => f.run(action, args, 'ui'), ids.cube, 7));
    ok(move((action, args) => f.run(action, args, 'ui'), ids.sphere, 8));
    ok(a('task.finish', { taskId: 'task-a' }));
    assert.deepEqual(heard.map(event => event.type), ['task.begun', 'task.scope', 'task.userEdit', 'task.finished']);
    assert.deepEqual(heard[1].scope, [`object:${ids.cube}`, `object:${ids.cylinder}`]);
    assert.deepEqual(heard[2], { type: 'task.userEdit', taskId: 'task-a', keys: [`object:${ids.cube}`] }, 'only the edit inside the scope is told');
  } finally { stop(); f.dispose(); }
});

test('undo task, newest first: once the later task is undone, the earlier one undoes though its key has a new token', () => {
  const { f, ids, task, begin, x, move } = setup();
  try {
    const ui = (action, args) => f.run(action, args, 'ui');
    const before = x(ids.cube);
    ok(begin('task-a', [`object:${ids.cube}`])); ok(move(task('task-a'), ids.cube, 1)); ok(task('task-a')('task.finish', { taskId: 'task-a' }));
    ok(begin('task-b', [`object:${ids.cube}`])); ok(move(task('task-b'), ids.cube, 2)); ok(task('task-b')('task.finish', { taskId: 'task-b' }));
    refused(ui('task.undo', { taskId: 'task-a' }), 'UNDO_CONFLICT');
    ok(ui('task.undo', { taskId: 'task-b' }));
    assert.equal(x(ids.cube), 1);
    ok(ui('task.undo', { taskId: 'task-a' }));
    assert.equal(x(ids.cube), before);
  } finally { f.dispose(); }
});

test('a character is four layers: each command names the ones it writes', () => {
  const state = { objects: [{ id: 'cup' }] }, keys = (id, args) => commandKeys(id, args, state);
  const of = (id, ...names) => names.map(name => `character:${id}:${name}`);
  assert.deepEqual(keys('character.move', { characterId: 'a', x: 1, z: 0, rot: 0 }), of('a', 'placement'));
  assert.deepEqual(keys('character.update', { characterId: 'a', patch: { tint: '#ff0000', hidden: true } }), of('a', 'placement'));
  assert.deepEqual(keys('character.update', { characterId: 'a', patch: { ikEdits: null } }), of('a', 'ik'));
  assert.deepEqual(keys('character.update', { characterId: 'a', patch: { model: 'x-bot-tpose' } }), of('a', 'placement', 'take', 'ik', 'props'), 'a model swap is a new body');
  assert.deepEqual(keys('character.set', { ops: [{ id: 'a', set: { position: { x: 1 } } }, { id: 'b', set: { rot: 3 } }] }), [...of('a', 'placement'), ...of('b', 'placement')]);
  assert.deepEqual(keys('characters.arrange', { ops: [{ op: 'create' }, { op: 'update', characterId: 'b' }] }), of('b', 'placement'));
  assert.deepEqual(keys('character.remove', { characterId: 'a' }), of('a', 'placement', 'take', 'ik', 'props'));
  assert.deepEqual(keys('character.setPose', { characterId: 'a', pose: 'sit' }), of('a', 'placement'));
  assert.deepEqual(keys('character.setPose', { characterId: 'a', pose: 'sit', clearMotion: true }), of('a', 'placement', 'take', 'ik'));
  assert.deepEqual(keys('character.addWaypoint', { characterId: 'a', position: { x: 0, z: 0 } }), of('a', 'take'));
  assert.deepEqual(keys('motion.set', { id: 'a', set: { take: { prompt: 'x' } } }), of('a', 'take'));
  assert.deepEqual(keys('motion.trim', { characterId: 'a', start: 0, end: 9 }), of('a', 'take', 'ik'), 'a timing edit moves the IK keys too');
  assert.deepEqual(keys('motion.clear', { characterId: 'a' }), of('a', 'take', 'ik'));
  assert.deepEqual(keys('ik.setKey', { characterId: 'a', frame: 0, tracks: {} }), of('a', 'ik'));
  assert.deepEqual(keys('motion.rangePin.apply', { characterId: 'a', pin: {} }), of('a', 'ik'));
  assert.deepEqual(keys('object.attach', { characterId: 'a', objectId: 'cup' }), [...of('a', 'props'), 'object:cup']);
  assert.deepEqual(keys('motion.keyObject', { characterId: 'a', objectId: 'cup', frame: 3 }), [...of('a', 'take', 'ik', 'props'), 'object:cup']);
  assert.deepEqual(keys('motion.someNewEdit', { characterId: 'a' }), of('a', 'placement', 'take', 'ik', 'props'), 'an unnamed character command writes all four');
});

test('a plain character:<id> is all four layers; layers of one character are separate keys', () => {
  const tasks = held => new Map(Object.entries(held).map(([taskId, keys]) => [taskId, { taskId, keys: new Set(keys) }]));
  for (const key of ['character:a', 'character:a:placement', 'character:a:take', 'character:a:ik', 'character:a:props']) assert.ok(isScopeKey(key), key);
  assert.match(scopeConflict('t2', ['character:a'], tasks({ t1: ['character:a:take'] })), /character:a is held by task t1/);
  assert.match(scopeConflict('t2', ['character:a:ik'], tasks({ t1: ['character:a'] })), /character:a:ik is held by task t1/);
  assert.equal(scopeConflict('t2', ['character:a:placement'], tasks({ t1: ['character:a:take', 'character:a:ik'] })), null);
  assert.equal(scopeConflict('t2', ['character:a'], tasks({ t1: ['character:b'] })), null);
  assert.equal(scopeConflict('t2', ['character:ab'], tasks({ t1: ['character:a:take'] })), null, 'another id that starts the same is another character');
});

test("a task's job fences on its own layers, not on another task's layer of the same character", () => {
  const tokens = { 'character:a:placement': 'p0', 'character:a:take': 't0', 'character:a:ik': 'i0' };
  const host = { workspaceId: 'workspace', documentEpoch: 'document', sceneId: 'scene', sceneEpoch: 'epoch' };
  const ports = { read: () => ({ revision: 1, host }), readLayer: key => tokens[key], snapshotTarget: () => [] };
  const tasks = createBusTasks({ ports });
  const request = taskId => ({ origin: 'agent', taskId, commandId: crypto.randomUUID() });
  for (const [taskId, scope] of [['tp', ['character:a:placement']], ['tt', ['character:a:take', 'character:a:ik']]]) tasks.control('task.begin', { taskId, scope }, request(taskId), ports.read(), null);
  const point = tasks.admit(tasks.of(request('tt'), 'motion.compile'), { id: 'motion.compile', kind: 'job' }, { characterId: 'a' }, request('tt'), ports.read());
  tokens['character:a:placement'] = 'p1';
  assert.deepEqual(tasks.moved(point), [], 'placing her does not stop the compile');
  tokens['character:a:ik'] = 'i1';
  assert.deepEqual(tasks.moved(point), ['character:a:ik']);
  tasks.rebase(point);
  assert.deepEqual(tasks.moved(point), []);
});

// A short standing take for the fixture's Y Bot (motion-fixture seedMotion's spec).
function standSpec(model, frames = 24) {
  const sk = skeletonFor(model), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1];
  return { schema: 'cozyclay.motion-spec.v1', fps: 24, frames,
    keys: [{ f: 0, set: { root: [0, P[I.Hips][1] - 0.01, 0], yaw: 0, foot_l: [0.09, ank, -0.03], foot_r: [-0.09, ank, 0.03], head_yaw: 0 } }, { f: frames - 1, set: { head_yaw: 30 } }] };
}

test("two tasks place one character and make her take at once; each layer is its own; cancel keeps the other's", () => {
  const f = motionFixture();
  try {
    const task = taskId => (action, args = {}) => f.run(action, args, 'agent', { taskId, expectedRevision: 0 });
    const p = task('task-p'), t = task('task-t'), x = () => f.cast.read().find(row => row.id === 'actor-a').x;
    const x0 = x(), model = f.cast.read().find(row => row.id === 'actor-a').model;
    ok(p('task.begin', { taskId: 'task-p', scope: ['character:actor-a:placement'], title: 'place her' }));
    ok(t('task.begin', { taskId: 'task-t', scope: ['character:actor-a:take', 'character:actor-a:ik'], title: 'her take' }));
    refused(task('task-x')('task.begin', { taskId: 'task-x', scope: ['character:actor-a'] }), 'SCOPE_BUSY');
    ok(p('character.move', { characterId: 'actor-a', x: 1.5, z: 0, rot: 0 }));
    ok(t('motion.compile', { characterId: 'actor-a', spec: standSpec(model) }));
    assert.equal(f.motion.motionFor('actor-a')?.schema, 'cozyclay.take.v3', 'the take is installed');
    ok(p('character.move', { characterId: 'actor-a', x: 2, z: 0, rot: 0 }));
    assert.equal(x(), 2, "the take task's install did not make the placement stale");
    refused(p('motion.clear', { characterId: 'actor-a' }), 'SCOPE_DENIED');
    refused(t('character.move', { characterId: 'actor-a', x: 3, z: 0, rot: 0 }), 'SCOPE_DENIED');
    refused(p('character.update', { characterId: 'actor-a', patch: { model: 'x-bot-tpose' } }), 'SCOPE_DENIED');
    ok(p('task.cancel', { taskId: 'task-p' }));
    assert.equal(x(), x0, 'her placement is back');
    assert.equal(f.motion.motionFor('actor-a')?.schema, 'cozyclay.take.v3', "the other task's take stays");
    ok(t('task.finish', { taskId: 'task-t' }));
    ok(task('task-x')('task.begin', { taskId: 'task-x', scope: ['character:actor-a'] }));
    ok(task('task-x')('character.move', { characterId: 'actor-a', x: 1, z: 0, rot: 0 }));
    ok(task('task-x')('motion.clear', { characterId: 'actor-a' }));
    ok(task('task-x')('task.cancel', { taskId: 'task-x' }));
    assert.equal(x(), x0); assert.equal(f.motion.motionFor('actor-a')?.schema, 'cozyclay.take.v3', 'a plain key restores all four');
  } finally { f.dispose(); }
});

// Box bench (box-old-r2, box-kf-r1): a motion.compile past the hub's 120 s answered UNCERTAIN_APPLY, the sidecar read it
// as a lost Studio and paused the task, then resumed it with the same task.begin while this editor still held it open.
test('its owner begins an open task again after a cut-off run: it resumes, keeps its pre-images, and a finished one is still refused', () => {
  const { f, ids, task, begin, x, move } = setup();
  try {
    const a = task('task-a'), x0 = x(ids.cube);
    ok(begin('task-a', [`object:${ids.cube}`], { title: 'cube' }));
    ok(a('task.mark', { taskId: 'task-a' }));
    ok(move(a, ids.cube, 1));
    const again = ok(begin('task-a', [`object:${ids.cube}`, `object:${ids.sphere}`], { title: 'cube' }));
    assert.equal(again.output.resumed, true);
    assert.deepEqual([...again.output.scope].sort(), [`object:${ids.cube}`, `object:${ids.sphere}`].sort());
    refused(task('task-b')('task.begin', { taskId: 'task-a', scope: [`object:${ids.cube}`] }), 'CAPABILITY_MISSING');
    refused(begin('task-b', [`object:${ids.cube}`]), 'SCOPE_BUSY');
    refused(a('task.rollback', { taskId: 'task-a' }), 'STALE_TARGET');
    ok(move(a, ids.cube, 2)); assert.equal(x(ids.cube), 2);
    ok(a('task.cancel', { taskId: 'task-a' }));
    assert.equal(x(ids.cube), x0, 'cancel after the resume restores the pre-image from before the first run');
    ok(begin('task-c', [`object:${ids.cube}`]));
    ok(task('task-c')('task.finish', { taskId: 'task-c' }));
    refused(begin('task-c', [`object:${ids.cube}`]), 'INVALID_ARGUMENT');
  } finally { f.dispose(); }
});

test('a holder its board no longer runs is released after 30 s idle; a live or recent one still answers SCOPE_BUSY', () => {
  const { f, ids, begin } = setup();
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    ok(begin('task-a', [`object:${ids.cube}`]));
    refused(begin('task-b', [`object:${ids.cube}`], { live: [] }), 'SCOPE_BUSY');
    t += 31_000;
    refused(begin('task-c', [`object:${ids.cube}`], { live: ['task-a'] }), 'SCOPE_BUSY');
    refused(begin('task-d', [`object:${ids.cube}`]), 'SCOPE_BUSY');
    ok(begin('task-e', [`object:${ids.cube}`], { live: [] }));
  } finally { Date.now = realNow; f.dispose(); }
});
