import { useMemo } from "react";
import { buildShotCameraTracks, castAimPoint, castBodyPoints, createShotSubjectSampler, shotSubjectTrack } from "./camera-direction.js";
import { shotSubjects, subjectsCenter } from "./shot-subjects.js";
import { shotAtFrame } from "./cuts.js";

function buildSubjectState({ characters, objects, shots, frameCount, fps, activeId, motion }) {
	const cast = { characters, objects, shots, frameCount, fps, activeId, clipOf: entry => entry.id === activeId ? motion : entry.sessionMotion };
	return { cast, at: createShotSubjectSampler(cast), track: shotSubjectTrack(cast) };
}

/** Stable shot-subject queries and a serializable anchor track for camera consumers. */
export function useShotSubjects({ characters, objects, shots, frameCount, fps, activeId, motion }) {
	return useMemo(() => buildSubjectState({ characters, objects, shots, frameCount, fps, activeId, motion }),
		[characters, objects, shots, frameCount, fps, activeId, motion]);
}

/** The posed joints of every named subject of the shot at a frame, or null when one of them has no take v3 body. */
function subjectBodiesAt(frame, cast) {
	const subjects = shotSubjects(shotAtFrame(cast.shots, frame), cast.characters, cast.activeId, cast.objects);
	const bodies = subjects.map(entry => castBodyPoints(entry.id, frame, cast));
	return bodies.length && bodies.every(Boolean) ? bodies.flat() : null;
}

/** The per-frame follow/rail camera of every shot (camera-direction.js), rebuilt
 * when the shots, the subject's path or the cast a rail aims at change. The
 * subjects' posed bodies at each frame are what a follow camera keeps in frame. */
export function useShotCameraTracks({ shots, fps, filmback, fovDeg, characters, objects, frameCount, activeId, motion, subjects }) {
	return useMemo(() => {
		const state = subjects ?? buildSubjectState({ characters, objects, shots, frameCount, fps, activeId, motion });
		return buildShotCameraTracks({ shots, subjectTrack: state.track, fps,
			yawDegOf: shot => subjectsCenter(state.at(shot, shot.startFrame))?.rot ?? 0,
			filmback, fovDeg, aimAt: (id, frame) => castAimPoint(id, frame, state.cast), bodyAt: frame => subjectBodiesAt(frame, state.cast) });
	}, [shots, fps, filmback, fovDeg, characters, objects, frameCount, activeId, motion, subjects]);
}
