import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assertCanonicalSize, buildProjectManifest } from "@oh-my-blender/director-core";
import { parseSceneSnapshot } from "@oh-my-blender/protocol";
import { createDirectorSession } from "./session.ts";

const INSPECT_INSTRUCTION = "Inspect the current Blender project before directing it.";

export interface InspectHandlerOptions {
	readonly model: Model<string>;
	readonly modelRuntime: ModelRuntime;
}

export function createInspectHandler(options: InspectHandlerOptions) {
	return async (
		params: Record<string, unknown>,
		context: { signal: AbortSignal; request?: { expected_revision_id?: string } },
	) => {
		const snapshot = parseSceneSnapshot(params.snapshot);
		assertCanonicalSize(snapshot);
		const manifest = buildProjectManifest(snapshot);
		const expectedRevision = context.request?.expected_revision_id;
		if (expectedRevision !== undefined && expectedRevision !== manifest.revision) {
			throw new Error(`STALE_BASE: expected ${expectedRevision}, current revision is ${manifest.revision}`);
		}
		const session = await createDirectorSession({
			bridge: { inspectProject: async () => manifest },
			model: options.model,
			modelRuntime: options.modelRuntime,
		});
		const abort = () => session.abort();
		context.signal.addEventListener("abort", abort, { once: true });
		try {
			if (context.signal.aborted) abort();
			await session.prompt(INSPECT_INSTRUCTION);
			if (!session.messages.some((message) => message.role === "toolResult")) {
				throw new Error("PI_INSPECT_TOOL_RESULT_MISSING");
			}
			return {
				result: {
					revision: manifest.revision,
					sceneName: snapshot.scene.name,
					objectNames: snapshot.objects.map((object) => object.name),
				},
				resulting_revision_id: manifest.revision,
			};
		} finally {
			context.signal.removeEventListener("abort", abort);
			session.dispose();
		}
	};
}
