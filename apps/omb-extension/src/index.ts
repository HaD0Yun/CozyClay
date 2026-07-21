import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createApplyCameraPlanTool,
	createInspectEntityTool,
	createInspectProjectTool,
	createReadImageTool,
	createRenderQaFramesTool,
	createStageSceneTool,
} from "@oh-my-blender/blender-tools";
import {
	canonicalizeStageScenePlan,
	type CameraPlanV1,
	type StageSceneRequestV1,
} from "@oh-my-blender/protocol";
import {
	commitCameraPlanMutation,
	commitStageSceneMutation,
	createDirectorProjectStore,
	DIRECTOR_PROMPT_CONTRACT,
	DIRECTOR_PROMPT_FULL,
} from "@oh-my-blender/director-runtime";
import { randomUUID } from "node:crypto";
import { BlenderBridge } from "./bridge.ts";

const ENDPOINT_FILENAME = "pi-bridge.json";

export default async function ombExtension(pi: ExtensionAPI): Promise<void> {
	const cwd = process.cwd();
	const store = createDirectorProjectStore(cwd);
	// Fail at extension load rather than giving the model tools bound to no OMB
	// project. Blender owns project initialization before Pi starts.
	await store.readProject();

	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const runtimeRoot = path.join(cwd, ".omb", "pi-runtime");
	const runtimeDirectory = path.join(runtimeRoot, endpoint.launchId);
	const endpointPath = path.join(cwd, ".omb", ENDPOINT_FILENAME);
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

	pi.registerTool(createInspectProjectTool(bridge));
	pi.registerTool(createInspectEntityTool(bridge));
	pi.registerTool(createReadImageTool(cwd));
	pi.registerTool(createStageSceneTool(mutationBridge));
	pi.registerTool(createApplyCameraPlanTool(cameraBridge));
	pi.registerTool(createRenderQaFramesTool(bridge));
	// Prime the director with the full directing craft on the first turn of the
	// session, then drop to the short tool-contract reminder for later turns.
	// The domain knowledge is expensive context; once the model has read it on
	// turn one it carries forward in the conversation, so repeating it every
	// turn would waste context window linearly.
	let directorPrimed = false;
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${
			directorPrimed ? DIRECTOR_PROMPT_CONTRACT : DIRECTOR_PROMPT_FULL
		}`,
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
	const refreshBlenderStatus = (setStatus: (key: string, text: string | undefined) => void) => {
		const attached = bridge.isAttached();
		const text = attached
			? `Blender: attached${bridge.attachedProjectId ? ` (${bridge.attachedProjectId.slice(0, 8)})` : ""}`
			: "Blender: waiting";
		if (text !== lastStatusText) {
			lastStatusText = text;
			setStatus(BLENDER_STATUS_KEY, text);
		}
	};
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const setStatus = ctx.ui.setStatus.bind(ctx.ui);
		refreshBlenderStatus(setStatus);
		setInterval(() => refreshBlenderStatus(setStatus), 2000);
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
		await bridge.close();
		await rm(endpointPath, { force: true });
		await rm(runtimeDirectory, { recursive: true, force: true });
	});

}
