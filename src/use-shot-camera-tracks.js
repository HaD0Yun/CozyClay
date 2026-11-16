import { useMemo } from "react";
import { buildShotCameraTracks, castAimPoint, castBodyPoints, followSubjectTrack } from "./camera-direction.js";

/** The per-frame follow/rail camera of every shot (camera-direction.js), rebuilt
 * when the shots, the subject's path or the cast a rail aims at change. The
 * subject's posed body at each frame is what a follow camera keeps in frame. */
export function useShotCameraTracks({ shots, subjectTrack, subjectId, fps, yawDeg, filmback, fovDeg, characters, objects, frameCount, activeId, motion }) {
	return useMemo(() => {
		if (!subjectTrack) return null;
		const cast = { characters, objects, shots, frameCount, fps, clipOf: (entry) => (entry.id === activeId ? motion : entry.sessionMotion) };
		return buildShotCameraTracks({ shots, subjectTrack: followSubjectTrack(subjectTrack, subjectId, cast), fps, yawDeg, filmback, fovDeg,
			aimAt: (id, frame) => castAimPoint(id, frame, cast), bodyAt: (frame) => castBodyPoints(subjectId, frame, cast) });
	}, [shots, subjectTrack, subjectId, fps, yawDeg, filmback, fovDeg, characters, objects, frameCount, activeId, motion]);
}
