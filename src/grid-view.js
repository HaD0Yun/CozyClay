// Blender-style viewport mode: no floor deck, a coordinate grid overlay and a
// theme-matched background. The grid is a reference, not a set piece — it
// belongs to the editor viewport, never to the scene, the plan board or an
// exported frame. Pure constants + persistence here; the shader mesh lives in
// grid-floor.jsx.

export const GRID_VIEW_STORAGE_KEY = "cozyclay.grid-view.v1";

// Blender's solid-mode look: a dark grey void, not true black. Under the dark
// UI theme the stage wears it — editor, shot preview and exports — so the set
// reads as one grey workbench; the grid view only trades the deck for the
// reference grid. Both views follow the UI theme. Fog matches the background so distance still dissolves
// into the same neutral. The far plane stays below the capture rig's
// CAPTURE_FOG_NEAR (55) so pushing near past far still disables fog for
// exported frames.
export const STAGE_BACKGROUND = "#232428";
// The light UI theme's stage: a photo-studio cyclorama. A near-white sky the
// deck fades into, so the floor has no horizon line and the figures stand in
// a bright, soft room that sits in the light shell instead of punching a
// dark hole in it.
// Matched to the lit deck's far tone (room.jsx FLOOR_LIGHT after tone
// mapping), so fog blends floor into sky without a step.
const STAGE_BACKGROUND_LIGHT = "#e7e8eb";
export const stageBackground = (theme) => (theme === "light" ? STAGE_BACKGROUND_LIGHT : STAGE_BACKGROUND);
export const GRID_FOG = Object.freeze({ color: STAGE_BACKGROUND, near: 30, far: 54 });

// Line palette, tuned against the dark background the way Blender's theme
// does it: minor metre lines whisper, ten-metre lines carry the scale read,
// axes wear Blender's X-red and Z-blue (our ground plane is XZ; Y is up).
export const GRID_COLORS = Object.freeze({
	minor: "#3d4046",
	major: "#4c5058",
	axisX: "#b3454f",
	axisZ: "#3f6bb0",
});

// Darker marks on the light studio background keep the same scale hierarchy.
export const GRID_COLORS_LIGHT = Object.freeze({
	minor: "#c1c4ca",
	major: "#a4a9b2",
	axisX: "#b3454f",
	axisZ: "#3f6bb0",
});

export function readStoredGridView(storage) {
	try {
		return storage?.getItem(GRID_VIEW_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

export function writeStoredGridView(storage, enabled) {
	try {
		storage?.setItem(GRID_VIEW_STORAGE_KEY, enabled ? "1" : "0");
	} catch {
		// Storage can be unavailable (private mode); the mode simply stops persisting.
	}
}
