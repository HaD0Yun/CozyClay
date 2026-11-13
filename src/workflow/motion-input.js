import { SCENES_STORAGE_KEY, readSceneDocument } from "../scenes.js";
import { characterName } from "../character-name.js";

const MOTION_INPUT_NODE_TYPE = "motion-input";
const MOTION_INPUT_NODE_VERSION = 2;

function text(value, fallback = "") {
	return typeof value === "string" ? value : fallback;
}

function clone(value) {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(clone);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

const SPEC_SCHEMA = "cozyclay.motion-spec.v1";
const specOf = value => value && typeof value === "object" && !Array.isArray(value) && value.schema === SPEC_SCHEMA && Number.isFinite(value.frames) ? value : null;

/** Normalize a Motion Input node's serializable state: a CozyClay 3 motion spec (the JSON an
 * agent writes for motion.compile) and the character it drives. */
export function normalizeMotionInputData(input = {}) {
	const source = input && typeof input === "object" ? input : {};
	const spec = specOf(source.spec);
	const characterId = text(source.characterId || source.targetCharacterId, "");
	return {
		type: MOTION_INPUT_NODE_TYPE,
		version: MOTION_INPUT_NODE_VERSION,
		label: text(source.label, "Motion Input"),
		fileName: text(source.fileName),
		characterId,
		status: spec ? "ready" : text(source.status) === "error" ? "error" : "idle",
		spec: spec ? clone(spec) : null,
		frames: spec ? Math.round(spec.frames) : null,
		fps: spec ? 24 : null,
	};
}

/** Parse a motion spec file's text; null when it is not a cozyclay.motion-spec.v1. */
export function parseMotionSpec(textValue) {
	try { return specOf(JSON.parse(textValue)); } catch { return null; }
}

export function characterHandleId(characterId) {
	const id = text(characterId).trim();
	return id ? `character:${id}` : "character";
}

export function characterIdFromHandle(handle) {
	const value = text(handle).trim();
	return value.startsWith("character:") ? value.slice("character:".length) || null : null;
}

export function motionInputOutput(input = {}) {
	const data = normalizeMotionInputData(input);
	return {
		type: MOTION_INPUT_NODE_TYPE,
		version: MOTION_INPUT_NODE_VERSION,
		fileName: data.fileName || null,
		characterId: data.characterId || null,
		handle: data.characterId ? characterHandleId(data.characterId) : null,
		frames: data.frames,
		fps: data.fps,
		spec: data.spec,
	};
}

/** Return active-scene cast entries without coupling the workflow UI to App. */
export function activeSceneCharacters(storage = globalThis.localStorage) {
	try {
		const raw = storage?.getItem(SCENES_STORAGE_KEY);
		const result = readSceneDocument(raw);
		const scene = result.document?.scenes?.find((entry) => entry.id === result.document.activeSceneId) || result.document?.scenes?.[0];
		return Array.isArray(scene?.stage?.characters)
			? scene.stage.characters.filter((entry) => entry && typeof entry.id === "string" && entry.id).map((entry) => ({ id: entry.id, name: characterName(entry), model: entry.model || null }))
			: [];
	} catch {
		return [];
	}
}

/** Convert connected Scene handles to the character ids they address. */
export function connectedCharacterIds(edges = [], sceneId) {
	if (!Array.isArray(edges)) return [];
	return [...new Set(edges.filter((edge) => edge?.target === sceneId).map((edge) => characterIdFromHandle(edge.targetHandle)).filter(Boolean))];
}

