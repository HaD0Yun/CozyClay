import { ArtifactStore } from "@oh-my-blender/director-core";
import type { RenderQaFramesResultV1 } from "@oh-my-blender/protocol";
import { parseRenderQaFramesRequest, parseRenderQaFramesResult } from "@oh-my-blender/protocol";
import type { DirectorHandlerContext } from "./inspect-service.ts";

export function parseRenderQaFramesResultWithImageCompat(input: unknown): RenderQaFramesResultV1 {
	try {
		return parseRenderQaFramesResult(input);
	} catch (error) {
		if (input === null || typeof input !== "object" || Array.isArray(input)) throw error;
		const candidate = input as Record<string, unknown>;
		if (!Array.isArray(candidate.frames)) throw error;
		const frames = candidate.frames.map((frame) => {
			if (frame === null || typeof frame !== "object" || Array.isArray(frame)) throw error;
			const { image, ...metadata } = frame as Record<string, unknown>;
			if (
				image === null ||
				typeof image !== "object" ||
				Array.isArray(image) ||
				(image as Record<string, unknown>).mime_type !== "image/png" ||
				typeof (image as Record<string, unknown>).data_base64 !== "string"
			) {
				throw error;
			}
			return metadata;
		});
		parseRenderQaFramesResult({ ...candidate, frames });
		return input as RenderQaFramesResultV1;
	}
}

export interface RenderArtifactDeclaration {
	readonly sha256: string;
	readonly byteLength: number;
}

export function createRenderArtifactReservationFactory(rootDirectory: string) {
	let store: Promise<ArtifactStore> | undefined;
	return async (artifacts: readonly RenderArtifactDeclaration[]) => {
		store ??= ArtifactStore.open(rootDirectory);
		return (await store).reserveBatch(
			artifacts.map((artifact) => ({
				expectedSha256: artifact.sha256,
				byteLength: artifact.byteLength,
			})),
		);
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
		const result = parseRenderQaFramesResultWithImageCompat(raw);
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
