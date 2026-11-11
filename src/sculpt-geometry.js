/**
 * Sculpt geometry: a normalized recipe (sculpt-recipe.js) becomes a three.js
 * Group of clay meshes, one per drawn part, each named by its part id.
 *
 * A blob is a superellipsoid built by remapping a UV sphere along each vertex
 * direction: |x/a|^p + |y/b|^p + |z/c|^p = 1. p = 2 is an ellipsoid and a large
 * p flattens the faces toward a rounded box, which is what a chibi head or a
 * pillow needs and what no stock primitive gives. Every shape stays inside its
 * declared size, so the record's measured box (sculptStandingBox) never lies.
 */

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { expandSculptParts } from "./sculpt-recipe.js";
import { BLOB_TAPER } from "./sculpt-shapes.js";
import { cutSculptGeometry } from "./sculpt-csg.js";
import { LOFT_CONVEX_BUILDERS } from "./sculpt-geometry-loft-convex.js";
import { extrudeGeometry, latheGeometry, tubeGeometry } from "./sculpt-geometry-shapes.js";
import { applySculptDetail } from "./sculpt-detail.js";
import { applySculptColours } from "./sculpt-colours.js";
import { scatterMesh } from "./sculpt-scatter.js";
import { lookMaterial } from "./material-look.js";
import { repeatCopies } from "./sculpt-repeat.js";

/** roundness 0..1 → superellipse exponent 2..8 */
const blobExponent = (roundness) => 2 + 6 * roundness;

/** The x/z scale at height fraction t (−1 bottom, +1 top). Positive taper
 * narrows the top, negative narrows the bottom; neither end grows. */
function taperScale(taper, t, strength) {
	if (taper > 0) return 1 - taper * strength * ((t + 1) / 2);
	if (taper < 0) return 1 + taper * strength * ((1 - t) / 2);
	return 1;
}

function blobGeometry(part) {
	const [a, b, c] = part.size.map((value) => value / 2);
	const p = blobExponent(part.roundness);
	const geometry = new THREE.SphereGeometry(1, 64, 48);
	const position = geometry.getAttribute("position");
	const v = new THREE.Vector3();
	for (let i = 0; i < position.count; i += 1) {
		v.fromBufferAttribute(position, i);
		const s = Math.abs(v.x) ** p + Math.abs(v.y) ** p + Math.abs(v.z) ** p;
		v.multiplyScalar(s > 0 ? s ** (-1 / p) : 0);
		const k = taperScale(part.taper, v.y, BLOB_TAPER);
		position.setXYZ(i, v.x * a * k, v.y * b, v.z * c * k);
	}
	geometry.computeVertexNormals();
	return geometry;
}

function boxGeometry(part) {
	const [w, h, d] = part.size;
	const radius = (part.roundness * Math.min(w, h, d)) / 2;
	if (radius <= 1e-4) return new THREE.BoxGeometry(w, h, d);
	return new RoundedBoxGeometry(w, h, d, 4, radius);
}

/** An upright cylinder with an elliptical section (size x by size z). Taper 1
 * is a cone; −1 is a cone standing on its point. */
function cylinderGeometry(part) {
	const [w, h, d] = part.size;
	const r = w / 2;
	const top = r * Math.max(0, 1 - Math.max(0, part.taper));
	const bottom = r * Math.max(0, 1 - Math.max(0, -part.taper));
	const geometry = new THREE.CylinderGeometry(top, bottom, h, 40, 1);
	geometry.scale(1, 1, d / w);
	return geometry;
}

/** A ring in the x/y plane: size [outer x, outer y, tube diameter]. */
function torusGeometry(part) {
	const [w, h, d] = part.size;
	const tube = d / 2;
	const geometry = new THREE.TorusGeometry(w / 2 - tube, tube, 20, 64);
	geometry.scale(1, (h - d) / (w - d), 1);
	return geometry;
}

/** A rectangular ring in the x/y plane, `border` metres wide, size z deep. */
function frameGeometry(part) {
	const [w, h, d] = part.size;
	const outerX = w / 2, outerY = h / 2;
	const innerX = outerX - part.border, innerY = outerY - part.border;
	const shape = new THREE.Shape();
	shape.moveTo(-outerX, -outerY);
	shape.lineTo(outerX, -outerY);
	shape.lineTo(outerX, outerY);
	shape.lineTo(-outerX, outerY);
	shape.closePath();
	const hole = new THREE.Path();
	hole.moveTo(-innerX, -innerY);
	hole.lineTo(-innerX, innerY);
	hole.lineTo(innerX, innerY);
	hole.lineTo(innerX, -innerY);
	hole.closePath();
	shape.holes.push(hole);
	const geometry = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false, steps: 1 });
	geometry.translate(0, 0, -d / 2);
	return geometry;
}

const BUILDERS = { blob: blobGeometry, box: boxGeometry, cylinder: cylinderGeometry, torus: torusGeometry, frame: frameGeometry, lathe: latheGeometry, tube: tubeGeometry, extrude: extrudeGeometry, ...LOFT_CONVEX_BUILDERS };
/** Shapes that draw their own mesh (many instances) instead of one geometry. */
const MESH_BUILDERS = { scatter: scatterMesh };

/** The part's geometry, with its surface `detail` applied. */
export function sculptPartGeometry(part) {
	const build = BUILDERS[part.shape];
	if (!build) throw new Error(`unknown sculpt shape "${part.shape}"`);
	return applySculptDetail(build(part), part);
}

/** A repeated part's copies (sculpt-repeat.js) merged into ONE geometry in the
 * part's own frame, so the part stays one mesh and one draw call. `geometry`
 * (one copy, already cut and coloured) is consumed. */
export function repeatSculptGeometry(geometry, part) {
	if (!part.repeat) return geometry;
	const copies = repeatCopies(part).map((copy) => geometry.clone().applyMatrix4(new THREE.Matrix4().fromArray(copy)));
	const merged = mergeGeometries(copies);
	for (const copy of copies) copy.dispose();
	geometry.dispose();
	return merged;
}

/**
 * The drawable object for a normalized recipe. `materialFor(part)` lets the
 * caller decide the look (auto-colour, depth rank); the default is the part's
 * own preset (material-look.js), clay when it names none, with the part's
 * gradient and a scatter's per-item tint. Meshes (a scatter's InstancedMesh
 * too) carry their part id as the name and as `userData.sculptPart`, so a
 * capture or a raycast can say which part it hit. Glass casts no shadow: light
 * passes through it.
 */
export function buildSculptGroup(recipe, { materialFor } = {}) {
	const group = new THREE.Group();
	group.userData.sculpt = true;
	const matrix = new THREE.Matrix4();
	const parts = expandSculptParts(recipe);
	for (const part of parts) {
		// A cutter (op) is never drawn: it cuts its parent's geometry instead.
		if (part.op) continue;
		const material = materialFor ? materialFor(part) : lookMaterial(part);
		// A scatter draws its own InstancedMesh and is never cut; every other part is cut by its cutters.
		const mesh = MESH_BUILDERS[part.shape]?.(part, material) ?? new THREE.Mesh(cutSculptGeometry(sculptPartGeometry(part), part, parts, sculptPartGeometry), material);
		// Gradients and scatter tints belong to the shaded look; a flat display mode (materialFor) ignores them.
		if (!materialFor) applySculptColours(mesh, part);
		// Copies after colours, so a gradient runs along each copy, not across the row.
		mesh.geometry = repeatSculptGeometry(mesh.geometry, part);
		mesh.name = part.id;
		mesh.userData.sculptPart = part.id;
		matrix.fromArray(part.matrix);
		matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
		mesh.castShadow = !(material.transmission > 0);
		mesh.receiveShadow = true;
		group.add(mesh);
	}
	return group;
}

/** Frees what buildSculptGroup allocated. Materials are disposed too, because
 * buildSculptGroup (or the caller's materialFor) minted one per part; a
 * scatter's instance buffers go with its InstancedMesh. The preset pattern
 * textures they sample are shared and stay. */
export function disposeSculptGroup(group) {
	group?.traverse((node) => {
		if (!node.isMesh) return;
		node.geometry.dispose();
		if (node.isInstancedMesh) node.dispose();
		const materials = Array.isArray(node.material) ? node.material : [node.material];
		for (const material of materials) material.dispose();
	});
}
