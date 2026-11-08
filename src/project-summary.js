// What the start screen's Recent work list shows about a project without
// opening it: its scene and shot counts and how it was made. Stored on the
// recents record at open/save time; a record from before that is read once
// from its file when the browser still holds permission for it.
import { queryHandlePermission, readProjectDocument, readProjectFile } from "./project.js";

export function projectSummary(project) {
	// Scenes sit in a scenes document ({ version, activeSceneId, scenes }): `scenes`
	// in the file, `scenesDocument` once readProjectDocument has read it.
	const document = project?.scenesDocument ?? project?.scenes;
	const scenes = Array.isArray(document?.scenes) ? document.scenes : [];
	return {
		scenes: scenes.length,
		shots: scenes.reduce((total, scene) => total + (Array.isArray(scene?.shotDocument?.shots) ? scene.shotDocument.shots.length : 0), 0),
		previsMode: typeof project?.previsMode === "string" ? project.previsMode : null,
		castStyle: typeof project?.castStyle === "string" ? project.castStyle : null,
	};
}

export function serializedSummary(serialized) {
	try {
		return projectSummary(JSON.parse(serialized));
	} catch {
		return null;
	}
}

// Never prompts: a handle that is not already granted stays unread.
export async function summarizeHandle(handle) {
	if (!handle || (await queryHandlePermission(handle)) !== "granted") return null;
	try {
		const result = readProjectDocument((await readProjectFile(handle)).text);
		return result.ok ? projectSummary(result.project) : null;
	} catch {
		return null;
	}
}
