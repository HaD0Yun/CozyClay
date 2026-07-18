import { ArtifactStore } from "@oh-my-blender/director-core";
import type { RenderQaFramesResultV1 } from "@oh-my-blender/protocol";
import { parseRenderQaFramesRequest, parseRenderQaFramesResult } from "@oh-my-blender/protocol";
import type { DirectorHandlerContext } from "./inspect-service.ts";

export interface RenderArtifactPayload {
	readonly sha256: string;
	readonly byteLength: number;
	readonly bytes: Uint8Array;
}

export function createRenderArtifactPublisher(rootDirectory: string) {
	let store: Promise<ArtifactStore> | undefined;
	return async (artifact: RenderArtifactPayload) => {
		store ??= ArtifactStore.open(rootDirectory);
		return (await store).publish({ expectedSha256: artifact.sha256, byteLength: artifact.byteLength }, [
			artifact.bytes,
		]);
	};
}

export function createRenderQaFramesHandler() {
	return async (params: unknown, context: DirectorHandlerContext) => {
		const request = parseRenderQaFramesRequest(params);
		if (context.request?.expected_revision_id !== request.revision_id) {
			throw new Error(
				`STALE_BASE: render expected ${request.revision_id}, request expected ${String(context.request?.expected_revision_id)}`,
			);
		}
		if (context.renderQaFrames === undefined) {
			throw new Error("RENDER_BRIDGE_UNAVAILABLE: protocol v2 bridge is required");
		}
		const raw = await context.renderQaFrames(request, {
			signal: context.signal,
			reportProgress: (progress) => context.reportProgress?.(progress.phase, progress.completed, progress.total),
		});
		const result: RenderQaFramesResultV1 = parseRenderQaFramesResult(raw);
		if (result.revision_id !== request.revision_id) {
			throw new Error("STALE_BASE: render result does not bind the requested revision");
		}
		if (
			result.frames.length !== request.frames.length ||
			result.frames.some((frame, index) => frame.frame !== request.frames[index])
		) {
			throw new Error("INVALID_RENDER_QA_RESULT: result frames must exactly match the requested frames");
		}
		return { result, resulting_revision_id: request.revision_id };
	};
}
