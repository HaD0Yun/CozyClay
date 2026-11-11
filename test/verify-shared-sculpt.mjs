// Sculpt copies share one built geometry (src/shared-sculpt.js): equal recipes build once, each copy owns its
// materials (the per-object passes write them) and its colour tint, and the geometry is freed only after the
// last copy lets go, past a grace period, so a copy still drawing never loses it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSculptRecipe } from '../src/sculpt-recipe.js';
import { sculptInstance, holdSculpt, releaseSculpt, tintSculpt, sharedSculptBuilds } from '../src/shared-sculpt.js';

const recipe = () => normalizeSculptRecipe({ version: 1, parts: [
	{ id: 'trunk', shape: 'cylinder', size: [0.3, 1.5, 0.3], position: [0, 0.75, 0], color: '#604e41' },
	{ id: 'crown', shape: 'blob', size: [1.4, 1.2, 1.4], position: [0, 1.9, 0], color: '#808080' },
] }).recipe;
const meshes = group => { const out = []; group.traverse(node => node.isMesh && out.push(node)); return out; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('equal recipes build once; copies share geometry but not materials; a tint is per copy', async () => {
	const start = sharedSculptBuilds();
	const a = sculptInstance(recipe()), b = sculptInstance(recipe()), other = sculptInstance({ ...recipe(), parts: recipe().parts.slice(0, 1) });
	[a, b, other].forEach(holdSculpt);
	assert.equal(sharedSculptBuilds(), start + 2, 'two distinct recipes, two builds');
	const [ma, mb] = [meshes(a.group), meshes(b.group)];
	assert.equal(ma.length, 2);
	ma.forEach((mesh, i) => {
		assert.equal(mesh.geometry, mb[i].geometry, 'geometry is shared');
		assert.notEqual(mesh.material, mb[i].material, 'materials are per copy');
	});
	tintSculpt(a, '#ff0000');
	const crown = i => meshes([a, b][i].group).find(mesh => mesh.name === 'crown').material.color;
	assert.equal(crown(0).g, 0, 'the tint multiplies the part colour');
	assert.ok(crown(1).g > 0, 'the other copy keeps its colour');
	tintSculpt(a, '#c2c6c8');
	assert.equal(crown(0).getHex(), crown(1).getHex(), 'the default grey is no tint');
	[a, b, other].forEach(releaseSculpt);
});

test('geometry is freed only after the last copy lets go, past the grace period', async () => {
	const a = sculptInstance(recipe()), b = sculptInstance(recipe());
	holdSculpt(a); holdSculpt(b);
	let freed = 0;
	for (const mesh of meshes(a.group)) mesh.geometry.addEventListener('dispose', () => { freed += 1; });
	releaseSculpt(a);
	await wait(2200);
	assert.equal(freed, 0, 'b still draws it');
	releaseSculpt(b);
	// A copy made again within the grace period (a remount) finds the same build.
	const c = sculptInstance(recipe());
	holdSculpt(c);
	assert.equal(meshes(c.group)[0].geometry, meshes(a.group)[0].geometry);
	await wait(2200);
	assert.equal(freed, 0);
	releaseSculpt(c);
	releaseSculpt(c);
	await wait(2200);
	assert.equal(freed, 2, 'freed once, when nobody holds it');
});
