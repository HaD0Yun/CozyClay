import { createHash, randomUUID } from "node:crypto";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	ApplyCameraPlanBridge,
	ApplyCameraPlanProgress,
	InspectProjectBridge,
	ProjectManifest,
	RenderQaFramesBridge,
	RenderQaFramesProgress,
	StageSceneBridge,
	StageSceneProgress,
} from "@oh-my-blender/blender-tools";
import {
	type CameraPlanMutationCandidate,
	type CameraPlanV1,
	canonicalizeStageScenePlan,
	type DirectorToolName,
	type DirectorTurn,
	parseRenderQaFramesResult,
	type RenderQaFramesRequestV1,
	type RenderQaFramesResultV1,
	type StageSceneMutationCandidate,
	type StageScenePlanV1,
} from "@oh-my-blender/protocol";
import {
	type CameraPlanRevisionStore,
	commitCameraPlanMutation,
	createDirectorProjectStore,
} from "./apply-camera-plan-service.ts";
import { createDirectorSession } from "./session.ts";
import { commitStageSceneMutation } from "./stage-scene-service.ts";

export type DirectorTurnToolEvent =
	| {
			readonly type: "started";
			readonly toolName: DirectorToolName;
			readonly toolCallId: string;
			readonly paramsSummary: string;
	  }
	| {
			readonly type: "finished";
			readonly toolName: DirectorToolName;
			readonly toolCallId: string;
			readonly digest: string;
			readonly isError: boolean;
	  };

export interface DirectorTurnLoopOptions {
	readonly bridge: InspectProjectBridge & ApplyCameraPlanBridge & RenderQaFramesBridge & StageSceneBridge;
	readonly model: Model<string>;
	readonly modelRuntime: ModelRuntime;
	readonly cwd?: string;
	readonly agentDir?: string;
}

export interface DirectorTurnRunOptions {
	readonly prompt: string;
	readonly expectedRevisionId: string;
	readonly signal: AbortSignal;
	readonly onToolEvent?: (event: DirectorTurnToolEvent) => void;
}

export interface DirectorTurnResult {
	readonly summary: string;
	readonly resultingRevisionId: string;
	readonly toolCallOrder: readonly DirectorToolName[];
}

type Phase = "initial" | "initial_inspected" | "primary_mutated" | "verification_inspected" | "rendered" | "repaired";

interface RunState {
	phase: Phase;
	currentRevisionId: string;
	violation?: Error;
	readonly toolCallOrder: DirectorToolName[];
}

const DIRECTOR_TOOL_NAMES = new Set<DirectorToolName>([
	"inspect_project",
	"stage_scene",
	"apply_camera_plan",
	"render_qa_frames",
]);
const BOOTSTRAP_REVISION_ID = "0".repeat(64);

function isDirectorToolName(value: string): value is DirectorToolName {
	return DIRECTOR_TOOL_NAMES.has(value as DirectorToolName);
}

function paramsSummary(toolName: DirectorToolName, args: unknown): string {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return `${toolName}()`;
	const keys = Object.keys(args).sort();
	return `${toolName}(${keys.join(",")})`.slice(0, 512);
}

function resultDigest(result: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(result) ?? "null";
	} catch {
		serialized = "[unserializable tool result]";
	}
	return createHash("sha256").update(serialized).digest("hex");
}

function assistantSummary(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/**
 * Turn-contract violation raised by the loop itself (never by provider/tool
 * code). The daemon maps these by instanceof to trusted fixed messages, so
 * untrusted errors cannot spoof them with a string prefix.
 */
export class DirectorLoopContractError extends Error {
	readonly code: "DIRECTOR_LOOP_INCOMPLETE" | "DIRECTOR_SUMMARY_MISSING";

	constructor(code: "DIRECTOR_LOOP_INCOMPLETE" | "DIRECTOR_SUMMARY_MISSING", message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

function fail(state: RunState, code: string, message: string): never {
	const error = new Error(`${code}: ${message}`);
	state.violation = error;
	throw error;
}

export function createDirectorTurnLoop(options: DirectorTurnLoopOptions) {
	let active: RunState | undefined;
	let disposed = false;
	let sessionPromise: ReturnType<typeof createDirectorSession> | undefined;

	const requireActive = (): RunState => {
		if (active === undefined) throw new Error("DIRECTOR_LOOP_INACTIVE: no director turn is active");
		return active;
	};

	const bridge: DirectorTurnLoopOptions["bridge"] = {
		inspectProject: async () => {
			const state = requireActive();
			if (state.phase !== "initial" && state.phase !== "initial_inspected" && state.phase !== "primary_mutated") {
				return fail(state, "DIRECTOR_LOOP_ORDER", `inspect_project is not allowed after ${state.phase}`);
			}
			const manifest = await options.bridge.inspectProject();
			if (state.phase === "initial" && state.currentRevisionId === BOOTSTRAP_REVISION_ID) {
				state.currentRevisionId = manifest.revision;
			} else if (manifest.revision !== state.currentRevisionId) {
				return fail(
					state,
					"STALE_BASE",
					`inspect_project returned ${manifest.revision}, expected ${state.currentRevisionId}`,
				);
			}
			state.phase = state.phase === "initial" ? "initial_inspected" : "verification_inspected";
			state.toolCallOrder.push("inspect_project");
			return manifest;
		},
		stageScene: async (request, context) => {
			const state = requireActive();
			const repair = state.phase === "rendered";
			if (state.phase === "repaired") {
				return fail(state, "DIRECTOR_LOOP_REPAIR_BUDGET", "at most one repair mutation is allowed");
			}
			if (state.phase !== "initial_inspected" && !repair) {
				return fail(state, "DIRECTOR_LOOP_ORDER", `stage_scene is not allowed after ${state.phase}`);
			}
			if (request.expected_revision_id !== state.currentRevisionId) {
				return fail(state, "STALE_BASE", "stage_scene is not based on the current director revision");
			}
			const result = await options.bridge.stageScene(request, context);
			state.currentRevisionId = result.resulting_revision_id;
			state.phase = repair ? "repaired" : "primary_mutated";
			state.toolCallOrder.push("stage_scene");
			return result;
		},
		applyCameraPlan: async (plan, context) => {
			const state = requireActive();
			const repair = state.phase === "rendered";
			if (state.phase === "repaired") {
				return fail(state, "DIRECTOR_LOOP_REPAIR_BUDGET", "at most one repair mutation is allowed");
			}
			if (state.phase !== "initial_inspected" && !repair) {
				return fail(state, "DIRECTOR_LOOP_ORDER", `apply_camera_plan is not allowed after ${state.phase}`);
			}
			if (plan.expected_revision_id !== state.currentRevisionId) {
				return fail(state, "STALE_BASE", "apply_camera_plan is not based on the current director revision");
			}
			const result = await options.bridge.applyCameraPlan(plan, context);
			state.currentRevisionId = result.resulting_revision_id;
			state.phase = repair ? "repaired" : "primary_mutated";
			state.toolCallOrder.push("apply_camera_plan");
			return result;
		},
		renderQaFrames: async (request, context) => {
			const state = requireActive();
			if (state.phase !== "verification_inspected") {
				return fail(state, "DIRECTOR_LOOP_ORDER", `render_qa_frames is not allowed after ${state.phase}`);
			}
			if (request.revision_id !== state.currentRevisionId) {
				return fail(state, "STALE_BASE", "render_qa_frames is not based on the current director revision");
			}
			const result = await options.bridge.renderQaFrames(request, context);
			state.phase = "rendered";
			state.toolCallOrder.push("render_qa_frames");
			return result;
		},
	};

	const getSession = () => {
		if (sessionPromise === undefined) {
			sessionPromise = createDirectorSession({
				bridge,
				model: options.model,
				modelRuntime: options.modelRuntime,
				cwd: options.cwd,
				agentDir: options.agentDir,
			});
		}
		return sessionPromise;
	};

	return {
		async run(runOptions: DirectorTurnRunOptions): Promise<DirectorTurnResult> {
			if (disposed) throw new Error("DIRECTOR_LOOP_DISPOSED: director loop is disposed");
			if (active !== undefined) throw new Error("DIRECTOR_LOOP_BUSY: one director turn is already active");
			const session = await getSession();
			const state: RunState = {
				phase: "initial",
				currentRevisionId: runOptions.expectedRevisionId,
				toolCallOrder: [],
			};
			active = state;
			const listener = (event: AgentSessionEvent) => {
				if (event.type === "tool_execution_start" && isDirectorToolName(event.toolName)) {
					runOptions.onToolEvent?.({
						type: "started",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						paramsSummary: paramsSummary(event.toolName, event.args),
					});
				} else if (event.type === "tool_execution_end" && isDirectorToolName(event.toolName)) {
					runOptions.onToolEvent?.({
						type: "finished",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						digest: resultDigest(event.result),
						isError: event.isError,
					});
				}
			};
			const unsubscribe = session.subscribe(listener);
			const abort = () => session.abort();
			runOptions.signal.addEventListener("abort", abort, { once: true });
			try {
				if (runOptions.signal.aborted) abort();
				await session.prompt(runOptions.prompt);
				if (state.violation !== undefined) throw state.violation;
				if (state.phase !== "verification_inspected" && state.phase !== "rendered" && state.phase !== "repaired") {
					throw new DirectorLoopContractError("DIRECTOR_LOOP_INCOMPLETE", `turn ended after ${state.phase}`);
				}
				const last = session.messages.at(-1);
				if (last?.role !== "assistant")
					throw new DirectorLoopContractError("DIRECTOR_SUMMARY_MISSING", "final assistant message is required");
				const summary = assistantSummary(last);
				if (summary.length === 0)
					throw new DirectorLoopContractError("DIRECTOR_SUMMARY_MISSING", "final assistant text is required");
				return {
					summary: summary.slice(0, 8_192),
					resultingRevisionId: state.currentRevisionId,
					toolCallOrder: [...state.toolCallOrder],
				};
			} finally {
				runOptions.signal.removeEventListener("abort", abort);
				unsubscribe();
				active = undefined;
			}
		},
		dispose(): void {
			disposed = true;
			void sessionPromise?.then((session) => session.dispose());
		},
	};
}

export interface DirectorTurnHandlerOptions {
	readonly model: Model<string>;
	readonly modelRuntime: ModelRuntime;
	readonly store?: CameraPlanRevisionStore;
	readonly cwd?: string;
	readonly agentDir?: string;
}

export interface DirectorTurnHandlerContext {
	readonly signal: AbortSignal;
	inspectProject(expectedRevisionId: string): Promise<ProjectManifest>;
	applyCameraPlan(
		plan: CameraPlanV1,
		context: {
			readonly signal: AbortSignal | undefined;
			readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
		},
	): Promise<CameraPlanMutationCandidate>;
	stageScene(
		plan: StageScenePlanV1,
		context: {
			readonly signal: AbortSignal | undefined;
			readonly reportProgress: (progress: StageSceneProgress) => void;
		},
	): Promise<StageSceneMutationCandidate>;
	renderQaFrames(
		request: RenderQaFramesRequestV1,
		context: {
			readonly signal: AbortSignal | undefined;
			readonly reportProgress: (progress: RenderQaFramesProgress) => void;
		},
	): Promise<RenderQaFramesResultV1>;
	beginDurableCommit(): void;
	finishDurableCommit(): void;
}

export function createDirectorTurnHandler(options: DirectorTurnHandlerOptions) {
	const store = options.store ?? createDirectorProjectStore(options.cwd ?? process.cwd());
	let context: DirectorTurnHandlerContext | undefined;
	let expectedRevisionId: string | undefined;

	const activeContext = (): DirectorTurnHandlerContext => {
		if (context === undefined) throw new Error("DIRECTOR_LOOP_INACTIVE: no daemon bridge context is active");
		return context;
	};

	const finishCommit = async <T>(commit: (begin: () => void) => Promise<T>): Promise<T> => {
		const current = activeContext();
		let began = false;
		try {
			return await commit(() => {
				current.beginDurableCommit();
				began = true;
			});
		} finally {
			if (began) current.finishDurableCommit();
		}
	};

	const loop = createDirectorTurnLoop({
		model: options.model,
		modelRuntime: options.modelRuntime,
		cwd: options.cwd,
		agentDir: options.agentDir,
		bridge: {
			inspectProject: async () => {
				if (expectedRevisionId === undefined) {
					throw new Error("DIRECTOR_LOOP_INACTIVE: no expected revision is active");
				}
				const manifest = await activeContext().inspectProject(expectedRevisionId);
				expectedRevisionId = manifest.revision;
				return manifest;
			},
			stageScene: async (request, bridgeContext) => {
				const current = activeContext();
				const plan = canonicalizeStageScenePlan(request, randomUUID);
				const candidate = await current.stageScene(plan, bridgeContext);
				const result = await finishCommit((begin) => commitStageSceneMutation(store, plan, candidate, begin));
				expectedRevisionId = result.resulting_revision_id;
				return result;
			},
			applyCameraPlan: async (plan, bridgeContext) => {
				const current = activeContext();
				const candidate = await current.applyCameraPlan(plan, bridgeContext);
				const result = await finishCommit((begin) => commitCameraPlanMutation(store, plan, candidate, begin));
				expectedRevisionId = result.resulting_revision_id;
				return result;
			},
			renderQaFrames: async (request, bridgeContext) => {
				const result = parseRenderQaFramesResult(await activeContext().renderQaFrames(request, bridgeContext));
				if (
					result.revision_id !== request.revision_id ||
					result.frames.length !== request.frames.length ||
					result.frames.some((frame, index) => frame.frame !== request.frames[index])
				) {
					throw new Error("INVALID_RENDER_QA_RESULT: result must bind the requested revision and frames");
				}
				return result;
			},
		},
	});

	return {
		async run(
			turn: DirectorTurn,
			handlerContext: DirectorTurnHandlerContext,
			onToolEvent?: (event: DirectorTurnToolEvent) => void,
		): Promise<DirectorTurnResult> {
			if (context !== undefined) throw new Error("DIRECTOR_LOOP_BUSY: one daemon bridge context is already active");
			context = handlerContext;
			expectedRevisionId = turn.expected_revision_id;
			try {
				return await loop.run({
					prompt: turn.prompt,
					expectedRevisionId: turn.expected_revision_id,
					signal: handlerContext.signal,
					onToolEvent,
				});
			} finally {
				context = undefined;
				expectedRevisionId = undefined;
			}
		},
		dispose(): void {
			loop.dispose();
		},
	};
}
