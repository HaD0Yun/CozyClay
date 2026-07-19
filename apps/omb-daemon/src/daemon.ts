import { randomUUID } from "node:crypto";
import http from "node:http";
import {
	MUTATION_PROTOCOL_VERSION,
	MutationBridgeSession,
	negotiateMutationBridge,
	parseAddonBridgeMessage,
	parseClientMessage,
	parseDaemonBridgeMessage,
	parseHello,
	parseRenderQaFramesRequest,
	parseStartupRecord,
	PROTOCOL_VERSION,
	type BridgeArtifactBegin,
	type BridgeArtifactBatchBegin,
	type BridgeArtifactChunk,
	type CameraPlanV1,
	type CameraPlanMutationCandidate,
	type RenderQaFramesRequestV1,
	type RenderQaFramesResultV1,
	type Request,
} from "@oh-my-blender/protocol";
import { SessionState, type ActiveRequest } from "./session-state.ts";
import { BearerToken, randomNonce, systemClock, type Clock } from "./token.ts";
import { acceptUpgrade, type WebSocketConnection } from "./ws-server.ts";

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
export interface HandlerContext {
	readonly signal: AbortSignal;
	readonly request: Request;
	readonly reportProgress: (phase: string, completed: number, total: number) => void;
	readonly applyCameraPlan: ApplyCameraPlan;
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
	beginArtifactReservation?: BeginArtifactReservation;
	beginArtifactReservations?: BeginArtifactReservations;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	helloTimeoutMs?: number;
	idleTimeoutMs?: number;
};
export type Daemon = {
	port: number;
	startup: ReturnType<typeof parseStartupRecord>;
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
	readonly method: "apply_camera_plan" | "render_qa_frames";
	readonly renderRequest?: RenderQaFramesRequestV1;
	readonly artifactFrames: Map<number, PendingArtifactFrame>;
	totalArtifactBytes: number;
	artifactCleanup?: Promise<void>;
	artifactSetup?: Promise<void>;
	cancelled?: boolean;
	readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
	readonly beginArtifactCommit?: () => void;
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	removeAbortListener(): void;
};

const MAX_RENDER_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_RENDER_BATCH_BYTES = 128 * 1024 * 1024;

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
		await reservation.abort();
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
		await Promise.allSettled(reservations.map((reservation) => reservation.abort()));
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
	frame.chunks.set(chunk.chunk_index, { offset: chunk.byte_offset, byteLength: bytes.byteLength });
	frame.receivedBytes += bytes.byteLength;
}

async function abortArtifactFrames(pending: PendingBridge): Promise<void> {
	await Promise.allSettled(Array.from(pending.artifactFrames.values(), (frame) => frame.reservation.abort()));
	pending.artifactFrames.clear();
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
	}> = [];
	for (const [index, expectedFrame] of pending.renderRequest.frames.entries()) {
		const metadata = raw.frames[index];
		if (
			!isRecord(metadata) ||
			!hasExactKeys(metadata, ["byte_length", "frame", "height", "profile_version", "sha256", "width"]) ||
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
		});
	}

	pending.beginArtifactCommit();
	const frames: RenderQaFramesResultV1["frames"][number][] = [];
	for (const candidate of candidates) {
		const descriptor = await candidate.reservation.commit();
		if (
			descriptor.sha256 !== candidate.sha256 ||
			descriptor.byteLength !== candidate.byteLength ||
			descriptor.uri !== `omb-artifact://sha256/${candidate.sha256}`
		) {
			throw new Error("INVALID_ARTIFACT_DESCRIPTOR: publisher returned mismatched metadata");
		}
		frames.push({
			frame: candidate.frame,
			width: 640,
			height: 360,
			profile_version: "omb-qa-png-v1",
			byte_length: candidate.byteLength,
			sha256: candidate.sha256,
			uri: descriptor.uri,
		});
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
	const token = new BearerToken(clock);
	const launchId = randomUUID();
	const nonces = new Set<string>();
	const seenRequestIds = new Set<string>();
	let accepted = false;
	let connection: WebSocketConnection | undefined;
	let draining = false;
	let idle: ReturnType<typeof setTimeout> | undefined;
	let resolveStopped!: () => void;
	const stopped = new Promise<void>((resolve) => {
		resolveStopped = resolve;
	});
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
	server.on("upgrade", (request, socket) => {
		const websocket = acceptUpgrade(request, socket, token, addressPort(), accepted);
		if (!websocket) return;
		accepted = true;
		connection = websocket;
		run(websocket);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", resolve);
	});
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

	function run(websocket: WebSocketConnection) {
		let helloComplete = false;
		let mutationSession: MutationBridgeSession | undefined;
		let pendingBridge: PendingBridge | undefined;
		let drainPromise: Promise<void> | undefined;
		const activeHandlers = new Set<Promise<void>>();
		let bridgeMessageTail: Promise<void> = Promise.resolve();
		const helloTimer = setTimeout(() => {
			if (!helloComplete) websocket.close(1008, "hello timeout");
		}, options.helloTimeoutMs ?? 3_000);
		const state = new SessionState(clock, (request) => void finishCancellation(request));
		const resetIdle = () => {
			clearTimeout(idle);
			idle = setTimeout(() => websocket.close(1000, "idle"), options.idleTimeoutMs ?? 60_000);
		};
		resetIdle();
		websocket.on("text", (text: string) => {
			resetIdle();
			let isBridgeMessage = false;
			try {
				const value = JSON.parse(text) as { type?: unknown };
				isBridgeMessage = typeof value.type === "string" && value.type.startsWith("bridge_");
			} catch {}
			if (isBridgeMessage) {
				bridgeMessageTail = bridgeMessageTail.then(() => message(text));
			} else {
				void message(text);
			}
		});
		websocket.on("disconnect", () => {
			clearTimeout(helloTimer);
			clearTimeout(idle);
			void drain("DISCONNECT", false);
		});

		async function failPendingBridge(code: string, message: string): Promise<void> {
			if (pendingBridge === undefined) return;
			const pending = pendingBridge;
			pendingBridge = undefined;
			pending.removeAbortListener();
			await abortArtifactFrames(pending);
			pending.reject(new Error(`${code}: ${message}`));
		}

		async function message(text: string) {
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				state.consumeToken();
				return;
			}
			if (!helloComplete) {
				try {
					const hello = parseHello(raw);
					if (nonces.has(hello.client_nonce)) return websocket.close(1008, "nonce reused");
					nonces.add(hello.client_nonce);
					helloComplete = true;
					clearTimeout(helloTimer);
					const ack =
						hello.protocol === MUTATION_PROTOCOL_VERSION
							? {
									type: "hello_ack" as const,
									protocol: MUTATION_PROTOCOL_VERSION,
									daemon_version: "0.1.0",
									launch_id: launchId,
									session_id: randomUUID(),
									server_nonce: randomNonce(),
									capabilities: ["mutation_bridge_v2" as const],
								}
							: {
									type: "hello_ack" as const,
									protocol: PROTOCOL_VERSION,
									daemon_version: "0.1.0",
									launch_id: launchId,
									session_id: randomUUID(),
									server_nonce: randomNonce(),
									capabilities: ["inspect_project"],
								};
					if (hello.protocol === MUTATION_PROTOCOL_VERSION) mutationSession = negotiateMutationBridge(hello, ack);
					websocket.sendText(ack);
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
			if (typeof rawType === "string" && rawType.startsWith("bridge_")) {
				if (mutationSession === undefined || pendingBridge === undefined) return;
				try {
					const bridgeMessage = parseAddonBridgeMessage(raw, mutationSession);
					if (bridgeMessage.id !== pendingBridge.id || bridgeMessage.request_id !== pendingBridge.requestId) return;
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
					const message = error instanceof Error ? error.message : "invalid add-on bridge message";
					const parsed = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/.exec(message);
					await failPendingBridge(parsed?.[1] ?? "INVALID_BRIDGE_MESSAGE", parsed?.[2] ?? message);
				}
				return;
			}
			if (rawType === "request") {
				if (!state.consumeToken()) {
					return websocket.sendText(protocolError((raw as { id?: string }).id ?? "", "RATE_LIMITED", "rate limit exceeded", true));
				}
				const deadline = (raw as { deadline_ms?: unknown }).deadline_ms;
				if (!Number.isInteger(deadline) || (deadline as number) < 100 || (deadline as number) > 30_000) {
					return websocket.sendText(
						protocolError((raw as { id?: string }).id ?? "", "INVALID_DEADLINE", "deadline_ms must be 100..30000", false),
					);
				}
				let request: Request;
				try {
					request = parseClientMessage(raw) as Request;
				} catch {
					return websocket.sendText(protocolError((raw as { id?: string }).id ?? "", "INVALID_REQUEST", "invalid request", false));
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
				websocket.sendText({ type: "cancel_ack", id: parsed.id, status });
				return;
			}
			if (parsed.type === "shutdown") await drain("SHUTDOWN", true);
		}

		async function applyCameraPlan(
			request: Request,
			plan: CameraPlanV1,
			context: Parameters<ApplyCameraPlan>[1],
		): Promise<CameraPlanMutationCandidate> {
			if (mutationSession === undefined) {
				throw new Error("MUTATION_BRIDGE_UNAVAILABLE: apply_camera_plan requires protocol v2");
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
				mutationSession,
				new Set([request.id]),
			);
			return new Promise<CameraPlanMutationCandidate>((resolve, reject) => {
				const abort = () => {
					if (pendingBridge?.id !== id || mutationSession === undefined) return;
					try {
						websocket.sendText(
							parseDaemonBridgeMessage(
								{ type: "bridge_cancel", id, request_id: request.id },
								mutationSession,
								new Set([request.id]),
							),
						);
					} catch {
						void failPendingBridge("CANCELLED", "mutation bridge cancellation failed");
					}
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
				websocket.sendText(bridgeRequest);
				if (signal?.aborted) abort();
			});
		}

		async function renderQaFrames(
			request: Request,
			requestValue: RenderQaFramesRequestV1,
			context: Parameters<RenderQaFrames>[1],
			beginArtifactCommit: () => void,
		): Promise<RenderQaFramesResultV1> {
			if (mutationSession === undefined) {
				throw new Error("RENDER_BRIDGE_UNAVAILABLE: render_qa_frames requires protocol v2");
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
				mutationSession,
				new Set([request.id]),
			);
			return new Promise<RenderQaFramesResultV1>((resolve, reject) => {
				const abort = () => {
					if (pendingBridge?.id !== id || mutationSession === undefined) return;
					pendingBridge.cancelled = true;
					const cancellingBridge = pendingBridge;
					pendingBridge.artifactCleanup = (async () => {
						try {
							await cancellingBridge.artifactSetup;
						} catch {}
						await abortArtifactFrames(cancellingBridge);
					})();
					try {
						websocket.sendText(
							parseDaemonBridgeMessage(
								{ type: "bridge_cancel", id, request_id: request.id },
								mutationSession,
								new Set([request.id]),
							),
						);
					} catch {
						void failPendingBridge("CANCELLED", "render bridge cancellation failed");
					}
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
				websocket.sendText(bridgeRequest);
				if (signal?.aborted) abort();
			});
		}

		async function execute(request: Request) {
			if (draining) return websocket.sendText(protocolError(request.id, "SHUTTING_DOWN", "daemon is shutting down", true));
			if (seenRequestIds.has(request.id)) {
				return websocket.sendText(protocolError(request.id, "INVALID_REQUEST", "request id has already been used", false));
			}
			seenRequestIds.add(request.id);
			if (state.begin(request.id, request.deadline_ms) === "busy") {
				return websocket.sendText(protocolError(request.id, "BUSY", "one request is already active", true));
			}
			const active = state.current!;
			const handler = options.handlers[request.method];
			if (!handler) {
				state.complete(active);
				state.terminal(active);
				return websocket.sendText(protocolError(request.id, "METHOD_NOT_ALLOWED", "method is not allowed", false));
			}
			const task = (async () => {
				try {
					const output = await handler(request.params, {
						signal: active.controller.signal,
						request,
						reportProgress: (phase, completed, total) => {
							if (active.phase === "running") {
								websocket.sendText({ type: "progress", id: active.id, phase, completed, total });
							}
						},
						applyCameraPlan: (plan, context) => applyCameraPlan(request, plan, context),
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
						websocket.sendText({ type: "response", id: active.id, ...output });
					}
				} catch (cause) {
					if (state.complete(active)) {
						state.terminal(active);
						const message = cause instanceof Error ? cause.message : "handler failed";
						const parsed = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/.exec(message);
						websocket.sendText(
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
			}
		}

		async function finishCancellation(request: ActiveRequest) {
			if (pendingBridge?.requestId === request.id) {
				await pendingBridge.artifactCleanup;
			}
			if (state.terminal(request) && !websocket.socket.destroyed) {
				websocket.sendText(
					protocolError(
						request.id,
						request.cause === "TIMEOUT" ? "TIMEOUT" : "CANCELLED",
						request.cause === "TIMEOUT" ? "deadline expired" : "request cancelled",
						false,
					),
				);
			}
		}

		function drain(cause: "SHUTDOWN" | "DISCONNECT", acknowledge: boolean): Promise<void> {
			if (drainPromise) return drainPromise;
			draining = true;
			server.close();
			const active = state.current;
			if (active) state.cancel(active.id, cause);
			drainPromise = (async () => {
				if (cause === "DISCONNECT") {
					await failPendingBridge("DISCONNECT", "add-on disconnected during mutation");
				}
				if (activeHandlers.size) {
					let timer: ReturnType<typeof setTimeout> | undefined;
					const bounded = new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 5_000);
					});
					await Promise.race([Promise.allSettled(Array.from(activeHandlers)), bounded]);
					clearTimeout(timer);
				}
				if (acknowledge && !websocket.socket.destroyed) websocket.sendText({ type: "shutdown_ack" });
				if (!websocket.socket.destroyed) websocket.close(1000);
				clearTimeout(idle);
				token.zero();
				try {
					await closeServer();
				} catch (error) {
					(options.stderr ?? ((line) => process.stderr.write(`${line}\n`)))(
						`daemon cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				resolveStopped();
			})();
			return drainPromise;
		}
	}

	return {
		port: addressPort(),
		startup,
		stopped,
		close: async () => {
			draining = true;
			clearTimeout(idle);
			connection?.close(1000);
			token.zero();
			await closeServer();
			resolveStopped();
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
