/**
 * Return the current content-driven length of the shared production clock.
 *
 * The active character is represented by the editing-buffer motion; inactive
 * characters keep their committed sessionMotion (motion.frames is an exclusive
 * timeline count).
 *
 * A zero result is intentional: an empty scene keeps its existing authored
 * duration instead of collapsing the pre-generation clock to one frame.
 */
export function timelineContentExtent(
	characters = [],
	activeCharacterId = null,
		activeMotion = null,
	extraFrames = 0,
) {
	const authoredExtent = characters.reduce((max, entry) => {
		const clip = entry.id === activeCharacterId ? activeMotion : entry.sessionMotion;
		return Math.max(max, Number.isFinite(clip?.frames) ? clip.frames : 0);
	}, 0);
	// Ingested footage owns the clock only before a cast take exists. Once a
	// 136-frame take is installed, an older 192-frame source video must not
	// recreate the frozen tail this helper prevents.
	return authoredExtent > 0
		? authoredExtent
		: Number.isFinite(extraFrames) ? extraFrames : 0;
}

/**
 * Return the frame count the shared timeline shows for a content `extent`.
 *
 * It never ends under an authored shot: a shot outside the timeline is an
 * invalid scene for the Studio agent and for playback, so the count is at
 * least every shot's inclusive `endFrame + 1`. A zero extent keeps
 * `currentCount` (the existing authored duration), raised only by a shot.
 */
export function timelineSpan(extent, shots = [], currentCount = 0) {
	const shotEnd = shots.reduce(
		(max, shot) => Math.max(max, Number.isFinite(shot?.endFrame) ? shot.endFrame + 1 : 0),
		0,
	);
	return Math.max(extent > 0 ? extent : currentCount, shotEnd);
}

/**
 * Return `shots` after a timing edit moved a take's last frame from `oldEnd`
 * to `newEnd`: a shot that ended with the take keeps ending with it (never
 * before its own first frame). Other shots keep their authored range. Without
 * this a shot laid over the whole take holds the timeline at the old length
 * (timelineSpan never ends under a shot) after a trim or a speed-up.
 */
export function shotsFollowingTake(shots = [], oldEnd, newEnd) {
	if (oldEnd === newEnd) return shots;
	return shots.map(shot => (shot?.endFrame === oldEnd
		? { ...shot, endFrame: Math.max(shot.startFrame, newEnd) }
		: shot));
}
