// task.undo across scene switches (#1058, box QA C5): opening a scene reloads its shot and motion slices through the scene
// file, so their JSON comes back different with nothing edited. Undo of a finished task must still work after the user
// leaves its scene and comes back, keep refusing when something really changed, and never write into another scene.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBusTasks } from '../../src/bus-tasks.js';

function editor() {
  const scenes = { a: { shot: { shots: [{ id: 's1', start: 0 }] } }, b: { shot: { shots: [] } } };
  const state = { scene: 'a', revision: 1, shotRevision: 0 };
  const host = () => ({ workspaceId: 'w', documentEpoch: 'd', sceneId: state.scene, sceneEpoch: state.scene });
  const ports = {
    read: () => ({ revision: state.revision, host: host(), domainRevisions: { shot: state.shotRevision } }),
    readTarget: () => `${state.scene}:${state.shotRevision}`,
    snapshotTarget: key => (key === 'shot:s1' ? [{ domain: 'shot', whole: scenes[state.scene].shot }] : []),
    restoreTargets(values) { for (const { value } of values) for (const part of value) scenes[state.scene].shot = part.whole; state.shotRevision++; return { historyEntryId: `h${state.shotRevision}` }; },
  };
  const tasks = createBusTasks({ ports });
  const request = taskId => ({ origin: 'agent', taskId, commandId: crypto.randomUUID() });
  const ui = { origin: 'ui', commandId: 'u' };
  const run = (id, args, req = ui) => { try { return tasks.control(id, args, req, ports.read(), null); } catch (error) { return { ok: false, code: error.code, message: error.message }; } };
  // the task moves shot s1: admit keeps its pre-image, the edit lands, record files it
  const editShot = (taskId, start) => {
    const point = tasks.admit(tasks.of(request(taskId), 'shot.set'), { id: 'shot.set', kind: 'mutation' }, { shotId: 's1' }, request(taskId), ports.read());
    scenes[state.scene].shot = { shots: [{ id: 's1', start }] }; state.shotRevision++; state.revision++;
    tasks.record(point, { ok: true, authored: true, receiptId: `r${state.revision}`, affectedIds: ['s1'], warnings: [] });
  };
  // a scene switch the way the bus runs a document action; reloading writes the same shots in another key order
  const open = scene => {
    tasks.leavingScene();
    state.scene = scene; state.revision++; state.shotRevision++;
    scenes[scene].shot = { shots: scenes[scene].shot.shots.map(({ id, start }) => ({ start, id })) };
    tasks.openedScene();
  };
  return { tasks, scenes, state, request, run, editShot, open };
}

test('a finished task undoes after its scene was left and opened again', () => {
  const e = editor();
  assert.equal(e.run('task.begin', { taskId: 't', scope: ['shot:s1'] }, e.request('t')).ok, true);
  e.editShot('t', 48);
  assert.equal(e.run('task.finish', { taskId: 't' }, e.request('t')).ok, true);
  e.open('b');
  const away = e.run('task.undo', { taskId: 't' });
  assert.deepEqual([away.ok, away.code], [false, 'UNDO_CONFLICT']);
  assert.match(away.message, /edited another scene \(a\); open that scene first/);
  assert.deepEqual(e.scenes.b.shot.shots, [], 'nothing was written into the other scene');
  e.open('a');
  const undone = e.run('task.undo', { taskId: 't' });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(e.scenes.a.shot.shots[0].start, 0, 'the shot is back where it stood before the task');
});

test('a change made before the scene was left still blocks the undo after coming back', () => {
  const e = editor();
  e.run('task.begin', { taskId: 't', scope: ['shot:s1'] }, e.request('t'));
  e.editShot('t', 48);
  e.run('task.finish', { taskId: 't' }, e.request('t'));
  e.scenes.a.shot = { shots: [{ id: 's1', start: 96 }] }; e.state.shotRevision++; // the user moves it by hand
  e.open('b'); e.open('a');
  const refused = e.run('task.undo', { taskId: 't' });
  assert.deepEqual([refused.ok, refused.code], [false, 'UNDO_CONFLICT']);
  assert.match(refused.message, /Changed since the task finished: shot:s1/);
  assert.equal(e.scenes.a.shot.shots[0].start, 96, "the user's edit stays");
});
