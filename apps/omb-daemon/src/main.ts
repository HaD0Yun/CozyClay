#!/usr/bin/env node
import {
	createApplyCameraPlanHandler,
	createDirectorProjectStore,
	createDirectorTurnHandler,
	createInspectHandler,
	createRenderArtifactReservationFactory,
	createRenderQaFramesHandler,
	createStageSceneHandler,
	type DirectorHandlerContext,
} from "@oh-my-blender/director-runtime";
import { createBootRuntime, parseBootArguments } from "./boot.ts";
import { start, type Handler } from "./daemon.ts";

/**
 * Test/operations override for the 60-second idle window. The narrow bounds
 * prevent accidental zero-delay churn and unbounded stale connections.
 */
function idleTimeoutFromEnvironment(): number | undefined {
	const raw = process.env.OMB_IDLE_TIMEOUT_MS;
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 500 || value > 60_000) {
		throw new Error("OMB_IDLE_TIMEOUT_MS must be an integer from 500 through 60000");
	}
	return value;
}
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requireProjectId(value: unknown): string {
	if (typeof value !== "string" || !PROJECT_ID_PATTERN.test(value)) {
		throw new Error("PROJECT_CONFIGURATION_ERROR: project is unavailable");
	}
	return value;
}

type DirectorHandler = (
	params: Record<string, unknown>,
	context: DirectorHandlerContext,
) => ReturnType<Handler>;

type DirectorApplyResult = Awaited<
	ReturnType<NonNullable<DirectorHandlerContext["applyCameraPlan"]>>
>;
type DirectorStageResult = Awaited<
	ReturnType<NonNullable<DirectorHandlerContext["stageScene"]>>
>;

function adaptDirectorHandler(handler: DirectorHandler): Handler {
	return (params, context) =>
		handler(params, {
			signal: context.signal,
			request: context.request,
			reportProgress: context.reportProgress,
			applyCameraPlan: async (plan, bridgeContext) =>
				(await context.applyCameraPlan(
					plan,
					bridgeContext,
				)) as unknown as DirectorApplyResult,
			stageScene: async (plan, bridgeContext) =>
				(await context.stageScene(
					plan,
					bridgeContext,
				)) as unknown as DirectorStageResult,
			renderQaFrames: context.renderQaFrames,
			beginDurableCommit: context.beginDurableCommit,
		});
}

async function main(): Promise<void> {
	const boot = parseBootArguments(process.argv.slice(2));
	const cwd = process.cwd();
	const store = createDirectorProjectStore(cwd);
	let projectId: string;
	try {
		projectId = requireProjectId((await store.readProject()).project_id);
	} catch {
		throw new Error("PROJECT_CONFIGURATION_ERROR: project is unavailable");
	}
	const runtime = await createBootRuntime(boot);
	if (runtime.credentialEnvironmentVariable !== undefined) {
		delete process.env[runtime.credentialEnvironmentVariable];
	}
	try {
		const beginArtifactReservations = createRenderArtifactReservationFactory(cwd);
		const inspect = createInspectHandler({ model: runtime.model, modelRuntime: runtime.modelRuntime, store });
		const directorTurn = createDirectorTurnHandler({
			model: runtime.model,
			modelRuntime: runtime.modelRuntime,
			store,
			cwd,
		});
		const daemon = await start({
			projectId,
			port: boot.port,
			idleTimeoutMs: idleTimeoutFromEnvironment(),
			projectDirectory: cwd,
			directorTurn,
			handlers: {
				inspect_project: adaptDirectorHandler(async (params, context) => {
					try {
						return await inspect(params, context);
					} catch {
						throw new Error("MODEL_PROVIDER_ERROR: provider request failed");
					}
				}),
				apply_camera_plan: adaptDirectorHandler(createApplyCameraPlanHandler({ store })),
				stage_scene: adaptDirectorHandler(createStageSceneHandler({ store })),
				render_qa_frames: adaptDirectorHandler(createRenderQaFramesHandler()),
			},
			beginArtifactReservations,
		});
		const closeFromSignal = () => {
			void daemon.close();
		};
		process.once("SIGINT", closeFromSignal);
		process.once("SIGTERM", closeFromSignal);
		try {
			// Architecture §4 cleanup order ends with "and exit": once the protocol
			// shutdown drain completes, the child process must terminate even if the
			// model runtime still holds event-loop handles.
			await daemon.stopped;
		} finally {
			process.off("SIGINT", closeFromSignal);
			process.off("SIGTERM", closeFromSignal);
		}
	} finally {
		await runtime.dispose();
	}
}

try {
	await main();
	process.exit(0);
} catch (error) {
	const message = error instanceof Error ? error.message : "PROVIDER_BOOT_FAILED: daemon startup failed";
	process.stderr.write(`${message.slice(0, 512)}\n`);
	process.exit(1);
}
