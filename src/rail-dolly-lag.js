import { buildRailFollowTrack } from "./camera-follow.js";

/**
 * How far a speed cap holds a rail dolly back, measured on the rail alone.
 * Both runs ride the rail from its head over `frames` frames with no subject
 * to pull them (no distance pull, whatever start the shot names): once with
 * no cap, once with the shot's follow settings. Returns the largest gap in
 * metres along the rail, the frame (from the rail's first) it happens on, and
 * the gap on the last frame. Without a cap both runs are the same track and
 * every value is 0. A shot whose camera follows a subject adds its distance
 * pull to both runs, so its own gap differs; an aimed rail's is this one.
 */
export function railDollyLag(rail, frames, fps, params = {}) {
	if (!rail || !(rail.length > 1e-6) || !(frames > 1)) return { behindM: 0, frame: 0, endShortM: 0 };
	const still = Array.from({ length: Math.round(frames) }, () => rail.points[0]);
	const alone = { ...params, distanceInfluence: 0, railStartMode: "head" };
	const asked = buildRailFollowTrack(still, fps, rail, { ...alone, maxDollySpeed: Infinity });
	const capped = buildRailFollowTrack(still, fps, rail, alone);
	let behindM = 0;
	let frame = 0;
	capped.forEach((sample, index) => {
		const gap = asked[index].s - sample.s;
		if (gap > behindM + 1e-9) {
			behindM = gap;
			frame = index;
		}
	});
	return { behindM, frame, endShortM: Math.max(0, asked.at(-1).s - capped.at(-1).s) };
}
