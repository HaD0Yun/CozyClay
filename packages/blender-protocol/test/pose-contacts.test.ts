import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
	type PoseContactSideV1,
	type PoseContactsResultV1,
	parseInspectPoseContactsParams,
	parsePoseContactsResult,
} from "../src/pose-contacts.ts";

// Drift-net: if the python add-on (item D of CozyClay issue #2) writes its
// pose-contacts fixture, this TS schema must be able to parse it verbatim.
const GOLDEN_FIXTURE_URL = new URL("../../../blender-addon/tests/fixtures/pose_contacts_golden.json", import.meta.url);

const revision = "a".repeat(64);
const uuidAt = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const characterEntityId = uuidAt(1);
const supportEntityId = uuidAt(2);

const leftSide: PoseContactSideV1 = {
	foot_joint_position: [0.15, 0.24, 1.9],
	toe_joint_position: [0.15, 0.34, 1.9],
	heel_point: [0.15, 0.22, 1.78],
	toe_point: [0.15, 0.36, 1.8],
	sole_point: [0.15, 0.29, 1.78],
	sole_source: "deformed_mesh",
	heel_to_toe_m: [0, 0.14, 0.02],
	joint_to_sole_offset_m: [0, 0.05, -0.12],
	contact_basis: "deformed_mesh",
	support: {
		support_entity_id: supportEntityId,
		support_height_m: 1.8,
		support_gap_m: -0.02,
		inside_support_footprint: true,
		edge_margin_m: 0.08,
		footprint_basis: "aabb_xy",
		surface_contact_verified: true,
	},
};

const rightSide: PoseContactSideV1 = {
	...leftSide,
	foot_joint_position: [-0.15, 0.24, 1.9],
	toe_joint_position: [-0.15, 0.34, 1.9],
	support: null,
};

const baseResult: PoseContactsResultV1 = {
	revision,
	schema_version: 1,
	character_entity_id: characterEntityId,
	gate: { max_gap_m: 0.03, min_edge_margin_m: 0.0 },
	frames: [{ frame: 128, sides: { left: leftSide, right: rightSide } }],
};

test("params: requires character_entity_id, unique 1..32 frames, unique 1..16 support ids, closed", () => {
	const valid = {
		character_entity_id: characterEntityId,
		frames: [128, 143, 156],
		support_entity_ids: [supportEntityId],
	};
	assert.deepEqual(parseInspectPoseContactsParams(valid), valid);

	const thirtyTwoFrames = { ...valid, frames: Array.from({ length: 32 }, (_, i) => i) };
	assert.equal(parseInspectPoseContactsParams(thirtyTwoFrames).frames.length, 32);
	assert.throws(
		() => parseInspectPoseContactsParams({ ...valid, frames: Array.from({ length: 33 }, (_, i) => i) }),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
	);

	const sixteenSupports = { ...valid, support_entity_ids: Array.from({ length: 16 }, (_, i) => uuidAt(i + 10)) };
	assert.equal(parseInspectPoseContactsParams(sixteenSupports).support_entity_ids.length, 16);
	assert.throws(
		() =>
			parseInspectPoseContactsParams({
				...valid,
				support_entity_ids: Array.from({ length: 17 }, (_, i) => uuidAt(i + 10)),
			}),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
	);

	// Empty arrays are impossible sizes, not "no filter".
	assert.throws(
		() => parseInspectPoseContactsParams({ ...valid, frames: [] }),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
	);
	assert.throws(
		() => parseInspectPoseContactsParams({ ...valid, support_entity_ids: [] }),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
	);

	// Uniqueness.
	assert.throws(
		() => parseInspectPoseContactsParams({ ...valid, frames: [128, 128] }),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
	);
	assert.throws(
		() => parseInspectPoseContactsParams({ ...valid, support_entity_ids: [supportEntityId, supportEntityId] }),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
	);

	// Frames are scene-frame integers, not clip floats/strings/negatives/bools.
	for (const frames of [[1.5], ["128"], [true], [-1]]) {
		assert.throws(() => parseInspectPoseContactsParams({ ...valid, frames }), /INVALID_INSPECT_POSE_CONTACTS_PARAMS/);
	}

	// Malformed / uppercase UUIDs fail closed.
	assert.throws(
		() => parseInspectPoseContactsParams({ ...valid, character_entity_id: "not-a-uuid" }),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
	);
	assert.throws(
		() => parseInspectPoseContactsParams({ ...valid, character_entity_id: uuidAt(0xabc).toUpperCase() }),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
	);
	assert.throws(
		() => parseInspectPoseContactsParams({ ...valid, support_entity_ids: ["Cube"] }),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
	);

	// Required fields cannot be missing or null, and no extra keys are allowed.
	assert.throws(
		() => parseInspectPoseContactsParams({ ...valid, character_entity_id: null }),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
	);
	const { frames: _omit, ...missingFrames } = valid;
	assert.throws(() => parseInspectPoseContactsParams(missingFrames), /INVALID_INSPECT_POSE_CONTACTS_PARAMS/);
	assert.throws(
		() => parseInspectPoseContactsParams({ ...valid, extra: true }),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
	);
	assert.throws(
		() => parseInspectPoseContactsParams({ ...valid, gate: { max_gap_m: 0.03 } }),
		/INVALID_INSPECT_POSE_CONTACTS_PARAMS/,
		"gate is addon-side and echoed only in the result, never accepted as a request override",
	);
});

test("result: parses two present sides, echoes the default gate, and keeps joint vs deformed-sole distinct", () => {
	const parsed = parsePoseContactsResult(baseResult);
	assert.deepEqual(parsed, baseResult);
	assert.deepEqual(parsed.gate, { max_gap_m: 0.03, min_edge_margin_m: 0.0 });

	const left = parsed.frames[0]!.sides.left!;
	assert.notDeepEqual(left.foot_joint_position, left.sole_point);
	assert.equal(left.contact_basis, "deformed_mesh");
	assert.equal(left.support?.footprint_basis, "aabb_xy");
	// surface_contact_verified must be reachable from deformed-sole/support
	// fields alone; it must not be defined in terms of the joint position.
	assert.equal(left.support?.surface_contact_verified, true);
});

test("result: a side can be entirely absent (nullable), and support fit can be null on a present side", () => {
	const rightAbsent: PoseContactsResultV1 = {
		...baseResult,
		frames: [{ frame: 128, sides: { left: leftSide, right: null } }],
	};
	assert.equal(parsePoseContactsResult(rightAbsent).frames[0]!.sides.right, null);
	// baseResult's rightSide already carries support: null (no support in range).
	assert.equal(parsePoseContactsResult(baseResult).frames[0]!.sides.right?.support, null);
});

test("result: withholds deformed-surface evidence as null rather than a guessed joint offset", () => {
	const jointOnly = {
		...leftSide,
		heel_point: null,
		toe_point: null,
		sole_point: null,
		sole_source: null,
		heel_to_toe_m: null,
		joint_to_sole_offset_m: null,
		support: null,
	};
	const withheld: PoseContactsResultV1 = {
		...baseResult,
		frames: [{ frame: 128, sides: { left: jointOnly, right: null } }],
	};
	const parsed = parsePoseContactsResult(withheld).frames[0]!.sides.left!;
	assert.ok(parsed.foot_joint_position);
	assert.equal(parsed.sole_point, null);
	assert.equal(parsed.sole_source, null);
	assert.equal(parsed.support, null);
});

test("result: rejects wrong contact_basis/footprint_basis literals and non-deformed-mesh claims", () => {
	assert.throws(
		() =>
			parsePoseContactsResult({
				...baseResult,
				frames: [{ frame: 128, sides: { left: { ...leftSide, contact_basis: "joint_estimate" }, right: null } }],
			}),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
	assert.throws(
		() =>
			parsePoseContactsResult({
				...baseResult,
				frames: [
					{
						frame: 128,
						sides: {
							left: { ...leftSide, support: { ...leftSide.support, footprint_basis: "exact_mesh" } },
							right: null,
						},
					},
				],
			}),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
});

test("result: closed schemas reject extra properties at every nesting level", () => {
	assert.throws(() => parsePoseContactsResult({ ...baseResult, extra: true }), /INVALID_INSPECT_POSE_CONTACTS_RESULT/);
	assert.throws(
		() => parsePoseContactsResult({ ...baseResult, gate: { ...baseResult.gate, extra: true } }),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
	assert.throws(
		() =>
			parsePoseContactsResult({
				...baseResult,
				frames: [{ frame: 128, sides: { left: { ...leftSide, extra: true }, right: null } }],
			}),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
	assert.throws(
		() =>
			parsePoseContactsResult({
				...baseResult,
				frames: [
					{
						frame: 128,
						sides: { left: { ...leftSide, support: { ...leftSide.support, extra: true } }, right: null },
					},
				],
			}),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
	assert.throws(
		() => parsePoseContactsResult({ ...baseResult, frames: [{ ...baseResult.frames[0], extra: true }] }),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
});

test("result: rejects bad revision hex, schema_version drift, and impossible frame-array sizes", () => {
	assert.throws(
		() => parsePoseContactsResult({ ...baseResult, revision: "Z".repeat(64) }),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
	assert.throws(
		() => parsePoseContactsResult({ ...baseResult, revision: "a".repeat(63) }),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
	assert.throws(
		() => parsePoseContactsResult({ ...baseResult, schema_version: 2 }),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
	assert.throws(() => parsePoseContactsResult({ ...baseResult, frames: [] }), /INVALID_INSPECT_POSE_CONTACTS_RESULT/);
	assert.throws(
		() =>
			parsePoseContactsResult({
				...baseResult,
				frames: Array.from({ length: 33 }, (_, i) => ({ frame: i, sides: { left: null, right: null } })),
			}),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
	assert.throws(
		() => parsePoseContactsResult({ ...baseResult, character_entity_id: "not-a-uuid" }),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
	assert.throws(
		() =>
			parsePoseContactsResult({
				...baseResult,
				frames: [
					{
						frame: 128,
						sides: {
							left: { ...leftSide, support: { ...leftSide.support, support_entity_id: "Ramp" } },
							right: null,
						},
					},
				],
			}),
		/INVALID_INSPECT_POSE_CONTACTS_RESULT/,
	);
});

test("drift-net: python golden fixture parses with the TS result schema", () => {
	assert.ok(
		existsSync(GOLDEN_FIXTURE_URL),
		"missing blender-addon/tests/fixtures/pose_contacts_golden.json — the python " +
			"add-on test suite (pose contacts, issue #2 item D) must write this golden " +
			"fixture; run the add-on tests or coordinate with the addon-side change before shipping",
	);
	const golden: unknown = JSON.parse(readFileSync(GOLDEN_FIXTURE_URL, "utf8"));
	const parsed = parsePoseContactsResult(golden);
	assert.equal(parsed.schema_version, 1);
	assert.deepEqual(parsed.gate, { max_gap_m: 0.03, min_edge_margin_m: 0.0 });
	assert.ok(parsed.frames.length >= 1);
	const someSide = parsed.frames.map((row) => row.sides.left ?? row.sides.right).find((side) => side !== null);
	assert.ok(someSide, "golden fixture must carry at least one resolvable side");
	assert.equal(someSide.contact_basis, "deformed_mesh");
});
