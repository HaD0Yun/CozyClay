import assert from "node:assert/strict";
import { test } from "node:test";
import { Parse } from "typebox/value";
import { createPreflightMotionTool } from "../src/preflight-motion.ts";

const entityId = "00000000-0000-4000-8000-000000000fff";

const cannedResult = {
	revision: "a".repeat(64),
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
	contact_windows: [{ start_frame: 0, end_frame: 11, height: 0.002 }],
	end_pose: { root_height: 0.948, lowest_gap: 0.001, speed: 0.042, resting: true },
};

test("preflight_motion: params require a motion_id slug and take an optional uuid entity_id", () => {
	const tool = createPreflightMotionTool({ preflightMotion: async () => cannedResult });
	assert.equal(tool.name, "preflight_motion");
	assert.equal(tool.label, "preflight_motion");
	assert.ok("motion_id" in tool.parameters.properties);
	assert.ok("entity_id" in tool.parameters.properties);
	assert.deepEqual(Parse(tool.parameters, { motion_id: "walk-forward-01" }), {
		motion_id: "walk-forward-01",
	});
	assert.deepEqual(Parse(tool.parameters, { motion_id: "a", entity_id: entityId }), {
		motion_id: "a",
		entity_id: entityId,
	});
	assert.throws(() => Parse(tool.parameters, {}));
	assert.throws(() => Parse(tool.parameters, { motion_id: "Walk" }));
	assert.throws(() => Parse(tool.parameters, { motion_id: "-walk" }));
	assert.throws(() => Parse(tool.parameters, { motion_id: `a${"b".repeat(64)}` }));
	assert.throws(() => Parse(tool.parameters, { motion_id: "walk", entity_id: "Rig" }));
	assert.throws(() => Parse(tool.parameters, { motion_id: "walk", entity_id: entityId.toUpperCase() }));
});

test("preflight_motion: forwards params to the bridge and returns round-trippable JSON text", async () => {
	let received: unknown;
	const tool = createPreflightMotionTool({
		preflightMotion: async (params) => {
			received = params;
			return cannedResult;
		},
	});
	const params = { motion_id: "walk-forward-01", entity_id: entityId };
	const output = await tool.execute("call", params, undefined, undefined, undefined as never);
	assert.deepEqual(received, params);
	assert.equal(output.details, cannedResult);
	assert.equal(output.content[0]?.type, "text");
	const text = output.content[0]?.type === "text" ? output.content[0].text : "{}";
	assert.deepEqual(JSON.parse(text), cannedResult);
});

test("preflight_motion: surfaces bridge rejection as a tool error", async () => {
	const failure = new Error("APPLY_MOTION_NOT_FOUND: no motion archive for id");
	const tool = createPreflightMotionTool({
		preflightMotion: async () => {
			throw failure;
		},
	});
	await assert.rejects(
		tool.execute("call", { motion_id: "walk-forward-01" }, undefined, undefined, undefined as never),
		failure,
	);
});
