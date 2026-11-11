#!/usr/bin/env node
// Sculpt `repeat` (copies of one part by rule, merged into its one mesh), the
// build report object.sculpt answers with, the valid example a shape refusal
// carries, and the worked example in the object.sculpt description: it must
// validate, build, and stay one recipe an agent can copy.
import assert from "node:assert/strict";
import * as THREE from "three";
import { objectsFixture } from "./bus/objects-fixture.mjs";
import { SCULPT_LIMITS, expandSculptParts, normalizeSculptRecipe, patchSculptRecipe, sculptBounds } from "../src/sculpt-recipe.js";
import { repeatCopies } from "../src/sculpt-repeat.js";
import { buildSculptGroup, disposeSculptGroup, sculptPartGeometry } from "../src/sculpt-geometry.js";
import { sculptBuildReport } from "../src/sculpt-report.js";
import { SCULPT_EXAMPLE_NAMES, sculptExamplePart, sculptRefusalExample } from "../src/sculpt-shape-examples.js";
import { sculptRefusalPath } from "../src/sculpt-refusal-path.js";
import { sculptViewPolygons } from "../src/sculpt-compare.js";
import { createSculptObject, loadScene, serializeScene } from "../src/scene-objects.js";
import { declarations } from "../src/commands/objects.js";

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
const refused = (parts, pattern) => {
	const result = normalizeSculptRecipe({ parts });
	assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(parts).slice(0, 200)}`);
	assert.match(result.error, pattern);
	return result;
};
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
/** Object-frame centre of every copy of a drawn part. */
const centres = (part) => repeatCopies(part).map((copy) => new THREE.Vector3().applyMatrix4(new THREE.Matrix4().fromArray(part.matrix).multiply(new THREE.Matrix4().fromArray(copy))));
const picket = { id: "picket", shape: "box", size: [0.08, 0.9, 0.02], position: [-0.9, 0.45, 0], repeat: { count: 12, step: [0.16, 0, 0] } };
const spoke = { id: "spoke", shape: "cylinder", size: [0.02, 0.3, 0.02], position: [0, 0.65, 0], repeat: { count: 8, turn: [45, 0, 0], pivot: [0, 0.5, 0] } };

/* ------------------------------------------------------------ layout ---- */

await check("step lays copies in a row, and the row is ONE drawn part with an honest box", () => {
	const recipe = accepted([picket]);
	const drawn = expandSculptParts(recipe);
	assert.equal(drawn.length, 1, "a repeated part counts once");
	const at = centres(drawn[0]);
	assert.equal(at.length, 12);
	at.forEach((point, k) => { near(point.x, -0.9 + 0.16 * k); near(point.y, 0.45); });
	const { min, max } = sculptBounds(recipe);
	near(min[0], -0.94, 1e-4);
	near(max[0], -0.9 + 0.16 * 11 + 0.04, 1e-4);
});

await check("turn about a pivot makes a ring; step + turn makes a spiral stair", () => {
	const ring = centres(expandSculptParts(accepted([spoke]))[0]);
	ring.forEach((point, k) => {
		near(Math.hypot(point.y - 0.5, point.z), 0.15);
		near(point.y - 0.5, 0.15 * Math.cos(k * Math.PI / 4));
		near(point.z, 0.15 * Math.sin(k * Math.PI / 4));
	});
	const stair = centres(expandSculptParts(accepted([{ id: "step", shape: "box", size: [0.6, 0.05, 0.2], position: [0.35, 0.1, 0], repeat: { count: 12, step: [0, 0.16, 0], turn: [0, 30, 0] } }]))[0]);
	stair.forEach((point, k) => { near(point.y, 0.1 + 0.16 * k); near(Math.hypot(point.x, point.z), 0.35); });
	near(stair[3].z, -0.35, 1e-6);
});

await check("jitter is seeded: the same recipe draws the same copies, another seed others", () => {
	const jittered = (seed) => centres(expandSculptParts(accepted([{ ...picket, repeat: { ...picket.repeat, jitter: { position: 0.02, rotation: 5, scale: 0.2, seed } } }]))[0]);
	const a = jittered(1), b = jittered(1), c = jittered(2);
	assert.deepEqual(a.map((p) => p.toArray()), b.map((p) => p.toArray()));
	assert.notDeepEqual(a.map((p) => p.toArray()), c.map((p) => p.toArray()));
	a.forEach((point, k) => assert.ok(Math.abs(point.x - (-0.9 + 0.16 * k)) <= 0.02 + 1e-9, "position jitter stays within its range"));
});

await check("a mirrored repeat is the source's copies reflected, jitter included", () => {
	const recipe = accepted([{ id: "blade", shape: "box", mirror: true, size: [0.04, 0.6, 0.06], position: [0.3, 0.4, 0], repeat: { count: 5, turn: [0, 0, -15], pivot: [0.3, 0.1, 0], jitter: { scale: 0.15, rotation: 10, seed: 2 } } }]);
	const [source, mirror] = expandSculptParts(recipe);
	assert.equal(mirror.id, "blade.mirror");
	const corner = new THREE.Vector3(0.02, 0.3, 0.03), reflected = new THREE.Vector3(-0.02, 0.3, 0.03);
	const world = (part, point) => repeatCopies(part).map((copy) => point.clone().applyMatrix4(new THREE.Matrix4().fromArray(part.matrix).multiply(new THREE.Matrix4().fromArray(copy))));
	world(source, corner).forEach((point, k) => {
		const twin = world(mirror, reflected)[k];
		near(twin.x, -point.x); near(twin.y, point.y); near(twin.z, point.z);
	});
	assert.equal(expandSculptParts(recipe).length, 2);
});

/* ----------------------------------------------------------- geometry ---- */

await check("the copies merge into the part's ONE mesh, and the mesh stays inside the stored box", () => {
	const recipe = accepted([{ id: "hub", shape: "cylinder", size: [0.1, 0.1, 0.1], position: [0, 0.5, 0] }, spoke]);
	const group = buildSculptGroup(recipe);
	try {
		const meshes = group.children.filter((child) => child.isMesh);
		assert.deepEqual(meshes.map((mesh) => mesh.name), ["hub", "spoke"]);
		const one = sculptPartGeometry(expandSculptParts(recipe)[1]);
		assert.equal(meshes[1].geometry.getAttribute("position").count, one.getAttribute("position").count * 8);
		one.dispose();
		group.updateMatrixWorld(true);
		const box = new THREE.Box3().setFromObject(group), { min, max } = sculptBounds(recipe);
		box.min.toArray().forEach((value, axis) => assert.ok(value >= min[axis] - 1e-4, `mesh min ${value} inside ${min[axis]}`));
		box.max.toArray().forEach((value, axis) => assert.ok(value <= max[axis] + 1e-4, `mesh max ${value} inside ${max[axis]}`));
	} finally {
		disposeSculptGroup(group);
	}
});

await check("the silhouette compare outlines every copy", () => {
	const polygons = sculptViewPolygons(accepted([picket]));
	assert.equal(polygons.length, 12);
});

/* ----------------------------------------------------------- refusals ---- */

await check("bad repeat values are refused with the allowed values, never clamped", () => {
	const at = (repeat) => refused([{ ...picket, repeat }], /./);
	assert.match(at({ count: 1, step: [0.1, 0, 0] }).error, /repeat\.count: must be a whole number from 2 to 64/);
	assert.match(at({ count: 65, step: [0.1, 0, 0] }).error, /from 2 to 64, got 65/);
	assert.match(at({ count: 4 }).error, /needs a non-zero step/);
	assert.match(at({ count: 4, step: [6, 0, 0] }).error, /step\[0\]: must be within ±5 m/);
	assert.match(at({ count: 4, turn: [0, 400, 0] }).error, /turn\[1\]: must be within ±360 degrees/);
	assert.match(at({ count: 4, step: [0.1, 0, 0], jitter: { scale: 0.9 } }).error, /jitter\.scale: must be a number from 0 to 0\.5/);
	assert.match(at({ count: 4, step: [0.1, 0, 0], spin: 3 }).error, /repeat\.spin: unknown key \(allowed: count, step, turn, pivot, jitter\)/);
	assert.match(at([4]).error, /repeat: must be an object/);
	const result = at({ count: 99, step: [0.1, 0, 0] });
	assert.equal(result.example, "repeat");
	assert.equal(sculptRefusalPath(result.path), "$.args.recipe.parts[].repeat.count");
});

await check("repeat is refused on a scatter, on a cutter and on a part that carries parts", () => {
	refused([{ id: "grass", shape: "scatter", size: [1, 0.1, 1], item: "blade", count: 10, repeat: { count: 3, step: [1, 0, 0] } }], /does not apply to a scatter/);
	refused([{ id: "wall", shape: "box", size: [2, 1, 0.1], position: [0, 0.5, 0] }, { id: "hole", shape: "box", parent: "wall", op: "subtract", size: [0.2, 0.2, 0.3], repeat: { count: 3, step: [0.4, 0, 0] } }], /a cutter \(op\) cannot repeat/);
	refused([{ ...picket }, { id: "nail", shape: "blob", parent: "picket", size: [0.01, 0.01, 0.01] }], /parts\[picket\]\.repeat: a repeated part cannot carry parts \("nail"/);
});

await check("the recipe's repeat copies are capped after mirrors", () => {
	assert.equal(SCULPT_LIMITS.maxRepeatCopies, 256);
	const rows = Array.from({ length: 4 }, (_, i) => ({ ...picket, id: `row-${i}`, mirror: true, repeat: { count: 32, step: [0.02, 0, 0] } }));
	accepted(rows.slice(0, 4).map((row) => ({ ...row, repeat: { count: 32, step: [0.02, 0, 0] } })));
	const over = refused([...rows, { ...picket, id: "one-more", repeat: { count: 2, step: [0.1, 0, 0] } }], /repeat parts draw 258 copies with mirrors; the limit is 256/);
	assert.equal(over.example, "repeat");
});

await check("every shape's refusal brings a valid example of that shape, and every example validates", () => {
	for (const name of SCULPT_EXAMPLE_NAMES) {
		const result = normalizeSculptRecipe({ parts: [sculptExamplePart(name)] });
		assert.equal(result.ok, true, `${name} example: ${result.error}`);
		assert.ok(sculptRefusalExample(name).includes(JSON.stringify(sculptExamplePart(name))));
	}
	assert.equal(sculptRefusalExample(undefined), "");
	assert.equal(refused([{ id: "pot", shape: "lathe", size: [0.3, 0.3, 0.3], profile: [[0, 0]] }], /profile/).example, "lathe");
	assert.equal(refused([{ id: "t", shape: "tube", size: [0.3, 0.3, 0.3], path: [[0, 0, 0]], thickness: 0.02 }], /path/).example, "tube");
	assert.equal(refused([{ id: "l", shape: "loft", size: [0.3, 0.3, 0.3], sections: [{ y: 0.2, w: 1, d: 1 }, { y: 1, w: 1, d: 1 }] }], /sections/).example, "loft");
	assert.equal(refused([{ id: "e", shape: "extrude", size: [0.3, 0.3, 0.03], outline: [[0, 0], [0.1, 0]] }], /outline/).example, "extrude");
	assert.equal(refused([{ id: "b", shape: "blob", size: [0.3, 40, 0.3] }], /size/).example, undefined, "a size refusal is not a shape refusal");
});

/* -------------------------------------------------------- the command ---- */

await check("object.sculpt answers a build report and refuses with the example; edits and duplicate keep the repeat", () => {
	const f = objectsFixture();
	try {
		const made = f.run("object.sculpt", { recipe: { parts: [{ id: "post", shape: "cylinder", size: [0.08, 1, 0.08], position: [0, 0.5, 0] }, { ...picket, position: [-0.9, 0.45, 0.05] }] } });
		assert.equal(made.ok, true, JSON.stringify(made));
		assert.match(made.summary, /: 2 parts, .* m tall\. Box check: no floating, hidden or below-floor parts\. Spans x -0\.94\.\.0\.\d+, y 0\.\.1, z -0\.04\.\.0\.06 m\.$/);
		assert.ok(made.summary.length <= 240, `${made.summary.length}`);
		const id = made.affectedIds[0];
		const patched = f.run("object.sculpt", { id, edits: [{ set: "picket", repeat: { count: 6, step: [0.3, 0, 0] } }, { add: { id: "stone", shape: "blob", size: [0.2, 0.2, 0.2], position: [3, -0.05, 0] } }] });
		assert.equal(patched.ok, true, JSON.stringify(patched));
		assert.match(patched.summary, /Box check: floating \(touch nothing\): stone; below the floor: stone\./);
		assert.ok(patched.summary.length <= 240, `${patched.summary.length}`);
		assert.ok(patched.summary.length < 600);
		assert.deepEqual(f.objects.read().find((row) => row.id === id).recipe.parts[1].repeat, { count: 6, step: [0.3, 0, 0] });
		const bad = f.run("object.sculpt", { id, edits: [{ set: "picket", repeat: { count: 100, step: [0.3, 0, 0] } }] });
		assert.equal(bad.ok, false);
		assert.match(bad.message, /^Recipe refused at parts\[picket\]\.repeat\.count: must be a whole number from 2 to 64, got 100 A valid repeat part: \{"id":"picket".*"repeat":\{"count":12,"step":\[0\.16,0,0\]\}\}\. A ring:/);
		const cleared = f.run("object.sculpt", { id, edits: [{ set: "picket", repeat: null }] });
		assert.equal(cleared.ok, true);
		assert.equal(f.objects.read().find((row) => row.id === id).recipe.parts[1].repeat, undefined);
		f.run("object.sculpt", { id, edits: [{ set: "picket", repeat: { count: 3, turn: [0, 90, 0] } }] });
		const copy = f.run("object.duplicate", { objectId: id });
		assert.equal(copy.ok, true, JSON.stringify(copy));
		const rows = f.objects.read().filter((row) => row.renderer === "sculpt");
		assert.equal(rows.length, 2);
		assert.deepEqual(rows[1].recipe.parts[1].repeat, rows[0].recipe.parts[1].repeat);
	} finally {
		f.dispose();
	}
});

await check("a repeated sculpt round-trips the scene document", () => {
	const { object } = createSculptObject({ recipe: { parts: [{ ...picket, repeat: { count: 5, step: [0.2, 0, 0], jitter: { rotation: 4, seed: 9 } } }] } });
	const loaded = loadScene(serializeScene([object]));
	assert.equal(loaded.dropped, 0);
	assert.deepEqual(loaded.objects[0].recipe, object.recipe);
	assert.deepEqual(loaded.objects[0].footprint, object.footprint);
});

/* ------------------------------------------------------------ report ---- */

await check("the report flags floating, hidden and below-floor parts, folds mirrors and caps the list", () => {
	const recipe = accepted([
		{ id: "body", shape: "box", size: [1, 1, 1], position: [0, 0.5, 0] },
		{ id: "core", shape: "blob", size: [0.2, 0.2, 0.2], position: [0, 0.5, 0] },
		{ id: "ear", shape: "blob", mirror: true, size: [0.1, 0.1, 0.1], position: [2, 0.5, 0] },
		{ id: "root", shape: "cylinder", size: [0.1, 0.4, 0.1], position: [0, 0.1, 0] },
	]);
	const report = sculptBuildReport(recipe);
	assert.equal(report, "Box check: floating (touch nothing): ear; hidden inside another part: core; below the floor: root. Spans x -2.05..2.05, y -0.1..1, z -0.5..0.5 m.");
	const crowd = accepted(Array.from({ length: 30 }, (_, i) => ({ id: `stone-${i}-with-a-long-name-to-fill`, shape: "blob", size: [0.1, 0.1, 0.1], position: [i * 0.5, -0.2, 0] })));
	const long = sculptBuildReport(crowd);
	assert.ok(long.length <= 400, `${long.length} characters`);
	assert.match(long, /\+25 more/);
	assert.equal(sculptBuildReport(accepted([picket])), "Box check: no floating, hidden or below-floor parts. Spans x -0.94..0.9, y 0..0.9, z -0.01..0.01 m.");
	// a receipt summary leaves little room: the flags stay, the spans go
	assert.equal(sculptBuildReport(accepted([picket]), 60), "Box check: no floating, hidden or below-floor parts.");
});

/* ----------------------------------------------- the description example ---- */

await check("the object.sculpt description's worked example validates, builds and passes its own report", () => {
	const description = declarations.find((entry) => entry.id === "object.sculpt").description;
	const text = description.slice(description.indexOf("{parts:"));
	const recipe = JSON.parse(text.replace(/([{,])([a-z]+):/g, '$1"$2":'));
	assert.ok(recipe.parts.length >= 12 && recipe.parts.length <= 20, `${recipe.parts.length} parts`);
	const shapes = new Set(recipe.parts.map((part) => part.shape));
	assert.ok(shapes.has("loft") || shapes.has("lathe"));
	assert.ok(shapes.has("tube"));
	assert.ok(recipe.parts.some((part) => part.mirror) && recipe.parts.some((part) => part.repeat));
	assert.equal(new Set(recipe.parts.map((part) => part.color).filter(Boolean)).size, 3);
	const normalized = normalizeSculptRecipe(recipe);
	assert.equal(normalized.ok, true, normalized.error);
	assert.match(sculptBuildReport(normalized.recipe), /no floating, hidden or below-floor parts/);
	const group = buildSculptGroup(normalized.recipe);
	disposeSculptGroup(group);
	// +1,110 for the natural-things craft note (how a tree or a rock is built up from uneven masses, and what to look for in the close-up)
	assert.ok(description.length < 5300, `${description.length} characters`);
	assert.match(description, /blob 0 = ellipsoid, 1 = rounded box/);
	assert.match(description, /Use for: lathe/);
});

await check("patchSculptRecipe replaces a repeat whole", () => {
	const recipe = accepted([spoke]);
	const next = patchSculptRecipe(recipe, [{ set: "spoke", repeat: { count: 4, turn: [90, 0, 0], pivot: [0, 0.5, 0] } }]);
	assert.equal(next.ok, true, next.error);
	assert.deepEqual(next.recipe.parts[0].repeat, { count: 4, turn: [90, 0, 0], pivot: [0, 0.5, 0] });
});

if (failures) {
	console.log(`\nverify-sculpt-repeat: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nverify-sculpt-repeat: all checks passed");
