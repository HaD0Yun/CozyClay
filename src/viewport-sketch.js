// What the stage is armed to take next: the Annotate pen (the rail's Annotate
// cell) or a click on the body for a timeline
// note's bone. The canvas tool (context-chip-tools.jsx) draws and picks; the
// rail and the note door (context-chip-actions.js) arm it. Esc disarms both.
import { useSyncExternalStore } from "react";

const ANNOTATE_TOOLS = Object.freeze(["pen"]);
const IDLE = Object.freeze({ tool: null, note: null });
let state = IDLE;
const listeners = new Set();
const emit = () => { for (const listener of listeners) listener(); };
const set = (patch) => { state = Object.freeze({ ...state, ...patch }); emit(); };

export const viewportSketch = () => state;
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const useViewportSketch = () => useSyncExternalStore(subscribe, viewportSketch, () => IDLE);

/** tool: "pen", or null to leave Annotate. */
export const setAnnotateTool = (tool) => set({ tool: ANNOTATE_TOOLS.includes(tool) ? tool : null, ...(tool ? { note: null } : {}) });
/** note: { noteId, characterId, rig, onBone(boneId) }; null disarms. */
export const armNoteBone = (note) => set({ note });
export const disarmViewportSketch = () => { if (state.tool || state.note) set(IDLE); };

// What the stage reads about the scene while it annotates: the live Studio
// state (characters, objects, rigs, the playhead), registered by the rail.
let world = () => null;
export const registerAnnotateWorld = (read) => { world = read; };
export const annotateWorld = () => world();
