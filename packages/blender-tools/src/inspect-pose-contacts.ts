// Read-only frame-specific deformed-sole/support-contact inspection (issue #2
// item D). Distinct from inspect_relations on purpose: this measures actual
// per-frame deformed-mesh sole geometry against declared support geometry, not
// static scene layout, and it must never let a skeleton joint position stand
// in for a measured surface contact.
import {
	type InspectPoseContactsParamsV1,
	InspectPoseContactsParamsV1Schema,
	type PoseContactsResultV1,
} from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { renderFoldedResult, shortRevision } from "./folded-result.ts";

const SUMMARY_FRAME_LIMIT = 8;
const SIDE_ORDER = ["left", "right"] as const;

function gapText(value: unknown): string {
	return typeof value === "number" ? `${value >= 0 ? "+" : ""}${value}m` : String(value ?? "?");
}

function sideText(side: unknown): string {
	if (typeof side !== "object" || side === null) return "none";
	const support = (side as Record<string, unknown>).support;
	if (typeof support !== "object" || support === null) return "sole n/a";
	const verdict = (support as Record<string, unknown>).surface_contact_verified === true ? "ok" : "NO";
	const inside = (support as Record<string, unknown>).inside_support_footprint === true ? "inside" : "outside";
	return `${verdict} gap ${gapText((support as Record<string, unknown>).support_gap_m)} ${inside}`;
}

/**
 * Fold inspect_pose_contacts into the only lines a foot-contact check needs:
 * the gate, then per frame whether each deformed sole verified against the
 * declared support and by what gap. Joint evidence stays in the expanded raw
 * payload; the fold keeps the verdict readable.
 */
export function summarizeInspectPoseContacts(payload: unknown): string[] {
	if (typeof payload !== "object" || payload === null) return [];
	const result = payload as Record<string, unknown>;
	const frames = Array.isArray(result.frames) ? (result.frames as readonly Record<string, unknown>[]) : [];
	if (!frames.length) return [];
	const gate = result.gate as Record<string, unknown> | undefined;
	const lines: string[] = [];
	let verified = 0;
	let measured = 0;
	for (const frame of frames) {
		const sides = frame.sides as Record<string, unknown> | undefined;
		for (const sideName of SIDE_ORDER) {
			const support = (sides?.[sideName] as Record<string, unknown> | undefined)?.support;
			if (typeof support === "object" && support !== null) {
				measured += 1;
				if ((support as Record<string, unknown>).surface_contact_verified === true) verified += 1;
			}
		}
	}
	lines.push(
		`gate ±${String(gate?.max_gap_m ?? "?")}m edge >=${String(gate?.min_edge_margin_m ?? "?")}m  ${verified}/${measured} sole contacts verified  rev ${shortRevision(
			result.revision,
		)}`,
	);
	for (const frame of frames.slice(0, SUMMARY_FRAME_LIMIT)) {
		const sides = (frame.sides ?? {}) as Record<string, unknown>;
		const parts = SIDE_ORDER.map((sideName) => `${sideName[0].toUpperCase()}:${sideText(sides[sideName])}`);
		const extra = Object.keys(sides)
			.filter((sideName) => !SIDE_ORDER.includes(sideName as (typeof SIDE_ORDER)[number]))
			.sort()
			.map((sideName) => `${sideName}:${sideText(sides[sideName])}`);
		lines.push(`frame ${String(frame.frame ?? "?")}  ${[...parts, ...extra].join("  ")}`);
	}
	const rest = frames.length - SUMMARY_FRAME_LIMIT;
	if (rest > 0) lines.push(`... ${rest} more frames`);
	return lines;
}

export interface InspectPoseContactsBridge {
	inspectPoseContacts(params: InspectPoseContactsParamsV1): Promise<PoseContactsResultV1>;
}

export function createInspectPoseContactsTool(bridge: InspectPoseContactsBridge) {
	return defineTool({
		name: "inspect_pose_contacts",
		label: "inspect_pose_contacts",
		description:
			"Measure, per requested SCENE frame, whether a character's deformed-mesh foot sole actually touches declared support geometry. `frames` are SCENE frames (scene = apply_motion start_frame + clip frame), not clip-relative frames. All positions and gaps are Blender world-space meters, Z-up. For each frame and side (left/right) this reports the raw skeleton foot/toe joint position alongside the DEFORMED sole/heel/toe mesh samples, then compares the deformed sole against each declared support entity's measured top surface: `support_gap_m` (positive = gap above the surface, negative = penetration) and `inside_support_footprint` (an AABB-XY footprint test, reported as such). `surface_contact_verified` is derived ONLY from that deformed-sole-vs-support-geometry comparison against the echoed gate (default max absolute gap 0.03 m, minimum edge margin 0.0 m) — it is never inferred from skeleton joint residual or IK/constraint error, because the joint-to-sole offset is not constant and changes with foot rotation. Joint positions in the result are raw evidence only, not proof of contact.",
		parameters: InspectPoseContactsParamsV1Schema,
		execute: async (_toolCallId, params) => {
			const result = await bridge.inspectPoseContacts(params);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
		renderResult(result, options, theme, context) {
			return renderFoldedResult(result, options, theme, context, summarizeInspectPoseContacts(result.details));
		},
	});
}
