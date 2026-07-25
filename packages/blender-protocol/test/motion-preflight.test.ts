import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
	type MotionPreflightResultV1,
	PREFLIGHT_MOTION_ERROR_CODES,
	parseMotionPreflightResult,
	parsePreflightMotionParams,
} from "../src/motion-preflight.ts";

const revision = "a".repeat(64);
const entityId = "00000000-0000-4000-8000-000000000fff";

// Drift-net source of truth: written by the python add-on test suite from the
// real preflight implementation output.
const GOLDEN_FIXTURE_URL = new URL(
	"../../../blender-addon/tests/fixtures/motion_preflight_golden.json",
	import.meta.url,
);

const metersResult: MotionPreflightResultV1 = {
	revision,
	schema_version: 1,
	motion_id: "walk-forward-01",
	frames: 120,
	fps: 20,
	duration_seconds: 6.0,
	scale: 0.482,
	units: "meters",
	travel: {
		vector_horizontal: [1.25, -0.31],
		distance_horizontal: 1.288,
		height_start: 0.951,
		height_end: 0.948,
		height_min: 0.902,
		height_max: 0.973,
		height_change: -0.003,
	},
	lowest_track: {
		min: 0.0,
		max: 0.182,
		sample_stride: 1,
		samples: [0.0, 0.01, 0.12, 0.182, 0.05, 0.0],
	},
	contact_windows: [
		{ start_frame: 0, end_frame: 11, height: 0.002 },
		{ start_frame: 34, end_frame: 47, height: 0.001 },
	],
	foot_contacts: [
		{
			channel: "left_heel",
			start_frame: 0,
			end_frame: 11,
			height: 0.002,
			height_max: 0.004,
		},
		{
			channel: "right_toe",
			start_frame: 34,
			end_frame: 47,
			height: 0.001,
			height_max: 0.002,
		},
	],
	end_pose: { root_height: 0.948, lowest_gap: 0.001, speed: 0.042, resting: true },
};

const npzResult: MotionPreflightResultV1 = {
	...metersResult,
	scale: null,
	units: "npz",
	contact_windows: [],
	// An npz staged before the carried-member contract has no channel at all.
	foot_contacts: null,
};

test("params: motion_id slug required, entity_id optional lowercase UUIDv4, closed", () => {
	assert.deepEqual(parsePreflightMotionParams({ motion_id: "walk-forward-01" }), {
		motion_id: "walk-forward-01",
	});
	assert.deepEqual(parsePreflightMotionParams({ motion_id: "a", entity_id: entityId }), {
		motion_id: "a",
		entity_id: entityId,
	});
	assert.throws(() => parsePreflightMotionParams({}), /INVALID_PREFLIGHT_MOTION_PARAMS/);
	assert.throws(() => parsePreflightMotionParams({ motion_id: "Walk" }), /INVALID_PREFLIGHT_MOTION_PARAMS/);
	assert.throws(() => parsePreflightMotionParams({ motion_id: "-walk" }), /INVALID_PREFLIGHT_MOTION_PARAMS/);
	assert.throws(
		() => parsePreflightMotionParams({ motion_id: `a${"b".repeat(64)}` }),
		/INVALID_PREFLIGHT_MOTION_PARAMS/,
	);
	// Explicit null must be rejected (parity with the python-side validation).
	assert.throws(
		() => parsePreflightMotionParams({ motion_id: "walk", entity_id: null }),
		/INVALID_PREFLIGHT_MOTION_PARAMS/,
	);
	assert.throws(
		() => parsePreflightMotionParams({ motion_id: "walk", entity_id: entityId.toUpperCase() }),
		/INVALID_PREFLIGHT_MOTION_PARAMS/,
	);
	assert.throws(
		() => parsePreflightMotionParams({ motion_id: "walk", extra: true }),
		/INVALID_PREFLIGHT_MOTION_PARAMS/,
	);
});

test("result: parses meters and npz variants, empty contact_windows, scale null", () => {
	assert.deepEqual(parseMotionPreflightResult(metersResult), metersResult);
	assert.deepEqual(parseMotionPreflightResult(npzResult), npzResult);
	assert.equal(parseMotionPreflightResult(npzResult).scale, null);
	assert.deepEqual(parseMotionPreflightResult(npzResult).contact_windows, []);
	// Boundary sizes are accepted: 240 samples, 64 windows.
	const maxed: MotionPreflightResultV1 = {
		...metersResult,
		lowest_track: {
			...metersResult.lowest_track,
			sample_stride: 3,
			samples: Array.from({ length: 240 }, () => 0.01),
		},
		contact_windows: Array.from({ length: 64 }, (_, index) => ({
			start_frame: index * 2,
			end_frame: index * 2 + 1,
			height: 0.001,
		})),
	};
	assert.deepEqual(parseMotionPreflightResult(maxed), maxed);
});

test("result: closed schemas reject extra properties anywhere", () => {
	assert.throws(() => parseMotionPreflightResult({ ...metersResult, extra: true }), /INVALID_PREFLIGHT_MOTION_RESULT/);
	assert.throws(
		() =>
			parseMotionPreflightResult({
				...metersResult,
				travel: { ...metersResult.travel, extra: true },
			}),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
	assert.throws(
		() =>
			parseMotionPreflightResult({
				...metersResult,
				lowest_track: { ...metersResult.lowest_track, extra: true },
			}),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
	assert.throws(
		() =>
			parseMotionPreflightResult({
				...metersResult,
				contact_windows: [{ ...metersResult.contact_windows[0]!, extra: true }],
			}),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
	assert.throws(
		() =>
			parseMotionPreflightResult({
				...metersResult,
				end_pose: { ...metersResult.end_pose, extra: true },
			}),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
});

test("result: rejects oversize tracks, wrong version, bad units, bad integers", () => {
	assert.throws(
		() =>
			parseMotionPreflightResult({
				...metersResult,
				lowest_track: {
					...metersResult.lowest_track,
					samples: Array.from({ length: 241 }, () => 0),
				},
			}),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
	assert.throws(
		() =>
			parseMotionPreflightResult({
				...metersResult,
				contact_windows: Array.from({ length: 65 }, () => ({
					start_frame: 0,
					end_frame: 1,
					height: 0,
				})),
			}),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
	assert.throws(
		() => parseMotionPreflightResult({ ...metersResult, schema_version: 2 }),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
	assert.throws(
		() => parseMotionPreflightResult({ ...metersResult, units: "feet" }),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
	assert.throws(() => parseMotionPreflightResult({ ...metersResult, frames: -1 }), /INVALID_PREFLIGHT_MOTION_RESULT/);
	assert.throws(() => parseMotionPreflightResult({ ...metersResult, frames: 0 }), /INVALID_PREFLIGHT_MOTION_RESULT/);
	assert.throws(() => parseMotionPreflightResult({ ...metersResult, fps: 241 }), /INVALID_PREFLIGHT_MOTION_RESULT/);
	assert.throws(
		() =>
			parseMotionPreflightResult({
				...metersResult,
				lowest_track: { ...metersResult.lowest_track, sample_stride: 0 },
			}),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
	assert.throws(
		() => parseMotionPreflightResult({ ...metersResult, revision: "Z".repeat(64) }),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
});

test("foot_contacts: null and [] stay distinct, channels are closed, cap is 64", () => {
	// null = the npz carries no channel; [] = the model predicted no contact.
	// Collapsing them would make "we never asked" read as "there is no contact".
	assert.equal(parseMotionPreflightResult(npzResult).foot_contacts, null);
	assert.deepEqual(parseMotionPreflightResult({ ...metersResult, foot_contacts: [] }).foot_contacts, []);
	const window = metersResult.foot_contacts![0]!;
	assert.throws(
		() =>
			parseMotionPreflightResult({
				...metersResult,
				foot_contacts: [{ ...window, channel: "left_knee" }],
			}),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
	assert.throws(
		() =>
			parseMotionPreflightResult({
				...metersResult,
				foot_contacts: [{ ...window, extra: true }],
			}),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
	// height_max is required: without it a declared contact that never reaches
	// the surface is unreportable.
	const { height_max: _dropped, ...withoutMax } = window;
	assert.throws(
		() => parseMotionPreflightResult({ ...metersResult, foot_contacts: [withoutMax] }),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
	assert.equal(
		parseMotionPreflightResult({
			...metersResult,
			foot_contacts: Array.from({ length: 64 }, () => window),
		}).foot_contacts?.length,
		64,
	);
	assert.throws(
		() =>
			parseMotionPreflightResult({
				...metersResult,
				foot_contacts: Array.from({ length: 65 }, () => window),
			}),
		/INVALID_PREFLIGHT_MOTION_RESULT/,
	);
});

test("error codes: preflight_motion contract codes are stable", () => {
	assert.deepEqual(PREFLIGHT_MOTION_ERROR_CODES, [
		"INVALID_PREFLIGHT_MOTION_PARAMS",
		"ENTITY_NOT_FOUND",
		"APPLY_MOTION_PROJECT_DIR_UNKNOWN",
		"APPLY_MOTION_NOT_FOUND",
		"APPLY_MOTION_TOO_LARGE",
		"APPLY_MOTION_MALFORMED",
	]);
});

test("drift-net: python golden fixture parses with the TS result schema", () => {
	assert.ok(
		existsSync(GOLDEN_FIXTURE_URL),
		"missing blender-addon/tests/fixtures/motion_preflight_golden.json — the python " +
			"add-on test suite (motion preflight) must write this golden fixture; run the " +
			"add-on tests or coordinate with the addon-side preflight change before shipping",
	);
	const golden: unknown = JSON.parse(readFileSync(GOLDEN_FIXTURE_URL, "utf8"));
	const parsed = parseMotionPreflightResult(golden);
	assert.equal(parsed.schema_version, 1);
	assert.equal(parsed.motion_id, "golden-motion");
	// The golden motion is unscaled npz-unit output.
	assert.equal(parsed.scale, null);
	assert.equal(parsed.units, "npz");
});
