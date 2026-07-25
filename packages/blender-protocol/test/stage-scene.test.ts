import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	canonicalizeStageScenePlan,
	HAND_SHAPE_NAMES,
	parseStageSceneMutationCandidate,
	parseStageScenePlan,
	type StageScenePlanV1,
	StageSceneValidationError,
} from "../src/stage-scene.ts";

const fixture = (name: string): Promise<unknown> =>
	readFile(new URL(`fixtures/stage-scene/${name}.json`, import.meta.url), "utf8").then(JSON.parse);

const IDS = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
	"33333333-3333-4333-8333-333333333333",
];

test("parses the committed closed StageScenePlanV1 fixture", async () => {
	const plan = parseStageScenePlan(await fixture("valid-plan"));
	assert.equal(plan.operations.length, 4);
	assert.deepEqual(
		plan.operations.map((operation) => operation.op),
		["add_primitive", "set_material_color", "upsert_area_light", "delete_entity"],
	);
});

test("rejects unknown fields with the schema-only error code", async () => {
	const value = await fixture("invalid-unknown-field");
	assert.throws(
		() => parseStageScenePlan(value),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_PLAN_SCHEMA",
	);
});

test("parses a closed per-entity identity mapping", async () => {
	const v2 = JSON.parse(
		await readFile(
			new URL("../../director-core/test/fixtures/scene-manifest-v2-parity.json", import.meta.url),
			"utf8",
		),
	) as Record<string, unknown>;
	const manifest = {
		...v2,
		schemaVersion: 3,
		lights: [],
		stagePrimitives: [],
		stageMaterials: [],
	};
	const candidate = parseStageSceneMutationCandidate({
		expected_revision_id: "a".repeat(64),
		scene_hash: v2.sceneHash as string,
		manifest,
		entity_identities: [
			{
				entity_id: IDS[0],
				requested_name: "Requested Name",
				actual_name: "Actual Name.001",
			},
		],
		applied_hand_shapes: [
			{
				operation_index: 0,
				entity_id: IDS[0],
				motion_id: "walk",
				left: "relaxed",
				right: "open",
				library_version: "1.1.0",
			},
		],
	});
	assert.equal(candidate.entity_identities[0]?.actual_name, "Actual Name.001");
	assert.deepEqual(candidate.applied_hand_shapes, [
		{
			operation_index: 0,
			entity_id: IDS[0],
			motion_id: "walk",
			left: "relaxed",
			right: "open",
			library_version: "1.1.0",
		},
	]);
	assert.deepEqual(Object.keys(candidate).sort(), [
		"applied_hand_shapes",
		"entity_identities",
		"expected_revision_id",
		"manifest",
		"scene_hash",
	]);

	const extra = structuredClone(candidate);
	(extra.entity_identities[0] as Record<string, unknown>).unexpected = true;
	assert.throws(() => parseStageSceneMutationCandidate(extra), /INVALID_MUTATION_RESULT/);

	const missingAppliedRows = structuredClone(candidate) as unknown as Record<string, unknown>;
	delete missingAppliedRows.applied_hand_shapes;
	assert.throws(() => parseStageSceneMutationCandidate(missingAppliedRows), /INVALID_MUTATION_RESULT/);

	for (const field of ["optimization", "mode", "tolerance", "fallback"]) {
		const extendedCandidate = { ...candidate, [field]: true };
		assert.throws(() => parseStageSceneMutationCandidate(extendedCandidate), /INVALID_MUTATION_RESULT/);
	}

	for (const invalidRow of [
		{ ...candidate.applied_hand_shapes[0], left: "unknown" },
		{ ...candidate.applied_hand_shapes[0], library_version: "2.0.0" },
		{ ...candidate.applied_hand_shapes[0], operation_index: -1 },
		{ ...candidate.applied_hand_shapes[0], unexpected: true },
	]) {
		const invalidCandidate = { ...candidate, applied_hand_shapes: [invalidRow] };
		assert.throws(() => parseStageSceneMutationCandidate(invalidCandidate), /INVALID_MUTATION_RESULT/);
	}
});

test("rejects duplicate daemon-issued entity IDs with a distinct code", async () => {
	const value = await fixture("invalid-duplicate-entity-id");
	assert.throws(
		() => parseStageScenePlan(value),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "STAGE_SCENE_ENTITY_ID_DUPLICATE",
	);
});

test("rejects duplicate stable names with a distinct code", async () => {
	const plan = (await fixture("valid-plan")) as StageScenePlanV1;
	const light = plan.operations[2] as Extract<StageScenePlanV1["operations"][number], { op: "upsert_area_light" }>;
	plan.operations[2] = { ...light, name: "Floor" };
	assert.throws(
		() => parseStageScenePlan(plan),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "STAGE_SCENE_STABLE_NAME_DUPLICATE",
	);
});

test("daemon canonicalization allocates UUIDs only for newly created entities", () => {
	const allocated = [...IDS];
	const plan = canonicalizeStageScenePlan(
		{
			schema_version: 1,
			expected_revision_id: "a".repeat(64),
			operations: [
				{
					op: "add_primitive",
					primitive_type: "CUBE",
					name: "Hero Cube",
					location: [0, 0, 1],
					rotation: [0, 0, 0],
					scale: [1, 1, 1],
				},
				{
					op: "set_material_color",
					object_name: "Hero Cube",
					color: [0.8, 0.2, 0.1, 1],
				},
				{
					op: "upsert_area_light",
					name: "Key Light",
					location: [4, -4, 6],
					rotation: [0.5, 0, 0.8],
					scale: [1, 1, 1],
					energy: 800,
					color: [1, 0.9, 0.8],
					size: 3,
				},
				{
					op: "upsert_area_light",
					entity_id: IDS[2],
					name: "Existing Fill",
					location: [-4, 2, 3],
					rotation: [0, 0, -0.8],
					scale: [1, 1, 1],
					energy: 200,
					color: [0.5, 0.7, 1],
					size: 2,
				},
			],
		},
		() => allocated.shift()!,
	);
	assert.deepEqual(
		plan.operations.map((operation) =>
			operation.op === "add_primitive" || operation.op === "upsert_area_light" ? operation.entity_id : undefined,
		),
		[IDS[0], undefined, IDS[1], IDS[2]],
	);
	assert.equal(allocated.length, 1);
	assert.equal(plan.operations[1]?.op, "set_material_color");
	assert.equal(plan.operations[1]?.op === "set_material_color" ? plan.operations[1].entity_id : undefined, IDS[0]);
});

const canonicalizeMaterialColorByName = (operation: Record<string, unknown>): StageScenePlanV1 =>
	canonicalizeStageScenePlan(
		{
			schema_version: 1,
			expected_revision_id: "a".repeat(64),
			operations: [
				{
					op: "add_primitive",
					primitive_type: "CUBE",
					name: "Hero Cube",
					location: [0, 0, 1],
					rotation: [0, 0, 0],
					scale: [1, 1, 1],
				},
				operation,
			],
		},
		() => IDS[0],
	);

test("set_material_color by name preserves roughness through canonicalization", () => {
	const plan = canonicalizeMaterialColorByName({
		op: "set_material_color",
		object_name: "Hero Cube",
		color: [0.8, 0.2, 0.1, 1],
		roughness: 0.28,
	});
	const resolved = plan.operations[1];
	assert.equal(resolved?.op, "set_material_color");
	if (resolved?.op !== "set_material_color") return;
	assert.equal(resolved.entity_id, IDS[0]);
	assert.deepEqual(resolved.color, [0.8, 0.2, 0.1, 1]);
	assert.equal(resolved.roughness, 0.28);
	assert.equal("metallic" in resolved, false);
});

test("set_material_color by name preserves metallic through canonicalization", () => {
	const plan = canonicalizeMaterialColorByName({
		op: "set_material_color",
		object_name: "Hero Cube",
		color: [0.8, 0.2, 0.1, 1],
		metallic: 0.9,
	});
	const resolved = plan.operations[1];
	assert.equal(resolved?.op, "set_material_color");
	if (resolved?.op !== "set_material_color") return;
	assert.equal(resolved.entity_id, IDS[0]);
	assert.deepEqual(resolved.color, [0.8, 0.2, 0.1, 1]);
	assert.equal("roughness" in resolved, false);
	assert.equal(resolved.metallic, 0.9);
});

test("set_material_color by name preserves both roughness and metallic through canonicalization", () => {
	const plan = canonicalizeMaterialColorByName({
		op: "set_material_color",
		object_name: "Hero Cube",
		color: [0.8, 0.2, 0.1, 1],
		roughness: 0.28,
		metallic: 0.9,
	});
	const resolved = plan.operations[1];
	assert.equal(resolved?.op, "set_material_color");
	if (resolved?.op !== "set_material_color") return;
	assert.equal(resolved.entity_id, IDS[0]);
	assert.deepEqual(resolved.color, [0.8, 0.2, 0.1, 1]);
	assert.equal(resolved.roughness, 0.28);
	assert.equal(resolved.metallic, 0.9);
});

test("set_material_color by name without finish fields resolves to op/entity_id/color only", () => {
	const plan = canonicalizeMaterialColorByName({
		op: "set_material_color",
		object_name: "Hero Cube",
		color: [0.8, 0.2, 0.1, 1],
	});
	const resolved = plan.operations[1];
	assert.equal(resolved?.op, "set_material_color");
	if (resolved?.op !== "set_material_color") return;
	assert.equal(resolved.entity_id, IDS[0]);
	assert.deepEqual(resolved.color, [0.8, 0.2, 0.1, 1]);
	assert.equal("roughness" in resolved, false);
	assert.equal("metallic" in resolved, false);
	assert.deepEqual(Object.keys(resolved).sort(), ["color", "entity_id", "op"]);
});

test("add_camera allocates an identity and keeps lens optional", () => {
	const allocated = [...IDS];
	const plan = canonicalizeStageScenePlan(
		{
			schema_version: 1,
			expected_revision_id: "a".repeat(64),
			operations: [
				{
					op: "add_camera",
					name: "Shot Camera",
					location: [4, -6, 3],
					rotation: [1.1, 0, 0.6],
				},
				{
					op: "add_camera",
					name: "Close Camera",
					location: [1, -2, 2],
					rotation: [1.2, 0, 0.2],
					lens: 70,
				},
			],
		},
		() => allocated.shift()!,
	);
	assert.deepEqual(
		plan.operations.map((operation) => (operation.op === "add_camera" ? operation.entity_id : undefined)),
		[IDS[0], IDS[1]],
	);
	assert.equal(plan.operations[0]?.op === "add_camera" ? plan.operations[0].lens : null, undefined);
	assert.equal(plan.operations[1]?.op === "add_camera" ? plan.operations[1].lens : null, 70);
});

test("add_camera rejects request-selected IDs and invalid lens values", () => {
	const base = {
		op: "add_camera" as const,
		name: "Shot Camera",
		location: [4, -6, 3] as [number, number, number],
		rotation: [1.1, 0, 0.6] as [number, number, number],
	};
	for (const operation of [
		{ ...base, entity_id: IDS[0] },
		{ ...base, lens: 0 },
		{ ...base, lens: "50" },
	]) {
		assert.throws(
			() =>
				canonicalizeStageScenePlan(
					{ schema_version: 1, expected_revision_id: "a".repeat(64), operations: [operation] },
					() => IDS[1],
				),
			(error: unknown) =>
				error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_REQUEST_SCHEMA",
		);
	}
});

test("request-side callers cannot choose an add_primitive entity ID", () => {
	assert.throws(
		() =>
			canonicalizeStageScenePlan(
				{
					schema_version: 1,
					expected_revision_id: "a".repeat(64),
					operations: [
						{
							op: "add_primitive",
							entity_id: IDS[0],
							primitive_type: "PLANE",
							name: "Floor",
							location: [0, 0, 0],
							rotation: [0, 0, 0],
							scale: [5, 5, 1],
						},
					],
				},
				() => IDS[1],
			),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_REQUEST_SCHEMA",
	);
});

test("parses add_character plans and allocates request-side entity IDs", () => {
	const plan = parseStageScenePlan({
		schema_version: 1,
		expected_revision_id: "a".repeat(64),
		operations: [
			{
				op: "add_character",
				entity_id: IDS[0],
				character_type: "Y_BOT",
				name: "Fighter One",
				location: [1, 0, 0],
				rotation: [0, 0, 0],
				scale: [1, 1, 1],
			},
		],
	});
	assert.equal(plan.operations[0]?.op, "add_character");

	let allocated = 0;
	const canonical = canonicalizeStageScenePlan(
		{
			schema_version: 1,
			expected_revision_id: "a".repeat(64),
			operations: [
				{
					op: "add_character",
					character_type: "X_BOT",
					name: "Fighter Two",
					location: [-1, 0, 0],
					rotation: [0, 0, 0],
					scale: [1, 1, 1],
				},
			],
		},
		() => {
			allocated++;
			return IDS[1];
		},
	);
	assert.equal(allocated, 1);
	const operation = canonical.operations[0];
	assert.equal(operation?.op === "add_character" && operation.entity_id, IDS[1]);
});

test("rejects unknown character types and duplicate character identities", () => {
	const character = (entityId: string) => ({
		op: "add_character",
		entity_id: entityId,
		character_type: "Y_BOT",
		name: "Fighter One",
		location: [0, 0, 0],
		rotation: [0, 0, 0],
		scale: [1, 1, 1],
	});
	assert.throws(
		() =>
			parseStageScenePlan({
				schema_version: 1,
				expected_revision_id: "a".repeat(64),
				operations: [{ ...character(IDS[0]), character_type: "Z_BOT" }],
			}),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_PLAN_SCHEMA",
	);
	assert.throws(
		() =>
			parseStageScenePlan({
				schema_version: 1,
				expected_revision_id: "a".repeat(64),
				operations: [character(IDS[0]), character(IDS[0])],
			}),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "STAGE_SCENE_ENTITY_ID_DUPLICATE",
	);
});

test("parses adopt_entity plans with a closed exact-key shape", () => {
	const plan = parseStageScenePlan({
		schema_version: 1,
		expected_revision_id: "a".repeat(64),
		operations: [{ op: "adopt_entity", entity_id: IDS[0] }],
	});
	assert.equal(plan.operations[0]?.op, "adopt_entity");
	assert.equal(plan.operations[0]?.op === "adopt_entity" ? plan.operations[0].entity_id : undefined, IDS[0]);
});

test("rejects adopt_entity unknown fields and non-UUID entity ids", () => {
	for (const operation of [
		{ op: "adopt_entity", entity_id: IDS[0], name: "Cube" },
		{ op: "adopt_entity", entity_id: "not-a-uuid" },
		{ op: "adopt_entity", entity_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
		{ op: "adopt_entity" },
	]) {
		assert.throws(
			() =>
				parseStageScenePlan({
					schema_version: 1,
					expected_revision_id: "a".repeat(64),
					operations: [operation],
				}),
			(error: unknown) =>
				error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_PLAN_SCHEMA",
		);
	}
});

test("request canonicalization passes adopt_entity through without allocating ids", () => {
	const plan = canonicalizeStageScenePlan(
		{
			schema_version: 1,
			expected_revision_id: "a".repeat(64),
			operations: [
				{ op: "adopt_entity", entity_id: IDS[0] },
				{ op: "delete_entity", entity_id: IDS[0] },
			],
		},
		() => {
			throw new Error("adopt_entity must not allocate entity ids");
		},
	);
	assert.deepEqual(plan.operations, [
		{ op: "adopt_entity", entity_id: IDS[0] },
		{ op: "delete_entity", entity_id: IDS[0] },
	]);
});

test("preserves mixed apply_motion wire operations without adding defaults or changing order", () => {
	const operations = [
		{ op: "set_render_settings", fps: 24 },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "idle" },
		{ op: "apply_motion", entity_id: IDS[1], motion_id: "walk", start_frame: 12, hand_pose: "open" },
		{
			op: "apply_motion",
			entity_id: IDS[2],
			motion_id: "wave",
			hand_shapes: { left: "point", right: "cup" },
		},
		{ op: "set_render_settings", resolution_x: 1920, resolution_y: 1080 },
	];
	const plan = canonicalizeStageScenePlan(
		{
			schema_version: 1,
			expected_revision_id: "a".repeat(64),
			operations,
		},
		() => {
			throw new Error("apply_motion must not allocate entity ids");
		},
	);

	assert.deepEqual(plan.operations, operations);
	assert.deepEqual(Object.keys(plan.operations[1]!).sort(), ["entity_id", "motion_id", "op"]);
	assert.deepEqual(Object.keys(plan.operations[2]!).sort(), [
		"entity_id",
		"hand_pose",
		"motion_id",
		"op",
		"start_frame",
	]);
	assert.deepEqual(Object.keys(plan.operations[3]!).sort(), ["entity_id", "hand_shapes", "motion_id", "op"]);
});

test("rejects optimization controls on the closed apply_motion wire request", () => {
	for (const [field, value] of [
		["optimization", "bulk"],
		["mode", "dense"],
		["tolerance", 0.001],
		["fallback", "legacy"],
		["optimization_mode", "dense"],
		["optimization_tolerance", 0.001],
		["optimization_fallback", "legacy"],
	] as const) {
		assert.throws(
			() =>
				canonicalizeStageScenePlan(
					{
						schema_version: 1,
						expected_revision_id: "a".repeat(64),
						operations: [
							{
								op: "apply_motion",
								entity_id: IDS[0],
								motion_id: "walk",
								[field]: value,
							},
						],
					},
					() => IDS[1],
				),
			(error: unknown) =>
				error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_REQUEST_SCHEMA",
		);
	}
});
test("parses all five closed apply_motion hand forms", () => {
	const plan = canonicalizeStageScenePlan(
		{
			schema_version: 1,
			expected_revision_id: "a".repeat(64),
			operations: [
				{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave-0722" },
				{ op: "apply_motion", entity_id: IDS[0], motion_id: "walk", start_frame: 40, hand_pose: "open" },
				{ op: "apply_motion", entity_id: IDS[0], motion_id: "walk", hand_shapes: { left: "fist" } },
				{ op: "apply_motion", entity_id: IDS[0], motion_id: "walk", hand_shapes: { right: "point" } },
				{
					op: "apply_motion",
					entity_id: IDS[0],
					motion_id: "walk",
					hand_shapes: { left: "cup", right: "thumb_extended" },
				},
			],
		},
		() => {
			throw new Error("apply_motion must not allocate entity ids");
		},
	);
	assert.equal(plan.operations.length, 5);
	assert.equal(plan.operations[0]?.op === "apply_motion" ? plan.operations[0].motion_id : undefined, "wave-0722");
	assert.equal(
		plan.operations[1]?.op === "apply_motion" && "hand_pose" in plan.operations[1]
			? plan.operations[1].hand_pose
			: undefined,
		"open",
	);
	assert.deepEqual(
		plan.operations
			.slice(2)
			.map((operation) =>
				operation.op === "apply_motion" && "hand_shapes" in operation ? operation.hand_shapes : undefined,
			),
		[{ left: "fist" }, { right: "point" }, { left: "cup", right: "thumb_extended" }],
	);
});

test("accepts every frozen hand-shape preset literal", () => {
	const frozenNames = [
		"relaxed",
		"open",
		"fist",
		"soft_fist",
		"point",
		"two_finger",
		"cup",
		"grasp",
		"thumb_extended",
		"three_finger",
		"hook",
	] as const;
	assert.deepEqual(HAND_SHAPE_NAMES, frozenNames);
	const plan = parseStageScenePlan({
		schema_version: 1,
		expected_revision_id: "a".repeat(64),
		operations: frozenNames.map((left) => ({
			op: "apply_motion" as const,
			entity_id: IDS[0],
			motion_id: "walk",
			hand_shapes: { left },
		})),
	});
	assert.deepEqual(
		plan.operations.map((operation) =>
			operation.op === "apply_motion" && "hand_shapes" in operation && "left" in operation.hand_shapes
				? operation.hand_shapes.left
				: undefined,
		),
		frozenNames,
	);
});

test("rejects apply_motion traversal slugs, unknown fields, and bad frames", () => {
	for (const operation of [
		{ op: "apply_motion", entity_id: IDS[0] },
		{ op: "apply_motion", motion_id: "wave" },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "Wave" },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "../etc" },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "a".repeat(65) },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "" },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", start_frame: 100001 },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", start_frame: 1.5 },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", npz_path: "/tmp/x.npz" },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", hand_pose: "fist" },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", hand_shapes: {} },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", hand_shapes: null },
		{
			op: "apply_motion",
			entity_id: IDS[0],
			motion_id: "wave",
			hand_pose: "open",
			hand_shapes: { left: "fist" },
		},
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", hand_shapes: { left: null } },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", hand_shapes: { left: "unknown" } },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", hand_shapes: { left: "pinch" } },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", hand_shapes: { left: "precision_pinch" } },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", hand_shapes: { left: "ok" } },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", hand_shapes: { left: "spread" } },
		{ op: "apply_motion", entity_id: IDS[0], motion_id: "wave", hand_shapes: { left: "flat" } },
		{
			op: "apply_motion",
			entity_id: IDS[0],
			motion_id: "wave",
			hand_shapes: { left: "fist", unexpected: true },
		},
	]) {
		assert.throws(
			() =>
				parseStageScenePlan({
					schema_version: 1,
					expected_revision_id: "a".repeat(64),
					operations: [operation],
				}),
			(error: unknown) =>
				error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_PLAN_SCHEMA",
		);
	}
});

test("apply_motion accepts a hand_track per side in clip frames", () => {
	const plan = parseStageScenePlan({
		schema_version: 1,
		expected_revision_id: "a".repeat(64),
		operations: [
			{
				op: "apply_motion",
				entity_id: IDS[0],
				motion_id: "reach",
				hand_track: {
					right: [
						{ frame: 0, preset: "open" },
						{ frame: 38, preset: "grasp" },
					],
				},
			},
			{
				op: "apply_motion",
				entity_id: IDS[0],
				motion_id: "reach",
				hand_track: {
					left: [{ frame: 4, preset: "relaxed" }],
					right: [
						{ frame: 0, preset: "open" },
						{ frame: 70, preset: "grasp" },
					],
				},
			},
		],
	});
	const first = plan.operations[0]!;
	assert.ok(first.op === "apply_motion" && "hand_track" in first);
	assert.deepEqual(first.hand_track, {
		right: [
			{ frame: 0, preset: "open" },
			{ frame: 38, preset: "grasp" },
		],
	});
});

test("apply_motion rejects malformed and conflicting hand tracks", () => {
	const base = { op: "apply_motion" as const, entity_id: IDS[0], motion_id: "reach" };
	const rejected = [
		// A track must carry at least one key on at least one side.
		{ ...base, hand_track: {} },
		{ ...base, hand_track: { right: [] } },
		{ ...base, hand_track: null },
		// Keys are exactly {frame, preset}, with a known preset.
		{ ...base, hand_track: { right: [{ frame: 0 }] } },
		{ ...base, hand_track: { right: [{ preset: "open" }] } },
		{ ...base, hand_track: { right: [{ frame: 0, preset: "open", ease: 2 }] } },
		{ ...base, hand_track: { right: [{ frame: 0, preset: "pinch" }] } },
		// Clip frames are non-negative; scene offsets belong in start_frame.
		{ ...base, hand_track: { right: [{ frame: -1, preset: "open" }] } },
		{ ...base, hand_track: { right: [{ frame: 1.5, preset: "open" }] } },
		{ ...base, hand_track: { middle: [{ frame: 0, preset: "open" }] } },
		// A clip-wide shape and a track are two ways to say the same thing.
		{ ...base, hand_shapes: { left: "fist" }, hand_track: { right: [{ frame: 0, preset: "open" }] } },
		{ ...base, hand_pose: "relaxed", hand_track: { right: [{ frame: 0, preset: "open" }] } },
		// Bounded like every other wire array.
		{
			...base,
			hand_track: {
				right: Array.from({ length: 33 }, (_unused, index) => ({
					frame: index,
					preset: "open" as const,
				})),
			},
		},
	];
	for (const operation of rejected) {
		assert.throws(
			() =>
				parseStageScenePlan({
					schema_version: 1,
					expected_revision_id: "a".repeat(64),
					operations: [operation],
				}),
			(error: unknown) =>
				error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_PLAN_SCHEMA",
			`expected rejection for ${JSON.stringify(operation)}`,
		);
	}
});
