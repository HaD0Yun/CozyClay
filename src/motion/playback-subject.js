import { playbackProbe } from "./playback-probe.js";

export function usePlaybackSubjectPosition({ motion, subjectCarry, scene, frame }) {
	if (!motion && !subjectCarry) return null;
	return playbackProbe({ scene, carry: subjectCarry }, frame, null);
}
