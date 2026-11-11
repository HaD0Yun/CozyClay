// The live sketch in the working views: while the agent is still writing a call that builds sculpts, the parts it
// has written so far (sculpt-sketch-state.js) stand on the stage as translucent clay in their own colours, so the
// scene takes shape while the model types instead of after minutes of an empty stage. Each part grows in briefly,
// so new ones read as new. Everything sits on GIZMO_LAYER and takes no ray: the shot preview card, PlayView,
// captures the agent reads (verify_result), contact sheets and exports never draw it, and no pick can select it.
// A part that did not change keeps its mesh; a removed one is disposed with its geometry and material.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { GIZMO_LAYER } from "./dualview.jsx";
import { repeatSculptGeometry, sculptPartGeometry } from "./sculpt-geometry.js";
import { clearSculptSketch, sculptSketchFrame, sculptSketchSnapshot, sketchDrawnParts, subscribeSculptSketch } from "./sculpt-sketch-state.js";

const OPACITY = 0.42;
/** A scatter is drawn as the soft box it fills: its items are the real sculpt's job. */
const SCATTER_OPACITY = 0.2;
const GROW_MS = 420;
const DEG = Math.PI / 180;
// After the other see-through things (ghost-set.js draws onion skins at 40).
const RENDER_ORDER = 44;
const noRay = () => {};
const grow = (t) => 1 - (1 - t) ** 3;

/** Where a group stands: its object.sculpt placement, else the sculpt it rebuilds, else the origin (where a new sculpt lands). */
function placementMatrix(group, objects) {
	const target = group.target ? objects?.find((object) => object.id === group.target) : null;
	const at = { x: target?.x ?? 0, y: target?.y ?? 0, z: target?.z ?? 0, rot: target?.rot ?? 0, ...group.placement };
	return new THREE.Matrix4().compose(new THREE.Vector3(at.x, at.y, at.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), at.rot * DEG), new THREE.Vector3(1, 1, 1));
}

/** Every part to draw: { identity, part, matrix (world) }. The identity leaves out ids and placement, so a part
 * the model renamed, or a group that just learned where it stands, keeps its mesh. */
function sketchItems(groups, objects) {
	const items = [];
	for (const group of groups) {
		const place = placementMatrix(group, objects);
		for (const part of sketchDrawnParts(group.parts)) {
			const { id, parent, matrix, ...shape } = part;
			items.push({ identity: JSON.stringify([shape, matrix.map((value) => Math.round(value * 1e4))]), part, matrix: place.clone().multiply(new THREE.Matrix4().fromArray(matrix)) });
		}
	}
	return items;
}

/** The meshes of the sketch under one root, keyed by identity. */
class SketchLayer {
	root = new THREE.Group();
	meshes = new Map();
	constructor() {
		this.root.name = "sculpt-sketch";
		this.root.userData.sculptSketch = true;
	}
	make(part, now) {
		const geometry = repeatSculptGeometry(sculptPartGeometry(part.shape === "scatter" ? { ...part, shape: "blob", roundness: 0.5, taper: 0 } : part), part);
		const material = new THREE.MeshStandardMaterial({ color: part.color, emissive: part.color, emissiveIntensity: 0.18, roughness: 0.85, metalness: 0, transparent: true, opacity: 0, depthWrite: false });
		const mesh = new THREE.Mesh(geometry, material);
		Object.assign(mesh, { raycast: noRay, castShadow: false, receiveShadow: false, matrixAutoUpdate: false, renderOrder: RENDER_ORDER, frustumCulled: false });
		mesh.layers.set(GIZMO_LAYER);
		mesh.userData.sculptSketch = true;
		this.root.add(mesh);
		return { mesh, base: new THREE.Matrix4(), born: now, opacity: part.shape === "scatter" ? SCATTER_OPACITY : OPACITY };
	}
	drop({ mesh }) {
		this.root.remove(mesh);
		mesh.geometry.dispose();
		mesh.material.dispose();
	}
	/** Keep the meshes whose parts are still there, make the new ones, dispose the rest. */
	update(items, now) {
		const next = new Map(), seen = new Map();
		for (const item of items) {
			const n = (seen.get(item.identity) ?? 0) + 1;
			seen.set(item.identity, n);
			const key = `${item.identity}#${n}`;
			let entry = this.meshes.get(key);
			if (entry) this.meshes.delete(key);
			else {
				try { entry = this.make(item.part, now); } catch { continue; }
			}
			entry.base.copy(item.matrix);
			next.set(key, entry);
		}
		for (const entry of this.meshes.values()) this.drop(entry);
		this.meshes = next;
		this.frame(now);
	}
	/** Grow the new parts in; true while one still grows. */
	frame(now) {
		let growing = false;
		const scale = new THREE.Matrix4();
		for (const entry of this.meshes.values()) {
			const t = Math.min(1, Math.max(0, (now - entry.born) / GROW_MS)), k = grow(t);
			growing ||= t < 1;
			const s = 0.55 + 0.45 * k;
			entry.mesh.matrix.copy(entry.base).multiply(scale.makeScale(s, s, s));
			entry.mesh.material.opacity = entry.opacity * k;
		}
		return growing;
	}
	dispose() {
		for (const entry of this.meshes.values()) this.drop(entry);
		this.meshes.clear();
	}
}

/** objects: the authored records, for the placement of a sculpt the agent rebuilds (object.sculpt { id }). */
export function SculptSketch({ objects }) {
	const groups = useSyncExternalStore(subscribeSculptSketch, sculptSketchSnapshot, sculptSketchSnapshot);
	const scene = useThree((state) => state.scene), invalidate = useThree((state) => state.invalidate);
	const layer = useMemo(() => new SketchLayer(), []);
	const items = useMemo(() => sketchItems(groups, objects), [groups, objects]);
	useEffect(() => {
		scene.add(layer.root);
		// QA: the browser suite feeds frames and counts what the stage draws.
		if (typeof window !== "undefined") window.__cozyclaySculptSketch = { frame: sculptSketchFrame, clear: clearSculptSketch, meshes: () => layer.meshes.size, root: layer.root };
		return () => { scene.remove(layer.root); layer.dispose(); };
	}, [scene, layer]);
	useEffect(() => {
		layer.update(items, performance.now());
		invalidate();
	}, [layer, items, invalidate]);
	useFrame(() => { if (layer.frame(performance.now())) invalidate(); });
	return null;
}
