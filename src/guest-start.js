// Guest start: a first visit to the hosted Studio opens on a ready stage, with a character walking on it and the
// camera tutorial open (guest-start-mount.jsx), instead of the project chooser. A visitor who pressed "Try it" on the
// landing page came to try the Studio, and a dialog asking for a project name and a storage folder before anything
// is on screen is a decision they cannot make yet. The project is a normal one ("Untitled Project" in the browser
// store): it saves, renames and exports like any other, and File > New or Open still reach the chooser.
//
// It applies when there is no project session and no stored scene document yet (an unnamed draft autosaves its scenes
// without a session, and project.new would replace it) and the page is hosted (https) or asks for it with `?try`
// (`npx cozyclay` and a checkout serve http, and keep the chooser: there the author usually opens a file).
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

/** True when this load should skip the project chooser and start a guest project. */
export function guestStart(location = globalThis.location, storage = globalThis.localStorage) {
	const params = new URLSearchParams(location?.search ?? "");
	if (params.has("embed") || params.has("scene") || loadProjectSession(storage)?.name || hasStoredScenes(storage)) return false;
	return location?.protocol === "https:" || params.has("try");
}
