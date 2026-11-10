// Guest start: a first visit to the hosted Studio opens on a ready stage, with a character walking on it and the
// camera tutorial open (guest-start-mount.jsx), instead of the project chooser. A visitor who pressed "Try it" on the
// landing page came to try the Studio, and a dialog asking for a project name and a storage folder before anything
// is on screen is a decision they cannot make yet. The project is a normal one ("Untitled Project" in the browser
// store): it saves, renames and exports like any other, and File > New or Open still reach the chooser.
//
// It applies when there is no project session yet and the page is hosted (https) or asks for it with `?try`
// (`npx cozyclay` and a checkout serve http, and keep the chooser: there the author usually opens a file).
import { loadProjectSession } from "./project.js";

/** True on the hosted Studio (https), or anywhere the URL asks for its first run with `?try`. */
function hostedFirstRun(location = globalThis.location) {
	return location?.protocol === "https:" || new URLSearchParams(location?.search ?? "").has("try");
}

/** True when this load should skip the project chooser and start a guest project. */
export function guestStart(location = globalThis.location, storage = globalThis.localStorage) {
	const params = new URLSearchParams(location?.search ?? "");
	if (params.has("embed") || params.has("scene") || loadProjectSession(storage)?.name) return false;
	return hostedFirstRun(location);
}
