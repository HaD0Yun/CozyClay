#!/usr/bin/env node
import {
	createApplyCameraPlanHandler,
	createDirectorProjectStore,
	createInspectHandler,
	createRenderArtifactReservationFactory,
	createRenderQaFramesHandler,
} from "@oh-my-blender/director-runtime";
import { createBootRuntime, parseBootArguments } from "./boot.ts";
import { start } from "./daemon.ts";

async function main(): Promise<void> {
	const boot = parseBootArguments(process.argv.slice(2));
	const runtime = await createBootRuntime(boot);
	if (runtime.credentialEnvironmentVariable !== undefined) {
		delete process.env[runtime.credentialEnvironmentVariable];
	}
	try {
		const store = createDirectorProjectStore(process.cwd());
		const beginArtifactReservations = createRenderArtifactReservationFactory(process.cwd());
		const inspect = createInspectHandler({ model: runtime.model, modelRuntime: runtime.modelRuntime, store });
		const daemon = await start({
			port: boot.port,
			handlers: {
				inspect_project: async (params, context) => {
					try {
						return await inspect(params, context);
					} catch {
						throw new Error("MODEL_PROVIDER_ERROR: provider request failed");
					}
				},
				apply_camera_plan: createApplyCameraPlanHandler({ store }),
				render_qa_frames: createRenderQaFramesHandler(),
			},
			beginArtifactReservations,
		});
		// Architecture §4 cleanup order ends with "and exit": once the protocol
		// shutdown drain completes, the child process must terminate even if the
		// model runtime still holds event-loop handles.
		await daemon.stopped;
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
