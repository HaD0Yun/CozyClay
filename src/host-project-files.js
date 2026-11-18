// Project files owned by a host app (#1319). A host that shows the Studio in
// its own window (the desktop app) may expose `window.cozyclayHost.projectFiles`
// from its preload. When it does, the Studio opens and saves .cclayproject
// files through the host's dialogs and files instead of the browser's pickers
// (src/project.js); in a plain browser the object is absent and nothing changes.
// The launcher advertises this as the "project-files" capability
// (bin/host-contract.mjs).
//
// The bridge; every method returns a promise:
//   pickForOpen()          -> { token, name } | null   the host's open dialog; null when cancelled
//   pickForSave(fileName)  -> { token, name } | null   the host's save dialog, suggesting fileName
//   read(token)            -> { text, lastModified? }
//   write(token, text)     -> void, replaces the whole file
//   onOpen(listener)       -> unsubscribe (optional)    the host asks the Studio to open { token, name };
//                                                       a request made before a listener exists waits for one
// `name` is the file name with its extension. `token` is opaque to the Studio:
// it is kept as the project's handle (the last-project record and the recent
// list in IndexedDB) and handed back to read and write, so it must keep naming
// the same file across launches. Any script in the page can call the bridge,
// so the host accepts only tokens it issued and never reads one as a path.

const METHODS = ["pickForOpen", "pickForSave", "read", "write"];

function bridge() {
	const files = globalThis.window?.cozyclayHost?.projectFiles;
	return files && METHODS.every((method) => typeof files[method] === "function") ? files : null;
}

function requireBridge() {
	const files = bridge();
	if (!files) throw new Error("The host app that owns this project file is not available.");
	return files;
}

// The host's answer, checked once here, as a plain record IndexedDB can store
// next to the browser's own file handles.
function hostFile(value) {
	if (typeof value?.token !== "string" || !value.token || typeof value.name !== "string" || !value.name.trim()) {
		throw new TypeError("The host app returned an invalid project file.");
	}
	return { hostToken: value.token, name: value.name.trim() };
}

export const hasHostProjectFiles = () => bridge() !== null;

export const isHostProjectFile = (handle) => typeof handle?.hostToken === "string";

// A host file stays readable while its host is there: there is nothing to ask the user.
export const hostProjectFilePermission = () => (bridge() ? "granted" : "denied");

// The host's open or save dialog. A cancel rejects with AbortError, as the browser's pickers do.
export async function pickHostProjectFile(mode, fileName) {
	const files = requireBridge();
	const picked = await (mode === "save" ? files.pickForSave(fileName) : files.pickForOpen());
	if (picked == null) throw new DOMException("The user aborted a request.", "AbortError");
	return hostFile(picked);
}

export async function readHostProjectFile(handle) {
	const { text, lastModified } = (await requireBridge().read(handle.hostToken)) ?? {};
	if (typeof text !== "string") throw new TypeError("The host app returned no project text.");
	return new File([text], handle.name, Number.isFinite(lastModified) ? { lastModified } : {});
}

export async function writeHostProjectFile(handle, text) {
	await requireBridge().write(handle.hostToken, text);
}

// How many projects the host asked for are still being opened. A brief for
// one of them waits until this says false (src/host-agent-brief.js).
let opening = 0;
export const hostProjectOpening = () => opening > 0;

// Projects the host asks the Studio to open. Returns the unsubscribe function.
// A listener that returns a promise keeps the project "opening" until it settles.
export function subscribeHostProjectOpen(listener) {
	const files = bridge();
	if (typeof files?.onOpen !== "function") return () => {};
	const unsubscribe = files.onOpen((value) => {
		try {
			const opened = listener(hostFile(value));
			opening += 1;
			Promise.resolve(opened).catch(() => {}).finally(() => { opening -= 1; });
		} catch (error) {
			console.warn(`cozyclay: ${error.message}`);
		}
	});
	return typeof unsubscribe === "function" ? unsubscribe : () => {};
}
