import { useMemo } from "react";
import { buildShotCameraTracks, castAimPoint, createShotSubjectSampler, shotSubjectTrack } from "./camera-direction.js";
import { subjectsCenter } from "./shot-subjects.js";

function buildSubjectState({ characters, objects, shots, frameCount, fps, activeId, motion }) {
	const cast = { characters, objects, shots, frameCount, fps, activeId, clipOf: entry => entry.id === activeId ? motion : entry.sessionMotion };
	return { cast, at: createShotSubjectSampler(cast), track: shotSubjectTrack(cast) };
}

/** Stable shot-subject queries and a serializable anchor track for camera consumers. */
export function useShotSubjects({ characters, objects, shots, frameCount, fps, activeId, motion }) {
	return useMemo(() => buildSubjectState({ characters, objects, shots, frameCount, fps, activeId, motion }),
		[characters, objects, shots, frameCount, fps, activeId, motion]);
}

/** The per-frame follow/rail camera of every shot (camera-direction.js), rebuilt
 * when the shots, the subject's path or the cast a rail aims at change. */
export function useShotCameraTracks({ shots, fps, filmback, characters, objects, frameCount, activeId, motion, subjects }) {
	return useMemo(() => {
		const state = subjects ?? buildSubjectState({ characters, objects, shots, frameCount, fps, activeId, motion });
		return buildShotCameraTracks({ shots, subjectTrack: state.track, fps,
			yawDegOf: shot => subjectsCenter(state.at(shot, shot.startFrame))?.rot ?? 0,
			filmback, aimAt: (id, frame) => castAimPoint(id, frame, state.cast) });
	}, [shots, fps, filmback, characters, objects, frameCount, activeId, motion, subjects]);
}
