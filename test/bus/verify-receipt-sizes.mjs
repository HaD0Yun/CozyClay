// Every object a command creates or resizes gets its size in the receipt (src/receipt-sizes.js), and no other
// object does. Each stated number is computed again here from the scene rows by this test's own arithmetic
// (footprint x height x scale), never by the function under test. The sizes take only the room the receipt
// without them leaves: its warnings and its output stay as they are, only the readback's box may give way.
import assert from 'node:assert/strict';
import { runSizeCases } from './receipt-sizes-cases.mjs';
import { fitReceipt } from '../../src/receipt-fit.js';
import { fitSized, receiptSizes, sizesInWarning } from '../../src/receipt-sizes.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const sizeOf = row => [row.footprint.width * row.scaleX, row.height * row.scaleY, row.footprint.depth * row.scaleZ];
const many = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`object-${i}`, [i + 0.5, 1, 2]]));
const warn = (i, length = 20) => ({ code: `FINDING_${i}`, message: 'w'.repeat(length) });
const sizesLine = receipt => receipt.warnings.find(w => w.code === 'SIZES_TRUNCATED');

// A receipt builder with the bus's levels: 0 the readback box, 1 without it, 2 four warnings; a line of `told`
// after them; past 8 KiB it throws as the receipt validation does.
const builder = ({ pad = 0, box = 0, warnings = [], output } = {}) => (level, out = output, cut = [], told = []) => {
	const all = [...cut, ...warnings];
	const receipt = { pad: 'p'.repeat(pad), delta: level > 0 ? [] : ['b'.repeat(box)], ...(out === undefined ? {} : { output: out }),
		warnings: [...(level > 1 && all.length > 4 ? [...all.slice(0, 3), { code: 'WARNINGS_TRUNCATED', count: all.length - 3 }] : all), ...told] };
	if (bytes(receipt) > 8192) throw Object.assign(new Error('Receipt exceeds 8 KiB; use a detail cursor.'), { code: 'INVALID_RECEIPT' });
	return receipt;
};
// What the receipt without sizes tells is all still told: the same warnings before the sizes line, the same output beside sizeM.
function keeps(sized, plain, label) {
	assert.deepEqual(sized.warnings.filter(w => w.code !== 'SIZES_TRUNCATED'), plain.warnings, `${label}: every warning of the plain receipt, in order`);
	const { sizeM: _sizes, ...rest } = sized.output ?? {};
	assert.deepEqual(Object.keys(rest).length ? rest : undefined, plain.output, `${label}: the plain receipt's output`);
	assert.ok(bytes(sized) <= 8192 - 160 || bytes(sized) === bytes(plain), `${label}: sizes leave the last 160 bytes`);
}
{
	const shape = { pad: 1000, box: 300, warnings: [warn(1)] }, sized = fitSized(builder(shape), undefined, many(10)), plain = fitReceipt(builder(shape));
	assert.deepEqual(sized.output.sizeM, many(10)); assert.deepEqual(sized.delta, plain.delta, 'room for all: the readback keeps its box'); keeps(sized, plain, 'room for all');
}
{
	const shape = { pad: 5000, box: 2600 }, sized = fitSized(builder(shape), undefined, many(30)), plain = fitReceipt(builder(shape));
	assert.equal(plain.delta.length, 1, 'the plain receipt is at level 0');
	assert.deepEqual(sized.output.sizeM, many(30), 'all sizes once the readback box gives way'); assert.equal(sized.delta.length, 0); assert.equal(sizesLine(sized), undefined);
}
{
	const shape = { pad: 7000, box: 500, warnings: [warn(1), warn(2)] }, sized = fitSized(builder(shape), undefined, many(100)), plain = fitReceipt(builder(shape));
	const listed = Object.keys(sized.output.sizeM), line = sizesLine(sized);
	assert.ok(listed.length > 0 && listed.length < 100); assert.deepEqual(listed, Object.keys(many(100)).slice(0, listed.length), 'the first ones, in order');
	assert.equal(line.count, 100 - listed.length, 'the line counts the sizes left out'); assert.equal(sized.warnings.at(-1), line, 'after the warnings');
	assert.match(line.message, new RegExp(`^sizeM lists ${listed.length} of 100 objects; inspect_studio scope entities with ids reads the others\\.$`)); assert.ok(line.message.length <= 120);
	keeps(sized, plain, 'as many as fit');
}
{
	const shape = { pad: 6300, box: 100, warnings: Array.from({ length: 8 }, (_, i) => warn(i, 200)) }, sized = fitSized(builder(shape), undefined, many(60)), plain = fitReceipt(builder(shape));
	assert.equal(plain.warnings.length, 4, 'the plain receipt is at level 2'); assert.equal(sized.warnings.length, 5, 'its four warnings and the sizes line');
	keeps(sized, plain, 'four warnings');
}
{
	const shape = { pad: 7990, box: 100, warnings: [warn(1)] }, sized = fitSized(builder(shape), undefined, many(20));
	assert.deepEqual(sized, fitReceipt(builder(shape)), 'no room for the line: the plain receipt, no size and no line');
	const full = { pad: 7300, box: 0, warnings: Array.from({ length: 12 }, (_, i) => warn(i)) }, kept = fitSized(builder(full), undefined, many(60));
	assert.deepEqual(kept, fitReceipt(builder(full)), 'twelve warnings: the line takes no warning\'s place');
}
{
	const output = { sourceId: 'cube', copies: Array.from({ length: 90 }, (_, i) => ({ id: `copy-${i}`, text: 'c'.repeat(90) })) }, shape = { pad: 500, box: 100, output };
	const sized = fitSized(builder(shape), output, many(90)), plain = fitReceipt(builder(shape), output);
	assert.ok(plain.output.copies.length < 90 && plain.warnings[0].code === 'OUTPUT_TRUNCATED', 'the plain receipt cut its list');
	keeps(sized, plain, 'a cut output list');
	assert.deepEqual(fitSized(builder({ output: ['a'] }), ['a'], many(3)), fitReceipt(builder({ output: ['a'] }), ['a']), 'an output that is no object gains nothing');
}
{
	const row = (id, extra = {}) => ({ id, renderer: 'cube', footprint: { width: 1, depth: 1 }, height: 1, scaleX: 1, scaleY: 1, scaleZ: 1, x: 0, y: 0, z: 0, rot: 0, ...extra });
	const before = { objects: [row('a'), row('b'), row('c'), row('d')] };
	const after = { objects: [row('a', { x: 5, rot: 45 }), row('b', { scaleX: 33 }), row('c', { footprint: { width: 2, depth: 2 }, height: 0 }), row('d', { name: 'D' }), row('e', { scaleY: 0.2 })] };
	assert.deepEqual(receiptSizes(before, after), { b: [33, 1, 1], c: [2, 0, 2], e: [1, 0.2, 1] }, 'a new id or a changed size; a move, a turn and a rename state none');
	assert.equal(receiptSizes(before, before), null);
}
{
	const partial = { status: 'partial', warnings: [warn(1)] }, one = sizesInWarning(partial, { cube: [4, 0.01, 2] });
	assert.deepEqual(one.warnings, [warn(1), { code: 'SIZES_INLINE', count: 1, message: 'sizeM {"cube":[4,0.01,2]}' }]);
	const long = sizesInWarning(partial, many(32)).warnings.at(-1);
	assert.deepEqual([long.code, long.count], ['SIZES_OMITTED', 32]); assert.match(long.message, /inspect_studio scope entities with ids reads the 32 objects\.$/); assert.ok(long.message.length <= 120);
	const cut = sizesInWarning({ status: 'partial', warnings: [warn(1), { code: 'SIZES_TRUNCATED', count: 7, message: 'm' }] }, many(3)).warnings;
	assert.deepEqual(cut.map(w => [w.code, w.count]), [['FINDING_1', undefined], ['SIZES_OMITTED', 10]], 'a cut list counts whole, and its own line goes with the output');
	assert.equal(sizesInWarning(partial, undefined), partial, 'no sizes, no line');
	const twelve = { status: 'partial', warnings: Array.from({ length: 12 }, (_, i) => warn(i)) };
	assert.equal(sizesInWarning(twelve, many(2)), twelve, 'twelve warnings stay twelve');
	const full = { status: 'partial', pad: 'p'.repeat(8000), warnings: [] };
	assert.equal(sizesInWarning(full, many(2)), full, 'no room, no line');
}
console.log('PASS sizes take only the room a receipt leaves: its warnings and output are kept, only the readback box gives way');

const cases = await runSizeCases();
let previous = [], checked = 0;
for (const c of cases) {
	if (!c.receipt || c.receipt.ok === false || !c.rows) { if (c.rows) previous = c.rows; continue; }
	const old = new Map(previous.map(r => [r.id, String(sizeOf(r))]));
	const expectedIds = c.rows.filter(r => old.get(r.id) !== String(sizeOf(r))).map(r => r.id);
	const stated = c.receipt.output?.sizeM;
	const inline = c.receipt.warnings.find(w => w.code === 'SIZES_INLINE');
	const sizes = stated ?? (inline ? JSON.parse(inline.message.slice('sizeM '.length)) : undefined);
	const truncated = sizesLine(c.receipt);
	if (c.receipt.action === 'edit.undo') { assert.equal(sizes, undefined, 'undo answers as before'); previous = c.rows; continue; }
	if (!expectedIds.length) assert.equal(sizes, undefined, `${c.label}: nothing created or resized, no sizes`);
	else {
		assert.ok(sizes, `${c.label}: sizes stated (${JSON.stringify(c.receipt.warnings)})`);
		const listed = Object.keys(sizes);
		assert.deepEqual(listed, expectedIds.slice(0, listed.length), `${c.label}: exactly the created or resized ids, in scene order`);
		if (listed.length < expectedIds.length) assert.equal(truncated?.count, expectedIds.length - listed.length, `${c.label}: the missing count is stated`);
		else assert.equal(truncated, undefined);
		for (const id of listed) {
			const want = sizeOf(c.rows.find(r => r.id === id));
			sizes[id].forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 1e-4, `${c.label}: ${id} axis ${i} stated ${v}, rows give ${want[i]}`));
			checked++;
		}
	}
	assert.ok(bytes(c.receipt) <= 8192, `${c.label}: receipt fits 8 KiB`);
	previous = c.rows;
}
const by = label => cases.find(c => c.label === label).receipt;
// Facts fixed by arithmetic on the inputs: primitives at scale 1, a scale-33 plane, sculpt recipes, kinds with no body.
assert.deepEqual(Object.values(by('every primitive kind').output.sizeM), [[1, 1, 1], [1, 1, 1], [0.7, 1.4, 0.7], [1, 1, 1], [1, 1, 1], [2, 0, 2]]);
assert.deepEqual(Object.values(by('one-number scale and per-axis scale').output.sizeM), [[66, 0, 66], [4, 0.2, 2]]);
assert.deepEqual(Object.values(by('turned about each axis').output.sizeM), [[1, 1, 1], [1, 1, 1], [1, 1, 1]], 'the same however it is turned');
assert.deepEqual(Object.values(by('sculpt of one part').output.sizeM), [[0.5, 0.8, 0.3]]);
assert.deepEqual(Object.values(by('sculpt of several parts').output.sizeM), [[1.6, 0.45 + 0.04, 0.4]]);
assert.deepEqual(Object.values(by('empty').output.sizeM), [[0, 0, 0]], 'an empty has no body');
assert.equal(Object.keys(by('sixteen objects in one call').output.sizeM).length, 16, 'all sixteen past the readback limit of 8');
assert.equal(by('sixteen objects in one call').delta.length, 8);
assert.deepEqual(by('patch of scale past the limit').warnings.at(-1), { code: 'SIZES_INLINE', count: 1, message: 'sizeM {"cube-2":[4,0.01,2]}' }, 'a partial receipt carries them in its last warning');
assert.ok(by('a hundred objects in one call').warnings[0].code === 'READBACK_TRUNCATED' && by('a hundred objects in one call').warnings.at(-1).code === 'SIZES_TRUNCATED');
console.log(`PASS ${checked} stated sizes agree with the rows; ids, missing counts, partial receipts and calls without a resize hold`);
process.exit(0);
