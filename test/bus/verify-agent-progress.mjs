// agent-progress.js through the real command bus: every motion.compile publishes its draft (the baked take, QA,
// goals and beats) whether or not it installs, numbered per character; images are kept; a clear starts over.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motionFixture } from './motion-fixture.mjs';
import { skeletonFor } from '../../src/motion3/rigs/index.js';
import { clearProgress, draftsOf, latestDraft, progressSheets, progressVersion, publishDraft, publishSheet, subscribeProgress } from '../../src/agent-progress.js';

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };

function walkSpec(model, frames) {
	const sk = skeletonFor(model), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1];
	return { schema: 'cozyclay.motion-spec.v1', fps: 24, frames, label: 'walk four steps',
		keys: [{ f: 0, set: { root: [0, P[I.Hips][1] - 0.01, 0], yaw: 0, foot_l: [0.09, ank, -0.03], foot_r: [-0.09, ank, 0.03], fyaw_l: 0, fyaw_r: 0 } }],
		generators: [{ type: 'walk', f0: 6, steps: 4, heading: [0, 0] }] };
}

test('every compile publishes a draft, installed or not; images are kept; clear starts over', () => {
	clearProgress();
	const f = motionFixture();
	let heard = 0;
	const stop = subscribeProgress(() => { heard++; });
	try {
		const model = f.cast.read().find(row => row.id === 'actor-a').model;
		const compile = args => ok(f.run('motion.compile', { characterId: 'actor-a', ...args }, 'agent'));
		const v0 = progressVersion();

		const draft = compile({ spec: walkSpec(model, 120), install: 'never' });
		const one = latestDraft('actor-a');
		assert.equal(one.n, 1);
		assert.equal(one.installed, false, 'a never-install compile is a draft that is not installed');
		assert.equal(f.motion.motionFor('actor-a'), null, 'the draft did not touch the character');
		assert.equal(one.take.schema, 'cozyclay.take.v3');
		assert.equal(one.frames, 120);
		assert.equal(one.specId, draft.output.specId);
		assert.equal(one.label, 'walk four steps');
		assert.equal(one.qa.total, draft.output.qa.total);
		assert.ok(Array.isArray(one.timeline) && one.timeline.length > 0, 'the beats ride with the draft');

		const missed = { ...walkSpec(model, 130), goals: [{ name: 'hand at head', near: ['joint:LeftHand', 'joint:Head'], tol: 0.02, at: 60 }] };
		compile({ spec: missed, install: 'ifClean' });
		const two = latestDraft('actor-a');
		assert.equal(two.n, 2);
		assert.equal(two.installed, true, 'ifClean with no take on installs the first take, even one that misses a goal');
		assert.deepEqual(two.qa.goals.map(g => [g.name, g.ok]), [['hand at head', false]], 'goals are published with their result');

		compile({ spec: walkSpec(model, 140) });
		const three = latestDraft('actor-a');
		assert.equal(three.installed, true, 'an installed compile is published as installed');
		assert.equal(f.motion.motionFor('actor-a').frameCount, three.frames);
		assert.deepEqual(draftsOf('actor-a').map(d => d.n), [1, 2, 3]);
		assert.equal(latestDraft(), three, 'the newest draft of any character');
		assert.ok(progressVersion() > v0 && heard >= 3, 'subscribers hear every publish');

		publishSheet({ characterId: 'actor-a', dataUrl: 'data:image/png;base64,AA==', width: 2, height: 1, caption: 'front, side' });
		assert.equal(progressSheets().length, 1);

		clearProgress();
		assert.deepEqual(draftsOf('actor-a'), []);
		assert.equal(latestDraft(), null);
		assert.equal(progressSheets().length, 0);
	} finally { stop(); f.dispose(); clearProgress(); }
});

test('a character keeps its last 12 drafts', () => {
	clearProgress();
	for (let i = 0; i < 15; i++) publishDraft('x', { take: { frameCount: 10 + i }, qa: { ok: true, total: 0 } });
	assert.deepEqual(draftsOf('x').map(d => d.n), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
	assert.equal(latestDraft('x').frames, 24);
	clearProgress();
});
