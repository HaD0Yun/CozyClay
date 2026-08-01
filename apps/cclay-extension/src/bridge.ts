// Blender-owned loopback bridge client. The add-on publishes discovery and
// owns the listener; this process reconnects when that generation changes.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import path from "node:path";
import {
	type BridgeTransactionPrepared,
	type CameraPlanMutationCandidate,
	type CameraPlanV1,
	type MotionPreflightResultV1,
	type BlenderBridgeDiscoveryV1,
	type ExecuteBlenderPythonRequestV1,
	type ExecuteBlenderPythonResponseV1,
	type ExecuteBlenderPythonResultV1,
	type GetExecutionOutcomeResponseV1,
	parseBlenderBridgeDiscovery,
	parseBlenderBridgeHelloAck,
	parseBlenderBridgeHelloReject,
	parseExecuteBlenderPythonRequest,
	parseExecuteBlenderPythonResponse,
	parseGetExecutionOutcomeResponse,
	parseMotionPreflightResult,
	type InspectPoseContactsParamsV1,
	parsePoseContactsResult,
	type PoseContactsResultV1,
	parseSceneRelationsResult,
	parseProduceDirectingEvidenceResult,
	parseSceneSnapshot,
	parseRenderQaFramesResult,
	parseViewportCaptureRequest,
	parseViewportCaptureResult,
	type ProduceDirectingEvidenceResultV1,
	type RenderQaFramesRequestV1,
	type RenderQaFramesResultV1,
	type ViewportCaptureResultV1,
	type SceneRelationsResultV1,
	type SceneSnapshot,
	type StageSceneMutationCandidate,
	type StageScenePlanV1,
} from "@cclay/protocol";
import type { InspectEntityOptions } from "@cclay/blender-tools";

const BOOTSTRAP_REVISION_ID = "0".repeat(64);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const HASH_64 = /^[0-9a-f]{64}$/;
const BRIDGE_OP_DEADLINE_MAX_MS = 30_000;
const BRIDGE_OP_DEADLINE_GRACE_MS = 5_000;
const ADDON_MANIFEST_URL = new URL(
	"../../../blender-addon/cclay/blender_manifest.toml",
	import.meta.url,
);
const ADDON_STALE_GUIDANCE =
	"close Blender and run cclay again (the launcher will reinstall the current add-on)";
const CLIENT_CAPABILITY = "execute_blender_python_v1";
const HANDSHAKE_TIMEOUT_MS = 5_000;
const EXECUTION_MUTATING_METHODS: ReadonlySet<string> = new Set([
	"execute_blender_python",
	"stage_scene",
	"apply_camera_plan",
	"create_fall_motion",
	"replace_camera_action",
	"apply_performance_mode",
]);


/** Repo-truth addon version from blender_manifest.toml (loud startup failure). */
export function expectedAddonVersion(manifestUrl: URL = ADDON_MANIFEST_URL): string {
	const version = readFileSync(manifestUrl, "utf8").match(/^version = "([^"]+)"/m)?.[1];
	if (version === undefined) throw new Error("blender_manifest.toml yielded no add-on version");
	return version;
}
const EXPECTED_ADDON_VERSION = expectedAddonVersion();

export type BridgeEndpoint = BlenderBridgeDiscoveryV1;

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
	lastPhase?: string;
	readonly reject: (error: Error) => void;
	preparedTransaction?: BridgeTransactionPrepared;
	renderRequest?: RenderQaFramesRequestV1;
	artifactFrames: Map<number, ArtifactFrame>;
	deadlineTimer?: ReturnType<typeof setTimeout>;
	executionBaseRevisionId?: string;
	outcomeRequestId?: string;
}

interface AttachedTransport {
	readonly socket: Socket;
	readonly generation: number;
}

interface PendingTransaction {
	readonly prepared: BridgeTransactionPrepared;
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

/** One JSONL bridge event log per project; diagnostics must never throw. */
function appendBridgeLog(projectDirectory: string, entry: Record<string, unknown>): void {
	const directory = path.join(projectDirectory, ".cclay");
	const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
	void mkdir(directory, { recursive: true, mode: 0o700 })
		.then(() => appendFile(path.join(directory, "bridge.log"), line, { encoding: "utf8", mode: 0o600 }))
		.catch(() => {});
}

/**
 * Blender-owned loopback bridge client. A single bridge operation may be in
 * flight at a time (Blender mutates on its main thread); this client
 * serializes operations through a FIFO promise-chain queue. Cancellation and
 * deadlines are advisory only: an interrupted request may have reached
 * Blender, so reconnect outcome lookup remains authoritative.
 */
export class BlenderBridge {
	private started = false;
	private transport: AttachedTransport | undefined;
	private endpoint: BlenderBridgeDiscoveryV1 | undefined;
	private readonly receiveBuffers = new WeakMap<Socket, Buffer>();
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private connectingSocket: Socket | undefined;
	private pending: PendingBridge | undefined;
	private preparedTransaction: PendingTransaction | undefined;
	private projectId: string | undefined;
	private addonVersion: string | undefined;
	private currentRevisionId = BOOTSTRAP_REVISION_ID;
	private readonly activeRequestIds = new Set<string>();
	private bridgeQueueTail: Promise<void> = Promise.resolve();
	private attachWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	private staleAddonMessage: string | undefined;
	private readonly projectDirectory: string;
	private readonly operationTimeoutMs: number;
	private executionMutationFreezeReason: string | undefined;

	constructor(
		projectDirectory = process.cwd(),
		options: { readonly operationTimeoutMs?: number; readonly projectId?: string } = {},
	) {
		this.projectDirectory = projectDirectory;
		this.projectId = options.projectId;
		this.operationTimeoutMs =
			options.operationTimeoutMs ?? BRIDGE_OP_DEADLINE_MAX_MS + BRIDGE_OP_DEADLINE_GRACE_MS;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("bridge already started");
		this.started = true;
		// Blender publishes discovery asynchronously. Extension load must remain
		// usable while Blender is opening; waitForAttach exposes actionable skew.
		this.scheduleReconnect(0);
	}

	async close(): Promise<void> {
		this.started = false;
		if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.rejectAttachWaiters(new Error("BRIDGE_CLOSED: bridge is shutting down"));
		this.failPending("BRIDGE_CLOSED", "bridge is shutting down");
		this.transport?.socket.destroy();
		this.connectingSocket?.destroy();
		this.transport = undefined;
	}

	inspectBridgeState(): Record<string, unknown> {
		return {
			attached: this.transport !== undefined,
			project_id: this.projectId ?? null,
			revision_id: this.currentRevisionId,
			pending_method: this.pending?.method ?? null,
			prepared_transaction_id: this.preparedTransaction?.prepared.transaction_id ?? null,
			attach_failure: this.staleAddonMessage ?? null,
			addon_version: this.addonVersion ?? null,
			token_generation: this.endpoint?.token_generation ?? null,
		};
	}

	repairBridge(): Record<string, unknown> {
		const before = this.inspectBridgeState();
		if (this.preparedTransaction !== undefined) {
			throw new Error(
				"TRANSACTION_RECONCILIATION_REQUIRED: cannot repair bridge while a prepared Blender transaction is unresolved",
			);
		}
		this.failPending("BRIDGE_REPAIR_REMOVED_STALE_PENDING", `repair removed stale bridge operation${this.pendingDiagnostics()}`);
		this.transport?.socket.destroy();
		this.connectingSocket?.destroy();
		this.transport = undefined;
		this.scheduleReconnect(0);
		appendBridgeLog(this.projectDirectory, { event: "bridge_repair", before });
		return { ...before, repaired: true, attached: false };
	}

	waitForAttach(signal?: AbortSignal): Promise<void> {
		if (this.transport !== undefined) return Promise.resolve();
		if (this.staleAddonMessage !== undefined) return Promise.reject(new Error(this.staleAddonMessage));
		this.scheduleReconnect(0);
		return new Promise<void>((resolve, reject) => {
			let waiter: { resolve: () => void; reject: (error: Error) => void };
			const onAbort = () => {
				this.attachWaiters = this.attachWaiters.filter((candidate) => candidate !== waiter);
				this.applyReconnectTimerRef();
				reject(new Error("ATTACH_ABORTED: waiting for Blender connection was aborted"));
			};
			waiter = {
				resolve: () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.attachWaiters.push(waiter);
			this.applyReconnectTimerRef();
		});
	}

	/** ADDON_STALE message from the last refused attach, if any. */
	get attachFailure(): string | undefined {
		return this.staleAddonMessage;
	}

	get attached(): boolean {
		return this.transport !== undefined;
	}

	get revisionId(): string {
		return this.currentRevisionId;
	}

	/**
	 * Clears the local execution safety freeze after a human has verified the
	 * Blender project state.
	 */
	clearExecutionMutationFreeze(): void {
		this.executionMutationFreezeReason = undefined;
	}

	get executionMutationFrozen(): boolean {
		return this.executionMutationFreezeReason !== undefined;
	}

	async inspectProject(): Promise<{ readonly revision: string; readonly snapshot: SceneSnapshot }> {
		const result = await this.runBridgeRequest("inspect_project", {}, () => this.currentRevisionId);
		if (!isRecord(result) || typeof result.revision !== "string" || !HASH_64.test(result.revision)) {
			throw new Error("INVALID_INSPECT_RESULT: bridge inspection result is malformed");
		}
		const snapshot = parseSceneSnapshot(result.snapshot);
		// Inspect is the universal STALE_BASE recovery path: the addon serves the
		// authoritative durable (or live-rebound) truth, so adopt the returned
		// revision even when it differs from the previously cached expectation.
		// Mutating bridge methods keep their strict revision binding.
		this.currentRevisionId = result.revision;
		return { revision: result.revision, snapshot };
	}

	async inspectEntity(entityId: string, options: InspectEntityOptions): Promise<Record<string, unknown>> {
		// Closed param projection (captureViewport/inspectRelations precedent):
		// build the wire params explicitly instead of spreading the caller's
		// object, so an options key carrying an extra field — or a rogue
		// `entity_id` that would shadow the argument — can never reach the
		// add-on. The add-on rejects unknown params as protocol skew
		// (INSPECT_ENTITY_PARAM_KEYS), so this guard keeps both sides closed.
		const { scope, data_path_filter, frame_start, frame_end } = options;
		// TypeBox validates the cross-field-independent bounds, but the
		// `frame_start <= frame_end` rule spans two fields and cannot be
		// expressed in the schema. Reject it here so the TS side matches the
		// add-on's INVALID_INSPECT_ENTITY_PARAMS refusal without a round trip.
		if (frame_start !== undefined && frame_end !== undefined && frame_start > frame_end) {
			throw new Error(
				`INVALID_INSPECT_ENTITY_REQUEST: frame_start (${frame_start}) must be <= frame_end (${frame_end})`,
			);
		}
		const params: Record<string, unknown> = { entity_id: entityId, scope };
		if (data_path_filter !== undefined) params.data_path_filter = data_path_filter;
		if (frame_start !== undefined) params.frame_start = frame_start;
		if (frame_end !== undefined) params.frame_end = frame_end;
		const result = await this.runBridgeRequest(
			"inspect_entity",
			params,
			() => this.currentRevisionId,
		);
		if (!isRecord(result) || typeof result.revision !== "string" || !HASH_64.test(result.revision)) {
			throw new Error("INVALID_INSPECT_ENTITY_RESULT: bridge did not return a bound revision");
		}
		// The detail payload's shape is scope-dependent and intentionally open
		// (bones hierarchy, animation curve summaries, material node inputs,
		// or all of them), so a full closed schema here would couple the
		// bridge to every add-on section and stomp on the deterministic
		// truncation the add-on already performs. The actual failure mode being
		// guarded is context-window blowup: an oversized result destroys the
		// model conversation. So verify the minimal envelope the add-on
		// promises (entity_id, scope, object detail) and cap the serialized
		// byte length instead of enumerating every field.
		if (typeof result.entity_id !== "string" || typeof result.scope !== "string" || !isRecord(result.detail)) {
			throw new Error(
				"INVALID_INSPECT_ENTITY_RESULT: bridge did not return entity_id, scope, and object detail",
			);
		}
		// Bind the answer to the question: a result describing another entity or
		// another scope would silently become the model's picture of the entity
		// it asked about.
		if (result.entity_id !== entityId || result.scope !== scope) {
			throw new Error(
				`INVALID_INSPECT_ENTITY_RESULT: result binds ${result.entity_id}/${result.scope}, not the requested ${entityId}/${scope}`,
			);
		}
		// Encoded UTF-8 bytes, not UTF-16 code units: a rig with non-ASCII bone
		// names costs more bytes than characters, and the ceiling is a byte
		// ceiling.
		const serializedLength = Buffer.byteLength(JSON.stringify(result), "utf8");
		// 64 KiB hard ceiling: the add-on reduces deterministically to stay
		// under it, but a misbehaving or older add-on could still emit an
		// oversized payload — refuse it before it reaches the model context.
		if (serializedLength > 65536) {
			throw new Error(
				`INVALID_INSPECT_ENTITY_RESULT: detail payload exceeds the 64 KiB ceiling (${serializedLength} bytes)`,
			);
		}
		return result;
	}

	async inspectRelations(params: {
		entity_ids?: readonly string[];
		reference_entity_id?: string;
	}): Promise<SceneRelationsResultV1> {
		const result = await this.runBridgeRequest(
			"inspect_relations",
			params,
			() => this.currentRevisionId,
		);
		if (!isRecord(result) || typeof result.revision !== "string" || !HASH_64.test(result.revision)) {
			throw new Error("INVALID_INSPECT_RELATIONS_RESULT: bridge did not return a bound revision");
		}
		// Runtime-parse the addon payload with the closed protocol schema
		// (preflightMotion / produceDirectingEvidence precedent); parse failure
		// throws an Error whose message starts with INVALID_INSPECT_RELATIONS_RESULT.
		return parseSceneRelationsResult(result);
	}

	async inspectPoseContacts(params: InspectPoseContactsParamsV1): Promise<PoseContactsResultV1> {
		const result = await this.runBridgeRequest(
			"inspect_pose_contacts",
			params,
			() => this.currentRevisionId,
		);
		if (!isRecord(result) || typeof result.revision !== "string" || !HASH_64.test(result.revision)) {
			throw new Error("INVALID_INSPECT_POSE_CONTACTS_RESULT: bridge did not return a bound revision");
		}
		// Runtime-parse the addon payload with the closed protocol schema
		// (inspectRelations precedent); parse failure throws an Error whose
		// message starts with INVALID_POSE_CONTACTS_RESULT.
		return parsePoseContactsResult(result);
	}

	async preflightMotion(params: {
		motion_id: string;
		entity_id?: string;
	}): Promise<MotionPreflightResultV1> {
		const result = await this.runBridgeRequest(
			"preflight_motion",
			params,
			() => this.currentRevisionId,
		);
		// Runtime-parse the addon payload with the closed protocol schema
		// (produceDirectingEvidence precedent); parse failure throws an Error
		// whose message starts with INVALID_PREFLIGHT_MOTION_RESULT.
		return parseMotionPreflightResult(result);
	}

	async inspectPerformance(params: {
		expected_revision_id: string;
	}): Promise<Record<string, unknown>> {
		const result = await this.runBridgeRequest(
			"inspect_performance",
			params,
			() => this.currentRevisionId,
		);
		if (!isRecord(result) || typeof result.revision !== "string" || !HASH_64.test(result.revision)) {
			throw new Error("INVALID_INSPECT_PERFORMANCE_RESULT: bridge did not return a bound revision");
		}
		return result;
	}

	async inspectVisualQaMetrics(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const result = await this.runBridgeRequest(
			"inspect_visual_qa_metrics",
			params,
			() => this.currentRevisionId,
		);
		if (!isRecord(result) || typeof result.revision !== "string" || !HASH_64.test(result.revision)) {
			throw new Error("INVALID_VISUAL_QA_METRICS_RESULT: bridge did not return a bound revision");
		}
		return result;
	}

	async createFallMotion(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const result = await this.runBridgeRequest(
			"create_fall_motion",
			params,
			() => this.currentRevisionId,
		);
		if (!isRecord(result) || typeof result.revision_id !== "string" || !HASH_64.test(result.revision_id)) {
			throw new Error("INVALID_FALL_MOTION_RESULT: bridge did not return a bound revision");
		}
		return result;
	}

	async replaceCameraAction(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const result = await this.runBridgeRequest(
			"replace_camera_action",
			params,
			() => this.currentRevisionId,
		);
		if (!isRecord(result) || typeof result.revision_id !== "string" || !HASH_64.test(result.revision_id)) {
			throw new Error("INVALID_CAMERA_ACTION_RESULT: bridge did not return a bound revision");
		}
		return result;
	}

	async applyPerformanceMode(params: {
		expected_revision_id: string;
		profile: "editing" | "playback" | "performance";
	}): Promise<Record<string, unknown>> {
		const result = await this.runBridgeRequest(
			"apply_performance_mode",
			params,
			() => this.currentRevisionId,
		);
		if (!isRecord(result) || typeof result.revision_id !== "string" || !HASH_64.test(result.revision_id)) {
			throw new Error("INVALID_PERFORMANCE_MODE_RESULT: bridge did not return a bound revision");
		}
		return result;
	}

	async captureViewport(request: { readonly subject?: string; readonly views?: readonly string[] } = {}): Promise<ViewportCaptureResultV1> {
		// Closed in both directions: the params the add-on receives are parsed
		// here, so an unknown key or a `views` request without a subject fails
		// before it reaches Blender instead of being silently ignored there.
		const params = parseViewportCaptureRequest({
			project_id: this.projectId ?? null,
			subject: request.subject ?? null,
			views: request.views ?? null,
		});
		const result = await this.runBridgeRequest("capture_viewport", params, () => this.currentRevisionId);
		if (!isRecord(result) || typeof result.revision !== "string" || !HASH_64.test(result.revision)) {
			throw new Error("INVALID_CAPTURE_VIEWPORT_RESULT: bridge did not return a bound revision");
		}
		// Guard against the 2026-07 viewport-poisoning incident: the add-on
		// returned a multi-view payload while this method blind-cast the old
		// flat {viewport} shape, emitting an image content block with an
		// undefined mime type and permanently poisoning the model
		// conversation. Parse the closed schema instead of trusting shape.
		return parseViewportCaptureResult(result);
	}

	async produceDirectingEvidence(
		request: { readonly frame_start?: number; readonly frame_end?: number } = {},
	): Promise<ProduceDirectingEvidenceResultV1> {
		const projectId = this.projectId;
		if (projectId === undefined) {
			throw new Error("MUTATION_BRIDGE_UNAVAILABLE: no attached protocol-v2 bridge");
		}
		const result = await this.runBridgeRequest(
			"produce_directing_evidence",
			{
				project_id: projectId,
				frame_start: request.frame_start ?? null,
				frame_end: request.frame_end ?? null,
			},
			() => this.currentRevisionId,
		);
		const parsed = parseProduceDirectingEvidenceResult(result);
		if (this.currentRevisionId !== BOOTSTRAP_REVISION_ID && parsed.revision_id !== this.currentRevisionId) {
			throw new Error("INVALID_PRODUCE_EVIDENCE_RESULT: evidence does not bind the expected revision");
		}
		this.currentRevisionId = parsed.revision_id;
		return parsed;
	}

	/** Whether a Blender add-on peer is currently attached over the bridge. */
	isAttached(): boolean {
		return this.transport !== undefined;
	}

	/** Project id advertised by the attached Blender peer, if any. */
	get attachedProjectId(): string | undefined {
		return this.projectId;
	}

	/**
	 * Add-on version the attached Blender peer reported in its hello. Attach
	 * cannot succeed unless this equals the repo version, so the footer shows the
	 * peer's own claim rather than restating the repo constant.
	 */
	get attachedAddonVersion(): string | undefined {
		return this.addonVersion;
	}

	async executeBlenderPython(
		request: Omit<ExecuteBlenderPythonRequestV1, "type" | "request_id">,
	): Promise<ExecuteBlenderPythonResponseV1> {
		const result = await this.runBridgeRequest(
			"execute_blender_python",
			{},
			request.expected_revision_id,
			{ executionRequest: request },
		);
		return result as ExecuteBlenderPythonResponseV1;
	}

	async getExecutionOutcome(requestId: string): Promise<GetExecutionOutcomeResponseV1> {
		const result = await this.runBridgeRequest(
			"get_execution_outcome",
			{},
			() => this.currentRevisionId,
			{ outcomeRequestId: requestId },
		);
		return result as GetExecutionOutcomeResponseV1;
	}

	async stageScene(
		plan: StageScenePlanV1,
		context: { readonly signal?: AbortSignal; readonly reportProgress: (progress: BridgeProgress) => void },
	): Promise<PreparedMutationCandidate<StageSceneMutationCandidate>> {
		const result = await this.runBridgeRequest(
			"stage_scene",
			plan,
			plan.expected_revision_id,
			context,
		);
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
		const result = await this.runBridgeRequest(
			"render_qa_frames",
			request,
			() => {
				// STALE_BASE is decided at dispatch time: an earlier queued
				// operation may legitimately move the current revision before
				// this render reaches the wire.
				if (request.revision_id !== this.currentRevisionId) {
					throw new Error("STALE_BASE: render request is not based on the current revision");
				}
				return request.revision_id;
			},
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
		const transport = this.transport;
		if (transport === undefined || transport.socket.destroyed) {
			throw new Error(
				"TRANSACTION_RECONCILIATION_REQUIRED: prepared Blender transaction requires an attached bridge",
			);
		}
		this.sendFrame(transport.socket, {
			type: "bridge_transaction_ack",
			id: transaction.prepared.id,
			transaction_id: transaction.prepared.transaction_id,
			status: "committed",
			resulting_revision_id: resultingRevisionId,
		});
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

	private async readEndpoint(): Promise<BlenderBridgeDiscoveryV1 | undefined> {
		try {
			// The add-on publishes this file with atomic replace; one complete read
			// therefore observes either generation, never a partially-written JSON.
			return parseBlenderBridgeDiscovery(JSON.parse(await readFile(
				path.join(this.projectDirectory, ".cclay", "bridge-endpoint.json"), "utf8",
			)));
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return undefined;
			throw new Error(`ADDON_STALE: Blender bridge discovery is invalid — ${String(error)}`);
		}
	}

	private scheduleReconnect(delayMs = 250): void {
		if (!this.started || this.reconnectTimer !== undefined) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.refreshConnection();
		}, delayMs);
		this.applyReconnectTimerRef();
	}

	/**
	 * The reconnect timer is the only thing that can settle an attach waiter, so
	 * it must hold the event loop open while anyone is awaiting `waitForAttach()`
	 * — otherwise that promise can never settle in an otherwise idle process. An
	 * idle bridge with no waiters must still let its host exit, so the ref is
	 * scoped to outstanding waiters and re-applied on every mutation of them.
	 */
	private applyReconnectTimerRef(): void {
		if (this.attachWaiters.length > 0) this.reconnectTimer?.ref?.();
		else this.reconnectTimer?.unref?.();
	}

	private async refreshConnection(): Promise<void> {
		try {
			const endpoint = await this.readEndpoint();
			if (endpoint === undefined) {
				this.staleAddonMessage = undefined;
				this.scheduleReconnect();
				return;
			}
			if (this.transport?.generation === endpoint.token_generation) {
				this.scheduleReconnect(500);
				return;
			}
			this.transport?.socket.destroy();
			await this.connectEndpoint(endpoint);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.staleAddonMessage = failure.message;
			this.rejectAttachWaiters(failure);
			this.scheduleReconnect();
		}
	}

	private async connectEndpoint(endpoint: BlenderBridgeDiscoveryV1): Promise<void> {
		const socket = connect({ host: endpoint.host, port: endpoint.port });
		this.connectingSocket = socket;
		this.receiveBuffers.set(socket, Buffer.alloc(0));
		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					socket.removeListener("connect", onConnect);
					socket.removeListener("error", onError);
					socket.removeListener("close", onClose);
					socket.removeListener("data", onData);
					if (error !== undefined) {
						socket.destroy();
						reject(error);
					} else {
						resolve();
					}
				};
				const fail = (message: string) => finish(new Error(message));
				const onConnect = () => {
					try {
						this.sendFrame(socket, {
							type: "hello",
							token: endpoint.token,
							client: "cclay-extension",
							protocol_version: 1,
							capabilities: [CLIENT_CAPABILITY],
						});
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				};
				const onError = (error: Error) => fail(`ADDON_STALE: Blender bridge connection failed — ${error.message}`);
				const onClose = () => fail("ADDON_STALE: Blender closed the bridge before hello acknowledgement");
				const onData = (bytes: Buffer) => this.readFrames(socket, bytes, (raw) => {
					if (!isRecord(raw)) {
						fail("ADDON_STALE: invalid hello response");
						return;
					}
					if (raw.type === "hello_reject") {
						try {
							const rejected = parseBlenderBridgeHelloReject(raw);
							fail(`ADDON_STALE: Blender rejected bridge hello (${rejected.reason}) — ${ADDON_STALE_GUIDANCE}`);
						} catch (error) {
							finish(error instanceof Error ? error : new Error(String(error)));
						}
						return;
					}
					try {
						const ack = parseBlenderBridgeHelloAck(raw);
						if (ack.addon_version !== endpoint.addon_version || ack.addon_version !== EXPECTED_ADDON_VERSION) {
							fail(`ADDON_STALE: Blender add-on v${ack.addon_version} does not match repo v${EXPECTED_ADDON_VERSION} — ${ADDON_STALE_GUIDANCE}`);
							return;
						}
						if (!ack.capabilities.includes(CLIENT_CAPABILITY)) {
							fail(`ADDON_STALE: Blender add-on does not advertise required capability ${CLIENT_CAPABILITY} — ${ADDON_STALE_GUIDANCE}`);
							return;
						}
						this.addonVersion = ack.addon_version;
						finish();
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				});
				const timeout = setTimeout(
					() => fail(`ADDON_STALE: Blender did not acknowledge bridge hello within ${HANDSHAKE_TIMEOUT_MS / 1_000} seconds`),
					HANDSHAKE_TIMEOUT_MS,
				);
				timeout.unref?.();
				socket.once("connect", onConnect);
				socket.once("error", onError);
				socket.once("close", onClose);
				socket.on("data", onData);
			});
		} finally {
			if (this.connectingSocket === socket) this.connectingSocket = undefined;
		}
		socket.once("close", () => this.onDisconnect(socket));
		socket.once("error", () => {});
		socket.on("data", (bytes) => this.readFrames(socket, bytes, (raw) => void this.handleBridgeMessage(raw)));
		this.endpoint = endpoint;
		this.transport = { socket, generation: endpoint.token_generation };
		this.staleAddonMessage = undefined;
		const waiters = this.attachWaiters;
		this.attachWaiters = [];
		this.applyReconnectTimerRef();
		for (const waiter of waiters) waiter.resolve();
		appendBridgeLog(this.projectDirectory, { event: "bridge_connected", token_generation: endpoint.token_generation });
		if (this.pending !== undefined) {
			this.sendFrame(socket, { type: "get_execution_outcome", request_id: this.pending.requestId });
			appendBridgeLog(this.projectDirectory, {
				event: "bridge_outcome_query",
				request_id: this.pending.requestId,
				token_generation: endpoint.token_generation,
			});
		}
		this.scheduleReconnect(500);
	}

	private rejectAttachWaiters(error: Error): void {
		const waiters = this.attachWaiters;
		this.attachWaiters = [];
		this.applyReconnectTimerRef();
		for (const waiter of waiters) waiter.reject(error);
	}
	private onDisconnect(socket: Socket): void {
		if (this.transport?.socket !== socket) return;
		const diagnostics = this.pendingDiagnostics();
		this.transport = undefined;
		appendBridgeLog(this.projectDirectory, {
			event: "bridge_disconnect",
			request_id: this.pending?.requestId ?? null,
			token_generation: this.endpoint?.token_generation ?? null,
			diagnostics,
		});
		// The request may have reached Blender. Keep its request_id and ask the
		// replacement generation for the authoritative outcome before rejecting.
		if (this.pending !== undefined) this.scheduleReconnect(0);
		else this.scheduleReconnect();
	}

	private readFrames(socket: Socket, chunk: Buffer, onFrame: (raw: unknown) => void): void {
		let receiveBuffer = Buffer.concat([this.receiveBuffers.get(socket) ?? Buffer.alloc(0), chunk]);
		if (receiveBuffer.byteLength > 18 * 1024 * 1024 + 4) {
			socket.destroy(new Error("FRAME_TOO_LARGE: bridge receive buffer exceeds 18 MiB"));
			return;
		}
		while (receiveBuffer.byteLength >= 4) {
			const length = receiveBuffer.readUInt32BE(0);
			if (length > 18 * 1024 * 1024) {
				socket.destroy(new Error("FRAME_TOO_LARGE: bridge frame exceeds 18 MiB"));
				return;
			}
			if (receiveBuffer.byteLength < 4 + length) {
				this.receiveBuffers.set(socket, receiveBuffer);
				return;
			}
			const payload = receiveBuffer.subarray(4, 4 + length);
			receiveBuffer = receiveBuffer.subarray(4 + length);
			try {
				onFrame(JSON.parse(payload.toString("utf8")));
			} catch {
				socket.destroy(new Error("INVALID_FRAME: bridge frame is not JSON"));
				return;
			}
		}
		this.receiveBuffers.set(socket, receiveBuffer);
	}

	private sendFrame(socket: Socket, value: unknown): void {
		const payload = Buffer.from(JSON.stringify(value), "utf8");
		if (payload.byteLength > 18 * 1024 * 1024) throw new Error("FRAME_TOO_LARGE: outbound bridge frame exceeds 18 MiB");
		const header = Buffer.alloc(4);
		header.writeUInt32BE(payload.byteLength);
		socket.write(Buffer.concat([header, payload]));
	}

	private async handleBridgeMessage(raw: unknown): Promise<void> {
		if (!isRecord(raw) || typeof raw.type !== "string") return;
		const message = raw;
		const pending = this.pending;
		if (message.type === "bridge_transaction_acknowledged") {
			const transaction = this.preparedTransaction;
			if (transaction !== undefined && message.id === transaction.prepared.id && message.transaction_id === transaction.prepared.transaction_id) transaction.resolveAcknowledged();
			return;
		}
		if (
			message.type === "execution_outcome_not_found" &&
			pending !== undefined &&
			message.request_id === (pending.outcomeRequestId ?? pending.requestId)
		) {
			if (pending.executionBaseRevisionId !== undefined) {
				this.settleExecutionUnknown(pending, "Blender restart lost the execution outcome");
			} else if (pending.outcomeRequestId !== undefined) {
				try {
					this.settle(pending, () => pending.resolve(parseGetExecutionOutcomeResponse(message)));
				} catch (error) {
					this.settle(pending, () => pending.reject(error instanceof Error ? error : new Error(String(error))));
				}
			} else {
				this.failPending("OUTCOME_UNKNOWN", "Blender restart lost the execution outcome");
			}
			return;
		}
		if (
			(message.type === "execute_result" || message.type === "precondition_failed") &&
			pending !== undefined &&
			message.request_id === (pending.outcomeRequestId ?? pending.requestId)
		) {
			try {
				if (pending.executionBaseRevisionId !== undefined) {
					const response = parseExecuteBlenderPythonResponse(message);
					this.settle(pending, () => pending.resolve(this.applyExecutionResponse(response, pending.executionBaseRevisionId!)));
				} else if (pending.outcomeRequestId !== undefined) {
					const response = parseGetExecutionOutcomeResponse(message);
					this.settle(pending, () => pending.resolve(this.applyExecutionOutcome(response)));
				}
			} catch (error) {
				if (pending.executionBaseRevisionId !== undefined) {
					this.settleExecutionUnknown(pending, "Blender returned a malformed execution outcome");
				} else {
					this.settle(pending, () => pending.reject(error instanceof Error ? error : new Error(String(error))));
				}
			}
			return;
		}
		if (pending === undefined || message.id !== pending.id) return;
		if (message.type === "bridge_transaction_prepared") {
			if (message.operation !== pending.method) return;
			pending.preparedTransaction = message as unknown as BridgeTransactionPrepared;
			return;
		}
		if (message.type === "bridge_artifact_begin") {
			if (
				typeof message.frame !== "number" ||
				typeof message.total_chunks !== "number" ||
				typeof message.total_byte_length !== "number" ||
				typeof message.sha256 !== "string" ||
				message.total_chunks < 1 ||
				message.total_byte_length < 0
			) {
				this.failPending("INVALID_RENDER_QA_RESULT", "artifact declaration is invalid");
				return;
			}
			pending.artifactFrames.set(message.frame, {
				totalChunks: message.total_chunks,
				totalByteLength: message.total_byte_length,
				sha256: message.sha256,
				chunks: new Map(),
				receivedBytes: 0,
			});
			return;
		}
		if (message.type === "bridge_artifact_batch_begin" && Array.isArray(message.frames)) {
			for (const frame of message.frames) {
				if (
					!isRecord(frame) ||
					typeof frame.frame !== "number" ||
					typeof frame.total_chunks !== "number" ||
					typeof frame.total_byte_length !== "number" ||
					typeof frame.sha256 !== "string"
				) {
					this.failPending("INVALID_RENDER_QA_RESULT", "artifact declaration is invalid");
					return;
				}
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
		if (message.type === "bridge_artifact_chunk" && typeof message.frame === "number" && typeof message.chunk_index === "number" && typeof message.byte_length === "number" && typeof message.byte_offset === "number" && typeof message.data_base64 === "string") {
			const artifact = pending.artifactFrames.get(message.frame);
			const bytes = Buffer.from(message.data_base64, "base64");
			if (artifact === undefined || artifact.chunks.has(message.chunk_index) || bytes.byteLength !== message.byte_length || artifact.receivedBytes !== message.byte_offset) {
				this.failPending("INVALID_RENDER_QA_RESULT", "artifact chunk is invalid");
				return;
			}
			artifact.chunks.set(message.chunk_index, bytes);
			artifact.receivedBytes += bytes.byteLength;
			return;
		}
		if (message.type === "bridge_progress" && typeof message.phase === "string" && typeof message.completed === "number" && typeof message.total === "number") {
			pending.lastPhase = message.phase;
			pending.reportProgress?.({ phase: message.phase, completed: message.completed, total: message.total });
			return;
		}
		if (message.type === "bridge_result") {
			try {
				const result = pending.renderRequest === undefined
					? (pending.preparedTransaction === undefined
						? message.result
						: { candidate: message.result, transaction: pending.preparedTransaction, requestId: pending.requestId })
					: await this.finalizeRenderResult(pending, message.result);
				if (pending.preparedTransaction !== undefined) {
					let resolveAcknowledged!: () => void;
					const acknowledged = new Promise<void>((resolve) => { resolveAcknowledged = resolve; });
					this.preparedTransaction = { prepared: pending.preparedTransaction, acknowledged, resolveAcknowledged };
				}
				this.settle(pending, () => pending.resolve(result));
			} catch (error) {
				this.settle(pending, () => pending.reject(error instanceof Error ? error : new Error(String(error))));
			}
			return;
		}
		if (message.type === "bridge_error") {
			this.settle(pending, () => pending.reject(new Error(`${message.code}: ${message.message}`)));
		}
	}

	private async finalizeRenderResult(pending: PendingBridge, raw: unknown): Promise<RenderQaFramesResultV1> {
		if (
			pending.renderRequest === undefined ||
			!isRecord(raw) ||
			raw.schema_version !== 1 ||
			raw.revision_id !== pending.renderRequest.revision_id ||
			raw.profile_version !== "cclay-qa-png-v1" ||
			!Array.isArray(raw.frames)
		) {
			throw new Error("INVALID_RENDER_QA_RESULT: final bridge metadata is invalid");
		}
		const artifactDirectory = path.join(this.projectDirectory, ".cclay", "artifacts", "sha256");
		await mkdir(artifactDirectory, { recursive: true });
		const frames: RenderQaFramesResultV1["frames"][number][] = [];
		for (const metadata of raw.frames) {
			if (!isRecord(metadata) || typeof metadata.frame !== "number") {
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
			// The result metadata no longer restates the PNG (that duplication
			// overflowed the addon's 1 MiB frame limit), so the streamed bytes are
			// the only copy and carry the full content check here.
			if (!bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
				throw new Error("INVALID_RENDER_QA_RESULT: streamed artifact is not a PNG");
			}
			await writeFile(path.join(artifactDirectory, `${sha256}.png`), bytes, { mode: 0o600 });
			frames.push({
				...(metadata as unknown as Omit<RenderQaFramesResultV1["frames"][number], "uri">),
				uri: `cclay-artifact://sha256/${sha256}`,
			});
		}
		return parseRenderQaFramesResult({
			schema_version: 1,
			revision_id: pending.renderRequest.revision_id,
			profile_version: "cclay-qa-png-v1",
			frames,
		});
	}
	private applyExecutionResponse(
		response: ExecuteBlenderPythonResponseV1,
		baseRevisionId: string,
	): ExecuteBlenderPythonResponseV1 {
		if (response.type === "precondition_failed") return response;
		return this.applyExecutionResult(response, baseRevisionId);
	}

	private applyExecutionOutcome(response: GetExecutionOutcomeResponseV1): GetExecutionOutcomeResponseV1 {
		if (response.type === "execution_outcome_not_found") return response;
		if (response.outcome === "failed_recovered") {
			this.currentRevisionId = response.restored_revision_id;
			return response;
		}
		return this.applyExecutionResult(response, this.currentRevisionId);
	}

	private applyExecutionResult(
		result: ExecuteBlenderPythonResultV1,
		baseRevisionId: string,
	): ExecuteBlenderPythonResultV1 {
		switch (result.outcome) {
			case "success":
				this.currentRevisionId = result.new_revision_id;
				break;
			case "failed_recovered":
				if (result.restored_revision_id !== baseRevisionId) {
					this.freezeExecutionMutations("Blender restored a revision other than the execution base");
					throw new Error("INVALID_EXECUTION_OUTCOME: recovered revision does not match the execution base");
				}
				this.currentRevisionId = baseRevisionId;
				break;
			case "recovery_required":
				this.freezeExecutionMutations("Blender requires execution recovery");
				break;
			case "outcome_unknown":
				this.freezeExecutionMutations("Blender execution outcome is unknown");
				break;
		}
		return result;
	}

	private freezeExecutionMutations(reason: string): void {
		this.executionMutationFreezeReason ??= reason;
	}

	private settleExecutionUnknown(pending: PendingBridge, reason: string): void {
		this.freezeExecutionMutations(reason);
		this.settle(pending, () => pending.resolve({
			type: "execute_result",
			request_id: pending.requestId,
			outcome: "outcome_unknown",
			reason,
		} satisfies ExecuteBlenderPythonResultV1));
	}

	private settle(pending: PendingBridge, run: () => void): void {
		if (this.pending !== pending) return;
		this.pending = undefined;
		if (pending.deadlineTimer !== undefined) clearTimeout(pending.deadlineTimer);
		this.activeRequestIds.delete(pending.requestId);
		run();
	}

	/**
	 * One actionable clause naming the operation a transport-level failure hit.
	 * Without it a mid-render disconnect or timeout surfaces as a bare code with
	 * no way to tell which tool call died or how far its artifact stream got.
	 */
	private pendingDiagnostics(): string {
		const pending = this.pending;
		if (pending === undefined) return "";
		const clauses = [`during ${pending.method}`];
		if (pending.lastPhase !== undefined) clauses.push(`phase ${pending.lastPhase}`);
		if (pending.artifactFrames.size > 0) {
			let streamed = 0;
			let declared = 0;
			for (const frame of pending.artifactFrames.values()) {
				streamed += frame.receivedBytes;
				declared += frame.totalByteLength;
			}
			clauses.push(`artifacts ${streamed}/${declared} bytes over ${pending.artifactFrames.size} frame(s)`);
		}
		return ` (${clauses.join(", ")})`;
	}

	private failPending(code: string, message: string): void {
		const pending = this.pending;
		if (pending === undefined) return;
		this.pending = undefined;
		if (pending.deadlineTimer !== undefined) clearTimeout(pending.deadlineTimer);
		this.activeRequestIds.delete(pending.requestId);
		pending.reject(new Error(`${code}: ${message}`));
	}

	/**
	 * FIFO queue in front of the single-flight bridge: each operation dispatches
	 * only after every earlier operation has settled. A queued operation whose
	 * signal aborts before its turn rejects immediately and is skipped without
	 * ever touching the wire; once dispatched, the original in-flight
	 * cancellation semantics (bridge_cancel + settle) apply unchanged. When
	 * `expectedRevisionId` is a thunk it is evaluated at dispatch time, so
	 * read-only operations bind the revision current after earlier queued
	 * operations settled (an enqueue-time read would go stale across a rebind).
	 */
	private runBridgeRequest(
		method: string,
		params: Record<string, unknown>,
		expectedRevisionId: string | (() => string),
		options: {
			signal?: AbortSignal;
			reportProgress?: (progress: BridgeProgress) => void;
			renderRequest?: RenderQaFramesRequestV1;
			executionRequest?: Omit<ExecuteBlenderPythonRequestV1, "type" | "request_id">;
			outcomeRequestId?: string;
		} = {},
	): Promise<unknown> {
		const signal = options.signal;
		if (signal?.aborted) {
			return Promise.reject(new Error("CANCELLED: bridge operation cancelled"));
		}
		return new Promise<unknown>((resolve, reject) => {
			let cancelledBeforeDispatch = false;
			const onAbort = () => {
				cancelledBeforeDispatch = true;
				reject(new Error("CANCELLED: bridge operation cancelled"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const turn = this.bridgeQueueTail.then(async () => {
				if (cancelledBeforeDispatch) return;
				signal?.removeEventListener("abort", onAbort);
				try {
					resolve(await this.dispatchBridgeRequest(method, params, expectedRevisionId, options));
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			this.bridgeQueueTail = turn;
		});
	}

	private dispatchBridgeRequest(
		method: string,
		params: Record<string, unknown>,
		expectedRevisionId: string | (() => string),
		options: {
			signal?: AbortSignal;
			reportProgress?: (progress: BridgeProgress) => void;
			renderRequest?: RenderQaFramesRequestV1;
			executionRequest?: Omit<ExecuteBlenderPythonRequestV1, "type" | "request_id">;
			outcomeRequestId?: string;
		} = {},
	): Promise<unknown> {
		if (EXECUTION_MUTATING_METHODS.has(method) && this.executionMutationFreezeReason !== undefined) {
			return Promise.reject(new Error(`EXECUTION_RECOVERY_REQUIRED: ${this.executionMutationFreezeReason}`));
		}
		const transport = this.transport;
		if (transport === undefined) {
			return Promise.reject(
				new Error(this.staleAddonMessage ?? "MUTATION_BRIDGE_UNAVAILABLE: no attached protocol-v2 bridge"),
			);
		}
		if (this.pending !== undefined) {
			return Promise.reject(new Error("BUSY: one protocol-v2 bridge operation is already open"));
		}
		let resolvedRevisionId: string;
		try {
			resolvedRevisionId =
				typeof expectedRevisionId === "function" ? expectedRevisionId() : expectedRevisionId;
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		const id = randomUUID();
		const requestId = randomUUID();
		this.activeRequestIds.add(requestId);
		const bridgeRequest = options.executionRequest === undefined && options.outcomeRequestId === undefined
			? {
				type: "bridge_request",
				id,
				request_id: requestId,
				method,
				params,
				expected_revision_id: resolvedRevisionId,
				// Advisory only: the add-on may complete after this deadline and
				// reconnect outcome lookup is the authority for ambiguous delivery.
				deadline_ms: BRIDGE_OP_DEADLINE_MAX_MS,
			}
			: options.executionRequest !== undefined
				? parseExecuteBlenderPythonRequest({
					type: "execute_blender_python",
					request_id: requestId,
					...options.executionRequest,
				})
				: { type: "get_execution_outcome", request_id: options.outcomeRequestId };
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
				executionBaseRevisionId: options.executionRequest?.expected_revision_id,
				outcomeRequestId: options.outcomeRequestId,
			};
			this.pending = pending;
			// Extension-side deadline enforcement: reap the operation locally
			// when the addon never answers. unref() keeps the timer from
			// holding the node process alive; it is cleared on every settle
			// path (result, error, cancel, disconnect, close).
			pending.deadlineTimer = setTimeout(() => {
				if (pending.executionBaseRevisionId !== undefined) {
					this.settleExecutionUnknown(pending, "Blender did not provide an execution outcome before the advisory deadline");
				} else {
					this.failPending(
						"DEADLINE_EXCEEDED",
						`bridge operation exceeded its deadline${this.pendingDiagnostics()}`,
					);
				}
			}, this.operationTimeoutMs);
			pending.deadlineTimer.unref?.();
			const signal = options.signal;
			if (signal !== undefined) {
				const onAbort = () => {
					try {
						this.sendFrame(transport.socket, { type: "bridge_cancel", id, request_id: requestId });
					} catch {
						// Cancellation is advisory; execution may still complete.
					}
					this.settle(pending, () => reject(new Error("CANCELLED: bridge operation cancelled")));
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.sendFrame(transport.socket, bridgeRequest);
		});
	}
}
