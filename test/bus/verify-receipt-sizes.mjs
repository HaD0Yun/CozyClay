// Every object a command creates or resizes gets its world box size in the receipt (src/receipt-sizes.js), and no
// other object does. Each stated number is computed again here from the scene rows by this test's own arithmetic
// (box corners turned by the row's Euler angles), never by the function under test.
import assert from 'node:assert/strict';
import { runSizeCases } from './receipt-sizes-cases.mjs';

const DEG = Math.PI / 180;
const mul = (a, b) => a.map((row, i) => [0, 1, 2].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const rx = t => [[1, 0, 0], [0, Math.cos(t), -Math.sin(t)], [0, Math.sin(t), Math.cos(t)]];
const ry = t => [[Math.cos(t), 0, Math.sin(t)], [0, 1, 0], [-Math.sin(t), 0, Math.cos(t)]];
const rz = t => [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]];
// A row's own box (footprint x height x scale), turned in XYZ order, as world min/max per axis.
function rowBox(row) {
	const m = mul(mul(rx(row.rotX * DEG), ry(row.rot * DEG)), rz(row.rotZ * DEG));
	const w = row.footprint.width * row.scaleX / 2, d = row.footprint.depth * row.scaleZ / 2, h = row.height * row.scaleY;
	const corners = [-w, w].flatMap(x => [0, h].flatMap(y => [-d, d].map(z => [x, y, z])))
		.map(p => [0, 1, 2].map(i => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + [row.x, row.y ?? 0, row.z][i]));
	return [0, 1, 2].map(i => [Math.min(...corners.map(c => c[i])), Math.max(...corners.map(c => c[i]))]);
}
const isEmpty = row => row.renderer === 'empty' || row.renderer === 'light';
function expectedSize(row, rows) {
	const boxes = isEmpty(row) ? rows.filter(r => !isEmpty(r) && descends(r, row.id, rows)).map(rowBox) : [rowBox(row)];
	if (!boxes.length) return null;
	return [0, 1, 2].map(i => Math.max(...boxes.map(b => b[i][1])) - Math.min(...boxes.map(b => b[i][0])));
}
const descends = (row, id, rows) => { for (let r = row; r?.parent; r = rows.find(o => o.id === r.parent)) if (r.parent === id) return true; return false; };
const own = row => JSON.stringify([row.renderer, row.footprint.width, row.footprint.depth, row.height, row.scaleX, row.scaleY, row.scaleZ]);

const cases = await runSizeCases();
let previous = [], checked = 0;
for (const c of cases) {
	if (!c.receipt || c.receipt.ok === false || !c.rows) { if (c.rows) previous = c.rows; continue; }
	const old = new Map(previous.map(r => [r.id, r]));
	const expectedIds = c.rows.filter(r => !old.has(r.id) || own(old.get(r.id)) !== own(r)).map(r => r.id);
	const stated = c.receipt.output?.worldBoxSizeM;
	const inline = c.receipt.warnings.find(w => w.code === 'SIZES_INLINE');
	const sizes = stated ?? (inline ? JSON.parse(inline.message.slice('worldBoxSizeM '.length)) : undefined);
	const truncated = c.receipt.warnings.find(w => w.code === 'SIZES_TRUNCATED');
	if (c.receipt.action === 'edit.undo') { assert.equal(sizes, undefined, 'undo answers as before'); previous = c.rows; continue; }
	if (!expectedIds.length) assert.equal(sizes, undefined, `${c.label}: nothing created or resized, no sizes`);
	else {
		assert.ok(sizes, `${c.label}: sizes stated (${JSON.stringify(c.receipt.warnings)})`);
		const listed = Object.keys(sizes);
		assert.deepEqual(listed, expectedIds.slice(0, listed.length), `${c.label}: exactly the created or resized ids, in scene order`);
		if (listed.length < expectedIds.length) assert.equal(truncated?.count, expectedIds.length - listed.length, `${c.label}: the missing count is stated`);
		else assert.equal(truncated, undefined);
		for (const id of listed) {
			const want = expectedSize(c.rows.find(r => r.id === id), c.rows);
			if (want === null) { assert.equal(sizes[id], null, `${c.label}: ${id} has nothing to measure`); continue; }
			sizes[id].forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 2e-4, `${c.label}: ${id} axis ${i} stated ${v}, rows give ${want[i]}`));
			checked++;
		}
	}
	assert.ok(JSON.stringify(c.receipt).length <= 8192, `${c.label}: receipt fits 8 KiB`);
	previous = c.rows;
}
const by = label => cases.find(c => c.label === label).receipt;
// Facts fixed by arithmetic on the inputs: primitives at scale 1, a scale-33 plane, sculpt recipes.
assert.deepEqual(Object.values(by('every primitive kind').output.worldBoxSizeM), [[1, 1, 1], [1, 1, 1], [0.7, 1.4, 0.7], [1, 1, 1], [1, 1, 1], [2, 0, 2]]);
assert.deepEqual(Object.values(by('one-number scale and per-axis scale').output.worldBoxSizeM), [[66, 0, 66], [4, 0.2, 2]]);
assert.deepEqual(Object.values(by('sculpt of one part').output.worldBoxSizeM), [[0.5, 0.8, 0.3]]);
assert.deepEqual(Object.values(by('sculpt of several parts').output.worldBoxSizeM), [[1.6, 0.45 + 0.04, 0.4]]);
assert.equal(Object.keys(by('sixteen objects in one call').output.worldBoxSizeM).length, 16, 'all sixteen past the readback limit of 8');
assert.equal(by('sixteen objects in one call').delta.length, 8);
assert.ok(by('a hundred objects in one call').warnings[0].code === 'READBACK_TRUNCATED' && by('a hundred objects in one call').warnings[1].code === 'SIZES_TRUNCATED');
console.log(`PASS ${checked} stated sizes agree with the rows; ids, missing counts, partial receipts and calls without a resize hold`);
process.exit(0);
