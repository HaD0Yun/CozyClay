// The timeline note's range guard where agent edits land: with a note sent
// (context-chips.js arms note-range-guard.js), the command bus refuses an
// agent's motion key, IK key or retime outside the note's frames, lets the
// ones inside through, never guards the author's own UI edits, and disarms
// when the next message carries no note.
import assert from 'node:assert/strict';
import { fixture, result } from './fixture.mjs';
import { addMark, consumeMarks, marksForAgent } from '../../src/context-chips.js';
import { noteRangeGuard } from '../../src/note-range-guard.js';

const f = fixture();
let runs = 0;
const edit = () => { runs++; f.edit(f.state.value + 1, 'motion'); return result(['char-1']); };
for (const id of ['character.setIkKey', 'character.removeIkKey', 'character.clearIkKeys', 'motion.cut', 'motion.trim', 'motion.setSegmentSpeed', 'motion.compile']) {
	f.registry.register({ id, label: id, description: id, kind: 'mutation', undoDomain: 'motion', exposure: 'open',
		input: { type: 'object', properties: {}, required: [], additionalProperties: true }, available: () => true, run: edit });
}
const ik = frame => ({ characterId: 'char-1', frame, tracks: {} });

// A note on char-1, frames 30-54, sent with a message.
// A point mark without a range never arms the guard; the note mark (a range) does.
addMark({ kind: 'pen', shape: 'point', hit: { type: 'object', id: 'cube-1', name: 'Cube', face: 'top' }, points: [{ x: 0, y: 1, z: 0 }], frame: 0 });
addMark({ kind: 'note', key: 'note:n1', hit: { type: 'character', id: 'char-1', name: 'Y Bot', bone: 'lArm' }, points: [], frame: 42, range: { frameStart: 30, frameEnd: 54 } });
assert.deepEqual(marksForAgent().marks.map(mark => [mark.n, mark.kind, mark.hit.id, mark.range?.frameStart ?? null]), [[1, 'pen', 'cube-1', null], [2, 'note', 'char-1', 30]], 'the marks ride the context as data');
consumeMarks();
assert.deepEqual(noteRangeGuard(), { characterId: 'char-1', frameStart: 30, frameEnd: 54 }, 'sending a note arms the guard');
assert.deepEqual(marksForAgent(), {}, 'sending clears the marks');

const inside = await f.bus.run('character.setIkKey', ik(42), f.request('agent'));
assert.equal(inside.ok, true, `an IK key inside the range lands: ${JSON.stringify(inside)}`);
const edge = await f.bus.run('character.setIkKey', ik(54), f.request('agent'));
assert.equal(edge.ok, true, 'the range is inclusive');
const before = runs;
const outside = await f.bus.run('character.setIkKey', ik(60), f.request('agent'));
assert.equal(outside.ok, false);
assert.equal(outside.code, 'INVALID_RANGE');
assert.match(outside.message, /timeline note.*frame 60.*frames 30-54/, outside.message);
assert.equal(runs, before, 'a refused edit never runs');
assert.equal((await f.bus.run('character.removeIkKey', { characterId: 'char-1', frame: 10 }, f.request('agent'))).code, 'INVALID_RANGE', 'removing a key outside is refused');
assert.equal((await f.bus.run('motion.cut', { characterId: 'char-1', frame: 80 }, f.request('agent'))).code, 'INVALID_RANGE', 'a cut outside is refused');
for (const id of ['character.clearIkKeys', 'motion.trim', 'motion.setSegmentSpeed', 'motion.compile']) {
	const refused = await f.bus.run(id, { characterId: 'char-1' }, f.request('agent'));
	assert.equal(refused.code, 'INVALID_RANGE', `${id} rewrites the whole take: ${JSON.stringify(refused)}`);
	assert.match(refused.message, /whole take/);
}
assert.equal((await f.bus.run('character.setIkKey', { ...ik(80), characterId: 'char-2' }, f.request('agent'))).ok, true, "another character's motion is not the note's");
assert.equal((await f.bus.run('character.setIkKey', ik(80), f.request('ui'))).ok, true, "the author's own edit is never guarded");

// The next message carries only a point mark: the guard is gone.
addMark({ kind: 'pen', shape: 'point', hit: { type: 'floor', id: null }, points: [{ x: 1, y: 0, z: 1 }], frame: 0 });
consumeMarks();
assert.equal(noteRangeGuard(), null);
assert.equal((await f.bus.run('character.setIkKey', ik(80), f.request('agent'))).ok, true, 'a later turn without a note edits freely');
f.bus.dispose();
console.log('PASS note range guard: agent motion/IK/retime edits outside the sent note frames are refused at the bus; inside, UI and other characters pass; the next message disarms it');
