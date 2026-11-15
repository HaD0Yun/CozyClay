#!/usr/bin/env node
// src/lowvis/studio/tops.js: the flat heights an object offers, from rays straight down over what it draws.
// A cube 1 x 0.5 x 1 offers one top at 0.5; a slab 1.2 x 0.45 x 0.5 with a wall 1.2 x 0.9 x 0.1 at its back offers
// 0.45 (the larger) and 0.9. The numbers are in the object's own frame, unchanged by where it stands and how it turns.
import assert from "node:assert/strict";
import * as THREE from "three";
import { objectTops } from "../../src/lowvis/studio/tops.js";

/** A group whose origin is the base pivot, with one box mesh per [w, h, d, x, y0, z] (y0: the box's underside). */
function object(boxes, { at = [0, 0, 0], rot = 0 } = {}) {
	const group = new THREE.Group();
	for (const [w, h, d, x, y0, z] of boxes) {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());
		mesh.position.set(x, y0 + h / 2, z);
		group.add(mesh);
	}
	group.position.set(...at);
	group.rotation.y = rot * Math.PI / 180;
	return group;
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

const cube = objectTops(object([[1, 0.5, 1, 0, 0, 0]]));
assert.equal(cube.length, 1, `a cube offers one top, got ${JSON.stringify(cube)}`);
near(cube[0].y, 0.5, 0.005, "the cube's top");
near(cube[0].x1 - cube[0].x0, 1, 0.01, "the cube's top spans its width");
console.log(`ok cube 1 x 0.5 x 1: ${JSON.stringify(cube)}`);

const SLAB = [[1.2, 0.45, 0.5, 0, 0, 0], [1.2, 0.9, 0.1, 0, 0, -0.2]];
for (const place of [{}, { at: [2, 0, -1], rot: 30 }]) {
	const tops = objectTops(object(SLAB, place));
	assert.equal(tops.length, 2, `the slab with a wall offers two tops, got ${JSON.stringify(tops)}`);
	near(tops[0].y, 0.45, 0.005, "the larger top is the slab");
	near(tops[1].y, 0.9, 0.005, "the second top is the wall");
	assert.ok((tops[0].x1 - tops[0].x0) * (tops[0].z1 - tops[0].z0) > (tops[1].x1 - tops[1].x0) * (tops[1].z1 - tops[1].z0), "largest first");
	assert.ok(tops[1].z1 <= -0.1 && tops[0].z1 >= 0.2, "the wall's top is at the back, the slab's reaches the front");
	console.log(`ok slab with a wall ${JSON.stringify(place)}: ${JSON.stringify(tops)}`);
}
assert.deepEqual(objectTops(null), [], "no group, no tops");
console.log("PASS verify-object-tops");
