// Playground mode (?embed=playground): a page hosted outside this repo can
// frame the Studio in an iframe with a preset scene, so a visitor can fly the
// camera before installing anything. Nothing here touches storage — such an
// iframe shares the origin with /app/, and a visitor poking at the
// playground must never overwrite scenes they authored in the real studio.

import { readProjectDocument } from "./project.js";
import { migrateScenesDocument as migrateToCurrentScenes } from "./scenes.js";
import { resolveSceneParam } from "./starter-scenes.js";

const PLAYGROUND_EMBED = "playground";
const PLAYGROUND_GLOBAL = "__cozyclayPlayground";

export function isPlaygroundEmbed(search) {
	return new URLSearchParams(search ?? "").get("embed") === PLAYGROUND_EMBED;
}

/** `?scene=` is a same-origin path only (`/scenes/foo.cclayproject`): the
 * landing page owns which preset loads, never a third-party URL. */
export function playgroundSceneUrl(search) {
	return resolveSceneParam(new URLSearchParams(search ?? "").get("scene"));
}

/** The same fetch, returning the whole project (name, scenes, poses, layout)
 * for the full studio to open as a project rather than a read-only preset. */
export async function fetchSceneProject(url) {
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const result = readProjectDocument(await response.text());
		return result.ok ? result.project : null;
	} catch {
		return null;
	}
}

/** Fetch and validate the preset; returns the scene document or null. */
export async function fetchPlaygroundProject(url) {
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const result = readProjectDocument(await response.text());
		if (!result.ok) return null;
		const source = result.project.scenesDocument;
		const document = migrateToCurrentScenes(source);
		return { name: result.project.name, document };
	} catch {
		return null;
	}
}

export function stashPlaygroundProject(project) {
	globalThis[PLAYGROUND_GLOBAL] = project;
}

export function takePlaygroundProject() {
	const project = globalThis[PLAYGROUND_GLOBAL];
	return project && typeof project === "object" && project.document ? project : null;
}
