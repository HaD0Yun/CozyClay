// First open: a load with nothing stored for this address yet (no project session, no scene document) goes straight
// to the stage, in a normal project ("Untitled Project" in the browser store: it saves, renames and exports like any
// other), instead of the project chooser. A dialog asking for a project name and a storage folder before anything is on
// screen is a decision a first visitor cannot make yet; File > New and Open still reach the chooser.
//
// Guest start is the first open of the hosted Studio (https), or of any address that asks for it with `?try`: the
// stage also gets a character walking on it and the camera tutorial (guest-start-mount.jsx). A visitor who pressed
// "Try it" on the landing page came to try the Studio. `npx cozyclay` and a checkout serve http: their first open is
// the empty stage.
//
// A load that finds the author's work stored without a session opens it as it is: a scene document (an unnamed draft
// autosaves its scenes without one), or a workflow graph with nodes in it (made on the Workflow page, which shares the
// address). project.new would replace either.
//
// A first open lasts until its project exists. The Studio stores its still-empty scene 400 ms after it mounts, and a
// guest is first asked for a language, which may reload the page: a mark kept for the tab (sessionStorage) says the
// first open has begun, so that stored scene and that reload do not end it.
import { loadProjectSession, loadWorkflowGraph } from "./project.js";
import { LEGACY_SCENE_STORAGE_KEY, LEGACY_SCENES_STORAGE_KEYS, SCENES_STORAGE_KEY } from "./scenes.js";

const SCENE_DOCUMENT_KEYS = [SCENES_STORAGE_KEY, ...LEGACY_SCENES_STORAGE_KEYS, LEGACY_SCENE_STORAGE_KEY];
const BEGUN_KEY = "cozyclay.first-open.begun";

function hasStoredScenes(storage) {
	try {
		return SCENE_DOCUMENT_KEYS.some((key) => storage?.getItem(key));
	} catch {
		return false;
	}
}

function begun(tab) {
	try {
		return tab?.getItem(BEGUN_KEY) === "1";
	} catch {
		return false;
	}
}

/**
 * True when this load is a first open: it asks for no embed and no scene, no project session is stored, and none of
 * the author's work is (a scene document, a workflow graph with nodes). A first open this tab has begun stays one
 * past the scene the Studio itself stored meanwhile.
 */
export function firstOpen(location = globalThis.location, storage = globalThis.localStorage, tab = globalThis.sessionStorage) {
	const params = new URLSearchParams(location?.search ?? "");
	if (params.has("embed") || params.has("scene") || loadProjectSession(storage)?.name) return false;
	return loadWorkflowGraph(storage).nodes.length === 0 && (begun(tab) || !hasStoredScenes(storage));
}

/** Marks this tab's first open as begun (`true`), or as over once its project exists (`false`). */
export function holdFirstOpen(held, tab = globalThis.sessionStorage) {
	try {
		if (held) tab?.setItem(BEGUN_KEY, "1");
		else tab?.removeItem(BEGUN_KEY);
	} catch { /* without the mark a first open ends at the Studio's first save, as an unnamed draft */ }
}

/** True when this load is a first open that also gets the walking character and the camera tutorial. */
export function guestStart(location = globalThis.location, storage = globalThis.localStorage, tab = globalThis.sessionStorage) {
	return firstOpen(location, storage, tab) && (location?.protocol === "https:" || new URLSearchParams(location?.search ?? "").has("try"));
}
