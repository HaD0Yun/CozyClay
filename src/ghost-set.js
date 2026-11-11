// The onion-skin ghosts as three.js objects (view-ghosts.js chooses the frames and the look). A
// ghost is a slot: one clone of the live rig, posed from the take (playback.js) only when its
// frame changes, plus copies of the meshes of the records that take carries (a kit's parts),
// placed where the take has them at that frame (object-travel.js). Clones share the live
// geometry; each slot owns one material. Every node sits on one layer (GIZMO_LAYER in the
// viewport, so no capture renders it) and takes no ray, so a ghost never wins a pick. Each mesh
// has a depth-only twin drawn just before it, so a ghost shows only its front surface: one
// translucent silhouette, not a stack of overlapping shells.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { playTakeFrame as applyTakeFrame } from "./character-playback.js";
import { sceneObjectTravelMatrixAt, trackShown } from "./object-travel.js";
import { ghostFrames, ghostLook, sheetGhostSettings, takeKeyFrames } from "./view-ghosts.js";

const noRay = () => {};
// Ghosts draw after the other see-through things, nearest in time first: a ghost behind a nearer
// one (in depth) hides there, one in front of it tints it.
const GHOST_ORDER = 40;

function claim(node, layer) {
	node.layers.set(layer);
	node.raycast = noRay;
	node.castShadow = false;
	node.receiveShadow = false;
}

/** The depth-only twin of a ghost mesh, a child at its place (a skinned one bound to the same skeleton). */
function addDepthTwin(mesh, material) {
	const twin = mesh.isSkinnedMesh ? new THREE.SkinnedMesh(mesh.geometry, material) : new THREE.Mesh(mesh.geometry, material);
	if (mesh.isSkinnedMesh) { twin.bindMode = mesh.bindMode; twin.bind(mesh.skeleton, mesh.bindMatrix); }
	twin.userData.depthTwin = true;
	twin.frustumCulled = false;
	mesh.add(twin);
	return twin;
}

/** A copy of a rig whose bind-pose map points at the copy's bones (Object3D.copy JSON-clones userData, losing the Map). */
function cloneRig(rig) {
	const copy = cloneSkeleton(rig), originals = [], copies = [];
	rig.traverse((node) => originals.push(node));
	copy.traverse((node) => copies.push(node));
	const binds = rig.userData?.poseBind;
	copy.userData = binds instanceof Map ? { poseBind: new Map(originals.flatMap((node, i) => (binds.has(node) ? [[copies[i], binds.get(node)]] : []))) } : {};
	return copy;
}

/** Ids of the records a character's take moves (its spec.objects that travel) and everything grouped under them. */
export function rideIds(objects = [], take) {
	const moved = new Set(Object.entries(take?.objects ?? {}).filter(([, track]) => track?.pos).map(([id]) => id));
	if (!moved.size) return [];
	const byId = new Map(objects.map((o) => [o.id, o]));
	const rides = (o, seen = new Set()) => !!o && !seen.has(o.id) && (moved.has(o.id) || rides(byId.get(o.parent), seen.add(o.id)));
	return objects.filter((o) => !o.hidden && rides(o)).map((o) => o.id);
}

/** The take's own object tracks as object-travel.js reads them (objectTracksOf for one character). */
export const takeTracks = (take) => new Map(Object.entries(take?.objects ?? {}).map(([id, track]) => [id, { frameCount: take.frameCount, ...track }]));

/**
 * What a record draws, from its mounted group (props.jsx tags it userData.sceneObjectId): every
 * visible mesh on layer 0 (no editor markers, halos or particles), with its matrix relative to
 * the record's own frame. Records not mounted yet are left out.
 */
export function propSources(scene, ids) {
	const wanted = new Set(ids), sources = [];
	if (!wanted.size) return sources;
	scene.traverse((group) => {
		const id = group.userData?.sceneObjectId;
		if (!wanted.has(id) || group.userData.ghost) return;
		group.updateWorldMatrix(true, true);
		const inverse = group.matrixWorld.clone().invert(), meshes = [];
		const walk = (node) => {
			if (!node.visible || node.userData?.beautyOnly) return;
			if (node.isMesh && !node.isInstancedMesh && node.layers.isEnabled(0) && node.geometry?.attributes?.position) {
				meshes.push({ geometry: node.geometry, matrix: inverse.clone().multiply(node.matrixWorld) });
			}
			for (const child of node.children) if (!child.userData?.sceneObjectId) walk(child);
		};
		for (const child of group.children) walk(child);
		if (meshes.length) sources.push({ id, meshes });
	});
	return sources;
}

const material = () => new THREE.MeshMatcapMaterial({ transparent: true, depthWrite: false, toneMapped: false, fog: false });
// Pushed back a hair so the colour pass of the same surface passes the depth test.
const depthOnly = () => new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

export class GhostSet {
	constructor({ layer }) {
		this.layer = layer;
		this.object = new THREE.Group();
		this.object.name = "ghosts";
		this.object.userData.ghost = true;
		// The body ghosts ride the character's placement; the props are already in world space.
		this.body = new THREE.Group();
		this.body.matrixAutoUpdate = false;
		this.props = new THREE.Group();
		this.object.add(this.body, this.props);
		this.slots = [];
		this.rig = null;
		this.sources = [];
		this.sourceTake = this.sourceObjects = null;
		this.sourcePasses = 0;
		this.depthMaterial = depthOnly();
		this.stats = { poses: 0, poseMs: 0 };
	}

	/** Show or hide the whole set; answers `shown`. */
	show(shown) {
		this.object.visible = shown;
		return shown;
	}

	/** Rebuild the slots for another rig (a new model, part colours): the old clones go. */
	setRig(rig) {
		if (rig === this.rig) return;
		this.clear();
		this.rig = rig;
	}

	/**
	 * Collect the carried records' meshes (propSources) when the take or the records changed, and
	 * again on the next `passes - 1` calls: kit parts can mount a frame after the change.
	 */
	syncSources(scene, objects, take, passes = 1) {
		if (this.sourceTake !== take || this.sourceObjects !== objects) Object.assign(this, { sourceTake: take, sourceObjects: objects, sourcePasses: passes });
		if (this.sourcePasses <= 0) return;
		this.sourcePasses -= 1;
		this.setSources(propSources(scene, rideIds(objects, take)));
	}

	/** Records whose meshes ride along (propSources); every slot rebuilds its prop copies. */
	setSources(sources) {
		this.sources = sources;
		for (const slot of this.slots) this.fillProps(slot);
	}

	fillProps(slot) {
		slot.props.clear();
		slot.records = this.sources.map(({ id, meshes }) => {
			const group = new THREE.Group();
			group.matrixAutoUpdate = false;
			claim(group, this.layer);
			for (const { geometry, matrix } of meshes) {
				const mesh = new THREE.Mesh(geometry, slot.material);
				mesh.matrixAutoUpdate = false;
				mesh.matrix.copy(matrix);
				mesh.frustumCulled = false;
				group.add(mesh);
				addDepthTwin(mesh, this.depthMaterial);
				mesh.traverse((node) => claim(node, this.layer));
			}
			slot.props.add(group);
			return { id, group };
		});
		slot.f = null;
		if (slot.order !== null) this.setOrder(slot, slot.order, true);
	}

	addSlot() {
		const slot = { material: material(), rig: cloneRig(this.rig), props: new THREE.Group(), records: [], f: null, take: null, order: null };
		const meshes = [];
		slot.rig.traverse((node) => { if (node.isMesh) meshes.push(node); });
		for (const mesh of meshes) { mesh.material = slot.material; mesh.frustumCulled = false; addDepthTwin(mesh, this.depthMaterial); }
		slot.rig.traverse((node) => claim(node, this.layer));
		claim(slot.props, this.layer);
		this.body.add(slot.rig);
		this.props.add(slot.props);
		this.fillProps(slot);
		this.slots.push(slot);
		return slot;
	}

	/** The twin at `order`, the colour right after it. */
	setOrder(slot, order, force = false) {
		if (slot.order === order && !force) return;
		slot.order = order;
		const at = (node) => { node.renderOrder = node.userData.depthTwin ? order : order + 1; };
		slot.rig.traverse(at);
		slot.props.traverse(at);
	}

	/**
	 * Show `entries` (ghostFrames) of `take`: body poses under `placement` (the rig's parent world
	 * matrix), carried records at their tracked pose in `propTake` ({ frameCount, fps, objectTracks })
	 * over the authored `objects`. A slot re-poses only when its frame or take changed.
	 */
	update({ entries, take, placement, propTake, objects, count }) {
		if (placement) { this.body.matrix.copy(placement); this.body.matrixWorldNeedsUpdate = true; }
		if (!this.rig || !take) entries = [];
		while (this.slots.length < entries.length) this.addSlot();
		const t0 = performance.now();
		let posed = 0, lookup = null;
		this.slots.forEach((slot, i) => {
			const entry = entries[i];
			slot.rig.visible = slot.props.visible = !!entry;
			if (!entry) return;
			const look = ghostLook(entry.side, entry.rank, count);
			slot.material.color.set(look.color).multiplyScalar(1.3);
			slot.material.opacity = look.opacity;
			this.setOrder(slot, GHOST_ORDER + 2 * i);
			if (slot.f === entry.f && slot.take === take && slot.tracks === propTake?.objectTracks) return;
			Object.assign(slot, { f: entry.f, take, tracks: propTake?.objectTracks });
			applyTakeFrame(slot.rig, take, entry.f);
			if (slot.records.length) lookup ??= new Map(objects.map((o) => [o.id, o]));
			for (const record of slot.records) {
				const world = trackShown(record.id, entry.f, propTake, lookup) ? sceneObjectTravelMatrixAt(lookup, record.id, entry.f, propTake, record.group.matrix) : null;
				// A record that does not travel stands where the real one is: no ghost.
				record.group.visible = !!world;
				record.group.matrixWorldNeedsUpdate = true;
			}
			posed += 1;
		});
		if (posed) { this.stats.poses += posed; this.stats.poseMs = +(performance.now() - t0).toFixed(3); }
	}

	clear() {
		for (const slot of this.slots) {
			slot.material.dispose();
			slot.rig.traverse((node) => { if (node.isSkinnedMesh) node.skeleton.dispose(); });
			this.body.remove(slot.rig);
			this.props.remove(slot.props);
		}
		this.slots = [];
	}

	dispose() {
		this.clear();
		this.depthMaterial.dispose();
		this.rig = null;
		this.sources = [];
		this.sourceTake = this.sourceObjects = null;
	}
}

const captureSets = new WeakMap();
const sceneOf = (node) => { while (node?.parent) node = node.parent; return node; };

/**
 * Draw ghosts into one capture (verify_result contact_sheet ghosts: true): the poses
 * sheetGhostSettings asks for around `frame`, on layer 0 for the duration of `render()` only.
 * Answers render()'s value; without a rig in a scene or a take v3 it just renders.
 */
export function renderWithGhosts({ rig, take, objects = [] }, frame, render) {
	const scene = sceneOf(rig);
	if (take?.schema !== "cozyclay.take.v3" || !scene?.isScene) return render();
	const settings = sheetGhostSettings();
	let set = captureSets.get(rig);
	if (!set) { set = new GhostSet({ layer: 0 }); set.setRig(rig); captureSets.set(rig, set); }
	set.syncSources(scene, objects, take);
	rig.parent?.updateWorldMatrix(true, false);
	const entries = ghostFrames({ frame, last: take.frameCount - 1, ...settings, keyFrames: settings.mode === "keys" ? takeKeyFrames(take, objects) : [] });
	set.update({ entries, take, placement: rig.parent?.matrixWorld, propTake: { frameCount: take.frameCount, fps: take.fps, objectTracks: takeTracks(take) }, objects, count: settings.count });
	scene.add(set.object);
	try { return render(); } finally { scene.remove(set.object); }
}
