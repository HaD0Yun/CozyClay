#!/usr/bin/env node
/**
 * Write tiny Wavefront OBJ cubes for the mesh-import tests.
 *
 * Same standing box as write-cube-glb.mjs: sits on y = 0, centred on XZ,
 * so parseObjBounds and the GLB POSITION box agree. No mtllib — v1 stores
 * the geometry file alone.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function cubeObj(height) {
	const h = Number(height);
	const half = h / 2;
	const vertices = [
		[-half, 0, -half],
		[half, 0, -half],
		[half, 0, half],
		[-half, 0, half],
		[-half, h, -half],
		[half, h, -half],
		[half, h, half],
		[-half, h, half],
	];
	const faces = [
		[1, 2, 3], [1, 3, 4],
		[5, 7, 6], [5, 8, 7],
		[1, 5, 6], [1, 6, 2],
		[2, 6, 7], [2, 7, 3],
		[3, 7, 8], [3, 8, 4],
		[4, 8, 5], [4, 5, 1],
	];
	const lines = [`# CozyClay test cube height ${h} m`, "o Cube"];
	for (const [x, y, z] of vertices) lines.push(`v ${x} ${y} ${z}`);
	for (const face of faces) lines.push(`f ${face.join(" ")}`);
	return `${lines.join("\n")}\n`;
}

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });

const cubes = [
	["unit-cube.obj", 1],
	["giant-cube.obj", 50],
	["tiny-cube.obj", 0.01],
];

for (const [name, height] of cubes) {
	const text = cubeObj(height);
	writeFileSync(join(here, name), text);
	console.log(`wrote ${name} (${Buffer.byteLength(text)} bytes, height ${height} m)`);
}
