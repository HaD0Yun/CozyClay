import { useMemo } from "react";
import { buildShotCameraTracks, castAimPoint, createShotSubjectBodies, createShotSubjectSampler, shotSubjectTrack } from "./camera-direction.js";
import { subjectsCenter } from "./shot-subjects.js";

function buildSubjectState({ characters, objects, shots, frameCount, fps, activeId, motion }) {
	const cast = { characters, objects, shots, frameCount, fps, activeId, clipOf: entry => entry.id === activeId ? motion : entry.sessionMotion };
	return { cast, at: createShotSubjectSampler(cast), track: shotSubjectTrack(cast) };
}

/** What the shot subjects read of the shots: which shot holds a frame, and whom it names (shot-subjects.js). */
const subjectShotsOf = shots => shots.map(({ id, startFrame, endFrame, subjectIds }) => ({ id, startFrame, endFrame, subjectIds }));

/** The same array while what the subjects read of the shots stays the same: a camera edit (one per pointer move of a
 *  camera drag) leaves the subjects, their track and the cameras built on them as they are. */
function useSubjectShots(shots) {
	const key = JSON.stringify(subjectShotsOf(shots));
	return useMemo(() => JSON.parse(key), [key]);
}

/** Stable shot-subject queries and a serializable anchor track for camera consumers. */
export function useShotSubjects({ characters, objects, shots, frameCount, fps, activeId, motion }) {
	const subjectShots = useSubjectShots(shots);
	return useMemo(() => buildSubjectState({ characters, objects, shots: subjectShots, frameCount, fps, activeId, motion }),
		[characters, objects, subjectShots, frameCount, fps, activeId, motion]);
}

/** The per-frame follow/rail camera of every shot (camera-direction.js), rebuilt
 * when the shots, the subject's path or the cast a rail aims at change. The
 * subjects' posed bodies at each frame are what a follow camera keeps in frame.
 * A shot whose rail head alone changed keeps its built samples (buildShotCameraTracks reuse). */
export function useShotCameraTracks({ shots, fps, filmback, fovDeg, characters, objects, frameCount, activeId, motion, subjects }) {
	const subjectShots = useSubjectShots(shots);
	const state = useMemo(() => subjects ?? buildSubjectState({ characters, objects, shots: subjectShots, frameCount, fps, activeId, motion }),
		[subjects, characters, objects, subjectShots, frameCount, fps, activeId, motion]);
	// kept per shot while every input but the shots stays the same
	const reuse = useMemo(() => ({ state, fps, filmback, fovDeg, shots: new Map() }), [state, fps, filmback, fovDeg]).shots;
	return useMemo(() => buildShotCameraTracks({ shots, subjectTrack: state.track, fps,
		yawDegOf: shot => subjectsCenter(state.at(shot, shot.startFrame))?.rot ?? 0,
		filmback, fovDeg, aimAt: (id, frame) => castAimPoint(id, frame, state.cast), bodyAt: createShotSubjectBodies(state.cast), reuse }),
	[shots, state, fps, filmback, fovDeg, reuse]);
}
