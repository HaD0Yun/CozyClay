import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createApplyCameraPlanTool,
	createApplyPerformanceModeTool,
	createCaptureViewportTool,
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
} from "@cclay/director-runtime";
import { randomUUID } from "node:crypto";
// This entry point lives in `src/cclay/` on purpose: Pi labels a loaded
// extension with the shortest unique suffix of its path, stripping a trailing
// `index.ts`. A `src/index.ts` entry therefore shows up as "src" in the startup
// Extensions list, so the directory name is the display name.
import { registerBtwCommand } from "../btw.ts";
import { BlenderBridge } from "../bridge.ts";
import { startRegenerateQueueRunner } from "../regenerate-queue-runner.ts";

const ENDPOINT_FILENAME = "pi-bridge.json";

export default async function cclayExtension(pi: ExtensionAPI): Promise<void> {
	const cwd = process.cwd();
	const store = createDirectorProjectStore(cwd);
	// Fail at extension load rather than giving the model tools bound to no CCLAY
	// project. Blender owns project initialization before Pi starts.
	await store.readProject();

	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const runtimeRoot = path.join(cwd, ".cclay", "pi-runtime");
	const runtimeDirectory = path.join(runtimeRoot, endpoint.launchId);
	const endpointPath = path.join(cwd, ".cclay", ENDPOINT_FILENAME);
	await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
	await chmod(runtimeRoot, 0o700);
	await chmod(runtimeDirectory, 0o700);
	await writeFile(
		path.join(runtimeDirectory, "endpoint.json"),
		`${JSON.stringify({
			schema_version: 1,
			host: endpoint.host,
			port: endpoint.port,
			launch_id: endpoint.launchId,
		})}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	await writeFile(
		endpointPath,
		`${JSON.stringify({
			schema_version: 1,
			runtime_directory: runtimeDirectory,
			credential: endpoint.token,
		})}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	await chmod(endpointPath, 0o600);

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

	// Started here rather than registered as a tool: the add-on has no way to
	// push a request to this process, so it publishes a queue file and this is
	// what looks. It is a deterministic reaction to a button the animator
	// pressed, so it stays off the director tool allowlist entirely.
	const regenerateQueue = startRegenerateQueueRunner({
		cwd,
		stageScene: (request, context) =>
			mutationBridge.stageScene(request, context as Parameters<BlenderBridge["stageScene"]>[1]),
		onError: (error) => {
			// Reported, never thrown: a failed sweep must not take the
			// extension down, or the next request would sit unwatched.
			console.error("[cclay] regeneration sweep failed:", error);
		},
	});

	pi.registerTool(createInspectProjectTool(bridge));
	pi.registerTool(createInspectBridgeStateTool(bridge));
	pi.registerTool(createInspectPerformanceTool(bridge));
	pi.registerTool(createInspectEntityTool(bridge));
	pi.registerTool(createInspectPoseContactsTool(bridge));
	pi.registerTool(createInspectRelationsTool(bridge));
	pi.registerTool(createInspectVisualQaMetricsTool(bridge));
	pi.registerTool(createPreflightMotionTool(bridge));
	pi.registerTool(createCaptureViewportTool(bridge));
	pi.registerTool(createReadImageTool(cwd));
	pi.registerTool(createProduceDirectingEvidenceTool(bridge));
	pi.registerTool(createStageSceneTool(mutationBridge));
	pi.registerTool(createApplyCameraPlanTool(cameraBridge));
	pi.registerTool(createRenderQaFramesTool(bridge));
	pi.registerTool(createRepairBridgeTool(bridge));
	pi.registerTool(createApplyPerformanceModeTool(bridge));
	pi.registerTool(createFallMotionTool(bridge));
	pi.registerTool(createReplaceCameraActionTool(bridge));
	// Ephemeral side questions. Registered after the tools on purpose: /btw
	// runs its own tool-less request, so it must never see this catalog.
	const btw = registerBtwCommand(pi);
	// Prime the director with the full directing craft on the first turn of the
	// session, then drop to the short tool-contract reminder for later turns.
	// The domain knowledge is expensive context; once the model has read it on
	// turn one it carries forward in the conversation, so repeating it every
	// turn would waste context window linearly.
	let directorPrimed = false;
	// Digest-verified at activation: a tampered bundled skill fails the session
	// before any turn runs, matching the DIRECTOR_PROMPT_DIGEST posture.
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
		await bridge.close();
		await rm(endpointPath, { force: true });
		await rm(runtimeDirectory, { recursive: true, force: true });
	});

}
