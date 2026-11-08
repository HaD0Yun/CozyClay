// #1126: a command's receipt over 8 KiB sheds detail instead of failing a command that ran (receipt-fit.js). The v2
// forward-rolls script asked motion.sample for 39 frames x 13 bones and lost the whole script to "Receipt exceeds
// 8 KiB"; now the output's longest list keeps the entries that fit and OUTPUT_TRUNCATED says how many.
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { declarations } from '../../src/commands/motion3.js';

const BONES = ['Head', 'HeadTop_End', 'Neck', 'Spine2', 'Spine1', 'Spine', 'Hips', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'];
const FRAMES = Array.from({ length: 39 }, (_, i) => 14 + 2 * i);
const rows = frames => frames.map(frame => ({ frame, bones: Object.fromEntries(BONES.map((b, j) => [b, [0.1234 + j / 1e4, 0.5678, -1.2345]])) }));
const sample = declarations.find(d => d.id === 'motion.sample');
const bytes = v => new TextEncoder().encode(JSON.stringify(v)).byteLength;

const f = fixture();
let answer;
f.registry.register({ ...sample, available: () => true, run: () => answer });
const run = () => f.bus.run('motion.sample', { characterId: 'char-a', frames: FRAMES, bones: BONES }, f.request('agent'));
try {
  // 1. the rolls request: 39 frames x 13 bones is about 18 KB of rows
  answer = { affectedIds: [], summary: 'Sampled 39 frames.', output: { frames: rows(FRAMES) } };
  assert.ok(bytes(answer.output) > 8192, 'the fixture output is over 8 KiB');
  const cut = await run();
  assert.equal(cut.ok, true, JSON.stringify(cut).slice(0, 300));
  assert.equal(cut.status, 'completed');
  const kept = cut.output.frames.length, [warning] = cut.warnings.filter(w => w.code === 'OUTPUT_TRUNCATED');
  assert.ok(kept > 0 && kept < 39, `kept ${kept}`);
  assert.deepEqual(cut.output.frames, rows(FRAMES).slice(0, kept), 'the first rows are kept whole, in order');
  assert.equal(warning?.count, 39 - kept);
  assert.equal(warning.message, `output.frames lists ${kept} of 39 entries (8 KiB receipt); ask for the other ${39 - kept} in another call.`);
  assert.ok(bytes(cut) <= 8192 - 160, 'room is left for a background job id');
  const more = await f.bus.run('motion.sample', { characterId: 'char-a', frames: FRAMES, bones: BONES }, f.request('agent'));
  assert.equal(more.output.frames.length, kept, 'the cut is the most that fits, the same each time');
  console.log(`PASS an oversized output keeps ${kept} of 39 rows and says so (OUTPUT_TRUNCATED)`);

  // 2. a receipt that fits is untouched
  answer = { affectedIds: [], summary: 'Sampled 4 frames.', output: { frames: rows(FRAMES.slice(0, 4)) } };
  const small = await run();
  assert.equal(small.ok, true);
  assert.equal(small.output.frames.length, 4);
  assert.deepEqual(small.warnings.filter(w => w.code === 'OUTPUT_TRUNCATED'), []);
  console.log('PASS a receipt that fits keeps its whole output');

  // 3. nothing to cut, or another receipt refusal: refused as before
  answer = { affectedIds: [], summary: 'Too long.', output: { text: 'x'.repeat(9000) } };
  const blob = await run();
  assert.equal(blob.ok, false);
  assert.equal(blob.code, 'INVALID_RECEIPT');
  assert.match(blob.message, /Receipt exceeds 8 KiB; use a detail cursor\./);
  answer = { affectedIds: [], summary: 's'.repeat(241), output: { frames: rows(FRAMES) } };
  const summary = await run();
  assert.equal(summary.ok, false);
  assert.match(summary.message, /\$\.summary: at most 240 characters/);
  console.log('PASS an output with no list, or another receipt refusal, is refused as before');
} finally {
  f.bus.dispose();
}
