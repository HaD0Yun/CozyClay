import { renderV4Sheet } from "./motion-v4/render/editor-render.js";

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

/**
 * One named timeline frame for `cclay live capture --frames` (#1074), drawn
 * the way the video export draws it: `live.captureShotFrame` poses the cast
 * and parks the shot camera at that frame, then puts both back, so the
 * playhead never moves and a run of frames needs no seek.
 */
export function captureFrameAt(live, frame) {
	const frameCount = Math.max(1, live.timeline.frameCount);
	if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frameCount) throw new Error(`Frame ${frame} is outside the timeline (0-${frameCount - 1}).`);
	const shot = live.captureShotFrame(frame);
	if (!shot.dataUrl) throw new Error("The shot renderer is not ready");
	return { ...shot, frame, partColours: live.partColours, meta: live.captureShotMeta(frame) };
}

/**
 * The v4 render sheet for the v4_render live query (motion-v4/render/editor-render.js), refused from a hidden tab
 * like the other live captures.
 */
export function captureV4Sheet(args, ports) {
	refuseHiddenCapture();
	return renderV4Sheet(args, ports);
}
