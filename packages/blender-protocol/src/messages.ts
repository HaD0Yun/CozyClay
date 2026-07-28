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
const ISO_8601_UTC = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";

export const StartupRecordSchema = exact({
	type: Type.Literal("cclay_daemon_ready"),
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
export const TRANSACTION_COMMIT_CAPABILITY = "transaction_commit_v2";
export const DIRECTOR_TURN_CAPABILITY = "director_turn_v1";
export const DIRECTOR_TRANSCRIPT_CAPABILITY = "director_transcript_v1";
export const DIRECTOR_STREAM_CAPABILITY = "director_stream_v1";
export const CONTROLLER_PEERS_CAPABILITY = "controller_peers_v1";
export const SNAPSHOT_CURSOR_V2_FEATURE = "snapshot_cursor_v2";
// Addon-reported staleness surface: `cclay.addon_version=<semver>`,
// `cclay.method.<bridge_method>`, `cclay.op.<stage_scene_op>`. These ride the
// hello capabilities array without widening the negotiated core set.
const NAMESPACED_CAPABILITY_PATTERN = "^cclay\\.[A-Za-z0-9_.=-]+$";
const mutationCapabilities = () =>
	Type.Union([
		Type.Tuple([Type.Literal(MUTATION_BRIDGE_CAPABILITY)]),
		Type.Tuple([Type.Literal(MUTATION_BRIDGE_CAPABILITY), Type.Literal(SCENE_MANIFEST_V3_CAPABILITY)]),
		Type.Tuple([Type.Literal(MUTATION_BRIDGE_CAPABILITY), Type.Literal(TRANSACTION_COMMIT_CAPABILITY)]),
		Type.Tuple([
			Type.Literal(MUTATION_BRIDGE_CAPABILITY),
			Type.Literal(SCENE_MANIFEST_V3_CAPABILITY),
			Type.Literal(TRANSACTION_COMMIT_CAPABILITY),
		]),
	]);
// The addon->daemon hello additionally carries namespaced cclay.* surface
// entries; every non-namespaced entry must still be one of the closed core
// capabilities, and negotiateMutationBridge requires mutation_bridge_v2.
const helloMutationCapabilities = () =>
	Type.Array(
		Type.Union([
			Type.Literal(MUTATION_BRIDGE_CAPABILITY),
			Type.Literal(SCENE_MANIFEST_V3_CAPABILITY),
			Type.Literal(TRANSACTION_COMMIT_CAPABILITY),
			Type.String({ pattern: NAMESPACED_CAPABILITY_PATTERN }),
		]),
	);

export const HelloV1Schema = exact({
	...helloProperties,
	protocol: Type.Literal(PROTOCOL_VERSION),
});
export const HelloV2Schema = exact({
	...helloProperties,
	protocol: Type.Literal(MUTATION_PROTOCOL_VERSION),
	capabilities: helloMutationCapabilities(),
});
export const HelloSchema = Type.Union([HelloV1Schema, HelloV2Schema]);
export const HelloAckV1Schema = exact({
	...helloAckProperties,
	protocol: Type.Literal(PROTOCOL_VERSION),
	capabilities: Type.Array(Type.String()),
});
export const HelloAckControllerV1Schema = exact({
	...helloAckProperties,
	protocol: Type.Literal(PROTOCOL_VERSION),
	capabilities: Type.Array(Type.String()),
	protocol_features: Type.Tuple([Type.Literal(SNAPSHOT_CURSOR_V2_FEATURE)]),
});
export const HelloAckV2Schema = exact({
	...helloAckProperties,
	protocol: Type.Literal(MUTATION_PROTOCOL_VERSION),
	capabilities: mutationCapabilities(),
});
export const HelloAckSchema = Type.Union([HelloAckV1Schema, HelloAckControllerV1Schema, HelloAckV2Schema]);
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
// Director turns wrap several sequential model roundtrips (inspect, mutation,
// verification, QA, summary); a single-request 30s ceiling starves them, so
// turns carry their own deadline ceiling. Bridge sub-operations spawned by a
// turn remain capped at the 30s single-request ceiling.
export const DIRECTOR_TURN_DEADLINE_MAX_MS = 300_000;
export const DirectorTurnSchema = exact({
	type: Type.Literal("director_turn"),
	id: uuid(),
	prompt: Type.String({ minLength: 1, maxLength: 8_192 }),
	expected_revision_id: hash(),
	deadline_ms: Type.Integer({ minimum: 100, maximum: DIRECTOR_TURN_DEADLINE_MAX_MS }),
});
export const DIRECTOR_TRANSCRIPT_MAX_EVENTS = 10_000;
export const DIRECTOR_TRANSCRIPT_MAX_PAGE_SIZE = 64;
export const DirectorTranscriptRequestV1Schema = exact({
	type: Type.Literal("director_transcript_request"),
	id: uuid(),
	cursor: Type.Integer({ minimum: 0, maximum: DIRECTOR_TRANSCRIPT_MAX_EVENTS }),
	page_size: Type.Integer({ minimum: 1, maximum: DIRECTOR_TRANSCRIPT_MAX_PAGE_SIZE }),
});
export const DirectorTranscriptRequestV2Schema = exact({
	type: Type.Literal("director_transcript_request"),
	id: uuid(),
	cursor: Type.Integer({ minimum: 0, maximum: DIRECTOR_TRANSCRIPT_MAX_EVENTS }),
	page_size: Type.Integer({ minimum: 1, maximum: DIRECTOR_TRANSCRIPT_MAX_PAGE_SIZE }),
	snapshot_cursor: Type.Union([Type.Integer({ minimum: 0, maximum: DIRECTOR_TRANSCRIPT_MAX_EVENTS }), Type.Null()]),
});
export const DirectorTranscriptRequestSchema = Type.Union([
	DirectorTranscriptRequestV1Schema,
	DirectorTranscriptRequestV2Schema,
]);
const directorToolName = () =>
	Type.Union([
		Type.Literal("inspect_project"),
		Type.Literal("stage_scene"),
		Type.Literal("apply_camera_plan"),
		Type.Literal("render_qa_frames"),
	]);
const directorEventProperties = {
	id: uuid(),
	sequence: Type.Integer({ minimum: 0 }),
	at: Type.String({ pattern: ISO_8601_UTC }),
};
export const DIRECTOR_DELTA_MAX_BYTES = 4_096;
export const DIRECTOR_UTTERANCE_MAX_BYTES = 16_384;
export const DIRECTOR_DELTA_SEQUENCE_MAX = 1_000_000;
export const DirectorTurnDeltaSchema = exact({
	type: Type.Literal("director_turn_delta"),
	id: uuid(),
	segment_id: uuid(),
	content_index: Type.Integer({ minimum: 0, maximum: 31 }),
	delta_sequence: Type.Integer({ minimum: 0, maximum: DIRECTOR_DELTA_SEQUENCE_MAX }),
	delta: Type.String({ minLength: 1, maxLength: DIRECTOR_DELTA_MAX_BYTES }),
});
export const DirectorAssistantUtteranceSchema = exact({
	type: Type.Literal("director_assistant_utterance"),
	...directorEventProperties,
	segment_id: uuid(),
	content_index: Type.Integer({ minimum: 0, maximum: 31 }),
	through_delta_sequence: Type.Integer({ minimum: -1, maximum: DIRECTOR_DELTA_SEQUENCE_MAX }),
	content: Type.String({ minLength: 1, maxLength: DIRECTOR_UTTERANCE_MAX_BYTES }),
});
export const DirectorTurnStartedSchema = exact({
	type: Type.Literal("director_turn_started"),
	...directorEventProperties,
	prompt: Type.String({ minLength: 1, maxLength: 8_192 }),
});
export const DirectorToolCallStartedSchema = exact({
	type: Type.Literal("director_tool_call_started"),
	...directorEventProperties,
	tool_call_id: Type.String({ minLength: 1, maxLength: 128 }),
	tool_name: directorToolName(),
	params_summary: Type.String({ maxLength: 512 }),
});
export const DirectorToolCallFinishedSchema = exact({
	type: Type.Literal("director_tool_call_finished"),
	...directorEventProperties,
	tool_call_id: Type.String({ minLength: 1, maxLength: 128 }),
	tool_name: directorToolName(),
	result_digest: hash(),
	is_error: Type.Boolean(),
});
export const DirectorTurnCompletedSchema = exact({
	type: Type.Literal("director_turn_completed"),
	...directorEventProperties,
	summary: Type.String({ minLength: 1, maxLength: 8_192 }),
	resulting_revision_id: hash(),
});
export const DirectorTurnFailedSchema = exact({
	type: Type.Literal("director_turn_failed"),
	...directorEventProperties,
	code: Type.String({ minLength: 1, maxLength: 128 }),
	message: Type.String({ maxLength: 1_024 }),
	retryable: Type.Boolean(),
});
export const DirectorTurnCancelledSchema = exact({
	type: Type.Literal("director_turn_cancelled"),
	...directorEventProperties,
});
export const DirectorTurnEventSchema = Type.Union([
	DirectorTurnStartedSchema,
	DirectorAssistantUtteranceSchema,
	DirectorToolCallStartedSchema,
	DirectorToolCallFinishedSchema,
	DirectorTurnCompletedSchema,
	DirectorTurnFailedSchema,
	DirectorTurnCancelledSchema,
]);
export const DirectorTranscriptV1Schema = exact({
	type: Type.Literal("director_transcript"),
	id: uuid(),
	session_id: uuid(),
	events: Type.Array(DirectorTurnEventSchema, { maxItems: DIRECTOR_TRANSCRIPT_MAX_PAGE_SIZE }),
	next_cursor: Type.Union([Type.Integer({ minimum: 1, maximum: DIRECTOR_TRANSCRIPT_MAX_EVENTS }), Type.Null()]),
});
export const DirectorTranscriptV2Schema = exact({
	type: Type.Literal("director_transcript"),
	schema_version: Type.Literal(2),
	id: uuid(),
	session_id: uuid(),
	events: Type.Array(DirectorTurnEventSchema, { maxItems: DIRECTOR_TRANSCRIPT_MAX_PAGE_SIZE }),
	next_cursor: Type.Union([Type.Integer({ minimum: 1, maximum: DIRECTOR_TRANSCRIPT_MAX_EVENTS }), Type.Null()]),
	snapshot_cursor: Type.Integer({ minimum: 0, maximum: DIRECTOR_TRANSCRIPT_MAX_EVENTS }),
});
export const DirectorTranscriptSchema = Type.Union([DirectorTranscriptV1Schema, DirectorTranscriptV2Schema]);
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
const generation = () => Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
export const ControllerAuthSchema = exact({
	type: Type.Literal("controller_auth"),
	resume_token: Type.String({ pattern: BASE64URL_32 }),
	launch_id: uuid(),
});
export const ControllerPeerAuthSchema = exact({
	type: Type.Literal("controller_peer_auth"),
	resume_token: Type.String({ pattern: BASE64URL_32 }),
	launch_id: uuid(),
	lineage_id: uuid(),
	generation: generation(),
	expires_in_ms: Type.Literal(300_000),
});
export const PublishBridgeDiscoverySlotSchema = exact({
	type: Type.Literal("publish_bridge_discovery_slot"),
	id: uuid(),
});
export const BridgeDiscoverySlotAckSchema = exact({
	type: Type.Literal("bridge_discovery_slot_ack"),
	id: uuid(),
	generation: generation(),
	expires_in_ms: Type.Literal(15_000),
});
export const PublishControllerPeerDiscoverySlotSchema = exact({
	type: Type.Literal("publish_controller_peer_discovery_slot"),
	id: uuid(),
	lineage_id: uuid(),
});
export const ControllerPeerDiscoverySlotAckSchema = exact({
	type: Type.Literal("controller_peer_discovery_slot_ack"),
	id: uuid(),
	lineage_id: uuid(),
	generation: generation(),
	expires_in_ms: Type.Literal(15_000),
});
export const RevokeControllerPeerSchema = exact({
	type: Type.Literal("revoke_controller_peer"),
	id: uuid(),
	lineage_id: uuid(),
});
export const RevokeControllerPeerAckSchema = exact({
	type: Type.Literal("revoke_controller_peer_ack"),
	id: uuid(),
	lineage_id: uuid(),
	status: Type.Literal("revoked"),
});
export const IssueAttachTicketV1Schema = exact({
	type: Type.Literal("issue_attach_ticket"),
	role: Type.Literal("bridge"),
});
export const IssueAttachTicketV2Schema = exact({
	type: Type.Literal("issue_attach_ticket"),
	id: uuid(),
	role: Type.Literal("bridge"),
});
export const IssueAttachTicketSchema = Type.Union([IssueAttachTicketV1Schema, IssueAttachTicketV2Schema]);
export const AttachTicketSchema = exact({
	type: Type.Literal("attach_ticket"),
	id: uuid(),
	role: Type.Literal("bridge"),
	ticket: Type.String({ pattern: BASE64URL_32 }),
	expires_in_ms: Type.Literal(15_000),
	generation: generation(),
});
export const BridgeTransactionPreparedSchema = exact({
	type: Type.Literal("bridge_transaction_prepared"),
	id: uuid(),
	transaction_id: uuid(),
	operation: Type.Union([Type.Literal("stage_scene"), Type.Literal("apply_camera_plan")]),
	project_id: uuid(),
	base_revision_id: hash(),
	base_scene_hash: hash(),
	candidate_revision_id: hash(),
	candidate_scene_hash: hash(),
	base_backup_sha256: hash(),
	canonical_blend_sha256: hash(),
});
export const BridgeTransactionAckSchema = exact({
	type: Type.Literal("bridge_transaction_ack"),
	id: uuid(),
	transaction_id: uuid(),
	status: Type.Literal("committed"),
	resulting_revision_id: hash(),
});
export const BridgeTransactionAcknowledgedSchema = exact({
	type: Type.Literal("bridge_transaction_acknowledged"),
	id: uuid(),
	transaction_id: uuid(),
});
export const BridgeTransactionReconcileSchema = exact({
	type: Type.Literal("bridge_transaction_reconcile"),
	id: uuid(),
	project_id: uuid(),
	transaction_id: uuid(),
	marker_phase: Type.Union([
		Type.Literal("prepared"),
		Type.Literal("candidate_saved"),
		Type.Literal("manifest_committed"),
		Type.Literal("acknowledged"),
		Type.Literal("rollback_saved"),
	]),
});
export const BridgeTransactionStatusSchema = exact({
	type: Type.Literal("bridge_transaction_status"),
	id: uuid(),
	transaction_id: uuid(),
	status: Type.Union([
		Type.Literal("base_authoritative"),
		Type.Literal("candidate_authoritative"),
		Type.Literal("unknown"),
	]),
	revision_id: hash(),
});
const bridgeTransactionError = <Code extends string, Message extends string>(code: Code, message: Message) =>
	exact({
		type: Type.Literal("bridge_transaction_error"),
		id: uuid(),
		transaction_id: uuid(),
		code: Type.Literal(code),
		message: Type.Literal(message),
		retryable: Type.Literal(false),
	});
export const BridgeTransactionErrorSchema = Type.Union([
	bridgeTransactionError("TRANSACTION_CONFLICT", "transaction id was reused with different content"),
	bridgeTransactionError("TRANSACTION_NOT_FOUND", "transaction is unavailable"),
	bridgeTransactionError("TRANSACTION_EVIDENCE_INVALID", "transaction recovery evidence is invalid"),
	bridgeTransactionError("TRANSACTION_STATE_INVALID", "transaction phase is invalid"),
]);
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

export const DaemonBridgeMessageSchema = Type.Union([
	BridgeRequestSchema,
	BridgeCancelSchema,
	BridgeTransactionAckSchema,
	BridgeTransactionStatusSchema,
	BridgeTransactionErrorSchema,
]);
export const AddonBridgeMessageSchema = Type.Union([
	BridgeProgressSchema,
	BridgeArtifactBeginSchema,
	BridgeArtifactBatchBeginSchema,
	BridgeArtifactChunkSchema,
	BridgeResultSchema,
	BridgeErrorSchema,
	BridgeCancelAckSchema,
	BridgeTransactionPreparedSchema,
	BridgeTransactionAcknowledgedSchema,
	BridgeTransactionReconcileSchema,
]);

export const ClientMessageSchema = Type.Union([
	HelloSchema,
	RequestSchema,
	DirectorTurnSchema,
	DirectorTranscriptRequestSchema,
	PublishBridgeDiscoverySlotSchema,
	PublishControllerPeerDiscoverySlotSchema,
	RevokeControllerPeerSchema,
	IssueAttachTicketSchema,
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
	DirectorTurnDeltaSchema,
	ControllerAuthSchema,
	ControllerPeerAuthSchema,
	BridgeDiscoverySlotAckSchema,
	ControllerPeerDiscoverySlotAckSchema,
	RevokeControllerPeerAckSchema,
	AttachTicketSchema,
	DirectorTurnEventSchema,
	DirectorTranscriptSchema,
]);

export type StartupRecord = Static<typeof StartupRecordSchema>;
export type Hello = Static<typeof HelloSchema>;
export type HelloAck = Static<typeof HelloAckSchema>;
export type Request = Static<typeof RequestSchema>;
export type Cancel = Static<typeof CancelSchema>;
export type ClientMessage = Static<typeof ClientMessageSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
export type DirectorTurn = Static<typeof DirectorTurnSchema>;
export type DirectorTranscriptRequest = Static<typeof DirectorTranscriptRequestSchema>;
export type DirectorToolName = Static<ReturnType<typeof directorToolName>>;
export type DirectorTurnEvent = Static<typeof DirectorTurnEventSchema>;
export type DirectorTranscript = Static<typeof DirectorTranscriptSchema>;
export type DirectorTurnDelta = Static<typeof DirectorTurnDeltaSchema>;
export type DirectorAssistantUtterance = Static<typeof DirectorAssistantUtteranceSchema>;
export type ControllerAuth = Static<typeof ControllerAuthSchema>;
export type ControllerPeerAuth = Static<typeof ControllerPeerAuthSchema>;
export type PublishBridgeDiscoverySlot = Static<typeof PublishBridgeDiscoverySlotSchema>;
export type BridgeDiscoverySlotAck = Static<typeof BridgeDiscoverySlotAckSchema>;
export type PublishControllerPeerDiscoverySlot = Static<typeof PublishControllerPeerDiscoverySlotSchema>;
export type ControllerPeerDiscoverySlotAck = Static<typeof ControllerPeerDiscoverySlotAckSchema>;
export type RevokeControllerPeer = Static<typeof RevokeControllerPeerSchema>;
export type RevokeControllerPeerAck = Static<typeof RevokeControllerPeerAckSchema>;
export type BridgeTransactionPrepared = Static<typeof BridgeTransactionPreparedSchema>;
export type BridgeTransactionAck = Static<typeof BridgeTransactionAckSchema>;
export type BridgeTransactionAcknowledged = Static<typeof BridgeTransactionAcknowledgedSchema>;
export type BridgeTransactionReconcile = Static<typeof BridgeTransactionReconcileSchema>;
export type BridgeTransactionStatus = Static<typeof BridgeTransactionStatusSchema>;
export type BridgeTransactionError = Static<typeof BridgeTransactionErrorSchema>;
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
export const parseDirectorTurn = (input: unknown): DirectorTurn => Parse(DirectorTurnSchema, input);
export function parseDirectorTranscriptRequest(input: unknown): DirectorTranscriptRequest {
	const request = Parse(DirectorTranscriptRequestSchema, input);
	if ("snapshot_cursor" in request) {
		if (request.snapshot_cursor === null && request.cursor !== 0) {
			throw new Error("the first transcript snapshot request must start at cursor zero");
		}
		if (request.snapshot_cursor !== null && request.cursor > request.snapshot_cursor) {
			throw new Error("transcript cursor must not exceed its snapshot cursor");
		}
	}
	return request;
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

export function parseDirectorTurnDelta(input: unknown): DirectorTurnDelta {
	const event = Parse(DirectorTurnDeltaSchema, input);
	if (utf8ByteLength(event.delta) > DIRECTOR_DELTA_MAX_BYTES) {
		throw new Error(`director delta exceeds ${DIRECTOR_DELTA_MAX_BYTES} UTF-8 bytes`);
	}
	return event;
}

export function parseDirectorTurnEvent(input: unknown): DirectorTurnEvent {
	const event = Parse(DirectorTurnEventSchema, input);
	if (event.type === "director_assistant_utterance" && utf8ByteLength(event.content) > DIRECTOR_UTTERANCE_MAX_BYTES) {
		throw new Error(`director utterance exceeds ${DIRECTOR_UTTERANCE_MAX_BYTES} UTF-8 bytes`);
	}
	return event;
}

export function parseDirectorTranscript(input: unknown): DirectorTranscript {
	const transcript = Parse(DirectorTranscriptSchema, input);
	for (const event of transcript.events) parseDirectorTurnEvent(event);
	if (
		"snapshot_cursor" in transcript &&
		transcript.next_cursor !== null &&
		transcript.next_cursor > transcript.snapshot_cursor
	) {
		throw new Error("next transcript cursor must not exceed its snapshot cursor");
	}
	return transcript;
}
export function parseClientMessage(input: unknown): ClientMessage {
	const type = typeof input === "object" && input !== null ? (input as { type?: unknown }).type : undefined;
	switch (type) {
		case "hello":
			return Parse(HelloSchema, input);
		case "request":
			return Parse(RequestSchema, input);
		case "director_turn":
			return Parse(DirectorTurnSchema, input);
		case "director_transcript_request":
			return parseDirectorTranscriptRequest(input);
		case "publish_bridge_discovery_slot":
			return Parse(PublishBridgeDiscoverySlotSchema, input);
		case "publish_controller_peer_discovery_slot":
			return Parse(PublishControllerPeerDiscoverySlotSchema, input);
		case "revoke_controller_peer":
			return Parse(RevokeControllerPeerSchema, input);
		case "issue_attach_ticket":
			return Parse(IssueAttachTicketSchema, input);
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
		case "director_turn_delta":
			return parseDirectorTurnDelta(input);
		case "controller_auth":
			return Parse(ControllerAuthSchema, input);
		case "controller_peer_auth":
			return Parse(ControllerPeerAuthSchema, input);
		case "bridge_discovery_slot_ack":
			return Parse(BridgeDiscoverySlotAckSchema, input);
		case "controller_peer_discovery_slot_ack":
			return Parse(ControllerPeerDiscoverySlotAckSchema, input);
		case "revoke_controller_peer_ack":
			return Parse(RevokeControllerPeerAckSchema, input);
		case "attach_ticket":
			return Parse(AttachTicketSchema, input);
		case "director_turn_started":
		case "director_assistant_utterance":
		case "director_tool_call_started":
		case "director_tool_call_finished":
		case "director_turn_completed":
		case "director_turn_failed":
		case "director_turn_cancelled":
			return parseDirectorTurnEvent(input);
		case "director_transcript":
			return parseDirectorTranscript(input);
		default:
			throw new Error(`unknown server message type: ${String(type)}`);
	}
}

const negotiatedMutationSessions = new WeakSet<MutationBridgeSession>();
export class MutationBridgeSession {
	readonly protocol = MUTATION_PROTOCOL_VERSION;
	readonly capability = MUTATION_BRIDGE_CAPABILITY;
	readonly supportsStageScene: boolean;
	readonly supportsTransactionCommits: boolean;
	private readonly openBridgeByRequest = new Map<string, string>();
	private readonly openRequestByBridge = new Map<string, string>();
	private readonly terminalBridgeIds = new Set<string>();

	constructor(supportsStageScene = false, supportsTransactionCommits = false) {
		this.supportsStageScene = supportsStageScene;
		this.supportsTransactionCommits = supportsTransactionCommits;
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
	// The hello capability shape tolerates namespaced cclay.* surface entries, so
	// the mutation core must be asserted explicitly (the tuple shape used to).
	if (!helloCapabilities.has(MUTATION_BRIDGE_CAPABILITY)) {
		throw new Error(`hello must offer the ${MUTATION_BRIDGE_CAPABILITY} capability`);
	}
	if (helloAck.capabilities.some((capability) => !helloCapabilities.has(capability))) {
		throw new Error("hello_ack capability was not offered by hello");
	}
	const helloAckCapabilities = helloAck.capabilities as readonly string[];
	const session = new MutationBridgeSession(
		helloCapabilities.has(SCENE_MANIFEST_V3_CAPABILITY) &&
			helloAckCapabilities.includes(SCENE_MANIFEST_V3_CAPABILITY),
		helloCapabilities.has(TRANSACTION_COMMIT_CAPABILITY) &&
			helloAckCapabilities.includes(TRANSACTION_COMMIT_CAPABILITY),
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
function assertTransactionCapability(session: MutationBridgeSession): void {
	if (!session.supportsTransactionCommits) {
		throw new Error(`bridge transaction requires negotiated ${TRANSACTION_COMMIT_CAPABILITY} capability`);
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
		case "bridge_transaction_ack":
			assertTransactionCapability(session);
			return Parse(BridgeTransactionAckSchema, input);
		case "bridge_transaction_status":
			assertTransactionCapability(session);
			return Parse(BridgeTransactionStatusSchema, input);
		case "bridge_transaction_error":
			assertTransactionCapability(session);
			return Parse(BridgeTransactionErrorSchema, input);
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
		case "bridge_transaction_prepared":
			assertTransactionCapability(session);
			return Parse(BridgeTransactionPreparedSchema, input);
		case "bridge_transaction_acknowledged":
			assertTransactionCapability(session);
			return Parse(BridgeTransactionAcknowledgedSchema, input);
		case "bridge_transaction_reconcile":
			assertTransactionCapability(session);
			return Parse(BridgeTransactionReconcileSchema, input);
		default:
			throw new Error(`unknown add-on bridge message type: ${String(type)}`);
	}
}
