/**
 * Local workflow -> Studio scene adapter.
 *
 * Workflow runs in its own route, so it cannot call the Studio's React state
 * directly.  This module keeps the crossing small and boring: image bytes go
 * through the existing content-addressed asset store, then a pure scene patch
 * adds one cutout to the active scene.  The write is announced in the same tab
 * with a CustomEvent and in other tabs through the normal storage event.
 */

import {
	ASSET_MAX_DIMENSION,
	assetAspect,
	importImageFile,
	isImageAssetId,
} from "../scene-assets.js";
import { rememberAsset } from "../scene-asset-cache.js";
import { motionScene } from "../motion3/scene.js";
import { CUTOUT_DEFAULT_HEIGHT, createCutoutObject } from "../scene-objects.js";
import {
	SCENES_STORAGE_KEY,
	SCENES_VERSION,
	activeSceneIndex,
	createSceneDocument,
	readSceneDocument,
	serializeSceneDocument,
} from "../scenes.js";

export const SCENE_SYNC_EVENT = "cozyclay:scene-change";
export const SCENE_PLAYBACK_STORAGE_KEY = "cozyclay.scene-playback.v1";
export const SCENE_PLAYBACK_EVENT = "cozyclay:scene-playback";

function objectHasAsset(object, assetId) {
	if (!object || typeof object !== "object") return false;
	return [object.assetId, object.sourceAssetId, object.matteAssetId].includes(assetId);
}

/**
 * Add an imported image as a cutout in the active scene.
 *
 * The same content-addressed id is intentionally idempotent: dropping the
 * same file twice gives one card, just as importing it twice gives one asset in
 * IndexedDB.  The returned object is detached and safe to persist.
 */
export function appendAssetCutout(document, asset, {
	height = CUTOUT_DEFAULT_HEIGHT,
	placement = {},
	name = asset?.name,
} = {}) {
	if (!asset || !isImageAssetId(asset.id)) return { document, object: null, changed: false, reason: "invalid-asset" };
	const source = document && typeof document === "object" ? document : createSceneDocument();
	const scenes = Array.isArray(source.scenes) ? source.scenes : [];
	const index = activeSceneIndex(scenes, source.activeSceneId);
	if (index < 0 || !scenes[index]) return { document: source, object: null, changed: false, reason: "no-active-scene" };
	const scene = scenes[index];
	const objects = Array.isArray(scene.objects) ? scene.objects : [];
	if (objects.some((object) => objectHasAsset(object, asset.id))) {
		return { document: source, object: null, changed: false, reason: "already-in-scene" };
	}
	const object = createCutoutObject({
		assetId: asset.id,
		aspect: assetAspect(asset) ?? 1,
		height,
		name,
	}, objects, placement);
	if (!object) return { document: source, object: null, changed: false, reason: "cutout-failed" };
	const nextScenes = scenes.map((entry, sceneIndex) => sceneIndex === index ? { ...entry, objects: [...objects, object] } : entry);
	return {
		document: { ...source, version: Number.isInteger(source.version) ? source.version : SCENES_VERSION, scenes: nextScenes },
		object,
		changed: true,
		reason: "added",
	};
}

/** Give one cast member a Motion Input's spec as its saved take source (what motion.compile
 * installs and the Studio compiles again on load), keeping every unrelated scene field. */
export function applyMotionToCharacter(document, characterId, motion = {}) {
	if (typeof characterId !== "string" || !characterId.trim() || !motion || typeof motion !== "object") return { document, changed: false, reason: "invalid-motion" };
	const source = document && typeof document === "object" ? document : createSceneDocument();
	const scenes = Array.isArray(source.scenes) ? source.scenes : [];
	const index = activeSceneIndex(scenes, source.activeSceneId);
	if (index < 0 || !scenes[index]) return { document: source, changed: false, reason: "no-active-scene" };
	const scene = scenes[index];
	const stage = scene.stage && typeof scene.stage === "object" ? scene.stage : {};
	const characters = Array.isArray(stage.characters) ? stage.characters : [];
	const target = characters.find((entry) => entry?.id === characterId);
	if (!target) return { document: source, changed: false, reason: "character-not-found" };
	if (motion.spec?.schema !== "cozyclay.motion-spec.v1") return { document: source, changed: false, reason: "motion-spec-missing" };
	const motionTake = { schema: "cozyclay.take.v3", rig: target.model || "x-bot-tpose", spec: motion.spec,
		placement: { position: [target.x ?? 0, target.y ?? 0, target.z ?? 0], yaw: target.rot ?? 0 }, scene: motionScene(Array.isArray(scene.objects) ? scene.objects : []) };
	const nextCharacters = characters.map((entry) => entry?.id === characterId ? { ...entry, motionTake } : entry);
	const nextScene = { ...scene, stage: { ...stage, characters: nextCharacters } };
	return { document: { ...source, scenes: scenes.map((entry, sceneIndex) => sceneIndex === index ? nextScene : entry) }, changed: true, reason: "updated", characterId, motionTake };
}

/** Persist a Motion Input assignment and notify Studio listeners. */
export function applyMotionToActiveScene(characterId, motion, options = {}) {
	const current = options.document ?? readStoredSceneDocument(options.storage);
	const result = applyMotionToCharacter(current, characterId, motion);
	if (result.changed) publishSceneDocument(result.document, options);
	return result;
}

/** Read and migrate the scene envelope currently stored by Studio. */
export function readStoredSceneDocument(storage = globalThis.localStorage) {
	const raw = storage?.getItem?.(SCENES_STORAGE_KEY) ?? null;
	return readSceneDocument(raw).document;
}

/** Persist a scene envelope and notify both local and remote Studio tabs. */
function publishSceneDocument(document, {
	storage = globalThis.localStorage,
	target = globalThis,
} = {}) {
	const payload = document && typeof document === "object" ? document : createSceneDocument();
	const serialized = serializeSceneDocument(payload);
	try {
		storage?.setItem?.(SCENES_STORAGE_KEY, serialized);
	} catch {
		// A full/private localStorage must not prevent the open Studio tab from
		// seeing the same-tab edit; its own persistence layer can report the error.
	}
	try {
		target?.dispatchEvent?.(new CustomEvent(SCENE_SYNC_EVENT, { detail: payload }));
	} catch {
		// CustomEvent is unavailable in node/test hosts; storage remains durable.
	}
	return payload;
}

/** Subscribe to same-tab CustomEvents and cross-tab storage updates. */
export function subscribeToSceneDocuments(onDocument, {
	target = globalThis,
} = {}) {
	if (typeof onDocument !== "function") return () => {};
	const onCustom = (event) => {
		const document = event?.detail;
		if (document && typeof document === "object") onDocument(document, { source: "same-tab" });
	};
	const onStorage = (event) => {
		if (event?.key !== SCENES_STORAGE_KEY || !event.newValue) return;
		const parsed = readSceneDocument(event.newValue);
		// A malformed or future document must never make a healthy Studio tab
		// fall back to a blank default scene. The normal scene loader quarantines
		// corrupt bytes; cross-tab listeners simply ignore them.
		if (parsed.status === "corrupt" || parsed.status === "future" || !parsed.document) return;
		onDocument(parsed.document, { source: "storage" });
	};
	target?.addEventListener?.(SCENE_SYNC_EVENT, onCustom);
	target?.addEventListener?.("storage", onStorage);
	return () => {
		target?.removeEventListener?.(SCENE_SYNC_EVENT, onCustom);
		target?.removeEventListener?.("storage", onStorage);
	};
}

/** Send a transient workflow playback command to the matching Studio scene. */
export function publishScenePlayback(command, {
	storage = globalThis.localStorage,
	target = globalThis,
	} = {}) {
	const payload = {
		activeSceneId: typeof command?.activeSceneId === "string" ? command.activeSceneId : null,
		frame: Number.isFinite(Number(command?.frame)) ? Math.max(0, Math.round(Number(command.frame))) : null,
		playing: typeof command?.playing === "boolean" ? command.playing : false,
		issuedAt: Date.now(),
	};
	try { storage?.setItem?.(SCENE_PLAYBACK_STORAGE_KEY, JSON.stringify(payload)); } catch { /* best effort cross-tab transport */ }
	try { target?.dispatchEvent?.(new CustomEvent(SCENE_PLAYBACK_EVENT, { detail: payload })); } catch { /* storage remains available */ }
	return payload;
}

/** Subscribe to transient playback commands from Workflow or another tab. */
export function subscribeToScenePlayback(onCommand, {
	target = globalThis,
	} = {}) {
	if (typeof onCommand !== "function") return () => {};
	const read = (value) => {
		try {
			const command = typeof value === "string" ? JSON.parse(value) : value;
			if (command && typeof command === "object") onCommand(command);
		} catch { /* ignore malformed transient commands */ }
	};
	const onCustom = (event) => read(event?.detail);
	const onStorage = (event) => {
		if (event?.key === SCENE_PLAYBACK_STORAGE_KEY && event.newValue) read(event.newValue);
	};
	target?.addEventListener?.(SCENE_PLAYBACK_EVENT, onCustom);
	target?.addEventListener?.("storage", onStorage);
	return () => {
		target?.removeEventListener?.(SCENE_PLAYBACK_EVENT, onCustom);
		target?.removeEventListener?.("storage", onStorage);
	};
}

/** Import bytes through the canonical asset pipeline and warm the texture cache. */
async function importWorkflowImage(file, {
	importer = importImageFile,
	remember = rememberAsset,
	importOptions,
} = {}) {
	const asset = await importer(file, { maxDimension: ASSET_MAX_DIMENSION, ...(importOptions || {}) });
	return remember(asset);
}

/** Import, store, patch the active scene, and announce the new scene document. */
export async function importImageIntoActiveScene(file, options = {}) {
	const asset = await importWorkflowImage(file, options);
	const current = options.document ?? readStoredSceneDocument(options.storage);
	const result = appendAssetCutout(current, asset, options);
	if (result.changed) publishSceneDocument(result.document, options);
	return { ...result, asset };
}
