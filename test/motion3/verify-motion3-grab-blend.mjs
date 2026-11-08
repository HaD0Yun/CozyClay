#!/usr/bin/env node
// Grab and release without a pop (object-keys.js approach, compiler/anchors.js propOnCarry), on two agent takes:
//   cup-at-along   bench S8, session cb2503b5: keys lead the cup from its grab frame with an at/along grip 13.6 cm off
//                  where the reach brought the hand; the hand jumped onto it in the grab frame (POP RightHand and
//                  RightForeArm there). It now turns onto the grip over the frames before the grab.
//   barbell-curl   session 02263581 turn 2: the left hand's anchor is a point of the right palm's prop, 55 cm off it.
//                  Before the grab and after the release that point swung with the right palm turning into and out
//                  of its grip (about 80 cm), and the left hand followed it. It now stays where it sits on the barbell.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { compileSpec } from '../../src/motion3/pipeline.js';
import { skeletonFor } from '../../src/motion3/rigs/index.js';
import { motionScene } from '../../src/motion3/scene.js';

const sk = skeletonFor('y-bot-tpose');
const load = name => JSON.parse(readFileSync(new URL(`../fixtures/grab-grip/${name}.json`, import.meta.url), 'utf8'));
const compile = ({ spec, objects }, opts) => compileSpec({ fps: 24, ...spec }, { sk, scene: motionScene(objects) }, opts);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('keys that lead from the grab frame with a grip off the reach: the hand turns onto it before the grab, no pop there', () => {
	const fx = load('cup-at-along'), r = compile(fx), grab = fx.spec.objects.cup.grab, I = sk.index.RightHand;
	const step = f => dist(r.out.frames[f].s.P[I], r.out.frames[f - 1].s.P[I]);
	const worst = Math.max(...[grab - 1, grab, grab + 1].map(step));
	assert.ok(worst < 0.03, `right hand step at the grab ${(worst * 100).toFixed(1)} cm (was 13.6)`);
	const pops = r.qa.groups.filter(g => g.kind === 'POP' && /^Right(Hand|ForeArm)/.test(g.subject) && Math.abs(g.first - grab) <= 2);
	assert.equal(pops.length, 0, pops.map(g => `${g.subject} f${g.first}`).join('; '));
	// the cup still rides the keys from the grab: the hand meets it there instead of the cup meeting the hand
	// the fingers are measured against the table since #1113 (finger-collide.js): 17 frames of fingertips 2.9 cm in its top on the reach
	const fingers = r.qa.groups.filter(g => /^fingers_[lr] x /.test(g.subject)).reduce((n, g) => n + g.count, 0);
	assert.ok(r.qa.total - fingers <= 101 && fingers <= 17, `QA ${r.qa.total} with ${fingers} fingers issues (was 101, and 17)`);
});

test('a prop point on the hand that carries an object stays on that object before the grab and after the release', () => {
	const fx = load('barbell-curl'), o = fx.spec.objects.empty;
	const r = compile(fx, { probes: [{ name: 'before', position: 'anchor:gripL', frames: [o.grab - 14, o.grab - 1], every: 1 },
		{ name: 'after', position: 'anchor:gripL', frames: [o.release + 1, o.release + 14], every: 1 }] });
	for (const name of ['before', 'after']) {
		const at = r.probes[name].at, spread = Math.max(...at.map(x => dist(x.p, at[0].p)));
		assert.ok(spread < 0.001, `${name}: the anchor moved ${(spread * 100).toFixed(1)} cm with the barbell at rest (was about 80 cm)`);
	}
	// where the barbell is taken, the point meets the palm's own (no jump into the carry)
	const into = compile(fx, { probes: [{ name: 'grab', position: 'anchor:gripL', frames: [o.grab - 1, o.grab], every: 1 }] }).probes.grab.at;
	assert.ok(dist(into[0].p, into[1].p) < 0.02, `the anchor moved ${(dist(into[0].p, into[1].p) * 100).toFixed(1)} cm into the grab`);
	// the left elbow, which followed the swinging point into the grab, moves less there
	const E = sk.index.LeftForeArm, step = f => dist(r.out.frames[f].s.P[E], r.out.frames[f - 1].s.P[E]);
	const worst = Math.max(...[o.grab - 2, o.grab - 1].map(step));
	assert.ok(worst < 0.25, `left elbow step before the grab ${(worst * 100).toFixed(1)} cm (was 28.6)`);
});
