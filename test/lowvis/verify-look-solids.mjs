#!/usr/bin/env node
// The solids the inside measure reads (src/lowvis/looks/solids.js, no three.js) are the solids of the looks as drawn
// (parts.js solidsOf over block.js and cube.js, three's convex hull): the same looks, the same solids per joint in the
// same order, the same corners, triangles, normals, edges and boxes, number for number. A change to a look's shape
// fails here until drawn-solids.js is written again from the looks: node test/lowvis/verify-look-solids.mjs --write
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { blockSolids } from "../../src/lowvis/looks/block.js";
import { cubeSolids } from "../../src/lowvis/looks/cube.js";

const DRAWN = { block: blockSolids, cube: cubeSolids };
const FILE = new URL("../../src/lowvis/looks/drawn-solids.js", import.meta.url);

if (process.argv.includes("--write")) {
	const num = x => (Object.is(x, -0) ? "-0" : String(x)), list = (a, f) => `[${a.map(f).join(",")}]`;
	const row = ({ joint, v, t }) => `\t\t{ joint: ${joint}, v: ${list(v, p => list(p, num))}, t: ${list(t, tri => list(tri, String))} },`;
	const looks = Object.entries(DRAWN).map(([look, solids]) => `\t${look}: [\n${solids().map(row).join("\n")}\n\t],`);
	writeFileSync(FILE, `// Written by node test/lowvis/verify-look-solids.mjs --write from the looks as drawn (parts.js solidsOf): per look, each\n// solid's rig joint, corners (metres from the joint at rest) and triangles (corner indices). solids.js reads it.\nexport const DRAWN = {\n${looks.join("\n")}\n};\n`);
	console.log(`wrote ${FILE.pathname}`);
}

const { LOOK_SOLIDS } = await import("../../src/lowvis/looks/solids.js");
assert.deepEqual(Object.keys(LOOK_SOLIDS).sort(), Object.keys(DRAWN).sort(), "solids.js keeps the looks that state solids");
for (const [look, drawn] of Object.entries(DRAWN)) {
	const want = drawn(), got = LOOK_SOLIDS[look]();
	assert.equal(got.length, want.length, `${look}: solid count`);
	const perJoint = s => s.reduce((m, o) => ({ ...m, [o.joint]: (m[o.joint] ?? 0) + 1 }), {});
	assert.deepStrictEqual(perJoint(got), perJoint(want), `${look}: solids per joint`);
	want.forEach((w, i) => assert.deepStrictEqual(got[i], w, `${look}: solid ${i} (joint ${w.joint}) differs from the look as drawn; run with --write`));
	console.log(`ok ${look}: ${got.length} solids, ${got.reduce((n, o) => n + o.v.length, 0)} corners, ${got.reduce((n, o) => n + o.n.length, 0)} normals, equal to the look as drawn`);
}
console.log("verify-look-solids: ok");
