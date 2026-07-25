import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	type CameraPlanV1,
	CameraPlanValidationError,
	type DirectingAnalysisEvidenceV1,
	parseCameraPlanMutationCandidate,
	validateCameraPlan,
} from "../src/camera-plan.ts";

const HASH = "a".repeat(64);
const FOV = 2 * Math.atan(12 / 48);
const V2_MANIFEST = JSON.parse(
	await readFile(new URL("../../director-core/test/fixtures/scene-manifest-v2-parity.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

function validPlan(): CameraPlanV1 {
	return {
		schema_version: 1,
		expected_revision_id: HASH,
		evidence_sha256: "b".repeat(64),
		output_format: { width: 640, height: 360 },
		keyframes: [
			{
				frame: 80,
				pose: { position: [0, 0, 50], look_at: [0, 0, 0], up: [0, 1, 0], vertical_fov_radians: FOV },
				transition: "smooth",
			},
			{
				frame: 100,
				pose: { position: [10, 0, 50], look_at: [10, 0, 0], up: [0, 1, 0], vertical_fov_radians: FOV },
				transition: "cut",
			},
		],
	};
}

function validEvidence(): DirectingAnalysisEvidenceV1 {
	return {
		schema_version: 1,
		revision_id: HASH,
		scene_hash: "c".repeat(64),
		frame_range: { start: 0, end: 200 },
		producer: { id: "cclay.approved_fixture", version: "boxing-v4", digest: "d".repeat(64) },
		analysis: {
			motion_valley_frames: [100],
			action_peak_ranges: [],
			action_axis: { a: [0, 0, 0], b: [20, 0, 0], up: [0, 0, 1] },
			subject_samples: [
				{ frame: 99, center: [10, 0, 0], height_m: 1 },
				{ frame: 100, center: [10, 0, 0], height_m: 1 },
			],
		},
	};
}

function assertCode(
	code: CameraPlanValidationError["code"],
	mutatePlan?: (plan: CameraPlanV1) => void,
	mutateEvidence?: (evidence: DirectingAnalysisEvidenceV1) => void,
): void {
	const plan = validPlan();
	const evidence = validEvidence();
	mutatePlan?.(plan);
	mutateEvidence?.(evidence);
	assert.throws(
		() => validateCameraPlan(plan, evidence),
		(error: unknown) => error instanceof CameraPlanValidationError && error.code === code,
	);
}
test("camera mutation candidate accepts a closed SceneManifestV4 variant", () => {
	const manifest = {
		...structuredClone(V2_MANIFEST),
		schemaVersion: 4,
		stagePrimitives: [],
		stageMaterials: [],
		assemblies: [],
	};
	const candidate = parseCameraPlanMutationCandidate({
		expected_revision_id: HASH,
		scene_hash: String(V2_MANIFEST.sceneHash),
		manifest,
	});
	assert.equal(candidate.manifest.schemaVersion, 4);
});

test("camera mutation candidate rejects a malformed SceneManifestV4 variant", () => {
	const manifest = {
		...structuredClone(V2_MANIFEST),
		schemaVersion: 4,
		stagePrimitives: [],
		stageMaterials: [],
	};
	assert.throws(
		() =>
			parseCameraPlanMutationCandidate({
				expected_revision_id: HASH,
				scene_hash: String(V2_MANIFEST.sceneHash),
				manifest,
			}),
		/INVALID_MUTATION_RESULT/,
	);
});

test("row 1: closed plan schema parse — INVALID_CAMERA_PLAN_SCHEMA", () => {
	assert.throws(
		() => validateCameraPlan({ ...validPlan(), extra: true }, validEvidence()),
		(error: unknown) => error instanceof CameraPlanValidationError && error.code === "INVALID_CAMERA_PLAN_SCHEMA",
	);
});

test("row 11: plan keyframe outside valid evidence range — PLAN_FRAME_OUT_OF_EVIDENCE_RANGE", () => {
	assertCode("PLAN_FRAME_OUT_OF_EVIDENCE_RANGE", (plan) => {
		plan.keyframes[1]!.frame = 201;
	});
});

test("row 12: required exact N−1/N subject sample absent — EVIDENCE_SUBJECT_SAMPLE_MISSING", () => {
	assertCode("EVIDENCE_SUBJECT_SAMPLE_MISSING", undefined, (evidence) => {
		evidence.analysis.subject_samples.pop();
	});
});

test("row 13: |axis_b-axis_a|<1e-9 — EVIDENCE_ACTION_AXIS_ZERO_LENGTH", () => {
	assertCode("EVIDENCE_ACTION_AXIS_ZERO_LENGTH", undefined, (evidence) => {
		evidence.analysis.action_axis.b = [0, 0, 0];
	});
});

test("row 14: |cross(axis,up)|<1e-9 after row 13 — EVIDENCE_ACTION_AXIS_PARALLEL_TO_UP", () => {
	assertCode("EVIDENCE_ACTION_AXIS_PARALLEL_TO_UP", undefined, (evidence) => {
		evidence.analysis.action_axis.b = [0, 0, 20];
	});
});

test("row 15: keyframe frame noninteger — PLAN_FRAME_NOT_INTEGER", () => {
	assertCode("PLAN_FRAME_NOT_INTEGER", (plan) => {
		plan.keyframes[0]!.frame = 80.5;
	});
});

test("row 16: fewer than two keyframes — PLAN_MINIMUM_TWO_KEYFRAMES", () => {
	assertCode("PLAN_MINIMUM_TWO_KEYFRAMES", (plan) => {
		plan.keyframes.splice(1);
	});
});

test("row 17: frames not strictly increasing — PLAN_FRAME_ORDER_INVALID", () => {
	assertCode("PLAN_FRAME_ORDER_INVALID", (plan) => {
		plan.keyframes[0]!.frame = 100;
		plan.keyframes[1]!.frame = 80;
		plan.keyframes[1]!.transition = "smooth";
	});
});

test("row 18: first transition not literal smooth — PLAN_FIRST_TRANSITION_NOT_SMOOTH", () => {
	assertCode(
		"PLAN_FIRST_TRANSITION_NOT_SMOOTH",
		(plan) => {
			plan.keyframes[0]!.transition = "cut";
		},
		(evidence) => {
			evidence.analysis.motion_valley_frames.unshift(80);
			evidence.analysis.subject_samples.unshift(
				{ frame: 79, center: [0, 0, 0], height_m: 1 },
				{ frame: 80, center: [0, 0, 0], height_m: 1 },
			);
		},
	);
});

test("row 19: cut at evidence range start — PLAN_CUT_AT_RANGE_START is subsumed by row 12, never row 18", () => {
	// Deliberately no evidence mutation: a cut at frame_range.start would
	// require an N-1 sample at frame_range.start - 1, which no valid evidence
	// document can represent, so EVIDENCE_SUBJECT_SAMPLE_MISSING always fires
	// before PLAN_FIRST_TRANSITION_NOT_SMOOTH could be reached.
	assertCode("EVIDENCE_SUBJECT_SAMPLE_MISSING", (plan) => {
		plan.keyframes[0]!.frame = 0;
		plan.keyframes[0]!.transition = "cut";
	});
});

test("row 20: up differs [0,1,0] by >1e-9/component — UNSUPPORTED_PLAN_UP", () => {
	assertCode("UNSUPPORTED_PLAN_UP", (plan) => {
		plan.keyframes[0]!.pose.up = [0, 1, 1e-8];
	});
});

test("row 21: view distance <1e-9 — PLAN_ZERO_VIEW_DISTANCE", () => {
	assertCode("PLAN_ZERO_VIEW_DISTANCE", (plan) => {
		plan.keyframes[0]!.pose.position = [0, 0, 0];
	});
});

test("row 22: up/direction sine <1e-9 — PLAN_POSE_COLLINEAR_UP", () => {
	assertCode("PLAN_POSE_COLLINEAR_UP", (plan) => {
		plan.keyframes[0]!.pose.position = [0, 50, 0];
	});
});

test("row 28: 12/tan(vfov/2) outside 45..52 ±1e-6 — FRAMING_BAND_VIOLATION", () => {
	assertCode("FRAMING_BAND_VIOLATION", (plan) => {
		plan.keyframes[0]!.pose.vertical_fov_radians = 2 * Math.atan(12 / 40);
	});
});

test("row 29: no valley within ±1 cut frame — CUT_NOT_AT_MOTION_VALLEY", () => {
	assertCode("CUT_NOT_AT_MOTION_VALLEY", undefined, (evidence) => {
		evidence.analysis.motion_valley_frames = [];
	});
});

test("row 30: cut in peak range expanded ±1 — CUT_SPLITS_ACTION_PEAK", () => {
	assertCode("CUT_SPLITS_ACTION_PEAK", undefined, (evidence) => {
		evidence.analysis.action_peak_ranges = [{ start: 99, end: 99 }];
	});
});

test("row 31: projected subject scale nonfinite/nonpositive — CUT_SCALE_UNDEFINED", () => {
	assertCode("CUT_SCALE_UNDEFINED", undefined, (evidence) => {
		for (const sample of evidence.analysis.subject_samples) sample.height_m = Number.MIN_VALUE;
	});
});

test("row 32: cut scale max/min >1.35+1e-6 — CUT_SCALE_DISCONTINUITY", () => {
	assertCode("CUT_SCALE_DISCONTINUITY", undefined, (evidence) => {
		evidence.analysis.subject_samples[1]!.height_m = 2;
	});
});

test("row 33: absolute axis-side score <1e-6 — CAMERA_ON_ACTION_AXIS", () => {
	assertCode(
		"CAMERA_ON_ACTION_AXIS",
		(plan) => {
			plan.keyframes[0]!.pose.position = [0, 0, 0];
			plan.keyframes[0]!.pose.look_at = [0, 0, 50];
		},
		(evidence) => {
			evidence.analysis.subject_samples[0]!.center = [0, -50, 0];
		},
	);
});

test("row 34: axis-side sign changes — ACTION_AXIS_CROSSING", () => {
	assertCode("ACTION_AXIS_CROSSING", (plan) => {
		plan.keyframes[1]!.pose.position = [10, 0, -50];
	});
});

test("multi-fault precedence returns only the earliest atomic error", () => {
	assertCode(
		"PLAN_FRAME_NOT_INTEGER",
		(plan) => {
			plan.keyframes[0]!.frame = 80.5;
			plan.keyframes.splice(1);
		},
		(evidence) => {
			evidence.analysis.motion_valley_frames = [];
		},
	);
});

test("valid plan and trusted evidence pass every pure-math predicate", () => {
	assert.doesNotThrow(() => validateCameraPlan(validPlan(), validEvidence()));
});
