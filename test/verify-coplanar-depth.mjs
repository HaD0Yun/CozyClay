#!/usr/bin/env node
// Coplanar-face depth ranks: parts of an assembly whose same-facing faces lie
// in one plane (hood top / grille top) would z-fight as the camera moves; the
// renderer pulls the later part toward the camera by its rank.
import assert from "node:assert/strict";
import { MAX_DEPTH_RANK, coplanarDepthRanks } from "../src/coplanar-depth.js";

let failures = 0;
function check(name, fn) {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name} — ${error.message}`);
	}
}

const cube = (id, x, y, z, sx = 1, sy = 1, sz = 1, extra = {}) => ({ id, renderer: "cube", x, y, z, rot: 0, scaleX: sx, scaleY: sy, scaleZ: sz, ...extra });
const rankOf = (objects, id) => coplanarDepthRanks(objects).get(id) ?? 0;

check("coplanar overlapping tops: later object ranks 1, earlier 0", () => {
	const objects = [cube("a", 0, 0, 0), cube("b", 0.5, 0, 0, 1, 1, 0.5)];
	assert.equal(rankOf(objects, "a"), 0);
	assert.equal(rankOf(objects, "b"), 1);
	// creation order decides, not size or position
	assert.equal(rankOf([objects[1], objects[0]], "a"), 1);
	assert.equal(rankOf([objects[1], objects[0]], "b"), 0);
});

check("stacked touching cubes (opposite faces) get no rank", () => {
	assert.equal(coplanarDepthRanks([cube("a", 0, 0, 0), cube("b", 0, 1, 0)]).size, 0);
});

// A 24-bit depth buffer cannot tell faces 1-6 mm apart at the 100 m far plane: those fight too, and the face in
// front along the normal wins, whichever was made first. Past that gap the depth test orders them itself.
check("3 mm apart: the face in front ranks, made first or last", () => {
	assert.equal(rankOf([cube("a", 0, 0, 0), cube("b", 0.5, 0.503, 0, 1, 0.5, 0.5)], "b"), 1);
	assert.equal(rankOf([cube("b", 0.5, 0.503, 0, 1, 0.5, 0.5), cube("a", 0, 0, 0)], "b"), 1);
	assert.equal(rankOf([cube("b", 0.5, 0.503, 0, 1, 0.5, 0.5), cube("a", 0, 0, 0)], "a"), 0);
});

check("8 mm apart: no rank", () => {
	assert.equal(coplanarDepthRanks([cube("a", 0, 0, 0), cube("b", 0.5, 0.508, 0, 1, 0.5, 0.5)]).size, 0);
});

check("stacked planes 2-5 mm apart (ground, road, lines): the upper one wins, by height not by order", () => {
	const plane = (id, y, sx, sz) => ({ id, renderer: "plane", x: 0, y, z: 0, rot: 0, scaleX: sx, scaleY: 1, scaleZ: sz });
	const ground = plane("ground", 0, 20, 20), road = plane("road", 0.002, 3, 20), line = plane("line", 0.005, 0.1, 18);
	for (const order of [[ground, road, line], [line, road, ground], [road, line, ground]]) {
		const ranks = coplanarDepthRanks(order);
		assert.deepEqual([ranks.get("ground") ?? 0, ranks.get("road") ?? 0, ranks.get("line") ?? 0], [0, 1, 2], order.map((o) => o.id).join(","));
	}
});

check("double-sided planes a gap apart rank only where no camera can stand on the other side", () => {
	const sheet = (id, y, s) => ({ id, renderer: "plane", x: 0, y, z: 0, rot: 0, scaleX: s, scaleY: 1, scaleZ: s });
	// in the air (a canopy and a panel 3 mm under it, seen from below as well): no rank, from either order
	assert.equal(coplanarDepthRanks([sheet("lower", 2.2, 2), sheet("upper", 2.203, 1)]).size, 0);
	assert.equal(coplanarDepthRanks([sheet("upper", 2.203, 1), sheet("lower", 2.2, 2)]).size, 0);
	// the same two at the floor, under every lens: the upper one ranks
	assert.equal(rankOf([sheet("upper", 0.003, 1), sheet("lower", 0, 2)], "upper"), 1);
	assert.equal(rankOf([sheet("upper", 0.003, 1), sheet("lower", 0, 2)], "lower"), 0);
	// up to the lowest lens (0.1 m; a plane sits 4 mm above its y), not above it
	assert.equal(rankOf([sheet("upper", 0.093, 1), sheet("lower", 0.09, 2)], "upper"), 1);
	assert.equal(coplanarDepthRanks([sheet("upper", 0.103, 1), sheet("lower", 0.1, 2)]).size, 0);
	// upright sheets: no side is up, no rank
	const upright = (id, z, s, turn = 90) => ({ id, renderer: "plane", x: 0, y: 1.5, z, rot: 0, rotX: turn, scaleX: s, scaleY: 1, scaleZ: s });
	for (const turn of [90, -90, 270]) {
		assert.equal(coplanarDepthRanks([upright("back", 0, 2, turn), upright("front", 0.003, 0.5, turn)]).size, 0, `turn ${turn}`);
		assert.equal(coplanarDepthRanks([upright("front", 0.003, 0.5, turn), upright("back", 0, 2, turn)]).size, 0, `turn ${turn}, front made first`);
	}
	// a ramp at the floor can be seen from under its high end: no rank
	const ramp = (id, lift, s) => ({ id, renderer: "plane", x: 0, y: Math.cos(Math.PI / 6) * lift, z: Math.sin(Math.PI / 6) * lift, rot: 0, rotX: 30, scaleX: s, scaleY: 1, scaleZ: s });
	assert.equal(coplanarDepthRanks([ramp("upper", 0.003, 1), ramp("lower", 0, 3)]).size, 0);
	// in one plane they still rank by order, as ever, wherever they are
	assert.equal(rankOf([upright("back", 0, 2), upright("front", 0, 0.5)], "front"), 1);
	assert.equal(rankOf([sheet("lower", 2.2, 2), sheet("upper", 2.2, 1)], "upper"), 1);
});

check("a face with one near neighbour only (a sheet on a box, a decal on a wall) ranks at any height, from either order", () => {
	const table = { id: "table", renderer: "cube", x: 0, y: 0, z: 0, rot: 0, scaleX: 2, scaleY: 0.8, scaleZ: 1 };
	const paper = { id: "paper", renderer: "plane", x: 0, y: 0.8, z: 0, rot: 0, scaleX: 0.15, scaleY: 1, scaleZ: 0.1 }; // a plane sits 4 mm above its y
	assert.equal(rankOf([table, paper], "paper"), 1);
	assert.equal(rankOf([paper, table], "paper"), 1);
	assert.equal(rankOf([paper, table], "table"), 0);
	const wall = { id: "wall", renderer: "cube", x: 0, y: 0, z: 0, rot: 0, scaleX: 4, scaleY: 3, scaleZ: 0.2 };
	const decal = { id: "decal", renderer: "plane", x: 0, y: 1.5, z: 0.1 - 0.004 + 0.003, rot: 0, rotX: 90, scaleX: 0.5, scaleY: 1, scaleZ: 0.5 };
	assert.equal(rankOf([wall, decal], "decal"), 1);
	assert.equal(rankOf([decal, wall], "decal"), 1);
	assert.equal(rankOf([decal, wall], "wall"), 0);
});

check("coplanar but side by side with a gap: no rank", () => {
	assert.equal(coplanarDepthRanks([cube("a", 0, 0, 0), cube("b", 1.2, 0, 0)]).size, 0);
});

check("coplanar tops touching along an edge only: no rank", () => {
	assert.equal(coplanarDepthRanks([cube("a", 0, 0, 0), cube("b", 1, 0, 0)]).size, 0);
});

check("sub-millimetre offset still conflicts", () => {
	assert.equal(rankOf([cube("a", 0, 0, 0), cube("b", 0.3, 0.0005, 0, 1, 1, 1)], "b"), 1);
});

check("rotY 90: coplanar front faces conflict", () => {
	// a's local -x face now points +z at z=1; b's +z face is at z=1 too
	const a = cube("a", 0, 0, 0, 2, 1, 1, { rot: 90 });
	const b = cube("b", 0, 0, 0.5);
	assert.equal(rankOf([a, b], "b"), 1);
	// a lower, thinner cube 5 mm in front of the plane wins over it; 8 mm in front, nothing
	assert.equal(rankOf([a, cube("c", 0, 0.2, 0.505, 0.5, 0.5, 1)], "c"), 1);
	assert.equal(coplanarDepthRanks([a, cube("c", 0, 0.2, 0.508, 0.5, 0.5, 1)]).size, 0);
});

check("rotY 45 top overlapping an axis-aligned top conflicts; far corner does not", () => {
	const a = cube("a", 0, 0, 0, 1, 1, 1, { rot: 45 });
	assert.equal(rankOf([a, cube("b", 0.4, 0, 0)], "b"), 1);
	// a's corner reaches x=0.707; a box starting at x=0.72 misses it
	assert.equal(coplanarDepthRanks([a, cube("c", 1.22, 0, 0)]).size, 0);
});

check("tilted faces are not coplanar with level ones", () => {
	assert.equal(coplanarDepthRanks([cube("a", 0, 0, 0), cube("b", 0, 0, 0, 1, 1, 1, { rotX: 5, rotZ: 5 })]).size, 0);
});

check("chain A < B < C coplanar ranks 0, 1, 2", () => {
	const objects = [cube("a", 0, 0, 0), cube("b", 0.1, 0, 0), cube("c", 0.2, 0, 0)];
	assert.deepEqual(["a", "b", "c"].map((id) => rankOf(objects, id)), [0, 1, 2]);
});

check("a later part over two unrelated earlier ones takes the deeper chain", () => {
	const objects = [cube("a", 0, 0, 0), cube("b", 0, 0, 0), cube("c", 0, 0, 0)];
	assert.equal(rankOf(objects, "c"), 2);
	const split = [cube("a", 0, 0, 0), cube("b", 5, 0, 0), cube("c", 0.2, 0, 0)];
	assert.equal(rankOf(split, "c"), 1);
});

check("rank is capped", () => {
	const objects = Array.from({ length: MAX_DEPTH_RANK + 5 }, (_, i) => cube(`o${i}`, i * 0.01, 0, 0));
	const ranks = coplanarDepthRanks(objects);
	assert.equal(Math.max(...ranks.values()), MAX_DEPTH_RANK);
	assert.equal(ranks.get(`o${objects.length - 1}`), MAX_DEPTH_RANK);
});

check("car: Hood and Grille share a top (y=1.05)", () => {
	const hood = { id: "hood", kind: "cube", x: -2.2, y: 0.6, z: 1.7, scaleX: 0.95, scaleY: 0.45, scaleZ: 1.3 };
	const grille = { id: "grille", kind: "cube", x: -2.2, y: 0.6, z: 2.37, scaleX: 0.75, scaleY: 0.45, scaleZ: 0.1 };
	assert.equal(rankOf([hood, grille], "grille"), 1);
	assert.equal(rankOf([hood, grille], "hood"), 0);
});

check("car: Hood and Headlight Bar share a front (z=2.35)", () => {
	const hood = { id: "hood", kind: "cube", x: -2.2, y: 0.6, z: 1.7, scaleX: 0.95, scaleY: 0.45, scaleZ: 1.3 };
	const bar = { id: "bar", kind: "cube", x: -2.2, y: 0.7, z: 2.3, scaleX: 1.2, scaleY: 0.1, scaleZ: 0.1 };
	assert.equal(rankOf([hood, bar], "bar"), 1);
});

check("cylinder caps and plane faces conflict with cube faces", () => {
	const base = cube("a", 0, 0, 0);
	const cyl = { id: "c", renderer: "cylinder", x: 0, y: 0, z: 0, rot: 0, scaleX: 0.5, scaleY: 1, scaleZ: 0.5 };
	assert.equal(rankOf([base, cyl], "c"), 1);
	const cone = { id: "k", renderer: "cone", x: 0.2, y: 0, z: 0, rot: 0, scaleX: 0.5, scaleY: 1, scaleZ: 0.5 };
	assert.equal(rankOf([base, cone], "k"), 1);
	const p1 = { id: "p1", renderer: "plane", x: 0, y: 0, z: 0, rot: 0, scaleX: 1, scaleY: 1, scaleZ: 1 };
	const p2 = { ...p1, id: "p2" };
	assert.equal(rankOf([p1, p2], "p2"), 1);
});

check("cube resting on a plane or a cube bottom on the floor is not a conflict", () => {
	const floor = { id: "f", renderer: "plane", x: 0, y: 0, z: 0, rot: 0, scaleX: 5, scaleY: 1, scaleZ: 5 };
	assert.equal(rankOf([floor, cube("a", 0, 0.5, 0, 1, 0.1, 1)], "a"), 0);
	assert.equal(coplanarDepthRanks([cube("a", 0, 0, 0), cube("b", 0, -1, 0)]).size, 0);
});

check("skipped: spheres, capsules, cutouts, meshes, attached, hidden, junk", () => {
	const base = cube("a", 0, 0, 0);
	for (const renderer of ["sphere", "capsule", "cutout", "mesh"]) {
		assert.equal(coplanarDepthRanks([base, { ...cube("b", 0, 0, 0), renderer }]).size, 0, renderer);
	}
	assert.equal(coplanarDepthRanks([base, cube("b", 0, 0, 0, 1, 1, 1, { attach: { characterId: "x", bone: null } })]).size, 0);
	assert.equal(coplanarDepthRanks([base, cube("b", 0, 0, 0, 1, 1, 1, { hidden: true })]).size, 0);
	assert.equal(coplanarDepthRanks([base, null, undefined, { id: "n" }, cube("b", NaN, 0, 0)]).size, 0);
	assert.equal(coplanarDepthRanks([]).size, 0);
	assert.equal(coplanarDepthRanks(null).size, 0);
});

check("a lone object and unrelated far objects get nothing", () => {
	assert.equal(coplanarDepthRanks([cube("a", 0, 0, 0)]).size, 0);
	assert.equal(coplanarDepthRanks([cube("a", 0, 0, 0), cube("b", 50, 3, -20)]).size, 0);
});

check("150 random objects rank in a few ms", () => {
	let seed = 7;
	const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
	const snap = (v) => Math.round(v * 4) / 4;
	const kinds = ["cube", "cube", "cube", "cylinder", "plane", "sphere"];
	const objects = Array.from({ length: 150 }, (_, i) => ({
		id: `r${i}`,
		renderer: kinds[Math.floor(rand() * kinds.length)],
		x: snap(rand() * 6), y: snap(rand() * 2), z: snap(rand() * 6),
		rot: Math.floor(rand() * 4) * 45, rotX: 0, rotZ: 0,
		scaleX: snap(0.5 + rand() * 2), scaleY: snap(0.5 + rand() * 2), scaleZ: snap(0.5 + rand() * 2),
	}));
	coplanarDepthRanks(objects); // warm up
	const start = performance.now();
	const runs = 20;
	let ranked = 0;
	for (let i = 0; i < runs; i += 1) ranked = coplanarDepthRanks(objects).size;
	const each = (performance.now() - start) / runs;
	console.log(`  ${each.toFixed(2)} ms per pass, ${ranked} of 150 ranked`);
	assert.ok(each < 10, `${each} ms`);
	assert.ok(ranked > 0, "snapped grid should produce conflicts");
});

if (failures > 0) {
	console.log(`\n${failures} failing`);
	process.exit(1);
}
console.log("\nall passing");
