import type { SceneSnapshot } from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatVector, renderFoldedResult, shortRevision } from "./folded-result.ts";
import { diffSummaryObjects, type InspectSummary, summarizeSnapshot } from "./inspect-summary.ts";

export interface ProjectManifest {
	readonly revision: string;
	readonly snapshot: SceneSnapshot;
}

export interface InspectProjectBridge {
	inspectProject(): Promise<ProjectManifest>;
}

const SUMMARY_ROW_LIMIT = 8;

function namesOf(rows: unknown): string[] {
	return Array.isArray(rows)
		? rows
				.map((row) => (typeof row === "object" && row !== null && "name" in row ? String(row.name) : String(row)))
				.filter(Boolean)
		: [];
}

function pushNameList(lines: string[], label: string, names: readonly string[]): void {
	if (!names.length) return;
	const shown = names.slice(0, SUMMARY_ROW_LIMIT);
	const rest = names.length - shown.length;
	lines.push(`  ${label} ${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`);
}

/**
 * Fold the model-facing inspect_project payload (a full summary or an
 * objectsDiff payload) into a few terminal lines. Reads the content text, not
 * `details`: details is the full manifest, which is exactly what the compact
 * summary exists to keep off the screen.
 */
export function summarizeInspectProjectContent(payload: unknown): string[] {
	if (typeof payload !== "object" || payload === null) return [];
	const summary = payload as Record<string, unknown>;
	const lines: string[] = [];
	const scene = summary.scene as Record<string, unknown> | undefined;
	if (scene) {
		lines.push(
			[
				String(scene.name ?? "scene"),
				`frames ${String(scene.frameStart ?? "?")}-${String(scene.frameEnd ?? "?")}`,
				`@${String(scene.fps ?? "?")}fps`,
				`cam ${String(scene.activeCamera ?? "(none)")}`,
				`rev ${shortRevision(summary.revision)}`,
			].join("  "),
		);
	}
	const render = summary.render as Record<string, unknown> | undefined;
	if (render) {
		lines.push(
			`render ${String(render.resolutionX ?? "?")}x${String(render.resolutionY ?? "?")} @ ${String(
				render.resolutionPercentage ?? "?",
			)}%`,
		);
	}

	if (Array.isArray(summary.objects)) {
		const objects = summary.objects as readonly Record<string, unknown>[];
		const cameras = Array.isArray(summary.cameras) ? summary.cameras.length : 0;
		const assemblies = Array.isArray(summary.assemblies) ? summary.assemblies.length : 0;
		const boneCounts = Array.isArray(summary.boneCounts) ? summary.boneCounts.length : 0;
		lines.push(
			`${objects.length} objects, ${cameras} cameras, ${assemblies} assemblies, ${String(
				summary.animationCount ?? 0,
			)} animations${boneCounts ? `, ${boneCounts} rigs` : ""}`,
		);
		for (const object of objects.slice(0, SUMMARY_ROW_LIMIT)) {
			lines.push(
				`  ${String(object.name ?? "?")}  ${String(object.type ?? "?")}${
					object.visible === false ? " hidden" : ""
				}  loc ${formatVector(object.location)}`,
			);
		}
		const rest = objects.length - SUMMARY_ROW_LIMIT;
		if (rest > 0) lines.push(`  ... ${rest} more objects`);
		return lines;
	}

	const diff = summary.objectsDiff as Record<string, unknown> | undefined;
	if (diff) {
		const added = namesOf(diff.added);
		const changed = namesOf(diff.changed);
		const removed = Array.isArray(diff.removedNames) ? diff.removedNames.map(String) : [];
		lines.push(
			`${String(summary.objectCount ?? "?")} objects  +${added.length} ~${changed.length} -${removed.length}  unchanged ${String(
				diff.unchangedCount ?? 0,
			)}  rev ${shortRevision(summary.revision)}`,
		);
		pushNameList(lines, "+", added);
		pushNameList(lines, "~", changed);
		pushNameList(lines, "-", removed);
	}
	return lines;
}

export function createInspectProjectTool(bridge: InspectProjectBridge) {
	// Last summary this tool instance returned. The tool lives for the whole
	// extension session, so repeat inspects (the common verify-after-stage
	// loop) can return an object diff instead of re-listing every object.
	let lastInspected: { readonly revision: string; readonly summary: InspectSummary } | undefined;
	return defineTool({
		name: "inspect_project",
		label: "inspect_project",
		description:
			"Read the current Blender scene as a compact summary: object names/types/ids, transforms, camera and light essentials, assembly member counts, and per-rig bone counts. The first call returns the full object list; repeat calls return `objectsDiff` (added/changed/removedNames since your last inspect, plus unchangedCount) instead of re-listing unchanged objects. Pass full=true to force the complete object list. Use inspect_entity to fetch full detail (bones, keyframes, materials) for a single entity when you need to edit it.",
		parameters: Type.Object(
			{
				full: Type.Optional(Type.Boolean({ description: "Force the complete object list instead of a diff" })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params: { readonly full?: boolean }) => {
			const manifest = await bridge.inspectProject();
			const summary = summarizeSnapshot(manifest.snapshot, manifest.revision);
			const previous = lastInspected;
			lastInspected = { revision: manifest.revision, summary };
			if (params?.full === true || previous === undefined) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify(summary) }],
					details: manifest,
				};
			}
			const { objects, ...rest } = summary;
			const payload = {
				...rest,
				objectCount: objects.length,
				objectsDiff: {
					baseRevision: previous.revision,
					...diffSummaryObjects(previous.summary.objects, objects),
				},
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(payload) }],
				details: manifest,
			};
		},
		renderResult(result, options, theme, context) {
			const raw = result.content?.find((part) => part.type === "text")?.text ?? "";
			let payload: unknown;
			try {
				payload = raw ? JSON.parse(raw) : undefined;
			} catch {
				payload = undefined;
			}
			return renderFoldedResult(result, options, theme, context, summarizeInspectProjectContent(payload));
		},
	});
}
