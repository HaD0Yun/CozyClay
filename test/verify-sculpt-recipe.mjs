#!/usr/bin/env node
// Sculpt recipes (#730): a clay prop described as data. The recipe is refused,
// never clamped, when it cannot be drawn; mirrors are reflections, not
// rotations; and the geometry never pokes out of the box the record stores.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import {
	SCULPT_LIMITS,
	SCULPT_MIRROR_SUFFIX,
	expandSculptParts,
	normalizeSculptRecipe,
	patchSculptRecipe,
	sculptBounds,
	sculptStandingBox,
} from "../src/sculpt-recipe.js";
import { buildSculptGroup, disposeSculptGroup, sculptPartGeometry } from "../src/sculpt-geometry.js";

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
const turtle = JSON.parse(readFileSync(new URL("./fixtures/sculpt-nerd-turtle.json", import.meta.url), "utf8"));
const blob = (id, extra = {}) => ({ id, shape: "blob", size: [0.4, 0.4, 0.4], ...extra });
const accepted = (input) => {
	const result = normalizeSculptRecipe(input);
	assert.equal(result.ok, true, result.error);
	return result.recipe;
};
const refused = (input, pattern) => {
	const result = normalizeSculptRecipe(input);
	assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(input).slice(0, 120)}`);
	assert.match(result.error, pattern);
	return result;
};
const translation = (matrix) => [matrix[12], matrix[13], matrix[14]];
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/* ----------------------------------------------------------- contract ---- */

await check("the turtle fixture normalizes, and normalizing again changes nothing", () => {
	const recipe = accepted(turtle);
	assert.deepEqual(accepted(recipe), recipe);
	assert.equal(recipe.version, 1);
	assert.equal(recipe.parts.length, turtle.parts.length);
});

await check("defaults are filled per shape and nowhere else", () => {
	const recipe = accepted({ parts: [blob("a"), { id: "b", shape: "box", size: [1, 1, 1] }, { id: "c", shape: "cylinder", size: [1, 1, 1] }, { id: "d", shape: "frame", size: [1, 0.6, 0.1] }] });
	const [a, b, c, d] = recipe.parts;
	assert.deepEqual(a.position, [0, 0, 0]);
	assert.deepEqual(a.rotation, [0, 0, 0]);
	assert.equal(a.color, "#c2c6c8");
	assert.equal(a.roundness, 0.5);
	assert.equal(a.taper, 0);
	assert.equal(b.roundness, 0.1);
	assert.equal("taper" in b, false);
	assert.equal(c.taper, 0);
	assert.equal("roundness" in c, false);
	assert.equal(d.border, 0.09, "a frame's default border is 15% of its smaller side");
	assert.equal("mirror" in a, false, "mirror is stored only when true");
});

await check("colours fold to #rrggbb and angles wrap into (-180, 180]", () => {
	const [part] = accepted({ parts: [blob("a", { color: " #ABC ", rotation: [270, -190, 540] })] }).parts;
	assert.equal(part.color, "#aabbcc");
	assert.deepEqual(part.rotation, [-90, 170, 180]);
});

await check("a recipe that cannot be drawn is refused with the reason, never clamped", () => {
	refused(null, /must be an object/);
	refused({ parts: [] }, /non-empty array/);
	refused({ version: 2, parts: [blob("a")] }, /only version 1/);
	refused({ parts: [blob("a")], scale: 2 }, /recipe\.scale: unknown key/);
	refused({ parts: [blob("a", { wobble: 1 })] }, /parts\[0\]\.wobble: unknown key/);
	// capitals and _ are kept as written (models write camelCase ids); a space is still refused
	refused({ parts: [blob("a b")] }, /parts\[0\]\.id/);
	refused({ parts: [blob("a", { shape: "teapot" })] }, /parts\[a\]\.shape: must be one of blob, box, cylinder, torus, frame/);
	refused({ parts: [blob("a", { size: [0.4, 40, 0.4] })] }, /parts\[a\]\.size\[1\]: extent must be/);
	refused({ parts: [blob("a", { size: [0.4, 0.4] })] }, /three numbers/);
	refused({ parts: [blob("a", { position: [0, 25, 0] })] }, /within ±20/);
	refused({ parts: [blob("a", { roundness: 1.5 })] }, /roundness: must be a number from 0 to 1/);
	refused({ parts: [{ id: "a", shape: "cylinder", size: [1, 1, 1], roundness: 0.2 }] }, /roundness: does not apply to a cylinder/);
	refused({ parts: [blob("a", { color: "teal" })] }, /colour must be/);
	refused({ parts: [{ id: "f", shape: "frame", size: [1, 0.6, 0.1], border: 0.3 }] }, /border: must be above 0 and below half/);
	refused({ parts: [{ id: "t", shape: "torus", size: [1, 1, 1.2] }] }, /tube/);
});

await check("parents must exist, must not loop, and must not nest too deep", () => {
	refused({ parts: [blob("a"), blob("a")] }, /parts\[a\]\.id: is used twice/);
	refused({ parts: [blob("a", { parent: "ghost" })] }, /no part named "ghost"/);
	refused({ parts: [blob("a", { parent: "b" }), blob("b", { parent: "a" })] }, /cycle/);
	const chain = Array.from({ length: SCULPT_LIMITS.maxDepth + 2 }, (_, i) => blob(`p${i}`, i ? { parent: `p${i - 1}` } : {}));
	refused({ parts: chain }, /deeper than 8/);
	accepted({ parts: chain.slice(0, SCULPT_LIMITS.maxDepth + 1) });
});

await check("the part limit counts mirrored copies", () => {
	const half = SCULPT_LIMITS.maxParts / 2;
	accepted({ parts: Array.from({ length: half }, (_, i) => blob(`m${i}`, { position: [0.5, i * 0.1, 0], mirror: true })) });
	refused({ parts: Array.from({ length: half + 1 }, (_, i) => blob(`m${i}`, { position: [0.5, i * 0.1, 0], mirror: true })) }, /expands to 50 parts with mirrors; the limit is 48/);
});

await check("a mirror inside a mirrored subtree is refused (it would mint one id twice)", () => {
	refused({ parts: [blob("eye", { mirror: true }), blob("pupil", { parent: "eye", mirror: true })] }, /"eye" above it is already mirrored/);
});

/* ------------------------------------------------------------- patch ---- */

await check("a patch edits one part and leaves every other part byte-identical", () => {
	const before = accepted(turtle);
	const result = patchSculptRecipe(before, [{ set: "head", size: [0.75, 0.38, 0.5], color: "#336677" }]);
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.changed, ["head"]);
	const head = result.recipe.parts.find((p) => p.id === "head");
	assert.deepEqual(head.size, [0.75, 0.38, 0.5]);
	assert.equal(head.color, "#336677");
	assert.equal(head.roundness, before.parts.find((p) => p.id === "head").roundness, "untouched fields stay");
	for (const part of result.recipe.parts.filter((p) => p.id !== "head")) {
		assert.deepEqual(part, before.parts.find((p) => p.id === part.id));
	}
});

await check("add appends, remove takes the subtree, null and false clear", () => {
	const base = accepted({ parts: [blob("head"), blob("eye", { parent: "head", mirror: true, position: [0.1, 0, 0] }), blob("pupil", { parent: "eye" })] });
	const added = patchSculptRecipe(base, [{ add: blob("hat", { parent: "head", position: [0, 0.3, 0] }) }]);
	assert.equal(added.ok, true, added.error);
	assert.deepEqual(added.recipe.parts.map((p) => p.id), ["head", "eye", "pupil", "hat"]);
	const removed = patchSculptRecipe(base, [{ remove: "eye" }]);
	assert.deepEqual(removed.recipe.parts.map((p) => p.id), ["head"]);
	assert.deepEqual(removed.changed.sort(), ["eye", "pupil"]);
	const cleared = patchSculptRecipe(base, [{ set: "eye", parent: null, mirror: false }]);
	const eye = cleared.recipe.parts.find((p) => p.id === "eye");
	assert.equal("parent" in eye || "mirror" in eye, false);
});

await check("changing a shape drops the old shape's options instead of refusing them", () => {
	const base = accepted({ parts: [blob("a", { roundness: 0.9, taper: 0.4 })] });
	const result = patchSculptRecipe(base, [{ set: "a", shape: "frame", size: [0.6, 0.4, 0.05] }]);
	assert.equal(result.ok, true, result.error);
	assert.equal(result.recipe.parts[0].shape, "frame");
	assert.equal("roundness" in result.recipe.parts[0], false);
});

await check("a patch that breaks the recipe is refused with the path, and edits are checked", () => {
	const base = accepted(turtle);
	assert.match(patchSculptRecipe(base, [{ set: "head", size: [0.4, 40, 0.4] }]).error, /parts\[head\]\.size\[1\]/);
	assert.match(patchSculptRecipe(base, [{ set: "ghost", size: [1, 1, 1] }]).error, /edits\[0\]\.set: no part named "ghost"/);
	assert.match(patchSculptRecipe(base, [{ set: "head", add: blob("x") }]).error, /exactly one of set, add, remove/);
	assert.match(patchSculptRecipe(base, [{ set: "head", id: "face" }]).error, /rename by remove \+ add/);
	assert.match(patchSculptRecipe(base, [{ add: blob("head") }]).error, /is used twice/);
	assert.match(patchSculptRecipe(base, []).error, /non-empty/);
});

/* ---------------------------------------------------------- expansion ---- */

await check("a mirror is a reflection across x = 0: position.x flips, yaw and roll turn the other way", () => {
	const recipe = accepted({ parts: [blob("arm", { position: [0.3, 1, 0.2], rotation: [10, 20, 30], mirror: true })] });
	const parts = expandSculptParts(recipe);
	assert.deepEqual(parts.map((p) => p.id), ["arm", `arm${SCULPT_MIRROR_SUFFIX}`]);
	const [left, right] = parts;
	assert.deepEqual(right.position, [-0.3, 1, 0.2]);
	assert.deepEqual(right.rotation, [10, -20, -30]);
	// The reflected matrix is S·M·S with S = diag(-1, 1, 1): every element whose
	// row and column disagree on the x axis changes sign, the rest stay.
	for (let col = 0; col < 4; col += 1) {
		for (let row = 0; row < 4; row += 1) {
			const sign = (row === 0) !== (col === 0) && row < 3 && col < 3 ? -1 : row === 0 && col === 3 ? -1 : 1;
			assert.ok(near(right.matrix[col * 4 + row], sign * left.matrix[col * 4 + row], 1e-12), `m[${row}][${col}]`);
		}
	}
});

await check("part matrices match three.js's own XYZ Euler composition", () => {
	const rotation = [33, -71, 128];
	const [part] = expandSculptParts(accepted({ parts: [blob("a", { position: [0.1, 0.2, 0.3], rotation })] }));
	const expected = new THREE.Matrix4().compose(
		new THREE.Vector3(0.1, 0.2, 0.3),
		new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation.map(THREE.MathUtils.degToRad), "XYZ")),
		new THREE.Vector3(1, 1, 1),
	);
	expected.elements.forEach((value, i) => assert.ok(near(part.matrix[i], value, 1e-12), `element ${i}: ${part.matrix[i]} vs ${value}`));
});

await check("a mirrored part brings its subtree, reflected in the object frame", () => {
	const recipe = accepted({
		parts: [
			blob("head", { position: [0, 1.5, 0], rotation: [0, 25, -8] }),
			blob("eye", { parent: "head", position: [0.3, 0.1, 0.4], mirror: true }),
			blob("pupil", { parent: "eye", position: [0.05, 0.03, 0.12], size: [0.1, 0.1, 0.05] }),
		],
	});
	const byId = new Map(expandSculptParts(recipe).map((part) => [part.id, part]));
	assert.deepEqual([...byId.keys()], ["head", "eye", "pupil", "eye.mirror", "pupil.mirror"]);
	assert.equal(byId.get("pupil.mirror").parent, "eye.mirror");
	// Under a turned head the copies are NOT x-reflections of the originals in
	// the object frame -- they are reflections in the head's frame. Check that
	// through the head: bring both pupils into head space and compare there.
	const head = new THREE.Matrix4().fromArray(byId.get("head").matrix).invert();
	const local = (id) => new THREE.Vector3(...translation(byId.get(id).matrix)).applyMatrix4(head);
	const a = local("pupil");
	const b = local("pupil.mirror");
	assert.ok(near(a.x, -b.x, 1e-9) && near(a.y, b.y, 1e-9) && near(a.z, b.z, 1e-9), `${a.toArray()} vs ${b.toArray()}`);
});

await check("the turtle expands to 25 drawn parts with both eyes, rims and temples", () => {
	const ids = expandSculptParts(accepted(turtle)).map((part) => part.id);
	assert.equal(ids.length, 25);
	for (const id of ["eye", "eye.mirror", "pupil.mirror", "catchlight.mirror", "rim.mirror", "temple.mirror", "leg.mirror", "foot.mirror", "arm.mirror"]) {
		assert.ok(ids.includes(id), id);
	}
});

/* ----------------------------------------------------------- the box ---- */

await check("the standing box is centred, conservative, and as tall as the highest part", () => {
	const recipe = accepted({ parts: [blob("a", { size: [0.4, 1, 0.2], position: [0.5, 0.5, -0.1] })] });
	assert.deepEqual(sculptBounds(recipe), { min: [0.3, 0, -0.2], max: [0.7, 1, 0] });
	const box = sculptStandingBox(recipe);
	assert.deepEqual(box.footprint, { width: 1.4, depth: 0.4 });
	assert.equal(box.height, 1);
});

/* ---------------------------------------------------------- geometry ---- */

const geometryBox = (geometry) => {
	geometry.computeBoundingBox();
	return geometry.boundingBox;
};

await check("every shape stays inside its declared size", () => {
	const shapes = accepted({
		parts: [
			blob("b", { size: [0.6, 0.4, 0.3], roundness: 1, taper: 0.5 }),
			{ id: "x", shape: "box", size: [0.6, 0.4, 0.3], roundness: 0.5 },
			{ id: "x0", shape: "box", size: [0.6, 0.4, 0.3], roundness: 0 },
			{ id: "c", shape: "cylinder", size: [0.6, 0.4, 0.3], taper: -1 },
			{ id: "t", shape: "torus", size: [0.6, 0.4, 0.1] },
			{ id: "f", shape: "frame", size: [0.6, 0.4, 0.1], border: 0.05 },
		],
	}).parts;
	for (const part of shapes) {
		const box = geometryBox(sculptPartGeometry(part));
		for (let axis = 0; axis < 3; axis += 1) {
			const half = part.size[axis] / 2;
			const key = "xyz"[axis];
			assert.ok(box.max[key] <= half + 1e-6 && box.min[key] >= -half - 1e-6, `${part.id} ${key}: ${box.min[key]}..${box.max[key]} vs ±${half}`);
		}
	}
});

await check("an untapered blob reaches its full size on every axis", () => {
	const [part] = accepted({ parts: [blob("b", { size: [0.6, 0.4, 0.3], roundness: 0.4 })] }).parts;
	const box = geometryBox(sculptPartGeometry(part));
	assert.ok(near(box.max.x, 0.3, 1e-3) && near(box.max.y, 0.2, 1e-3) && near(box.max.z, 0.15, 1e-3), JSON.stringify(box));
});

await check("a frame is a ring: nothing is drawn inside the border", () => {
	const [part] = accepted({ parts: [{ id: "f", shape: "frame", size: [0.6, 0.4, 0.1], border: 0.05 }] }).parts;
	const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
	const mesh = new THREE.Mesh(sculptPartGeometry(part), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
	assert.equal(raycaster.intersectObject(mesh).length, 0, "the centre is open");
	raycaster.set(new THREE.Vector3(0.27, 0, 1), new THREE.Vector3(0, 0, -1));
	assert.ok(raycaster.intersectObject(mesh).length > 0, "the border is solid");
});

await check("the built turtle names every mesh by part and fits the stored box", () => {
	const recipe = accepted(turtle);
	const group = buildSculptGroup(recipe);
	const names = group.children.map((mesh) => mesh.name);
	assert.deepEqual(names, expandSculptParts(recipe).map((part) => part.id));
	assert.ok(group.children.every((mesh) => mesh.userData.sculptPart === mesh.name && mesh.castShadow));
	group.updateMatrixWorld(true);
	const drawn = new THREE.Box3().setFromObject(group);
	const { min, max } = sculptBounds(recipe);
	for (const [i, key] of ["x", "y", "z"].entries()) {
		assert.ok(drawn.min[key] >= min[i] - 1e-3 && drawn.max[key] <= max[i] + 1e-3, `${key}: drawn ${drawn.min[key]}..${drawn.max[key]} vs ${min[i]}..${max[i]}`);
	}
	const { height } = sculptStandingBox(recipe);
	assert.ok(drawn.max.y > height * 0.9, `drawn top ${drawn.max.y} is close to the stored height ${height}`);
	assert.ok(drawn.min.y > -0.01, `feet stand on the floor (${drawn.min.y})`);
	disposeSculptGroup(group);
});

await check("materialFor decides the look for every part", () => {
	const recipe = accepted({ parts: [blob("a", { color: "#ff0000" }), blob("b", { mirror: true, position: [0.3, 0, 0] })] });
	const seen = [];
	const group = buildSculptGroup(recipe, { materialFor: (part) => (seen.push(part.id), new THREE.MeshBasicMaterial({ color: "#00ff00" })) });
	assert.deepEqual(seen, ["a", "b", "b.mirror"]);
	assert.ok(group.children.every((mesh) => mesh.material.isMeshBasicMaterial));
	disposeSculptGroup(group);
});

if (failures) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nverify-sculpt-recipe: all checks passed");
