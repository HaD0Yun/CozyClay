// Sculpt cards on the asset shelf (#740 S9 + S13): the `sculpt-` id in the
// shared asset store, the `.cozysculpt.json` round trip and its refusals, the
// store round trip (put, list, overwrite, delete) through the real scene-assets
// put/get/list/delete over an in-memory IndexedDB seam, Manage storage never
// sweeping a card, the thumbnail camera fit, and the drop table's five kinds.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { isAssetId, isImageAssetId, normalizeAsset, unreachableAssetIds } from '../../src/scene-assets.js';
import { isSculptAssetId, parseCard, readSculptCard, sculptCardFileName, sculptCardRecord, serializeCard, SCULPT_CARD_TYPE, SCULPT_FILE_SUFFIX } from '../../src/sculpt-shelf-file.js';
import { deleteSculptCard, importSculptCardFiles, putSculptCard, refreshSculptShelf, saveSculptToShelf, sculptShelfCards, subscribeSculptShelf } from '../../src/sculpt-shelf.js';
import { sculptThumbCamera } from '../../src/sculpt-thumb.js';
import { dropAssetAt } from '../../src/asset-drop.js';
import { normalizeSculptRecipe } from '../../src/sculpt-recipe.js';

const recipe = normalizeSculptRecipe(JSON.parse(await readFile(new URL('../fixtures/sculpt-snorlax.json', import.meta.url), 'utf8'))).recipe;
const turtle = normalizeSculptRecipe(JSON.parse(await readFile(new URL('../fixtures/sculpt-nerd-turtle.json', import.meta.url), 'utf8'))).recipe;
const THUMB = 'data:image/png;base64,iVBORw0KGgo=';
const subtle = webcrypto.subtle;

// 1. The id: a `sculpt-` prefix the shared store accepts, and nothing else.
const record = await sculptCardRecord({ name: 'Snorlax', recipe, thumb: THUMB }, subtle);
assert.match(record.id, /^sculpt-[0-9a-f]{32}$/);
assert.ok(isSculptAssetId(record.id) && isAssetId(record.id), 'isAssetId accepts the sculpt- prefix');
assert.ok(!isImageAssetId(record.id), 'a card id is not an image id');
for (const bad of ['sculpt-', 'sculpt-XYZ', `sculpt-${'a'.repeat(31)}`, `img-${'a'.repeat(32)}`, null]) assert.ok(!isSculptAssetId(bad), String(bad));
assert.equal((await sculptCardRecord({ name: 'Other name', recipe, thumb: null }, subtle)).id, record.id, 'the id is the recipe\'s: a renamed copy keeps one card');
assert.notEqual((await sculptCardRecord({ name: 'Turtle', recipe: turtle }, subtle)).id, record.id);
console.log('PASS a card id is sculpt-<32 hex> of the recipe, and isAssetId accepts it');

// 2. normalizeAsset keeps a card whose bytes parse and drops a cross-wired one.
assert.deepEqual(normalizeAsset(record), { id: record.id, type: SCULPT_CARD_TYPE, bytes: record.bytes, name: 'Snorlax' });
assert.equal(normalizeAsset({ ...record, type: 'image/png' }), null, 'prefix and type must agree');
assert.equal(normalizeAsset({ ...record, bytes: new TextEncoder().encode('{"format":"nope"}').buffer }), null, 'bytes that are not a card are dropped');
assert.deepEqual(unreachableAssetIds([record.id, `img-${'a'.repeat(32)}`], []), [`img-${'a'.repeat(32)}`], 'Manage storage never sweeps a card');
console.log('PASS normalizeAsset reads a card record; unreachableAssetIds leaves cards alone');

// 3. The file: serialize -> parse is the same recipe, name and thumbnail.
const text = serializeCard({ name: '  Snorlax  ', recipe, thumb: THUMB });
const file = JSON.parse(text);
assert.equal(file.format, 'cozysculpt');
assert.equal(file.version, 1);
const parsed = parseCard(text);
assert.ok(parsed.ok, parsed.error);
assert.deepEqual(parsed.card, { name: 'Snorlax', recipe, thumb: THUMB });
assert.equal(new TextDecoder().decode(record.bytes), serializeCard({ name: 'Snorlax', recipe, thumb: THUMB }), 'a card\'s stored bytes are its file');
assert.deepEqual(readSculptCard(record), { id: record.id, name: 'Snorlax', recipe, thumb: THUMB });
assert.equal(parseCard(serializeCard({ name: 'X', recipe, thumb: 'javascript:alert(1)' })).card.thumb, null, 'a thumbnail that is not an image data URL is dropped');
assert.equal(sculptCardFileName('My Sculpt / v2!'), `My-Sculpt-v2${SCULPT_FILE_SUFFIX}`);
assert.equal(sculptCardFileName(''), `sculpt${SCULPT_FILE_SUFFIX}`);
console.log('PASS .cozysculpt.json serialize -> parse returns the same recipe, name and thumbnail');

// 4. Refusals, each with a reason.
const refusals = {
	empty: '',
	'not JSON': '{oops',
	'no format': JSON.stringify({ version: 1, recipe }),
	'wrong format': JSON.stringify({ format: 'cozyscene', version: 1, recipe }),
	'version 2': JSON.stringify({ format: 'cozysculpt', version: 2, name: 'x', recipe }),
	'bad recipe': JSON.stringify({ format: 'cozysculpt', version: 1, name: 'x', recipe: { version: 1, parts: [{ id: 'a', shape: 'blob', size: [400, 1, 1], position: [0, 0, 0], color: '#ffffff' }] } }),
	'no recipe': JSON.stringify({ format: 'cozysculpt', version: 1, name: 'x' }),
	'too large': JSON.stringify({ format: 'cozysculpt', version: 1, recipe, pad: 'x'.repeat(5 * 1024 * 1024) }),
};
for (const [label, input] of Object.entries(refusals)) {
	const result = parseCard(input);
	assert.equal(result.ok, false, label);
	assert.ok(typeof result.error === 'string' && result.error.length > 5, `${label}: ${result.error}`);
}
assert.match(parseCard(refusals['version 2']).error, /version 2/);
assert.match(parseCard(refusals['bad recipe']).error, /refused/);
assert.throws(() => serializeCard({ name: 'x', recipe: { version: 1, parts: [] } }), /refused/);
console.log(`PASS ${Object.keys(refusals).length} bad files are refused with a reason`);

// 5. The store round trip, through scene-assets' own put/get/list/delete.
const rows = new Map();
const memoryDb = () => ({
	close() {},
	transaction() {
		const tx = { objectStore: () => ({
			put(value) { queueMicrotask(() => { rows.set(value.id, structuredClone(value)); tx.oncomplete(); }); },
			delete(id) { queueMicrotask(() => { rows.delete(id); tx.oncomplete(); }); },
			get(id) { const req = {}; queueMicrotask(() => { req.result = structuredClone(rows.get(id)); req.onsuccess(); }); return req; },
			getAllKeys() { const req = {}; queueMicrotask(() => { req.result = [...rows.keys()]; req.onsuccess(); }); return req; },
		}) };
		return tx;
	},
});
const openDb = async () => memoryDb();
rows.set(`img-${'b'.repeat(32)}`, { id: `img-${'b'.repeat(32)}`, type: 'image/png', width: 1, height: 1, bytes: new ArrayBuffer(4), name: 'photo.png' });
let published = 0;
const unsubscribe = subscribeSculptShelf(() => { published += 1; });
assert.deepEqual(await refreshSculptShelf({ openDb }), [], 'pictures in the store are not cards');
const source = structuredClone(recipe);
const snorlaxId = await putSculptCard({ name: 'Snorlax', recipe: source, thumb: THUMB }, { openDb, subtle });
const turtleId = await putSculptCard({ name: 'Nerd turtle', recipe: turtle }, { openDb, subtle });
assert.deepEqual(sculptShelfCards().map((card) => card.name), ['Nerd turtle', 'Snorlax'], 'cards list in name order');
source.parts[0].size = [9, 9, 9];
source.parts.length = 1;
assert.deepEqual((await refreshSculptShelf({ openDb })).find((card) => card.id === snorlaxId).recipe, recipe, 'the card holds a copy: editing or deleting the source sculpt leaves it');
await putSculptCard({ name: 'Snorlax again', recipe, thumb: THUMB }, { openDb, subtle });
assert.equal(sculptShelfCards().length, 2, 'saving the same recipe overwrites its card');
assert.equal(sculptShelfCards().find((card) => card.id === snorlaxId).name, 'Snorlax again');
assert.ok(await deleteSculptCard(turtleId, { openDb }));
assert.deepEqual(sculptShelfCards().map((card) => card.id), [snorlaxId]);
assert.ok(rows.has(`img-${'b'.repeat(32)}`), 'deleting a card leaves the pictures');
assert.equal(await deleteSculptCard(`img-${'b'.repeat(32)}`, { openDb }), false, 'the shelf deletes only cards');
assert.ok(published >= 5, `the folder heard every change (${published})`);
unsubscribe();
assert.deepEqual(await refreshSculptShelf({ openDb: async () => { throw new Error('no IndexedDB'); } }), [], 'no IndexedDB reads as an empty shelf');
console.log('PASS store round trip: put, list, copy semantics, overwrite, delete; no IndexedDB is an empty shelf');

// 6. Save to shelf and import answer a sentence; a bad file names itself.
assert.match(await saveSculptToShelf({ name: 'Turtle', recipe: turtle }, { openDb, renderThumb: async () => THUMB }), /Turtle saved to the shelf/);
assert.equal(sculptShelfCards().find((card) => card.name === 'Turtle').thumb, THUMB);
assert.match(await saveSculptToShelf(null, { openDb }), /Select a sculpt/);
await deleteSculptCard(snorlaxId, { openDb });
const asFile = (name, body) => ({ name, text: async () => body });
assert.match(await importSculptCardFiles([asFile('snorlax.cozysculpt.json', text)], { openDb }), /Imported Snorlax/);
assert.deepEqual(sculptShelfCards().find((card) => card.id === snorlaxId)?.recipe, recipe, 'export text -> import restores the card');
assert.match(await importSculptCardFiles([asFile('scene.json', refusals['wrong format'])], { openDb }), /scene\.json: the file is not a \.cozysculpt\.json/);
console.log('PASS Save to shelf stores the thumbnail; import restores an exported card and names a refused file');

// 7. The thumbnail camera: front three-quarter, above, the whole box in view.
const box = { min: [-0.5, 0, -0.4], max: [0.5, 1.6, 0.4] };
const fit = sculptThumbCamera(box);
assert.deepEqual(fit.target, [0, 0.8, 0]);
const [dx, dy, dz] = fit.position.map((value, axis) => value - fit.target[axis]);
const distance = Math.hypot(dx, dy, dz);
assert.ok(Math.abs(Math.atan2(dx, dz) * 180 / Math.PI - 35) < 1e-9, 'yaw 35 deg toward the subject\'s left');
assert.ok(Math.abs(Math.asin(dy / distance) * 180 / Math.PI - 15) < 1e-9, 'elevation 15 deg');
const radius = Math.hypot(1, 1.6, 0.8) / 2;
assert.ok(radius / distance < Math.sin(15 * Math.PI / 180), 'the bounding sphere fits inside the 30 deg view');
assert.ok(fit.near < distance - radius && fit.far > distance + radius, 'near and far bracket the subject');
const big = sculptThumbCamera({ min: [-5, 0, -5], max: [5, 10, 5] });
assert.ok(Math.hypot(...big.position.map((v, i) => v - big.target[i])) > distance * 5, 'a larger sculpt is framed from further back');
console.log('PASS the thumbnail camera frames the box from yaw 35, elevation 15');

// 8. The drop table: five kinds to their spawners, an unknown kind to nothing.
const calls = [];
const spawn = {
	spawnCharacter: (...args) => calls.push(['character', ...args]),
	addSceneObject: (...args) => calls.push(['object', ...args]),
	spawnCutoutAt: (...args) => calls.push(['image', ...args]),
	spawnMeshAt: (...args) => calls.push(['mesh', ...args]),
	runStudioAction: (...args) => { calls.push(['action', ...args]); return { ok: true, affectedIds: ['sculpt-2'] }; },
	select: (id) => calls.push(['select', id]),
};
const hit = { x: 1.25, y: 0, z: -2 };
assert.ok(dropAssetAt({ kind: 'character', id: 'x-bot' }, hit, spawn));
assert.ok(dropAssetAt({ kind: 'character', id: 'x-bot' }, { x: 999, z: -999 }, spawn));
assert.ok(dropAssetAt({ kind: 'object', objectKind: 'cube' }, hit, spawn));
assert.ok(dropAssetAt({ kind: 'image', assetId: 'img-1' }, hit, spawn));
assert.ok(dropAssetAt({ kind: 'mesh', assetId: 'mesh-1' }, hit, spawn));
assert.ok(dropAssetAt({ kind: 'sculpt', id: snorlaxId, name: 'Snorlax', recipe }, hit, spawn));
assert.equal(dropAssetAt({ kind: 'shot', id: 'a' }, hit, spawn), false);
assert.equal(dropAssetAt(null, hit, spawn), false);
assert.deepEqual(calls[0], ['character', 'x-bot', 1.25, -2]);
assert.ok(calls[1][2] < 999 && calls[1][3] > -999, `a character keeps its stage clamp: ${calls[1]}`);
assert.deepEqual(calls.slice(2, 5), [['object', 'cube', { x: 1.25, z: -2 }], ['image', 'img-1', { x: 1.25, z: -2 }], ['mesh', 'mesh-1', { x: 1.25, z: -2 }]]);
assert.deepEqual(calls[5], ['action', 'object.sculpt', { recipe, name: 'Snorlax', placement: { x: 1.25, z: -2 } }], 'a card drops through object.sculpt (createSculptObject, one undo)');
assert.deepEqual(calls[6], ['select', 'object:sculpt-2'], 'the dropped sculpt is selected');
assert.equal(calls.length, 7, 'unknown kinds spawn nothing');
console.log('PASS the drop table sends character, object, image, mesh and sculpt to their spawners and ignores the rest');
