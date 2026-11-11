/**
 * The bridge between stored GLB bytes and a three.js graph the set can clone.
 *
 * A mesh record holds an `assetId` and a fitted box, so something has to turn
 * that id into a parsed scene exactly once per session: two instances of the
 * same file, or the same file in two scenes, share one decode. The renderer
 * clones per instance so transforms and clay materials never leak across
 * copies.
 *
 * Loading is async and the renderer is not, so `ImportedMesh` (props.jsx)
 * subscribes and re-renders when the graph lands. A prop with no graph yet
 * draws as a grey box of the stored footprint × height — the collision size
 * is already correct, which is what blocking needs first.
 */

import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { getAsset, isMeshAssetId, isSupportedMeshType, openAssetDb } from "./scene-assets.js";
import { decodeObjText } from "./scene-mesh.js";
import { arrayBufferOf } from "./scene-fbx.js";

// three.js owns the bundled decoder URLs, including the Vite-emitted WASM.
// Reuse one Draco worker pool for every imported asset.
const gltfLoader = new GLTFLoader().setDRACOLoader(new DRACOLoader()).setMeshoptDecoder(MeshoptDecoder);

/** Build a cache with injectable seams for deterministic tests. */
export function createMeshSceneCache({
	getRecord = async (id) => getAsset(await db(), id),
	parseGlb = (bytes) => gltfLoader.parseAsync(arrayBufferOf(bytes), ""),
	parseObj = (text) => new OBJLoader().parse(text),
	parseFbx = (bytes) => new FBXLoader().parse(arrayBufferOf(bytes), ""),
} = {}) {
	/** id → { scene, promise, listeners, generation, evicted, failed } */
	const entries = new Map();

	function entryFor(id) {
		let entry = entries.get(id);
		if (!entry) {
			entry = { scene: null, promise: null, listeners: new Set(), generation: 0, evicted: false, failed: false };
			entries.set(id, entry);
		}
		return entry;
	}

	function announce(entry) {
		for (const listener of entry.listeners) listener(entry.scene);
	}

	/** The parsed scene for this id, decoded once and shared. Callers must
	 * clone before they fit, clay-tint or parent — the cached graph is the
	 * original materials and the file's own pivot. `record` (the asset itself)
	 * parses bytes not stored yet, so an import can check them before saving. */
	function loadMeshScene(id, record = null) {
		if (typeof id !== "string" || !id) return Promise.resolve(null);
		const entry = entryFor(id);
		if (entry.evicted) return Promise.resolve(null);
		if (entry.scene) return Promise.resolve(entry.scene);
		if (!entry.promise) {
			const generation = entry.generation;
			entry.promise = (async () => {
				const asset = entry.record ?? record ?? (await getRecord(id));
				if (!asset || entry.evicted || entry.generation !== generation) return null;
				// A picture id that wandered in here has nothing to parse; skip
				// rather than handing PNG bytes to a mesh loader.
				const type = String(asset.type ?? "").toLowerCase();
				if (!isMeshAssetId(asset.id) && !isSupportedMeshType(asset.type)) {
					return null;
				}
				entry.record = asset;
				let scene = null;
				if (type === "model/obj") {
					scene = await parseObj(decodeObjText(asset.bytes));
				} else if (type === "model/fbx") {
					scene = await parseFbx(asset.bytes);
				} else if (type === "model/gltf-binary") {
					const gltf = await parseGlb(asset.bytes);
					scene = gltf?.scene ?? null;
				} else {
					return null;
				}
				if (!scene || entry.evicted || entry.generation !== generation) return null;
				entry.scene = scene;
				entry.failed = false;
				announce(entry);
				return scene;
			})().catch((error) => {
				console.warn(`[cozyclay] could not load mesh asset ${id}`, error);
				entry.failed = true;
				return null;
			}).finally(() => {
				if (entry.generation === generation) entry.promise = null;
			});
		}
		return entry.promise;
	}

	/** Subscribe to one id; returns an unsubscribe. The listener receives the
	 * cached original (or null while loading / missing) and must clone it. */
	function subscribeToMeshScene(id, listener) {
		if (typeof id !== "string" || !id) return () => {};
		const entry = entryFor(id);
		entry.listeners.add(listener);
		if (entry.scene) listener(entry.scene);
		else loadMeshScene(id);
		return () => entry.listeners.delete(listener);
	}

	/** Forget deleted bytes without dropping mounted subscribers. */
	function evictMeshScene(id) {
		const entry = entries.get(id);
		if (!entry) return;
		entry.generation += 1;
		entry.evicted = true;
		entry.scene = null;
		entry.record = null;
		entry.promise = null;
		entry.failed = false;
		announce(entry);
	}

	/** Drop everything (a test harness, or a hard document reload). */
	function clearMeshScenes() {
		entries.clear();
	}

	return { loadMeshScene, subscribeToMeshScene, evictMeshScene, clearMeshScenes };
}

let dbPromise = null;
function db() {
	if (!dbPromise) dbPromise = openAssetDb();
	return dbPromise;
}

const cache = createMeshSceneCache();
export const loadMeshScene = cache.loadMeshScene;
export const subscribeToMeshScene = cache.subscribeToMeshScene;
export const evictMeshScene = cache.evictMeshScene;
