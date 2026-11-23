#!/usr/bin/env node
// verify_result motion measures one-frame jumps of an installed take (src/lowvis/jumps.js through
// src/studio-agent-motion.js): where the character is (its hips) when it stops for one frame inside a steady move, at
// its own size, and the objects that move and stop for one frame, each with a row of its own, over the frames it is
// shown on, the parts of a group that has a row left out, at most 3 objects. A steady take and a still object give
// no row. Made-up takes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { primeBindPose } from '../../src/poses.js';
import { createIkState } from '../../src/motion/ik.js';
import { compileTakeSource } from '../../src/domains/motion/take-source.js';
import { skeletonFor } from '../../src/motion3/rigs/index.js';
import { verifyInstalledTake } from '../../src/studio-agent-motion.js';
import { jumpsOf, groupJumps } from '../../src/lowvis/jumps.js';

function rigFixture(scale = 1) {
  const bytes = readFileSync(new URL('../../public/models/y-bot-tpose.fbx', import.meta.url));
  const rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  rig.scale.setScalar(.01 * scale); primeBindPose(rig); rig.updateMatrixWorld(true); return rig;
}
// A take that slides along +Z at `speed` m per frame; with stall the hips stay put on that frame and go on from there.
function take({ frames = 40, speed = .1, stall = null } = {}) {
  const sk = skeletonFor('y-bot-tpose'), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1], hips = P[I.Hips][1] - .01;
  const at = z => ({ root: [0, hips, z], yaw: 0, foot_l: [.09, ank, z - .03], foot_r: [-.09, ank, z + .03] });
  const keys = [{ f: 0, set: at(0) }, { f: frames - 1, set: at(speed * (frames - 1)) }];
  const t = compileTakeSource({ schema: 'cozyclay.take.v3', rig: 'y-bot-tpose', spec: { schema: 'cozyclay.motion-spec.v1', fps: 24, frames, keys }, placement: { position: [0, 0, 0], yaw: 0 }, scene: { objects: {} } });
  // the hips track as a steady slide, in the take's own units: the first frame's place plus the step the take makes over the clip
  const h = t.hips, step = [0, 1, 2].map(k => (h[(frames - 1) * 3 + k] - h[k]) / (frames - 1)), first = [h[0], h[1], h[2]];
  for (let f = 0; f < frames; f++) { const n = stall != null && f >= stall ? f - 1 : f; for (let k = 0; k < 3; k++) h[f * 3 + k] = first[k] + step[k] * n; }
  return t;
}
const verify = ({ motion, objects = [], scale = 1, range }) => verifyInstalledTake({
  target: { character: { id: 'actor', x: 0, y: 0, z: 0, rot: 0, scale }, rig: rigFixture(scale), motion, ikState: createIkState() },
  environment: { host: { workspaceId: 'w', documentEpoch: 'd', sceneId: 's', sceneEpoch: 'e' }, physicsRevision: 1, floor: { model: 'flat', y: 0 }, objects, cast: [], frameCount: motion.frames },
  yieldTask: () => Promise.resolve(), range });

test('jumpsOf: a stop of one frame inside a move is its step, a hop is its size, out and back is half of it on each frame, a start, a stop and a turn back are not jumps', () => {
  const path = zs => f => [0, 0, zs[f]];
  const stall = jumpsOf(path([0, .1, .2, .3, .3, .4, .5, .6]), 8, .01);
  assert.deepEqual(stall.map(j => j.f), [4]); assert(Math.abs(stall[0].size - .1) < 1e-9);
  assert.deepEqual(stall[0].steps.map(v => +v.toFixed(3)), [.1, 0, .1]);
  const hop = jumpsOf(path([0, 0, 0, .3, .3, .3, .3]), 7, .01);
  assert.deepEqual(hop.map(j => [j.f, +j.size.toFixed(3)]), [[3, .3]]);
  const pop = jumpsOf(path([0, 0, 0, .3, 0, 0, 0]), 7, .01);
  assert.deepEqual(pop.map(j => [j.f, +j.size.toFixed(3)]), [[3, .15], [4, .15]]);
  for (const zs of [[0, 0, 0, .1, .2, .3, .4], [0, .1, .2, .3, .3, .3, .3], [0, .1, .2, .3, .2, .1, 0], [0, .01, .04, .09, .16, .25, .36]]) assert.deepEqual(jumpsOf(path(zs), 7, .01), [], `no jump in ${zs}`);
  const g = groupJumps([{ part: 'a', at: path([0, .1, .2, .3, .3, .4, .5, .6]) }, { part: 'b', at: path([0, 0, 0, 0, 0, 0, 0, 0]) }], 8, .01);
  assert.equal(g.part, 'a'); assert.equal(g.frames, 1); assert.deepEqual(g.parts, ['a']);
  assert.equal(groupJumps([{ part: 'b', at: path([0, 0, 0, 0, 0, 0, 0, 0]) }], 8, .01), null);
});

test('jumpsOf and groupJumps: a stretch of frames is measured by itself, a place that is no number has no step, told picks the jumps that count', () => {
  const path = zs => f => [0, 0, zs[f]], zs = [0, .1, .2, .3, .3, .4, .5, .6, 5, 5.1, 5.2, 5.3, 5.3, 5.4, 5.5, 5.6];
  assert.deepEqual(jumpsOf(path(zs), 16, .01, 0, 8).map(j => j.f), [4]);
  assert.deepEqual(jumpsOf(path(zs), 16, .01, 8, 16).map(j => j.f), [12]);
  const g = groupJumps([{ part: 'a', at: path(zs), runs: [[0, 8], [8, 16]] }], 16, .01);
  assert.deepEqual([g.frames, g.first, g.last], [2, 4, 12], 'the hop between the two stretches is not a jump of either');
  assert.equal(groupJumps([{ part: 'a', at: path(zs), runs: [[0, 8], [8, 16]] }], 16, .01, (t, f) => f > 8).f, 12);
  assert.equal(groupJumps([{ part: 'a', at: path(zs), runs: [[0, 8]] }], 16, .01, () => false), null);
  assert.deepEqual(jumpsOf(path([0, .1, .2, .3, NaN, .4, .5, .6, .7, .8]), 10, .01), [], 'no step to or from a place that is no number');
});

test('verify_result motion: a body that stops for one frame inside its move is told with its frame and size; a steady one is not', async () => {
  const steady = await verify({ motion: take() });
  assert.equal(steady.frameJumps, undefined, 'a steady slide has no jump');
  const v = await verify({ motion: take({ stall: 20 }) });
  assert.equal(v.frameJumps.length, 1);
  const [row] = v.frameJumps;
  assert.deepEqual(Object.keys(row), ['id', 'frame', 'sizeM', 'stepsM', 'frames', 'firstFrame', 'lastFrame']);
  assert.equal(row.id, 'actor'); assert.equal(row.frame, 20);
  assert(row.stepsM[1] === 0 && Math.abs(row.stepsM[0] - row.sizeM) < .002 && Math.abs(row.stepsM[2] - row.sizeM) < .002 && row.sizeM > .05, `steps ${row.stepsM}`);
  assert([row.sizeM, ...row.stepsM].every(x => Math.round(x * 1000) === x * 1000 || Math.abs(Math.round(x * 1000) / 1000 - x) < 1e-12), 'metres to the millimetre');
  assert.equal(row.firstFrame, 20); assert.equal(row.lastFrame, 20); assert.equal(row.frames, 1);
  // a range: frames stay on the timeline
  const part = await verify({ motion: take({ stall: 20 }), range: { startFrame: 10, endFrameExclusive: 30 } });
  assert.equal(part.frameJumps[0].frame, 20);
  // at its own size: the same take on a body twice as large stops twice as far, against a threshold twice as large
  const big = await verify({ motion: take({ stall: 20 }), scale: 2 });
  assert(Math.abs(big.frameJumps[0].sizeM / row.sizeM - 2) < .02, `${big.frameJumps[0].sizeM} vs ${row.sizeM}`);
  // a stop shorter than the threshold is not told
  assert.equal((await verify({ motion: take({ stall: 20, speed: .1 * .04 / row.sizeM }) })).frameJumps, undefined);
});

test('verify_result motion: an object the take moves that stops for one frame has a row; its parts go with it; one hidden for a stretch is measured on the frames it is shown; at most 3 objects', async () => {
  const cube = (id, extra = {}) => ({ id, kind: 'cube', x: 2, y: .25, z: 0, rot: 0, scaleX: .5, scaleY: .5, scaleZ: .5, ...extra });
  assert.equal((await verify({ motion: take(), objects: [cube('crate')] })).frameJumps, undefined, 'a still object has no jump');
  // the take moves an object along +Z at `step` m per frame; with stall it stays put on that frame; vis: the frames it is shown on
  const track = (step, stall, F, vis) => { const pos = new Float32Array(F * 3), quat = new Float32Array(F * 4);
    for (let f = 0; f < F; f++) { pos.set([2, .25, step * (stall != null && f >= stall ? f - 1 : f)], f * 3); quat.set([0, 0, 0, 1], f * 4); }
    return { pos, quat, ...(vis ? { vis: Uint8Array.from({ length: F }, (_, f) => +vis(f)) } : {}) }; };
  const moved = tracks => { const m = take(); return { ...m, objects: Object.fromEntries(Object.entries(tracks).map(([id, [step, stall, vis]]) => [id, track(step, stall, m.frameCount, vis)])) }; };
  assert.equal((await verify({ motion: moved({ crate: [.2, null] }), objects: [cube('crate')] })).frameJumps, undefined, 'a steady move has no jump');
  const v = await verify({ motion: moved({ crate: [.2, 15] }), objects: [cube('crate'), cube('lid', { parent: 'crate', y: .75 }), cube('far', { x: 9 })] });
  assert.deepEqual(v.frameJumps, [{ id: 'crate', frame: 15, sizeM: .2, stepsM: [.2, 0, .2], frames: 1, firstFrame: 15, lastFrame: 15 }], 'one row: the crate, not the lid that goes with it');
  assert.equal(v.frameJumpsLeftOut, undefined);
  // an object that hops 5 m while it is hidden: no jump on the frames it is shown; the same hop in sight is one
  const hop = vis => { const m = moved({ ghost: [.2, null, vis] }), pos = m.objects.ghost.pos; for (let f = 20; f < m.frameCount; f++) pos[f * 3 + 2] += 5; return m; };
  assert.equal((await verify({ motion: hop(f => f < 18 || f > 22), objects: [cube('ghost')] })).frameJumps, undefined, 'a hop while hidden is not a jump');
  assert.deepEqual((await verify({ motion: hop(null), objects: [cube('ghost')] })).frameJumps.map(r => [r.id, r.frame, r.sizeM]), [['ghost', 20, 5]]);
  // four objects that stop: the three largest have rows, the largest first, the fourth is counted
  const four = await verify({ motion: moved({ a: [.1, 12], b: [.3, 14], c: [.2, 16], d: [.4, 18] }), objects: ['a', 'b', 'c', 'd'].map(id => cube(id)) });
  assert.deepEqual(four.frameJumps.map(r => [r.id, r.frame, r.sizeM]), [['d', 18, .4], ['b', 14, .3], ['c', 16, .2]]);
  assert.equal(four.frameJumpsLeftOut, 1);
});
