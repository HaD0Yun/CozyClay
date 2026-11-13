// Shared state of the Auto Pose tool between the viewport handles (inside the three.js canvas) and the Details panel:
// model status, the active character's handle state, the selected handle, the current hint and the controller that
// performs actions. A tiny external store read with useSyncExternalStore.
import { useSyncExternalStore } from "react";

const listeners = new Set();
let snapshot = Object.freeze({
	model: { status: "idle", progress: 0 },
	characterId: null, handles: null, selected: null, hint: null,
	controller: null, clipboard: null,
});

/** The current snapshot (frozen; replaced on every update). */
export const getPoserState = () => snapshot;

/** Merge `patch` (an object or `(state) => object`) into the snapshot and notify subscribers. */
export function updatePoserState(patch) {
	const change = typeof patch === "function" ? patch(snapshot) : patch;
	if (!change) return;
	snapshot = Object.freeze({ ...snapshot, ...change });
	for (const listener of [...listeners]) listener();
}

function subscribe(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** React hook: Auto Pose snapshot, re-rendering on change. */
export function usePoserState() {
	return useSyncExternalStore(subscribe, getPoserState, getPoserState);
}
