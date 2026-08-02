// Shared test mirror of the Blender add-on's reported hello surface: version
// from the repo manifest plus cclay.method.* / cclay.op.* capability entries.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { StageSceneOperationV1Schema } from "@cclay/protocol";

export const REPO_ADDON_VERSION = readFileSync(
	new URL("../../../blender-addon/cclay/blender_manifest.toml", import.meta.url),
	"utf8",
).match(/^version = "([^"]+)"/m)?.[1];
assert.ok(REPO_ADDON_VERSION, "blender_manifest.toml version is readable");

export const BRIDGE_METHODS = [
	"inspect_project",
	"inspect_entity",
	"inspect_pose_contacts",
	"inspect_relations",
	"preflight_motion",
	"inspect_performance",
	"inspect_visual_qa_metrics",
	"capture_viewport",
	"produce_directing_evidence",
	"apply_camera_plan",
	"stage_scene",
	"render_qa_frames",
	"apply_performance_mode",
	"create_fall_motion",
	"replace_camera_action",
	"inspect_motion_constraints",
	"capture_evaluated_pose",
];

export const STAGE_SCENE_OPS = (
	StageSceneOperationV1Schema as unknown as {
		anyOf: ReadonlyArray<{ properties?: { op?: { const?: string } } }>;
	}
).anyOf.flatMap((member) => (member.properties?.op?.const ? [member.properties.op.const] : []));
assert.ok(STAGE_SCENE_OPS.length > 0, "stage-scene op union yields op names");

export function surfaceCapabilities(addonVersion: string | undefined = REPO_ADDON_VERSION): string[] {
	return [
		"mutation_bridge_v2",
		"scene_manifest_v3",
		"transaction_commit_v2",
		...(addonVersion === undefined ? [] : [`cclay.addon_version=${addonVersion}`]),
		...BRIDGE_METHODS.map((method) => `cclay.method.${method}`),
		...[...new Set(STAGE_SCENE_OPS)].sort().map((op) => `cclay.op.${op}`),
	];
}
