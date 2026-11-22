import { buildRailFollowTrack } from "./camera-follow.js";

/**
 * How far a set speed cap holds a rail dolly behind the rail's own schedule.
 * Both runs ride the rail alone (no distance pull) over `frames` frames: once
 * with no cap, once with the shot's follow settings. Returns the largest gap
 * in metres along the rail, the frame (from the rail's first) it happens on,
 * and how far short of the uncapped end the capped dolly stops. Without a cap
 * both runs are the same track and every value is 0.
 */
export function railDollyLag(rail, frames, fps, params = {}) {
	if (!rail || !(rail.length > 1e-6) || !(frames > 1)) return { behindM: 0, frame: 0, endShortM: 0 };
	const still = Array.from({ length: Math.round(frames) }, () => rail.points[0]);
	const alone = { ...params, distanceInfluence: 0 };
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
