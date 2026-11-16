// The solid shape of a scene record, for sight-line tests ("does this body hide that point from this eye"). A record's
// box (footprint x height) is mostly air for a stair, a table, an arch or a bench: a sight line through the empty part
// of the box is not hidden. The shapes come from what the viewport draws: a sculpt's buildSculptGroup (cutters applied),
// an imported model's loaded scene fitted the way imported-mesh.jsx fits it, and the round primitives' geometries with
// props.jsx's arguments. A cube is its box; so is a model whose file has not loaded here (node, or still loading).
// Built only when a sight line first crosses the box, then cached: sculpts by recipe content, models by scene and height.
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { buildSculptGroup } from "./sculpt-geometry.js";
import { loadedMeshScene } from "./scene-mesh-cache.js";
import { MESH_KIND, SCULPT_KIND } from "./scene-objects.js";

// The same geometries and lifts as props.jsx's Primitive: keep the two in step.
const PRIMITIVES = {
	sphere: () => new THREE.SphereGeometry(0.5, 28, 18).translate(0, 0.5, 0),
	capsule: () => new THREE.CapsuleGeometry(0.35, 0.7, 6, 18).translate(0, 0.7, 0),
	cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 26).translate(0, 0.5, 0),
	cone: () => new THREE.ConeGeometry(0.5, 1, 26).translate(0, 0.5, 0),
};
// A point this close (m) behind a surface still shows: a foot on a step, a hand on a table top.
const SURFACE_M = 0.02;
const SCULPT_CACHE = 32, TOP_STEPS = 20;
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(a => new THREE.Vector3(...a));
const sculpts = new Map(), recipeKeys = new WeakMap(), models = new WeakMap(), primitives = new Map();
const flat = new THREE.MeshBasicMaterial();

/** Every drawn triangle under root, in root's parent frame (root's own transform applied), as one BVH; null when none. */
function bvhOf(root, transform = new THREE.Matrix4()) {
	root.updateMatrixWorld(true);
	const out = [], m = new THREE.Matrix4(), instance = new THREE.Matrix4(), v = new THREE.Vector3();
	root.traverse(node => {
		if (!node.isMesh || !node.geometry?.attributes?.position) return;
		const position = node.geometry.attributes.position, index = node.geometry.index, n = index ? index.count : position.count;
		for (let k = 0; k < (node.isInstancedMesh ? node.count : 1); k++) {
			m.multiplyMatrices(transform, node.matrixWorld);
			if (node.isInstancedMesh) m.multiply(node.getMatrixAt(k, instance) ?? instance);
			for (let i = 0; i < n; i++) { v.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(m); out.push(v.x, v.y, v.z); }
		}
	});
	if (!out.length) return null;
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
	return new MeshBVH(geometry);
}

function sculptBvh(recipe) {
	let key = recipeKeys.get(recipe);
	if (key === undefined) { key = JSON.stringify(recipe); recipeKeys.set(recipe, key); }
	if (sculpts.has(key)) return sculpts.get(key);
	let bvh;
	try {
		const group = buildSculptGroup(recipe, { materialFor: () => flat });
		bvh = bvhOf(group);
		group.traverse(node => { if (node.isMesh) node.geometry.dispose(); });
	} catch { bvh = null; }
	sculpts.set(key, bvh);
	if (sculpts.size > SCULPT_CACHE) sculpts.delete(sculpts.keys().next().value);
	return bvh;
}

/** imported-mesh.jsx instantiateMesh: scaled about the file root so the box is `height` tall, then stood on y = 0. */
function modelBvh(scene, height) {
	const byHeight = models.get(scene) ?? new Map();
	models.set(scene, byHeight);
	if (byHeight.has(height)) return byHeight.get(height);
	scene.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(scene), size = box.getSize(new THREE.Vector3()), root = scene.position;
	const k = Number.isFinite(height) && height > 0 && size.y > 1e-8 ? height / size.y : 1, floor = root.y + k * (box.min.y - root.y);
	const fit = new THREE.Matrix4().makeTranslation(root.x, root.y - floor, root.z).multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(new THREE.Matrix4().makeTranslation(-root.x, -root.y, -root.z));
	const bvh = Number.isFinite(box.min.y) ? bvhOf(scene, fit) : null;
	byHeight.set(height, bvh);
	return bvh;
}

function sourceOf(record) {
	if (record.renderer === SCULPT_KIND && record.recipe?.parts) return () => sculptBvh(record.recipe);
	if (record.renderer === MESH_KIND) {
		const scene = loadedMeshScene(record.assetId);
		return scene ? () => modelBvh(scene, Number(record.height)) : null;
	}
	const make = PRIMITIVES[record.renderer];
	if (!make) return null;
	return () => { if (!primitives.has(record.renderer)) primitives.set(record.renderer, new MeshBVH(make())); return primitives.get(record.renderer); };
}

const triangle = new THREE.Triangle(), normal = new THREE.Vector3();
/** The outward normal of a BVH face (the geometries wind their faces outward). */
function faceNormal(geometry, face) {
	const index = geometry.index, position = geometry.attributes.position, at = k => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(face * 3 + k) : face * 3 + k);
	return triangle.set(at(0), at(1), at(2)).getNormal(normal);
}

/**
 * The record's solid, or null when its box is its shape. box is where the record stands now, a motion box ({ pos: base
 * centre, R: rows of the turn, half }: motion3/scene.js), so a carried or hinged copy moves its solid too; points are
 * [x, y, z] in the world. hits(box, eye, p): the segment eye -> p crosses the drawn surface. depth(box, p): how far p lies
 * inside the drawn solid (0 outside). top(box, region): the highest world height at which the drawn surface reaches into
 * region ({ min, max } as [x, y, z], world axes), null when it does not reach in: a wall's top under a roof, a seat under
 * a cup. depth and top answer null when the shape cannot be built (the box stands in).
 */
export function solidOf(record) {
	const size = [record?.footprint?.width, record?.height, record?.footprint?.depth];
	if (!record || !size.every(v => v > 0)) return null;
	const source = sourceOf(record);
	if (!source) return null;
	let bvh;
	const built = () => { if (bvh === undefined) bvh = source(); return bvh; };
	const scaleOf = box => size.map((v, i) => (2 * box.half[i]) / v);
	const local = (box, scale, q) => [0, 1, 2].map(i => (box.R[0][i] * (q[0] - box.pos[0]) + box.R[1][i] * (q[1] - box.pos[1]) + box.R[2][i] * (q[2] - box.pos[2])) / scale[i]);
	const world = (box, scale, l) => [0, 1, 2].map(i => box.pos[i] + box.R[i][0] * l.x * scale[0] + box.R[i][1] * l.y * scale[1] + box.R[i][2] * l.z * scale[2]);
	const depth = (box, p) => {
		if (!built()) return null;
		const scale = scaleOf(box), q = new THREE.Vector3(...local(box, scale, p)), hit = bvh.closestPointToPoint(q);
		if (!hit || q.clone().sub(hit.point).dot(faceNormal(bvh.geometry, hit.faceIndex)) >= 0) return 0;
		// behind the nearest face, and walled in on every side: under an open-bottomed lathe base is outside
		if (AXES.some(axis => !bvh.raycastFirst(new THREE.Ray(q, axis), THREE.DoubleSide))) return 0;
		const c = world(box, scale, hit.point);
		return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
	};
	return {
		hits(box, eye, p) {
			if (!built()) return true;
			const scale = scaleOf(box);
			const a = new THREE.Vector3(...local(box, scale, eye)), b = new THREE.Vector3(...local(box, scale, p)), along = b.clone().sub(a), length = along.length();
			const span = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
			if (!(length > 0) || span <= SURFACE_M) return false;
			return Boolean(bvh.raycastFirst(new THREE.Ray(a, along.divideScalar(length)), THREE.DoubleSide, 0, length * (1 - SURFACE_M / span)));
		},
		depth,
		top(box, region) {
			if (!built()) return null;
			const scale = scaleOf(box), m = new THREE.Matrix4().set(...[0, 1, 2].flatMap(i => [box.R[i][0] * scale[0], box.R[i][1] * scale[1], box.R[i][2] * scale[2], box.pos[i]]), 0, 0, 0, 1).invert();
			const meets = lo => bvh.intersectsBox(new THREE.Box3(new THREE.Vector3(region.min[0], lo, region.min[2]), new THREE.Vector3(region.max[0], region.max[1], region.max[2])), m);
			if (!meets(region.min[1])) return null;
			let lo = region.min[1], hi = region.max[1];
			for (let k = 0; k < TOP_STEPS; k++) { const mid = (lo + hi) / 2; if (meets(mid)) lo = mid; else hi = mid; }
			return lo;
		},
	};
}

/** { id: solid } for the records that have a shape of their own (solidOf). */
export function solidsOf(records = []) {
	return Object.fromEntries(records.flatMap(o => { const solid = o && !o.hidden ? solidOf(o) : null; return solid ? [[o.id, solid]] : []; }));
}
