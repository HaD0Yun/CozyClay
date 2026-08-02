import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ApplyCameraPlanBridge,
	type ApplyPerformanceModeBridge,
	type ArdyGenerateBridge,
	type ArdyInbetweenBridge,
	type ArdyRegenerateBridge,
	type CaptureViewportBridge,
	type CreateFallMotionBridge,
	createApplyCameraPlanTool,
	createApplyPerformanceModeTool,
	createArdyGenerateTool,
	createArdyInbetweenTool,
	createArdyRegenerateTool,
	createCaptureViewportTool,
	createExecuteBlenderPythonTool,
	createFallMotionTool,
	createInspectBridgeStateTool,
	createInspectEntityTool,
	createInspectPerformanceTool,
	createInspectPoseContactsTool,
	createInspectProjectTool,
	createInspectRelationsTool,
	createInspectVisualQaMetricsTool,
	createPreflightMotionTool,
	createProduceDirectingEvidenceTool,
	createReadImageTool,
	createRenderQaFramesTool,
	createRepairBridgeTool,
	createReplaceCameraActionTool,
	createStageSceneTool,
	EMBEDDED_DIRECTOR_ELIGIBLE_TOOL_NAMES,
	type EmbeddedDirectorToolName,
	type ExecuteBlenderPythonBridge,
	type InspectBridgeStateBridge,
	type InspectEntityBridge,
	type InspectPerformanceBridge,
	type InspectPoseContactsBridge,
	type InspectProjectBridge,
	type InspectRelationsBridge,
	type InspectVisualQaMetricsBridge,
	type PreflightMotionBridge,
	type ProduceDirectingEvidenceBridge,
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
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isArdyHostConfigured } from "./ardy-host-config.ts";
import { BundledDirectorResourceLoader } from "./resource-loader.ts";

export const DIRECTOR_TOOL_ALLOWLIST = EMBEDDED_DIRECTOR_ELIGIBLE_TOOL_NAMES;

/**
 * A bridge carrying members outside this type is inert rather than rejected.
 * Excess-property checking only fires on object literals, so a bridge built by
 * spread, Object.assign, a widened variable, or a factory can carry extra
 * members and still typecheck. They are harmless because tool construction is
 * driven by the closed DIRECTOR_TOOL_CONSTRUCTION_PATHS map below, which reads
 * named bridge methods explicitly and never enumerates the bridge's own keys.
 * Do not restate this as a compile-time guarantee; it is not one.
 */
export interface DirectorSessionOptions {
	readonly bridge: InspectProjectBridge &
		Partial<
			ApplyCameraPlanBridge &
				ApplyPerformanceModeBridge &
				CaptureViewportBridge &
				CreateFallMotionBridge &
				ArdyRegenerateBridge &
				ArdyGenerateBridge &
				ArdyInbetweenBridge &
				InspectBridgeStateBridge &
				InspectEntityBridge &
				InspectPerformanceBridge &
				InspectPoseContactsBridge &
				InspectRelationsBridge &
				InspectVisualQaMetricsBridge &
				PreflightMotionBridge &
				ProduceDirectingEvidenceBridge &
				RenderQaFramesBridge &
				ReplaceCameraActionBridge &
				RepairBridgeBridge &
				StageSceneBridge &
				ExecuteBlenderPythonBridge
		>;
	readonly model: Model<string>;
	readonly modelRuntime: ModelRuntime;
	readonly cwd?: string;
	readonly agentDir?: string;
	readonly allowExecuteBlenderPython?: boolean;
	// The offer-time ARDY host gate. Defaults to the ambient CCLAY_ARDY_HOST
	// (see isArdyHostConfigured); tests inject the signal so their outcome
	// does not depend on the machine. When false, ardy_generate and
	// ardy_inbetween are omitted from the constructed tool set even when
	// their bridges are present -- the same optional mechanism an absent
	// bridge already uses. ardy_regenerate is unaffected: it keeps its
	// bridge-only gating.
	readonly ardyHostConfigured?: boolean;
}

/**
 * Tools with no bridge precondition: they are constructed from the session's own
 * cwd or from the always-present inspect bridge, so a construction path that
 * yields nothing for one of these is a defect, not an absent capability.
 */
export const UNCONDITIONAL_DIRECTOR_TOOLS: readonly string[] = ["inspect_project", "read_image"];

export function assertDirectorToolConstructionPaths(
	eligibleToolNames: readonly string[],
	constructionPaths: Readonly<Record<string, unknown>>,
): void {
	const constructionPathNames = Object.keys(constructionPaths);
	if (
		constructionPathNames.length !== eligibleToolNames.length ||
		constructionPathNames.some((name, index) => name !== eligibleToolNames[index])
	) {
		throw new Error(`DIRECTOR_TOOL_ALLOWLIST_MISMATCH: ${eligibleToolNames.join(",")}`);
	}
}
export async function createDirectorSession(options: DirectorSessionOptions) {
	const cwd = options.cwd ?? process.cwd();
	const ownsAgentDir = options.agentDir === undefined;
	const agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "cclay-director-agent-"));
	// Every failure between here and the point the session takes ownership of
	// agentDir has to remove a directory this function created; otherwise a
	// rejected construction leaves a temp directory behind on every attempt.
	try {
		return await buildDirectorSession(options, cwd, agentDir, ownsAgentDir);
	} catch (error) {
		if (ownsAgentDir) rmSync(agentDir, { recursive: true, force: true });
		throw error;
	}
}

async function buildDirectorSession(
	options: DirectorSessionOptions,
	cwd: string,
	agentDir: string,
	ownsAgentDir: boolean,
) {
	const resourceLoader = new BundledDirectorResourceLoader();
	// Resolved once, before any tool construction: the gate decides whether
	// ardy_generate / ardy_inbetween exist in this session, so it must be
	// stable for the session's whole lifetime, not re-read per tool.
	const ardyHostConfigured = options.ardyHostConfigured ?? isArdyHostConfigured();
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
	const inspectEntityBridge =
		options.bridge.inspectEntity === undefined
			? undefined
			: { inspectEntity: options.bridge.inspectEntity.bind(options.bridge) };
	const inspectPoseContactsBridge =
		options.bridge.inspectPoseContacts === undefined
			? undefined
			: { inspectPoseContacts: options.bridge.inspectPoseContacts.bind(options.bridge) };
	const inspectRelationsBridge =
		options.bridge.inspectRelations === undefined
			? undefined
			: { inspectRelations: options.bridge.inspectRelations.bind(options.bridge) };
	const preflightMotionBridge =
		options.bridge.preflightMotion === undefined
			? undefined
			: { preflightMotion: options.bridge.preflightMotion.bind(options.bridge) };
	const captureViewportBridge =
		options.bridge.captureViewport === undefined
			? undefined
			: { captureViewport: options.bridge.captureViewport.bind(options.bridge) };
	const directingEvidenceBridge =
		options.bridge.produceDirectingEvidence === undefined
			? undefined
			: { produceDirectingEvidence: options.bridge.produceDirectingEvidence.bind(options.bridge) };
	const ardyRegenerateBridge =
		options.bridge.regenerate === undefined
			? undefined
			: { regenerate: options.bridge.regenerate.bind(options.bridge) };
	const ardyGenerateBridge =
		options.bridge.generate === undefined ? undefined : { generate: options.bridge.generate.bind(options.bridge) };
	const ardyInbetweenBridge =
		options.bridge.inbetween === undefined ? undefined : { inbetween: options.bridge.inbetween.bind(options.bridge) };
	// Annotated rather than `satisfies`: an explicit Record over the literal
	const executeBlenderPythonBridge =
		options.allowExecuteBlenderPython === false || options.bridge.executeBlenderPython === undefined
			? undefined
			: { executeBlenderPython: options.bridge.executeBlenderPython.bind(options.bridge) };
	// tool-name union both requires every eligible catalog entry to have a
	// construction path and rejects a path for a name the catalog does not
	// carry, and it gives the flatMap below one element type instead of a
	// union of twenty distinct tool-array types.
	const DIRECTOR_TOOL_CONSTRUCTION_PATHS: Record<EmbeddedDirectorToolName, () => ToolDefinition[]> = {
		inspect_project: () => [createInspectProjectTool(options.bridge)],
		inspect_bridge_state: () =>
			inspectBridgeStateBridge === undefined ? [] : [createInspectBridgeStateTool(inspectBridgeStateBridge)],
		inspect_performance: () =>
			inspectPerformanceBridge === undefined ? [] : [createInspectPerformanceTool(inspectPerformanceBridge)],
		inspect_entity: () => (inspectEntityBridge === undefined ? [] : [createInspectEntityTool(inspectEntityBridge)]),
		inspect_pose_contacts: () =>
			inspectPoseContactsBridge === undefined ? [] : [createInspectPoseContactsTool(inspectPoseContactsBridge)],
		inspect_relations: () =>
			inspectRelationsBridge === undefined ? [] : [createInspectRelationsTool(inspectRelationsBridge)],
		inspect_visual_qa_metrics: () =>
			inspectVisualQaMetricsBridge === undefined
				? []
				: [createInspectVisualQaMetricsTool(inspectVisualQaMetricsBridge)],
		preflight_motion: () =>
			preflightMotionBridge === undefined ? [] : [createPreflightMotionTool(preflightMotionBridge)],
		capture_viewport: () =>
			captureViewportBridge === undefined ? [] : [createCaptureViewportTool(captureViewportBridge)],
		read_image: () => [createReadImageTool(cwd)],
		produce_directing_evidence: () =>
			directingEvidenceBridge === undefined ? [] : [createProduceDirectingEvidenceTool(directingEvidenceBridge)],
		stage_scene: () => (stageBridge === undefined ? [] : [createStageSceneTool(stageBridge)]),
		apply_camera_plan: () => (mutationBridge === undefined ? [] : [createApplyCameraPlanTool(mutationBridge)]),
		render_qa_frames: () => (renderBridge === undefined ? [] : [createRenderQaFramesTool(renderBridge)]),
		repair_bridge: () => (repairBridge === undefined ? [] : [createRepairBridgeTool(repairBridge)]),
		apply_performance_mode: () =>
			performanceBridge === undefined ? [] : [createApplyPerformanceModeTool(performanceBridge)],
		create_fall_motion: () => (fallMotionBridge === undefined ? [] : [createFallMotionTool(fallMotionBridge)]),
		replace_camera_action: () =>
			cameraActionBridge === undefined ? [] : [createReplaceCameraActionTool(cameraActionBridge)],
		ardy_regenerate: () =>
			ardyRegenerateBridge === undefined ? [] : [createArdyRegenerateTool(ardyRegenerateBridge)],
		ardy_generate: () =>
			ardyGenerateBridge === undefined || !ardyHostConfigured ? [] : [createArdyGenerateTool(ardyGenerateBridge)],
		ardy_inbetween: () =>
			ardyInbetweenBridge === undefined || !ardyHostConfigured ? [] : [createArdyInbetweenTool(ardyInbetweenBridge)],
		execute_blender_python: () =>
			executeBlenderPythonBridge === undefined ? [] : [createExecuteBlenderPythonTool(executeBlenderPythonBridge)],
	};

	assertDirectorToolConstructionPaths(DIRECTOR_TOOL_ALLOWLIST, DIRECTOR_TOOL_CONSTRUCTION_PATHS);
	// Each path is invoked exactly once and its output validated against its own
	// key. Keying the map by hand next to twenty factory calls makes a
	// copy-paste error realistic: a path can return a tool belonging to another
	// key, return two tools, or return nothing at all. The key-coverage check
	// above cannot see any of those, so validate the produced tools here rather
	// than discovering the shrunken tool set at runtime.
	const constructed = DIRECTOR_TOOL_ALLOWLIST.map((name) => [name, DIRECTOR_TOOL_CONSTRUCTION_PATHS[name]()] as const);
	for (const [name, produced] of constructed) {
		if (produced.length > 1) {
			throw new Error(`DIRECTOR_TOOL_CONSTRUCTION_INVALID: ${name} produced ${produced.length} tools`);
		}
		const tool = produced[0];
		if (tool !== undefined && tool.name !== name) {
			throw new Error(`DIRECTOR_TOOL_CONSTRUCTION_INVALID: ${name} produced a tool named ${tool.name}`);
		}
		if (tool === undefined && UNCONDITIONAL_DIRECTOR_TOOLS.includes(name)) {
			throw new Error(`DIRECTOR_TOOL_CONSTRUCTION_INVALID: ${name} is unconditional but produced no tool`);
		}
	}
	const customTools = constructed.flatMap(([, produced]) => produced);
	const customToolNames = customTools.map(({ name }) => name);
	const enabledTools = DIRECTOR_TOOL_ALLOWLIST.filter((name) => customToolNames.includes(name));
	if (enabledTools.length !== customToolNames.length) {
		throw new Error(`DIRECTOR_TOOL_ALLOWLIST_MISMATCH: ${customToolNames.join(",")}`);
	}
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
		customTools,
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
