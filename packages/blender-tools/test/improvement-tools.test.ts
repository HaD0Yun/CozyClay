import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createApplyPerformanceModeTool,
	createFallMotionTool,
	createInspectBridgeStateTool,
	createInspectPerformanceTool,
	createInspectVisualQaMetricsTool,
	createRepairBridgeTool,
	createReplaceCameraActionTool,
} from "../src/index.ts";

const REVISION = "a".repeat(64);
const ENTITY_ID = "123e4567-e89b-42d3-a456-426614174000";

interface ToolResult {
	details?: unknown;
}

type ExecutableTool = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
	) => Promise<ToolResult>;
};

async function invoke(tool: unknown, params: Record<string, unknown>): Promise<ToolResult> {
	return (tool as ExecutableTool).execute("call", params, undefined, undefined);
}

describe("bridge repair tools", () => {
	it("inspects and repairs extension-side bridge state", async () => {
		const bridge = {
			inspectBridgeState: () => ({ attached: true, pending_method: "render_qa_frames" }),
			repairBridge: () => ({ attached: false, repaired: true }),
		};
		const inspect = createInspectBridgeStateTool(bridge);
		const repair = createRepairBridgeTool(bridge);
		assert.deepEqual((await invoke(inspect, {})).details, {
			attached: true,
			pending_method: "render_qa_frames",
		});
		assert.deepEqual((await invoke(repair, {})).details, { attached: false, repaired: true });
	});
});

describe("performance tools", () => {
	it("forwards revision-bound performance requests", async () => {
		const calls: unknown[] = [];
		const bridge = {
			inspectPerformance: async (params: unknown) => {
				calls.push(params);
				return { schema_version: 1 };
			},
			applyPerformanceMode: async (params: unknown) => {
				calls.push(params);
				return { schema_version: 1, profile: "performance" };
			},
		};
		await invoke(createInspectPerformanceTool(bridge), { expected_revision_id: REVISION });
		await invoke(createApplyPerformanceModeTool(bridge), {
			expected_revision_id: REVISION,
			profile: "performance",
		});
		assert.deepEqual(calls, [
			{ expected_revision_id: REVISION },
			{ expected_revision_id: REVISION, profile: "performance" },
		]);
	});

	it("rejects an unsupported profile in the closed tool schema", () => {
		const tool = createApplyPerformanceModeTool({
			applyPerformanceMode: async () => ({}),
		});
		assert.throws(() =>
			tool.parameters.parse({
				expected_revision_id: REVISION,
				profile: "maximum",
			}),
		);
	});
});

describe("fall and camera action tools", () => {
	it("forwards gravity fall and camera action replacements", async () => {
		const calls: unknown[] = [];
		const bridge = {
			createFallMotion: async (params: unknown) => {
				calls.push(params);
				return { revision_id: REVISION };
			},
			replaceCameraAction: async (params: unknown) => {
				calls.push(params);
				return { revision_id: REVISION };
			},
		};
		await invoke(createFallMotionTool(bridge), {
			expected_revision_id: REVISION,
			character_entity_id: ENTITY_ID,
			start_frame: 214,
			drop_height_m: 6.2,
			fps: 20,
		});
		await invoke(createReplaceCameraActionTool(bridge), {
			expected_revision_id: REVISION,
			camera_entity_id: ENTITY_ID,
			keyframes: [
				{ frame: 1, location: [0, 0, 1], look_at: [0, 0, 0], transition: "smooth" },
				{ frame: 20, location: [1, 0, 1], look_at: [0, 0, 0], transition: "cut" },
			],
		});
		assert.equal(calls.length, 2);
	});
});

describe("visual QA metrics tool", () => {
	it("forwards subject metrics for sorted unique frames", async () => {
		const params = {
			expected_revision_id: REVISION,
			frames: [1, 20, 40],
			subject_entity_ids: [ENTITY_ID],
			ground_z: 0,
		};
		const bridge = {
			inspectVisualQaMetrics: async (received: unknown) => {
				assert.deepEqual(received, params);
				return { schema_version: 1 };
			},
		};
		await invoke(createInspectVisualQaMetricsTool(bridge), params);
	});
});
