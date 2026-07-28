import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export interface InspectEntityAnimationOptions {
	readonly data_path_filter?: string;
	readonly frame_start?: number;
	readonly frame_end?: number;
}

export interface InspectEntityOptions extends InspectEntityAnimationOptions {
	readonly scope: "bones" | "animation" | "material" | "all";
}

export interface InspectEntityBridge {
	inspectEntity(entityId: string, options: InspectEntityOptions): Promise<Record<string, unknown>>;
}

/** The slice of a detail payload this renderer reads. Everything is optional
 * because the shape depends on scope, and a renderer must never be the thing
 * that throws on an unexpected response. */
interface InspectEntityDetail {
	readonly name?: string;
	readonly type?: string;
	readonly parent?: string | null;
	readonly bones?: readonly unknown[];
	readonly bonesOmitted?: number;
	readonly materials?: readonly { readonly slot?: string; readonly material?: string | null }[];
	readonly materialsOmitted?: number;
	readonly animationSummary?: {
		readonly curveCount?: number;
		readonly keyframeCount?: number;
		readonly frameStart?: number;
		readonly frameEnd?: number;
		readonly groupCount?: number;
		readonly groups?: readonly {
			readonly name?: string;
			readonly curveCount?: number;
			readonly keyframeCount?: number;
		}[];
		readonly truncated?: unknown;
	};
}

interface InspectEntityPayload {
	readonly scope?: string;
	readonly detail?: InspectEntityDetail;
}

const SUMMARY_GROUP_LIMIT = 8;

/**
 * What the user sees instead of the response.
 *
 * The payload is built for the model: every f-curve carries its own keyframe
 * list, so a two-frame rig is already a screen of quoted JSON and a real one is
 * far worse. None of it is readable at a glance, and it buried whatever the
 * turn was actually doing. The full response is still one expand away, so
 * nothing is hidden -- only folded.
 */
export function summarizeInspectEntity(payload: InspectEntityPayload): string[] {
	const detail = payload.detail;
	if (!detail) return [];
	const lines: string[] = [];
	// The scope rides along with the entity or not at all: on its own it is a
	// line telling the user the argument they just typed.
	const identity = [detail.name, detail.type].filter((part): part is string => Boolean(part));
	if (identity.length) {
		lines.push(
			[...identity, payload.scope ? `scope ${payload.scope}` : undefined]
				.filter((part): part is string => Boolean(part))
				.join("  "),
		);
	}
	if (detail.parent) lines.push(`parent ${detail.parent}`);

	if (detail.bones) {
		const omitted = detail.bonesOmitted ? ` (+${detail.bonesOmitted} omitted)` : "";
		lines.push(`${detail.bones.length} bones${omitted}`);
	}

	const animation = detail.animationSummary;
	if (animation) {
		const range =
			animation.frameStart !== undefined && animation.frameEnd !== undefined
				? `, frames ${animation.frameStart}-${animation.frameEnd}`
				: "";
		lines.push(`${animation.curveCount ?? 0} curves, ${animation.keyframeCount ?? 0} keys${range}`);
		for (const group of (animation.groups ?? []).slice(0, SUMMARY_GROUP_LIMIT)) {
			lines.push(`  ${group.name ?? "?"}  ${group.curveCount ?? 0} curves, ${group.keyframeCount ?? 0} keys`);
		}
		const rest = (animation.groups?.length ?? 0) - SUMMARY_GROUP_LIMIT;
		if (rest > 0) lines.push(`  ... ${rest} more groups`);
	}

	if (detail.materials) {
		const omitted = detail.materialsOmitted ? ` (+${detail.materialsOmitted} omitted)` : "";
		lines.push(`${detail.materials.length} material slots${omitted}`);
		for (const slot of detail.materials.slice(0, SUMMARY_GROUP_LIMIT)) {
			lines.push(`  ${slot.slot ?? "?"}  ${slot.material ?? "(empty)"}`);
		}
	}
	return lines;
}

export function createInspectEntityTool(bridge: InspectEntityBridge) {
	return defineTool({
		name: "inspect_entity",
		label: "inspect_entity",
		description:
			"Fetch full detail for one entity on demand. scope 'bones' returns the bone hierarchy and transforms for an armature; 'animation' returns f-curve summaries (per-curve source, dataPath, arrayIndex, keyframeCount, frame range, value range, interpolations) and includes the exact keyframes list per curve only while the whole response fits a keyframe budget; 'material' returns material slots and node inputs; 'all' returns everything. When scope animation/all exceeds the budget, the per-curve keyframes lists are dropped, the returned animationSummary.truncated names what was omitted, and you narrow with data_path_filter (a bone name or data-path substring, case-sensitive), frame_start, and frame_end. A narrowed selection is still subject to the same budgets: it returns exact keyframes only once the narrowed selection itself fits, so if animationSummary.truncated is still set, narrow further by channel or frame range. The serialized detail payload is hard-capped at 64 KiB (the animation section at 32 KiB) by deterministic truncation, so a wide call may omit rows; narrow with data_path_filter/frame_start/frame_end to fetch what was dropped. Use this after inspect_project when you need to edit a specific rigged character or animated object.",
		parameters: Type.Object(
			{
				entity_id: Type.String({ pattern: UUID_V4_LOWERCASE }),
				scope: Type.Union([
					Type.Literal("bones"),
					Type.Literal("animation"),
					Type.Literal("material"),
					Type.Literal("all"),
				]),
				data_path_filter: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
				frame_start: Type.Optional(Type.Integer({ minimum: -1000000, maximum: 1000000 })),
				frame_end: Type.Optional(Type.Integer({ minimum: -1000000, maximum: 1000000 })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			// Forward only the keys the model actually supplied: the add-on
			// rejects unknown params, and an explicit undefined would serialize
			// as a present key.
			const { entity_id: entityId, scope, data_path_filter, frame_start, frame_end } = params;
			// TypeBox validates each field independently but cannot express the
			// cross-field rule that frame_start <= frame_end when both are
			// present. Reject it before dispatch so the bridge is never called
			// for an inverted range (the bridge mirrors the same refusal).
			if (frame_start !== undefined && frame_end !== undefined && frame_start > frame_end) {
				throw new Error(
					`INVALID_INSPECT_ENTITY_REQUEST: frame_start (${frame_start}) must be <= frame_end (${frame_end})`,
				);
			}
			const options: InspectEntityOptions = {
				scope,
				...(data_path_filter !== undefined ? { data_path_filter } : {}),
				...(frame_start !== undefined ? { frame_start } : {}),
				...(frame_end !== undefined ? { frame_end } : {}),
			};
			const result = await bridge.inspectEntity(entityId, options);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			// Expanded shows the response verbatim: the summary is a fold, not
			// a filter, and anyone who wants the numbers must be able to reach
			// them without re-running the call.
			if (options.expanded) {
				const raw = result.content?.find((part) => part.type === "text")?.text ?? "";
				text.setText(raw ? `\n${theme.fg("toolOutput", raw)}` : "");
				return text;
			}
			const lines = summarizeInspectEntity((result.details ?? {}) as InspectEntityPayload);
			const truncated = (result.details as InspectEntityPayload | undefined)?.detail?.animationSummary?.truncated;
			let rendered = lines.length ? `\n${lines.map((line) => theme.fg("toolOutput", line)).join("\n")}` : "";
			if (truncated)
				rendered += `\n${theme.fg("warning", "[Truncated: narrow with data_path_filter or a frame range]")}`;
			text.setText(rendered);
			return text;
		},
	});
}
