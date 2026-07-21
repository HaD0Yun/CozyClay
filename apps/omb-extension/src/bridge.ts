// In-extension Blender bridge (option A): owns the WebSocket server that Blender
// attaches to, performs the protocol-v2 hello handshake, and drives the
// bridge_request/bridge_result loop for the four director tools. Discovery-slot
// credential ceremony and controller-peer auth are intentionally dropped; a
// plain bearer token gates the loopback socket. Durable transaction commit and
// auto-reconnect are retained.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import {
	type BridgeTransactionPrepared,
	type CameraPlanMutationCandidate,
	type CameraPlanV1,
	type MutationBridgeSession,
	negotiateMutationBridge,
	parseAddonBridgeMessage,
	parseDaemonBridgeMessage,
	parseSceneSnapshot,
	parseRenderQaFramesResult,
	type RenderQaFramesRequestV1,
	type RenderQaFramesResultV1,
	type SceneSnapshot,
	type StageSceneMutationCandidate,
	type StageScenePlanV1,
} from "@oh-my-blender/protocol";
import { acceptUpgrade, readClientRole, type WebSocketConnection } from "./ws-server.ts";

const BOOTSTRAP_REVISION_ID = "0".repeat(64);
const HASH_64 = /^[0-9a-f]{64}$/;
const BRIDGE_OP_DEADLINE_MAX_MS = 30_000;
const DAEMON_VERSION = "0.1.0";

export interface BridgeEndpoint {
	readonly host: "127.0.0.1";
	readonly port: number;
	readonly token: string;
	readonly launchId: string;
}

export interface BridgeProgress {
	readonly phase: string;
	readonly completed: number;
	readonly total: number;
}

export interface PreparedMutationCandidate<T> {
	readonly candidate: T;
	readonly transaction: BridgeTransactionPrepared;
	readonly requestId: string;
}

interface PendingBridge {
	readonly id: string;
	readonly requestId: string;
	readonly method: string;
	readonly reportProgress?: (progress: BridgeProgress) => void;
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	preparedTransaction?: BridgeTransactionPrepared;
	renderRequest?: RenderQaFramesRequestV1;
	artifactFrames: Map<number, ArtifactFrame>;
}

interface AttachedTransport {
	readonly websocket: WebSocketConnection;
	readonly session: MutationBridgeSession;
}

interface PendingTransaction {
	readonly prepared: BridgeTransactionPrepared;
	readonly session: MutationBridgeSession;
	readonly websocket: WebSocketConnection;
	readonly acknowledged: Promise<void>;
	readonly resolveAcknowledged: () => void;
}

interface ArtifactFrame {
	readonly totalChunks: number;
	readonly totalByteLength: number;
	readonly sha256: string;
	readonly chunks: Map<number, Buffer>;
	receivedBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Owns the Blender-facing WebSocket. A single bridge operation may be in flight
 * at a time (Blender mutates on its main thread); callers must serialize.
 */
export class BlenderBridge {
	private server: Server | undefined;
	private token = "";
	private readonly launchId = randomUUID();
	private transport: AttachedTransport | undefined;
	private pending: PendingBridge | undefined;
	private preparedTransaction: PendingTransaction | undefined;
	private projectId: string | undefined;
	private currentRevisionId = BOOTSTRAP_REVISION_ID;
	private readonly activeRequestIds = new Set<string>();
	private attachWaiters: Array<() => void> = [];
	private readonly projectDirectory: string;

	constructor(projectDirectory = process.cwd()) {
		this.projectDirectory = projectDirectory;
	}

	async start(): Promise<BridgeEndpoint> {
		if (this.server !== undefined) throw new Error("bridge already started");
		this.token = randomBytes(32).toString("base64url");
		const server = createServer((_request, response) => {
			response.writeHead(426, { "content-length": "0" });
			response.end();
		});
		server.on("upgrade", (request, socket, head) => {
			if (head.length > 0) {
				socket.destroy();
				return;
			}
			const port = (server.address() as { port: number }).port;
			const role = readClientRole(request);
			if (role !== "bridge") {
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
				return;
			}
			const websocket = acceptUpgrade(request, socket, port, (credential) => credential === this.token);
			if (websocket === undefined) return;
			this.attachConnection(websocket);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.server = server;
		const port = (server.address() as { port: number }).port;
		return { host: "127.0.0.1", port, token: this.token, launchId: this.launchId };
	}

	async close(): Promise<void> {
		this.failPending("BRIDGE_CLOSED", "bridge is shutting down");
		this.transport?.websocket.close(1001, "bridge shutdown");
		this.transport = undefined;
		const server = this.server;
		this.server = undefined;
		if (server !== undefined) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	/** Resolves once Blender has attached and completed the hello handshake. */
	waitForAttach(signal?: AbortSignal): Promise<void> {
		if (this.transport !== undefined) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const onResolve = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = () => {
				this.attachWaiters = this.attachWaiters.filter((waiter) => waiter !== onResolve);
				reject(new Error("ATTACH_ABORTED: waiting for Blender to attach was aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.attachWaiters.push(onResolve);
		});
	}

	get attached(): boolean {
		return this.transport !== undefined;
	}

	get revisionId(): string {
		return this.currentRevisionId;
	}

	async inspectProject(): Promise<{ readonly revision: string; readonly snapshot: SceneSnapshot }> {
		const result = await this.runBridgeRequest("inspect_project", {}, this.currentRevisionId);
		if (
			!isRecord(result) ||
			typeof result.revision !== "string" ||
			!HASH_64.test(result.revision) ||
			(this.currentRevisionId !== BOOTSTRAP_REVISION_ID && result.revision !== this.currentRevisionId)
		) {
			throw new Error("INVALID_INSPECT_RESULT: bridge inspection does not bind the expected revision");
		}
		const snapshot = parseSceneSnapshot(result.snapshot);
		this.currentRevisionId = result.revision;
		return { revision: result.revision, snapshot };
	}

	async inspectEntity(
		entityId: string,
		scope: "bones" | "animation" | "material" | "all",
	): Promise<Record<string, unknown>> {
		const result = await this.runBridgeRequest(
			"inspect_entity",
			{ entity_id: entityId, scope },
			this.currentRevisionId,
		);
		if (!isRecord(result) || typeof result.revision !== "string" || !HASH_64.test(result.revision)) {
			throw new Error("INVALID_INSPECT_ENTITY_RESULT: bridge did not return a bound revision");
		}
		return result;
	}

	/** Whether a Blender add-on peer is currently attached over the bridge. */
	isAttached(): boolean {
		return this.transport !== undefined;
	}

	/** Project id advertised by the attached Blender peer, if any. */
	get attachedProjectId(): string | undefined {
		return this.projectId;
	}

	async stageScene(
		plan: StageScenePlanV1,
		context: { readonly signal?: AbortSignal; readonly reportProgress: (progress: BridgeProgress) => void },
	): Promise<PreparedMutationCandidate<StageSceneMutationCandidate>> {
		const result = await this.runBridgeRequest("stage_scene", plan, plan.expected_revision_id, context);
		return this.requirePreparedCandidate<StageSceneMutationCandidate>(result);
	}

	async applyCameraPlan(
		plan: CameraPlanV1,
		context: { readonly signal?: AbortSignal; readonly reportProgress: (progress: BridgeProgress) => void },
	): Promise<PreparedMutationCandidate<CameraPlanMutationCandidate>> {
		const result = await this.runBridgeRequest("apply_camera_plan", plan, plan.expected_revision_id, context);
		return this.requirePreparedCandidate<CameraPlanMutationCandidate>(result);
	}

	async renderQaFrames(
		request: RenderQaFramesRequestV1,
		context: { readonly signal?: AbortSignal; readonly reportProgress: (progress: BridgeProgress) => void },
	): Promise<RenderQaFramesResultV1> {
		if (request.revision_id !== this.currentRevisionId) {
			throw new Error("STALE_BASE: render request is not based on the current revision");
		}
		const result = await this.runBridgeRequest(
			"render_qa_frames",
			request,
			request.revision_id,
			{ ...context, renderRequest: request },
		);
		return parseRenderQaFramesResult(result);
	}

	async finishDurableCommit(resultingRevisionId: string): Promise<void> {
		const transaction = this.preparedTransaction;
		if (transaction === undefined) {
			throw new Error("DURABLE_COMMIT_STATE: no prepared Blender transaction");
		}
		if (transaction.prepared.candidate_revision_id !== resultingRevisionId) {
			throw new Error("TRANSACTION_CONFLICT: committed revision does not match Blender candidate");
		}
		transaction.websocket.sendText(
			parseDaemonBridgeMessage(
				{
					type: "bridge_transaction_ack",
					id: transaction.prepared.id,
					transaction_id: transaction.prepared.transaction_id,
					status: "committed",
					resulting_revision_id: resultingRevisionId,
				},
				transaction.session,
				new Set(),
			),
		);
		await transaction.acknowledged;
		this.preparedTransaction = undefined;
		this.currentRevisionId = resultingRevisionId;
	}

	private requirePreparedCandidate<T>(result: unknown): PreparedMutationCandidate<T> {
		if (!isRecord(result) || !("candidate" in result) || !("transaction" in result) || !("requestId" in result)) {
			throw new Error("TRANSACTION_EVIDENCE_INVALID: mutation returned no prepared transaction");
		}
		return result as unknown as PreparedMutationCandidate<T>;
	}

	private attachConnection(websocket: WebSocketConnection): void {
		let session: MutationBridgeSession | undefined;
		websocket.on("text", (text: string) => {
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				websocket.close(1008, "invalid json");
				return;
			}
			if (session === undefined) {
				try {
					session = this.completeHandshake(websocket, raw);
				} catch {
					websocket.close(1008, "invalid hello");
				}
				return;
			}
			void this.handleBridgeMessage(session, raw);
		});
		websocket.on("disconnect", () => {
			if (this.transport?.websocket === websocket) {
				this.transport = undefined;
				this.failPending("BRIDGE_DISCONNECTED", "Blender bridge disconnected");
			}
		});
	}

	private completeHandshake(websocket: WebSocketConnection, hello: unknown): MutationBridgeSession {
		if (!isRecord(hello) || hello.type !== "hello") {
			throw new Error("expected hello");
		}
		if (typeof hello.project_id !== "string") {
			throw new Error("hello project id missing");
		}
		if (this.projectId !== undefined && this.projectId !== hello.project_id) {
			throw new Error("hello project id changed");
		}
		this.projectId = hello.project_id;
		const capabilities = Array.isArray(hello.capabilities) ? (hello.capabilities as string[]) : [];
		const helloAck = {
			type: "hello_ack",
			protocol: 2,
			daemon_version: DAEMON_VERSION,
			launch_id: this.launchId,
			session_id: randomUUID(),
			server_nonce: randomBytes(16).toString("base64url"),
			// Echo the intersection; Blender always offers the full triple.
			capabilities,
		};
		const session = negotiateMutationBridge(hello, helloAck);
		websocket.sendText(helloAck);
		this.transport = { websocket, session };
		const waiters = this.attachWaiters;
		this.attachWaiters = [];
		for (const waiter of waiters) waiter();
		return session;
	}

	private async handleBridgeMessage(session: MutationBridgeSession, raw: unknown): Promise<void> {
		let message: ReturnType<typeof parseAddonBridgeMessage>;
		try {
			message = parseAddonBridgeMessage(raw, session);
		} catch {
			return; // Ignore malformed frames; the deadline reaps a stuck op.
		}
		const pending = this.pending;
		if (message.type === "bridge_transaction_acknowledged") {
			const transaction = this.preparedTransaction;
			if (
				transaction !== undefined &&
				message.id === transaction.prepared.id &&
				message.transaction_id === transaction.prepared.transaction_id
			) {
				transaction.resolveAcknowledged();
			}
			return;
		}
		if (message.type === "bridge_transaction_prepared") {
			if (
				pending === undefined ||
				message.id !== pending.id ||
				message.operation !== pending.method ||
				message.project_id !== this.projectId
			) {
				return;
			}
			if (
				pending.preparedTransaction !== undefined &&
				JSON.stringify(pending.preparedTransaction) !== JSON.stringify(message)
			) {
				this.failPending("TRANSACTION_EVIDENCE_INVALID", "transaction id was reused with different content");
				return;
			}
			pending.preparedTransaction = message;
			return;
		}
		if (message.type === "bridge_artifact_batch_begin") {
			if (pending === undefined || message.id !== pending.id) return;
			for (const frame of message.frames) {
				pending.artifactFrames.set(frame.frame, {
					totalChunks: frame.total_chunks,
					totalByteLength: frame.total_byte_length,
					sha256: frame.sha256,
					chunks: new Map(),
					receivedBytes: 0,
				});
			}
			return;
		}
		if (message.type === "bridge_artifact_begin") {
			if (pending === undefined || message.id !== pending.id) return;
			pending.artifactFrames.set(message.frame, {
				totalChunks: message.total_chunks,
				totalByteLength: message.total_byte_length,
				sha256: message.sha256,
				chunks: new Map(),
				receivedBytes: 0,
			});
			return;
		}
		if (message.type === "bridge_artifact_chunk") {
			if (pending === undefined || message.id !== pending.id) return;
			const artifact = pending.artifactFrames.get(message.frame);
			if (artifact === undefined || artifact.chunks.has(message.chunk_index)) {
				this.failPending("INVALID_RENDER_QA_RESULT", "artifact chunk has no declaration or is duplicated");
				return;
			}
			const bytes = Buffer.from(message.data_base64, "base64");
			if (bytes.byteLength !== message.byte_length || artifact.receivedBytes !== message.byte_offset) {
				this.failPending("INVALID_RENDER_QA_RESULT", "artifact chunk offset or length is invalid");
				return;
			}
			artifact.chunks.set(message.chunk_index, bytes);
			artifact.receivedBytes += bytes.byteLength;
			return;
		}
		if (pending === undefined) return;
		if (message.type === "bridge_progress" && message.id === pending.id) {
			pending.reportProgress?.({ phase: message.phase, completed: message.completed, total: message.total });
			return;
		}
		if (message.type === "bridge_result" && message.id === pending.id) {
			const result =
				pending.preparedTransaction === undefined
					? message.result
					: {
							candidate: message.result,
							transaction: pending.preparedTransaction,
							requestId: pending.requestId,
						};
			if (pending.preparedTransaction !== undefined) {
				let resolveAcknowledged!: () => void;
				const acknowledged = new Promise<void>((resolve) => {
					resolveAcknowledged = resolve;
				});
				this.preparedTransaction = {
					prepared: pending.preparedTransaction,
					session,
					websocket: this.transport!.websocket,
					acknowledged,
					resolveAcknowledged,
				};
			}
			const resolved =
				pending.renderRequest === undefined ? result : await this.finalizeRenderResult(pending, result);
			this.settle(pending, () => pending.resolve(resolved));
			return;
		}
		if (message.type === "bridge_error" && message.id === pending.id) {
			this.settle(pending, () => pending.reject(new Error(`${message.code}: ${message.message}`)));
			return;
		}
	}

	private async finalizeRenderResult(pending: PendingBridge, raw: unknown): Promise<RenderQaFramesResultV1> {
		if (
			pending.renderRequest === undefined ||
			!isRecord(raw) ||
			raw.schema_version !== 1 ||
			raw.revision_id !== pending.renderRequest.revision_id ||
			raw.profile_version !== "omb-qa-png-v1" ||
			!Array.isArray(raw.frames)
		) {
			throw new Error("INVALID_RENDER_QA_RESULT: final bridge metadata is invalid");
		}
		const artifactDirectory = path.join(this.projectDirectory, ".omb", "artifacts", "sha256");
		await mkdir(artifactDirectory, { recursive: true });
		const frames: RenderQaFramesResultV1["frames"][number][] = [];
		for (const metadata of raw.frames) {
			if (!isRecord(metadata) || typeof metadata.frame !== "number" || !isRecord(metadata.image)) {
				throw new Error("INVALID_RENDER_QA_RESULT: frame metadata is invalid");
			}
			const artifact = pending.artifactFrames.get(metadata.frame);
			if (
				artifact === undefined ||
				artifact.chunks.size !== artifact.totalChunks ||
				artifact.receivedBytes !== artifact.totalByteLength
			) {
				throw new Error("INVALID_RENDER_QA_RESULT: artifact chunks are incomplete");
			}
			const bytes = Buffer.concat(
				[...artifact.chunks.entries()].sort(([left], [right]) => left - right).map(([, value]) => value),
			);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			if (sha256 !== artifact.sha256 || metadata.sha256 !== sha256 || metadata.byte_length !== bytes.byteLength) {
				throw new Error("INVALID_RENDER_QA_RESULT: artifact digest or length changed");
			}
			if (metadata.image.data_base64 !== bytes.toString("base64") || metadata.image.mime_type !== "image/png") {
				throw new Error("INVALID_RENDER_QA_RESULT: model image does not match streamed artifact");
			}
			await writeFile(path.join(artifactDirectory, `${sha256}.png`), bytes, { mode: 0o600 });
			frames.push({
				...(metadata as unknown as Omit<RenderQaFramesResultV1["frames"][number], "uri">),
				uri: `omb-artifact://sha256/${sha256}`,
			});
		}
		return parseRenderQaFramesResult({
			schema_version: 1,
			revision_id: pending.renderRequest.revision_id,
			profile_version: "omb-qa-png-v1",
			frames,
		});
	}
	private settle(pending: PendingBridge, run: () => void): void {
		if (this.pending !== pending) return;
		this.pending = undefined;
		this.activeRequestIds.delete(pending.requestId);
		run();
	}

	private failPending(code: string, message: string): void {
		const pending = this.pending;
		if (pending === undefined) return;
		this.pending = undefined;
		this.activeRequestIds.delete(pending.requestId);
		pending.reject(new Error(`${code}: ${message}`));
	}

	private runBridgeRequest(
		method: string,
		params: Record<string, unknown>,
		expectedRevisionId: string,
		options: {
			signal?: AbortSignal;
			reportProgress?: (progress: BridgeProgress) => void;
			renderRequest?: RenderQaFramesRequestV1;
		} = {},
	): Promise<unknown> {
		const transport = this.transport;
		if (transport === undefined) {
			return Promise.reject(new Error("MUTATION_BRIDGE_UNAVAILABLE: no attached protocol-v2 bridge"));
		}
		if (this.pending !== undefined) {
			return Promise.reject(new Error("BUSY: one protocol-v2 bridge operation is already open"));
		}
		const id = randomUUID();
		const requestId = randomUUID();
		this.activeRequestIds.add(requestId);
		let bridgeRequest: unknown;
		try {
			bridgeRequest = parseDaemonBridgeMessage(
				{
					type: "bridge_request",
					id,
					request_id: requestId,
					method,
					params,
					expected_revision_id: expectedRevisionId,
					deadline_ms: BRIDGE_OP_DEADLINE_MAX_MS,
				},
				transport.session,
				this.activeRequestIds,
			);
		} catch (error) {
			this.activeRequestIds.delete(requestId);
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return new Promise<unknown>((resolve, reject) => {
			const pending: PendingBridge = {
				id,
				requestId,
				method,
				reportProgress: options.reportProgress,
				resolve,
				reject,
				renderRequest: options.renderRequest,
				artifactFrames: new Map(),
			};
			this.pending = pending;
			const signal = options.signal;
			if (signal !== undefined) {
				const onAbort = () => {
					try {
						transport.websocket.sendText({ type: "bridge_cancel", id, request_id: requestId });
					} catch {
						// Cancellation is best-effort; the deadline still reaps it.
					}
					this.settle(pending, () => reject(new Error("CANCELLED: bridge operation cancelled")));
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			transport.websocket.sendText(bridgeRequest);
		});
	}
}
