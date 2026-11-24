import { hasHostProjectFiles } from "./host-project-files.js";
import { hasFileSystemAccess, openProjectFallback, pickProjectFileForOpen, readProjectFile } from "./project.js";

const PICKER_UNREADABLE_KEY = "cozyclay.open-picker-unreadable";

/** Pick a project file to open: { file, handle } (file null when the author cancels), or { blocked: true }.
 * Some embedded browsers (the OmO desktop preview is one) hand back a picked handle and then refuse to read it
 * (NotAllowedError on getFile). After one refusal this browser opens projects through a plain file input,
 * which reads the file without a handle; when the click's activation is still live that input opens at once.
 * A host app's own dialog (src/host-project-files.js) always comes first: its file can be saved back to. */
export async function pickProjectToOpen(storage = globalThis.localStorage, activation = globalThis.navigator?.userActivation) {
	if (!hasHostProjectFiles() && (!hasFileSystemAccess() || storage?.getItem(PICKER_UNREADABLE_KEY) === "1")) return { file: await openProjectFallback(), handle: null };
	const handle = await pickProjectFileForOpen();
	try {
		return { file: await readProjectFile(handle), handle };
	} catch (error) {
		if (error?.name !== "NotAllowedError") throw error;
		try { storage?.setItem(PICKER_UNREADABLE_KEY, "1"); } catch { /* the next open asks the picker again */ }
		return activation?.isActive ? { file: await openProjectFallback(), handle: null } : { blocked: true };
	}
}
