import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ApplyCameraPlanBridge,
	type ApplyPerformanceModeBridge,
	type CreateFallMotionBridge,
	createApplyCameraPlanTool,
	createApplyPerformanceModeTool,
	createFallMotionTool,
	createInspectBridgeStateTool,
	createInspectPerformanceTool,
	createInspectProjectTool,
	createInspectVisualQaMetricsTool,
	createRenderQaFramesTool,
	createRepairBridgeTool,
	createReplaceCameraActionTool,
	createStageSceneTool,
	type InspectBridgeStateBridge,
	type InspectPerformanceBridge,
	type InspectProjectBridge,
	type InspectVisualQaMetricsBridge,
	type RenderQaFramesBridge,
	type RepairBridgeBridge,
	type ReplaceCameraActionBridge,
	type StageSceneBridge,
} from "@cclay/blender-tools";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BundledDirectorResourceLoader, DIRECTOR_PROMPT_DIGEST } from "./resource-loader.ts";

export const DIRECTOR_TOOL_ALLOWLIST = [
	"inspect_project",
	"inspect_bridge_state",
	"inspect_performance",
	"inspect_visual_qa_metrics",
	"stage_scene",
	"apply_camera_plan",
	"render_qa_frames",
	"repair_bridge",
	"apply_performance_mode",
	"create_fall_motion",
	"replace_camera_action",
] as const;

export interface DirectorSessionOptions {
	readonly bridge: InspectProjectBridge &
		Partial<
			ApplyCameraPlanBridge &
				ApplyPerformanceModeBridge &
				CreateFallMotionBridge &
				InspectBridgeStateBridge &
				InspectPerformanceBridge &
				InspectVisualQaMetricsBridge &
				RenderQaFramesBridge &
				ReplaceCameraActionBridge &
				RepairBridgeBridge &
				StageSceneBridge
		>;
	readonly model: Model<string>;
	readonly modelRuntime: ModelRuntime;
	readonly cwd?: string;
	readonly agentDir?: string;
}

export async function createDirectorSession(options: DirectorSessionOptions) {
	const cwd = options.cwd ?? process.cwd();
	const ownsAgentDir = options.agentDir === undefined;
	const agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "cclay-director-agent-"));
	const resourceLoader = new BundledDirectorResourceLoader();
	const mutationBridge =
		options.bridge.applyCameraPlan === undefined
			? undefined
			: { applyCameraPlan: options.bridge.applyCameraPlan.bind(options.bridge) };
	const stageBridge =
		options.bridge.stageScene === undefined
			? undefined
			: { stageScene: options.bridge.stageScene.bind(options.bridge) };
	const renderBridge =
		options.bridge.renderQaFrames === undefined
			? undefined
			: { renderQaFrames: options.bridge.renderQaFrames.bind(options.bridge) };
	const inspectBridgeStateBridge =
		options.bridge.inspectBridgeState === undefined
			? undefined
			: { inspectBridgeState: options.bridge.inspectBridgeState.bind(options.bridge) };
	const inspectPerformanceBridge =
		options.bridge.inspectPerformance === undefined
			? undefined
			: { inspectPerformance: options.bridge.inspectPerformance.bind(options.bridge) };
	const inspectVisualQaMetricsBridge =
		options.bridge.inspectVisualQaMetrics === undefined
			? undefined
			: { inspectVisualQaMetrics: options.bridge.inspectVisualQaMetrics.bind(options.bridge) };
	const repairBridge =
		options.bridge.repairBridge === undefined
			? undefined
			: { repairBridge: options.bridge.repairBridge.bind(options.bridge) };
	const performanceBridge =
		options.bridge.applyPerformanceMode === undefined
			? undefined
			: { applyPerformanceMode: options.bridge.applyPerformanceMode.bind(options.bridge) };
	const fallMotionBridge =
		options.bridge.createFallMotion === undefined
			? undefined
			: { createFallMotion: options.bridge.createFallMotion.bind(options.bridge) };
	const cameraActionBridge =
		options.bridge.replaceCameraAction === undefined
			? undefined
			: { replaceCameraAction: options.bridge.replaceCameraAction.bind(options.bridge) };
	const enabledTools = [
		"inspect_project",
		...(inspectBridgeStateBridge === undefined ? [] : (["inspect_bridge_state"] as const)),
		...(inspectPerformanceBridge === undefined ? [] : (["inspect_performance"] as const)),
		...(inspectVisualQaMetricsBridge === undefined ? [] : (["inspect_visual_qa_metrics"] as const)),
		...(stageBridge === undefined ? [] : (["stage_scene"] as const)),
		...(mutationBridge === undefined ? [] : (["apply_camera_plan"] as const)),
		...(renderBridge === undefined ? [] : (["render_qa_frames"] as const)),
		...(repairBridge === undefined ? [] : (["repair_bridge"] as const)),
		...(performanceBridge === undefined ? [] : (["apply_performance_mode"] as const)),
		...(fallMotionBridge === undefined ? [] : (["create_fall_motion"] as const)),
		...(cameraActionBridge === undefined ? [] : (["replace_camera_action"] as const)),
	];
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: options.model,
		modelRuntime: options.modelRuntime,
		// "off" never reaches the codex wire (the request builder omits the
		// reasoning field entirely, deferring to the backend default). Pin the
		// effort explicitly so behavior does not drift with backend defaults.
		thinkingLevel: "medium",
		resourceLoader,
		customTools: [
			createInspectProjectTool(options.bridge),
			...(inspectBridgeStateBridge === undefined ? [] : [createInspectBridgeStateTool(inspectBridgeStateBridge)]),
			...(inspectPerformanceBridge === undefined ? [] : [createInspectPerformanceTool(inspectPerformanceBridge)]),
			...(inspectVisualQaMetricsBridge === undefined
				? []
				: [createInspectVisualQaMetricsTool(inspectVisualQaMetricsBridge)]),
			...(stageBridge === undefined ? [] : [createStageSceneTool(stageBridge)]),
			...(mutationBridge === undefined ? [] : [createApplyCameraPlanTool(mutationBridge)]),
			...(renderBridge === undefined ? [] : [createRenderQaFramesTool(renderBridge)]),
			...(repairBridge === undefined ? [] : [createRepairBridgeTool(repairBridge)]),
			...(performanceBridge === undefined ? [] : [createApplyPerformanceModeTool(performanceBridge)]),
			...(fallMotionBridge === undefined ? [] : [createFallMotionTool(fallMotionBridge)]),
			...(cameraActionBridge === undefined ? [] : [createReplaceCameraActionTool(cameraActionBridge)]),
		],
		tools: enabledTools,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			// Transient provider failures (observed with sol on complex builds)
			// must not kill a director turn outright: two bounded retries cost
			// at most ~3s of backoff against the 300s turn deadline.
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 },
		}),
	});

	const effectiveTools = session.getActiveToolNames();
	if (
		effectiveTools.length !== enabledTools.length ||
		effectiveTools.some((name, index) => name !== enabledTools[index])
	) {
		session.dispose();
		throw new Error(`DIRECTOR_TOOL_ALLOWLIST_MISMATCH: ${effectiveTools.join(",")}`);
	}
	if (resourceLoader.promptDigest() !== DIRECTOR_PROMPT_DIGEST) {
		session.dispose();
		throw new Error("DIRECTOR_PROMPT_DIGEST_MISMATCH");
	}

	const dispose = session.dispose.bind(session);
	session.dispose = () => {
		try {
			dispose();
		} finally {
			if (ownsAgentDir) rmSync(agentDir, { recursive: true, force: true });
		}
	};

	return session;
}
