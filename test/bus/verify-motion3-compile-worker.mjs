// The motion compile worker (commands/motion3-compile.js, motion3/compile-worker.js): in the browser
// motion.compile, motion.qa and motion.keyObject run their compile in one module Web Worker, so the main
// thread never blocks on the compiler; where there is no Worker they answer synchronously as before.
// Through the real command bus on the baseball swing: a fake Worker that crosses a structured-clone
// boundary (typed arrays transferred) gives the same receipts (but timings), the same installed takes byte
// for byte and the same undo entries as the synchronous path; refusals come back as the same protocol
// errors; a worker that fails hands its jobs to the calling thread and says so once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motionFixture } from './motion-fixture.mjs';
import { SWING_SPEC, SWING_KEYS } from '../motion3/fixtures/bat-swing.mjs';
import { answerOf } from '../../src/motion3/compile-job.js';
import { createCompileRunner } from '../../src/commands/motion3-compile.js';
import { motionScene } from '../../src/motion3/scene.js';
import { StudioProtocolError } from '../../src/studio-agent-protocol.js';

/** A Worker as the browser gives it: messages cross a structured clone, answers arrive later, in order. */
class FakeWorker {
	static made = [];
	constructor(url, options) { this.url = String(url); this.options = options; this.jobs = []; FakeWorker.made.push(this); }
	postMessage(message) {
		const sent = structuredClone(message);
		this.jobs.push(sent.id);
		setTimeout(() => { const { message: answer, transfer } = answerOf(sent); this.onmessage?.({ data: structuredClone(answer, { transfer }) }); }, 0);
	}
	terminate() { this.terminated = true; }
}

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 600)); return receipt; };
const noMs = value => JSON.parse(JSON.stringify(value, (key, v) => (key === 'ms' ? undefined : v)));
const takeBytes = take => ({ rot: Array.from(take.rot), hips: Array.from(take.hips), objects: Object.fromEntries(Object.entries(take.objects ?? {}).map(([id, o]) => [id, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, ArrayBuffer.isView(v) ? Array.from(v) : v]))])), spec: take.spec, prompt: take.prompt });

/** The bat swing scene of verify-motion-keyobject.mjs and the spec on it. */
function swing(f) {
	const byName = name => f.store.current.objects.find(o => o.name === name);
	const add = (kind, name, set) => { ok(f.run('object.add', { kind, name, placement: { x: set.x, z: set.z } }, 'agent')); ok(f.run('object.update', { id: byName(name).id, patch: set }, 'agent')); return byName(name).id; };
	const bat = add('cylinder', 'Baseball Bat', { x: -0.4, y: 0, z: 0.3, scaleX: 0.06, scaleY: 0.84, scaleZ: 0.06 });
	const spec = structuredClone(SWING_SPEC);
	spec.objects = { [bat]: spec.objects.cylinder };
	spec.checks.allow = spec.checks.allow.map(a => ({ ...a, object: bat }));
	spec.goals = spec.goals.map(g => (g.moved ? { ...g, moved: `object:${bat}.center` } : g));
	return { bat, spec };
}

test('motion.compile / qa / keyObject through the worker answer as the calling thread does, a step later', async () => {
	const plain = motionFixture(), worked = motionFixture();
	try {
		// the plain fixture's runner looks for a Worker on its first compile and finds none: it stays synchronous
		const a = swing(plain), b = swing(worked);
		const syncCompile = plain.run('motion.compile', { characterId: 'actor-a', spec: a.spec }, 'agent');
		assert.equal(typeof syncCompile?.then, 'undefined', 'without a Worker the compile answers at once');
		globalThis.Worker = FakeWorker;
		const pending = worked.run('motion.compile', { characterId: 'actor-a', spec: b.spec }, 'agent');
		assert.equal(typeof pending?.then, 'function', 'with a Worker the compile answers later');
		const asyncCompile = ok(await pending);
		ok(syncCompile);
		assert.equal(FakeWorker.made.length, 1, 'one worker');
		assert.deepEqual(FakeWorker.made[0].options, { type: 'module', name: 'motion-compile' });
		assert.match(FakeWorker.made[0].url, /motion3\/compile-worker\.js$/);
		assert.deepEqual(noMs(asyncCompile.output), noMs(syncCompile.output), 'the same output but timings');
		assert.equal(asyncCompile.summary, syncCompile.summary);
		assert.deepEqual(asyncCompile.affectedIds, syncCompile.affectedIds);
		assert.deepEqual(takeBytes(worked.motion.motionFor('actor-a')), takeBytes(plain.motion.motionFor('actor-a')), 'the same installed take, byte for byte');

		const key = (f, bat) => f.run('motion.keyObject', { characterId: 'actor-a', objectId: bat, frame: SWING_KEYS[2].f, pos: SWING_KEYS[2].pos, rot: SWING_KEYS[2].rot }, 'agent');
		const syncKey = ok(key(plain, a.bat)), asyncKey = ok(await key(worked, b.bat));
		assert.deepEqual(noMs(asyncKey.output), noMs(syncKey.output), 'keyObject: the same output');
		assert.deepEqual(takeBytes(worked.motion.motionFor('actor-a')), takeBytes(plain.motion.motionFor('actor-a')), 'keyObject: the same take');
		const keysOf = f => f.motion.motionFor('actor-a').spec.objects[f === plain ? a.bat : b.bat].keys?.map(k => k.f) ?? [];
		ok(await worked.run('edit.undo', {}, 'agent'));
		assert.deepEqual(keysOf(worked), [], 'one undo takes the worker-compiled key back, as one entry');
		ok(await worked.run('edit.redo', {}, 'agent'));
		assert.deepEqual(keysOf(worked), [SWING_KEYS[2].f]);

		const syncQa = ok(plain.run('motion.qa', { characterId: 'actor-a' }, 'agent')), asyncQa = ok(await worked.run('motion.qa', { characterId: 'actor-a' }, 'agent'));
		assert.deepEqual(noMs(asyncQa.output), noMs(syncQa.output), 'motion.qa: the same measure');

		const repaired = { characterId: 'actor-a', base: syncCompile.output.specId, patch: [{ op: 'replace', path: '/frames', value: 90 }], repair: { rounds: 1 }, install: 'never' };
		const syncRepair = ok(plain.run('motion.compile', repaired, 'agent')), asyncRepair = ok(await worked.run('motion.compile', repaired, 'agent'));
		assert.deepEqual(noMs(asyncRepair.output), noMs(syncRepair.output), 'base + patch + repair: the same answer');

		const bad = { characterId: 'actor-a', spec: { ...b.spec, fps: 30 } };
		const syncBad = plain.run('motion.compile', bad, 'agent'), asyncBad = await worked.run('motion.compile', bad, 'agent');
		assert.equal(asyncBad.ok, false);
		assert.equal(asyncBad.code, syncBad.code);
		assert.equal(asyncBad.message, syncBad.message, 'a refusal reads the same');
		assert.deepEqual(FakeWorker.made[0].jobs, [...FakeWorker.made[0].jobs].sort((x, y) => x - y), 'jobs go out in order');
	} finally {
		delete globalThis.Worker;
		plain.dispose(); worked.dispose();
	}
});

test('the runner: a worker that fails hands its jobs to the calling thread and says so once; refusals keep their code', async () => {
	const job = { model: 'y-bot-tpose', scene: motionScene([]), spec: { schema: 'cozyclay.motion-spec.v1', frames: 24, use: [{ skill: 'standIdle', f0: 0, args: { at: [0, 0] } }] } };
	const crashing = { postMessage() { setTimeout(() => this.onerror?.({ message: 'boom', preventDefault() {} }), 0); }, terminate() { this.terminated = true; } };
	const runner = createCompileRunner({ spawn: () => crashing });
	const first = runner.run(job);
	assert.equal(typeof first?.then, 'function');
	const answer = await first;
	assert.equal(answer.frameCount, 24, 'the job in flight is answered on the calling thread');
	assert.equal(crashing.terminated, true);
	assert.match(runner.takeWarning(), /motion compile worker stopped \(boom\); compiling on the main thread/);
	assert.equal(runner.takeWarning(), null, 'said once');
	const after = runner.run(job);
	assert.equal(typeof after?.then, 'undefined', 'after a failure the runner answers at once');
	assert.deepEqual(noMs(after), noMs(answer));

	const unstartable = createCompileRunner({ spawn: () => { throw new Error('no workers here'); } });
	assert.equal(unstartable.run(job).frameCount, 24);
	assert.match(unstartable.takeWarning(), /no workers here/);

	const worker = new FakeWorker('x', {});
	const refusing = createCompileRunner({ spawn: () => worker });
	await assert.rejects(refusing.run({ ...job, spec: { ...job.spec, fps: 30 } }), error => error instanceof StudioProtocolError && error.code === 'INVALID_ARGUMENT' && /spec\.fps must be 24/.test(error.message));
	await assert.rejects(refusing.run({ ...job, spec: { ...job.spec, frames: 10, keys: [{ f: 30, set: {} }] } }), error => error instanceof StudioProtocolError && error.code === 'INVALID_ARGUMENT');
	assert.equal(refusing.takeWarning(), null, 'a refusal is not a worker failure');
	assert.equal(createCompileRunner({ spawn: () => null }).run(job).frameCount, 24, 'no worker: the calling thread');
});

test('motion.compile keeps a worker fallback warning schema-valid at the receipt boundary', async () => {
	const previousWorker = globalThis.Worker;
	class CrashingWorker {
		postMessage() { setTimeout(() => this.onerror?.({ message: 'forced worker failure', preventDefault() {} }), 0); }
		terminate() { this.terminated = true; }
	}
	globalThis.Worker = CrashingWorker;
	const f = motionFixture();
	const logged = [], previousWarn = console.warn;
	console.warn = (...args) => logged.push(args);
	try {
		const spec = { schema: 'cozyclay.motion-spec.v1', fps: 24, frames: 24, use: [{ skill: 'standIdle', f0: 0, args: { at: [0, 0] } }] };
		const receipt = await f.run('motion.compile', { characterId: 'actor-a', spec }, 'ui');
		const fullNote = 'The motion compile worker stopped (forced worker failure); compiling on the main thread, which is slower and blocks the editor while it runs.';
		assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 1000));
		assert.deepEqual(receipt.warnings, [{
			code: 'MOTION_COMPILE_WORKER_STOPPED',
			message: fullNote.slice(0, 120),
		}]);
		assert.deepEqual(logged, [['[cozyclay] motion compile worker stopped', fullNote]]);
	} finally {
		console.warn = previousWarn;
		f.dispose();
		if (previousWorker === undefined) delete globalThis.Worker;
		else globalThis.Worker = previousWorker;
	}
});
