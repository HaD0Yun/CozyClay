import assert from "node:assert/strict";
import test from "node:test";
import type { CameraPlanV1 } from "@oh-my-blender/protocol";
import { createApplyCameraPlanHandler } from "../src/apply-camera-plan-service.ts";

const plan: CameraPlanV1 = {
	schema_version: 1,
	expected_revision_id: "a".repeat(64),
	evidence_sha256: "b".repeat(64),
	output_format: { width: 640, height: 360 },
	keyframes: [
		{
			frame: 1,
			pose: { position: [0, 0, 50], look_at: [0, 0, 0], up: [0, 1, 0], vertical_fov_radians: 0.5 },
			transition: "smooth",
		},
	],
};

test("row 35: live main-thread V2 hash differs — STALE_BASE", async () => {
	let dispatched = false;
	await assert.rejects(
		createApplyCameraPlanHandler()(plan, {
			signal: new AbortController().signal,
			request: { expected_revision_id: "c".repeat(64) },
			applyCameraPlan: async () => {
				dispatched = true;
				return { resulting_revision_id: "d".repeat(64) };
			},
		}),
		/STALE_BASE/,
	);
	assert.equal(dispatched, false);
});

test("routes apply_camera_plan through the negotiated bridge with cancellation and progress", async () => {
	const controller = new AbortController();
	const progress: Array<[string, number, number]> = [];
	let received: CameraPlanV1 | undefined;
	const output = await createApplyCameraPlanHandler()(plan, {
		signal: controller.signal,
		request: { expected_revision_id: plan.expected_revision_id },
		reportProgress: (phase, completed, total) => progress.push([phase, completed, total]),
		applyCameraPlan: async (value, context) => {
			received = value;
			assert.equal(context.signal, controller.signal);
			context.reportProgress({ phase: "mutating", completed: 1, total: 2 });
			return { resulting_revision_id: "d".repeat(64), scene_hash: "e".repeat(64) };
		},
	});
	assert.deepEqual(received, plan);
	assert.deepEqual(progress, [["mutating", 1, 2]]);
	assert.equal(output.resulting_revision_id, "d".repeat(64));
});
