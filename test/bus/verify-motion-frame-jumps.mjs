#!/usr/bin/env node
// verify_result motion measures one-frame jumps of an installed take (src/lowvis/jumps.js through
// src/studio-agent-motion.js): a body that stops for one frame inside a steady move, at its own size, and an object
// that moves on keys and stops for one frame. A steady take and a still object give no row. Made-up takes.
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

test('verify_result motion: a body that stops for one frame inside its move is told with its frame, part and size; a steady one is not', async () => {
  const steady = await verify({ motion: take() });
  assert.equal(steady.frameJumps, undefined, 'a steady slide has no jump');
  const v = await verify({ motion: take({ stall: 20 }) });
  assert.equal(v.frameJumps.length, 1);
  const [row] = v.frameJumps;
  assert.equal(row.id, 'actor'); assert.equal(row.frame, 20);
  assert(row.stepsM[1] < .005 && Math.abs(row.stepsM[0] - row.sizeM) < .005 && Math.abs(row.stepsM[2] - row.sizeM) < .005, `steps ${row.stepsM}`);
  assert.equal(row.firstFrame, 20); assert.equal(row.lastFrame, 20); assert.equal(row.frames, 1);
  assert.equal(typeof row.part, 'string');
  // a range: frames stay on the timeline
  const part = await verify({ motion: take({ stall: 20 }), range: { startFrame: 10, endFrameExclusive: 30 } });
  assert.equal(part.frameJumps[0].frame, 20);
  // at its own size: the same take on a body twice as large stops twice as far, against a threshold twice as large
  const big = await verify({ motion: take({ stall: 20 }), scale: 2 });
  assert(Math.abs(big.frameJumps[0].sizeM / row.sizeM - 2) < .01, `${big.frameJumps[0].sizeM} vs ${row.sizeM}`);
  // a stop shorter than the threshold is not told
  assert.equal((await verify({ motion: take({ stall: 20, speed: row.sizeM ? .1 * .04 / row.sizeM : 0 }) })).frameJumps, undefined);
});

test('verify_result motion: an object the take moves that stops for one frame is told as the objects row', async () => {
  const cube = { id: 'crate', kind: 'cube', x: 2, y: .25, z: 0, rot: 0, scaleX: .5, scaleY: .5, scaleZ: .5 };
  assert.equal((await verify({ motion: take(), objects: [cube] })).frameJumps, undefined, 'a still object has no jump');
  // the take moves the crate along +Z at .2 m per frame; with stall it stays put on frame 15
  const moved = stall => { const m = take(), F = m.frameCount, pos = new Float32Array(F * 3), quat = new Float32Array(F * 4);
    for (let f = 0; f < F; f++) { pos.set([2, .25, .2 * (stall != null && f >= stall ? f - 1 : f)], f * 3); quat.set([0, 0, 0, 1], f * 4); }
    return { ...m, objects: { crate: { pos, quat } } }; };
  assert.equal((await verify({ motion: moved(null), objects: [cube] })).frameJumps, undefined, 'a steady move has no jump');
  const v = await verify({ motion: moved(15), objects: [cube] }), row = v.frameJumps.find(r => r.id === 'objects');
  assert.equal(row.part, 'crate'); assert.equal(row.frame, 15); assert(Math.abs(row.sizeM - .2) < 1e-3, `size ${row.sizeM}`);
});
