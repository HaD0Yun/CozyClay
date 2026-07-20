import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import {
	DIRECTOR_TRANSCRIPT_CAPABILITY,
	CONTROLLER_PEERS_CAPABILITY,
	DIRECTOR_STREAM_CAPABILITY,
	DIRECTOR_TURN_CAPABILITY,
	MUTATION_PROTOCOL_VERSION,
	MUTATION_BRIDGE_CAPABILITY,
	MutationBridgeSession,
	negotiateMutationBridge,
	parseAddonBridgeMessage,
	parseClientMessage,
	parseDirectorTurnEvent,
	parseDirectorTurnDelta,
	parseDaemonBridgeMessage,
	parseHello,
	parseRenderQaFramesRequest,
	parseSceneSnapshot,
	parseStartupRecord,
	PROTOCOL_VERSION,
	SCENE_MANIFEST_V3_CAPABILITY,
	SNAPSHOT_CURSOR_V2_FEATURE,
	TRANSACTION_COMMIT_CAPABILITY,
	type BridgeArtifactBegin,
	type BridgeArtifactBatchBegin,
	type BridgeArtifactChunk,
	type BridgeTransactionAcknowledged,
	type BridgeTransactionPrepared,
	type BridgeTransactionReconcile,
	type BridgeTransactionStatus,
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
import {
	DirectorLoopContractError,
	DirectorTurnPublicationError,
	type DirectorTurnPublication,
	type DirectorTurnToolEvent,
	type PreparedMutationCandidate,
} from "@oh-my-blender/director-runtime";
import {
	AttachTicketBroker,
	ControllerCredential,
	createRuntimeAdvertisement,
	type ClientRole,
	type CredentialPrincipal,
	OwnerCredential,
	type PeerAuthentication,
	ProjectCredentialBroker,
} from "./control-plane.ts";
import { DirectorTranscriptStore } from "./transcript-store.ts";
import { SessionState, type ActiveRequest } from "./session-state.ts";
import { BearerToken, randomNonce, systemClock, type Clock } from "./token.ts";
import { acceptUpgrade, readClientRole, readUniqueHeader, type WebSocketConnection } from "./ws-server.ts";

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
) => Promise<PreparedMutationCandidate<CameraPlanMutationCandidate>>;
export type StageScene = (
	plan: StageScenePlanV1,
	context: {
		readonly signal: AbortSignal | undefined;
		readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
	},
) => Promise<PreparedMutationCandidate<StageSceneMutationCandidate>>;
export type { DirectorTurnToolEvent };
export interface DirectorTurnContext {
	readonly signal: AbortSignal;
	inspectProject(expectedRevisionId: string): Promise<{ readonly revision: string; readonly snapshot: SceneSnapshot }>;
	readonly applyCameraPlan: ApplyCameraPlan;
	readonly stageScene: StageScene;
	readonly renderQaFrames: RenderQaFrames;
	beginDurableCommit(): void;
	finishDurableCommit(): Promise<void> | void;
}
export type ControllerAuthority = "owner" | "peer";
export interface AuthenticatedPrincipal {
	readonly connectionId: string;
	readonly projectId: string;
	readonly role: ClientRole;
	readonly authority: ControllerAuthority | "bridge" | "legacy";
	readonly lineageId?: string;
	readonly generation: number;
}

export interface DirectorTurnService {
	run(
		turn: DirectorTurn,
		context: DirectorTurnContext,
		onPublication: (event: DirectorTurnPublication) => Promise<void> | void,
	): Promise<{
		readonly summary: string;
		readonly resultingRevisionId: string;
		readonly toolCallOrder: readonly DirectorToolName[];
	}>;
	reconcileTransaction(transactionId: string, markerPhase: BridgeTransactionReconcile["marker_phase"]): Promise<{
		readonly status: BridgeTransactionStatus["status"];
		readonly revisionId: string;
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
	signal?: AbortSignal,
) => Promise<RenderArtifactReservation>;
export type BeginArtifactReservations = (
	artifacts: readonly RenderArtifactDeclaration[],
	signal?: AbortSignal,
) => Promise<readonly RenderArtifactReservation[]>;
export type RenderQaFrames = (
	request: RenderQaFramesRequestV1,
	context: {
		readonly signal: AbortSignal | undefined;
		readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
	},
) => Promise<RenderQaFramesResultV1>;

export interface TranscriptStore {
	readonly sessionId: string;
	append(event: Parameters<DirectorTranscriptStore["append"]>[0]): Promise<void>;
	page(request: Parameters<DirectorTranscriptStore["page"]>[0]): ReturnType<DirectorTranscriptStore["page"]>;
}

export type DaemonOptions = {
	projectId: string;
	port: number;
	clock?: Clock;
	handlers: Record<string, Handler>;
	directorTurn?: DirectorTurnService;
	projectDirectory?: string;
	transcriptStore?: TranscriptStore;
	beginArtifactReservation?: BeginArtifactReservation;
	beginArtifactReservations?: BeginArtifactReservations;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	helloTimeoutMs?: number;
	idleTimeoutMs?: number;
	/** Test-only observability; omitted by production callers. */
	testHooks?: {
		onIdleForceDestroy?: () => void;
	};
	attachTicketTtlMs?: number;
	directorTeardownTimeoutMs?: number;
	runtimeBaseDirectory?: string;
};
export type Daemon = {
	projectId: string;
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
	readonly signal?: AbortSignal;
	preparedTransaction?: BridgeTransactionPrepared;
	quarantine?: Promise<void>;
	resolveQuarantine?: () => void;
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
type DirectorPreparedTransaction = {
	readonly prepared: BridgeTransactionPrepared;
	readonly bridge: WebSocketConnection;
	readonly mutationSession: MutationBridgeSession;
	readonly acknowledged: Promise<void>;
	ackSent: boolean;
	resolveAcknowledged(message: BridgeTransactionAcknowledged): void;
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
	PERSISTENCE_UNHEALTHY: "transcript persistence is unavailable",
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
	STAGE_SCENE_FAILED: "stage_scene operation failed",
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
async function runTrustedStageScene<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await runTrustedDirectorTool(operation);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "";
		if (message.startsWith("UNKNOWN:") || !/^[A-Z][A-Z0-9_]+:/.test(message)) {
			throw new TrustedDirectorFailure("STAGE_SCENE_FAILED");
		}
		throw cause;
	}
}

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requireProjectId(value: string): string {
	if (!PROJECT_ID_PATTERN.test(value)) {
		throw new Error("PROJECT_CONFIGURATION_ERROR: project is unavailable");
	}
	return value;
}
const KNOWN_CONTROL_MESSAGE_TYPES = new Set([
	"ping",
	"cancel",
	"shutdown",
	"request",
	"director_turn",
	"director_transcript_request",
	"bridge_status_request",
	"issue_attach_ticket",
	"publish_bridge_discovery_slot",
	"publish_controller_peer_discovery_slot",
	"revoke_controller_peer",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function preparedMutationCandidate<T>(value: unknown): PreparedMutationCandidate<T> | undefined {
	if (
		!isRecord(value) ||
		!isRecord(value.candidate) ||
		!isRecord(value.transaction) ||
		typeof value.requestId !== "string"
	) {
		return undefined;
	}
	return value as PreparedMutationCandidate<T>;
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
	const reservation = await beginReservation(
		{
			sha256: begin.sha256,
			byteLength: begin.total_byte_length,
		},
		pending.signal,
	);
	if (pending.cancelled) {
		if (pending.quarantined) {
			void Promise.resolve()
				.then(() => reservation.abort())
				.catch(() => undefined);
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
		pending.signal,
	);
	if (pending.cancelled) {
		const aborts = reservations.map((reservation) =>
			Promise.resolve().then(() => reservation.abort()),
		);
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
	await Promise.allSettled(
		frames.map((frame) => Promise.resolve().then(() => frame.reservation.abort())),
	);
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

type DaemonConnection = {
	readonly websocket: WebSocketConnection;
	readonly principal: AuthenticatedPrincipal;
	readonly peerAuthentication?: PeerAuthentication;
	helloComplete: boolean;
	mutationSession?: MutationBridgeSession;
	idle?: ReturnType<typeof setTimeout>;
	idleCloseGrace?: ReturnType<typeof setTimeout>;
	unknownTypeAt?: number;
};

function authenticatedPrincipal(
	principal: CredentialPrincipal,
	connectionId = randomUUID(),
): AuthenticatedPrincipal {
	return Object.freeze({
		connectionId,
		projectId: principal.projectId,
		role: principal.role === "bridge" ? "bridge" : "controller",
		authority: principal.authority === "owner" || principal.role === "owner" ? "owner" : principal.role,
		lineageId: principal.lineageId,
		generation: principal.generation,
	});
}

export async function start(options: DaemonOptions): Promise<Daemon> {
	const projectId = requireProjectId(options.projectId);
	const clock = options.clock ?? systemClock;
	const transcript =
		options.transcriptStore ?? (await DirectorTranscriptStore.open(options.projectDirectory ?? process.cwd()));
	const token = new BearerToken(clock);
	const launchId = randomUUID();
	const ownerCredential = new OwnerCredential({
		projectId,
		authority: "owner",
		lineageId: launchId,
	});
	const projectCredentials = new ProjectCredentialBroker(clock);
	const attachTickets = new AttachTicketBroker(clock, options.attachTicketTtlMs);
	const nonces = new Set<string>();
	const seenRequestIds = new Set<string>();
	const connections = new Map<ClientRole, DaemonConnection>();
	const peerConnections = new Map<string, DaemonConnection>();
	const pendingTerminals = new Map<string, unknown[]>();
	let pendingTerminalCount = 0;
	const activeHandlers = new Set<Promise<void>>();
	const bridgeTerminalTargets = new Map<string, WebSocketConnection>();
	const requesterTargets = new Map<
		string,
		{ readonly websocket: WebSocketConnection; readonly principalKey: string }
	>();
	const directorSequences = new Map<string, number>();
	const directorEventTails = new Map<string, Promise<void>>();
	const directorCommitRevisions = new Map<string, string>();
	const directorCleanupBarriers = new Map<string, Promise<void>>();
	const discoveryResponses = new Map<
		string,
		{ readonly canonical: string; readonly response: unknown; readonly expiresAt: number }
	>();
	const directorPreparedTransactions = new Map<string, DirectorPreparedTransaction>();
	const directorPreparedTransactionsByBridgeId = new Map<string, DirectorPreparedTransaction>();
	let directorTurn = options.directorTurn;
	let directorGeneration = 0;
	let pendingBridge: PendingBridge | undefined;
	const retiredBridges = new Map<string, RetiredBridge>();
	let bridgeMessageTail: Promise<void> = Promise.resolve();
	let draining = false;
	let persistenceUnhealthy = false;
	let shutdownPromise: Promise<void> | undefined;
	let runtimeAdvertisement: Awaited<ReturnType<typeof createRuntimeAdvertisement>> | undefined;
	let handoffTicket: string | undefined;
	let controllerPeerSlotLineage: string | undefined;
	let handoffExpiryTimer: ReturnType<typeof setTimeout> | undefined;
	let bridgeStatusSubscribed = false;
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
	const controllerTargets = (): DaemonConnection[] => {
		const targets: DaemonConnection[] = [];
		const owner = activeControl();
		if (owner !== undefined) targets.push(owner);
		targets.push(...peerConnections.values());
		return targets;
	};
	const requesterPrincipalKey = (principal: AuthenticatedPrincipal): string =>
		principal.authority === "peer"
			? `peer:${principal.lineageId}`
			: `${principal.authority}:${principal.lineageId ?? launchId}`;
	const sendRequester = (websocket: WebSocketConnection, value: unknown): boolean =>
		!websocket.socket.destroyed && websocket.sendText(value);
	const broadcastControllers = (value: unknown, streamOnly = false) => {
		for (const connection of controllerTargets()) {
			if (!connection.helloComplete || connection.websocket.socket.destroyed) continue;
			if (streamOnly && connection.principal.role === "legacy") continue;
			connection.websocket.sendText(value);
		}
	};
	const sendBridgeStatus = () => {
		if (bridgeStatusSubscribed) broadcastControllers({ type: "bridge_status", attached: bridgeTransport() !== undefined });
	};
	let persistenceFailureStarted = false;
	const failPersistence = (cause: unknown) => {
		if (persistenceFailureStarted) return;
		persistenceFailureStarted = true;
		persistenceUnhealthy = true;
		attachTickets.zero();
		projectCredentials.zero();
		for (const connection of controllerTargets()) {
			if (!connection.websocket.socket.destroyed) {
				connection.websocket.close(1011, "transcript persistence failure");
			}
		}
		const detail = cause instanceof Error ? cause.message : String(cause);
		emitDiagnostic(`director transcript persistence failed: ${detail}`);
		void drain("SHUTDOWN").catch((error) => {
			emitDiagnostic(`daemon shutdown failed after transcript persistence failure: ${
				error instanceof Error ? error.message : String(error)
			}`);
		});
	};
	const queueDirectorEvent = (
		requestId: string,
		value: Omit<Record<string, unknown>, "id" | "sequence" | "at">,
	): Promise<void> => {
		if (persistenceUnhealthy) return Promise.reject(new DirectorTurnPublicationError());
		const sequence = directorSequences.get(requestId) ?? 0;
		directorSequences.set(requestId, sequence + 1);
		const event = parseDirectorTurnEvent({
			...value,
			id: requestId,
			sequence,
			at: new Date(clock.now()).toISOString(),
		});
		const previous = directorEventTails.get(requestId) ?? Promise.resolve();
		const queued = previous.then(async () => {
			if (persistenceUnhealthy) throw new DirectorTurnPublicationError();
			await transcript.append(event);
			broadcastControllers(event, event.type === "director_assistant_utterance");
		});
		directorEventTails.set(requestId, queued);
		void queued.catch(failPersistence);
		return queued;
	};
	const queueDirectorDelta = (publication: Extract<DirectorTurnPublication, { type: "text_delta" }>) => {
		if (persistenceUnhealthy) return;
		const delta = parseDirectorTurnDelta({
			type: "director_turn_delta",
			id: publication.turnId,
			segment_id: publication.segmentId,
			content_index: publication.contentIndex,
			delta_sequence: publication.deltaSequence,
			delta: publication.delta,
		});
		broadcastControllers(delta, true);
	};
	const sendTerminal = (requestId: string, value: unknown) => {
		const requester = requesterTargets.get(requestId);
		const delivered = requester !== undefined && sendRequester(requester.websocket, value);
		if (requester !== undefined && !delivered) {
			const pending = pendingTerminals.get(requester.principalKey) ?? [];
			pending.push(value);
			pendingTerminalCount += 1;
			pendingTerminals.set(requester.principalKey, pending);
			if (pendingTerminalCount > 1_000) {
				emitDiagnostic(`pending terminal bound exceeded for ${requester.principalKey}`);
				void drain("SHUTDOWN");
			}
		}
		const bridge = bridgeTerminalTargets.get(requestId);
		if (bridge !== undefined && bridge !== requester?.websocket && !bridge.socket.destroyed) {
			bridge.sendText(value);
		}
		requesterTargets.delete(requestId);
	};
	const state = new SessionState(clock, (request) => {
		// Total wake boundary: cancellation cleanup must never escape as an
		// unhandled rejection, whatever its internal failure handlers do.
		finishCancellation(request).catch(() => undefined);
	});

	function emitDiagnostic(line: string): void {
		// Diagnostics must never abort a fail-safe sequence.
		try {
			(options.stderr ?? ((text: string) => process.stderr.write(`${text}\n`)))(line);
		} catch {}
	}

	function quarantineSignal(pending: PendingBridge): Promise<void> {
		pending.quarantine ??= new Promise<void>((resolve) => {
			pending.resolveQuarantine = resolve;
		});
		return pending.quarantine;
	}

	function retireBridge(pending: PendingBridge): Promise<void> {
		const existing = retiredBridges.get(pending.id);
		if (existing !== undefined) return existing.artifactCleanup;
		quarantineSignal(pending);
		const artifactCleanup =
			pending.artifactCleanup ??=
				(async () => {
					try {
						await Promise.race([pending.artifactSetup, pending.quarantine]);
					} catch {}
					if (!pending.quarantined) await abortArtifactFrames(pending);
				})();
		const retirementTimer = setTimeout(() => {
			void artifactCleanup
				.finally(() => retiredBridges.delete(pending.id))
				.catch(() => undefined);
		}, RETIRED_BRIDGE_TTL_MS);
		retirementTimer.unref();
		retiredBridges.set(pending.id, { pending, artifactCleanup, retirementTimer });
		return artifactCleanup;
	}

	function forceDisposeRetiredBridge(retired: RetiredBridge): void {
		retired.pending.quarantined = true;
		retired.pending.resolveQuarantine?.();
		const frames = Array.from(retired.pending.artifactFrames.values());
		retired.pending.artifactFrames.clear();
		for (const frame of frames) {
			void Promise.resolve()
				.then(() => frame.reservation.abort())
				.catch(() => undefined);
		}
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
		if (
			!transport?.helloComplete ||
			transport.mutationSession === undefined ||
			transport.websocket.closing ||
			transport.websocket.socket.destroyed ||
			!transport.websocket.socket.writable ||
			transport.websocket.socket.writableEnded
		) {
			return undefined;
		}
		return {
			websocket: transport.websocket,
			mutationSession: transport.mutationSession,
		};
	}
	function registerPreparedTransaction(
		requestId: string,
		prepared: PreparedMutationCandidate<CameraPlanMutationCandidate | StageSceneMutationCandidate>,
	): void {
		const bridge = bridgeTerminalTargets.get(requestId);
		const transport = bridgeTransport();
		if (
			bridge === undefined ||
			bridge.socket.destroyed ||
			transport === undefined ||
			transport.websocket !== bridge
		) {
			throw new TrustedDirectorFailure("DURABLE_COMMIT_STATE");
		}
		let resolved = false;
		let resolveAcknowledged!: () => void;
		const acknowledged = new Promise<void>((resolve) => {
			resolveAcknowledged = resolve;
		});
		const transaction: DirectorPreparedTransaction = {
			prepared: prepared.transaction,
			bridge,
			mutationSession: transport.mutationSession,
			acknowledged,
			ackSent: false,
			resolveAcknowledged: (message) => {
				if (
					resolved ||
					message.id !== prepared.transaction.id ||
					message.transaction_id !== prepared.transaction.transaction_id
				) {
					return;
				}
				resolved = true;
				resolveAcknowledged();
			},
		};
		directorPreparedTransactions.set(requestId, transaction);
		directorPreparedTransactionsByBridgeId.set(prepared.transaction.id, transaction);
	}


	const directorTeardownTimeoutMs = options.directorTeardownTimeoutMs ?? 10_000;
	async function finishCancellation(request: ActiveRequest): Promise<void> {
		let teardownTimer: ReturnType<typeof setTimeout> | undefined;
		let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
		try {
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
			if (!state.terminal(request)) return;
			if (directorSequences.has(request.id)) {
				const publication = queueDirectorEvent(request.id, { type: "director_turn_cancelled" });
				const persistenceDeadline = new Promise<never>((_resolve, reject) => {
					persistenceTimer = setTimeout(
						() => reject(new Error("transcript persistence timed out")),
						directorTeardownTimeoutMs,
					);
				});
				try {
					await Promise.race([publication, persistenceDeadline]);
				} catch (cause) {
					persistenceUnhealthy = true;
					attachTickets.zero();
					try {
						const detail = cause instanceof Error ? cause.message : String(cause);
						emitDiagnostic(`director cancellation persistence failed for request ${request.id}: ${detail}`);
						const control = activeControl();
						if (control !== undefined && !control.websocket.socket.destroyed) {
							control.websocket.close(1011, "transcript persistence failure");
						}
					} finally {
						// Shutdown is unconditional: independent of diagnostics and close.
						void drain("SHUTDOWN").catch((error) => {
							emitDiagnostic(
								`daemon shutdown failed after transcript persistence failure for request ${request.id}: ${
									error instanceof Error ? error.message : String(error)
								}`,
							);
						});
					}
				}
				return;
			}
			const error = protocolError(
				request.id,
				request.cause === "TIMEOUT" ? "TIMEOUT" : "CANCELLED",
				request.cause === "TIMEOUT" ? "deadline expired" : "request cancelled",
				false,
			);
			sendTerminal(request.id, error);
		} catch (cause) {
			emitDiagnostic(
				`director cancellation cleanup failed for request ${request.id}: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		} finally {
			if (teardownTimer !== undefined) clearTimeout(teardownTimer);
			if (persistenceTimer !== undefined) clearTimeout(persistenceTimer);
		}
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
			for (const connection of [...connections.values(), ...peerConnections.values()]) {
				clearTimeout(connection.idle);
				if (!connection.websocket.socket.destroyed) connection.websocket.close(1000);
			}
			connections.clear();
			peerConnections.clear();
			token.zero();
			ownerCredential.zero();
			projectCredentials.zero();
			clearTimeout(handoffExpiryTimer);
			handoffTicket = undefined;
			attachTickets.zero();
			try {
				await closeServer();
				await runtimeAdvertisement?.cleanup();
			} catch (error) {
				emitDiagnostic(`daemon cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
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
		let principal: AuthenticatedPrincipal | undefined;
		let peerAuthentication: PeerAuthentication | undefined;
		const websocket = acceptUpgrade(
			request,
			socket,
			addressPort(),
			false,
			(candidate) => {
				if (role === "bridge") {
					const projectPrincipal = projectCredentials.consumeBridge(candidate, projectId);
					const legacyAccepted = projectPrincipal === undefined && attachTickets.consume(candidate, role);
					if (projectPrincipal === undefined && !legacyAccepted) return false;
					if (candidate === handoffTicket) {
						handoffTicket = undefined;
						clearTimeout(handoffExpiryTimer);
						void runtimeAdvertisement?.removeAttachHandoff().catch(() => undefined);
					}
					if (projectPrincipal !== undefined) {
						void runtimeAdvertisement?.removeBridgeSlot().catch(() => undefined);
					}
					principal = projectPrincipal === undefined
						? Object.freeze({
								connectionId: randomUUID(),
								projectId,
								role: "bridge",
								authority: "bridge",
								lineageId: launchId,
								generation: 1,
							})
						: authenticatedPrincipal(projectPrincipal);
					return !connections.has("bridge") && !connections.has("legacy");
				}
				if (role === "controller") {
					if (token.consume(candidate)) {
						principal = authenticatedPrincipal(ownerCredential.principal);
					} else if (ownerCredential.matches(candidate, projectId)) {
						if (readUniqueHeader(request, "x-omb-launch-id") !== launchId) return false;
						principal = authenticatedPrincipal(ownerCredential.principal);
					} else {
						let resumed = false;
						peerAuthentication = projectCredentials.consumeControllerPeer(candidate, projectId);
						if (peerAuthentication === undefined) {
							resumed = true;
							peerAuthentication = projectCredentials.resumeControllerPeer(candidate, projectId);
						}
						if (peerAuthentication === undefined) return false;
						const peerPrincipal = peerAuthentication.principal;
						if (resumed) {
							const generation = readUniqueHeader(request, "x-omb-peer-generation");
							if (
								readUniqueHeader(request, "x-omb-launch-id") !== launchId ||
								readUniqueHeader(request, "x-omb-peer-lineage-id") !== peerPrincipal.lineageId ||
								generation === undefined ||
								!Number.isSafeInteger(Number(generation)) ||
								String(Number(generation)) !== generation ||
								Number(generation) !== peerPrincipal.generation - 1
							) {
								projectCredentials.revokeControllerPeer(peerPrincipal.lineageId);
								return false;
							}
						}
						if (!resumed && controllerPeerSlotLineage === peerPrincipal.lineageId) {
							controllerPeerSlotLineage = undefined;
							void runtimeAdvertisement?.removeControllerPeerSlot().catch(() => undefined);
						}
						principal = authenticatedPrincipal(peerPrincipal);
					}
					if (principal.authority === "owner") {
						return !connections.has("controller") && !connections.has("legacy");
					}
					return principal.lineageId !== undefined && !peerConnections.has(principal.lineageId);
				}
				if (!token.consume(candidate)) return false;
				principal = Object.freeze({
					connectionId: randomUUID(),
					projectId,
					role: "legacy",
					authority: "legacy",
					generation: 1,
				});
				return connections.size === 0 && peerConnections.size === 0;
			},
			role === "bridge" ? MAX_BRIDGE_MESSAGE_BYTES : undefined,
		);
		if (websocket === undefined || principal === undefined) return;
		const connection: DaemonConnection = {
			websocket,
			principal,
			peerAuthentication,
			helloComplete: false,
		};
		if (principal.authority === "peer" && principal.lineageId !== undefined) {
			peerConnections.set(principal.lineageId, connection);
		} else {
			connections.set(role, connection);
		}
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
		ownerCredential.zero();
		projectCredentials.zero();
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

	function run(role: ClientRole, connection: DaemonConnection) {
		const websocket = connection.websocket;
		const helloTimer = setTimeout(() => {
			if (!connection.helloComplete) websocket.close(1008, "hello timeout");
		}, options.helloTimeoutMs ?? 3_000);
		const resetIdle = () => {
			clearTimeout(connection.idle);
			connection.idle = setTimeout(() => {
				websocket.close(1000, "idle");
				connection.idleCloseGrace = setTimeout(() => {
					if (!websocket.socket.destroyed) {
						websocket.socket.destroy();
						options.testHooks?.onIdleForceDestroy?.();
					}
				}, 1_000);
				connection.idleCloseGrace.unref();
			}, options.idleTimeoutMs ?? 60_000);
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
				bridgeMessageTail = bridgeMessageTail.then(async () => {
					await message(text);
				});
			} else {
				void message(text);
			}
		});
		websocket.on("disconnect", () => {
			clearTimeout(helloTimer);
			clearTimeout(connection.idle);
			clearTimeout(connection.idleCloseGrace);
			if (connection.principal.authority === "peer" && connection.principal.lineageId !== undefined) {
				if (peerConnections.get(connection.principal.lineageId)?.websocket === websocket) {
					peerConnections.delete(connection.principal.lineageId);
				}
			} else if (connections.get(role)?.websocket === websocket) {
				connections.delete(role);
			}
			if (role === "bridge") sendBridgeStatus();
			if (role === "legacy") {
				void drain("DISCONNECT");
			} else if (role === "bridge") {
				if (pendingBridge !== undefined) {
					const requestId = pendingBridge.requestId;
					state.cancel(requestId, "DISCONNECT");
					void failPendingBridge("DISCONNECT", "add-on disconnected during mutation");
				}
				for (const [turnId, transaction] of directorPreparedTransactions) {
					if (transaction.bridge === websocket) state.cancel(turnId, "DISCONNECT");
				}
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
					if (hello.project_id !== projectId) return websocket.close(1008, "project mismatch");
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
										? hello.capabilities.some(
												(capability) => capability === TRANSACTION_COMMIT_CAPABILITY,
											)
											? [
													MUTATION_BRIDGE_CAPABILITY,
													SCENE_MANIFEST_V3_CAPABILITY,
													TRANSACTION_COMMIT_CAPABILITY,
												]
											: [MUTATION_BRIDGE_CAPABILITY, SCENE_MANIFEST_V3_CAPABILITY]
										: hello.capabilities.some(
												(capability) => capability === TRANSACTION_COMMIT_CAPABILITY,
											)
											? [MUTATION_BRIDGE_CAPABILITY, TRANSACTION_COMMIT_CAPABILITY]
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
											? ["inspect_project", CONTROLLER_PEERS_CAPABILITY]
											: [
													"inspect_project",
													DIRECTOR_TURN_CAPABILITY,
													DIRECTOR_TRANSCRIPT_CAPABILITY,
													DIRECTOR_STREAM_CAPABILITY,
													CONTROLLER_PEERS_CAPABILITY,
												],
									protocol_features: [SNAPSHOT_CURSOR_V2_FEATURE],
								};
					if (hello.protocol === MUTATION_PROTOCOL_VERSION) {
						connection.mutationSession = negotiateMutationBridge(hello, ack);
					}
					websocket.sendText(ack);
					if (role === "bridge") sendBridgeStatus();
					if (role === "controller") {
						if (connection.principal.authority === "owner") {
							websocket.sendText({
								type: "controller_auth",
								resume_token: ownerCredential.value,
								launch_id: launchId,
							});
						} else if (connection.peerAuthentication !== undefined) {
							websocket.sendText({
								type: "controller_peer_auth",
								resume_token: connection.peerAuthentication.resumeToken,
								launch_id: launchId,
								lineage_id: connection.peerAuthentication.principal.lineageId,
								generation: connection.peerAuthentication.principal.generation,
								expires_in_ms: connection.peerAuthentication.expiresInMs,
							});
						}
						const principalKey = requesterPrincipalKey(connection.principal);
						const pending = pendingTerminals.get(principalKey);
						if (pending !== undefined) {
							let delivered = 0;
							while (delivered < pending.length && sendRequester(websocket, pending[delivered])) {
								delivered += 1;
							}
							if (delivered === pending.length) {
								pendingTerminalCount -= pending.length;
								pendingTerminals.delete(principalKey);
							} else if (delivered > 0) {
								pendingTerminalCount -= delivered;
								pending.splice(0, delivered);
							}
						}
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
			if (
				rawType === "bridge_status_request" &&
				role === "controller" &&
				isRecord(raw) &&
				hasExactKeys(raw, ["type"])
			) {
				bridgeStatusSubscribed = true;
				sendBridgeStatus();
				return;
			}
			if (
				rawType === "publish_bridge_discovery_slot" ||
				rawType === "publish_controller_peer_discovery_slot" ||
				rawType === "revoke_controller_peer"
			) {
				const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : "";
				if (role !== "controller" || connection.principal.authority !== "owner") {
					sendRequester(
						websocket,
						protocolError(id, "AUTHORITY_DENIED", "controller authority is insufficient", false),
					);
					return;
				}
				try {
					const request = parseClientMessage(raw);
					if (
						request.type !== "publish_bridge_discovery_slot" &&
						request.type !== "publish_controller_peer_discovery_slot" &&
						request.type !== "revoke_controller_peer"
					) {
						throw new Error("invalid discovery message");
					}
					if (runtimeAdvertisement === undefined) {
						throw new Error("runtime advertisement unavailable");
					}
					const canonical =
						request.type === "publish_bridge_discovery_slot"
							? request.type
							: `${request.type}:${request.lineage_id}`;
					const cached = discoveryResponses.get(request.id);
					if (cached !== undefined && clock.now() < cached.expiresAt) {
						if (cached.canonical !== canonical) {
							sendRequester(
								websocket,
								protocolError(request.id, "IDEMPOTENCY_CONFLICT", "request id conflicts with prior request", false),
							);
						} else {
							sendRequester(websocket, cached.response);
						}
						return;
					}
					discoveryResponses.delete(request.id);
					const remember = (response: unknown, expiresAt: number) => {
						discoveryResponses.set(request.id, { canonical, response, expiresAt });
						if (discoveryResponses.size > 1_000) {
							const oldest = discoveryResponses.keys().next().value;
							if (oldest !== undefined) discoveryResponses.delete(oldest);
						}
						sendRequester(websocket, response);
					};
					if (request.type === "publish_bridge_discovery_slot") {
						attachTickets.zero();
						const issued = projectCredentials.publishBridge({
							projectId,
							authority: "bridge",
							lineageId: launchId,
						});
						await runtimeAdvertisement.writeBridgeSlot({
							schema_version: 1,
							project_id: projectId,
							ticket: issued.ticket,
							expires_at_ms: Date.now() + issued.expiresInMs,
							generation: issued.principal.generation,
						});
						remember({
							type: "bridge_discovery_slot_ack",
							id: request.id,
							generation: issued.principal.generation,
							expires_in_ms: issued.expiresInMs,
						}, clock.now() + issued.expiresInMs);
					} else if (request.type === "publish_controller_peer_discovery_slot") {
						const issued = projectCredentials.publishControllerPeer({
							projectId,
							authority: "peer",
							lineageId: request.lineage_id,
						});
						await runtimeAdvertisement.writeControllerPeerSlot({
							schema_version: 1,
							project_id: projectId,
							ticket: issued.ticket,
							expires_at_ms: Date.now() + issued.expiresInMs,
							generation: issued.principal.generation,
							lineage_id: request.lineage_id,
						});
						controllerPeerSlotLineage = request.lineage_id;
						remember({
							type: "controller_peer_discovery_slot_ack",
							id: request.id,
							lineage_id: request.lineage_id,
							generation: issued.principal.generation,
							expires_in_ms: issued.expiresInMs,
						}, clock.now() + issued.expiresInMs);
					} else if (request.type === "revoke_controller_peer") {
						projectCredentials.revokeControllerPeer(request.lineage_id);
						if (controllerPeerSlotLineage === request.lineage_id) {
							controllerPeerSlotLineage = undefined;
							await runtimeAdvertisement.removeControllerPeerSlot();
						}
						const response = {
							type: "revoke_controller_peer_ack",
							id: request.id,
							lineage_id: request.lineage_id,
							status: "revoked",
						};
						remember(response, Number.POSITIVE_INFINITY);
						const peer = peerConnections.get(request.lineage_id);
						if (peer !== undefined && !peer.websocket.socket.destroyed) {
							peer.websocket.close(1008, "controller peer revoked");
						}
					}
				} catch {
					sendRequester(websocket, protocolError(id, "MALFORMED_MESSAGE", "discovery message is malformed", false));
				}
				return;
			}
			if (rawType === "issue_attach_ticket") {
				if (persistenceUnhealthy) return;
				const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : "";
				if (role !== "controller" || connection.principal.authority !== "owner") {
					sendRequester(
						websocket,
						protocolError(id, "AUTHORITY_DENIED", "controller authority is insufficient", false),
					);
					return;
				}
				try {
					const request = parseClientMessage(raw);
					if (request.type !== "issue_attach_ticket" || runtimeAdvertisement === undefined) return;
					if ("id" in request) {
						attachTickets.zero();
						const issued = projectCredentials.publishBridge({
							projectId,
							authority: "bridge",
							lineageId: launchId,
						});
						await runtimeAdvertisement.writeBridgeSlot({
							schema_version: 1,
							project_id: projectId,
							ticket: issued.ticket,
							expires_at_ms: Date.now() + issued.expiresInMs,
							generation: issued.principal.generation,
						});
						sendRequester(websocket, {
							type: "attach_ticket",
							id: request.id,
							role: "bridge",
							ticket: issued.ticket,
							expires_in_ms: issued.expiresInMs,
							generation: issued.principal.generation,
						});
					} else {
						projectCredentials.revokeBridge(launchId);
						const issued = attachTickets.issue("bridge");
						const expiresAtMs = Date.now() + issued.expiresInMs;
						await runtimeAdvertisement.writeAttachHandoff({
							schema_version: 1,
							project_id: projectId,
							ticket: issued.ticket,
							expires_at_ms: expiresAtMs,
						});
						handoffTicket = issued.ticket;
						clearTimeout(handoffExpiryTimer);
						handoffExpiryTimer = setTimeout(() => {
							if (handoffTicket !== issued.ticket) return;
							handoffTicket = undefined;
							void runtimeAdvertisement?.removeAttachHandoff().catch(() => undefined);
						}, issued.expiresInMs);
						handoffExpiryTimer.unref();
						websocket.sendText({
							type: "attach_ticket",
							role: issued.role,
							ticket: issued.ticket,
							expires_in_ms: issued.expiresInMs,
							launch_id: launchId,
							runtime_directory: runtimeAdvertisement.directory,
						});
					}
				} catch {
					sendRequester(websocket, protocolError(id, "INVALID_REQUEST", "invalid attach ticket request", false));
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
				if (rawType === "bridge_transaction_reconcile") {
					try {
						const reconcile = parseAddonBridgeMessage(raw, connection.mutationSession);
						if (reconcile.type !== "bridge_transaction_reconcile") return;
						if (reconcile.project_id !== projectId) {
							websocket.sendText(
								parseDaemonBridgeMessage(
									{
										type: "bridge_transaction_error",
										id: reconcile.id,
										transaction_id: reconcile.transaction_id,
										code: "TRANSACTION_EVIDENCE_INVALID",
										message: "transaction recovery evidence is invalid",
										retryable: false,
									},
									connection.mutationSession,
									new Set(),
								),
							);
							return;
						}
						if (directorTurn === undefined) {
							websocket.sendText(
								parseDaemonBridgeMessage(
									{
										type: "bridge_transaction_error",
										id: reconcile.id,
										transaction_id: reconcile.transaction_id,
										code: "TRANSACTION_NOT_FOUND",
										message: "transaction is unavailable",
										retryable: false,
									},
									connection.mutationSession,
									new Set(),
								),
							);
							return;
						}
						try {
							const result = await directorTurn.reconcileTransaction(
								reconcile.transaction_id,
								reconcile.marker_phase,
							);
							websocket.sendText(
								parseDaemonBridgeMessage(
									{
										type: "bridge_transaction_status",
										id: reconcile.id,
										transaction_id: reconcile.transaction_id,
										status: result.status,
										revision_id: result.revisionId,
									},
									connection.mutationSession,
									new Set(),
								),
							);
						} catch (cause) {
							const code =
								cause instanceof Error &&
								"code" in cause &&
								cause.code === "PROJECT_INVALID"
									? "TRANSACTION_STATE_INVALID"
									: "TRANSACTION_EVIDENCE_INVALID";
							websocket.sendText(
								parseDaemonBridgeMessage(
									{
										type: "bridge_transaction_error",
										id: reconcile.id,
										transaction_id: reconcile.transaction_id,
										code,
										message:
											code === "TRANSACTION_STATE_INVALID"
												? "transaction phase is invalid"
												: "transaction recovery evidence is invalid",
										retryable: false,
									},
									connection.mutationSession,
									new Set(),
								),
							);
						}
					} catch {
						return;
					}
					return;
				}
				if (rawType === "bridge_transaction_acknowledged") {
					try {
						const acknowledged = parseAddonBridgeMessage(raw, connection.mutationSession);
						if (acknowledged.type !== "bridge_transaction_acknowledged") return;
						const transaction = directorPreparedTransactionsByBridgeId.get(acknowledged.id);
						if (
							transaction === undefined ||
							transaction.prepared.transaction_id !== acknowledged.transaction_id
						) {
							return;
						}
						transaction.resolveAcknowledged(acknowledged);
					} catch {
						return;
					}
					return;
				}
				if (rawType === "bridge_transaction_prepared") {
					if (pendingBridge === undefined || rawId !== pendingBridge.id) return;
					try {
						const prepared = parseAddonBridgeMessage(raw, connection.mutationSession);
						if (
							prepared.type !== "bridge_transaction_prepared" ||
							(pendingBridge.method !== "apply_camera_plan" && pendingBridge.method !== "stage_scene") ||
							prepared.operation !== pendingBridge.method ||
							prepared.project_id !== projectId
						) {
							throw new Error("prepared transaction does not bind the pending mutation");
						}
						if (
							pendingBridge.preparedTransaction !== undefined &&
							JSON.stringify(pendingBridge.preparedTransaction) !== JSON.stringify(prepared)
						) {
							throw new Error("transaction id was reused with different content");
						}
						pendingBridge.preparedTransaction = prepared;
					} catch {
						await failPendingBridge(
							"TRANSACTION_EVIDENCE_INVALID",
							"prepared transaction recovery evidence is invalid",
						);
					}
					return;
				}
				const retired = rawId === undefined ? undefined : retiredBridges.get(rawId);
				if (rawId !== undefined && retired !== undefined) {
					if (rawRequestId !== retired.pending.requestId) return;
					if (
						rawType === "bridge_error" ||
						rawType === "bridge_cancel_ack" ||
						rawType === "bridge_result"
					) {
						await Promise.race([retired.artifactCleanup, retired.pending.quarantine ?? Promise.resolve()]);
						if (retired.pending.quarantined) return;
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
						const setup = pendingBridge.artifactSetup;
						void setup.catch(() => undefined);
						await Promise.race([setup, quarantineSignal(pendingBridge)]);
						return;
					}
					if (bridgeMessage.type === "bridge_artifact_begin") {
						pendingBridge.artifactSetup = beginArtifactFrame(
							pendingBridge,
							bridgeMessage,
							options.beginArtifactReservation,
						);
						const setup = pendingBridge.artifactSetup;
						void setup.catch(() => undefined);
						await Promise.race([setup, quarantineSignal(pendingBridge)]);
						return;
					}
					if (bridgeMessage.type === "bridge_artifact_chunk") {
						await recordArtifactChunk(pendingBridge, bridgeMessage);
						return;
					}
					const pending = pendingBridge;
					if (bridgeMessage.type === "bridge_result") {
						const candidate =
							pending.method === "render_qa_frames"
								? await finalizeRenderResult(pending, bridgeMessage.result)
								: bridgeMessage.result;
						const result =
							pending.preparedTransaction === undefined
								? candidate
								: {
										candidate,
										transaction: pending.preparedTransaction,
										requestId: pending.requestId,
									};
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
			if (role === "bridge" && rawType === "ping") {
				try {
					const parsed = parseClientMessage(raw);
					if (parsed.type === "ping") websocket.sendText({ type: "pong", nonce: parsed.nonce });
				} catch {}
				return;
			}
			if (role === "bridge") return;
			if (rawType === "director_transcript_request") {
				if (role !== "controller") return;
				const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : "";
				try {
					const request = parseClientMessage(raw);
					if (request.type === "director_transcript_request") {
						sendRequester(websocket, transcript.page(request));
					}
				} catch (cause) {
					const code =
						cause instanceof Error && cause.message.startsWith("TRANSCRIPT_CURSOR_ERROR:")
							? "INVALID_TRANSCRIPT_CURSOR"
							: "INVALID_REQUEST";
					const message = code === "INVALID_TRANSCRIPT_CURSOR"
						? "transcript cursor is invalid"
						: "invalid transcript request";
					sendRequester(websocket, protocolError(id, code, message, false));
				}
				return;
			}
			if (rawType === "director_turn") {
				if (role !== "controller") return;
				if (!state.consumeToken()) {
					return sendRequester(
						websocket,
						protocolError((raw as { id?: string }).id ?? "", "RATE_LIMITED", "rate limit exceeded", true),
					);
				}
				let turn: DirectorTurn;
				try {
					const parsed = parseClientMessage(raw);
					if (parsed.type !== "director_turn") throw new Error("invalid director turn");
					turn = parsed;
				} catch {
					return sendRequester(
						websocket,
						protocolError((raw as { id?: string }).id ?? "", "INVALID_REQUEST", "invalid director turn", false),
					);
				}
				return executeDirectorTurn(turn, websocket, requesterPrincipalKey(connection.principal));
			}
			if (rawType === "request") {
				if (!state.consumeToken()) {
					return sendRequester(
						websocket,
						protocolError((raw as { id?: string }).id ?? "", "RATE_LIMITED", "rate limit exceeded", true),
					);
				}
				const deadline = (raw as { deadline_ms?: unknown }).deadline_ms;
				if (!Number.isInteger(deadline) || (deadline as number) < 100 || (deadline as number) > 30_000) {
					return sendRequester(
						websocket,
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
					return sendRequester(
						websocket,
						protocolError((raw as { id?: string }).id ?? "", "INVALID_REQUEST", "invalid request", false),
					);
				}
				return execute(request, websocket, requesterPrincipalKey(connection.principal));
			}
			let parsed: ReturnType<typeof parseClientMessage>;
			try {
				parsed = parseClientMessage(raw);
			} catch {
				state.consumeToken();
				if (
					typeof rawType === "string" &&
					!KNOWN_CONTROL_MESSAGE_TYPES.has(rawType) &&
					!rawType.startsWith("bridge_")
				) {
					const now = clock.now();
					if (connection.unknownTypeAt !== undefined && now - connection.unknownTypeAt <= 10_000) {
						websocket.close(1008, "repeated unknown message type");
					} else {
						connection.unknownTypeAt = now;
						const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : "";
						sendRequester(websocket, protocolError(id, "MALFORMED_MESSAGE", "message type is not recognized", false));
					}
				}
				return;
			}
			if (parsed.type === "ping") {
				websocket.sendText({ type: "pong", nonce: parsed.nonce });
				return;
			}
			if (parsed.type === "cancel") {
				const target = requesterTargets.get(parsed.id);
				const status =
					target === undefined || target.websocket === websocket ? state.cancel(parsed.id) : "not_found";
				sendRequester(websocket, { type: "cancel_ack", id: parsed.id, status });
				return;
			}
			if (parsed.type === "shutdown") {
				if (connection.principal.authority !== "owner" && connection.principal.authority !== "legacy") {
					sendRequester(
						websocket,
						protocolError("", "AUTHORITY_DENIED", "controller authority is insufficient", false),
					);
					return;
				}
				await drain("SHUTDOWN", websocket);
			}
		}
	}
	type BridgeParentRequest = Pick<Request, "id" | "expected_revision_id" | "deadline_ms">;
	// Director turns may carry deadlines above the single-request ceiling; every
	// bridge sub-operation stays within the protocol-v2 bridge deadline bound.
	const BRIDGE_OP_DEADLINE_MAX_MS = 30_000;
	const bridgeOpDeadlineMs = (request: BridgeParentRequest): number =>
		Math.min(request.deadline_ms, BRIDGE_OP_DEADLINE_MAX_MS);

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
				deadline_ms: bridgeOpDeadlineMs(request),
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
				signal,
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
	): Promise<PreparedMutationCandidate<CameraPlanMutationCandidate>> {
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
				deadline_ms: bridgeOpDeadlineMs(request),
			},
			transport.mutationSession,
			new Set([request.id]),
		);
		bridgeTerminalTargets.set(request.id, transport.websocket);
		return new Promise<PreparedMutationCandidate<CameraPlanMutationCandidate>>((resolve, reject) => {
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
				signal,
				reportProgress: context.reportProgress,
				resolve: (result) => resolve(result as PreparedMutationCandidate<CameraPlanMutationCandidate>),
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
	): Promise<PreparedMutationCandidate<StageSceneMutationCandidate>> {
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
				deadline_ms: bridgeOpDeadlineMs(request),
			},
			transport.mutationSession,
			new Set([request.id]),
		);
		bridgeTerminalTargets.set(request.id, transport.websocket);
		return new Promise<PreparedMutationCandidate<StageSceneMutationCandidate>>((resolve, reject) => {
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
				signal,
				reportProgress: context.reportProgress,
				resolve: (result) => resolve(result as PreparedMutationCandidate<StageSceneMutationCandidate>),
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
				deadline_ms: bridgeOpDeadlineMs(request),
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
				signal,
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

	async function executeDirectorTurn(
		turn: DirectorTurn,
		requester: WebSocketConnection,
		principalKey: string,
	) {
		if (persistenceUnhealthy) {
			return sendRequester(
				requester,
				protocolError(
					turn.id,
					"PERSISTENCE_UNHEALTHY",
					TRUSTED_DIRECTOR_FAILURE_MESSAGES.PERSISTENCE_UNHEALTHY,
					false,
				),
			);
		}
		if (draining) {
			return sendRequester(requester, protocolError(turn.id, "SHUTTING_DOWN", "daemon is shutting down", true));
		}
		if (seenRequestIds.has(turn.id)) {
			return sendRequester(
				requester,
				protocolError(turn.id, "INVALID_REQUEST", "request id has already been used", false),
			);
		}
		seenRequestIds.add(turn.id);
		if (directorTurn === undefined) {
			return sendRequester(
				requester,
				protocolError(turn.id, "METHOD_NOT_ALLOWED", "director turns are not enabled", false),
			);
		}
		const service = directorTurn;
		if (state.begin(turn.id, turn.deadline_ms) === "busy") {
			return sendRequester(requester, protocolError(turn.id, "BUSY", "one request is already active", true));
		}
		requesterTargets.set(turn.id, { websocket: requester, principalKey });
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
							const prepared = preparedMutationCandidate<CameraPlanMutationCandidate>(candidate);
							const mutation = prepared?.candidate ?? (candidate as unknown as CameraPlanMutationCandidate);
							directorCommitRevisions.set(turn.id, mutation.manifest.revisionId);
							if (prepared !== undefined) registerPreparedTransaction(turn.id, prepared);
							return candidate;
						},
						stageScene: async (plan, context) => {
							requireCurrentTurn();
							const candidate = await runTrustedStageScene(() =>
								stageScene(parent(plan.expected_revision_id), plan, context),
							);
							requireCurrentTurn();
							const prepared = preparedMutationCandidate<StageSceneMutationCandidate>(candidate);
							const mutation = prepared?.candidate ?? (candidate as unknown as StageSceneMutationCandidate);
							directorCommitRevisions.set(turn.id, mutation.manifest.revisionId);
							if (prepared !== undefined) registerPreparedTransaction(turn.id, prepared);
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
						finishDurableCommit: async () => {
							requireCurrentTurn();
							const revision = directorCommitRevisions.get(turn.id);
							const transaction = directorPreparedTransactions.get(turn.id);
							const bridge = transaction?.bridge ?? bridgeTerminalTargets.get(turn.id);
							if (revision === undefined || bridge === undefined || bridge.socket.destroyed) {
								throw new TrustedDirectorFailure("DURABLE_COMMIT_STATE");
							}
							if (transaction !== undefined) {
								transaction.ackSent = true;
								bridge.sendText(
									parseDaemonBridgeMessage(
										{
											type: "bridge_transaction_ack",
											id: transaction.prepared.id,
											transaction_id: transaction.prepared.transaction_id,
											status: "committed",
											resulting_revision_id: revision,
										},
										transaction.mutationSession,
										new Set(),
									),
								);
								await new Promise<void>((resolve, reject) => {
									const abort = () => {
										active.controller.signal.removeEventListener("abort", abort);
										reject(new TrustedDirectorFailure("DURABLE_COMMIT_STATE"));
									};
									active.controller.signal.addEventListener("abort", abort, { once: true });
									transaction.acknowledged.then(() => {
										active.controller.signal.removeEventListener("abort", abort);
										resolve();
									}, reject);
									if (active.controller.signal.aborted) abort();
								});
								directorPreparedTransactions.delete(turn.id);
								directorPreparedTransactionsByBridgeId.delete(transaction.prepared.id);
							}
							if (!state.finishDurableCommit(active)) {
								throw new TrustedDirectorFailure("DURABLE_COMMIT_STATE");
							}
							directorCommitRevisions.delete(turn.id);
							if (transaction === undefined) {
								bridge.sendText({
									type: "response",
									id: turn.id,
									result: {},
									resulting_revision_id: revision,
								});
							}
						},
					},
					async (event) => {
						if (!isCurrentTurn()) return;
						if (event.type === "text_delta") {
							queueDirectorDelta(event);
						} else if (event.type === "assistant_utterance") {
							await queueDirectorEvent(turn.id, {
								type: "director_assistant_utterance",
								segment_id: event.segmentId,
								content_index: event.contentIndex,
								through_delta_sequence: event.throughDeltaSequence,
								content: event.content,
							});
						} else if (event.type === "started") {
							await queueDirectorEvent(turn.id, {
								type: "director_tool_call_started",
								tool_call_id: event.toolCallId,
								tool_name: event.toolName,
								params_summary: event.paramsSummary,
							});
						} else {
							await queueDirectorEvent(turn.id, {
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
				const preparedTransaction = directorPreparedTransactions.get(turn.id);
				if (preparedTransaction !== undefined) {
					if (!preparedTransaction.ackSent && !preparedTransaction.bridge.socket.destroyed) {
						const causeCode =
							cause instanceof Error && "code" in cause && typeof cause.code === "string"
								? cause.code
								: undefined;
						const code =
							causeCode === "TRANSACTION_CONFLICT"
								? "TRANSACTION_CONFLICT"
								: causeCode === "STALE_BASE" || causeCode === "PROJECT_INVALID"
									? "TRANSACTION_STATE_INVALID"
									: "TRANSACTION_EVIDENCE_INVALID";
						preparedTransaction.bridge.sendText(
							parseDaemonBridgeMessage(
								{
									type: "bridge_transaction_error",
									id: preparedTransaction.prepared.id,
									transaction_id: preparedTransaction.prepared.transaction_id,
									code,
									message:
										code === "TRANSACTION_CONFLICT"
											? "transaction id was reused with different content"
											: code === "TRANSACTION_STATE_INVALID"
												? "transaction phase is invalid"
												: "transaction recovery evidence is invalid",
									retryable: false,
								},
								preparedTransaction.mutationSession,
								new Set(),
							),
						);
					}
					directorPreparedTransactions.delete(turn.id);
					directorPreparedTransactionsByBridgeId.delete(preparedTransaction.prepared.id);
				}
				await directorEventTails.get(turn.id)?.catch(() => undefined);
				if (cause instanceof DirectorTurnPublicationError || persistenceUnhealthy) {
					state.complete(active);
					state.terminal(active);
					return;
				}
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
			requesterTargets.delete(turn.id);
			const transaction = directorPreparedTransactions.get(turn.id);
			if (transaction !== undefined) {
				directorPreparedTransactionsByBridgeId.delete(transaction.prepared.id);
			}
			directorPreparedTransactions.delete(turn.id);
		}
	}

	async function execute(request: Request, requester: WebSocketConnection, principalKey: string) {
		if (draining) {
			return sendRequester(
				requester,
				protocolError(request.id, "SHUTTING_DOWN", "daemon is shutting down", true),
			);
		}
		if (seenRequestIds.has(request.id)) {
			return sendRequester(
				requester,
				protocolError(request.id, "INVALID_REQUEST", "request id has already been used", false),
			);
		}
		seenRequestIds.add(request.id);
		if (state.begin(request.id, request.deadline_ms) === "busy") {
			return sendRequester(requester, protocolError(request.id, "BUSY", "one request is already active", true));
		}
		const active = state.current!;
		if (
			request.method === "stage_scene" &&
			!bridgeTransport()?.mutationSession.supportsStageScene
		) {
			state.complete(active);
			state.terminal(active);
			return sendRequester(
				requester,
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
			return sendRequester(
				requester,
				protocolError(request.id, "METHOD_NOT_ALLOWED", "method is not allowed", false),
			);
		}
		requesterTargets.set(request.id, { websocket: requester, principalKey });
		const task = (async () => {
			try {
				const output = await handler(request.params, {
					signal: active.controller.signal,
					request,
					reportProgress: (phase, completed, total) => {
						if (active.phase === "running") {
							sendRequester(requester, { type: "progress", id: active.id, phase, completed, total });
						}
					},
					applyCameraPlan: async (plan, context) => {
						const candidate = await applyCameraPlan(request, plan, context);
						const prepared = preparedMutationCandidate<CameraPlanMutationCandidate>(candidate);
						if (prepared !== undefined) registerPreparedTransaction(request.id, prepared);
						return candidate;
					},
					stageScene: async (plan, context) => {
						const candidate = await stageScene(request, plan, context);
						const prepared = preparedMutationCandidate<StageSceneMutationCandidate>(candidate);
						if (prepared !== undefined) registerPreparedTransaction(request.id, prepared);
						return candidate;
					},
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
				const transaction = directorPreparedTransactions.get(request.id);
				if (transaction !== undefined) {
					transaction.ackSent = true;
					transaction.bridge.sendText(
						parseDaemonBridgeMessage(
							{
								type: "bridge_transaction_ack",
								id: transaction.prepared.id,
								transaction_id: transaction.prepared.transaction_id,
								status: "committed",
								resulting_revision_id: output.resulting_revision_id,
							},
							transaction.mutationSession,
							new Set(),
						),
					);
					await new Promise<void>((resolve, reject) => {
						const abort = () => {
							active.controller.signal.removeEventListener("abort", abort);
							reject(new Error(`${active.cause ?? "CANCELLED"}: transaction acknowledgement was interrupted`));
						};
						active.controller.signal.addEventListener("abort", abort, { once: true });
						transaction.acknowledged.then(() => {
							active.controller.signal.removeEventListener("abort", abort);
							resolve();
						}, reject);
						if (active.controller.signal.aborted) abort();
					});
					directorPreparedTransactions.delete(request.id);
					directorPreparedTransactionsByBridgeId.delete(transaction.prepared.id);
					if (!state.finishDurableCommit(active)) {
						throw new Error("DURABLE_COMMIT_STATE: durable commit state is invalid");
					}
				}
				if (state.complete(active)) {
					state.terminal(active);
					sendTerminal(active.id, { type: "response", id: active.id, ...output });
				}
			} catch (cause) {
				const transaction = directorPreparedTransactions.get(request.id);
				if (transaction !== undefined) {
					if (!transaction.ackSent && !transaction.bridge.socket.destroyed) {
						const causeCode =
							cause instanceof Error && "code" in cause && typeof cause.code === "string"
								? cause.code
								: undefined;
						const code =
							causeCode === "TRANSACTION_CONFLICT"
								? "TRANSACTION_CONFLICT"
								: causeCode === "STALE_BASE" || causeCode === "PROJECT_INVALID"
									? "TRANSACTION_STATE_INVALID"
									: "TRANSACTION_EVIDENCE_INVALID";
						transaction.bridge.sendText(
							parseDaemonBridgeMessage(
								{
									type: "bridge_transaction_error",
									id: transaction.prepared.id,
									transaction_id: transaction.prepared.transaction_id,
									code,
									message:
										code === "TRANSACTION_CONFLICT"
											? "transaction id was reused with different content"
											: code === "TRANSACTION_STATE_INVALID"
												? "transaction phase is invalid"
												: "transaction recovery evidence is invalid",
									retryable: false,
								},
								transaction.mutationSession,
								new Set(),
							),
						);
					}
					directorPreparedTransactions.delete(request.id);
					directorPreparedTransactionsByBridgeId.delete(transaction.prepared.id);
				}
				if (state.complete(active)) {
					state.terminal(active);
					const message = cause instanceof Error ? cause.message : "handler failed";
					const parsed = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/.exec(message);
					const stageSceneUnknown =
						request.method === "stage_scene" && (parsed === null || parsed[1] === "UNKNOWN");
					sendTerminal(
						active.id,
						stageSceneUnknown
							? protocolError(active.id, "STAGE_SCENE_FAILED", "stage_scene operation failed", false)
							: protocolError(active.id, parsed?.[1] ?? "HANDLER_ERROR", parsed?.[2] ?? message, false),
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
			const transaction = directorPreparedTransactions.get(request.id);
			if (transaction !== undefined) {
				directorPreparedTransactionsByBridgeId.delete(transaction.prepared.id);
			}
			directorPreparedTransactions.delete(request.id);
		}
	}

	return {
		projectId,
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
