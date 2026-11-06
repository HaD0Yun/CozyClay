import { createProjectDocument } from "../src/project.js";

/**
 * The memory-only camera inside a saved project (#861).
 *
 * Without an editor the shot camera lives only in the MCP state, which the
 * scene document does not carry. It rides the active scene's stage as one
 * extra key: createSceneStage keeps unknown stage keys losslessly, so the
 * studio passes it through untouched and `open_project` reads it back here.
 */
const STAGE_KEY = "authoringCamera";
const FIELDS = ["x", "y", "z", "focalMm"];

/** A copy of `document` whose active scene's stage records `camera`. */
export function documentWithCamera(document, camera) {
	const record = Object.fromEntries(FIELDS.map((key) => [key, camera[key]]));
	if (!FIELDS.every((key) => Number.isFinite(record[key]))) return document;
	return {
		...document,
		scenes: document.scenes.map((scene) => scene.id === document.activeSceneId
			? { ...scene, stage: { ...scene.stage, [STAGE_KEY]: record } }
			: scene),
	};
}

/** Split a loaded document into the camera saved with its active scene (null
 * when it has none) and the document without that key, so the open scene is
 * exactly the one that was saved and the camera lives only in the MCP state. */
export function splitSavedCamera(document) {
	const scene = document.scenes.find((entry) => entry.id === document.activeSceneId) ?? document.scenes[0];
	const record = scene?.stage?.[STAGE_KEY];
	const valid = !!record && typeof record === "object"
		&& FIELDS.every((key) => Number.isFinite(record[key])) && record.focalMm > 0;
	return {
		camera: valid ? Object.fromEntries(FIELDS.map((key) => [key, record[key]])) : null,
		document: {
			...document,
			scenes: document.scenes.map((entry) => {
				if (!entry?.stage || !Object.hasOwn(entry.stage, STAGE_KEY)) return entry;
				const { [STAGE_KEY]: _saved, ...stage } = entry.stage;
				return { ...entry, stage };
			}),
		},
	};
}

/** Shared project envelope and camera persistence for terminal saves. */
export function serializeSavedProject({ document, camera = {}, name, workspaceLayout = null, customPoses = [], ...metadata }) {
	return JSON.stringify(createProjectDocument({
		...metadata,
		scenesDocument: documentWithCamera(document, camera),
		workspaceLayout, customPoses, name,
	}), null, "\t");
}
