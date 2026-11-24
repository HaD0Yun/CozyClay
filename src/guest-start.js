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
// A load that finds a stored scene document without a session (an unnamed draft autosaves its scenes without one, and
// project.new would replace it) opens that draft as it is.
import { loadProjectSession } from "./project.js";
import { LEGACY_SCENE_STORAGE_KEY, LEGACY_SCENES_STORAGE_KEYS, SCENES_STORAGE_KEY } from "./scenes.js";

const SCENE_DOCUMENT_KEYS = [SCENES_STORAGE_KEY, ...LEGACY_SCENES_STORAGE_KEYS, LEGACY_SCENE_STORAGE_KEY];

function hasStoredScenes(storage) {
	try {
		return SCENE_DOCUMENT_KEYS.some((key) => storage?.getItem(key));
	} catch {
		return false;
	}
}

/** True when this load is a first open: nothing is stored for this address, and it asks for no embed and no scene. */
export function firstOpen(location = globalThis.location, storage = globalThis.localStorage) {
	const params = new URLSearchParams(location?.search ?? "");
	return !(params.has("embed") || params.has("scene") || loadProjectSession(storage)?.name || hasStoredScenes(storage));
}

/** True when this load is a first open that also gets the walking character and the camera tutorial. */
export function guestStart(location = globalThis.location, storage = globalThis.localStorage) {
	return firstOpen(location, storage) && (location?.protocol === "https:" || new URLSearchParams(location?.search ?? "").has("try"));
}
