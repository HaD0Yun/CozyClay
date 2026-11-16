#!/usr/bin/env node
// Sculpt shapes that follow points: lathe (a profile turned round y), tube (a
// round tube along a path) and extrude (a flat outline pushed through z). Bad
// points are refused with their path, never clamped; the drawn mesh never
// leaves the part's size; a mirror reflects the shape's own points; and the
// silhouette compare stays honest about necks, U-bends, notches and holes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { expandSculptParts, normalizeSculptRecipe, patchSculptRecipe, sculptBounds } from "../src/sculpt-recipe.js";
import { buildSculptGroup, disposeSculptGroup, sculptPartGeometry } from "../src/sculpt-geometry.js";
import { sculptViewPolygons } from "../src/sculpt-compare.js";
import { earClip, monotoneCurve } from "../src/sculpt-curve.js";
import { createSculptObject, loadScene, serializeScene } from "../src/scene-objects.js";

let failures = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name} - ${error.stack?.split("\n").slice(0, 3).join(" | ") ?? error.message}`);
	}
}
const accepted = (parts) => {
	const result = normalizeSculptRecipe({ parts });
	assert.equal(result.ok, true, result.error);
	return result.recipe;
};
const refused = (part, pattern) => {
	const result = normalizeSculptRecipe({ parts: [part] });
	assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(part).slice(0, 160)}`);
	assert.match(result.error, pattern);
};
/** A deterministic stream in [0, 1): the shapes must not depend on Math.random, and neither do the tests. */
function lcg(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

const vase = { id: "vase", shape: "lathe", size: [0.4, 0.6, 0.3], profile: [[0.5, 0], [0.9, 0.15], [1, 0.4], [0.3, 0.75], [0.25, 0.9], [0.5, 1]] };
const rope = { id: "rope", shape: "tube", size: [0.6, 0.5, 0.06], thickness: 0.05, path: [[-0.5, 0.5, 0], [-0.45, -0.5, 0], [0.45, -0.5, 0], [0.5, 0.5, 0]] };
const sign = {
	id: "sign", shape: "extrude", size: [0.6, 0.4, 0.04], roundness: 0.5,
	outline: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.3], [0, 0.5], [-0.5, 0.3]],
	holes: [[[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]]],
};
const star = {
	id: "star", shape: "extrude", size: [0.6, 0.6, 0.1], roundness: 1,
	outline: Array.from({ length: 10 }, (_, i) => [Math.sin((i * Math.PI) / 5), Math.cos((i * Math.PI) / 5)].map((v) => Math.round(v * (i % 2 ? 0.2 : 0.5) * 1e4) / 1e4)),
};

/* ----------------------------------------------------------- contract ---- */

await check("each shape normalizes with its defaults, and normalizing again changes nothing", () => {
	const recipe = accepted([vase, rope, { id: "plank", shape: "extrude", size: [1, 0.2, 0.05], outline: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] }]);
	assert.deepEqual(normalizeSculptRecipe(recipe).recipe, recipe);
	const [lathe, tube, extrude] = recipe.parts;
	assert.equal(lathe.smooth, true);
	assert.deepEqual([tube.taper, tube.closed, tube.thickness], [0, false, 0.05]);
	assert.equal(extrude.roundness, 0.1);
	assert.equal("holes" in extrude, false, "holes are stored only when there are some");
	for (const key of ["roundness", "taper", "border", "path", "outline"]) assert.equal(key in lathe, false, `${key} is not a lathe's`);
});

await check("the stored points are fresh arrays, not the caller's", () => {
	const raw = structuredClone(rope);
	const [part] = accepted([raw]).parts;
	raw.path[0][0] = 0.1;
	assert.equal(part.path[0][0], -0.5);
});

await check("a lathe refuses a bad profile with the point's path", () => {
	refused({ ...vase, profile: undefined }, /parts\[vase\]\.profile: must be a list of 3-32 points \[r, y\]/);
	refused({ ...vase, profile: [[0.5, 0], [0.5, 1]] }, /parts\[vase\]\.profile: must be a list of 3-32/);
	refused({ ...vase, profile: Array.from({ length: 33 }, (_, i) => [0.5, i / 32]) }, /3-32 points/);
	refused({ ...vase, profile: [[0.5, 0], [1.2, 0.5], [0.5, 1]] }, /parts\[vase\]\.profile\[1\]\[0\]: must be from 0 to 1, got 1\.2/);
	refused({ ...vase, profile: [[0.5, 0], [1, 0.5, 0], [0.5, 1]] }, /parts\[vase\]\.profile\[1\]: must be 2 numbers/);
	refused({ ...vase, profile: [[0.5, 0], [1, 0.6], [0.5, 0.4]] }, /parts\[vase\]\.profile\[2\]\[1\]: y must not go down/);
	refused({ ...vase, profile: [[0.5, 0.5], [1, 0.5], [0.5, 0.5]] }, /profile: must climb/);
	refused({ ...vase, profile: [[0, 0], [0, 0.5], [0, 1]] }, /every r at 0/);
	refused({ ...vase, smooth: "yes" }, /parts\[vase\]\.smooth: must be true or false/);
});

await check("a tube refuses a bad path, thickness or loop with the field's path", () => {
	refused({ ...rope, path: [[0, 0, 0]] }, /parts\[rope\]\.path: must be a list of 2-32 points \[x, y, z\]/);
	refused({ ...rope, path: [[0, 0, 0], [0.2, 0.1, 0], [0.3, 0.2, 0], [0.4, 0.6, 0]] }, /parts\[rope\]\.path\[3\]\[1\]: must be from -0\.5 to 0\.5/);
	refused({ ...rope, thickness: undefined }, /parts\[rope\]\.thickness: must be the tube's diameter/);
	refused({ ...rope, thickness: 0 }, /thickness: must be .* from 0\.001/);
	refused({ ...rope, thickness: 0.07 }, /thickness: .*smallest size \(0\.06 m\), got 0\.07/);
	refused({ ...rope, closed: true, taper: 0.5 }, /parts\[rope\]\.taper: a closed tube cannot taper/);
	refused({ ...rope, closed: true, path: [[0, 0, 0], [0.5, 0, 0]] }, /closed tube needs at least 3 points/);
	refused({ ...rope, closed: 1 }, /closed: must be true or false/);
	refused({ ...rope, path: [[-0.5, 0, 0], [0.2, 0, 0], [0.2, 0, 0]] }, /parts\[rope\]\.path\[2\]: sits on the point before it/);
	// size z equals the thickness, so z is flattened away and these two points meet.
	refused({ ...rope, size: [0.6, 0.5, 0.05], path: [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [0.5, 0, 0]] }, /path\[1\]: sits on the point before it once fitted/);
	refused({ ...rope, closed: true, path: [[-0.5, 0, 0], [0, 0.5, 0], [0.5, 0, 0], [-0.5, 0, 0]] }, /path\[0\]: repeats the last point/);
	refused({ ...rope, taper: 2 }, /taper: must be a number from -1 to 1/);
});

await check("an extrude refuses crossing, repeated, flat and stray outlines", () => {
	const square = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
	refused({ ...sign, outline: [[0, 0], [0.5, 0]] }, /parts\[sign\]\.outline: must be a list of 3-64 points \[x, y\]/);
	refused({ ...sign, outline: Array.from({ length: 65 }, (_, i) => [0.5 * Math.cos(i / 10), 0.5 * Math.sin(i / 10)]) }, /3-64/);
	refused({ ...sign, holes: undefined, outline: [[-0.5, -0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, 0.5]] }, /parts\[sign\]\.outline: edge 0 .* touches or crosses another of its edges/);
	refused({ ...sign, holes: undefined, outline: [[-0.5, -0.5], [0.5, 0.5], [0.5, -0.2], [-0.5, 0.5]] }, /outline: edge 0 .* touches or crosses/);
	refused({ ...sign, holes: undefined, outline: [[-0.5, -0.5], [0.5, -0.5], [0.5, -0.5], [0, 0.5]] }, /parts\[sign\]\.outline\[2\]: repeats the point before it/);
	refused({ ...sign, holes: undefined, outline: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5], [-0.5, -0.5]] }, /outline\[0\]: repeats the last point/);
	refused({ ...sign, holes: undefined, outline: [[-0.5, 0], [0, 0], [0.5, 0]] }, /outline: edge 0 .* touches or crosses/);
	refused({ ...sign, holes: undefined, outline: [[-0.05, 0], [0.05, 0], [0.05, 0.0001]] }, /parts\[sign\]\.outline: encloses no area/);
	refused({ ...sign, holes: undefined, outline: [[-0.5, 0], [0.5, 0], [0, 0.5], [0.2, 0]] }, /touches or crosses/);
	refused({ ...sign, holes: [[[0.6, 0], [0.7, 0], [0.7, 0.1]]] }, /parts\[sign\]\.holes\[0\]\[0\]\[0\]: must be from -0\.5 to 0\.5/);
	const ell = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0], [0, 0], [0, 0.5], [-0.5, 0.5]];
	refused({ ...sign, outline: ell, holes: [[[-0.1, -0.1], [0.2, -0.1], [0.2, 0.2], [-0.1, 0.2]]] }, /parts\[sign\]\.outline: edge 2 .* touches or crosses parts\[sign\]\.holes\[0\] \(edge 1\)/);
	refused({ ...sign, outline: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [0.4, 0.5], [0.4, -0.4], [-0.5, -0.4]], holes: [[[0, 0], [0.2, 0], [0.1, 0.2]]] }, /parts\[sign\]\.holes\[0\]: must lie inside the outline/);
	const ring = [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]];
	refused({ ...sign, outline: square, holes: [ring, [[-0.1, -0.1], [0.1, -0.1], [0, 0.1]]] }, /parts\[sign\]\.holes\[1\]: must not lie inside another hole/);
	refused({ ...sign, outline: square, holes: Array.from({ length: 5 }, (_, i) => [[-0.4 + i * 0.15, 0], [-0.3 + i * 0.15, 0], [-0.35 + i * 0.15, 0.1]]) }, /holes: must be a list of at most 4 hole outlines/);
	refused({ ...sign, holes: "none" }, /holes: must be a list/);
});

await check("a shape's own keys stay its own", () => {
	refused({ id: "b", shape: "blob", size: [1, 1, 1], profile: vase.profile }, /parts\[b\]\.profile: does not apply to a blob/);
	refused({ ...rope, roundness: 0.2 }, /parts\[rope\]\.roundness: does not apply to a tube/);
	refused({ ...sign, taper: 0.2 }, /parts\[sign\]\.taper: does not apply to a extrude/);
	refused({ ...vase, thickness: 0.1 }, /thickness: does not apply to a lathe/);
});

/* ------------------------------------------------------------- patch ---- */

await check("a patched point list replaces the whole list, never merges into it", () => {
	const base = accepted([rope]);
	const result = patchSculptRecipe(base, [{ set: "rope", path: [[-0.5, 0, 0], [0.5, 0, 0]] }]);
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.recipe.parts[0].path, [[-0.5, 0, 0], [0.5, 0, 0]]);
	assert.equal(base.parts[0].path.length, 4, "the base recipe is untouched");
	const holes = patchSculptRecipe(accepted([sign]), [{ set: "sign", holes: [] }]);
	assert.equal("holes" in holes.recipe.parts[0], false, "an empty list clears the holes");
	assert.match(patchSculptRecipe(base, [{ set: "rope", path: [[0, 0, 0], [0.9, 0, 0]] }]).error, /parts\[rope\]\.path\[1\]\[0\]/);
});

await check("changing shape drops the old shape's points and options", () => {
	const base = accepted([rope, { id: "b", shape: "blob", size: [0.4, 0.6, 0.4], roundness: 0.8, taper: 0.3 }]);
	const toSign = patchSculptRecipe(base, [{ set: "rope", shape: "extrude", outline: sign.outline }]);
	assert.equal(toSign.ok, true, toSign.error);
	const part = toSign.recipe.parts[0];
	for (const key of ["path", "thickness", "taper", "closed"]) assert.equal(key in part, false, key);
	assert.equal(part.roundness, 0.1);
	const toVase = patchSculptRecipe(base, [{ set: "b", shape: "lathe", profile: vase.profile }]);
	assert.equal(toVase.ok, true, toVase.error);
	assert.deepEqual(Object.keys(toVase.recipe.parts[1]).sort(), ["color", "id", "position", "profile", "rotation", "shape", "size", "smooth"]);
	const toBlob = patchSculptRecipe(toVase.recipe, [{ set: "b", shape: "blob" }]);
	assert.equal("profile" in toBlob.recipe.parts[1] || "smooth" in toBlob.recipe.parts[1], false);
	assert.match(patchSculptRecipe(base, [{ set: "b", shape: "tube" }]).error, /parts\[b\]\.path: must be a list/);
});

/* ------------------------------------------------------------ mirror ---- */

const worldVertices = (part) => {
	const geometry = sculptPartGeometry(part);
	const matrix = new THREE.Matrix4().fromArray(part.matrix);
	const position = geometry.getAttribute("position");
	return Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix));
};
const summary = (points) => {
	const box = new THREE.Box3().setFromPoints(points);
	const centre = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(points.length);
	return [box.min.toArray(), box.max.toArray(), centre.toArray()];
};
const reflected = ([min, max, centre]) => [[-max[0], min[1], min[2]], [-min[0], max[1], max[2]], [-centre[0], centre[1], centre[2]]];
const close = (a, b, tol, label) => a.flat().forEach((value, i) => assert.ok(Math.abs(value - b.flat()[i]) <= tol, `${label}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`));

await check("a mirrored tube or extrude is the reflection of the original, not a turned copy", () => {
	const hook = { id: "hook", shape: "tube", size: [0.3, 0.4, 0.2], thickness: 0.04, taper: 0.5, path: [[-0.5, -0.5, 0], [-0.4, 0.4, 0.3], [0.2, 0.5, -0.5], [0.5, 0.1, 0.5]] };
	const arrow = { id: "arrow", shape: "extrude", size: [0.5, 0.3, 0.05], outline: [[-0.5, -0.2], [0.1, -0.2], [0.1, -0.5], [0.5, 0], [0.1, 0.5], [0.1, 0.2], [-0.5, 0.2]], holes: [[[-0.4, -0.1], [-0.2, -0.1], [-0.3, 0.1]]] };
	const recipe = accepted([
		{ id: "body", shape: "blob", size: [0.4, 0.4, 0.4], position: [0, 1, 0] },
		{ ...hook, parent: "body", position: [0.3, 0.1, 0.05], rotation: [10, 35, -20], mirror: true },
		{ ...arrow, parent: "body", position: [0.25, -0.1, 0.2], rotation: [-15, 25, 40], mirror: true },
	]);
	const parts = new Map(expandSculptParts(recipe).map((part) => [part.id, part]));
	assert.deepEqual(parts.get("hook.mirror").path[1], [0.4, 0.4, 0.3]);
	assert.deepEqual(parts.get("arrow.mirror").outline[3], [-0.5, 0]);
	assert.deepEqual(parts.get("arrow.mirror").holes[0][0], [0.4, -0.1]);
	assert.deepEqual(recipe.parts[1].path[1], [-0.4, 0.4, 0.3], "the authored part keeps its points");
	for (const id of ["hook", "arrow"]) {
		const original = summary(worldVertices(parts.get(id)));
		close(summary(worldVertices(parts.get(`${id}.mirror`))), reflected(original), 1e-6, id);
		// Without reflecting its own points the copy would be a turned copy, and would not match.
		const unflipped = { ...parts.get(`${id}.mirror`), path: parts.get(id).path, outline: parts.get(id).outline, holes: parts.get(id).holes };
		const turned = summary(worldVertices(unflipped));
		assert.ok(turned.flat().some((value, i) => Math.abs(value - reflected(original).flat()[i]) > 1e-3), `${id}: the test shape is not symmetric enough to tell`);
	}
	const vaseCopy = expandSculptParts(accepted([{ ...vase, position: [0.3, 0, 0], mirror: true }]))[1];
	assert.deepEqual(vaseCopy.profile, vase.profile, "a lathe is symmetric about its own x and needs nothing");
});

/* ---------------------------------------------------------- geometry ---- */

const signedVolume = (geometry) => {
	const p = geometry.getAttribute("position"), index = geometry.index.array;
	let volume = 0;
	for (let t = 0; t < index.length; t += 3) {
		const [a, b, c] = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(p, index[t + k]));
		volume += a.dot(b.cross(c)) / 6;
	}
	return volume;
};
function assertInside(part, label = part.id) {
	const geometry = sculptPartGeometry(part);
	geometry.computeBoundingBox();
	const box = geometry.boundingBox;
	for (let axis = 0; axis < 3; axis += 1) {
		const half = part.size[axis] / 2, key = "xyz"[axis];
		assert.ok(box.max[key] <= half + 1e-6 && box.min[key] >= -half - 1e-6, `${label} ${key}: ${box.min[key]}..${box.max[key]} vs ±${half}`);
	}
	return geometry;
}

await check("every new shape stays inside its size: overshoot, thickness, round ends and bevels included", () => {
	const parts = accepted([
		vase,
		{ id: "bulge", shape: "lathe", size: [0.3, 0.3, 0.5], profile: [[0, 0], [1, 0.05], [1, 0.1], [0.2, 0.5], [1, 0.9], [0, 1]] },
		{ id: "cup", shape: "lathe", size: [0.3, 0.3, 0.3], profile: [[0.7, 0], [0.75, 0.05], [1, 1]], smooth: false },
		rope,
		{ id: "zigzag", shape: "tube", size: [0.2, 0.2, 0.2], thickness: 0.15, path: [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [0.5, -0.5, 0.5]] },
		{ id: "loop", shape: "tube", size: [0.6, 0.5, 0.3], thickness: 0.08, closed: true, path: [[-0.5, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0], [0, -0.5, -0.5]] },
		{ id: "tail", shape: "tube", size: [0.5, 0.5, 0.1], thickness: 0.1, taper: -1, path: [[-0.5, -0.5, 0], [0, 0.5, 0], [0.5, -0.5, 0]] },
		sign,
		star,
		{ id: "cee", shape: "extrude", size: [0.5, 0.5, 0.2], roundness: 1, outline: [[0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5], [0.5, -0.5], [0.5, -0.4], [-0.4, -0.4], [-0.4, 0.4], [0.5, 0.4]] },
	]).parts;
	for (const part of parts) assertInside(part);
	const random = lcg(7);
	const pick = (lo, hi) => Math.round((lo + random() * (hi - lo)) * 1e4) / 1e4;
	for (let n = 0; n < 60; n += 1) {
		let y = 0;
		const profile = Array.from({ length: 3 + (n % 8) }, (_, i) => [pick(0, 1), i ? (y = Math.min(1, y + pick(0, 0.4))) : 0]);
		profile.at(-1)[1] = 1;
		const path = Array.from({ length: 2 + (n % 9) }, () => [pick(-0.5, 0.5), pick(-0.5, 0.5), pick(-0.5, 0.5)]);
		const size = [pick(0.05, 1), pick(0.05, 1), pick(0.05, 1)];
		const random3 = accepted([
			{ id: "l", shape: "lathe", size, profile: profile.some(([r]) => r > 0) ? profile : [[1, 0], ...profile.slice(1)] },
			{ id: "t", shape: "tube", size, thickness: Math.max(0.005, Math.min(...size) * pick(0.1, 1)), taper: pick(-1, 1), path },
		]).parts;
		for (const part of random3) assertInside(part, `${part.id} #${n}`);
	}
});

await check("the widest profile point and a straight tube reach the full size", () => {
	const [pot, bar] = accepted([vase, { id: "bar", shape: "tube", size: [1, 0.1, 0.1], thickness: 0.1, path: [[-0.5, 0, 0], [0.5, 0, 0]] }]).parts;
	const box = (part) => {
		const geometry = sculptPartGeometry(part);
		geometry.computeBoundingBox();
		return geometry.boundingBox;
	};
	assert.ok(Math.abs(box(pot).max.x - 0.2) < 1e-4 && Math.abs(box(pot).min.z + 0.15) < 1e-3, JSON.stringify(box(pot)));
	assert.ok(Math.abs(box(bar).max.x - 0.5) < 1e-4 && Math.abs(box(bar).max.y - 0.05) < 1e-3, JSON.stringify(box(bar)));
});

await check("each mesh is closed and faces out, with unit normals and a uv in metres", () => {
	const parts = accepted([vase, rope, sign, star, { id: "loop", shape: "tube", size: [0.6, 0.5, 0.3], thickness: 0.08, closed: true, path: [[-0.5, 0, 0], [0, 0.5, 0], [0.5, 0, 0], [0, -0.5, 0]] }]).parts;
	for (const part of parts) {
		const geometry = sculptPartGeometry(part);
		const normal = geometry.getAttribute("normal"), uv = geometry.getAttribute("uv");
		assert.ok(signedVolume(geometry) > 0, `${part.id} winds outward`);
		assert.equal(uv.count, geometry.getAttribute("position").count, `${part.id} has a uv per vertex`);
		for (let i = 0; i < normal.count; i += 1) {
			const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
			assert.ok(Math.abs(length - 1) < 1e-4, `${part.id} normal ${i} has length ${length}`);
		}
		const span = Math.max(...Array.from(uv.array).map(Math.abs));
		assert.ok(span > 0.01 && span < 5, `${part.id} uv spans ${span}, about the part's metres`);
	}
	// A closed tube of radius r along a loop of length L holds about π r² L.
	const ring = accepted([{ id: "ring", shape: "tube", size: [1.08, 1.08, 0.08], thickness: 0.08, closed: true, path: Array.from({ length: 16 }, (_, i) => [0.5 * Math.cos((i * Math.PI) / 8), 0.5 * Math.sin((i * Math.PI) / 8), 0]).map((p) => p.map((v) => Math.round(v * 1e4) / 1e4)) }]).parts[0];
	const expected = Math.PI * 0.04 ** 2 * (2 * Math.PI * 0.5);
	assert.ok(Math.abs(signedVolume(sculptPartGeometry(ring)) / expected - 1) < 0.05, "a 16-point loop is nearly a torus");
});

await check("a pot's ends are capped, and an extrude's hole is open", () => {
	const [pot, board] = accepted([{ id: "pot", shape: "lathe", size: [0.4, 0.5, 0.4], profile: [[0.6, 0], [1, 0.5], [0.7, 1]] }, sign]).parts;
	const hits = (geometry, origin, direction) => new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction)).intersectObject(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())).map((hit) => hit.point);
	const potMesh = sculptPartGeometry(pot);
	assert.ok(Math.abs(hits(potMesh, [0, -1, 0], [0, 1, 0])[0].y + 0.25) < 1e-6, "the bottom is closed");
	assert.ok(Math.abs(hits(potMesh, [0, 1, 0], [0, -1, 0])[0].y - 0.25) < 1e-6, "the top is closed");
	const boardMesh = sculptPartGeometry(board);
	assert.equal(hits(boardMesh, [0, 0, 1], [0, 0, -1]).length, 0, "the hole is see-through");
	assert.ok(Math.abs(hits(boardMesh, [0.2, 0, 1], [0, 0, -1])[0].z - 0.02) < 1e-6, "the board's face is solid");
});

await check("either winding draws the same extrude, and the build is deterministic", () => {
	const [cw, ccw] = accepted([star, { ...star, id: "star2", outline: [...star.outline].reverse() }]).parts;
	const a = sculptPartGeometry(cw), b = sculptPartGeometry(ccw);
	assert.ok(Math.abs(signedVolume(a) - signedVolume(b)) < 1e-9 && signedVolume(a) > 0);
	assert.deepEqual(Array.from(sculptPartGeometry(cw).getAttribute("position").array), Array.from(a.getAttribute("position").array));
});

await check("the built group with the new shapes fits the stored bounds", () => {
	const recipe = accepted([
		{ ...vase, position: [0, 0.3, 0] },
		{ ...rope, parent: "vase", position: [0.25, 0.1, 0], rotation: [0, 90, 0], mirror: true },
		{ ...sign, position: [0, 0.8, 0.1], rotation: [0, 0, 15] },
	]);
	const group = buildSculptGroup(recipe);
	group.updateMatrixWorld(true);
	const drawn = new THREE.Box3().setFromObject(group);
	const { min, max } = sculptBounds(recipe);
	for (const [i, key] of ["x", "y", "z"].entries()) {
		// sculptBounds rounds to 0.1 mm.
		assert.ok(drawn.min[key] >= min[i] - 1e-4 && drawn.max[key] <= max[i] + 1e-4, `${key}: drawn ${drawn.min[key]}..${drawn.max[key]} vs ${min[i]}..${max[i]}`);
	}
	disposeSculptGroup(group);
});

/* ----------------------------------------------------------- compare ---- */

const inside = (polygon, [x, y]) => {
	let result = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
		const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
	}
	return result;
};
const covered = (polygons, point) => polygons.some(({ polygon, hole }) => inside(polygon, point) && !(hole && inside(hole, point)));

await check("the silhouette keeps a vase's neck, a rope's U, an arrow's notch and a board's hole", () => {
	const at = (part) => sculptViewPolygons(accepted([part]));
	const neck = at(vase);
	assert.ok(covered(neck, [0, 0.12]) && covered(neck, [0.18, -0.05]), "the belly is solid");
	assert.equal(covered(neck, [0.15, 0.17]), false, "beside the neck is open");
	const u = at(rope);
	assert.equal(u.length, 3, "one hull per segment");
	assert.ok(covered(u, [0, -0.24]) && covered(u, [-0.29, 0.2]), "the rope itself is solid");
	assert.equal(covered(u, [0, 0.1]), false, "inside the U is open");
	const arrow = at({ id: "arrow", shape: "extrude", size: [1, 1, 0.05], outline: [[-0.5, -0.2], [0.1, -0.2], [0.1, -0.5], [0.5, 0], [0.1, 0.5], [0.1, 0.2], [-0.5, 0.2]] });
	assert.ok(covered(arrow, [-0.4, 0]) && covered(arrow, [0.3, 0]));
	assert.equal(covered(arrow, [-0.2, 0.35]), false, "the notch beside the shaft is open");
	const board = at(sign);
	assert.ok(covered(board, [0.2, 0]) && !covered(board, [0, 0]), "the largest hole is cut");
});

await check("ear clipping covers a simple loop of either winding exactly", () => {
	const random = lcg(11);
	for (let n = 0; n < 20; n += 1) {
		const count = 3 + (n % 12);
		const loop = Array.from({ length: count }, (_, i) => {
			const angle = (i / count) * 2 * Math.PI, r = 0.2 + 0.3 * random();
			return [r * Math.cos(angle), r * Math.sin(angle)];
		});
		const area = (points) => Math.abs(points.reduce((sum, p, i) => sum + p[0] * points[(i + 1) % points.length][1] - points[(i + 1) % points.length][0] * p[1], 0)) / 2;
		for (const winding of [loop, [...loop].reverse()]) {
			const triangles = earClip(winding);
			assert.equal(triangles.length, count - 2);
			const total = triangles.reduce((sum, triangle) => sum + area(triangle.map((k) => winding[k])), 0);
			assert.ok(Math.abs(total - area(winding)) < 1e-9, `${total} vs ${area(winding)}`);
		}
	}
});

await check("the smooth curve passes through every point and never leaves a segment's box", () => {
	const points = [[0, 0], [1, 0.9], [1, 1], [0, 1], [0.2, 0.3]];
	const curve = monotoneCurve(points, 10);
	points.forEach((point, k) => assert.deepEqual(curve[k * 10].map((v) => Math.round(v * 1e9) / 1e9), point));
	for (let k = 0; k + 1 < points.length; k += 1) {
		for (let i = k * 10; i <= (k + 1) * 10; i += 1) {
			for (const axis of [0, 1]) {
				const lo = Math.min(points[k][axis], points[k + 1][axis]), hi = Math.max(points[k][axis], points[k + 1][axis]);
				assert.ok(curve[i][axis] >= lo - 1e-12 && curve[i][axis] <= hi + 1e-12, `sample ${i} axis ${axis}: ${curve[i][axis]} outside ${lo}..${hi}`);
			}
		}
	}
});

/* ------------------------------------------------------------ record ---- */

await check("a sculpt with the new shapes round-trips through the scene document", () => {
	const { object, error } = createSculptObject({ recipe: { parts: [vase, rope, sign] } });
	assert.equal(error, undefined);
	const loaded = loadScene(serializeScene([object]));
	assert.equal(loaded.dropped, 0);
	assert.deepEqual(loaded.objects[0].recipe, object.recipe);
});

await check("the shape modules the MCP memory server imports stay free of three.js", () => {
	for (const file of ["sculpt-shapes.js", "sculpt-shapes-curved.js", "sculpt-curve.js", "sculpt-recipe-read.js"]) {
		const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
		assert.equal(/from\s+["']three/.test(text), false, `${file} imports three`);
	}
});

if (failures) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nverify-sculpt-shapes: all checks passed");
