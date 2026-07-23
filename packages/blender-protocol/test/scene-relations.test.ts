import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
	parseInspectRelationsParams,
	parseSceneRelationsResult,
	type SceneRelationsResultV1,
} from "../src/scene-relations.ts";

const GOLDEN_FIXTURE_URL = new URL(
	"../../../blender-addon/tests/fixtures/scene_relations_golden.json",
	import.meta.url,
);

const revision = "a".repeat(64);
const uuidAt = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const referenceEntityId = uuidAt(0xfff);

const baseResult: SceneRelationsResultV1 = {
	revision,
	schema_version: 1,
	reference: null,
	entities: [
		{
			entity_id: uuidAt(1),
			name: "Slab",
			type: "MESH",
			aabb_min: [0, 0, 0],
			aabb_max: [1.2, 0.4, 0.18],
			size: [1.2, 0.4, 0.18],
			top_height: 0.18,
			support_planes: [0.18],
			footprint: [1.2, 0.4],
			relative: null,
		},
	],
	patterns: [],
};

test("params: entity_ids and reference are optional lowercase UUIDv4, closed, max 64 ids", () => {
	assert.deepEqual(parseInspectRelationsParams({}), {});
	assert.deepEqual(parseInspectRelationsParams({ entity_ids: [uuidAt(1)], reference_entity_id: referenceEntityId }), {
		entity_ids: [uuidAt(1)],
		reference_entity_id: referenceEntityId,
	});
	const sixtyFour = Array.from({ length: 64 }, (_, index) => uuidAt(index));
	assert.deepEqual(parseInspectRelationsParams({ entity_ids: sixtyFour }).entity_ids?.length, 64);
	assert.throws(
		() => parseInspectRelationsParams({ entity_ids: [...sixtyFour, uuidAt(64)] }),
		/INVALID_INSPECT_RELATIONS_PARAMS/,
	);
	assert.throws(() => parseInspectRelationsParams({ entity_ids: [] }), /INVALID_INSPECT_RELATIONS_PARAMS/);
	assert.throws(
		() => parseInspectRelationsParams({ entity_ids: [uuidAt(1), uuidAt(1)] }),
		/INVALID_INSPECT_RELATIONS_PARAMS/,
	);
	assert.throws(() => parseInspectRelationsParams({ entity_ids: ["Cube"] }), /INVALID_INSPECT_RELATIONS_PARAMS/);
	assert.throws(
		() => parseInspectRelationsParams({ reference_entity_id: referenceEntityId.toUpperCase() }),
		/INVALID_INSPECT_RELATIONS_PARAMS/,
	);
	assert.throws(() => parseInspectRelationsParams({ extra: true }), /INVALID_INSPECT_RELATIONS_PARAMS/);
	// TS-vs-python null parity: null is not "absent" — optional fields reject explicit null.
	assert.throws(() => parseInspectRelationsParams({ entity_ids: null }), /INVALID_INSPECT_RELATIONS_PARAMS/);
	assert.throws(() => parseInspectRelationsParams({ reference_entity_id: null }), /INVALID_INSPECT_RELATIONS_PARAMS/);
});

test("result: parses reference:null with empty patterns and direction:null relatives", () => {
	const withNullDirection: SceneRelationsResultV1 = {
		...baseResult,
		entities: [
			{
				...baseResult.entities[0]!,
				relative: {
					offset: [0, 0, 0.5],
					horizontal_distance: 0,
					direction: null,
					top_above_reference_base: 0.18,
				},
			},
		],
	};
	assert.deepEqual(parseSceneRelationsResult(baseResult), baseResult);
	assert.deepEqual(parseSceneRelationsResult(withNullDirection), withNullDirection);
});

test("result: parses armature reference with character block and null-able rest heights", () => {
	const withCharacter: SceneRelationsResultV1 = {
		...baseResult,
		reference: {
			entity_id: referenceEntityId,
			name: "Rig",
			type: "ARMATURE",
			origin: [0.5, -1, 0],
			aabb_min: [0.1, -1.3, 0],
			aabb_max: [0.9, -0.7, 1.75],
			character: {
				world_scale: [1, 1, 1],
				standing_height: 1.75,
				bone_count: 65,
				rest_heights: { lowest: 0, pelvis: 0.95, hand: null, head: 1.62 },
			},
		},
		entities: [
			{
				...baseResult.entities[0]!,
				relative: {
					offset: [0.6, 0.2, 0.09],
					horizontal_distance: 0.632,
					direction: [0.949, 0.316],
					top_above_reference_base: 0.18,
				},
			},
		],
		patterns: [
			{
				entity_ids: [uuidAt(1), uuidAt(2), uuidAt(3)],
				count: 3,
				pitch: [0.3, 0, 0.18],
				max_deviation: 0.004,
				footprint: [1.2, 0.4],
			},
		],
	};
	assert.deepEqual(parseSceneRelationsResult(withCharacter), withCharacter);
	// Non-armature reference carries character:null.
	assert.deepEqual(
		parseSceneRelationsResult({
			...baseResult,
			reference: { ...withCharacter.reference, character: null },
		}).reference?.character,
		null,
	);
});

test("result: closed schemas reject extra properties, bad revision hex, and schema_version 2", () => {
	assert.throws(() => parseSceneRelationsResult({ ...baseResult, extra: true }), /INVALID_INSPECT_RELATIONS_RESULT/);
	assert.throws(
		() =>
			parseSceneRelationsResult({
				...baseResult,
				entities: [{ ...baseResult.entities[0], extra: true }],
			}),
		/INVALID_INSPECT_RELATIONS_RESULT/,
	);
	assert.throws(
		() => parseSceneRelationsResult({ ...baseResult, revision: "Z".repeat(64) }),
		/INVALID_INSPECT_RELATIONS_RESULT/,
	);
	assert.throws(
		() => parseSceneRelationsResult({ ...baseResult, revision: "a".repeat(63) }),
		/INVALID_INSPECT_RELATIONS_RESULT/,
	);
	assert.throws(
		() => parseSceneRelationsResult({ ...baseResult, schema_version: 2 }),
		/INVALID_INSPECT_RELATIONS_RESULT/,
	);
	assert.throws(
		() =>
			parseSceneRelationsResult({
				...baseResult,
				entities: [{ ...baseResult.entities[0], support_planes: Array.from({ length: 9 }, () => 0) }],
			}),
		/INVALID_INSPECT_RELATIONS_RESULT/,
	);
});

test("result: the 64-id request cap is not enforced on returned entities", () => {
	const entities = Array.from({ length: 65 }, (_, index) => ({
		...baseResult.entities[0]!,
		entity_id: uuidAt(index),
	}));
	assert.equal(parseSceneRelationsResult({ ...baseResult, entities }).entities.length, 65);
});

test("drift-net: python golden fixture parses with the TS result schema", () => {
	assert.ok(
		existsSync(GOLDEN_FIXTURE_URL),
		"missing blender-addon/tests/fixtures/scene_relations_golden.json — the python " +
			"add-on test suite (scene relations) must write this golden fixture; run the " +
			"add-on tests or coordinate with the addon-side relations change before shipping",
	);
	const golden: unknown = JSON.parse(readFileSync(GOLDEN_FIXTURE_URL, "utf8"));
	const parsed = parseSceneRelationsResult(golden);
	assert.equal(parsed.schema_version, 1);
	assert.equal(parsed.revision, "0".repeat(64));
	// Contract variants baked into the golden scene: armature reference with a
	// null-able rest height, one 3-crate pattern, a direction:null relative,
	// and an entity with empty support_planes.
	assert.equal(parsed.reference?.type, "ARMATURE");
	assert.equal(parsed.reference?.character?.rest_heights.hand, null);
	assert.equal(parsed.patterns.length, 1);
	assert.equal(parsed.patterns[0]?.count, 3);
	const pillar = parsed.entities.at(-1);
	assert.deepEqual(pillar?.support_planes, []);
	assert.equal(pillar?.relative?.direction, null);
});
