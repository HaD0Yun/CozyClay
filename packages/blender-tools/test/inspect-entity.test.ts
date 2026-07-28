import assert from "node:assert/strict";
import { test } from "node:test";
import { Parse } from "typebox/value";
import { createInspectEntityTool, type InspectEntityOptions, summarizeInspectEntity } from "../src/inspect-entity.ts";

const entityId = "00000000-0000-4000-8000-000000000000";
const cannedResult = { revision: "a".repeat(64), detail: { bones: [] } };

test("inspect_entity: closed params accept a bare entity_id+scope call and the three narrowing params", () => {
	const tool = createInspectEntityTool({ inspectEntity: async () => cannedResult });
	assert.equal(tool.name, "inspect_entity");
	assert.equal(tool.label, "inspect_entity");
	assert.ok("entity_id" in tool.parameters.properties);
	assert.ok("scope" in tool.parameters.properties);
	assert.ok("data_path_filter" in tool.parameters.properties);
	assert.ok("frame_start" in tool.parameters.properties);
	assert.ok("frame_end" in tool.parameters.properties);
	// Bare call: only entity_id and scope are required; the narrowing params are optional.
	assert.deepEqual(Parse(tool.parameters, { entity_id: entityId, scope: "animation" }), {
		entity_id: entityId,
		scope: "animation",
	});
	// All three narrowing params accepted together.
	assert.deepEqual(
		Parse(tool.parameters, {
			entity_id: entityId,
			scope: "all",
			data_path_filter: 'pose.bones["mixamorig:LeftFoot"]',
			frame_start: -1000000,
			frame_end: 1000000,
		}),
		{
			entity_id: entityId,
			scope: "all",
			data_path_filter: 'pose.bones["mixamorig:LeftFoot"]',
			frame_start: -1000000,
			frame_end: 1000000,
		},
	);
});

test("inspect_entity: closed params reject an unknown key and out-of-range frames", () => {
	const tool = createInspectEntityTool({ inspectEntity: async () => cannedResult });
	// additionalProperties: false — an unknown key (e.g. a typo) is rejected.
	assert.throws(() => Parse(tool.parameters, { entity_id: entityId, scope: "animation", data_path: "LeftFoot" }));
	// Bad entity id pattern.
	assert.throws(() => Parse(tool.parameters, { entity_id: "Rig", scope: "bones" }));
	// Bad scope literal.
	assert.throws(() => Parse(tool.parameters, { entity_id: entityId, scope: "rig" }));
	// data_path_filter length bounds: empty string and >128 chars rejected.
	assert.throws(() => Parse(tool.parameters, { entity_id: entityId, scope: "animation", data_path_filter: "" }));
	assert.throws(() =>
		Parse(tool.parameters, {
			entity_id: entityId,
			scope: "animation",
			data_path_filter: "x".repeat(129),
		}),
	);
	// frame_start / frame_end range bounds.
	assert.throws(() => Parse(tool.parameters, { entity_id: entityId, scope: "animation", frame_start: -1000001 }));
	assert.throws(() => Parse(tool.parameters, { entity_id: entityId, scope: "animation", frame_end: 1000001 }));
	// Non-integer frames rejected.
	assert.throws(() => Parse(tool.parameters, { entity_id: entityId, scope: "animation", frame_start: 1.5 }));
});

test("inspect_entity: forwards exactly the supplied params to the bridge and returns the payload as JSON text plus details", async () => {
	let receivedId: string | undefined;
	let receivedOptions: InspectEntityOptions | undefined;
	const tool = createInspectEntityTool({
		inspectEntity: async (id, options) => {
			receivedId = id;
			receivedOptions = options;
			return cannedResult;
		},
	});
	const params = {
		entity_id: entityId,
		scope: "animation" as const,
		data_path_filter: "LeftFoot",
		frame_start: 12,
		frame_end: 48,
	};
	const output = await tool.execute("call", params, undefined, undefined, undefined as never);
	assert.equal(receivedId, entityId);
	// Only the supplied keys are forwarded; scope is always present.
	assert.deepEqual(receivedOptions, {
		scope: "animation",
		data_path_filter: "LeftFoot",
		frame_start: 12,
		frame_end: 48,
	});
	assert.equal(output.details, cannedResult);
	assert.equal(output.content[0]?.type, "text");
	const text = output.content[0]?.type === "text" ? output.content[0].text : "{}";
	assert.deepEqual(JSON.parse(text), cannedResult);
});

test("inspect_entity: a bare call forwards only scope (no undefined narrowing keys)", async () => {
	let receivedOptions: InspectEntityOptions | undefined;
	const tool = createInspectEntityTool({
		inspectEntity: async (_id, options) => {
			receivedOptions = options;
			return cannedResult;
		},
	});
	await tool.execute("call", { entity_id: entityId, scope: "bones" }, undefined, undefined, undefined as never);
	assert.deepEqual(receivedOptions, { scope: "bones" });
});

test("inspect_entity: surfaces bridge rejection as a tool error", async () => {
	const failure = new Error("ENTITY_NOT_FOUND: unknown entity id");
	const tool = createInspectEntityTool({
		inspectEntity: async () => {
			throw failure;
		},
	});
	await assert.rejects(
		tool.execute("call", { entity_id: entityId, scope: "all" }, undefined, undefined, undefined as never),
		failure,
	);
});

test("inspect_entity: rejects frame_start > frame_end before dispatch and never calls the bridge", async () => {
	let calls = 0;
	const tool = createInspectEntityTool({
		inspectEntity: async () => {
			calls += 1;
			return cannedResult;
		},
	});
	await assert.rejects(
		tool.execute(
			"call",
			{ entity_id: entityId, scope: "animation", frame_start: 48, frame_end: 12 },
			undefined,
			undefined,
			undefined as never,
		),
		/INVALID_INSPECT_ENTITY_REQUEST: frame_start \(48\) must be <= frame_end \(12\)/,
	);
	// The refusal is local: the bridge must not be touched for an inverted range.
	assert.equal(calls, 0);
});

test("inspect_entity: accepts frame_start == frame_end (a single-frame slice) and forwards it", async () => {
	let receivedOptions: InspectEntityOptions | undefined;
	const tool = createInspectEntityTool({
		inspectEntity: async (_id, options) => {
			receivedOptions = options;
			return cannedResult;
		},
	});
	await tool.execute(
		"call",
		{ entity_id: entityId, scope: "animation", frame_start: 24, frame_end: 24 },
		undefined,
		undefined,
		undefined as never,
	);
	assert.deepEqual(receivedOptions, { scope: "animation", frame_start: 24, frame_end: 24 });
});

test("inspect_entity: folds the response into a few readable lines instead of quoting it", () => {
	// Reported from a real session as a screen of quoted JSON. The payload is
	// built for the model -- every f-curve carries its own keyframe list, so
	// even a two-frame rig fills the terminal and buries what the turn was
	// doing. The full response stays one expand away, so this is a fold and
	// not a filter.
	const lines = summarizeInspectEntity({
		scope: "animation",
		detail: {
			name: "Walker",
			type: "ARMATURE",
			parent: null,
			animationSummary: {
				curveCount: 7,
				keyframeCount: 14,
				frameStart: 1,
				frameEnd: 2,
				groupCount: 1,
				groups: [{ name: "mixamorig:Hips", curveCount: 7, keyframeCount: 14 }],
				truncated: null,
			},
		},
	});

	assert.deepEqual(lines, [
		"Walker  ARMATURE  scope animation",
		"7 curves, 14 keys, frames 1-2",
		"  mixamorig:Hips  7 curves, 14 keys",
	]);
});

test("inspect_entity: counts bones and material slots rather than listing every one", () => {
	assert.deepEqual(
		summarizeInspectEntity({
			scope: "all",
			detail: {
				name: "Walker",
				type: "ARMATURE",
				parent: "Rig",
				bones: [{}, {}, {}],
				bonesOmitted: 4,
				materials: [
					{ slot: "Body", material: "Skin" },
					{ slot: "Eyes", material: null },
				],
				materialsOmitted: 2,
			},
		}),
		[
			"Walker  ARMATURE  scope all",
			"parent Rig",
			"3 bones (+4 omitted)",
			"2 material slots (+2 omitted)",
			"  Body  Skin",
			"  Eyes  (empty)",
		],
	);
});

test("inspect_entity: a payload with no detail summarizes to nothing rather than throwing", () => {
	// A renderer must never be the thing that breaks on an unexpected response.
	assert.deepEqual(summarizeInspectEntity({}), []);
	assert.deepEqual(summarizeInspectEntity({ scope: "bones", detail: {} }), []);
});
