import { renderV4Sheet } from "./motion-v4/render/editor-render.js";

/**
 * Live captures (`cclay live capture`, the MCP frame capture) render whatever
 * the scene graph holds right now. `operate --frame` reaches the rigs and the
 * shot camera through animation-frame callbacks, which a hidden tab throttles,
 * so a capture from a background tab would return the previous frame with no
 * error. Refuse it instead. The video export does not come through here: it
 * writes each frame's bones and camera itself before rendering.
 * The agent's own looks do not come through here either (#1138): an author who
 * works in another window while the agent runs hides the tab most of the time,
 * and an agent that cannot look cannot check its work. They take the export's
 * way instead, which needs no animation frame: the v4 render sheet
 * (captureV4Sheet) and, in a hidden tab, the shot frame (captureHiddenFraming).
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

/** True in a tab the browser does not show: animation-frame callbacks are throttled there. */
export const tabHidden = (doc = globalThis.document) => doc?.visibilityState === "hidden";

/**
 * The shot frame at the playhead for a capture asked from a hidden tab, drawn the way the video export draws it
 * (captureFrameAt), with the references the visible capture carries. The frame is the playhead's, whole and inside
 * the timeline; the output is the shot's own size (a size the caller asked for applies to the visible capture only).
 */
export function captureHiddenFraming(live) {
	const last = Math.max(1, live.timeline.frameCount) - 1, at = Math.round(Number(live.timeline.currentFrame) || 0);
	return { ...captureFrameAt(live, Math.min(last, Math.max(0, at))), references: live.captureShotReferences?.() };
}

/**
 * The v4 render sheet for the v4_render live query (motion-v4/render/editor-render.js). Every cell is drawn through
 * renderFrameBuffer, the export's way (it writes that frame's bones and its own camera before it renders), so a
 * hidden tab draws the same sheet as a visible one and is not refused.
 */
export function captureV4Sheet(args, ports) {
	return renderV4Sheet(args, ports);
}
