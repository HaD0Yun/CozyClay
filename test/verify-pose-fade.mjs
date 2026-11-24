import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { applyPoseFade, authoredOpacity, withPoseFadeLifted, POSE_FADE_DEFAULT, POSE_FADE_STORAGE_KEY, readPoseFadeOpacity, writePoseFadeOpacity } from "../src/pose-fade.js";

function prop() {
	const shared = new THREE.MeshStandardMaterial({ opacity: 1 });
	const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 });
	const root = new THREE.Group();
	const body = new THREE.Mesh(new THREE.BoxGeometry(), shared);
	const cab = new THREE.Mesh(new THREE.BoxGeometry(), shared);
	const window = new THREE.Mesh(new THREE.BoxGeometry(), glass);
	root.add(body, cab, window);
	return { root, shared, glass };
}

function hits(root) {
	const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1));
	return ray.intersectObject(root, true).length;
}

function memoryStorage() {
	const map = new Map();
	return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

test("posing fades every material once and stops pointer hits", () => {
	const { root, shared, glass } = prop();
	assert.ok(hits(root) > 0);
	applyPoseFade(root, 0.2);
	applyPoseFade(root, 0.2);
	assert.equal(shared.opacity, 0.2, "a shared material fades once, not once per mesh or per frame");
	assert.equal(glass.opacity, 0.5 * 0.2);
	assert.equal(shared.transparent, true);
	assert.equal(shared.depthWrite, false);
	assert.equal(hits(root), 0, "faded props cannot take a click meant for the rig");
});

test("changing the opacity scales from the authored value, not the faded one", () => {
	const { root, shared, glass } = prop();
	applyPoseFade(root, 0.2);
	applyPoseFade(root, 0.6);
	assert.equal(shared.opacity, 0.6);
	assert.equal(glass.opacity, 0.5 * 0.6);
});

test("the authored opacity stays readable under the working fade", () => {
	const { root, shared, glass } = prop();
	assert.deepEqual([authoredOpacity(shared), authoredOpacity(glass)], [1, 0.5], "an untouched material is authored as it is drawn");
	applyPoseFade(root, 0.2, 0.8);
	assert.equal(shared.opacity, 0.2 * 0.8, "the working fade and the object's own opacity are both drawn");
	assert.deepEqual([authoredOpacity(shared), authoredOpacity(glass)], [0.8, 0.5 * 0.8], "the authored opacity leaves the working fade out");
	applyPoseFade(root, 0, 1);
	assert.deepEqual([shared.opacity, authoredOpacity(shared)], [0, 1], "a prop faded away is still a solid in the set");
	applyPoseFade(root, null, 1);
	assert.deepEqual([authoredOpacity(shared), authoredOpacity(glass)], [1, 0.5], "leaving pose mode leaves nothing behind");
	assert.equal(authoredOpacity(undefined), undefined, "no material, no opacity");
});

test("full opacity and leaving pose mode restore materials and picking exactly", () => {
	for (const off of [1, null]) {
		const { root, shared, glass } = prop();
		applyPoseFade(root, 0.3);
		applyPoseFade(root, off);
		applyPoseFade(root, off);
		assert.deepEqual([shared.transparent, shared.opacity, shared.depthWrite], [false, 1, true]);
		assert.deepEqual([glass.transparent, glass.opacity, glass.depthWrite], [true, 0.5, true]);
		assert.ok(hits(root) > 0);
	}
});

test("a mesh that mounts while posing is faded on the next pass", () => {
	const { root } = prop();
	applyPoseFade(root, 0.2);
	const late = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
	root.add(late);
	applyPoseFade(root, 0.2);
	assert.equal(late.material.opacity, 0.2);
});

test("the chosen opacity is remembered and bad stored values fall back", () => {
	const storage = memoryStorage();
	assert.equal(readPoseFadeOpacity(storage), POSE_FADE_DEFAULT);
	writePoseFadeOpacity(0.45, storage);
	assert.equal(readPoseFadeOpacity(storage), 0.45);
	storage.setItem(POSE_FADE_STORAGE_KEY, "7");
	assert.equal(readPoseFadeOpacity(storage), 1);
	storage.setItem(POSE_FADE_STORAGE_KEY, "nope");
	assert.equal(readPoseFadeOpacity(storage), POSE_FADE_DEFAULT);
});

test("a capture lifts the fade for the draw and puts it back without another frame", () => {
	const { root, shared } = prop();
	const sync = () => applyPoseFade(root, 0.2);
	sync();
	const during = withPoseFadeLifted(sync, () => ({ opacity: shared.opacity, hits: hits(root) }));
	assert.equal(during.opacity, 1, "the capture draws the set as authored");
	assert.ok(during.hits > 0);
	assert.equal(shared.opacity, 0.2, "the fade is back before any frame renders");
	assert.equal(hits(root), 0, "a pick after the capture goes past the faded prop");
	assert.throws(() => withPoseFadeLifted(sync, () => { throw new Error("draw failed"); }));
	assert.equal(hits(root), 0, "a failed capture also restores the fade");
});

test("two instances of one imported graph keep their own opacity (#659)", async () => {
	const { cloneMeshGraph } = await import("../src/mesh-graph-clone.js");
	const { root: source, shared } = prop();
	const a = cloneMeshGraph(source);
	const b = cloneMeshGraph(source);
	applyPoseFade(a, null, 0.3);
	applyPoseFade(b, null, 1);
	const opacityOf = (root) => root.children[0].material.opacity;
	assert.equal(opacityOf(a), 0.3);
	assert.equal(opacityOf(b), 1, "the second instance stays solid");
	assert.equal(shared.opacity, 1, "the cached source graph is untouched");
	assert.notEqual(a.children[0].material, b.children[0].material);
	assert.equal(a.children[0].material, a.children[1].material, "materials shared inside one instance stay shared");
	assert.ok(a.children[0].userData.instanceOwned, "instance materials are disposed with the instance");
});

test("leaving pose mode restores picking after a re-render replaced userData (#974)", () => {
	const { root } = prop();
	const custom = () => {};
	root.children[2].raycast = custom;
	applyPoseFade(root, 0.2);
	// R3F compares userData by reference: an inline userData={{...}} prop is a new object every render.
	for (const node of root.children) node.userData = { cutoutTexture: null };
	applyPoseFade(root, null);
	for (const node of root.children) assert.equal(typeof node.raycast, "function");
	assert.equal(root.children[2].raycast, custom, "an authored raycast override comes back as it was");
	assert.ok(hits(root) > 0);
});
