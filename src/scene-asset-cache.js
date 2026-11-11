/**
 * The bridge between stored asset bytes and a texture the set can wear.
 *
 * A cutout record holds an `assetId` and nothing else, so something has to
 * turn that id into a THREE.Texture exactly once per session: the same picture
 * on two cards, or on cards in two scenes, is one decode and one upload.
 *
 * Loading is async and the renderer is not, so `useAssetTexture` (props.jsx)
 * subscribes and re-renders when the texture lands. A card with no texture yet
 * draws as a blank placeholder rather than popping into existence — the
 * geometry is already correct, and that is what blocking needs first.
 */

import * as THREE from "three";
import { getAsset, isMeshAssetId, isSupportedMeshType, openAssetDb, putAsset } from "./scene-assets.js";

/** Mesh blobs live in the same store as pictures. They must never reach
 * `createImageBitmap`: a GLB is not an image, and decoding one would throw
 * (or worse, hang) on every mistaken load. */
function isMeshRecord(asset) {
	if (!asset) return false;
	if (typeof asset.id === "string" && isMeshAssetId(asset.id)) return true;
	return isSupportedMeshType(asset.type);
}

/** Build a cache with injectable browser seams for deterministic race tests. */
export function createAssetTextureCache({
	getRecord = async (id) => getAsset(await db(), id),
	putRecord = async (asset) => putAsset(await db(), asset),
	createBitmap = (...args) => createImageBitmap(...args),
	makeTexture = (bitmap) => new THREE.Texture(bitmap),
} = {}) {
	/** id → { texture, record, promise, listeners, generation } */
	const entries = new Map();

	function entryFor(id) {
		let entry = entries.get(id);
		if (!entry) {
			entry = { texture: null, record: null, promise: null, listeners: new Set(), generation: 0, evicted: false };
			entries.set(id, entry);
		}
		return entry;
	}

	function announce(entry) {
		for (const listener of entry.listeners) listener(entry.texture);
	}

	function dispose(texture) {
		texture?.image?.close?.();
		texture?.dispose?.();
	}

	/** A texture from asset bytes. ImageBitmap ignores Texture.flipY, so the
	 * flip is asked of the decoder instead. */
	async function textureFromAsset(asset) {
		if (isMeshRecord(asset)) return null;
		const bitmap = await createBitmap(new Blob([asset.bytes], { type: asset.type }), { imageOrientation: "flipY" });
		const texture = makeTexture(bitmap);
		texture.flipY = false;
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.generateMipmaps = true;
		texture.minFilter = THREE.LinearMipmapLinearFilter;
		texture.magFilter = THREE.LinearFilter;
		texture.anisotropy = 4;
		texture.needsUpdate = true;
		texture.userData.assetId = asset.id;
		return texture;
	}

	/** The texture for this id, decoded once and shared. */
	function loadAssetTexture(id) {
		if (typeof id !== "string" || !id) return Promise.resolve(null);
		// Mesh ids share the asset store. A mistaken subscribe must not decode
		// GLB bytes as a bitmap — that is the mesh cache's job.
		if (isMeshAssetId(id)) return Promise.resolve(null);
		const entry = entryFor(id);
		if (entry.evicted) return Promise.resolve(null);
		if (entry.texture) return Promise.resolve(entry.texture);
		if (!entry.promise) {
			const generation = entry.generation;
			entry.promise = (async () => {
				const asset = entry.record ?? (await getRecord(id));
				if (!asset || entry.evicted || entry.generation !== generation) return null;
				if (isMeshRecord(asset)) return null;
				entry.record = asset;
				const texture = await textureFromAsset(asset);
				if (entry.evicted || entry.generation !== generation) {
					dispose(texture);
					return null;
				}
				entry.texture = texture;
				announce(entry);
				return texture;
			})().catch((error) => {
				console.warn(`[cozyclay] could not load image asset ${id}`, error);
				// Mark the failure so callers can distinguish "gone" from "decode
				// failed" and offer a retry instead of a forever-grey card.
				entry.failed = true;
				return null;
			}).finally(() => {
				// Never let an old, invalidated promise block a later rehydration.
				if (entry.generation === generation) entry.promise = null;
			});
		}
		return entry.promise;
	}

	/** The stored record behind an id — the bytes, not the texture. */
	async function assetRecord(id) {
		if (typeof id !== "string" || !id) return null;
		const entry = entryFor(id);
		if (entry.evicted) return null;
		if (entry.record) return entry.record;
		entry.record = await getRecord(id);
		return entry.record;
	}

	/** Warm the cache with an asset that is already in hand. */
	async function rememberAsset(asset) {
		const stored = await putRecord(asset);
		const entry = entryFor(stored.id);
		const generation = ++entry.generation;
		entry.evicted = false;
		dispose(entry.texture);
		entry.texture = null;
		entry.record = stored;
		entry.promise = null;
		// A GLB in this function would always hit createImageBitmap. Mesh import
		// stores bytes with putAsset and leaves textures alone.
		if (isMeshRecord(stored)) return stored;
		const texture = await textureFromAsset(stored);
		if (!texture || entry.generation !== generation) {
			dispose(texture);
			return stored;
		}
		entry.texture = texture;
		announce(entry);
		return stored;
	}

	/** Forget deleted bytes without dropping mounted subscribers. */
	function evictAssetTexture(id) {
		const entry = entries.get(id);
		if (!entry) return;
		entry.generation += 1;
		entry.evicted = true;
		dispose(entry.texture);
		entry.texture = null;
		entry.record = null;
		entry.promise = null;
		announce(entry);
	}

	/** Subscribe to one id; returns an unsubscribe. */
	function subscribeToAssetTexture(id, listener) {
		if (typeof id !== "string" || !id) return () => {};
		const entry = entryFor(id);
		entry.listeners.add(listener);
		if (entry.texture) listener(entry.texture);
		else loadAssetTexture(id);
		return () => entry.listeners.delete(listener);
	}

	/** Drop everything (a test harness, or a hard document reload). */
	function clearAssetTextures() {
		for (const entry of entries.values()) dispose(entry.texture);
		entries.clear();
	}

	return { loadAssetTexture, assetRecord, rememberAsset, evictAssetTexture, subscribeToAssetTexture, clearAssetTextures };
}

let dbPromise = null;
function db() {
	if (!dbPromise) dbPromise = openAssetDb();
	return dbPromise;
}

const cache = createAssetTextureCache();
export const assetRecord = cache.assetRecord;
export const rememberAsset = cache.rememberAsset;
export const evictAssetTexture = cache.evictAssetTexture;
export const subscribeToAssetTexture = cache.subscribeToAssetTexture;
