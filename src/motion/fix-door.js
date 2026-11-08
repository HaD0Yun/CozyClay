// Pose mode's Fix settings (src/shell/FixTools.jsx): viewer settings, never saved, never undone.
// Fix mode: a pose drag over an installed take makes a correction island at that frame (domains/motion/fix-islands.js)
// instead of the whole-take range preview. The Studio starts in Fix mode; a headless motion owner (the node tests)
// keeps the range preview. View: "fixed" (the take with its fixes) or "original" (the take alone, A/B).
import { useSyncExternalStore } from "react";

const settings = { mode: Boolean(globalThis.document), view: "fixed" };
const listeners = new Set();
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
const set = (patch) => { Object.assign(settings, patch); for (const listener of listeners) listener(); };

export const fixModeOn = () => settings.mode;
export const fixView = () => settings.view;
export const setFixMode = (on) => set({ mode: Boolean(on) });
export const setFixView = (view) => set({ view: view === "original" ? "original" : "fixed" });
export const useFixMode = () => useSyncExternalStore(subscribe, fixModeOn, fixModeOn);
export const useFixView = () => useSyncExternalStore(subscribe, fixView, fixView);
