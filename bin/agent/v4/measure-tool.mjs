// The v4 "measure" tool: numbers about the current raw track (ctx.track.out()) over a frame range.
// data has every row (what a js caller gets); text is a worst-first TSV of at most 6,000 chars.
import { measureTake, measureText } from "../../../src/motion-v4/measure/index.js";

const DESCRIPTION = [
	"Measure the current track (after track set or patch; no commit needed). Frames are 0-based, metres, degrees.",
	"Tables (what, default all):",
	"- penetration: per frame, body part and surface (floor or a scene box id), depth = how far the part's skin goes inside; rows deeper than tolerance (default 0.01 m). Parts: torso_lo torso_hi hips neck head thigh_ shin_ uarm_ farm_ hand_ sole_ tips_ palm_ (suffix l or r); skin: true adds the fitted skin points (slower; adds foot_ and fingers_).",
	"- contacts: runs where an end (palm_, tips_, heel_, ball_, tip_, knee_, elbow_, buttocks, head_top) is within 0.02 m of the floor or a box for 2+ frames, with minGap and slide (travel along the surface, in the box's own frame when it moves).",
	"- balance: every step frames, COM, support kinds (feet, hands, knees, hips, air), margin of the COM over the support polygon (< 0 outside), XcoM and its margin; runs where the COM is outside.",
	"- limits: knee and elbow fold past 160 and 150, knee or elbow bent backward past 5, wrist flex/dev/twist past its limits, neck bend past 60; runs.",
	"- speed: local bone rotation speed over 400 deg/s (trunk, head), 1200 (arms, legs), 1500 (hands, feet); top hips and COM speed and acceleration.",
	"parts filters penetration parts and contact ends (a table none of the names belongs to stays whole); against (floor or box ids) filters both. maxRows (default 20) is the rows per table in the text.",
	"From js: await measure({ ... }) returns every row of every table.",
].join("\n");

const INPUT_SCHEMA = {
	type: "object", additionalProperties: false, required: [],
	properties: {
		from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 },
		step: { type: "integer", minimum: 1, maximum: 24 },
		what: { type: "array", items: { enum: ["penetration", "contacts", "balance", "limits", "speed"] } },
		parts: { type: "array", items: { type: "string" } },
		against: { type: "array", items: { type: "string" } },
		skin: { type: "boolean" },
		tolerance: { type: "number", minimum: 0, maximum: 0.1 },
		maxRows: { type: "integer", minimum: 1, maximum: 200 },
	},
};

/** createMeasureTool(ctx) -> V4Tool "measure"; ctx.track is the conversation's TrackStore. */
export function createMeasureTool(ctx) {
	return {
		name: "measure",
		description: DESCRIPTION,
		inputSchema: INPUT_SCHEMA,
		async run(args, call = {}) {
			const a = args ?? {};
			const maxRows = a.maxRows ?? 20;
			if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 200) throw new Error("measure: maxRows must be an integer from 1 to 200.");
			const out = await ctx.track.out();
			if (!out) throw new Error("No track yet: call track set first.");
			call.signal?.throwIfAborted?.();
			const data = measureTake(out, a);
			return { data, text: measureText(data, maxRows) };
		},
	};
}
