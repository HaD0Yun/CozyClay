#!/usr/bin/env node
// Sculpt surface detail, gradients and scatter: three additive recipe features
// that keep a prop from reading as smooth single-colour plastic. Bad data is
// refused with its path; the same recipe always draws the same geometry; and
// nothing pokes out of the size box the record measures.
import assert from "node:assert/strict";
import * as THREE from "three";
import { SCULPT_LIMITS, expandSculptParts, normalizeSculptRecipe, patchSculptRecipe } from "../src/sculpt-recipe.js";
import { buildSculptGroup, disposeSculptGroup, sculptPartGeometry } from "../src/sculpt-geometry.js";
import { SCATTER_ITEMS } from "../src/sculpt-scatter-shape.js";
import { sculptViewPolygons } from "../src/sculpt-compare.js";

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
const accepted = (input) => {
	const result = normalizeSculptRecipe(input);
	assert.equal(result.ok, true, result.error);
	return result.recipe;
};
const refused = (input, path, pattern) => {
	const result = normalizeSculptRecipe(input);
	assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(input).slice(0, 160)}`);
	assert.equal(result.path, path, result.error);
	if (pattern) assert.match(result.error, pattern);
};
const blob = (id, extra = {}) => ({ id, shape: "blob", size: [0.8, 0.6, 0.5], ...extra });
const scatter = (id, extra = {}) => ({ id, shape: "scatter", item: "blade", count: 200, size: [1, 0.3, 1], ...extra });
const one = (part) => accepted({ parts: [part] }).parts[0];
const drawn = (recipe) => new Map(expandSculptParts(recipe).map((part) => [part.id, part]));

/** The mesh's local box, from its vertices: an InstancedMesh's covers every instance's. */
function localBox(mesh) {
	if (!mesh.isInstancedMesh) {
		mesh.geometry.computeBoundingBox();
		return mesh.geometry.boundingBox;
	}
	const box = new THREE.Box3(), matrix = new THREE.Matrix4(), vertex = new THREE.Vector3();
	const position = mesh.geometry.getAttribute("position");
	for (let i = 0; i < mesh.count; i += 1) {
		mesh.getMatrixAt(i, matrix);
		for (let v = 0; v < position.count; v += 1) box.expandByPoint(vertex.fromBufferAttribute(position, v).applyMatrix4(matrix));
	}
	return box;
}
function assertInside(box, part, label) {
	for (const [axis, key] of ["x", "y", "z"].entries()) {
		const half = part.size[axis] / 2;
		assert.ok(box.min[key] >= -half - 1e-6 && box.max[key] <= half + 1e-6, `${label} ${key}: ${box.min[key]}..${box.max[key]} vs ±${half}`);
	}
}
function assertFinite(array, label) {
	for (let i = 0; i < array.length; i += 1) assert.ok(Number.isFinite(array[i]), `${label}[${i}] is ${array[i]}`);
}
/** Edges (by rounded position) used by an odd number of triangles: a crack or an open seam. */
function openEdges(geometry) {
	const position = geometry.getAttribute("position");
	const key = (i) => [position.getX(i), position.getY(i), position.getZ(i)].map((value) => Math.round(value * 1e5)).join(",");
	const counts = new Map();
	const triangles = geometry.index ? geometry.index.count / 3 : position.count / 3;
	const vertex = (i) => (geometry.index ? geometry.index.getX(i) : i);
	for (let t = 0; t < triangles; t += 1) {
		const keys = [0, 1, 2].map((corner) => key(vertex(3 * t + corner)));
		for (let e = 0; e < 3; e += 1) {
			const [a, b] = [keys[e], keys[(e + 1) % 3]].sort();
			if (a === b) continue;
			counts.set(`${a}|${b}`, (counts.get(`${a}|${b}`) ?? 0) + 1);
		}
	}
	return [...counts.values()].filter((count) => count % 2 === 1).length;
}

/* ------------------------------------------------------------- detail ---- */

await check("detail is read with defaults, and a second normalize changes nothing", () => {
	const recipe = accepted({ parts: [blob("cloud", { detail: { amount: 0.6 } }), blob("rock", { detail: { amount: 1, scale: 7, seed: 42 } })] });
	assert.deepEqual(recipe.parts[0].detail, { amount: 0.6, scale: 4, seed: 0 });
	assert.deepEqual(recipe.parts[1].detail, { amount: 1, scale: 7, seed: 42 });
	assert.deepEqual(accepted(recipe), recipe);
	assert.equal(one(blob("smooth")).detail, undefined, "no detail unless asked");
});

await check("bad detail is refused with the field's path, never clamped", () => {
	refused({ parts: [blob("a", { detail: 0.5 })] }, "parts[a].detail", /must be an object/);
	refused({ parts: [blob("a", { detail: { scale: 3 } })] }, "parts[a].detail.amount", /required/);
	refused({ parts: [blob("a", { detail: { amount: 1.5 } })] }, "parts[a].detail.amount", /0 to 1/);
	// a scale outside 1..12 is the one slip read as meant (clamped): a refusal costs the model the recipe again (verify-sculpt-forgive.mjs)
	refused({ parts: [blob("a", { detail: { amount: 0.5, scale: "big" } })] }, "parts[a].detail.scale");
	refused({ parts: [blob("a", { detail: { amount: 0.5, seed: 1.5 } })] }, "parts[a].detail.seed", /whole number/);
	refused({ parts: [blob("a", { detail: { amount: 0.5, bumps: 3 } })] }, "parts[a].detail.bumps", /unknown key/);
	refused({ parts: [scatter("g", { detail: { amount: 0.5 } })] }, "parts[g].detail", /scatter/);
});

await check("detail lumps every shape and keeps it inside its declared size", () => {
	const shapes = [
		blob("b", { roundness: 0.3, taper: 0.4 }),
		{ id: "x", shape: "box", size: [0.6, 0.4, 0.3], roundness: 0 },
		{ id: "xr", shape: "box", size: [0.6, 0.4, 0.3], roundness: 0.5 },
		{ id: "c", shape: "cylinder", size: [0.5, 1, 0.4], taper: 1 },
		{ id: "t", shape: "torus", size: [0.6, 0.4, 0.12] },
		{ id: "f", shape: "frame", size: [0.6, 0.4, 0.1], border: 0.08 },
	];
	for (const raw of shapes) {
		for (const detail of [{ amount: 1 }, { amount: 1, scale: 12, seed: 9 }, { amount: 0.3, scale: 1 }]) {
			const part = one({ ...raw, detail });
			const plain = sculptPartGeometry(one(raw));
			const geometry = sculptPartGeometry(part);
			assertInside((geometry.computeBoundingBox(), geometry.boundingBox), part, `${raw.id} ${JSON.stringify(detail)}`);
			assertFinite(geometry.getAttribute("position").array, `${raw.id} position`);
			assertFinite(geometry.getAttribute("normal").array, `${raw.id} normal`);
			assert.ok(geometry.getAttribute("position").count >= plain.getAttribute("position").count, `${raw.id} is not coarser than the plain shape`);
		}
	}
});

await check("a low-poly box is tessellated so the bumps show", () => {
	const raw = { id: "x", shape: "box", size: [0.6, 0.4, 0.3], roundness: 0 };
	const plain = sculptPartGeometry(one(raw));
	const lumpy = sculptPartGeometry(one({ ...raw, detail: { amount: 1 } }));
	assert.ok(lumpy.getAttribute("position").count > 50 * plain.getAttribute("position").count, `${lumpy.getAttribute("position").count} vertices`);
	// A face that was flat is no longer: depths below the top face spread out.
	const position = lumpy.getAttribute("position");
	const tops = [];
	for (let i = 0; i < position.count; i += 1) if (Math.abs(position.getX(i)) < 0.2 && Math.abs(position.getZ(i)) < 0.1 && position.getY(i) > 0) tops.push(position.getY(i));
	assert.ok(Math.max(...tops) - Math.min(...tops) > 0.02, `top face relief ${Math.max(...tops) - Math.min(...tops)}`);
	assert.ok(position.count / 3 <= 40000, "stays within the triangle budget");
});

await check("amount 0 draws the plain shape", () => {
	const plain = sculptPartGeometry(one(blob("a")));
	const zero = sculptPartGeometry(one(blob("a", { detail: { amount: 0 } })));
	assert.deepEqual(Array.from(zero.getAttribute("position").array), Array.from(plain.getAttribute("position").array));
});

await check("seams stay welded: a detailed surface has no open edge", () => {
	for (const raw of [blob("b"), { id: "x", shape: "box", size: [0.6, 0.4, 0.3] }, { id: "c", shape: "cylinder", size: [0.5, 1, 0.4] }, { id: "t", shape: "torus", size: [0.6, 0.6, 0.15] }]) {
		const before = openEdges(sculptPartGeometry(one(raw)));
		const after = openEdges(sculptPartGeometry(one({ ...raw, detail: { amount: 1, scale: 6 } })));
		assert.equal(after, before, `${raw.id}: ${before} open edges before detail, ${after} after`);
		assert.equal(after, 0, `${raw.id} is closed`);
	}
});

await check("the same recipe draws the same lumps; another seed draws others", () => {
	const positions = (detail) => Array.from(sculptPartGeometry(one(blob("cloud", { detail }))).getAttribute("position").array);
	assert.deepEqual(positions({ amount: 0.8 }), positions({ amount: 0.8 }));
	assert.notDeepEqual(positions({ amount: 0.8 }), positions({ amount: 0.8, seed: 1 }));
});

await check("a mirrored detailed part is its source's reflection", () => {
	const recipe = accepted({ parts: [blob("ear", { position: [0.5, 0, 0], detail: { amount: 1 }, mirror: true }), blob("other", { detail: { amount: 1 } })] });
	const group = buildSculptGroup(recipe);
	const [source, copy, other] = group.children;
	/** Distance from the part's centre to its surface along `direction` (local frame). */
	const radius = (mesh, direction) => {
		const probe = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
		const hits = new THREE.Raycaster(new THREE.Vector3(), direction).intersectObject(probe);
		return hits.at(-1).distance;
	};
	const random = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
	let mirrored = 0, unrelated = 0;
	for (let i = 0; i < 60; i += 1) {
		const direction = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize();
		const own = radius(source, direction);
		mirrored += Math.abs(radius(copy, new THREE.Vector3(-direction.x, direction.y, direction.z)) - own);
		unrelated += Math.abs(radius(other, direction) - own);
	}
	// Both copies triangulate the reflected surface their own way, so they agree closely, not bit for bit.
	assert.ok(mirrored / 60 < 4e-3, `the copy's surface is the reflected source's (mean gap ${mirrored / 60} m)`);
	assert.ok(unrelated > 5 * mirrored, `another part lumps differently (${unrelated / 60} vs ${mirrored / 60} m)`);
	disposeSculptGroup(group);
});

/* ----------------------------------------------------------- gradient ---- */

await check("gradient is read with defaults and refused when bad", () => {
	assert.deepEqual(one(blob("a", { gradient: { color: "#fff" } })).gradient, { color: "#ffffff", axis: "y", from: 0, to: 1 });
	assert.deepEqual(one(blob("a", { gradient: { color: "#FF8800", axis: "x", from: 0.2, to: 0.9 } })).gradient, { color: "#ff8800", axis: "x", from: 0.2, to: 0.9 });
	refused({ parts: [blob("a", { gradient: "#ffffff" })] }, "parts[a].gradient");
	refused({ parts: [blob("a", { gradient: { axis: "y" } })] }, "parts[a].gradient.color", /required/);
	refused({ parts: [blob("a", { gradient: { color: "blue" } })] }, "parts[a].gradient.color", /#rgb/);
	refused({ parts: [blob("a", { gradient: { color: "#fff", axis: "w" } })] }, "parts[a].gradient.axis", /y, x, z/);
	refused({ parts: [blob("a", { gradient: { color: "#fff", to: 2 } })] }, "parts[a].gradient.to");
});

await check("gradient colours run from the part colour at the bottom to the gradient colour at the top", () => {
	const recipe = accepted({ parts: [blob("cloud", { color: "#ffffff", gradient: { color: "#4060c0" }, detail: { amount: 0.5 } })] });
	const group = buildSculptGroup(recipe);
	const [mesh] = group.children;
	assert.equal(mesh.material.vertexColors, true);
	assert.equal(mesh.material.color.getHexString(), "ffffff", "the colour lives in the vertices");
	const position = mesh.geometry.getAttribute("position"), colour = mesh.geometry.getAttribute("color");
	let bottom = 0, top = 0;
	for (let i = 0; i < position.count; i += 1) {
		if (position.getY(i) < position.getY(bottom)) bottom = i;
		if (position.getY(i) > position.getY(top)) top = i;
	}
	const at = (i) => new THREE.Color(colour.getX(i), colour.getY(i), colour.getZ(i));
	const near = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 0.08;
	assert.ok(near(at(bottom), new THREE.Color("#ffffff")), `bottom ${at(bottom).getHexString()}`);
	assert.ok(near(at(top), new THREE.Color("#4060c0")), `top ${at(top).getHexString()}`);
	disposeSculptGroup(group);
});

await check("a flat display mode (materialFor) ignores gradients and scatter tints", () => {
	const recipe = accepted({ parts: [blob("a", { gradient: { color: "#000000" } }), scatter("g")] });
	const group = buildSculptGroup(recipe, { materialFor: () => new THREE.MeshStandardMaterial({ color: "#ff0000" }) });
	const [shaded, field] = group.children;
	assert.equal(shaded.geometry.getAttribute("color"), undefined);
	assert.equal(shaded.material.vertexColors, false);
	assert.equal(field.instanceColor, null);
	assert.equal(field.material.vertexColors, false);
	assert.equal(field.material.color.getHexString(), "ff0000");
	disposeSculptGroup(group);
});

/* ------------------------------------------------------------ scatter ---- */

await check("scatter is read with defaults; its keys belong to it alone", () => {
	assert.deepEqual(one(scatter("g")), { id: "g", shape: "scatter", size: [1, 0.3, 1], position: [0, 0, 0], rotation: [0, 0, 0], color: "#c2c6c8", item: "blade", count: 200, seed: 0, spread: "ground" });
	refused({ parts: [scatter("g", { item: "rock" })] }, "parts[g].item", /blade, tuft/);
	refused({ parts: [scatter("g", { item: undefined })] }, "parts[g].item");
	refused({ parts: [scatter("g", { count: 0 })] }, "parts[g].count", /1 to 4000/);
	refused({ parts: [scatter("g", { count: 4001 })] }, "parts[g].count");
	refused({ parts: [scatter("g", { count: 2.5 })] }, "parts[g].count");
	refused({ parts: [scatter("g", { spread: "sky" })] }, "parts[g].spread");
	refused({ parts: [scatter("g", { roundness: 0.5 })] }, "parts[g].roundness", /does not apply to a scatter/);
	refused({ parts: [blob("a", { count: 10 })] }, "parts[a].count", /does not apply to a blob/);
});

await check("a scatter counts as one part, and the recipe's items are capped", () => {
	const recipe = accepted({ parts: [scatter("a", { count: 4000 }), scatter("b", { count: 4000 }), scatter("c", { count: 4000 })] });
	assert.equal(expandSculptParts(recipe).length, 3);
	refused({ parts: [scatter("a", { count: 4000 }), scatter("b", { count: 4000 }), scatter("c", { count: 4000 }), scatter("d", { count: 1 })] }, "recipe.parts", /12001 items.*12000/);
	refused({ parts: [scatter("a", { count: 3000, position: [1, 0, 0], mirror: true }), scatter("b", { count: 4000 }), scatter("c", { count: 2001 })] }, "recipe.parts", /12001 items with mirrors/);
	assert.equal(SCULPT_LIMITS.maxScatterItems, 12000);
});

await check("every item, on the ground and on a shell, stays inside the size box", () => {
	for (const spread of ["ground", "shell"]) {
		for (const item of SCATTER_ITEMS) {
			for (const size of [[1.2, 0.3, 0.8], [0.2, 1.5, 0.2], [2, 0.05, 2]]) {
				const recipe = accepted({ parts: [scatter("s", { item, spread, size, count: 400, position: [0.6, 0, 0], rotation: [0, 30, 0], mirror: true })] });
				const group = buildSculptGroup(recipe);
				const parts = drawn(recipe);
				for (const mesh of group.children) {
					assert.ok(mesh.isInstancedMesh && mesh.count === 400, `${mesh.name} is one InstancedMesh of 400`);
					assertInside(localBox(mesh), parts.get(mesh.name), `${spread} ${item} ${size} ${mesh.name}`);
					assertInside(mesh.boundingBox, parts.get(mesh.name), `${spread} ${item} ${size} ${mesh.name} (the box three reads)`);
					assert.ok(mesh.boundingBox.containsBox(localBox(mesh).expandByScalar(-1e-6)), `${mesh.name}: three's box holds every item`);
					assertFinite(mesh.instanceMatrix.array, `${spread} ${item} matrices`);
				}
				disposeSculptGroup(group);
			}
		}
	}
});

await check("ground items stand on the bottom face and spread across the footprint", () => {
	const part = one(scatter("g", { count: 1000, size: [2, 0.3, 1] }));
	const group = buildSculptGroup(accepted({ parts: [part] }));
	const [mesh] = group.children;
	const matrix = new THREE.Matrix4(), at = new THREE.Vector3();
	const cells = new Set();
	assert.ok(Math.abs(localBox(mesh).min.y + 0.15) < 1e-6, "the lowest item touches the bottom face");
	for (let i = 0; i < mesh.count; i += 1) {
		at.setFromMatrixPosition(mesh.getMatrixAt(i, matrix));
		assert.ok(at.y < -0.145, `item ${i} roots at ${at.y}`);
		cells.add(`${Math.floor((at.x + 1) * 5)},${Math.floor((at.z + 0.5) * 5)}`);
	}
	assert.equal(cells.size, 50, `items reach all 10×5 cells, got ${cells.size}`);
	disposeSculptGroup(group);
});

await check("a scatter is deterministic, its seed reshuffles it, and its mirror is a reflection", () => {
	const matrices = (extra) => {
		const group = buildSculptGroup(accepted({ parts: [scatter("g", { spread: "shell", ...extra })] }));
		const array = Array.from(group.children[0].instanceMatrix.array);
		disposeSculptGroup(group);
		return array;
	};
	assert.deepEqual(matrices({}), matrices({}));
	assert.notDeepEqual(matrices({}), matrices({ seed: 3 }));
	const group = buildSculptGroup(accepted({ parts: [scatter("g", { item: "leaf", spread: "shell", position: [0.8, 0, 0], mirror: true })] }));
	const [source, copy] = group.children;
	const a = new THREE.Matrix4(), b = new THREE.Matrix4(), pa = new THREE.Vector3(), pb = new THREE.Vector3();
	for (let i = 0; i < source.count; i += 1) {
		pa.setFromMatrixPosition(source.getMatrixAt(i, a));
		pb.setFromMatrixPosition(copy.getMatrixAt(i, b));
		assert.ok(Math.abs(pa.x + pb.x) < 1e-6 && Math.abs(pa.y - pb.y) < 1e-6 && Math.abs(pa.z - pb.z) < 1e-6, `item ${i}`);
		assert.ok(Math.abs(a.determinant() - b.determinant()) < 1e-9 && b.determinant() > 0, "a turn, never a negative scale");
	}
	disposeSculptGroup(group);
});

await check("a scatter keeps its part name, shadows, per-item colour, raycast and disposal", () => {
	const group = buildSculptGroup(accepted({ parts: [scatter("grass", { color: "#4a8a3a", count: 600, size: [1, 0.4, 1] })] }));
	const [mesh] = group.children;
	assert.equal(mesh.name, "grass");
	assert.equal(mesh.userData.sculptPart, "grass");
	assert.ok(mesh.castShadow && mesh.receiveShadow);
	assert.equal(mesh.material.vertexColors, true, "the item's foot shading");
	const colours = new Set();
	const colour = new THREE.Color();
	for (let i = 0; i < mesh.count; i += 1) colours.add(mesh.getColorAt(i, colour).getHexString());
	assert.ok(colours.size > 100, `${colours.size} distinct item colours`);
	group.updateMatrixWorld(true);
	const hits = new THREE.Raycaster(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, -1, 0)).intersectObject(group, true);
	const sideways = new THREE.Raycaster(new THREE.Vector3(-2, -0.15, 0.05), new THREE.Vector3(1, 0, 0)).intersectObject(group, true);
	assert.ok(hits.length + sideways.length > 0 && [...hits, ...sideways].every((hit) => hit.object === mesh && hit.instanceId !== undefined), "a pick lands on an item");
	let disposed = false;
	mesh.addEventListener("dispose", () => { disposed = true; });
	disposeSculptGroup(group);
	assert.ok(disposed, "the InstancedMesh's buffers are freed");
});

await check("the compare hulls a ground scatter's box and a shell scatter's ellipsoid", () => {
	const recipe = accepted({ parts: [scatter("g", { size: [2, 0.2, 1] }), scatter("crown", { item: "leaf", spread: "shell", size: [1, 1, 1], position: [0, 1, 0] })] });
	const polygons = sculptViewPolygons(recipe);
	const width = (id) => {
		const xs = polygons.filter((entry) => entry.id === id).flatMap((entry) => entry.polygon.map(([x]) => x));
		return Math.max(...xs) - Math.min(...xs);
	};
	assert.ok(Math.abs(width("g") - 2) < 1e-6, `ground width ${width("g")}`);
	assert.ok(Math.abs(width("crown") - 1) < 0.01, `shell width ${width("crown")}`);
});

/* -------------------------------------------------------------- edits ---- */

await check("edits set and clear the new fields; a new shape drops scatter's keys", () => {
	const recipe = accepted({ parts: [blob("a"), scatter("g")] });
	const set = patchSculptRecipe(recipe, [{ set: "a", detail: { amount: 0.4 }, gradient: { color: "#ffeecc" } }]);
	assert.equal(set.ok, true, set.error);
	assert.equal(set.recipe.parts[0].detail.amount, 0.4);
	const cleared = patchSculptRecipe(set.recipe, [{ set: "a", detail: null, gradient: null }]);
	assert.equal(cleared.ok, true, cleared.error);
	assert.equal(cleared.recipe.parts[0].detail, undefined);
	assert.equal(cleared.recipe.parts[0].gradient, undefined);
	const reshaped = patchSculptRecipe(recipe, [{ set: "g", shape: "blob" }]);
	assert.equal(reshaped.ok, true, reshaped.error);
	for (const key of ["item", "count", "seed", "spread"]) assert.equal(reshaped.recipe.parts[1][key], undefined, key);
});

if (failures) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nverify-sculpt-detail: all checks passed");
