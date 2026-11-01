// The task board of task mode (parallel Studio tasks, P3; src/workflow/task-board.js) and the compile worker pool
// (case 10; src/commands/motion3-compile.js). The board: server events (task.queued .. task.done, sceneChanged),
// editor events (task.userEdit, task.undone) and a board read fold into one card per task; the open scopes follow the
// bus (task.begun / task.scope / task.finished). The pool: at most two compiles run at once, the rest wait in order
// and show which task waits; every answer equals the calling thread's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerOf, runCompileJob } from '../src/motion3/compile-job.js';
import { compileActivity, createCompileRunner, watchCompileActivity } from '../src/commands/motion3-compile.js';
import { motionScene } from '../src/motion3/scene.js';
import { TASK_STATUS_COPY, boardGroups, compileState, costLabel, dispatchedTaskIds, emptyBoard, progressLine, readStoredTaskMode, reduceBoard, reduceScopes, scopeLabel, seedBoard, taskLine, taskReason } from '../src/workflow/task-board.js';

test('task mode is on by default; only an explicit off turns it off', () => {
	const store = (value) => ({ getItem: () => value });
	assert.equal(readStoredTaskMode(store(null)), true);
	assert.equal(readStoredTaskMode(store('off')), false);
	assert.equal(readStoredTaskMode(store('on')), true);
	assert.equal(readStoredTaskMode({ getItem: () => { throw new Error('blocked'); } }), true);
	assert.equal(readStoredTaskMode(null), true);
});

const view = (taskId, status, extra = {}) => ({ taskId, title: `Task ${taskId}`, status, scope: [`object:${taskId}`], usage: { cost: 0 }, ...extra });

test('a task row reads in the author\'s words: the blocking task by title, never its id', () => {
	const waiting = taskReason('timeline is held by task 84867242-9a6f-4d2a-9495-85c6508f986f (Cube left (2 m))');
	assert.ok(waiting.includes('Cube left (2 m)') && !waiting.includes('84867242'), waiting);
	assert.ok(taskReason('waits for task t-1 (Frame the shot) to finish').includes('Frame the shot'));
	assert.equal(taskReason('the run failed'), 'the run failed');
	assert.equal(taskLine(view('a', 'running', { progress: 'Compile motion' })), 'Compile motion');
	assert.equal(taskLine(view('a', 'done', { summary: { reply: 'Moved the cup. QA: none.' } })), 'Moved the cup.');
	assert.equal(scopeLabel('object:cube-1') === 'object:cube-1', false);
	const groups = boardGroups(['a', 'b', 'c', 'd'].reduce((board, id, i) => reduceBoard(board, { type: 'task.seed', ...view(id, ['running', 'waiting', 'failed', 'done'][i]) }), emptyBoard()));
	assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, list.map(task => task.taskId)])), { failed: ['c'], running: ['a'], waiting: ['b'], done: ['d'] });
	const reviewed = reduceBoard(emptyBoard(), { type: 'task.review', ...view('r', 'review', { verify: true, summary: { reply: 'Cup made.' } }) });
	assert.deepEqual(boardGroups(reviewed).waiting.map(task => task.taskId), ['r'], 'a task in review waits for the coordinator');
	assert.equal(taskLine(reviewed.tasks.r), TASK_STATUS_COPY.review); assert.ok(TASK_STATUS_COPY.review.length <= 16);
	assert.deepEqual(dispatchedTaskIds([{ kind: 'tool', name: 'dispatch_task', result: { taskId: 't1' } }, { kind: 'tool', name: 'quick_edit', result: { taskId: 'x' } }, { kind: 'tool', name: 'dispatch_task', result: { duplicateOf: 't1' } }, { kind: 'tool', name: 'dispatch_task' }]), ['t1', 't1']);
	assert.deepEqual(dispatchedTaskIds([{ kind: 'tool', name: 'dispatch_plan', result: { tasks: [{ ref: 'a', taskId: 'p1' }, { ref: 'b', duplicateOf: 't1', taskId: 't1' }] } }, { kind: 'tool', name: 'dispatch_plan' }]), ['p1', 't1'], 'a plan places every task it queued under its turn');
});

test('board events make one card per task, in arrival order, with the latest state', () => {
	let board = emptyBoard();
	board = reduceBoard(board, { type: 'task.queued', eventSeq: 1, ...view('a', 'queued') });
	board = reduceBoard(board, { type: 'task.queued', eventSeq: 2, ...view('b', 'queued') });
	board = reduceBoard(board, { type: 'task.waiting', eventSeq: 3, ...view('b', 'waiting', { reason: 'object:a is held by task a' }) });
	board = reduceBoard(board, { type: 'task.started', eventSeq: 4, ...view('a', 'running', { turnId: 't-a' }) });
	board = reduceBoard(board, { type: 'task.progress', taskId: 'a', status: 'running', progress: 'Compile motion' });
	assert.deepEqual(board.order, ['a', 'b']);
	assert.equal(board.after, 4);
	assert.equal(board.tasks.a.status, 'running');
	assert.equal(board.tasks.a.progress, 'Compile motion');
	assert.equal(board.tasks.b.reason, 'object:a is held by task a');
	board = reduceBoard(board, { type: 'task.done', eventSeq: 5, ...view('a', 'done', { usage: { cost: 0.123 }, summary: { reply: 'Moved the cup.', receipts: [] } }) });
	assert.equal(board.tasks.a.summary.reply, 'Moved the cup.');
	assert.equal(costLabel(board.tasks.a.usage), '$0.12');
	assert.equal(costLabel({ cost: 0 }), '');
	// a progress line for a task the board never heard of is dropped (no title, no card)
	assert.equal(reduceBoard(board, { type: 'task.progress', taskId: 'zz', status: 'running', progress: 'x' }).tasks.zz, undefined);
});

test('scene changes, user edits and undo land on the card; a board read fills only what events did not', () => {
	let board = reduceBoard(emptyBoard(), { type: 'task.started', eventSeq: 1, ...view('a', 'running') });
	board = reduceBoard(board, { type: 'task.userEdit', taskId: 'a', keys: ['object:a'] });
	board = reduceBoard(board, { type: 'task.sceneChanged', eventSeq: 2, taskId: 'a', keys: ['object:a'], midCommand: false });
	assert.equal(board.tasks.a.notes.length, 2);
	assert.match(board.tasks.a.notes[0], /object:a/);
	board = reduceBoard(board, { type: 'task.undone', taskId: 'a' });
	assert.equal(board.tasks.a.undone, true);
	const seeded = seedBoard(board, [view('a', 'queued'), view('c', 'paused', { reason: 'Studio disconnected' })]);
	assert.equal(seeded.tasks.a.status, 'running', 'an event already told the card more than the read');
	assert.equal(seeded.tasks.c.status, 'paused');
	assert.deepEqual(seeded.order, ['a', 'c']);
});

test('open scopes follow the bus; a progress line names the tool or the error', () => {
	let scopes = reduceScopes({}, { type: 'task.begun', taskId: 'a', scope: ['object:a'] });
	scopes = reduceScopes(scopes, { type: 'task.scope', taskId: 'a', scope: ['object:a', 'character:c'] });
	scopes = reduceScopes(scopes, { type: 'task.begun', taskId: 'b', scope: ['shot:s'] });
	assert.deepEqual(scopes, { a: ['object:a', 'character:c'], b: ['shot:s'] });
	assert.deepEqual(reduceScopes(scopes, { type: 'task.finished', taskId: 'a' }), { b: ['shot:s'] });
	assert.deepEqual(reduceScopes(scopes, { type: 'task.cancelled', taskId: 'b' }), { a: ['object:a', 'character:c'] });
	assert.equal(progressLine({ type: 'tool.start', name: 'run_action' }, call => `label ${call.name}`), 'label run_action');
	assert.match(progressLine({ type: 'error', code: 'SCOPE_BUSY', message: 'held' }), /held/);
	assert.equal(progressLine({ type: 'text.delta', text: 'x' }), null);
	assert.match(progressLine({ type: 'studio.waiting', reason: 'gesture', waiting: true }), /Waiting: the user is editing|사용자가 편집 중/);
	assert.doesNotMatch(progressLine({ type: 'studio.waiting', reason: 'gesture', waiting: false }), /Error|오류|TARGET_BUSY/);
});

/** A Worker the test drives: it answers only when told, so the pool's concurrency can be read. */
class HeldWorker {
	static made = [];
	constructor() { this.held = []; HeldWorker.made.push(this); }
	postMessage(message) { this.held.push(structuredClone(message)); }
	answer() { const sent = this.held.shift(); const { message, transfer } = answerOf(sent); this.onmessage?.({ data: structuredClone(message, { transfer }) }); }
	terminate() { this.terminated = true; }
}
const job = frames => ({ model: 'y-bot-tpose', scene: motionScene([]), spec: { schema: 'cozyclay.motion-spec.v1', fps: 24, frames, use: [{ skill: 'standIdle', f0: 0, args: { at: [0, 0], heading: 0 } }] } });
const bytes = answer => JSON.stringify(answer, (key, value) => (key === 'ms' ? undefined : ArrayBuffer.isView(value) ? Array.from(value) : value));

test('the compile pool runs at most two at once, queues the rest in order, and answers as the calling thread does', async () => {
	HeldWorker.made = [];
	const runner = createCompileRunner({ spawn: () => new HeldWorker(), size: 2 });
	const seen = [];
	const stop = watchCompileActivity(activity => seen.push(activity));
	const jobs = [job(12), job(14), job(16)];
	const answers = jobs.map((one, index) => runner.run(one, { taskId: `t${index}`, characterId: 'a' }));
	assert.ok(answers.every(answer => typeof answer?.then === 'function'));
	assert.equal(HeldWorker.made.length, 2, 'two workers, not three');
	assert.equal(HeldWorker.made.reduce((n, w) => n + w.held.length, 0), 2, 'two compiles running');
	assert.deepEqual(compileActivity().waiting, [{ taskId: 't2', characterId: 'a' }], 'the third waits, and says whose it is');
	assert.deepEqual(compileState(compileActivity(), 't2'), { waiting: 1, running: 0 });
	assert.deepEqual(compileState(compileActivity(), 't0'), { waiting: 0, running: 1 });
	HeldWorker.made[0].answer();
	await answers[0];
	assert.equal(HeldWorker.made[0].held.length, 1, 'the freed worker takes the waiting compile');
	assert.equal(compileActivity().waiting.length, 0);
	HeldWorker.made[1].answer();
	HeldWorker.made[0].answer();
	const results = await Promise.all(answers);
	for (const [index, result] of results.entries()) assert.equal(bytes(result), bytes(runCompileJob(jobs[index])), `job ${index} answers as the calling thread does`);
	assert.ok(seen.every(activity => activity.running.length <= 2), 'never more than two at once');
	stop();
});

test('without a Worker the pool answers at once on the calling thread; a crash hands every job to it', async () => {
	const plain = createCompileRunner({ spawn: () => null });
	const answer = plain.run(job(10));
	assert.equal(typeof answer?.then, 'undefined');
	assert.equal(bytes(answer), bytes(runCompileJob(job(10))));
	HeldWorker.made = [];
	const runner = createCompileRunner({ spawn: () => new HeldWorker(), size: 2 });
	const pending = [runner.run(job(10)), runner.run(job(12)), runner.run(job(14))];
	HeldWorker.made[0].onerror?.({ message: 'boom' });
	const results = await Promise.all(pending);
	assert.equal(results.length, 3);
	assert.equal(bytes(results[2]), bytes(runCompileJob(job(14))));
	assert.match(runner.takeWarning(), /compile worker stopped \(boom\)/);
	assert.ok(HeldWorker.made.every(worker => worker.terminated));
});
