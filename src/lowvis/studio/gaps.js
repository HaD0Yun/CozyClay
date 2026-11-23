// How far points are from what the stage draws of an object, for the contact gaps of a motion (contacts.js; rule 6).
// The drawn meshes of the object's group (visible, layer 0, not a nested object; a scatter's instances each), in the
// object's own frame: its base pivot and turn without its scale, so every number is in metres, the frame a sculpt
// recipe of it is written in. No object kinds or names: only the geometry. Browser only (three.js).
//   contactGaps(sceneOf) -> query(args): the live query contact_gaps
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(a => new THREE.Vector3(...a));
const COLUMN = 0.05; // m: the column round a point that a surface under it is looked for in
const LAYER = 4, CORNERS = 4000; // points per triangle edge of a solid; at most this many corners of the drawn look are read
const round = v => Math.round(v * 1000) / 1000;

/** The meshes an object's group draws, as tops.js reads them, and a scatter's instanced meshes too. */
function meshesOf(root) {
	const meshes = [];
	const walk = node => {
		if (!node.visible || node.userData?.beautyOnly) return;
		if (node.isMesh && node.layers.isEnabled(0) && node.geometry?.attributes?.position) meshes.push(node);
		for (const child of node.children) if (!child.userData?.sceneObjectId) walk(child);
	};
	for (const child of root.children) walk(child);
	return meshes;
}

/** One BVH per drawn mesh (and instance), in the object's own frame; [] when nothing is drawn. */
function partsOf(root) {
	root.updateWorldMatrix(true, true);
	const place = new THREE.Vector3(), turn = new THREE.Quaternion(), scale = new THREE.Vector3();
	root.matrixWorld.decompose(place, turn, scale);
	const toOwn = new THREE.Matrix4().compose(place, turn, new THREE.Vector3(1, 1, 1)).invert(), m = new THREE.Matrix4(), one = new THREE.Matrix4();
	return meshesOf(root).flatMap(mesh => Array.from({ length: mesh.isInstancedMesh ? mesh.count : 1 }, (_, k) => {
		m.multiplyMatrices(toOwn, mesh.matrixWorld);
		if (mesh.isInstancedMesh) { mesh.getMatrixAt(k, one); m.multiply(one); }
		const soup = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone(), geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", soup.getAttribute("position").clone().applyMatrix4(m));
		soup.dispose();
		return new MeshBVH(geometry);
	}));
}

const q = new THREE.Vector3(), n = new THREE.Vector3(), tri = new THREE.Triangle(), ray = new THREE.Ray();
/** True when q lies inside the closed part: behind its nearest face and walled in on every axis (solid-shape.js depth). */
function inside(bvh, hit) {
	tri.setFromAttributeAndIndices(bvh.geometry.getAttribute("position"), hit.faceIndex * 3, hit.faceIndex * 3 + 1, hit.faceIndex * 3 + 2).getNormal(n);
	if (n.dot(q.clone().sub(hit.point)) >= 0) return false;
	return AXES.every(axis => { ray.origin.copy(q); ray.direction.copy(axis); return Boolean(bvh.raycastFirst(ray, THREE.DoubleSide)); });
}
/** Signed distance (m) from p to the drawn parts: to the nearest surface outside, minus the depth inside the deepest part. */
function signed(parts, p) {
	q.set(p[0], p[1], p[2]);
	let near = Infinity, deep = 0;
	for (const bvh of parts) {
		const hit = bvh.closestPointToPoint(q);
		if (!hit) continue;
		if (inside(bvh, hit)) deep = Math.max(deep, hit.distance); else near = Math.min(near, hit.distance);
	}
	return deep > 0 ? -deep : near;
}
/** The drawn surface the point at [x, z], y up, rests on: the highest one under it (5 rays down in a COLUMN); where the point
 *  itself is inside a closed part, that part's top over it (a ray down from there would find its underside); null when
 *  there is none. */
function under(parts, [x, z, y]) {
	let top = -Infinity;
	for (const bvh of parts) {
		q.set(x, y, z);
		const near = bvh.closestPointToPoint(q);
		if (!near || !inside(bvh, near)) continue;
		ray.origin.set(x, y, z); ray.direction.set(0, 1, 0);
		const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
		if (hit) top = Math.max(top, y + hit.distance);
	}
	if (Number.isFinite(top)) return round(top);
	for (const [dx, dz] of [[0, 0], [COLUMN, 0], [-COLUMN, 0], [0, COLUMN], [0, -COLUMN]]) for (const bvh of parts) {
		ray.origin.set(x + dx, y, z + dz); ray.direction.set(0, -1, 0);
		const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
		if (hit) top = Math.max(top, y - hit.distance);
	}
	return Number.isFinite(top) ? round(top) : null;
}

/** Points spread over closed solids [{ v, t }] (corners, LAYER points across each triangle, and toward the middle of each). */
function spreadOver(list) {
	const out = [];
	for (const { v, t } of list) {
		const mid = [0, 1, 2].map(k => v.reduce((s, p) => s + p[k], 0) / v.length);
		for (const [a, b, c] of t) for (let i = 0; i <= LAYER; i++) for (let j = 0; i + j <= LAYER; j++) {
			const w = [i / LAYER, j / LAYER, 1 - (i + j) / LAYER], p = [0, 1, 2].map(k => w[0] * v[a][k] + w[1] * v[b][k] + w[2] * v[c][k]);
			out.push(p, p.map((x, k) => (x + mid[k]) / 2));
		}
	}
	return out;
}
/** The gap between the drawn parts and closed solids [{ v, t }] (a body part, contacts.js): the least distance from the
 *  points of either to the other's surface, or, where one is in the other, minus the deepest such point. */
function solidGap(parts, list) {
	const solids = list.map(({ v, t }) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(t.flatMap(tri => tri.flatMap(i => v[i])), 3)); return new MeshBVH(g); });
	let near = Infinity, deep = 0;
	const take = d => { if (d < 0) deep = Math.max(deep, -d); else near = Math.min(near, d); };
	for (const p of spreadOver(list)) take(signed(parts, p));
	for (const bvh of parts) { const a = bvh.geometry.getAttribute("position"), step = Math.max(1, Math.ceil(a.count / CORNERS)); for (let i = 0; i < a.count; i += step) take(signed(solids, [a.getX(i), a.getY(i), a.getZ(i)])); }
	for (const bvh of solids) bvh.geometry.dispose();
	return round(deep > 0 ? -deep : near);
}

/**
 * The live query contact_gaps: args { objects: [{ id, points: [[[x, y, z], ...], ...], columns: [[x, z, y], ...], solids:
 * [[{ v, t }, ...], ...] }] }, every point in the object's own frame -> { objects: [{ id, drawn, points: [[d, ...], ...],
 * columns: [top | null], solids: [g] }] }: d the signed distance of each point from the drawn surface (m; negative inside
 * a drawn part), top the drawn surface each column's point rests on (the highest under it; the top of the part it is
 * inside), g the gap of each list of closed solids (corners v, triangles t) from the drawn parts (solidGap). drawn false
 * (and no numbers) when the stage draws nothing of the object now.
 */
export function contactGaps(sceneOf) {
	return (args = {}) => {
		const groups = new Map();
		sceneOf()?.traverse(node => { const id = node.userData?.sceneObjectId; if (typeof id === "string" && !node.userData.ghost && !groups.has(id)) groups.set(id, node); });
		const objects = (Array.isArray(args.objects) ? args.objects : []).map(entry => {
			const root = groups.get(entry?.id), parts = root ? partsOf(root) : [];
			if (!parts.length) return { id: entry?.id, drawn: false };
			const out = { id: entry.id, drawn: true, points: (entry.points ?? []).map(list => list.map(p => round(signed(parts, p)))), columns: (entry.columns ?? []).map(c => under(parts, c)), ...(entry.solids ? { solids: entry.solids.map(list => solidGap(parts, list)) } : {}) };
			for (const bvh of parts) bvh.geometry.dispose();
			return out;
		});
		return { objects };
	};
}
