import assert from "node:assert/strict";
import { test } from "node:test";
import { Parse } from "typebox/value";
import { createInspectRelationsTool, summarizeInspectRelations } from "../src/inspect-relations.ts";

const uuidAt = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const referenceEntityId = uuidAt(0xfff);
const cannedResult = {
	revision: "a".repeat(64),
	schema_version: 1,
	reference: {
		entity_id: referenceEntityId,
		name: "Rig",
		type: "ARMATURE",
		origin: [0, 0, 0],
		aabb_min: [-0.4, -0.3, 0],
		aabb_max: [0.4, 0.3, 1.75],
		character: {
			world_scale: [1, 1, 1],
			standing_height: 1.75,
			bone_count: 65,
			rest_heights: { lowest: 0, pelvis: 0.95, hand: 0.82, head: 1.62 },
		},
	},
	entities: [
		{
			entity_id: uuidAt(1),
			name: "Slab",
			type: "MESH",
			aabb_min: [1, 0, 0],
			aabb_max: [2.2, 0.4, 0.18],
			size: [1.2, 0.4, 0.18],
			top_height: 0.18,
			support_planes: [0.18],
			footprint: [1.2, 0.4],
			relative: {
				offset: [1.6, 0.2, 0.09],
				horizontal_distance: 1.612,
				direction: [0.992, 0.124],
				top_above_reference_base: 0.18,
			},
		},
	],
	patterns: [],
};

test("inspect_relations: closed params take <=64 lowercase UUIDv4 ids plus optional uuid reference", () => {
	const tool = createInspectRelationsTool({ inspectRelations: async () => cannedResult });
	assert.equal(tool.name, "inspect_relations");
	assert.equal(tool.label, "inspect_relations");
	assert.ok("entity_ids" in tool.parameters.properties);
	assert.ok("reference_entity_id" in tool.parameters.properties);
	assert.deepEqual(Parse(tool.parameters, {}), {});
	const sixtyFour = Array.from({ length: 64 }, (_, index) => uuidAt(index));
	assert.deepEqual(Parse(tool.parameters, { entity_ids: sixtyFour }), { entity_ids: sixtyFour });
	assert.throws(() => Parse(tool.parameters, { entity_ids: [...sixtyFour, uuidAt(64)] }));
	// uniqueItems: duplicate ids are rejected at the tool boundary too.
	assert.throws(() => Parse(tool.parameters, { entity_ids: [uuidAt(1), uuidAt(1)] }));
	assert.throws(() => Parse(tool.parameters, { reference_entity_id: "Rig" }));
	// additionalProperties: false — unknown keys (e.g. typos) are rejected.
	assert.throws(() => Parse(tool.parameters, { entity_id: referenceEntityId }));
	assert.throws(() => Parse(tool.parameters, { depth: 1 }));
});

test("inspect_relations: forwards params to the bridge and returns round-trippable JSON text", async () => {
	let received: unknown;
	const tool = createInspectRelationsTool({
		inspectRelations: async (params) => {
			received = params;
			return cannedResult;
		},
	});
	const params = { entity_ids: [uuidAt(1)], reference_entity_id: referenceEntityId };
	const output = await tool.execute("call", params, undefined, undefined, undefined as never);
	assert.deepEqual(received, params);
	assert.equal(output.details, cannedResult);
	assert.equal(output.content[0]?.type, "text");
	const text = output.content[0]?.type === "text" ? output.content[0].text : "{}";
	assert.deepEqual(JSON.parse(text), cannedResult);
});

test("inspect_relations: surfaces bridge rejection as a tool error", async () => {
	const failure = new Error("ENTITY_NOT_FOUND: unknown entity id");
	const tool = createInspectRelationsTool({
		inspectRelations: async () => {
			throw failure;
		},
	});
	await assert.rejects(
		tool.execute("call", { entity_ids: [uuidAt(1)] }, undefined, undefined, undefined as never),
		failure,
	);
});

test("inspect_relations: folds reference, entity measurements, and patterns into bounded lines", () => {
	const lines = summarizeInspectRelations({
		...cannedResult,
		patterns: [{ entity_ids: [uuidAt(1)], count: 3, pitch: [1.2, 0], max_deviation: 0.002, footprint: [1.2, 0.4] }],
	});
	assert.deepEqual(lines, [
		`1 entities, 1 patterns  rev ${"a".repeat(12)}`,
		"reference Rig  ARMATURE  height 1.75m  65 bones",
		"  Slab  MESH  size [1.2, 0.4, 0.18]  top 0.18m  supports [0.18]  rel 1.612m",
		"  pattern x3  pitch [1.2, 0]  dev 0.002m",
	]);
});

test("inspect_relations: an unexpected payload folds to nothing rather than throwing", () => {
	assert.deepEqual(summarizeInspectRelations(undefined), []);
	assert.deepEqual(summarizeInspectRelations({ entities: "not-a-list" }), []);
});
