// The timeline clock, on its own so the agent sidecar (bin/agent) can read it
// without importing scenes.js, whose scene-object and motion-trail imports pull
// in `three` — a devDependency the npm package does not ship
// (test/verify-package-agent-imports.mjs).

/** v3 and older authored every frame number on ARDY's 20 fps clock; v4 reads
 * them on the 24 fps production clock. The numbers are MULTIPLIED, never
 * reinterpreted: a waypoint at frame 40 meant 2.0 s and must still mean 2.0 s,
 * which is frame 48 — reinterpreting it would silently speed the scene up. */
const LEGACY_FRAME_FPS = 20;
export const TIMELINE_FRAME_FPS = 24;
export const toTimelineFrame = (frame) =>
	Math.round((frame * TIMELINE_FRAME_FPS) / LEGACY_FRAME_FPS);
