// The flat heights an object offers, sampled from what the stage draws: rays straight down over its footprint, the
// first hit of each grouped by height. No object kinds or names: only the geometry. Browser only (three.js).
//   objectTops(root, options) -> [{ y, x0, z0, x1, z1 }]   in the object's own frame: metres, y over its base
//   withTops(describe, sceneOf) -> describe(args): the describe query answering `tops` on each solid object row when
//                                  asked with { tops: true }
import * as THREE from "three";

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
 * The editor's describe query with the tops flag: withTops(describe, sceneOf)(args) is describe() and, when
 * args.tops is true, each visible solid object row gains `tops` (objectTops of its group in the scene sceneOf() returns;
 * [] when the group is not mounted).
 */
export function withTops(describe, sceneOf) {
	return (args = {}) => {
		const answer = describe(args);
		if (args?.tops !== true || !Array.isArray(answer?.objects)) return answer;
		const scene = sceneOf(), groups = new Map();
		scene?.traverse(node => { const id = node.userData?.sceneObjectId; if (typeof id === "string" && !node.userData.ghost && !groups.has(id)) groups.set(id, node); });
		return { ...answer, objects: answer.objects.map(row => row && !row.hidden && SOLID.has(row.renderer) ? { ...row, tops: objectTops(groups.get(row.id)) } : row) };
	};
}
