#!/usr/bin/env node
/**
 * Write tiny glTF 2.0 binary cubes for the mesh-import tests.
 *
 * Each cube sits on y = 0, centred on XZ. Positions carry accessor min/max
 * so Node can measure the box without three.js. A red PBR material is on the
 * mesh so the clay-clone path has something to replace.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function cubeGeometry(height) {
	const h = Number(height);
	const half = h / 2;
	const positions = new Float32Array([
		-half, 0, -half,
		half, 0, -half,
		half, 0, half,
		-half, 0, half,
		-half, h, -half,
		half, h, -half,
		half, h, half,
		-half, h, half,
	]);
	const indices = new Uint16Array([
		0, 1, 2, 0, 2, 3,
		4, 6, 5, 4, 7, 6,
		0, 4, 5, 0, 5, 1,
		1, 5, 6, 1, 6, 2,
		2, 6, 7, 2, 7, 3,
		3, 7, 4, 3, 4, 0,
	]);
	return {
		positions,
		indices,
		min: [-half, 0, -half],
		max: [half, h, half],
	};
}

function padTo4(bytes, fill) {
	const padding = (4 - (bytes.length % 4)) % 4;
	if (!padding) return bytes;
	const out = new Uint8Array(bytes.length + padding);
	out.set(bytes);
	if (fill) out.fill(fill, bytes.length);
	return out;
}

function writeGlb(geometry) {
	const positionBytes = new Uint8Array(geometry.positions.buffer.slice(0));
	const indexBytes = new Uint8Array(geometry.indices.buffer.slice(0));
	const bin = new Uint8Array(positionBytes.byteLength + indexBytes.byteLength);
	bin.set(positionBytes, 0);
	bin.set(indexBytes, positionBytes.byteLength);
	const json = {
		asset: { version: "2.0", generator: "CozyClay test cube" },
		scene: 0,
		scenes: [{ nodes: [0] }],
		nodes: [{ mesh: 0 }],
		meshes: [{
			primitives: [{
				attributes: { POSITION: 0 },
				indices: 1,
				material: 0,
			}],
		}],
		materials: [{
			name: "Cube",
			pbrMetallicRoughness: {
				baseColorFactor: [0.8, 0.22, 0.14, 1],
				metallicFactor: 0,
				roughnessFactor: 0.85,
			},
		}],
		accessors: [
			{
				bufferView: 0,
				componentType: 5126,
				count: 8,
				type: "VEC3",
				min: geometry.min,
				max: geometry.max,
			},
			{
				bufferView: 1,
				componentType: 5123,
				count: geometry.indices.length,
				type: "SCALAR",
			},
		],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: positionBytes.byteLength },
			{ buffer: 0, byteOffset: positionBytes.byteLength, byteLength: indexBytes.byteLength },
		],
		buffers: [{ byteLength: bin.byteLength }],
	};
	const jsonBytes = padTo4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
	const binBytes = padTo4(bin, 0);
	const total = 12 + 8 + jsonBytes.byteLength + 8 + binBytes.byteLength;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, MAGIC, true);
	view.setUint32(4, 2, true);
	view.setUint32(8, total, true);
	view.setUint32(12, jsonBytes.byteLength, true);
	view.setUint32(16, JSON_CHUNK, true);
	out.set(jsonBytes, 20);
	const binHeader = 20 + jsonBytes.byteLength;
	view.setUint32(binHeader, binBytes.byteLength, true);
	view.setUint32(binHeader + 4, BIN_CHUNK, true);
	out.set(binBytes, binHeader + 8);
	return out;
}

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });

const cubes = [
	["unit-cube.glb", 1],
	["giant-cube.glb", 50],
	["tiny-cube.glb", 0.01],
];

for (const [name, height] of cubes) {
	const bytes = writeGlb(cubeGeometry(height));
	writeFileSync(join(here, name), bytes);
	console.log(`wrote ${name} (${bytes.byteLength} bytes, height ${height} m)`);
}
