// In-extension Blender bridge (option A): owns the WebSocket server that Blender
// attaches to, performs the protocol-v2 hello handshake, and drives the
// bridge_request/bridge_result loop for the four director tools. Discovery-slot
// credential ceremony and controller-peer auth are intentionally dropped; a
// plain bearer token gates the loopback socket. Durable transaction commit and
// auto-reconnect are retained.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import {
	type BridgeTransactionPrepared,
	type CameraPlanMutationCandidate,
	type CameraPlanV1,
	type MotionPreflightResultV1,
	MUTATION_BRIDGE_CAPABILITY,
	type MutationBridgeSession,
	negotiateMutationBridge,
	parseAddonBridgeMessage,
	parseDaemonBridgeMessage,
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
	SCENE_MANIFEST_V3_CAPABILITY,
	type SceneRelationsResultV1,
	type SceneSnapshot,
	type StageSceneMutationCandidate,
	StageSceneOperationV1Schema,
	type StageScenePlanV1,
	TRANSACTION_COMMIT_CAPABILITY,
} from "@cclay/protocol";
import type { InspectEntityOptions } from "@cclay/blender-tools";
import { acceptUpgrade, readClientRole, type WebSocketConnection } from "./ws-server.ts";

const BOOTSTRAP_REVISION_ID = "0".repeat(64);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const HASH_64 = /^[0-9a-f]{64}$/;
const BRIDGE_OP_DEADLINE_MAX_MS = 30_000;
// Local reaper margin on top of the wire deadline: a wedged-but-connected
// addon must not stall the FIFO queue forever, so the extension arms its own
// timer slightly past the deadline it sent.
const BRIDGE_OP_DEADLINE_GRACE_MS = 5_000;
const DAEMON_VERSION = "0.1.0";

// Expected addon surface, computed at startup. A reused Blender may hold a
// stale in-memory add-on; the hello capability report lets the bridge fail
// attach with one actionable ADDON_STALE line instead of per-call cryptic
// METHOD_NOT_SUPPORTED / unsupported-op failures.
const ADDON_VERSION_CAPABILITY_PREFIX = "cclay.addon_version=";
const METHOD_CAPABILITY_PREFIX = "cclay.method.";
const OP_CAPABILITY_PREFIX = "cclay.op.";
const NEGOTIATED_CORE_CAPABILITIES = [
	MUTATION_BRIDGE_CAPABILITY,
	SCENE_MANIFEST_V3_CAPABILITY,
	TRANSACTION_COMMIT_CAPABILITY,
] as const;
const REQUIRED_BRIDGE_METHODS = [
	"inspect_project",
	"inspect_entity",
	"inspect_pose_contacts",
	"inspect_relations",
	"preflight_motion",
	"capture_viewport",
	"produce_directing_evidence",
	"apply_camera_plan",
	"stage_scene",
	"render_qa_frames",
] as const;
const ADDON_MANIFEST_URL = new URL(
	"../../../blender-addon/cclay/blender_manifest.toml",
	import.meta.url,
);
const ADDON_STALE_GUIDANCE =
	"close Blender and run cclay again (the launcher will reinstall the current add-on)";

/** Op names of the protocol's StageSceneOperationV1 union (drift-proof). */
function requiredStageSceneOps(): readonly string[] {
	const union = StageSceneOperationV1Schema as unknown as {
		anyOf?: ReadonlyArray<{ properties?: { op?: { const?: unknown } } }>;
	};
	const names = new Set<string>();
	for (const member of union.anyOf ?? []) {
		const op = member.properties?.op?.const;
		if (typeof op === "string") names.add(op);
	}
	if (names.size === 0) throw new Error("stage-scene op union yielded no op names");
	return [...names];
}
const REQUIRED_STAGE_SCENE_OPS = requiredStageSceneOps();

/** Repo-truth addon version from blender_manifest.toml (loud startup failure). */
export function expectedAddonVersion(manifestUrl: URL = ADDON_MANIFEST_URL): string {
	const version = readFileSync(manifestUrl, "utf8").match(/^version = "([^"]+)"/m)?.[1];
	if (version === undefined) throw new Error("blender_manifest.toml yielded no add-on version");
	return version;
}
const EXPECTED_ADDON_VERSION = expectedAddonVersion();

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
	lastPhase?: string;
	readonly reject: (error: Error) => void;
	preparedTransaction?: BridgeTransactionPrepared;
	renderRequest?: RenderQaFramesRequestV1;
	artifactFrames: Map<number, ArtifactFrame>;
	deadlineTimer?: ReturnType<typeof setTimeout>;
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

/** One JSONL bridge event log per project; diagnostics must never throw. */
function appendBridgeLog(projectDirectory: string, entry: Record<string, unknown>): void {
	const directory = path.join(projectDirectory, ".cclay");
	const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
	void mkdir(directory, { recursive: true, mode: 0o700 })
		.then(() => appendFile(path.join(directory, "bridge.log"), line, { encoding: "utf8", mode: 0o600 }))
		.catch(() => {});
}

/**
 * Owns the Blender-facing WebSocket. A single bridge operation may be in flight
 * at a time (Blender mutates on its main thread); the bridge serializes its
 * own operations through a FIFO promise-chain queue, so concurrent tool calls
 * wait their turn. That serialization covers only this daemon's requests, so
 * addon-side BUSY remains a defensive backstop rather than dead code:
 * after an in-flight cancel (which settles locally and is best-effort on the
 * wire) the addon may still be draining the cancelled operation when the next
 * request arrives.
 */
export class BlenderBridge {
	private server: Server | undefined;
	private token = "";
	private readonly launchId = randomUUID();
	private transport: AttachedTransport | undefined;
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

	constructor(
		projectDirectory = process.cwd(),
		options: { readonly operationTimeoutMs?: number } = {},
	) {
		this.projectDirectory = projectDirectory;
		this.operationTimeoutMs =
			options.operationTimeoutMs ?? BRIDGE_OP_DEADLINE_MAX_MS + BRIDGE_OP_DEADLINE_GRACE_MS;
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

	/**
	 * Resolves once Blender has attached and completed the hello handshake.
	 * Rejects when an attach attempt is refused because the Blender add-on is
	 * stale (ADDON_STALE), so the failure surfaces once instead of hanging.
	 */
	waitForAttach(signal?: AbortSignal): Promise<void> {
		if (this.transport !== undefined) return Promise.resolve();
		if (this.staleAddonMessage !== undefined) {
			return Promise.reject(new Error(this.staleAddonMessage));
		}
		return new Promise<void>((resolve, reject) => {
			const waiter = {
				resolve: () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				},
				reject: (error: Error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			};
			const onAbort = () => {
				this.attachWaiters = this.attachWaiters.filter((candidate) => candidate !== waiter);
				reject(new Error("ATTACH_ABORTED: waiting for Blender to attach was aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.attachWaiters.push(waiter);
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
				} catch (error) {
					if (error instanceof Error && error.message.startsWith("ADDON_STALE")) {
						this.refuseStaleAttach(websocket, error);
					} else {
						websocket.close(1008, "invalid hello");
					}
				}
				return;
			}
			void this.handleBridgeMessage(session, raw);
		});
		websocket.on("disconnect", (closeInfo?: { code: number; reason: string; source: "local" | "peer" }) => {
			if (this.transport?.websocket === websocket) {
				const diagnostics = this.pendingDiagnostics();
				appendBridgeLog(this.projectDirectory, {
					event: "bridge_disconnect",
					launchId: this.launchId,
					projectId: this.projectId,
					diagnostics,
					close: closeInfo ?? websocket.closeInfo() ?? null,
				});
				this.transport = undefined;
				this.failPending("BRIDGE_DISCONNECTED", `Blender bridge disconnected${diagnostics}`);
			}
		});
	}

	/** Refuse the attach with one actionable line and wake every waiter. */
	private refuseStaleAttach(websocket: WebSocketConnection, error: Error): void {
		this.staleAddonMessage = error.message;
		websocket.close(1008, "stale addon");
		const waiters = this.attachWaiters;
		this.attachWaiters = [];
		for (const waiter of waiters) waiter.reject(new Error(error.message));
	}

	/**
	 * Compare the addon-reported cclay.* surface against the repo expectation.
	 * A legacy add-on (no version capability), a version mismatch, or any
	 * missing required method/op fails the attach with a single ADDON_STALE.
	 * Records the reported version on success so the footer can show what the
	 * attached peer actually claimed.
	 */
	private verifyAddonSurface(capabilities: readonly string[]): void {
		const surface = new Set(capabilities);
		const reportedVersion = capabilities
			.find((capability) => capability.startsWith(ADDON_VERSION_CAPABILITY_PREFIX))
			?.slice(ADDON_VERSION_CAPABILITY_PREFIX.length);
		let problem: string | undefined;
		if (reportedVersion === undefined) {
			problem = "Blender add-on reported no version (pre-surface add-on is loaded)";
		} else if (reportedVersion !== EXPECTED_ADDON_VERSION) {
			problem = `Blender add-on v${reportedVersion} does not match repo v${EXPECTED_ADDON_VERSION}`;
		} else {
			const missing = [
				...REQUIRED_BRIDGE_METHODS.filter(
					(method) => !surface.has(`${METHOD_CAPABILITY_PREFIX}${method}`),
				).map((method) => `method ${method}`),
				...REQUIRED_STAGE_SCENE_OPS.filter((op) => !surface.has(`${OP_CAPABILITY_PREFIX}${op}`)).map(
					(op) => `op ${op}`,
				),
			];
			if (missing.length > 0) {
				problem = `Blender add-on v${reportedVersion} is missing required surface: ${missing.join(", ")}`;
			}
		}
		if (problem !== undefined) {
			throw new Error(`ADDON_STALE: ${problem} — ${ADDON_STALE_GUIDANCE}`);
		}
		this.addonVersion = reportedVersion;
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
		const capabilities = Array.isArray(hello.capabilities)
			? (hello.capabilities as unknown[]).filter((entry): entry is string => typeof entry === "string")
			: [];
		this.verifyAddonSurface(capabilities);
		this.projectId = hello.project_id;
		const offered = new Set(capabilities);
		const helloAck = {
			type: "hello_ack",
			protocol: 2,
			daemon_version: DAEMON_VERSION,
			launch_id: this.launchId,
			session_id: randomUUID(),
			server_nonce: randomBytes(16).toString("base64url"),
			// Echo only the negotiated core intersection in canonical order; the
			// namespaced cclay.* surface entries are attach metadata, and the
			// addon-side hello_ack validator keeps its closed core tuple.
			capabilities: NEGOTIATED_CORE_CAPABILITIES.filter((capability) => offered.has(capability)),
		};
		const session = negotiateMutationBridge(hello, helloAck);
		websocket.sendText(helloAck);
		this.staleAddonMessage = undefined;
		this.transport = { websocket, session };
		const waiters = this.attachWaiters;
		this.attachWaiters = [];
		for (const waiter of waiters) waiter.resolve();
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
			pending.lastPhase = message.phase;
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
			// finalizeRenderResult performs fs writes and artifact-integrity
			// checks; a rejection here must settle the pending operation as a
			// normal tool error (not an unhandled rejection that wedges the
			// FIFO queue behind a forever-pending dispatch).
			let resolved: unknown;
			try {
				resolved =
					pending.renderRequest === undefined ? result : await this.finalizeRenderResult(pending, result);
			} catch (error) {
				this.settle(pending, () =>
					pending.reject(error instanceof Error ? error : new Error(String(error))),
				);
				return;
			}
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
		} = {},
	): Promise<unknown> {
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
		let bridgeRequest: unknown;
		try {
			bridgeRequest = parseDaemonBridgeMessage(
				{
					type: "bridge_request",
					id,
					request_id: requestId,
					method,
					params,
					expected_revision_id: resolvedRevisionId,
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
			// Extension-side deadline enforcement: reap the operation locally
			// when the addon never answers. unref() keeps the timer from
			// holding the node process alive; it is cleared on every settle
			// path (result, error, cancel, disconnect, close).
			pending.deadlineTimer = setTimeout(() => {
				this.failPending(
					"DEADLINE_EXCEEDED",
					`bridge operation exceeded its deadline${this.pendingDiagnostics()}`,
				);
			}, this.operationTimeoutMs);
			pending.deadlineTimer.unref?.();
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
