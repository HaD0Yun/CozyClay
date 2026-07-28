import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoseContactsResultV1 } from "@cclay/protocol";
import { createInspectPoseContactsTool, summarizeInspectPoseContacts } from "../src/inspect-pose-contacts.ts";

const REVISION = "a".repeat(64);
const character = "00000000-0000-4000-8000-000000000001";
const support = "00000000-0000-4000-8000-000000000002";

const cannedResult = {
	revision: REVISION,
	schema_version: 1,
	character_entity_id: character,
	gate: { max_gap_m: 0.03, min_edge_margin_m: 0 },
	frames: [
		{
			frame: 12,
			sides: {
				left: {
					foot_joint_position: [0, 0, 0.09],
					toe_joint_position: [0, 0.12, 0.03],
					heel_point: [0, -0.05, 0.01],
					toe_point: [0, 0.12, 0.01],
					sole_point: [0, 0.02, 0.004],
					sole_source: "vertex_group",
					heel_to_toe_m: [0, 0.17, 0],
					joint_to_sole_offset_m: [0, 0.02, -0.086],
					contact_basis: "deformed_mesh",
					support: {
						support_entity_id: support,
						support_height_m: 0,
						support_gap_m: 0.004,
						inside_support_footprint: true,
						edge_margin_m: 0.12,
						footprint_basis: "aabb_xy",
						surface_contact_verified: true,
					},
				},
				right: {
					foot_joint_position: [0.2, 0, 0.12],
					toe_joint_position: [0.2, 0.12, 0.06],
					heel_point: null,
					toe_point: null,
					sole_point: null,
					sole_source: null,
					heel_to_toe_m: null,
					joint_to_sole_offset_m: null,
					contact_basis: "deformed_mesh",
					support: null,
				},
			},
		},
	],
} as PoseContactsResultV1;

test("inspect_pose_contacts: forwards params and returns round-trippable JSON text", async () => {
	let received: unknown;
	const tool = createInspectPoseContactsTool({
		inspectPoseContacts: async (params) => {
			received = params;
			return cannedResult;
		},
	});
	const params = { character_entity_id: character, frames: [12], support_entity_ids: [support] };
	const output = await tool.execute("call", params, undefined, undefined, undefined as never);
	assert.deepEqual(received, params);
	assert.equal(output.details, cannedResult);
	const text = output.content[0]?.type === "text" ? output.content[0].text : "{}";
	assert.deepEqual(JSON.parse(text), cannedResult);
});

test("inspect_pose_contacts: folds the gate and per-frame sole verdicts into readable lines", () => {
	assert.deepEqual(summarizeInspectPoseContacts(cannedResult), [
		`gate ±0.03m edge >=0m  1/1 sole contacts verified  rev ${"a".repeat(12)}`,
		"frame 12  L:ok gap +0.004m inside  R:sole n/a",
	]);
});

test("inspect_pose_contacts: an unexpected payload folds to nothing rather than throwing", () => {
	assert.deepEqual(summarizeInspectPoseContacts(undefined), []);
	assert.deepEqual(summarizeInspectPoseContacts({ frames: "not-a-list" }), []);
});
