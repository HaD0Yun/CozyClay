import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import {
	DIRECTOR_TRANSCRIPT_CAPABILITY,
	DIRECTOR_TURN_CAPABILITY,
	MUTATION_PROTOCOL_VERSION,
	MUTATION_BRIDGE_CAPABILITY,
	MutationBridgeSession,
	negotiateMutationBridge,
	parseAddonBridgeMessage,
	parseClientMessage,
	parseDirectorTurnEvent,
	parseDaemonBridgeMessage,
	parseHello,
	parseRenderQaFramesRequest,
	parseSceneSnapshot,
	parseStartupRecord,
	PROTOCOL_VERSION,
	SCENE_MANIFEST_V3_CAPABILITY,
	type BridgeArtifactBegin,
	type BridgeArtifactBatchBegin,
	type BridgeArtifactChunk,
	type DirectorToolName,
	type DirectorTurn,
	type CameraPlanV1,
	type CameraPlanMutationCandidate,
	type RenderQaFramesRequestV1,
	type RenderQaFramesResultV1,
	type Request,
	type SceneSnapshot,
	type StageSceneMutationCandidate,
	type StageScenePlanV1,
} from "@oh-my-blender/protocol";
import { DirectorLoopContractError } from "@oh-my-blender/director-runtime";
import {
	AttachTicketBroker,
	ControllerCredential,
	createRuntimeAdvertisement,
	type ClientRole,
} from "./control-plane.ts";
import { DirectorTranscriptStore } from "./transcript-store.ts";
import { SessionState, type ActiveRequest } from "./session-state.ts";
import { BearerToken, randomNonce, systemClock, type Clock } from "./token.ts";
import { acceptUpgrade, readClientRole, type WebSocketConnection } from "./ws-server.ts";

export type HandlerResult = { result: unknown; resulting_revision_id: string };
export interface ApplyCameraPlanProgress {
	readonly phase: string;
	readonly completed: number;
	readonly total: number;
}
export type ApplyCameraPlan = (
	plan: CameraPlanV1,
	context: {
		readonly signal: AbortSignal | undefined;
		readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
	},
) => Promise<CameraPlanMutationCandidate>;
export type StageScene = (
	plan: StageScenePlanV1,
	context: {
		readonly signal: AbortSignal | undefined;
		readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
	},
) => Promise<StageSceneMutationCandidate>;
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
export interface DirectorTurnContext {
	readonly signal: AbortSignal;
	inspectProject(expectedRevisionId: string): Promise<{ readonly revision: string; readonly snapshot: SceneSnapshot }>;
	readonly applyCameraPlan: ApplyCameraPlan;
	readonly stageScene: StageScene;
	readonly renderQaFrames: RenderQaFrames;
	beginDurableCommit(): void;
	finishDurableCommit(): void;
}
export interface DirectorTurnService {
	run(
		turn: DirectorTurn,
		context: DirectorTurnContext,
		onToolEvent: (event: DirectorTurnToolEvent) => void,
	): Promise<{
		readonly summary: string;
		readonly resultingRevisionId: string;
		readonly toolCallOrder: readonly DirectorToolName[];
	}>;
	dispose(): void;
	forceDispose(): DirectorTurnService;
}
export interface HandlerContext {
	readonly signal: AbortSignal;
	readonly request: Request;
	readonly reportProgress: (phase: string, completed: number, total: number) => void;
	readonly applyCameraPlan: ApplyCameraPlan;
	readonly stageScene: StageScene;
	readonly renderQaFrames: RenderQaFrames;
	readonly beginDurableCommit: () => void;
}
export type Handler = (params: Record<string, unknown>, context: HandlerContext) => Promise<HandlerResult>;
export interface RenderArtifactDeclaration {
	readonly sha256: string;
	readonly byteLength: number;
}
export interface RenderArtifactDescriptor {
	readonly sha256: string;
	readonly byteLength: number;
	readonly uri: string;
}
export interface RenderArtifactReservation {
	writeAt(position: number, chunk: Uint8Array): Promise<void>;
	commit(): Promise<RenderArtifactDescriptor>;
	abort(): Promise<void>;
}
export type BeginArtifactReservation = (
	artifact: RenderArtifactDeclaration,
) => Promise<RenderArtifactReservation>;
export type BeginArtifactReservations = (
	artifacts: readonly RenderArtifactDeclaration[],
) => Promise<readonly RenderArtifactReservation[]>;
export type RenderQaFrames = (
	request: RenderQaFramesRequestV1,
	context: {
		readonly signal: AbortSignal | undefined;
		readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
	},
) => Promise<RenderQaFramesResultV1>;

export type DaemonOptions = {
	port: number;
	clock?: Clock;
	handlers: Record<string, Handler>;
	directorTurn?: DirectorTurnService;
	projectDirectory?: string;
	beginArtifactReservation?: BeginArtifactReservation;
	beginArtifactReservations?: BeginArtifactReservations;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	helloTimeoutMs?: number;
	idleTimeoutMs?: number;
	attachTicketTtlMs?: number;
	directorTeardownTimeoutMs?: number;
	runtimeBaseDirectory?: string;
};
export type Daemon = {
	port: number;
	startup: ReturnType<typeof parseStartupRecord>;
	runtimeDirectory: string;
	stopped: Promise<void>;
	close(): Promise<void>;
};

type PendingArtifactChunk = {
	readonly offset: number;
	readonly byteLength: number;
};
type PendingArtifactFrame = {
	readonly totalChunks: number;
	readonly totalByteLength: number;
	readonly sha256: string;
	readonly reservation: RenderArtifactReservation;
	readonly chunks: Map<number, PendingArtifactChunk>;
	receivedBytes: number;
};

type PendingBridge = {
	readonly id: string;
	readonly requestId: string;
	readonly method: "inspect_project" | "apply_camera_plan" | "stage_scene" | "render_qa_frames";
	readonly renderRequest?: RenderQaFramesRequestV1;
	readonly artifactFrames: Map<number, PendingArtifactFrame>;
	totalArtifactBytes: number;
	artifactCleanup?: Promise<void>;
	artifactSetup?: Promise<void>;
	cancelled?: boolean;
	quarantined?: boolean;
	readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
	readonly beginArtifactCommit?: () => void;
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	removeAbortListener(): void;
};
type RetiredBridge = {
	readonly pending: PendingBridge;
	readonly artifactCleanup: Promise<void>;
	readonly retirementTimer: ReturnType<typeof setTimeout>;
};

const RETIRED_BRIDGE_TTL_MS = 30_000;

const MAX_RENDER_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_RENDER_BATCH_BYTES = 128 * 1024 * 1024;
const MAX_QA_IMAGE_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_QA_IMAGE_BATCH_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";
const MAX_BRIDGE_MESSAGE_BYTES = 18 * 1024 * 1024;
const BOOTSTRAP_REVISION_ID = "0".repeat(64);
const TRUSTED_DIRECTOR_FAILURE_MESSAGES = {
	ARTIFACT_STORE_UNAVAILABLE: "artifact store unavailable",
	BLENDER_UNAVAILABLE: "Blender bridge unavailable",
	BUSY: "bridge is busy",
	CAPABILITY_NOT_NEGOTIATED: "required bridge capability was not negotiated",
	DURABLE_BASE_UNAVAILABLE: "durable bridge base unavailable",
	DIRECTOR_LOOP_INCOMPLETE: "director turn ended before its verification inspect",
	DIRECTOR_SUMMARY_MISSING: "director turn ended without a final summary",
	DURABLE_COMMIT_STATE: "durable commit state invalid",
	INSPECT_BRIDGE_UNAVAILABLE: "inspection bridge unavailable",
	INVALID_ARTIFACT_DESCRIPTOR: "artifact descriptor invalid",
	INVALID_BRIDGE_MESSAGE: "bridge message invalid",
	INVALID_INSPECT_RESULT: "inspection result invalid",
	INVALID_RENDER_QA_RESULT: "render QA result invalid",
	METHOD_NOT_SUPPORTED: "bridge method not supported",
	MUTATION_BRIDGE_UNAVAILABLE: "mutation bridge unavailable",
	RECOVERY_REQUIRED: "bridge recovery required",
	RENDER_BRIDGE_UNAVAILABLE: "render bridge unavailable",
	RENDER_QA_BATCH_BYTES_EXCEEDED: "render QA batch exceeds its byte limit",
	RENDER_QA_FRAME_BYTES_EXCEEDED: "render QA frame exceeds its byte limit",
	RENDER_QA_IMAGE_CONTENT_LIMIT: "render QA image content exceeds its byte limit",
	STALE_BASE: "expected revision is stale",
} as const;

class TrustedDirectorFailure extends Error {
	readonly code: keyof typeof TRUSTED_DIRECTOR_FAILURE_MESSAGES;

	constructor(code: keyof typeof TRUSTED_DIRECTOR_FAILURE_MESSAGES) {
		super(TRUSTED_DIRECTOR_FAILURE_MESSAGES[code]);
		this.code = code;
	}
}

function rethrowTrustedDirectorFailure(cause: unknown): never {
	const message = cause instanceof Error ? cause.message : "";
	const parsed = /^([A-Z][A-Z0-9_]+):/.exec(message);
	const code = parsed?.[1];
	if (code !== undefined && Object.hasOwn(TRUSTED_DIRECTOR_FAILURE_MESSAGES, code)) {
		throw new TrustedDirectorFailure(code as keyof typeof TRUSTED_DIRECTOR_FAILURE_MESSAGES);
	}
	throw cause;
}

async function runTrustedDirectorTool<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (cause) {
		rethrowTrustedDirectorFailure(cause);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function beginArtifactFrame(
	pending: PendingBridge,
	begin: BridgeArtifactBegin,
	beginReservation: BeginArtifactReservation | undefined,
): Promise<void> {
	if (
		pending.method !== "render_qa_frames" ||
		pending.renderRequest === undefined ||
		beginReservation === undefined
	) {
		throw new Error("ARTIFACT_STORE_UNAVAILABLE: artifact declarations require render_qa_frames");
	}
	if (!pending.renderRequest.frames.includes(begin.frame)) {
		throw new Error("INVALID_RENDER_QA_RESULT: artifact declaration frame was not requested");
	}
	if (pending.artifactFrames.has(begin.frame)) {
		throw new Error("INVALID_RENDER_QA_RESULT: duplicate artifact declaration");
	}
	if (begin.total_byte_length > MAX_RENDER_FRAME_BYTES) {
		throw new Error("RENDER_QA_FRAME_BYTES_EXCEEDED: declared artifact exceeds 16 MiB");
	}
	if (pending.totalArtifactBytes + begin.total_byte_length > MAX_RENDER_BATCH_BYTES) {
		throw new Error("RENDER_QA_BATCH_BYTES_EXCEEDED: declared artifacts exceed 128 MiB");
	}
	const reservation = await beginReservation({
		sha256: begin.sha256,
		byteLength: begin.total_byte_length,
	});
	if (pending.cancelled) {
		if (pending.quarantined) {
			void reservation.abort().catch(() => undefined);
		} else {
			await reservation.abort();
		}
		throw new Error("CANCELLED: artifact reservation completed after cancellation");
	}
	pending.artifactFrames.set(begin.frame, {
		totalChunks: begin.total_chunks,
		totalByteLength: begin.total_byte_length,
		sha256: begin.sha256,
		reservation,
		chunks: new Map(),
		receivedBytes: 0,
	});
	pending.totalArtifactBytes += begin.total_byte_length;
}

async function beginArtifactBatch(
	pending: PendingBridge,
	begin: BridgeArtifactBatchBegin,
	beginReservations: BeginArtifactReservations | undefined,
): Promise<void> {
	if (
		pending.method !== "render_qa_frames" ||
		pending.renderRequest === undefined ||
		beginReservations === undefined
	) {
		throw new Error("ARTIFACT_STORE_UNAVAILABLE: artifact batch declarations require render_qa_frames");
	}
	if (
		pending.artifactFrames.size !== 0 ||
		begin.frames.length !== pending.renderRequest.frames.length ||
		begin.frames.some((frame, index) => frame.frame !== pending.renderRequest?.frames[index])
	) {
		throw new Error("INVALID_RENDER_QA_RESULT: artifact batch must exactly match requested frames");
	}
	let totalBytes = 0;
	for (const frame of begin.frames) {
		if (frame.total_byte_length > MAX_RENDER_FRAME_BYTES) {
			throw new Error("RENDER_QA_FRAME_BYTES_EXCEEDED: declared artifact exceeds 16 MiB");
		}
		totalBytes += frame.total_byte_length;
	}
	if (totalBytes > MAX_RENDER_BATCH_BYTES) {
		throw new Error("RENDER_QA_BATCH_BYTES_EXCEEDED: declared artifacts exceed 128 MiB");
	}
	const reservations = await beginReservations(
		begin.frames.map((frame) => ({ sha256: frame.sha256, byteLength: frame.total_byte_length })),
	);
	if (pending.cancelled) {
		const aborts = reservations.map((reservation) => reservation.abort());
		if (pending.quarantined) {
			for (const abort of aborts) void abort.catch(() => undefined);
		} else {
			await Promise.allSettled(aborts);
		}
		throw new Error("CANCELLED: artifact reservation batch completed after cancellation");
	}
	if (reservations.length !== begin.frames.length) {
		await Promise.allSettled(reservations.map((reservation) => reservation.abort()));
		throw new Error("ARTIFACT_STORE_UNAVAILABLE: reservation batch length is invalid");
	}
	for (const [index, frame] of begin.frames.entries()) {
		pending.artifactFrames.set(frame.frame, {
			totalChunks: frame.total_chunks,
			totalByteLength: frame.total_byte_length,
			sha256: frame.sha256,
			reservation: reservations[index]!,
			chunks: new Map(),
			receivedBytes: 0,
		});
	}
	pending.totalArtifactBytes = totalBytes;
}

async function recordArtifactChunk(pending: PendingBridge, chunk: BridgeArtifactChunk): Promise<void> {
	if (pending.method !== "render_qa_frames" || pending.renderRequest === undefined) {
		throw new Error("INVALID_BRIDGE_MESSAGE: artifact chunks require render_qa_frames");
	}
	const frame = pending.artifactFrames.get(chunk.frame);
	if (frame === undefined) {
		throw new Error("INVALID_RENDER_QA_RESULT: artifact chunk arrived before its declaration");
	}
	if (frame.totalChunks !== chunk.total_chunks) {
		throw new Error("INVALID_RENDER_QA_RESULT: artifact total_chunks changed mid-stream");
	}
	if (frame.chunks.has(chunk.chunk_index)) {
		throw new Error("INVALID_RENDER_QA_RESULT: duplicate artifact chunk index");
	}
	const bytes = Buffer.from(chunk.data_base64, "base64");
	if (bytes.toString("base64") !== chunk.data_base64 || bytes.byteLength !== chunk.byte_length) {
		throw new Error("INVALID_RENDER_QA_RESULT: artifact chunk base64 or byte length is invalid");
	}
	const end = chunk.byte_offset + bytes.byteLength;
	if (end > frame.totalByteLength) {
		throw new Error("INVALID_RENDER_QA_RESULT: artifact chunk exceeds its declared byte length");
	}
	for (const recorded of frame.chunks.values()) {
		const recordedEnd = recorded.offset + recorded.byteLength;
		if (chunk.byte_offset < recordedEnd && recorded.offset < end) {
			throw new Error("INVALID_RENDER_QA_RESULT: artifact chunk byte ranges overlap");
		}
	}
	await frame.reservation.writeAt(chunk.byte_offset, bytes);
	if (pending.quarantined) return;
	frame.chunks.set(chunk.chunk_index, { offset: chunk.byte_offset, byteLength: bytes.byteLength });
	frame.receivedBytes += bytes.byteLength;
}

async function abortArtifactFrames(pending: PendingBridge): Promise<void> {
	const frames = Array.from(pending.artifactFrames.values());
	pending.artifactFrames.clear();
	await Promise.allSettled(frames.map((frame) => frame.reservation.abort()));
}

async function finalizeRenderResult(pending: PendingBridge, raw: unknown): Promise<RenderQaFramesResultV1> {
	if (pending.renderRequest === undefined || pending.beginArtifactCommit === undefined) {
		throw new Error("ARTIFACT_STORE_UNAVAILABLE: render artifact publication is unavailable");
	}
	if (
		!isRecord(raw) ||
		!hasExactKeys(raw, ["frames", "profile_version", "revision_id", "schema_version"]) ||
		raw.schema_version !== 1 ||
		raw.revision_id !== pending.renderRequest.revision_id ||
		raw.profile_version !== "omb-qa-png-v1" ||
		!Array.isArray(raw.frames) ||
		raw.frames.length !== pending.renderRequest.frames.length
	) {
		throw new Error("INVALID_RENDER_QA_RESULT: final bridge metadata is invalid");
	}
	const candidates: Array<{
		readonly frame: number;
		readonly byteLength: number;
		readonly sha256: string;
		readonly reservation: RenderArtifactReservation;
		readonly image: { readonly mime_type: "image/png"; readonly data_base64: string };
	}> = [];
	let totalImageBytes = 0;
	for (const [index, expectedFrame] of pending.renderRequest.frames.entries()) {
		const metadata = raw.frames[index];
		if (
			!isRecord(metadata) ||
			!hasExactKeys(metadata, ["byte_length", "frame", "height", "image", "profile_version", "sha256", "width"]) ||
			metadata.frame !== expectedFrame ||
			metadata.width !== 640 ||
			metadata.height !== 360 ||
			metadata.profile_version !== "omb-qa-png-v1" ||
			!Number.isSafeInteger(metadata.byte_length) ||
			(metadata.byte_length as number) <= 0 ||
			(metadata.byte_length as number) > MAX_RENDER_FRAME_BYTES ||
			typeof metadata.sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(metadata.sha256)
		) {
			throw new Error("INVALID_RENDER_QA_RESULT: frame metadata is invalid");
		}
		const image = metadata.image;
		if (
			!isRecord(image) ||
			!hasExactKeys(image, ["data_base64", "mime_type"]) ||
			image.mime_type !== "image/png" ||
			typeof image.data_base64 !== "string"
		) {
			throw new Error("INVALID_RENDER_QA_RESULT: frame image content is invalid");
		}
		const imageBytes = Buffer.from(image.data_base64, "base64");
		if (imageBytes.toString("base64") !== image.data_base64) {
			throw new Error("INVALID_RENDER_QA_RESULT: frame image base64 is not canonical");
		}
		totalImageBytes += imageBytes.byteLength;
		if (
			imageBytes.byteLength > MAX_QA_IMAGE_FRAME_BYTES ||
			totalImageBytes > MAX_QA_IMAGE_BATCH_BYTES
		) {
			throw new Error("RENDER_QA_IMAGE_CONTENT_LIMIT: QA image content exceeds the bounded context budget");
		}
		if (
			imageBytes.byteLength !== metadata.byte_length ||
			createHash("sha256").update(imageBytes).digest("hex") !== metadata.sha256 ||
			imageBytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE_HEX
		) {
			throw new Error("INVALID_RENDER_QA_RESULT: frame image does not match its PNG metadata");
		}
		const streamed = pending.artifactFrames.get(expectedFrame);
		if (
			streamed === undefined ||
			streamed.chunks.size !== streamed.totalChunks ||
			streamed.receivedBytes !== streamed.totalByteLength
		) {
			throw new Error("INVALID_RENDER_QA_RESULT: frame artifact chunks are incomplete");
		}
		if (metadata.byte_length !== streamed.totalByteLength || metadata.sha256 !== streamed.sha256) {
			throw new Error("INVALID_RENDER_QA_RESULT: final metadata changed from the artifact declaration");
		}
		candidates.push({
			frame: expectedFrame,
			byteLength: streamed.totalByteLength,
			sha256: streamed.sha256,
			reservation: streamed.reservation,
			image: { mime_type: "image/png", data_base64: image.data_base64 },
		});
	}

	pending.beginArtifactCommit();
	const frames: RenderQaFramesResultV1["frames"][number][] = [];
	for (const candidate of candidates) {
		const descriptor = await candidate.reservation.commit();
		if (pending.quarantined) {
			throw new Error("CANCELLED: artifact commit completed after cancellation");
		}
		if (
			descriptor.sha256 !== candidate.sha256 ||
			descriptor.byteLength !== candidate.byteLength ||
			descriptor.uri !== `omb-artifact://sha256/${candidate.sha256}`
		) {
			throw new Error("INVALID_ARTIFACT_DESCRIPTOR: publisher returned mismatched metadata");
		}
		const frame = {
			frame: candidate.frame,
			width: 640 as const,
			height: 360 as const,
			profile_version: "omb-qa-png-v1" as const,
			byte_length: candidate.byteLength,
			sha256: candidate.sha256,
			uri: descriptor.uri,
			image: candidate.image,
		};
		frames.push(frame);
	}
	return {
		schema_version: 1,
		revision_id: pending.renderRequest.revision_id,
		profile_version: "omb-qa-png-v1",
		frames,
	};
}

export async function start(options: DaemonOptions): Promise<Daemon> {
	const clock = options.clock ?? systemClock;
	const transcript = await DirectorTranscriptStore.open(options.projectDirectory ?? process.cwd());
	const token = new BearerToken(clock);
	const controllerCredential = new ControllerCredential();
	const attachTickets = new AttachTicketBroker(clock, options.attachTicketTtlMs);
	const launchId = randomUUID();
	const nonces = new Set<string>();
	const seenRequestIds = new Set<string>();
	const connections = new Map<ClientRole, {
		readonly websocket: WebSocketConnection;
		helloComplete: boolean;
		mutationSession?: MutationBridgeSession;
		idle?: ReturnType<typeof setTimeout>;
	}>();
	const controlEvents: unknown[] = [];
	const activeHandlers = new Set<Promise<void>>();
	const bridgeTerminalTargets = new Map<string, WebSocketConnection>();
	const directorSequences = new Map<string, number>();
	const directorEventTails = new Map<string, Promise<void>>();
	const directorCommitRevisions = new Map<string, string>();
	const directorCleanupBarriers = new Map<string, Promise<void>>();
	let directorTurn = options.directorTurn;
	let directorGeneration = 0;
	let pendingBridge: PendingBridge | undefined;
	const retiredBridges = new Map<string, RetiredBridge>();
	let bridgeMessageTail: Promise<void> = Promise.resolve();
	let draining = false;
	let shutdownPromise: Promise<void> | undefined;
	let runtimeAdvertisement: Awaited<ReturnType<typeof createRuntimeAdvertisement>> | undefined;
	let resolveStopped!: () => void;
	let stoppedResolved = false;
	const stopped = new Promise<void>((resolve) => {
		resolveStopped = resolve;
	});
	const resolveStoppedOnce = () => {
		if (stoppedResolved) return;
		stoppedResolved = true;
		resolveStopped();
	};
	const server = http.createServer((_request, response) => {
		response.writeHead(403);
		response.end();
	});
	const closeServer = () =>
		new Promise<void>((resolve, reject) => {
			if (!server.listening) return resolve();
			server.close((error) => (error ? reject(error) : resolve()));
		});
	const addressPort = () => {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("not listening");
		return address.port;
	};
	const activeControl = () => connections.get("controller") ?? connections.get("legacy");
	const sendControl = (value: unknown, retain = true) => {
		if (retain) {
			controlEvents.push(value);
			if (controlEvents.length > 1_000) controlEvents.shift();
		}
		const control = activeControl();
		if (control?.helloComplete && !control.websocket.socket.destroyed) control.websocket.sendText(value);
	};
	const queueDirectorEvent = (
		requestId: string,
		value: Omit<Record<string, unknown>, "id" | "sequence" | "at">,
	): Promise<void> => {
		const sequence = directorSequences.get(requestId) ?? 0;
		directorSequences.set(requestId, sequence + 1);
		const event = parseDirectorTurnEvent({
			...value,
			id: requestId,
			sequence,
			at: new Date(clock.now()).toISOString(),
		});
		const previous = (directorEventTails.get(requestId) ?? Promise.resolve()).catch(() => undefined);
		const queued = previous.then(async () => {
			await transcript.append(event);
			sendControl(event, false);
		});
		directorEventTails.set(requestId, queued);
		void queued.catch(() => undefined);
		return queued;
	};
	const sendTerminal = (requestId: string, value: unknown) => {
		sendControl(value);
		const bridge = bridgeTerminalTargets.get(requestId);
		const control = activeControl()?.websocket;
		if (bridge !== undefined && bridge !== control && !bridge.socket.destroyed) {
			bridge.sendText(value);
		}
	};
	const state = new SessionState(clock, (request) => void finishCancellation(request));

	function retireBridge(pending: PendingBridge): Promise<void> {
		const existing = retiredBridges.get(pending.id);
		if (existing !== undefined) return existing.artifactCleanup;
		const artifactCleanup =
			pending.artifactCleanup ??=
				(async () => {
					try {
						await pending.artifactSetup;
					} catch {}
					await abortArtifactFrames(pending);
				})();
		const retirementTimer = setTimeout(() => {
			void artifactCleanup.finally(() => retiredBridges.delete(pending.id));
		}, RETIRED_BRIDGE_TTL_MS);
		retirementTimer.unref();
		retiredBridges.set(pending.id, { pending, artifactCleanup, retirementTimer });
		return artifactCleanup;
	}

	function forceDisposeRetiredBridge(retired: RetiredBridge): void {
		retired.pending.quarantined = true;
		const frames = Array.from(retired.pending.artifactFrames.values());
		retired.pending.artifactFrames.clear();
		for (const frame of frames) void frame.reservation.abort().catch(() => undefined);
		clearTimeout(retired.retirementTimer);
		retiredBridges.delete(retired.pending.id);
		void retired.artifactCleanup.catch(() => undefined);
	}

	async function failPendingBridge(code: string, message: string): Promise<void> {
		if (pendingBridge === undefined) return;
		const pending = pendingBridge;
		pendingBridge = undefined;
		pending.removeAbortListener();
		pending.reject(new Error(`${code}: ${message}`));
		await retireBridge(pending);
	}

	function bridgeTransport() {
		const transport = connections.get("bridge") ?? connections.get("legacy");
		if (!transport?.helloComplete || transport.mutationSession === undefined) return undefined;
		return {
			websocket: transport.websocket,
			mutationSession: transport.mutationSession,
		};
	}

	const directorTeardownTimeoutMs = options.directorTeardownTimeoutMs ?? 10_000;
	async function finishCancellation(request: ActiveRequest) {
		let teardownTimer: ReturnType<typeof setTimeout> | undefined;
		let deadlineExpired = false;
		const cancellationDeadline = new Promise<false>((resolve) => {
			teardownTimer = setTimeout(() => {
				deadlineExpired = true;
				resolve(false);
			}, directorTeardownTimeoutMs);
		});
		const cleanupBarrier = directorCleanupBarriers.get(request.id);
		if (cleanupBarrier !== undefined) {
			const settled = await Promise.race([cleanupBarrier.then(() => true), cancellationDeadline]);
			if (!settled && directorCleanupBarriers.get(request.id) === cleanupBarrier) {
				directorGeneration += 1;
				directorTurn = directorTurn?.forceDispose();
				directorCleanupBarriers.delete(request.id);
			}
		}
		const retired = Array.from(retiredBridges.values()).find(
			(candidate) => candidate.pending.requestId === request.id,
		);
		if (retired !== undefined && !deadlineExpired) {
			await Promise.race([retired.artifactCleanup.then(() => true), cancellationDeadline]);
		}
		if (retired !== undefined && deadlineExpired) forceDisposeRetiredBridge(retired);
		if (teardownTimer !== undefined) clearTimeout(teardownTimer);
		if (!state.terminal(request)) return;
		if (directorSequences.has(request.id)) {
			await queueDirectorEvent(request.id, { type: "director_turn_cancelled" });
			return;
		}
		const error = protocolError(
			request.id,
			request.cause === "TIMEOUT" ? "TIMEOUT" : "CANCELLED",
			request.cause === "TIMEOUT" ? "deadline expired" : "request cancelled",
			false,
		);
		sendTerminal(request.id, error);
	}

	async function drain(
		cause: "SHUTDOWN" | "DISCONNECT",
		acknowledge?: WebSocketConnection,
	): Promise<void> {
		if (shutdownPromise) return shutdownPromise;
		draining = true;
		server.close();
		const active = state.current;
		if (active) state.cancel(active.id, cause);
		shutdownPromise = (async () => {
			if (pendingBridge !== undefined) {
				await failPendingBridge(
					cause,
					cause === "DISCONNECT"
						? "legacy add-on disconnected during mutation"
						: "daemon shut down during mutation",
				);
			}
			if (activeHandlers.size) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const bounded = new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 5_000);
				});
				await Promise.race([Promise.allSettled(Array.from(activeHandlers)), bounded]);
				clearTimeout(timer);
			}
			directorTurn?.dispose();
			if (acknowledge !== undefined && !acknowledge.socket.destroyed) {
				acknowledge.sendText({ type: "shutdown_ack" });
			}
			for (const connection of connections.values()) {
				clearTimeout(connection.idle);
				if (!connection.websocket.socket.destroyed) connection.websocket.close(1000);
			}
			connections.clear();
			token.zero();
			controllerCredential.zero();
			attachTickets.zero();
			try {
				await closeServer();
				await runtimeAdvertisement?.cleanup();
			} catch (error) {
				(options.stderr ?? ((line) => process.stderr.write(`${line}\n`)))(
					`daemon cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			resolveStoppedOnce();
		})();
		return shutdownPromise;
	}

	server.on("upgrade", (request, socket) => {
		const role = readClientRole(request);
		if (role === undefined) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		const alreadyAccepted = connections.has(role) || (role !== "legacy" && connections.has("legacy"));
		const websocket = acceptUpgrade(
			request,
			socket,
			addressPort(),
			alreadyAccepted,
			(candidate) => {
				if (role === "bridge") return attachTickets.consume(candidate, role);
				if (role === "controller") {
					return controllerCredential.matches(candidate) || token.consume(candidate);
				}
				return token.consume(candidate);
			},
			role === "bridge" ? MAX_BRIDGE_MESSAGE_BYTES : undefined,
		);
		if (!websocket) return;
		const connection = { websocket, helloComplete: false };
		connections.set(role, connection);
		run(role, connection);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", resolve);
	});
	try {
		runtimeAdvertisement = await createRuntimeAdvertisement({
			launchId,
			port: addressPort(),
			baseDirectory: options.runtimeBaseDirectory,
		});
	} catch (error) {
		token.zero();
		controllerCredential.zero();
		attachTickets.zero();
		await closeServer();
		throw error;
	}
	const startup = parseStartupRecord({
		type: "omb_daemon_ready",
		protocol: PROTOCOL_VERSION,
		port: addressPort(),
		pid: process.pid,
		launch_id: launchId,
		bearer_token: token.value,
		expires_in_ms: 10_000,
	});
	token.startExpiry();
	(options.stdout ?? ((line) => process.stdout.write(`${line}\n`)))(JSON.stringify(startup));

	function run(
		role: ClientRole,
		connection: {
			readonly websocket: WebSocketConnection;
			helloComplete: boolean;
			mutationSession?: MutationBridgeSession;
			idle?: ReturnType<typeof setTimeout>;
		},
	) {
		const websocket = connection.websocket;
		const helloTimer = setTimeout(() => {
			if (!connection.helloComplete) websocket.close(1008, "hello timeout");
		}, options.helloTimeoutMs ?? 3_000);
		const resetIdle = () => {
			clearTimeout(connection.idle);
			connection.idle = setTimeout(
				() => websocket.close(1000, "idle"),
				options.idleTimeoutMs ?? 60_000,
			);
		};
		resetIdle();
		websocket.on("text", (text: string) => {
			resetIdle();
			let serializedBridgeMessage = false;
			try {
				const value = JSON.parse(text) as { type?: unknown };
				serializedBridgeMessage =
					typeof value.type === "string" && value.type.startsWith("bridge_");
			} catch {}
			if (serializedBridgeMessage) {
				bridgeMessageTail = bridgeMessageTail.then(() => message(text));
			} else {
				void message(text);
			}
		});
		websocket.on("disconnect", () => {
			clearTimeout(helloTimer);
			clearTimeout(connection.idle);
			if (connections.get(role)?.websocket === websocket) connections.delete(role);
			if (role === "legacy") {
				void drain("DISCONNECT");
			} else if (role === "bridge" && pendingBridge !== undefined) {
				const requestId = pendingBridge.requestId;
				state.cancel(requestId, "DISCONNECT");
				void failPendingBridge("DISCONNECT", "add-on disconnected during mutation");
			}
		});

		async function message(text: string) {
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				if (role !== "bridge") state.consumeToken();
				return;
			}
			if (!connection.helloComplete) {
				try {
					const hello = parseHello(raw);
					if (nonces.has(hello.client_nonce)) return websocket.close(1008, "nonce reused");
					if (
						(role === "controller" && hello.protocol !== PROTOCOL_VERSION) ||
						(role === "bridge" && hello.protocol !== MUTATION_PROTOCOL_VERSION)
					) {
						return websocket.close(1008, "role protocol mismatch");
					}
					nonces.add(hello.client_nonce);
					connection.helloComplete = true;
					clearTimeout(helloTimer);
					const ack =
						hello.protocol === MUTATION_PROTOCOL_VERSION
							? {
									type: "hello_ack" as const,
									protocol: MUTATION_PROTOCOL_VERSION,
									daemon_version: "0.1.0",
									launch_id: launchId,
									session_id: transcript.sessionId,
									server_nonce: randomNonce(),
									capabilities: hello.capabilities.some(
										(capability) => capability === SCENE_MANIFEST_V3_CAPABILITY,
									)
										? [MUTATION_BRIDGE_CAPABILITY, SCENE_MANIFEST_V3_CAPABILITY]
										: [MUTATION_BRIDGE_CAPABILITY],
								}
							: {
									type: "hello_ack" as const,
									protocol: PROTOCOL_VERSION,
									daemon_version: "0.1.0",
									launch_id: launchId,
									session_id: transcript.sessionId,
									server_nonce: randomNonce(),
									capabilities:
										directorTurn === undefined
											? ["inspect_project"]
											: [
													"inspect_project",
													DIRECTOR_TURN_CAPABILITY,
													DIRECTOR_TRANSCRIPT_CAPABILITY,
												],
								};
					if (hello.protocol === MUTATION_PROTOCOL_VERSION) {
						connection.mutationSession = negotiateMutationBridge(hello, ack);
					}
					websocket.sendText(ack);
					if (role === "controller") {
						websocket.sendText({
							type: "controller_auth",
							resume_token: controllerCredential.value,
							launch_id: launchId,
						});
						for (const event of controlEvents) websocket.sendText(event);
					}
					return;
				} catch {
					return websocket.close(1008, "invalid hello");
				}
			}
			if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "hello") {
				const nonce = (raw as { client_nonce?: unknown }).client_nonce;
				if (typeof nonce === "string" && nonces.has(nonce)) return websocket.close(1008, "nonce reused");
				return websocket.close(1008, "hello already completed");
			}
			const rawType = typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : undefined;
			if (rawType === "issue_attach_ticket") {
				if (
					role === "controller" &&
					isRecord(raw) &&
					hasExactKeys(raw, ["role", "type"]) &&
					raw.role === "bridge"
				) {
					const issued = attachTickets.issue("bridge");
					websocket.sendText({
						type: "attach_ticket",
						role: issued.role,
						ticket: issued.ticket,
						expires_in_ms: issued.expiresInMs,
						launch_id: launchId,
						runtime_directory: runtimeAdvertisement?.directory,
					});
				}
				return;
			}
			if (typeof rawType === "string" && rawType.startsWith("bridge_")) {
				if (
					(role !== "bridge" && role !== "legacy") ||
					connection.mutationSession === undefined
				) {
					return;
				}
				const rawId = isRecord(raw) && typeof raw.id === "string" ? raw.id : undefined;
				const rawRequestId =
					isRecord(raw) && typeof raw.request_id === "string" ? raw.request_id : undefined;
				const retired = rawId === undefined ? undefined : retiredBridges.get(rawId);
				if (rawId !== undefined && retired !== undefined) {
					if (rawRequestId !== retired.pending.requestId) return;
					if (
						rawType === "bridge_error" ||
						rawType === "bridge_cancel_ack" ||
						rawType === "bridge_result"
					) {
						await retired.artifactCleanup;
						clearTimeout(retired.retirementTimer);
						retiredBridges.delete(rawId);
					}
					return;
				}
				if (
					pendingBridge === undefined ||
					rawId !== pendingBridge.id ||
					rawRequestId !== pendingBridge.requestId
				) {
					return;
				}
				try {
					const bridgeMessage = parseAddonBridgeMessage(raw, connection.mutationSession);
					if (bridgeMessage.type === "bridge_progress") {
						pendingBridge.reportProgress({
							phase: bridgeMessage.phase,
							completed: bridgeMessage.completed,
							total: bridgeMessage.total,
						});
						return;
					}
					if (bridgeMessage.type === "bridge_artifact_batch_begin") {
						pendingBridge.artifactSetup = beginArtifactBatch(
							pendingBridge,
							bridgeMessage,
							options.beginArtifactReservations,
						);
						await pendingBridge.artifactSetup;
						return;
					}
					if (bridgeMessage.type === "bridge_artifact_begin") {
						pendingBridge.artifactSetup = beginArtifactFrame(
							pendingBridge,
							bridgeMessage,
							options.beginArtifactReservation,
						);
						await pendingBridge.artifactSetup;
						return;
					}
					if (bridgeMessage.type === "bridge_artifact_chunk") {
						await recordArtifactChunk(pendingBridge, bridgeMessage);
						return;
					}
					const pending = pendingBridge;
					if (bridgeMessage.type === "bridge_result") {
						const result =
							pending.method === "render_qa_frames"
								? await finalizeRenderResult(pending, bridgeMessage.result)
								: bridgeMessage.result;
						pendingBridge = undefined;
						pending.removeAbortListener();
						pending.resolve(result);
					} else {
						pendingBridge = undefined;
						pending.removeAbortListener();
						await abortArtifactFrames(pending);
						if (bridgeMessage.type === "bridge_error") {
							pending.reject(new Error(`${bridgeMessage.code}: ${bridgeMessage.message}`));
						} else {
							pending.reject(new Error("CANCELLED: add-on acknowledged bridge cancellation"));
						}
					}
				} catch (error) {
					if (
						pendingBridge === undefined ||
						rawId !== pendingBridge.id ||
						rawRequestId !== pendingBridge.requestId
					) {
						return;
					}
					const message = error instanceof Error ? error.message : "invalid add-on bridge message";
					const parsed = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/.exec(message);
					await failPendingBridge(parsed?.[1] ?? "INVALID_BRIDGE_MESSAGE", parsed?.[2] ?? message);
				}
				return;
			}
			if (role === "bridge") return;
			if (rawType === "director_transcript_request") {
				if (role !== "controller") return;
				try {
					const request = parseClientMessage(raw);
					if (request.type === "director_transcript_request") {
						websocket.sendText(transcript.page(request));
					}
				} catch {
					state.consumeToken();
				}
				return;
			}
			if (rawType === "director_turn") {
				if (role !== "controller") return;
				if (!state.consumeToken()) {
					return sendControl(
						protocolError((raw as { id?: string }).id ?? "", "RATE_LIMITED", "rate limit exceeded", true),
					);
				}
				let turn: DirectorTurn;
				try {
					const parsed = parseClientMessage(raw);
					if (parsed.type !== "director_turn") throw new Error("invalid director turn");
					turn = parsed;
				} catch {
					return sendControl(
						protocolError((raw as { id?: string }).id ?? "", "INVALID_REQUEST", "invalid director turn", false),
					);
				}
				return executeDirectorTurn(turn);
			}
			if (rawType === "request") {
				if (!state.consumeToken()) {
					return sendControl(
						protocolError((raw as { id?: string }).id ?? "", "RATE_LIMITED", "rate limit exceeded", true),
					);
				}
				const deadline = (raw as { deadline_ms?: unknown }).deadline_ms;
				if (!Number.isInteger(deadline) || (deadline as number) < 100 || (deadline as number) > 30_000) {
					return sendControl(
						protocolError(
							(raw as { id?: string }).id ?? "",
							"INVALID_DEADLINE",
							"deadline_ms must be 100..30000",
							false,
						),
					);
				}
				let request: Request;
				try {
					request = parseClientMessage(raw) as Request;
				} catch {
					return sendControl(
						protocolError((raw as { id?: string }).id ?? "", "INVALID_REQUEST", "invalid request", false),
					);
				}
				return execute(request);
			}
			let parsed: ReturnType<typeof parseClientMessage>;
			try {
				parsed = parseClientMessage(raw);
			} catch {
				state.consumeToken();
				return;
			}
			if (parsed.type === "ping") {
				websocket.sendText({ type: "pong", nonce: parsed.nonce });
				return;
			}
			if (parsed.type === "cancel") {
				const status = state.cancel(parsed.id);
				sendControl({ type: "cancel_ack", id: parsed.id, status });
				return;
			}
			if (parsed.type === "shutdown") await drain("SHUTDOWN", websocket);
		}
	}
	type BridgeParentRequest = Pick<Request, "id" | "expected_revision_id" | "deadline_ms">;

	async function inspectProject(
		request: BridgeParentRequest,
		context: Parameters<ApplyCameraPlan>[1],
	): Promise<{ readonly revision: string; readonly snapshot: SceneSnapshot }> {
		const transport = bridgeTransport();
		if (transport === undefined) {
			throw new Error("INSPECT_BRIDGE_UNAVAILABLE: inspect_project requires an attached protocol-v2 bridge");
		}
		if (pendingBridge !== undefined) throw new Error("BUSY: one protocol-v2 bridge is already open");
		const id = randomUUID();
		const bridgeRequest = parseDaemonBridgeMessage(
			{
				type: "bridge_request",
				id,
				request_id: request.id,
				method: "inspect_project",
				params: {},
				expected_revision_id: request.expected_revision_id,
				deadline_ms: request.deadline_ms,
			},
			transport.mutationSession,
			new Set([request.id]),
		);
		bridgeTerminalTargets.set(request.id, transport.websocket);
		return new Promise((resolve, reject) => {
			const abort = () => {
				if (pendingBridge?.id !== id) return;
				try {
					transport.websocket.sendText(
						parseDaemonBridgeMessage(
							{ type: "bridge_cancel", id, request_id: request.id },
							transport.mutationSession,
							new Set([request.id]),
						),
					);
				} catch {
					void failPendingBridge("CANCELLED", "inspect bridge cancellation failed");
				}
				void failPendingBridge("CANCELLED", "inspect bridge cancelled");
			};
			const signal = context.signal;
			pendingBridge = {
				id,
				requestId: request.id,
				method: "inspect_project",
				artifactFrames: new Map(),
				totalArtifactBytes: 0,
				reportProgress: context.reportProgress,
				resolve: (result) => {
					if (
						!isRecord(result) ||
						!hasExactKeys(result, ["revision", "snapshot"]) ||
						typeof result.revision !== "string" ||
						!/^[0-9a-f]{64}$/.test(result.revision) ||
						(request.expected_revision_id !== BOOTSTRAP_REVISION_ID &&
							result.revision !== request.expected_revision_id)
					) {
						reject(new Error("INVALID_INSPECT_RESULT: bridge inspection does not bind the expected revision"));
						return;
					}
					try {
						resolve({
							revision: result.revision,
							snapshot: parseSceneSnapshot(result.snapshot),
						});
					} catch {
						reject(new Error("INVALID_INSPECT_RESULT: bridge returned an invalid scene snapshot"));
					}
				},
				reject,
				removeAbortListener: () => signal?.removeEventListener("abort", abort),
			};
			signal?.addEventListener("abort", abort, { once: true });
			transport.websocket.sendText(bridgeRequest);
			if (signal?.aborted) abort();
		});
	}

	async function applyCameraPlan(
		request: BridgeParentRequest,
		plan: CameraPlanV1,
		context: Parameters<ApplyCameraPlan>[1],
	): Promise<CameraPlanMutationCandidate> {
		const transport = bridgeTransport();
		if (transport === undefined) {
			throw new Error("MUTATION_BRIDGE_UNAVAILABLE: apply_camera_plan requires an attached protocol-v2 bridge");
		}
		if (pendingBridge !== undefined) throw new Error("BUSY: one mutation bridge is already open");
		if (plan.expected_revision_id !== request.expected_revision_id) {
			throw new Error(
				`STALE_BASE: plan expected ${plan.expected_revision_id}, request expected ${request.expected_revision_id}`,
			);
		}
		const id = randomUUID();
		const bridgeRequest = parseDaemonBridgeMessage(
			{
				type: "bridge_request",
				id,
				request_id: request.id,
				method: "apply_camera_plan",
				params: plan,
				expected_revision_id: request.expected_revision_id,
				deadline_ms: request.deadline_ms,
			},
			transport.mutationSession,
			new Set([request.id]),
		);
		bridgeTerminalTargets.set(request.id, transport.websocket);
		return new Promise<CameraPlanMutationCandidate>((resolve, reject) => {
			const abort = () => {
				if (pendingBridge?.id !== id) return;
				try {
					transport.websocket.sendText(
						parseDaemonBridgeMessage(
							{ type: "bridge_cancel", id, request_id: request.id },
							transport.mutationSession,
							new Set([request.id]),
						),
					);
				} catch {
					void failPendingBridge("CANCELLED", "mutation bridge cancellation failed");
				}
				void failPendingBridge("CANCELLED", "mutation bridge cancelled");
			};
			const signal = context.signal;
			pendingBridge = {
				id,
				requestId: request.id,
				method: "apply_camera_plan",
				artifactFrames: new Map(),
				totalArtifactBytes: 0,
				reportProgress: context.reportProgress,
				resolve: (result) => resolve(result as CameraPlanMutationCandidate),
				reject,
				removeAbortListener: () => signal?.removeEventListener("abort", abort),
			};
			signal?.addEventListener("abort", abort, { once: true });
			transport.websocket.sendText(bridgeRequest);
			if (signal?.aborted) abort();
		});
	}
	async function stageScene(
		request: BridgeParentRequest,
		plan: StageScenePlanV1,
		context: Parameters<StageScene>[1],
	): Promise<StageSceneMutationCandidate> {
		const transport = bridgeTransport();
		if (transport === undefined) {
			throw new Error("MUTATION_BRIDGE_UNAVAILABLE: stage_scene requires an attached protocol-v2 bridge");
		}
		if (!transport.mutationSession.supportsStageScene) {
			throw new Error(
				`CAPABILITY_NOT_NEGOTIATED: stage_scene requires ${SCENE_MANIFEST_V3_CAPABILITY}`,
			);
		}
		if (pendingBridge !== undefined) throw new Error("BUSY: one mutation bridge is already open");
		if (plan.expected_revision_id !== request.expected_revision_id) {
			throw new Error(
				`STALE_BASE: plan expected ${plan.expected_revision_id}, request expected ${request.expected_revision_id}`,
			);
		}
		const id = randomUUID();
		const bridgeRequest = parseDaemonBridgeMessage(
			{
				type: "bridge_request",
				id,
				request_id: request.id,
				method: "stage_scene",
				params: plan,
				expected_revision_id: request.expected_revision_id,
				deadline_ms: request.deadline_ms,
			},
			transport.mutationSession,
			new Set([request.id]),
		);
		bridgeTerminalTargets.set(request.id, transport.websocket);
		return new Promise<StageSceneMutationCandidate>((resolve, reject) => {
			const abort = () => {
				if (pendingBridge?.id !== id) return;
				try {
					transport.websocket.sendText(
						parseDaemonBridgeMessage(
							{ type: "bridge_cancel", id, request_id: request.id },
							transport.mutationSession,
							new Set([request.id]),
						),
					);
				} catch {
					void failPendingBridge("CANCELLED", "stage bridge cancellation failed");
				}
				void failPendingBridge("CANCELLED", "stage bridge cancelled");
			};
			const signal = context.signal;
			pendingBridge = {
				id,
				requestId: request.id,
				method: "stage_scene",
				artifactFrames: new Map(),
				totalArtifactBytes: 0,
				reportProgress: context.reportProgress,
				resolve: (result) => resolve(result as StageSceneMutationCandidate),
				reject,
				removeAbortListener: () => signal?.removeEventListener("abort", abort),
			};
			signal?.addEventListener("abort", abort, { once: true });
			transport.websocket.sendText(bridgeRequest);
			if (signal?.aborted) abort();
		});
	}


	async function renderQaFrames(
		request: BridgeParentRequest,
		requestValue: RenderQaFramesRequestV1,
		context: Parameters<RenderQaFrames>[1],
		beginArtifactCommit: () => void,
	): Promise<RenderQaFramesResultV1> {
		const transport = bridgeTransport();
		if (transport === undefined) {
			throw new Error("RENDER_BRIDGE_UNAVAILABLE: render_qa_frames requires an attached protocol-v2 bridge");
		}
		if (pendingBridge !== undefined) throw new Error("BUSY: one protocol-v2 bridge is already open");
		const renderRequest = parseRenderQaFramesRequest(requestValue);
		if (renderRequest.revision_id !== request.expected_revision_id) {
			throw new Error(
				`STALE_BASE: render expected ${renderRequest.revision_id}, request expected ${request.expected_revision_id}`,
			);
		}
		const id = randomUUID();
		const bridgeRequest = parseDaemonBridgeMessage(
			{
				type: "bridge_request",
				id,
				request_id: request.id,
				method: "render_qa_frames",
				params: renderRequest,
				expected_revision_id: request.expected_revision_id,
				deadline_ms: request.deadline_ms,
			},
			transport.mutationSession,
			new Set([request.id]),
		);
		bridgeTerminalTargets.set(request.id, transport.websocket);
		return new Promise<RenderQaFramesResultV1>((resolve, reject) => {
			const abort = () => {
				if (pendingBridge?.id !== id) return;
				pendingBridge.cancelled = true;
				const cancellingBridge = pendingBridge;
				void retireBridge(cancellingBridge);
				try {
					transport.websocket.sendText(
						parseDaemonBridgeMessage(
							{ type: "bridge_cancel", id, request_id: request.id },
							transport.mutationSession,
							new Set([request.id]),
						),
					);
				} catch {
					void failPendingBridge("CANCELLED", "render bridge cancellation failed");
				}
				void failPendingBridge("CANCELLED", "render bridge cancelled");
			};
			const signal = context.signal;
			pendingBridge = {
				id,
				requestId: request.id,
				method: "render_qa_frames",
				renderRequest,
				artifactFrames: new Map(),
				totalArtifactBytes: 0,
				reportProgress: context.reportProgress,
				beginArtifactCommit,
				resolve: (result) => resolve(result as RenderQaFramesResultV1),
				reject,
				removeAbortListener: () => signal?.removeEventListener("abort", abort),
			};
			signal?.addEventListener("abort", abort, { once: true });
			transport.websocket.sendText(bridgeRequest);
			if (signal?.aborted) abort();
		});
	}

	async function executeDirectorTurn(turn: DirectorTurn) {
		if (draining) {
			return sendControl(protocolError(turn.id, "SHUTTING_DOWN", "daemon is shutting down", true));
		}
		if (seenRequestIds.has(turn.id)) {
			return sendControl(protocolError(turn.id, "INVALID_REQUEST", "request id has already been used", false));
		}
		seenRequestIds.add(turn.id);
		if (directorTurn === undefined) {
			return sendControl(protocolError(turn.id, "METHOD_NOT_ALLOWED", "director turns are not enabled", false));
		}
		const service = directorTurn;
		if (state.begin(turn.id, turn.deadline_ms) === "busy") {
			return sendControl(protocolError(turn.id, "BUSY", "one request is already active", true));
		}
		const active = state.current!;
		const parent = (expectedRevisionId: string): BridgeParentRequest => ({
			id: turn.id,
			expected_revision_id: expectedRevisionId,
			deadline_ms: turn.deadline_ms,
		});
		let resolveCleanup!: () => void;
		const cleanupBarrier = new Promise<void>((resolve) => {
			resolveCleanup = resolve;
		});
		directorCleanupBarriers.set(turn.id, cleanupBarrier);
		const generation = directorGeneration;
		const isCurrentTurn = () => generation === directorGeneration;
		const requireCurrentTurn = () => {
			if (!isCurrentTurn()) throw new Error("DIRECTOR_TURN_QUARANTINED: director turn was abandoned");
		};
		const task = (async () => {
			try {
				await queueDirectorEvent(turn.id, {
					type: "director_turn_started",
					prompt: turn.prompt,
				});
				const result = await service.run(
					turn,
					{
						signal: active.controller.signal,
						inspectProject: (expectedRevisionId) => {
							requireCurrentTurn();
							return runTrustedDirectorTool(() =>
								inspectProject(parent(expectedRevisionId), {
									signal: active.controller.signal,
									reportProgress: () => {},
								}),
							);
						},
						applyCameraPlan: async (plan, context) => {
							requireCurrentTurn();
							const candidate = await runTrustedDirectorTool(() =>
								applyCameraPlan(parent(plan.expected_revision_id), plan, context),
							);
							requireCurrentTurn();
							directorCommitRevisions.set(turn.id, candidate.manifest.revisionId);
							return candidate;
						},
						stageScene: async (plan, context) => {
							requireCurrentTurn();
							const candidate = await runTrustedDirectorTool(() =>
								stageScene(parent(plan.expected_revision_id), plan, context),
							);
							requireCurrentTurn();
							directorCommitRevisions.set(turn.id, candidate.manifest.revisionId);
							return candidate;
						},
						renderQaFrames: async (renderRequest, context) => {
							requireCurrentTurn();
							let beganCommit = false;
							try {
								return await runTrustedDirectorTool(() =>
									renderQaFrames(
									parent(renderRequest.revision_id),
									renderRequest,
									context,
									() => {
										requireCurrentTurn();
										if (!state.beginDurableCommit(active)) {
											throw new Error(
												`${active.cause ?? "CANCELLED"}: cancellation won before artifact publication`,
											);
										}
										beganCommit = true;
									},
									),
								);
							} finally {
								if (beganCommit && isCurrentTurn()) state.finishDurableCommit(active);
							}
						},
						beginDurableCommit: () => {
							requireCurrentTurn();
							if (!state.beginDurableCommit(active)) {
								throw new TrustedDirectorFailure("DURABLE_COMMIT_STATE");
							}
						},
						finishDurableCommit: () => {
							requireCurrentTurn();
							if (!state.finishDurableCommit(active)) {
								throw new TrustedDirectorFailure("DURABLE_COMMIT_STATE");
							}
							const revision = directorCommitRevisions.get(turn.id);
							const bridge = bridgeTerminalTargets.get(turn.id);
							if (revision === undefined || bridge === undefined || bridge.socket.destroyed) {
								throw new TrustedDirectorFailure("DURABLE_COMMIT_STATE");
							}
							directorCommitRevisions.delete(turn.id);
							bridge.sendText({
								type: "response",
								id: turn.id,
								result: {},
								resulting_revision_id: revision,
							});
						},
					},
					(event) => {
						if (!isCurrentTurn()) return;
						if (event.type === "started") {
							void queueDirectorEvent(turn.id, {
								type: "director_tool_call_started",
								tool_call_id: event.toolCallId,
								tool_name: event.toolName,
								params_summary: event.paramsSummary,
							});
						} else {
							void queueDirectorEvent(turn.id, {
								type: "director_tool_call_finished",
								tool_call_id: event.toolCallId,
								tool_name: event.toolName,
								result_digest: event.digest,
								is_error: event.isError,
							});
						}
					},
				);
				if (!isCurrentTurn()) return;
				await directorEventTails.get(turn.id);
				if (state.complete(active)) {
					await queueDirectorEvent(turn.id, {
						type: "director_turn_completed",
						summary: result.summary,
						resulting_revision_id: result.resultingRevisionId,
					});
					state.terminal(active);
				}
			} catch (cause) {
				if (!isCurrentTurn()) return;
				await directorEventTails.get(turn.id)?.catch(() => undefined);
				if (state.complete(active)) {
					const failure =
						cause instanceof TrustedDirectorFailure
							? {
									code: cause.code,
									message: cause.message,
								}
							: cause instanceof DirectorLoopContractError
								? {
										code: cause.code,
										message: TRUSTED_DIRECTOR_FAILURE_MESSAGES[cause.code],
									}
								: {
										code: "MODEL_PROVIDER_ERROR",
										message: "provider request failed",
									};
					try {
						await queueDirectorEvent(turn.id, {
							type: "director_turn_failed",
							code: failure.code,
							message: failure.message,
							retryable: false,
						});
					} finally {
						state.terminal(active);
					}
				}
			} finally {
				resolveCleanup();
				if (directorCleanupBarriers.get(turn.id) === cleanupBarrier) {
					directorCleanupBarriers.delete(turn.id);
				}
			}
		})();
		activeHandlers.add(task);
		try {
			await task;
		} finally {
			activeHandlers.delete(task);
			directorCommitRevisions.delete(turn.id);
			bridgeTerminalTargets.delete(turn.id);
		}
	}

	async function execute(request: Request) {
		if (draining) {
			return sendControl(protocolError(request.id, "SHUTTING_DOWN", "daemon is shutting down", true));
		}
		if (seenRequestIds.has(request.id)) {
			return sendControl(protocolError(request.id, "INVALID_REQUEST", "request id has already been used", false));
		}
		seenRequestIds.add(request.id);
		if (state.begin(request.id, request.deadline_ms) === "busy") {
			return sendControl(protocolError(request.id, "BUSY", "one request is already active", true));
		}
		const active = state.current!;
		if (
			request.method === "stage_scene" &&
			!bridgeTransport()?.mutationSession.supportsStageScene
		) {
			state.complete(active);
			state.terminal(active);
			return sendControl(
				protocolError(
					request.id,
					"CAPABILITY_NOT_NEGOTIATED",
					`stage_scene requires ${SCENE_MANIFEST_V3_CAPABILITY}`,
					false,
				),
			);
		}
		const handler = options.handlers[request.method];
		if (!handler) {
			state.complete(active);
			state.terminal(active);
			return sendControl(protocolError(request.id, "METHOD_NOT_ALLOWED", "method is not allowed", false));
		}
		const task = (async () => {
			try {
				const output = await handler(request.params, {
					signal: active.controller.signal,
					request,
					reportProgress: (phase, completed, total) => {
						if (active.phase === "running") {
							sendControl({ type: "progress", id: active.id, phase, completed, total });
						}
					},
					applyCameraPlan: (plan, context) => applyCameraPlan(request, plan, context),
					stageScene: (plan, context) => stageScene(request, plan, context),
					renderQaFrames: (renderRequest, context) =>
						renderQaFrames(request, renderRequest, context, () => {
							if (!state.beginDurableCommit(active)) {
								throw new Error(`${active.cause ?? "CANCELLED"}: cancellation won before artifact publication`);
							}
						}),
					beginDurableCommit: () => {
						if (!state.beginDurableCommit(active)) {
							throw new Error(`${active.cause ?? "CANCELLED"}: cancellation won before durable commit`);
						}
					},
				});
				if (state.complete(active)) {
					state.terminal(active);
					sendTerminal(active.id, { type: "response", id: active.id, ...output });
				}
			} catch (cause) {
				if (state.complete(active)) {
					state.terminal(active);
					const message = cause instanceof Error ? cause.message : "handler failed";
					const parsed = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/.exec(message);
					sendTerminal(
						active.id,
						protocolError(active.id, parsed?.[1] ?? "HANDLER_ERROR", parsed?.[2] ?? message, false),
					);
				}
			}
		})();
		activeHandlers.add(task);
		try {
			await task;
		} finally {
			activeHandlers.delete(task);
			bridgeTerminalTargets.delete(request.id);
		}
	}

	return {
		port: addressPort(),
		startup,
		runtimeDirectory: runtimeAdvertisement.directory,
		stopped,
		close: async () => {
			await drain("SHUTDOWN");
		},
	};
}

const protocolError = (id: string, code: string, message: string, retryable: boolean) => ({
	type: "error",
	id,
	code,
	message,
	retryable,
});
