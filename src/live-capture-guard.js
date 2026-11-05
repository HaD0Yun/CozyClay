/**
 * Live captures (`cclay live capture`, the MCP frame capture) render whatever
 * the scene graph holds right now. `operate --frame` reaches the rigs and the
 * shot camera through animation-frame callbacks, which a hidden tab throttles,
 * so a capture from a background tab would return the previous frame with no
 * error. Refuse it instead. The video export does not come through here: it
 * writes each frame's bones and camera itself before rendering.
 */
export function refuseHiddenCapture(doc = globalThis.document) {
	if (doc?.visibilityState !== "hidden") return;
	throw Object.assign(new Error("Bring the Studio tab to the front or run headless Chrome before capturing; a hidden tab may still show the previous frame or camera."), { code: "TAB_HIDDEN" });
}
