import { randomUUID } from "node:crypto";
import type { ApplyCameraPlanProgress, RenderQaFramesProgress, StageSceneProgress } from "@cclay/blender-tools";
import { assertCanonicalSize, buildProjectManifest } from "@cclay/director-core";
import {
	type CameraPlanMutationCandidate,
	type CameraPlanV1,
	canonicalizeStageScenePlan,
	parseRenderQaFramesResult,
	parseSceneSnapshot,
	type RenderQaFramesRequestV1,
	type RenderQaFramesResultV1,
	type StageSceneMutationCandidate,
	type StageScenePlanV1,
} from "@cclay/protocol";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type CameraPlanRevisionStore,
	commitCameraPlanMutation,
	createDirectorProjectStore,
} from "./apply-camera-plan-service.ts";
import { createDirectorSession } from "./session.ts";
import { commitStageSceneMutation } from "./stage-scene-service.ts";

const INSPECT_INSTRUCTION = "Inspect the current Blender project before directing it.";

export interface InspectHandlerOptions {
	readonly model: Model<string>;
	readonly modelRuntime: ModelRuntime;
	readonly store?: CameraPlanRevisionStore;
}

export interface DirectorHandlerContext {
	readonly signal: AbortSignal;
	readonly request?: { expected_revision_id?: string };
	readonly reportProgress?: (phase: string, completed: number, total: number) => void;
	readonly applyCameraPlan?: (
		plan: CameraPlanV1,
		context: {
			readonly signal: AbortSignal | undefined;
			readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
		},
	) => Promise<CameraPlanMutationCandidate>;
	readonly stageScene?: (
		plan: StageScenePlanV1,
		context: {
			readonly signal: AbortSignal | undefined;
			readonly reportProgress: (progress: StageSceneProgress) => void;
		},
	) => Promise<StageSceneMutationCandidate>;
	readonly renderQaFrames?: (
		request: RenderQaFramesRequestV1,
		context: {
			readonly signal: AbortSignal | undefined;
			readonly reportProgress: (progress: RenderQaFramesProgress) => void;
		},
	) => Promise<RenderQaFramesResultV1>;
	readonly beginDurableCommit?: () => void;
}

export function createInspectHandler(options: InspectHandlerOptions) {
	const store = options.store ?? createDirectorProjectStore(process.cwd());
	return async (params: Record<string, unknown>, context: DirectorHandlerContext) => {
		const snapshot = parseSceneSnapshot(params.snapshot);
		assertCanonicalSize(snapshot);
		const manifest = buildProjectManifest(snapshot);
		const expectedRevision = context.request?.expected_revision_id;
		if (expectedRevision !== undefined && expectedRevision !== manifest.revision) {
			throw new Error(`STALE_BASE: expected ${expectedRevision}, current revision is ${manifest.revision}`);
		}
		let resultingRevision = manifest.revision;
		const session = await createDirectorSession({
			bridge: {
				inspectProject: async () => manifest,
				applyCameraPlan: async (plan, bridgeContext) => {
					if (plan.expected_revision_id !== manifest.revision) {
						throw new Error(
							`STALE_BASE: expected ${plan.expected_revision_id}, current revision is ${manifest.revision}`,
						);
					}
					if (context.applyCameraPlan === undefined) {
						throw new Error("MUTATION_BRIDGE_UNAVAILABLE: protocol v2 mutation bridge is required");
					}
					const candidate = await context.applyCameraPlan(plan, {
						signal: bridgeContext.signal,
						reportProgress: (progress) => {
							bridgeContext.reportProgress(progress);
							context.reportProgress?.(progress.phase, progress.completed, progress.total);
						},
					});
					const result = await commitCameraPlanMutation(store, plan, candidate, context.beginDurableCommit);
					resultingRevision = result.resulting_revision_id;
					return result;
				},
				stageScene: async (request, bridgeContext) => {
					if (request.expected_revision_id !== resultingRevision) {
						throw new Error(
							`STALE_BASE: expected ${request.expected_revision_id}, current revision is ${resultingRevision}`,
						);
					}
					if (context.stageScene === undefined) {
						throw new Error("MUTATION_BRIDGE_UNAVAILABLE: protocol v2 mutation bridge is required");
					}
					const plan = canonicalizeStageScenePlan(request, randomUUID);
					const candidate = await context.stageScene(plan, {
						signal: bridgeContext.signal,
						reportProgress: (progress) => {
							bridgeContext.reportProgress(progress);
							context.reportProgress?.(progress.phase, progress.completed, progress.total);
						},
					});
					const result = await commitStageSceneMutation(store, plan, candidate, context.beginDurableCommit);
					resultingRevision = result.resulting_revision_id;
					return result;
				},
				renderQaFrames: async (request, bridgeContext) => {
					if (request.expected_revision_id !== resultingRevision) {
						throw new Error(
							`STALE_BASE: expected ${request.expected_revision_id}, current revision is ${resultingRevision}`,
						);
					}
					if (context.renderQaFrames === undefined) {
						throw new Error("RENDER_BRIDGE_UNAVAILABLE: protocol v2 bridge is required");
					}
					const result = parseRenderQaFramesResult(
						await context.renderQaFrames(request, {
							signal: bridgeContext.signal,
							reportProgress: (progress) => {
								bridgeContext.reportProgress(progress);
								context.reportProgress?.(progress.phase, progress.completed, progress.total);
							},
						}),
					);
					if (result.expected_revision_id !== request.expected_revision_id) {
						throw new Error("STALE_BASE: render result does not bind the requested revision");
					}
					if (
						result.frames.length !== request.frames.length ||
						result.frames.some((frame, index) => frame.frame !== request.frames[index])
					) {
						throw new Error("INVALID_RENDER_QA_RESULT: result frames must exactly match the requested frames");
					}
					return result;
				},
			},
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
				resulting_revision_id: resultingRevision,
			};
		} finally {
			context.signal.removeEventListener("abort", abort);
			session.dispose();
		}
	};
}
