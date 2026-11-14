import { placementAt } from "./root-path.js";
import { shotAtFrame } from "./cuts.js";

export function characterGizmoView({ selected, characters, activeCharacterId, activeCharacter, motion, shots, activeId, frame }) {
	if (!selected) return null;
	const entry = characters.find((item) => item.id === activeId);
	if (!entry || entry.hidden) return null;
	const hasTake = activeId === activeCharacterId ? Boolean(motion) : Boolean(activeCharacter.sessionMotion);
	const placement = hasTake ? entry : placementAt(entry, frame, { shotAt: (at) => shotAtFrame(shots, at) });
	return { position: [placement.x, entry.y ?? 0, placement.z], rot: placement.rot };
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

export function playbackSceneWithTrack(base, subjectTrack, followTrack, cameraAnchorTrack) {
	return { ...base, subjectTrack, cameraTrack: followTrack, ...(cameraAnchorTrack ? { cameraAnchorTrack } : {}) };
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
