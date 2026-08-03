import { createHash, randomUUID } from "node:crypto";
import type {
	ApplyCameraPlanBridge,
	ApplyCameraPlanProgress,
	ExecuteBlenderPythonBridge,
	InspectProjectBridge,
	ProjectManifest,
	RenderQaFramesBridge,
	RenderQaFramesProgress,
	StageSceneBridge,
	StageSceneProgress,
} from "@cclay/blender-tools";
import type { TransactionMarkerPhase } from "@cclay/director-core";
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
} from "@cclay/protocol";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type CameraPlanRevisionStore,
	commitCameraPlanMutation,
	createDirectorProjectStore,
	type PreparedMutationCandidate,
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
export type DirectorTurnPublication =
	| {
			readonly type: "text_delta";
			readonly turnId: string;
			readonly segmentId: string;
			readonly contentIndex: number;
			readonly deltaSequence: number;
			readonly delta: string;
	  }
	| {
			readonly type: "assistant_utterance";
			readonly turnId: string;
			readonly segmentId: string;
			readonly contentIndex: number;
			readonly throughDeltaSequence: number;
			readonly content: string;
	  }
	| DirectorTurnToolEvent;

/**
 * Per-turn publication boundary consumed by the daemon. A returned promise is
 * the ordering barrier for persistence and broadcast; the loop never invokes a
 * later callback or settles the turn before it resolves.
 */
export type DirectorTurnPublicationCallback = (publication: DirectorTurnPublication) => Promise<void> | void;

/**
 * Fixed failure raised when the daemon's publication callback rejects. The
 * callback owns persistence-health state; this error deliberately omits the
 * rejected value so provider or transcript bytes cannot cross the boundary.
 */
export class DirectorTurnPublicationError extends Error {
	readonly code = "DIRECTOR_PUBLICATION_FAILED";

	constructor() {
		super("DIRECTOR_PUBLICATION_FAILED: director event publication failed");
	}
}

export interface DirectorTurnLoopOptions {
	readonly bridge: InspectProjectBridge &
		ApplyCameraPlanBridge &
		RenderQaFramesBridge &
		StageSceneBridge &
		Partial<ExecuteBlenderPythonBridge>;
	readonly model: Model<string>;
	readonly modelRuntime: ModelRuntime;
	readonly cwd?: string;
	readonly agentDir?: string;
	readonly projectStore?: Pick<CameraPlanRevisionStore, "readProject">;
}

export interface DirectorTurnRunOptions {
	readonly turnId: string;
	readonly prompt: string;
	readonly expectedRevisionId: string;
	readonly signal: AbortSignal;
	readonly onPublication?: DirectorTurnPublicationCallback;
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
	"execute_blender_python",
	"render_qa_frames",
]);
const BOOTSTRAP_REVISION_ID = "0".repeat(64);
const STREAM_DELTA_FLUSH_MS = 50;
const STREAM_DELTA_FLUSH_BYTES = 2_048;
const STREAM_DELTA_MAX_BYTES = 4_096;
const STREAM_UTTERANCE_MAX_BYTES = 16_384;
const STREAM_UTTERANCE_MAX_COUNT = 32;
const STREAM_CONTENT_INDEX_MAX = 31;
const STREAM_DELTA_SEQUENCE_MAX = 1_000_000;

function takeUtf8Prefix(value: string, maxBytes: number): readonly [string, string] {
	let bytes = 0;
	let end = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character);
		if (bytes + characterBytes > maxBytes) break;
		bytes += characterBytes;
		end += character.length;
	}
	return [value.slice(0, end), value.slice(end)];
}

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
		...(options.bridge.executeBlenderPython === undefined
			? {}
			: {
					executeBlenderPython: async (request) => {
						const state = requireActive();
						const repair = state.phase === "rendered";
						if (state.phase === "repaired") {
							return fail(state, "DIRECTOR_LOOP_REPAIR_BUDGET", "at most one repair mutation is allowed");
						}
						if (state.phase !== "initial_inspected" && !repair) {
							return fail(
								state,
								"DIRECTOR_LOOP_ORDER",
								`execute_blender_python is not allowed after ${state.phase}`,
							);
						}
						if (request.expected_revision_id !== state.currentRevisionId) {
							return fail(
								state,
								"STALE_BASE",
								"execute_blender_python is not based on the current director revision",
							);
						}
						const result = await options.bridge.executeBlenderPython!(request);
						if (result.type === "execute_result" && result.outcome === "success") {
							state.currentRevisionId = result.new_revision_id;
							state.phase = repair ? "repaired" : "primary_mutated";
						} else if (result.type === "execute_result" && result.outcome === "failed_recovered") {
							if (result.restored_revision_id !== state.currentRevisionId) {
								return fail(
									state,
									"EXECUTION_RECOVERY_MISMATCH",
									"recovered execution restored an unexpected revision",
								);
							}
						} else if (result.type === "execute_result") {
							return fail(state, "EXECUTION_OUTCOME_UNKNOWN", "Blender execution outcome requires recovery");
						}
						state.toolCallOrder.push("execute_blender_python");
						return result;
					},
				}),
		renderQaFrames: async (request, context) => {
			const state = requireActive();
			if (state.phase !== "verification_inspected") {
				return fail(state, "DIRECTOR_LOOP_ORDER", `render_qa_frames is not allowed after ${state.phase}`);
			}
			if (request.expected_revision_id !== state.currentRevisionId) {
				return fail(state, "STALE_BASE", "render_qa_frames is not based on the current director revision");
			}
			const result = await options.bridge.renderQaFrames(request, context);
			state.phase = "rendered";
			state.toolCallOrder.push("render_qa_frames");
			return result;
		},
	};

	const SESSION_IDLE_TIMEOUT_MS = 4_000;

	const getSession = () => {
		if (sessionPromise === undefined) {
			const createSession = (allowExecuteBlenderPython: boolean) =>
				createDirectorSession({
					bridge,
					model: options.model,
					modelRuntime: options.modelRuntime,
					cwd: options.cwd,
					agentDir: options.agentDir,
					allowExecuteBlenderPython,
				});
			sessionPromise =
				options.projectStore === undefined
					? createSession(true)
					: options.projectStore
							.readProject()
							.then((project) => createSession(project.allowExecuteBlenderPython !== false));
		}
		return sessionPromise;
	};
	const resetSession = (session: Awaited<ReturnType<typeof createDirectorSession>>) => {
		if (sessionPromise === undefined) return;
		const cached = sessionPromise;
		sessionPromise = undefined;
		// Recreating the session drops in-model conversation context. The daemon's
		// durable transcript remains the source of truth across this recovery.
		void cached.then((value) => {
			if (value === session) value.dispose();
		});
	};
	// Historical QA frame images are re-uploaded to the provider on every model
	// step of every later turn while adding no directing signal (the durable
	// artifact store keeps the originals). Replace them with digest placeholders
	// before each new turn; images produced during the current turn stay intact
	// for in-turn repair decisions.
	const pruneHistoricalQaFrameImages = (session: Awaited<ReturnType<typeof createDirectorSession>>) => {
		for (const message of session.messages) {
			if (message.role !== "toolResult") continue;
			if (!Array.isArray(message.content)) continue;
			if (!message.content.some((block) => block.type === "image")) continue;
			message.content = message.content.map((block) =>
				block.type === "image"
					? {
							type: "text" as const,
							text: `[QA frame image pruned from context; sha256 ${createHash("sha256")
								.update(Buffer.from(block.data, "base64"))
								.digest("hex")}]`,
						}
					: block,
			);
		}
	};

	let abandonActive: (() => void) | undefined;
	return {
		async getActiveToolNames() {
			return (await getSession()).getActiveToolNames();
		},
		async run(runOptions: DirectorTurnRunOptions): Promise<DirectorTurnResult> {
			if (disposed) throw new Error("DIRECTOR_LOOP_DISPOSED: director loop is disposed");
			if (active !== undefined) throw new Error("DIRECTOR_LOOP_BUSY: one director turn is already active");
			const state: RunState = {
				phase: "initial",
				currentRevisionId: runOptions.expectedRevisionId,
				toolCallOrder: [],
			};
			active = state;
			let session: Awaited<ReturnType<typeof createDirectorSession>>;
			try {
				session = await getSession();
			} catch (error) {
				active = undefined;
				throw error;
			}
			pruneHistoricalQaFrameImages(session);
			type TextPublicationState = {
				readonly segmentId: string;
				readonly contentIndex: number;
				pending: string;
				nextDeltaSequence: number;
				throughDeltaSequence: number;
				timer: ReturnType<typeof setTimeout> | undefined;
			};
			const textStates = new Map<number, TextPublicationState>();
			let segmentId: string | undefined;
			let utteranceCount = 0;
			let publicationsStopped = false;
			let publicationFailure: DirectorTurnPublicationError | undefined;
			let streamContractFailure: Error | undefined;
			let publicationTail = Promise.resolve();

			const discardUnsealedText = () => {
				for (const textState of textStates.values()) {
					if (textState.timer !== undefined) clearTimeout(textState.timer);
					textState.pending = "";
				}
				textStates.clear();
			};
			const stopPublications = () => {
				if (publicationsStopped) return;
				publicationsStopped = true;
				discardUnsealedText();
			};
			const publish = (publication: DirectorTurnPublication) => {
				if (runOptions.onPublication === undefined || publicationsStopped) return;
				publicationTail = publicationTail.then(async () => {
					if (publicationsStopped) return;
					try {
						await runOptions.onPublication?.(publication);
					} catch {
						if (publicationFailure === undefined) publicationFailure = new DirectorTurnPublicationError();
						stopPublications();
						void session.abort();
					}
				});
			};
			const failStreamContract = (message: string) => {
				if (streamContractFailure === undefined) {
					streamContractFailure = new Error(`DIRECTOR_STREAM_INVALID: ${message}`);
				}
				stopPublications();
				void session.abort();
			};
			const getTextState = (contentIndex: number): TextPublicationState | undefined => {
				if (!Number.isInteger(contentIndex) || contentIndex < 0 || contentIndex > STREAM_CONTENT_INDEX_MAX) {
					failStreamContract("assistant text content index is out of range");
					return undefined;
				}
				let textState = textStates.get(contentIndex);
				if (textState !== undefined) return textState;
				segmentId ??= randomUUID();
				textState = {
					segmentId,
					contentIndex,
					pending: "",
					nextDeltaSequence: 0,
					throughDeltaSequence: -1,
					timer: undefined,
				};
				textStates.set(contentIndex, textState);
				return textState;
			};
			const flushTextState = (textState: TextPublicationState) => {
				if (textState.timer !== undefined) {
					clearTimeout(textState.timer);
					textState.timer = undefined;
				}
				while (!publicationsStopped && textState.pending.length > 0) {
					if (textState.nextDeltaSequence > STREAM_DELTA_SEQUENCE_MAX) {
						failStreamContract("assistant delta sequence exceeds the turn bound");
						return;
					}
					const [delta, remaining] = takeUtf8Prefix(textState.pending, STREAM_DELTA_MAX_BYTES);
					if (delta.length === 0) {
						failStreamContract("assistant text delta cannot be encoded within the frame bound");
						return;
					}
					textState.pending = remaining;
					const deltaSequence = textState.nextDeltaSequence;
					textState.nextDeltaSequence += 1;
					textState.throughDeltaSequence = deltaSequence;
					publish({
						type: "text_delta",
						turnId: runOptions.turnId,
						segmentId: textState.segmentId,
						contentIndex: textState.contentIndex,
						deltaSequence,
						delta,
					});
				}
			};
			const appendTextDelta = (contentIndex: number, delta: string) => {
				if (publicationsStopped || delta.length === 0 || runOptions.onPublication === undefined) return;
				const textState = getTextState(contentIndex);
				if (textState === undefined) return;
				textState.pending += delta;
				if (textState.timer === undefined) {
					textState.timer = setTimeout(() => {
						if (!publicationsStopped) flushTextState(textState);
					}, STREAM_DELTA_FLUSH_MS);
				}
				if (Buffer.byteLength(textState.pending) >= STREAM_DELTA_FLUSH_BYTES) flushTextState(textState);
			};
			const sealText = (contentIndex: number, content: string) => {
				if (publicationsStopped || runOptions.onPublication === undefined) return;
				const textState = getTextState(contentIndex);
				if (textState === undefined) return;
				flushTextState(textState);
				textStates.delete(contentIndex);
				if (content.length === 0) {
					if (textState.throughDeltaSequence >= 0) {
						failStreamContract("an emitted assistant delta ended without an utterance");
					}
					return;
				}
				if (Buffer.byteLength(content) > STREAM_UTTERANCE_MAX_BYTES) {
					failStreamContract("assistant utterance exceeds the byte bound");
					return;
				}
				utteranceCount += 1;
				if (utteranceCount > STREAM_UTTERANCE_MAX_COUNT) {
					failStreamContract("assistant utterance count exceeds the turn bound");
					return;
				}
				publish({
					type: "assistant_utterance",
					turnId: runOptions.turnId,
					segmentId: textState.segmentId,
					contentIndex,
					throughDeltaSequence: textState.throughDeltaSequence,
					content,
				});
			};
			const closeSegmentForTool = () => {
				if (textStates.size > 0) {
					failStreamContract("tool execution started before every assistant utterance was sealed");
					return false;
				}
				segmentId = undefined;
				return true;
			};
			const listener = (event: AgentSessionEvent) => {
				if (publicationsStopped) return;
				if (event.type === "message_update") {
					const assistantEvent = event.assistantMessageEvent;
					if (assistantEvent.type === "text_delta") {
						appendTextDelta(assistantEvent.contentIndex, assistantEvent.delta);
					} else if (assistantEvent.type === "text_end") {
						sealText(assistantEvent.contentIndex, assistantEvent.content);
					}
					return;
				}
				if (event.type === "tool_execution_start" && isDirectorToolName(event.toolName)) {
					if (!closeSegmentForTool()) return;
					publish({
						type: "started",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						paramsSummary: paramsSummary(event.toolName, event.args),
					});
				} else if (event.type === "tool_execution_end" && isDirectorToolName(event.toolName)) {
					publish({
						type: "finished",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						digest: resultDigest(event.result),
						isError: event.isError,
					});
				}
			};
			const unsubscribe = session.subscribe(listener);
			const abort = () => {
				stopPublications();
				void session.abort();
			};
			let cleanedUp = false;
			const cleanup = () => {
				if (cleanedUp) return;
				cleanedUp = true;
				stopPublications();
				runOptions.signal.removeEventListener("abort", abort);
				unsubscribe();
				if (active === state) active = undefined;
			};
			abandonActive = cleanup;
			runOptions.signal.addEventListener("abort", abort, { once: true });
			let idleReached = false;
			try {
				if (runOptions.signal.aborted) abort();
				let promptError: unknown;
				try {
					await session.prompt(runOptions.prompt);
				} catch (error) {
					promptError = error;
					discardUnsealedText();
				}
				if (promptError === undefined && textStates.size > 0) {
					failStreamContract("assistant response ended before every utterance was sealed");
				}
				await publicationTail;
				if (publicationFailure !== undefined) throw publicationFailure;
				if (streamContractFailure !== undefined) throw streamContractFailure;
				if (promptError !== undefined) throw promptError;
				// A cancelled turn must reject even when the provider stream
				// settled cleanly before the abort was observed; previously the
				// strict phase contract rejected these runs by accident.
				if (runOptions.signal.aborted) {
					throw new DOMException("The operation was aborted.", "AbortError");
				}
				if (state.violation !== undefined) throw state.violation;
				// The safety invariant is "every mutation is verified", not "every
				// turn inspects twice": chat-only ("initial") and read-only
				// ("initial_inspected") turns may end without a verification
				// inspect because nothing changed. A turn that mutated
				// ("primary_mutated") still fails closed here.
				if (
					state.phase !== "initial" &&
					state.phase !== "initial_inspected" &&
					state.phase !== "verification_inspected" &&
					state.phase !== "rendered" &&
					state.phase !== "repaired"
				) {
					throw new DirectorLoopContractError("DIRECTOR_LOOP_INCOMPLETE", `turn ended after ${state.phase}`);
				}
				const last = session.messages.at(-1);
				if (last?.role !== "assistant")
					throw new DirectorLoopContractError("DIRECTOR_SUMMARY_MISSING", "final assistant message is required");
				const summary = assistantSummary(last);
				if (summary.length === 0)
					throw new DirectorLoopContractError("DIRECTOR_SUMMARY_MISSING", "final assistant text is required");
				stopPublications();
				return {
					summary: summary.slice(0, 8_192),
					resultingRevisionId: state.currentRevisionId,
					toolCallOrder: [...state.toolCallOrder],
				};
			} finally {
				let idleTimeout: ReturnType<typeof setTimeout> | undefined;
				const abortResult = await Promise.race([
					session.abort().then(
						() => true,
						() => false,
					),
					new Promise<false>((resolve) => {
						idleTimeout = setTimeout(() => resolve(false), SESSION_IDLE_TIMEOUT_MS);
					}),
				]);
				if (idleTimeout !== undefined) clearTimeout(idleTimeout);
				idleReached = abortResult && !session.isStreaming;
				if (!idleReached) resetSession(session);
				cleanup();
				if (abandonActive === cleanup) abandonActive = undefined;
			}
		},
		dispose(): void {
			disposed = true;
			abandonActive?.();
			abandonActive = undefined;
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
	): Promise<PreparedMutationCandidate<CameraPlanMutationCandidate>>;
	stageScene(
		plan: StageScenePlanV1,
		context: {
			readonly signal: AbortSignal | undefined;
			readonly reportProgress: (progress: StageSceneProgress) => void;
		},
	): Promise<PreparedMutationCandidate<StageSceneMutationCandidate>>;
	renderQaFrames(
		request: RenderQaFramesRequestV1,
		context: {
			readonly signal: AbortSignal | undefined;
			readonly reportProgress: (progress: RenderQaFramesProgress) => void;
		},
	): Promise<RenderQaFramesResultV1>;
	executeBlenderPython(
		request: Parameters<ExecuteBlenderPythonBridge["executeBlenderPython"]>[0],
	): ReturnType<ExecuteBlenderPythonBridge["executeBlenderPython"]>;
	beginDurableCommit(): void;
	finishDurableCommit(): Promise<void> | void;
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
		const result = await commit(() => {
			current.beginDurableCommit();
			began = true;
		});
		if (began) await current.finishDurableCommit();
		return result;
	};

	const loop = createDirectorTurnLoop({
		model: options.model,
		modelRuntime: options.modelRuntime,
		cwd: options.cwd,
		agentDir: options.agentDir,
		projectStore: store,
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
			executeBlenderPython: async (request) => {
				const result = await activeContext().executeBlenderPython(request);
				if (result.type === "execute_result" && result.outcome === "success") {
					expectedRevisionId = result.new_revision_id;
				}
				return result;
			},
			renderQaFrames: async (request, bridgeContext) => {
				const result = parseRenderQaFramesResult(await activeContext().renderQaFrames(request, bridgeContext));
				if (
					result.expected_revision_id !== request.expected_revision_id ||
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
			onPublication?: DirectorTurnPublicationCallback,
		): Promise<DirectorTurnResult> {
			if (context !== undefined) throw new Error("DIRECTOR_LOOP_BUSY: one daemon bridge context is already active");
			context = handlerContext;
			expectedRevisionId = turn.expected_revision_id;
			try {
				return await loop.run({
					turnId: turn.id,
					prompt: turn.prompt,
					expectedRevisionId: turn.expected_revision_id,
					signal: handlerContext.signal,
					onPublication,
				});
			} finally {
				context = undefined;
				expectedRevisionId = undefined;
			}
		},
		dispose(): void {
			loop.dispose();
		},
		forceDispose() {
			loop.dispose();
			return createDirectorTurnHandler(options);
		},
		async reconcileTransaction(transactionId: string, markerPhase: TransactionMarkerPhase) {
			return store.reconcileRevision(transactionId, markerPhase);
		},
	};
}
