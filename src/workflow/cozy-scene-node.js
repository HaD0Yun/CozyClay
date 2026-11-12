/**
 * Data-only adapter for the CozyClay Scene workflow node.
 *
 * This module deliberately knows nothing about React, three.js, or the
 * project document. It is the bridge contract a workflow runner can use to
 * turn a node into a render request and to put a render result back on the
 * node.
 */
import { characterName } from "../character-name.js";

export const COZY_SCENE_NODE_TYPE = "cozyclay-scene";
const COZY_SCENE_NODE_VERSION = 1;

export const COZY_SCENE_INPUTS = Object.freeze([
	{ id: "asset", label: "Asset", kind: "asset" },
	{ id: "motion", label: "Motion", kind: "motion", legacy: true },
]);

const COZY_SCENE_CHARACTER_HANDLE_PREFIX = "character:";

/** Return the stable Scene target handle for a cast member. */
export function sceneCharacterHandle(characterId) {
	const id = typeof characterId === "string" ? characterId.trim() : "";
	return id ? `${COZY_SCENE_CHARACTER_HANDLE_PREFIX}${id}` : null;
}

/** Parse a `character:<id>` target handle, returning null for generic handles. */
export function sceneCharacterIdFromHandle(handle) {
	const value = typeof handle === "string" ? handle.trim() : "";
	if (!value.startsWith(COZY_SCENE_CHARACTER_HANDLE_PREFIX)) return null;
	const id = value.slice(COZY_SCENE_CHARACTER_HANDLE_PREFIX.length).trim();
	return id || null;
}

/** Scene inputs are cast-aware. The legacy generic `motion` handle remains
 * accepted by the data adapter for old project files, while new graphs use
 * one explicit character:<id> handle per active-scene cast member. */
export function sceneInputSpecs(characters = [], { includeLegacyMotion = true } = {}) {
	const hasCharacters = Array.isArray(characters) && characters.length > 0;
	const specs = COZY_SCENE_INPUTS.filter((spec) => !hasCharacters || spec.id !== "motion").map((spec) => ({ ...spec }));
	for (const character of Array.isArray(characters) ? characters : []) {
		const id = typeof character === "string" ? character : character?.id;
		if (!id || specs.some((spec) => spec.id === `character:${id}`)) continue;
		specs.push({ id: `character:${id}`, label: typeof character === "object" ? characterName(character) : id, kind: "motion", characterId: id });
	}
	if (includeLegacyMotion && !hasCharacters && specs.length === 1) specs.push({ id: "motion", label: "Motion", kind: "motion", legacy: true });
	return specs;
}

/** Restrict Scene inputs to values the Scene can actually consume. */
export function sceneConnectionAllowed(source, targetHandle, sourceData = {}) {
	const type = typeof source === "string" ? source : source?.type;
	const handle = typeof targetHandle === "string" ? targetHandle : "";
	if (handle === "asset") return type === "image" || (type === "upload" && String(sourceData?.mimeType || "").toLowerCase().startsWith("image/"));
	if (handle === "motion" || sceneCharacterIdFromHandle(handle)) return type === "motion-input";
	return false;
}

/** Build the Scene input state represented by ReactFlow edges. */
export function sceneInputsFromEdges(edges, sceneNodeId) {
	const assetInputs = [];
	const motionInputs = [];
	const seenAssets = new Set();
	const seenMotion = new Set();
	for (const edge of Array.isArray(edges) ? edges : []) {
		if (!edge || edge.target !== sceneNodeId || typeof edge.source !== "string") continue;
		const targetHandle = typeof edge.targetHandle === "string" ? edge.targetHandle : "";
		if (targetHandle === "asset") {
			if (!seenAssets.has(edge.source)) { seenAssets.add(edge.source); assetInputs.push(edge.source); }
			continue;
		}
		const characterId = sceneCharacterIdFromHandle(targetHandle);
		if (!characterId) continue;
		const key = `${edge.source}\u0000${characterId}`;
		if (seenMotion.has(key)) continue;
		seenMotion.add(key);
		motionInputs.push({ source: edge.source, handle: targetHandle, characterId });
	}
	return { assetInputs, motionInputs };
}

/** The embedded Studio announces the take it holds under this message type. */
export const SCENE_TIMELINE_MESSAGE = "cozyclay:scene-timeline";

/**
 * Turn an embed timeline announcement into the patch it implies for a node.
 *
 * Returns null when the message is not one of ours, carries no usable length,
 * or already matches the node: the caller can then skip the state write, which
 * keeps a chatty embed from re-rendering the canvas on every frame.
 */
export function sceneTimelinePatch(data, message) {
	if (!message || typeof message !== "object" || message.type !== SCENE_TIMELINE_MESSAGE) return null;
	const announced = Number(message.frameCount);
	if (!Number.isFinite(announced) || announced < 1) return null;
	const current = normalizeCozySceneData(data);
	const frameCount = Math.round(announced);
	if (frameCount === current.frameCount) return null;
	// A shorter take must also pull the playhead back inside it, or the slider
	// would report a frame the previs cannot show.
	return { frameCount, frame: Math.min(current.frame, frameCount - 1) };
}

export const COZY_SCENE_OUTPUTS = Object.freeze([
	{ id: "render", label: "Render", kind: "render" },
	{ id: "scene", label: "Scene", kind: "scene" },
]);

const STATUS_VALUES = new Set(["idle", "ready", "running", "complete", "error"]);
const PREVIEW_VALUES = new Set(["placeholder", "scene", "render"]);

function finiteNumber(value, fallback) {
	return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function text(value, fallback = "") {
	return typeof value === "string" ? value : fallback;
}

function list(value) {
	return Array.isArray(value) ? value.filter(Boolean) : [];
}

function characterList(value) {
	return Array.isArray(value)
		? value.filter((entry) => typeof entry === "string" || (entry && typeof entry.id === "string" && entry.id)).map((entry) => typeof entry === "string" ? { id: entry } : { ...entry })
		: [];
}

/** Return a safe, serializable data envelope for a node. */
export function normalizeCozySceneData(input = {}) {
	const source = input && typeof input === "object" ? input : {};
	const controls = source.controls && typeof source.controls === "object" ? source.controls : {};
	const camera = controls.camera && typeof controls.camera === "object" ? controls.camera : {};
	const status = STATUS_VALUES.has(source.status) ? source.status : "idle";
	const preview = PREVIEW_VALUES.has(source.preview) ? source.preview : "placeholder";
	return {
		type: COZY_SCENE_NODE_TYPE,
		version: COZY_SCENE_NODE_VERSION,
		sceneId: text(source.sceneId, null),
		sceneName: text(source.sceneName, "CozyClay Scene"),
		status,
		statusMessage: text(source.statusMessage),
		preview,
		frame: Math.max(0, Math.round(finiteNumber(source.frame, 0))),
		frameCount: Math.max(1, Math.round(finiteNumber(source.frameCount, 120))),
		controls: {
			playing: Boolean(controls.playing),
			camera: {
				yaw: finiteNumber(camera.yaw, 24),
				pitch: finiteNumber(camera.pitch, 12),
			},
			shotAspect: text(camera.shotAspect, "16:9"),
		},
		assetInputs: list(source.assetInputs),
		motionInputs: list(source.motionInputs),
		characterInputs: list(source.characterInputs),
		characters: characterList(source.characters || source.characterOptions),
		lastOutput: source.lastOutput && typeof source.lastOutput === "object" ? { ...source.lastOutput } : null,
	};
}

/** Apply a user or runner patch without mutating the ReactFlow node data. */
export function applyCozyScenePatch(data, patch = {}) {
	const current = normalizeCozySceneData(data);
	const next = { ...current, ...patch };
	if (patch.controls) {
		next.controls = {
			...current.controls,
			...patch.controls,
			camera: { ...current.controls.camera, ...(patch.controls.camera ?? {}) },
		};
	}
	return normalizeCozySceneData(next);
}

/** Advance one preview frame without wrapping past the end of the take. */
export function nextSceneFrame(data) {
	const current = normalizeCozySceneData(data);
	const lastFrame = Math.max(0, current.frameCount - 1);
	if (current.frame >= lastFrame) return { frame: lastFrame, playing: false };
	return { frame: current.frame + 1, playing: true };
}

/** Build the serializable request consumed by a workflow bridge. */
export function toCozySceneRunRequest(node, context = {}) {
	const nodeId = text(node?.id, "cozy-scene");
	const data = normalizeCozySceneData(node?.data ?? node);
	return {
		type: COZY_SCENE_NODE_TYPE,
		version: COZY_SCENE_NODE_VERSION,
		nodeId,
		sceneId: data.sceneId,
		inputs: {
			asset: data.assetInputs,
			motion: data.motionInputs,
			...(data.characterInputs.length ? { characters: data.characterInputs } : {}),
		},
		controls: data.controls,
		frame: data.frame,
		frameCount: data.frameCount,
		context: context && typeof context === "object" ? { ...context } : {},
	};
}

/** Put a bridge result back into the controlled node envelope. */
export function applyCozySceneRunResult(data, result = {}) {
	const source = result && typeof result === "object" ? result : {};
	return applyCozyScenePatch(data, {
		status: source.error ? "error" : "complete",
		statusMessage: text(source.error ?? source.message),
		preview: source.renderUrl ? "render" : "scene",
		lastOutput: {
			renderUrl: text(source.renderUrl, null),
			sceneUrl: text(source.sceneUrl, null),
			jobId: text(source.jobId, null),
		},
	});
}
