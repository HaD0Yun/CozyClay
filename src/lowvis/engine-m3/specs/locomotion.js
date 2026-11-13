// Demo "locomotion" as a motion3 spec: stand, walk, turn on the spot, run, walk through a turn, stop.
import { SCHEMA, standSet, turnOnSpot, jog, arcTo, linesOf } from "../author.js";

export function locomotion(B) {
	const keys = [
		// f120-156: turn on the spot to heading 90 (no skill: keys)
		...turnOnSpot(B, { f0: 120, f1: 156, at: [0, 3], h0: 0, h1: 90 }),
		// f156-240: run to [4, 3] (no skill: keys); ends in a stride so the walk goes on from it
		...jog(B, { f0: 156, f1: 240, from: [0, 3], to: [4, 3], h: 90, steps: 10 }),
		{ f: 335, set: standSet(B, [4.6, 2], 180) },
	];
	const a = {
		schema: SCHEMA, fps: 24, frames: 336,
		// the jog's keys are timed step by step: fix.retime moved its landings by up to 0.4 m of travel, differently on each rig
		fix: { retime: false },
		use: [
			{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } },
			{ skill: "walkTo", f0: 24, args: { to: [0, 3], steps: 5, period: 12 } },
			// f240-288 walk through a quarter turn to [4.6, 2]; its last step and settle are the stop of f288-336
			{ skill: "walkTo", f0: 240, args: { ...arcTo([4, 3], 90, [4.6, 2], 4), period: 11 } },
		],
		keys,
	};
	return {
		characters: { a },
		lines: linesOf(locomotion),
		notes: [
			"turn on the spot (f120-156) and run (f156-240) have no motion3 skill: hand-written key generators (engine-m3/author.js turnOnSpot, jog)",
			"the run is a jog: 4 m in 84 frames is 1.14 m/s, so it has short flights and a small stride",
			"walkTo starts from a standing pose with a 16-frame weight shift, so the run does not blend into the walk at f240: the figure checks its pace for about half a second",
		],
	};
}
