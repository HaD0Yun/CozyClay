import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createApplyCameraPlanTool,
	createApplyPerformanceModeTool,
	createCaptureViewportTool,
	createFallMotionTool,
	createArdyGenerateTool,
	createArdyInbetweenTool,
	createArdyRegenerateTool,
	createExecuteBlenderPythonTool,
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
} from "@cclay/blender-tools";
import {
	canonicalizeStageScenePlan,
	type CameraPlanV1,
	type StageSceneRequestV1,
} from "@cclay/protocol";
import {
	bundledSkillsPromptBlock,
	commitCameraPlanMutation,
	commitStageSceneMutation,
	createDirectorProjectStore,
	DIRECTOR_PROMPT_CONTRACT,
	DIRECTOR_PROMPT_FULL,
	isArdyHostConfigured,
} from "@cclay/director-runtime";
import { randomUUID } from "node:crypto";
// This entry point lives in `src/cclay/` on purpose: Pi labels a loaded
// extension with the shortest unique suffix of its path, stripping a trailing
// `index.ts`. A `src/index.ts` entry therefore shows up as "src" in the startup
// Extensions list, so the directory name is the display name.
import { registerBtwCommand } from "../btw.ts";
import { BlenderBridge } from "../bridge.ts";
import { startRegenerateQueueRunner } from "../regenerate-queue-runner.ts";
import { startGenerateQueueRunner } from "../generate-queue-runner.ts";
import { startInbetweenQueueRunner } from "../inbetween-queue-runner.ts";
import { registerOpenAIServiceTier } from "../openai-service-tier.ts";


export default async function cclayExtension(pi: ExtensionAPI): Promise<void> {
	const cwd = process.cwd();
	await registerOpenAIServiceTier(pi, cwd);
	const store = createDirectorProjectStore(cwd);
	// Fail at extension load rather than giving the model tools bound to no CCLAY
	// project. Blender owns project initialization before Pi starts.
	const project = await store.readProject();
	const bridge = new BlenderBridge(cwd, { projectId: project.project_id });
	await bridge.start();

	const mutationBridge = {
		stageScene: async (
			request: StageSceneRequestV1,
			context: Parameters<BlenderBridge["stageScene"]>[1],
		) => {
			const plan = canonicalizeStageScenePlan(request, randomUUID);
			const candidate = await bridge.stageScene(plan, context);
			const result = await commitStageSceneMutation(store, plan, candidate);
			await bridge.finishDurableCommit(result.resulting_revision_id);
			return result;
		},
	};
	const cameraBridge = {
		applyCameraPlan: async (
			plan: CameraPlanV1,
			context: Parameters<BlenderBridge["applyCameraPlan"]>[1],
		) => {
			const candidate = await bridge.applyCameraPlan(plan, context);
			const result = await commitCameraPlanMutation(store, plan, candidate);
			await bridge.finishDurableCommit(result.resulting_revision_id);
			return result;
		},
	};

	// The wrapper (scripts/cclay-ardy-generate) is the authority on host
	// configuration: it requires a non-empty CCLAY_ARDY_HOST and prints
	// "CCLAY_ARDY_HOST is required" otherwise. The same signal gates what the
	// model is OFFERED: without a configured host the two host-backed tools
	// would only ever fail at generation time, so they are not registered and
	// their queue runners are not started. ardy_regenerate is unaffected.
	const ardyHostConfigured = isArdyHostConfigured();

	// The runner keeps watching animator-published queue requests while its
	// submit bridge gives the model-facing tool that same durable execution path.
	const regenerateQueue = startRegenerateQueueRunner({
		cwd,
		// Live getter: re-reads the bridge's current revision for every
		// request, so the handler's staleness guard sees the latest commit.
		liveRevisionId: () => bridge.revisionId,
		stageScene: (request, context) =>
			mutationBridge.stageScene(request, context as Parameters<BlenderBridge["stageScene"]>[1]),
		onError: (error) => {
			// Reported, never thrown: a failed sweep must not take the
			// extension down, or the next request would sit unwatched.
			console.error("[cclay] regeneration sweep failed:", error);
		},
	});

	// The generate and in-between queues are consumed the same way: a
	// serialized sweep per runner, recovery before the first sweep, the
	// project directory as the wrapper's cwd, and the live bridge revision
	// for the pre-kernel staleness guard. The model-facing ardy_generate and
	// ardy_inbetween tools submit into these same queues, so animator- and
	// director-published requests are consumed identically.
	const generateQueue = ardyHostConfigured
		? startGenerateQueueRunner({
				cwd,
				// Live getter: re-reads the bridge's current revision for every
				// request, so the sweep's staleness guard sees the latest commit.
				liveRevisionId: () => bridge.revisionId,
				stageScene: (request, context) =>
					mutationBridge.stageScene(request, context as Parameters<BlenderBridge["stageScene"]>[1]),
				onError: (error) => {
					// Reported, never thrown: a failed sweep must not take the
					// extension down, or the next request would sit unwatched.
					console.error("[cclay] generation sweep failed:", error);
				},
			})
		: undefined;
	const inbetweenQueue = ardyHostConfigured
		? startInbetweenQueueRunner({
				cwd,
				// Live getter: re-reads the bridge's current revision for every
				// request, so the sweep's staleness guard sees the latest commit.
				liveRevisionId: () => bridge.revisionId,
				stageScene: (request, context) =>
					mutationBridge.stageScene(request, context as Parameters<BlenderBridge["stageScene"]>[1]),
				onError: (error) => {
					// Reported, never thrown: a failed sweep must not take the
					// extension down, or the next request would sit unwatched.
					console.error("[cclay] in-between sweep failed:", error);
				},
			})
		: undefined;

	const directorTools = [
		createInspectProjectTool(bridge),
		createInspectBridgeStateTool(bridge),
		createInspectPerformanceTool(bridge),
		createInspectEntityTool(bridge),
		createInspectPoseContactsTool(bridge),
		createInspectRelationsTool(bridge),
		createInspectVisualQaMetricsTool(bridge),
		createPreflightMotionTool(bridge),
		createCaptureViewportTool(bridge),
		createReadImageTool(cwd),
		createProduceDirectingEvidenceTool(bridge),
		createStageSceneTool(mutationBridge),
		createApplyCameraPlanTool(cameraBridge),
		createRenderQaFramesTool(bridge),
		createRepairBridgeTool(bridge),
		createApplyPerformanceModeTool(bridge),
		createFallMotionTool(bridge),
		createReplaceCameraActionTool(bridge),
		createArdyRegenerateTool(regenerateQueue),
		// Both host-backed tools ride one conditional, the same optional
		// mechanism an absent bridge uses in the director session: without a
		// configured ARDY host there is no queue runner to submit through, so
		// offering the tools would hand the model surfaces that can only fail.
		...(generateQueue !== undefined && inbetweenQueue !== undefined
			? [createArdyGenerateTool(generateQueue), createArdyInbetweenTool(inbetweenQueue)]
			: []),
		...(project.allowExecuteBlenderPython === false ? [] : [createExecuteBlenderPythonTool(bridge)]),
	];
	const registeredToolNames = directorTools.map((tool) => tool.name);
	const eligibleToolNames = EMBEDDED_DIRECTOR_ELIGIBLE_TOOL_NAMES.filter(
		(name) =>
			(name !== "execute_blender_python" || project.allowExecuteBlenderPython !== false) &&
			((name !== "ardy_generate" && name !== "ardy_inbetween") || ardyHostConfigured),
	);
	if (
		registeredToolNames.length !== eligibleToolNames.length ||
		registeredToolNames.some((name, index) => name !== eligibleToolNames[index])
	) {
		throw new Error(`DIRECTOR_TOOL_REGISTRATION_MISMATCH: ${registeredToolNames.join(",")}`);
	}
	for (const tool of directorTools) pi.registerTool(tool);
	// Ephemeral side questions. Registered after the tools on purpose: /btw
	// runs its own tool-less request, so it must never see this catalog.
	const btw = registerBtwCommand(pi);
	// Prime the director with the full directing craft on the first turn of the
	// session, then drop to the short tool-contract reminder for later turns.
	// The domain knowledge is expensive context; once the model has read it on
	// turn one it carries forward in the conversation, so repeating it every
	// turn would waste context window linearly.
	let directorPrimed = false;
	// Bundled skill frontmatter is validated at activation before any turn runs.
	const skillsBlock = bundledSkillsPromptBlock();
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${
			directorPrimed ? DIRECTOR_PROMPT_CONTRACT : DIRECTOR_PROMPT_FULL
		}\n\n${skillsBlock}`,
	}));
	pi.on("agent_start", () => {
		directorPrimed = true;
	});

	// Reflect Blender bridge connection state in the Pi footer so the user can
	// see whether the director is attached to a live Blender peer. The add-on
	// connects and disconnects as Blender opens/closes, so poll cheaply and only
	// push a status update when the state text changes.
	let lastStatusText: string | undefined = undefined;
	const BLENDER_STATUS_KEY = "blender";
	let statusInterval: ReturnType<typeof setInterval> | undefined;
	const refreshBlenderStatus = (setStatus: (key: string, text: string | undefined) => void) => {
		const attached = bridge.isAttached();
		const text = attached
			? `Blender: attached${bridge.attachedProjectId ? ` (${bridge.attachedProjectId.slice(0, 8)})` : ""}`
			: (bridge.attachFailure ?? "Blender: waiting");
		if (text !== lastStatusText) {
			lastStatusText = text;
			setStatus(BLENDER_STATUS_KEY, text);
		}
	};
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const setStatus = ctx.ui.setStatus.bind(ctx.ui);
		refreshBlenderStatus(setStatus);
		statusInterval = setInterval(() => refreshBlenderStatus(setStatus), 2000);
		ctx.ui.onTerminalInput(() => {
			refreshBlenderStatus(setStatus);
			return { consume: false };
		});
	});
	pi.on("tool_result", (_event, ctx) => {
		if (ctx.mode !== "tui") return {};
		refreshBlenderStatus(ctx.ui.setStatus.bind(ctx.ui));
		return {};
	});
	pi.on("session_shutdown", async () => {
		btw.dismiss();
		if (statusInterval !== undefined) {
			clearInterval(statusInterval);
			statusInterval = undefined;
		}
		await regenerateQueue.stop();
		// The two host-backed runners exist only when the host is configured,
		// so they stop only when they exist.
		if (generateQueue !== undefined) await generateQueue.stop();
		if (inbetweenQueue !== undefined) await inbetweenQueue.stop();
		await bridge.close();
	});

}
