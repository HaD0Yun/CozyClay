import { placementAt } from "./root-path.js";
import { shotAtFrame } from "./cuts.js";
import { sampleAt } from "./sample-at.js";

/**
 * Where the selected cast member's gizmo stands. A character with a take is drawn where the take puts it at this
 * frame (the render's placement) with its body moved by the take's hips track inside it, so the gizmo stands at the
 * hips' floor place at the playhead, not at the take's start. A move still moves the whole take: `offset` is the
 * gizmo's distance from the character's own x/z, and a drag writes x/z minus that offset (the dragged amount).
 */
export function characterGizmoView({ selected, characters, activeCharacterId, activeCharacter, motion, shots, activeId, frame }) {
	if (!selected) return null;
	const entry = characters.find((item) => item.id === activeId);
	if (!entry || entry.hidden) return null;
	const clip = activeId === activeCharacterId ? motion : activeCharacter.sessionMotion;
	if (!clip) {
		const placement = placementAt(entry, frame, { shotAt: (at) => shotAtFrame(shots, at) });
		return { position: [placement.x, entry.y ?? 0, placement.z], rot: placement.rot, offset: [0, 0] };
	}
	const at = placementAt(entry, frame, { takeRoot: sampleAt({ frameCount: clip.frames, motion: clip }, null, frame).subject });
	const body = takeBodyOffset(clip, frame, at.rot ?? 0, entry.scale ?? 1);
	const x = at.x + body[0], z = at.z + body[1];
	return { position: [x, entry.y ?? 0, z], rot: at.rot, offset: [x - entry.x, z - entry.z] };
}

/** The take's hips at `frame` across the floor, turned and scaled as the character draws its rig: [x, z] metres. */
function takeBodyOffset(clip, frame, rotDeg, scale = 1) {
	const n = Number.isFinite(clip?.frames) ? clip.frames : 0;
	if (!clip?.hips || n < 1) return [0, 0];
	const f = Math.max(0, Math.min(n - 1, Math.round(Number.isFinite(frame) ? frame : 0)));
	const hx = clip.hips[f * 3] * scale, hz = clip.hips[f * 3 + 2] * scale, a = (rotDeg * Math.PI) / 180;
	if (!Number.isFinite(hx) || !Number.isFinite(hz)) return [0, 0];
	return [hx * Math.cos(a) + hz * Math.sin(a), -hx * Math.sin(a) + hz * Math.cos(a)];
}

export function characterGizmoObject(gizmoView, entry) {
	if (!gizmoView) return null;
	return {
		id: "__character__",
		x: gizmoView.position[0],
		y: gizmoView.position[1],
		z: gizmoView.position[2],
		height: 1.15,
		footprint: { width: 0.6, depth: 0.6 },
		rotY: gizmoView.rot ?? entry?.rot ?? 0,
		scaleX: entry?.scale ?? 1,
		scaleY: entry?.scale ?? 1,
		scaleZ: entry?.scale ?? 1,
	};
}

export function playbackSceneWithTrack(base, subjectTrack, followTrack) {
	return { ...base, subjectTrack, cameraTrack: followTrack };
}

export function followCameraActive(mode, track, frame, preview, ikMode, waypointMode, posing) {
	return mode !== "keys" && Boolean(track?.[frame]) && (preview || (!ikMode && !waypointMode && !posing));
}

export function updateShotMetrics({ position, visible, playing, setCameraPos, setSubjectVisible, cameraRef, visibleRef }) {
	cameraRef.current = { x: position.x, y: position.y, z: position.z };
	if (!playing) setCameraPos((prev) => Math.abs(prev.x - position.x) + Math.abs(prev.y - position.y) + Math.abs(prev.z - position.z) > 1e-4
		? { x: position.x, y: position.y, z: position.z } : prev);
	visibleRef.current = visible;
	if (!playing) setSubjectVisible((prev) => (prev === visible ? prev : visible));
}
