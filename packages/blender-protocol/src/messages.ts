import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

export const PROTOCOL_VERSION = 1;
export const MUTATION_PROTOCOL_VERSION = 2;

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const HASH_64 = "^[0-9a-f]{64}$";
const BASE64URL_16 = "^[A-Za-z0-9_-]{22}$";
const BASE64URL_32 = "^[A-Za-z0-9_-]{43}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const uuid = () => Type.String({ pattern: UUID_V4_LOWERCASE });
const hash = () => Type.String({ pattern: HASH_64 });

export const StartupRecordSchema = exact({
	type: Type.Literal("omb_daemon_ready"),
	protocol: Type.Literal(PROTOCOL_VERSION),
	port: Type.Integer({ minimum: 1, maximum: 65_535 }),
	pid: Type.Integer({ minimum: 1 }),
	launch_id: uuid(),
	bearer_token: Type.String({ pattern: BASE64URL_32 }),
	expires_in_ms: Type.Literal(10_000),
});
const helloProperties = {
	type: Type.Literal("hello"),
	addon_version: Type.String(),
	blender_version: Type.String(),
	project_id: uuid(),
	client_nonce: Type.String({ pattern: BASE64URL_16 }),
};
const helloAckProperties = {
	type: Type.Literal("hello_ack"),
	daemon_version: Type.String(),
	launch_id: uuid(),
	session_id: uuid(),
	server_nonce: Type.String({ pattern: BASE64URL_16 }),
};
export const MUTATION_BRIDGE_CAPABILITY = "mutation_bridge_v2";
export const SCENE_MANIFEST_V3_CAPABILITY = "scene_manifest_v3";
const mutationCapabilities = () =>
	Type.Union([
		Type.Tuple([Type.Literal(MUTATION_BRIDGE_CAPABILITY)]),
		Type.Tuple([Type.Literal(MUTATION_BRIDGE_CAPABILITY), Type.Literal(SCENE_MANIFEST_V3_CAPABILITY)]),
	]);

export const HelloV1Schema = exact({
	...helloProperties,
	protocol: Type.Literal(PROTOCOL_VERSION),
});
export const HelloV2Schema = exact({
	...helloProperties,
	protocol: Type.Literal(MUTATION_PROTOCOL_VERSION),
	capabilities: mutationCapabilities(),
});
export const HelloSchema = Type.Union([HelloV1Schema, HelloV2Schema]);
export const HelloAckV1Schema = exact({
	...helloAckProperties,
	protocol: Type.Literal(PROTOCOL_VERSION),
	capabilities: Type.Array(Type.String()),
});
export const HelloAckV2Schema = exact({
	...helloAckProperties,
	protocol: Type.Literal(MUTATION_PROTOCOL_VERSION),
	capabilities: mutationCapabilities(),
});
export const HelloAckSchema = Type.Union([HelloAckV1Schema, HelloAckV2Schema]);
export const RequestSchema = exact({
	type: Type.Literal("request"),
	id: uuid(),
	method: Type.String({ minLength: 1 }),
	params: Type.Record(Type.String(), Type.Unknown()),
	expected_revision_id: hash(),
	deadline_ms: Type.Integer({ minimum: 100, maximum: 30_000 }),
});
export const ProgressSchema = exact({
	type: Type.Literal("progress"),
	id: uuid(),
	phase: Type.String(),
	completed: Type.Integer({ minimum: 0 }),
	total: Type.Integer({ minimum: 0 }),
});
export const ResponseSchema = exact({
	type: Type.Literal("response"),
	id: uuid(),
	result: Type.Unknown(),
	resulting_revision_id: hash(),
});
export const ErrorSchema = exact({
	type: Type.Literal("error"),
	id: uuid(),
	code: Type.String(),
	message: Type.String(),
	retryable: Type.Boolean(),
});
export const CancelSchema = exact({ type: Type.Literal("cancel"), id: uuid() });
export const CancelAckSchema = exact({
	type: Type.Literal("cancel_ack"),
	id: uuid(),
	status: Type.Union([Type.Literal("accepted"), Type.Literal("already_terminal"), Type.Literal("unknown")]),
});
export const RollbackAckSchema = exact({
	type: Type.Literal("rollback_ack"),
	id: uuid(),
	status: Type.Union([Type.Literal("restored"), Type.Literal("failed")]),
	state_hash: hash(),
});
export const ShutdownSchema = exact({ type: Type.Literal("shutdown"), reason: Type.String() });
export const ShutdownAckSchema = exact({ type: Type.Literal("shutdown_ack") });
export const PingSchema = exact({ type: Type.Literal("ping"), nonce: Type.String() });
export const PongSchema = exact({ type: Type.Literal("pong"), nonce: Type.String() });
export const BridgeRequestSchema = exact({
	type: Type.Literal("bridge_request"),
	id: uuid(),
	request_id: uuid(),
	method: Type.String({ minLength: 1 }),
	params: Type.Record(Type.String(), Type.Unknown()),
	expected_revision_id: hash(),
	deadline_ms: Type.Integer({ minimum: 100, maximum: 30_000 }),
});
export const BridgeProgressSchema = exact({
	type: Type.Literal("bridge_progress"),
	id: uuid(),
	request_id: uuid(),
	phase: Type.String({ minLength: 1 }),
	completed: Type.Integer({ minimum: 0 }),
	total: Type.Integer({ minimum: 0 }),
});
export const BridgeArtifactBeginSchema = exact({
	type: Type.Literal("bridge_artifact_begin"),
	id: uuid(),
	request_id: uuid(),
	frame: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
	total_chunks: Type.Integer({ minimum: 1, maximum: 32 }),
	total_byte_length: Type.Integer({ minimum: 1, maximum: 512 * 1024 * 1024 }),
	sha256: hash(),
});
export const BridgeArtifactBatchBeginSchema = exact({
	type: Type.Literal("bridge_artifact_batch_begin"),
	id: uuid(),
	request_id: uuid(),
	frames: Type.Array(
		exact({
			frame: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
			total_chunks: Type.Integer({ minimum: 1, maximum: 32 }),
			total_byte_length: Type.Integer({ minimum: 1, maximum: 512 * 1024 * 1024 }),
			sha256: hash(),
		}),
		{ minItems: 1, maxItems: 12 },
	),
});
export const BridgeArtifactChunkSchema = exact({
	type: Type.Literal("bridge_artifact_chunk"),
	id: uuid(),
	request_id: uuid(),
	frame: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
	chunk_index: Type.Integer({ minimum: 0, maximum: 31 }),
	total_chunks: Type.Integer({ minimum: 1, maximum: 32 }),
	byte_offset: Type.Integer({ minimum: 0, maximum: 16 * 1024 * 1024 - 1 }),
	byte_length: Type.Integer({ minimum: 1, maximum: 512 * 1024 }),
	data_base64: Type.String({ minLength: 4, maxLength: 699_052, pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
});
export const BridgeResultSchema = exact({
	type: Type.Literal("bridge_result"),
	id: uuid(),
	request_id: uuid(),
	result: Type.Unknown(),
});
export const BridgeErrorSchema = exact({
	type: Type.Literal("bridge_error"),
	id: uuid(),
	request_id: uuid(),
	code: Type.String({ minLength: 1 }),
	message: Type.String(),
	retryable: Type.Boolean(),
});
export const BridgeCancelSchema = exact({
	type: Type.Literal("bridge_cancel"),
	id: uuid(),
	request_id: uuid(),
});
export const BridgeCancelAckSchema = exact({
	type: Type.Literal("bridge_cancel_ack"),
	id: uuid(),
	request_id: uuid(),
	status: Type.Union([Type.Literal("accepted"), Type.Literal("already_terminal"), Type.Literal("unknown")]),
});

export const DaemonBridgeMessageSchema = Type.Union([BridgeRequestSchema, BridgeCancelSchema]);
export const AddonBridgeMessageSchema = Type.Union([
	BridgeProgressSchema,
	BridgeArtifactBeginSchema,
	BridgeArtifactBatchBeginSchema,
	BridgeArtifactChunkSchema,
	BridgeResultSchema,
	BridgeErrorSchema,
	BridgeCancelAckSchema,
]);

export const ClientMessageSchema = Type.Union([
	HelloSchema,
	RequestSchema,
	CancelSchema,
	RollbackAckSchema,
	ShutdownSchema,
	PingSchema,
]);
export const ServerMessageSchema = Type.Union([
	HelloAckSchema,
	ProgressSchema,
	ResponseSchema,
	ErrorSchema,
	CancelAckSchema,
	ShutdownAckSchema,
	PongSchema,
]);

export type StartupRecord = Static<typeof StartupRecordSchema>;
export type Hello = Static<typeof HelloSchema>;
export type HelloAck = Static<typeof HelloAckSchema>;
export type Request = Static<typeof RequestSchema>;
export type Cancel = Static<typeof CancelSchema>;
export type ClientMessage = Static<typeof ClientMessageSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
export type BridgeRequest = Static<typeof BridgeRequestSchema>;
export type BridgeProgress = Static<typeof BridgeProgressSchema>;
export type BridgeArtifactBegin = Static<typeof BridgeArtifactBeginSchema>;
export type BridgeArtifactBatchBegin = Static<typeof BridgeArtifactBatchBeginSchema>;
export type BridgeArtifactChunk = Static<typeof BridgeArtifactChunkSchema>;
export type BridgeResult = Static<typeof BridgeResultSchema>;
export type BridgeError = Static<typeof BridgeErrorSchema>;
export type BridgeCancel = Static<typeof BridgeCancelSchema>;
export type BridgeCancelAck = Static<typeof BridgeCancelAckSchema>;
export type DaemonBridgeMessage = Static<typeof DaemonBridgeMessageSchema>;
export type AddonBridgeMessage = Static<typeof AddonBridgeMessageSchema>;

export const parseStartupRecord = (input: unknown): StartupRecord => Parse(StartupRecordSchema, input);
export const parseHello = (input: unknown): Hello => Parse(HelloSchema, input);
export const parseHelloAck = (input: unknown): HelloAck => Parse(HelloAckSchema, input);
export const parseRequest = (input: unknown): Request => Parse(RequestSchema, input);
export const parseCancel = (input: unknown): Cancel => Parse(CancelSchema, input);
export function parseClientMessage(input: unknown): ClientMessage {
	const type = typeof input === "object" && input !== null ? (input as { type?: unknown }).type : undefined;
	switch (type) {
		case "hello":
			return Parse(HelloSchema, input);
		case "request":
			return Parse(RequestSchema, input);
		case "cancel":
			return Parse(CancelSchema, input);
		case "rollback_ack":
			return Parse(RollbackAckSchema, input);
		case "shutdown":
			return Parse(ShutdownSchema, input);
		case "ping":
			return Parse(PingSchema, input);
		default:
			throw new Error(`unknown client message type: ${String(type)}`);
	}
}

export function parseServerMessage(input: unknown): ServerMessage {
	const type = typeof input === "object" && input !== null ? (input as { type?: unknown }).type : undefined;
	switch (type) {
		case "hello_ack":
			return Parse(HelloAckSchema, input);
		case "progress":
			return Parse(ProgressSchema, input);
		case "response":
			return Parse(ResponseSchema, input);
		case "error":
			return Parse(ErrorSchema, input);
		case "cancel_ack":
			return Parse(CancelAckSchema, input);
		case "shutdown_ack":
			return Parse(ShutdownAckSchema, input);
		case "pong":
			return Parse(PongSchema, input);
		default:
			throw new Error(`unknown server message type: ${String(type)}`);
	}
}

const negotiatedMutationSessions = new WeakSet<MutationBridgeSession>();
export class MutationBridgeSession {
	readonly protocol = MUTATION_PROTOCOL_VERSION;
	readonly capability = MUTATION_BRIDGE_CAPABILITY;
	readonly supportsStageScene: boolean;
	private readonly openBridgeByRequest = new Map<string, string>();
	private readonly openRequestByBridge = new Map<string, string>();
	private readonly terminalBridgeIds = new Set<string>();

	constructor(supportsStageScene = false) {
		this.supportsStageScene = supportsStageScene;
	}

	registerRequest(message: BridgeRequest, activeRequestIds: ReadonlySet<string>): void {
		if (message.method === "stage_scene" && !this.supportsStageScene) {
			throw new Error(`stage_scene requires negotiated ${SCENE_MANIFEST_V3_CAPABILITY} capability`);
		}
		if (!activeRequestIds.has(message.request_id)) {
			throw new Error(`bridge parent ${message.request_id} is not an active top-level request`);
		}
		if (this.terminalBridgeIds.has(message.id)) {
			throw new Error(`bridge id ${message.id} reached a terminal state and cannot be replayed`);
		}
		if (this.openBridgeByRequest.has(message.request_id)) {
			throw new Error(`top-level request ${message.request_id} already has an open bridge`);
		}
		if (this.openRequestByBridge.has(message.id)) {
			throw new Error(`bridge id ${message.id} is already open`);
		}
		this.openBridgeByRequest.set(message.request_id, message.id);
		this.openRequestByBridge.set(message.id, message.request_id);
	}

	assertOpen(id: string, requestId: string): void {
		if (this.terminalBridgeIds.has(id)) {
			throw new Error(`bridge id ${id} already reached a terminal state`);
		}
		if (this.openBridgeByRequest.get(requestId) !== id || this.openRequestByBridge.get(id) !== requestId) {
			throw new Error(`bridge correlation does not match an open bridge: ${id}/${requestId}`);
		}
	}

	complete(id: string, requestId: string): void {
		this.assertOpen(id, requestId);
		this.openBridgeByRequest.delete(requestId);
		this.openRequestByBridge.delete(id);
		this.terminalBridgeIds.add(id);
	}
}

export function negotiateMutationBridge(helloInput: unknown, helloAckInput: unknown): MutationBridgeSession {
	const hello = parseHello(helloInput);
	const helloAck = parseHelloAck(helloAckInput);
	if (hello.protocol !== MUTATION_PROTOCOL_VERSION || helloAck.protocol !== MUTATION_PROTOCOL_VERSION) {
		throw new Error("mutation bridge requires a protocol v2 hello/hello_ack negotiation");
	}
	const helloCapabilities = new Set(hello.capabilities);
	if (helloAck.capabilities.some((capability) => !helloCapabilities.has(capability))) {
		throw new Error("hello_ack capability was not offered by hello");
	}
	const session = new MutationBridgeSession(
		helloCapabilities.has(SCENE_MANIFEST_V3_CAPABILITY) &&
			helloAck.capabilities.includes(SCENE_MANIFEST_V3_CAPABILITY),
	);
	negotiatedMutationSessions.add(session);
	Object.freeze(session);
	return session;
}

function assertMutationSession(session: MutationBridgeSession): void {
	if (!(session instanceof MutationBridgeSession) || !negotiatedMutationSessions.has(session)) {
		throw new Error("mutation bridge requires a negotiated protocol v2 session");
	}
}

export function parseDaemonBridgeMessage(
	input: unknown,
	session: MutationBridgeSession,
	activeRequestIds: ReadonlySet<string>,
): DaemonBridgeMessage {
	assertMutationSession(session);
	const type = typeof input === "object" && input !== null ? (input as { type?: unknown }).type : undefined;
	switch (type) {
		case "bridge_request": {
			const request = Parse(BridgeRequestSchema, input);
			session.registerRequest(request, activeRequestIds);
			return request;
		}
		case "bridge_cancel": {
			const cancel = Parse(BridgeCancelSchema, input);
			session.assertOpen(cancel.id, cancel.request_id);
			return cancel;
		}
		default:
			throw new Error(`unknown daemon bridge message type: ${String(type)}`);
	}
}

export function parseAddonBridgeMessage(input: unknown, session: MutationBridgeSession): AddonBridgeMessage {
	assertMutationSession(session);
	const type = typeof input === "object" && input !== null ? (input as { type?: unknown }).type : undefined;
	switch (type) {
		case "bridge_progress": {
			const progress = Parse(BridgeProgressSchema, input);
			if (progress.completed > progress.total) {
				throw new Error("bridge progress completed must not exceed total");
			}
			session.assertOpen(progress.id, progress.request_id);
			return progress;
		}
		case "bridge_artifact_begin": {
			const begin = Parse(BridgeArtifactBeginSchema, input);
			session.assertOpen(begin.id, begin.request_id);
			return begin;
		}
		case "bridge_artifact_batch_begin": {
			const begin = Parse(BridgeArtifactBatchBeginSchema, input);
			session.assertOpen(begin.id, begin.request_id);
			return begin;
		}
		case "bridge_artifact_chunk": {
			const chunk = Parse(BridgeArtifactChunkSchema, input);
			if (chunk.chunk_index >= chunk.total_chunks) {
				throw new Error("bridge artifact chunk index must be below total_chunks");
			}
			session.assertOpen(chunk.id, chunk.request_id);
			return chunk;
		}
		case "bridge_result": {
			const result = Parse(BridgeResultSchema, input);
			session.complete(result.id, result.request_id);
			return result;
		}
		case "bridge_error": {
			const error = Parse(BridgeErrorSchema, input);
			session.complete(error.id, error.request_id);
			return error;
		}
		case "bridge_cancel_ack": {
			const cancelAck = Parse(BridgeCancelAckSchema, input);
			session.complete(cancelAck.id, cancelAck.request_id);
			return cancelAck;
		}
		default:
			throw new Error(`unknown add-on bridge message type: ${String(type)}`);
	}
}
