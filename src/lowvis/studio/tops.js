// The flat heights an object offers, sampled from what the stage draws: rays straight down over its footprint, the
// first hit of each grouped by height; and the parts it draws, one box per drawn mesh. No object kinds: only the geometry
// and the names the meshes carry. Browser only (three.js).
//   objectTops(root, options) -> [{ y, x0, z0, x1, z1 }]   in the object's own frame: metres, y over its base
//   objectParts(root, max) -> [{ name, at, size, turn? }]  in the same frame (parts.js mergeParts)
//   withTops(describe, sceneOf) -> describe(args): the describe query answering `tops` on each solid object row when
//                                  asked with { tops: true }, and `parts` when asked with { parts: true }
import * as THREE from "three";
import { MAX_PARTS, mergeParts } from "./parts.js";

const SOLID = new Set(["cube", "sphere", "capsule", "cylinder", "cone", "sculpt", "mesh"]);
const round = v => Math.round(v * 1000) / 1000;

/** The meshes an object's group draws (visible, layer 0, not a nested object), as propSources (ghost-set.js) takes them. */
function meshesOf(root) {
	const meshes = [];
	const walk = node => {
		if (!node.visible || node.userData?.beautyOnly) return;
		if (node.isMesh && !node.isInstancedMesh && node.layers.isEnabled(0) && node.geometry?.attributes?.position) meshes.push(node);
		for (const child of node.children) if (!child.userData?.sceneObjectId) walk(child);
	};
	for (const child of root.children) walk(child);
	return meshes;
}

/**
 * objectTops(root, { grid, band, minArea, max }) -> [{ y, x0, z0, x1, z1 }], largest first.
 * root: the object's group (its origin is the base pivot). The own frame is the group's place and turn without its
 * scale, so every number is in metres. A grid x grid lattice of rays falls on the footprint of the drawn meshes; the
 * heights of the first hits form bands `band` metres deep; a band is the bounding rectangle of its cells, kept when
 * its cells cover at least minArea square metres; at most max bands.
 */
export function objectTops(root, { grid = 9, band = 0.03, minArea = 0.02, max = 6 } = {}) {
	if (!root) return [];
	root.updateWorldMatrix(true, true);
	const meshes = meshesOf(root);
	if (!meshes.length) return [];
	const place = new THREE.Vector3(), turn = new THREE.Quaternion(), scale = new THREE.Vector3();
	root.matrixWorld.decompose(place, turn, scale);
	const own = new THREE.Matrix4().compose(place, turn, new THREE.Vector3(1, 1, 1)), toOwn = own.clone().invert();
	const box = new THREE.Box3(), part = new THREE.Box3(), m = new THREE.Matrix4();
	for (const mesh of meshes) {
		if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
		box.union(part.copy(mesh.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(toOwn, mesh.matrixWorld)));
	}
	if (box.isEmpty()) return [];
	const cw = (box.max.x - box.min.x) / grid, cd = (box.max.z - box.min.z) / grid, down = new THREE.Vector3(0, -1, 0).applyQuaternion(turn);
	const ray = new THREE.Raycaster(), origin = new THREE.Vector3(), hits = [];
	for (let i = 0; i < grid; i++) for (let k = 0; k < grid; k++) {
		const x = box.min.x + (i + 0.5) * cw, z = box.min.z + (k + 0.5) * cd;
		ray.set(origin.set(x, box.max.y + 1, z).applyMatrix4(own), down);
		const hit = ray.intersectObjects(meshes, false)[0];
		if (hit) hits.push({ y: hit.point.applyMatrix4(toOwn).y, i, k });
	}
	hits.sort((a, b) => a.y - b.y);
	const bands = [];
	for (const h of hits) {
		const last = bands.at(-1);
		if (last && h.y - last.from <= band) last.cells.push(h); else bands.push({ from: h.y, cells: [h] });
	}
	return bands.map(b => {
		const is = b.cells.map(c => c.i), ks = b.cells.map(c => c.k);
		return { y: b.cells.reduce((s, c) => s + c.y, 0) / b.cells.length, area: b.cells.length * cw * cd,
			x0: box.min.x + Math.min(...is) * cw, x1: box.min.x + (Math.max(...is) + 1) * cw, z0: box.min.z + Math.min(...ks) * cd, z1: box.min.z + (Math.max(...ks) + 1) * cd };
	}).filter(b => b.area >= minArea).sort((a, b) => b.area - a.area).slice(0, max)
		.map(b => ({ y: round(b.y), x0: round(b.x0), z0: round(b.z0), x1: round(b.x1), z1: round(b.z1) }));
}

/**
 * objectParts(root, max) -> the parts an object draws, each the box of one drawn mesh's geometry where the mesh puts it
 * (its centre, its sides along the mesh's own axes times its scale, the mesh's turn), in the object's own frame (place and
 * turn of the group, none of its scale), named by the mesh's sculpt part, else its name, else "part", merged down to max
 * (parts.js mergeParts); [] when the group draws nothing.
 */
export function objectParts(root, max = MAX_PARTS) {
	if (!root) return [];
	root.updateWorldMatrix(true, true);
	const place = new THREE.Vector3(), turn = new THREE.Quaternion(), scale = new THREE.Vector3();
	root.matrixWorld.decompose(place, turn, scale);
	const toOwn = new THREE.Matrix4().compose(place, turn, new THREE.Vector3(1, 1, 1)).invert(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
	const used = new Map(), parts = [];
	for (const mesh of meshesOf(root)) {
		if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
		const box = mesh.geometry.boundingBox;
		if (box.isEmpty()) continue;
		m.multiplyMatrices(toOwn, mesh.matrixWorld).decompose(place, q, scale);
		const at = box.getCenter(new THREE.Vector3()).applyMatrix4(m), size = box.getSize(new THREE.Vector3()).multiply(scale);
		e.setFromQuaternion(q, "XYZ");
		const base = String(mesh.userData?.sculptPart ?? (mesh.name || "part")), n = (used.get(base) ?? 0) + 1, turned = [e.x, e.y, e.z].map(v => v * 180 / Math.PI);
		used.set(base, n);
		parts.push({ name: n > 1 ? `${base}_${n}` : base, at: at.toArray(), size: size.toArray().map(Math.abs), ...(turned.some(v => Math.abs(v) > 0.05) ? { turn: turned } : {}) });
	}
	return parts.length ? mergeParts(parts, max) : [];
}

/**
 * The editor's describe query with the tops and parts flags: withTops(describe, sceneOf)(args) is describe() and, when
 * args.tops is true, each visible solid object row gains `tops` (objectTops of its group in the scene sceneOf() returns;
 * [] when the group is not mounted), and when args.parts is true `parts` (objectParts of it).
 */
export function withTops(describe, sceneOf) {
	return (args = {}) => {
		const answer = describe(args), tops = args?.tops === true, parts = args?.parts === true;
		if (!(tops || parts) || !Array.isArray(answer?.objects)) return answer;
		const scene = sceneOf(), groups = new Map();
		scene?.traverse(node => { const id = node.userData?.sceneObjectId; if (typeof id === "string" && !node.userData.ghost && !groups.has(id)) groups.set(id, node); });
		return { ...answer, objects: answer.objects.map(row => row && !row.hidden && SOLID.has(row.renderer) ? { ...row, ...(tops ? { tops: objectTops(groups.get(row.id)) } : {}), ...(parts ? { parts: objectParts(groups.get(row.id)) } : {}) } : row) };
	};
}
