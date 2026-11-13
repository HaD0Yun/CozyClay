#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { PART_COLOURS, paletteViolations, partForBone, applyPartColours } from "../src/part-colours.js";

assert.equal(PART_COLOURS.length, 14);
assert.deepEqual(paletteViolations(PART_COLOURS), []);
assert.equal(PART_COLOURS.find((entry) => entry.part === "torso").hex, "#FFFFFF");
const headHex = PART_COLOURS.find((entry) => entry.part === "head").hex;
assert.equal(headHex, "#8C8C8C");
const headChannels = headHex.slice(1).match(/../g).map((hex) => parseInt(hex, 16) / 255);
const headMax = Math.max(...headChannels);
const headMin = Math.min(...headChannels);
const headSaturation = headMax === 0 ? 0 : (headMax - headMin) / headMax;
assert.ok(headSaturation < 0.1, `head saturation ${headSaturation} should be neutral`);
assert.ok(headMax > 0.3, `head value ${headMax} should not be near-black`);
assert.ok(headMax < 0.8, `head value ${headMax} should not be near-white`);
for (const entry of PART_COLOURS.filter((part) => part.hue !== null)) {
	const channels = entry.hex.slice(1).match(/../g).map((hex) => parseInt(hex, 16));
	assert.equal(Math.min(...channels), 0, `${entry.part}: full saturation`);
	assert.equal(Math.max(...channels), 255, `${entry.part}: full value`);
}
// Exercise circular distance and each rejection, so an empty stub cannot pass.
assert.ok(paletteViolations([{ part: "leftHand", hue: 359 }, { part: "rightHand", hue: 1 }]).some((message) => message.includes("60 degrees")));
assert.ok(paletteViolations([{ part: "leftHand", hue: 359 }, { part: "leftFoot", hue: 1 }]).some((message) => message.includes("28 degrees")));
assert.ok(paletteViolations([{ part: "leftHand", hue: 20 }]).some((message) => message.includes("10-35")));
console.log("PASS palette constraints and fully saturated, full-value limb hexes");

// A minimal window so FBXLoader parses under Node; read the shipped
// assets themselves so a replacement rig cannot silently outgrow a fixture.
globalThis.window ??= {
	innerWidth: 1920,
	innerHeight: 1080,
	URL: { createObjectURL() { throw new Error("no embedded FBX textures under Node"); } },
};
for (const model of ["x-bot-tpose", "y-bot-tpose"]) {
	const buffer = readFileSync(new URL(`../public/models/${model}.fbx`, import.meta.url));
	const root = new FBXLoader().parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), "");
	const names = [];
	root.traverse((bone) => {
		if (bone.isBone) names.push(bone.name);
	});
	assert.ok(names.length > 0);
	for (const name of names) {
		const bare = name.replace(/^mixamorig:?/i, "");
		for (const spelling of [name, bare, `mixamorig:${bare}`]) {
			assert.ok(partForBone(spelling), `${model}: unassigned ${spelling}`);
		}
		if (/Hand/.test(name)) assert.equal(partForBone(name), /Left/.test(name) ? "leftHand" : "rightHand");
		if (/Toe/.test(name)) assert.equal(partForBone(name), /Left/.test(name) ? "leftFoot" : "rightFoot");
	}
	const parts = new Set(names.map(partForBone));
	assert.equal(parts.size, 14, `${model}: all fourteen parts`);
	for (const mode of ["flat", "shaded"]) {
		const clone = SkeletonUtils.clone(root);
		const originals = new Map();
		clone.traverse((mesh) => {
			if (mesh.isSkinnedMesh) originals.set(mesh, mesh.geometry);
		});
		assert.deepEqual(applyPartColours(clone, mode), []);
		for (const [mesh, original] of originals) {
			assert.notEqual(mesh.geometry, original, "cached FBX geometry stays shared only by grey instances");
			const colours = mesh.geometry.attributes.color;
			const { skinIndex, skinWeight } = original.attributes;
			assert.equal(colours.count, skinIndex.count);
			for (let vertex = 0; vertex < skinIndex.count; vertex += 1) {
				const weights = [skinWeight.getX(vertex), skinWeight.getY(vertex), skinWeight.getZ(vertex), skinWeight.getW(vertex)];
				const indices = [skinIndex.getX(vertex), skinIndex.getY(vertex), skinIndex.getZ(vertex), skinIndex.getW(vertex)];
				const bone = mesh.skeleton.bones[indices[weights.indexOf(Math.max(...weights))]];
				const expected = new THREE.Color(PART_COLOURS.find((entry) => entry.part === partForBone(bone.name)).hex);
				assert.ok(Math.abs(colours.getX(vertex) - expected.r) < 1e-6);
				assert.ok(Math.abs(colours.getY(vertex) - expected.g) < 1e-6);
				assert.ok(Math.abs(colours.getZ(vertex) - expected.b) < 1e-6);
			}
			assert.equal(!!mesh.material.isMeshBasicMaterial, mode === "flat");
			if (mode === "flat") assert.equal(mesh.material.toneMapped, false);
		}
	}
	console.log(`PASS ${model}: ${names.length} bones assigned; both modes match dominant weights at every vertex`);
}
assert.equal(partForBone("UnknownBone"), null);
console.log("all part-colour checks PASS");
