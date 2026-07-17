import { type Static, Type, type TSchema } from "typebox";
import { Parse } from "typebox/value";

export const PROTOCOL_VERSION = 1;

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const HASH_64 = "^[0-9a-f]{64}$";
const BASE64URL_16 = "^[A-Za-z0-9_-]{22}$";
const BASE64URL_32 = "^[A-Za-z0-9_-]{43}$";
const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const uuid = () => Type.String({ pattern: UUID_V4_LOWERCASE });
const hash = () => Type.String({ pattern: HASH_64 });

export const StartupRecordSchema = exact({
	type: Type.Literal("omb_daemon_ready"), protocol: Type.Literal(PROTOCOL_VERSION),
	port: Type.Integer({ minimum: 1, maximum: 65_535 }), pid: Type.Integer({ minimum: 1 }),
	launch_id: uuid(), bearer_token: Type.String({ pattern: BASE64URL_32 }), expires_in_ms: Type.Literal(10_000),
});
export const HelloSchema = exact({
	type: Type.Literal("hello"), protocol: Type.Literal(PROTOCOL_VERSION), addon_version: Type.String(),
	blender_version: Type.String(), project_id: uuid(), client_nonce: Type.String({ pattern: BASE64URL_16 }),
});
export const HelloAckSchema = exact({
	type: Type.Literal("hello_ack"), protocol: Type.Literal(PROTOCOL_VERSION), daemon_version: Type.String(),
	launch_id: uuid(), session_id: uuid(), server_nonce: Type.String({ pattern: BASE64URL_16 }),
	capabilities: Type.Array(Type.String()),
});
export const RequestSchema = exact({
	type: Type.Literal("request"), id: uuid(), method: Type.String({ minLength: 1 }),
	params: Type.Record(Type.String(), Type.Unknown()), expected_revision_id: hash(),
	deadline_ms: Type.Integer({ minimum: 100, maximum: 30_000 }),
});
export const ProgressSchema = exact({ type: Type.Literal("progress"), id: uuid(), phase: Type.String(), completed: Type.Integer({ minimum: 0 }), total: Type.Integer({ minimum: 0 }) });
export const ResponseSchema = exact({ type: Type.Literal("response"), id: uuid(), result: Type.Unknown(), resulting_revision_id: hash() });
export const ErrorSchema = exact({ type: Type.Literal("error"), id: uuid(), code: Type.String(), message: Type.String(), retryable: Type.Boolean() });
export const CancelSchema = exact({ type: Type.Literal("cancel"), id: uuid() });
export const CancelAckSchema = exact({ type: Type.Literal("cancel_ack"), id: uuid(), status: Type.Union([Type.Literal("accepted"), Type.Literal("already_terminal"), Type.Literal("unknown")]) });
export const RollbackAckSchema = exact({ type: Type.Literal("rollback_ack"), id: uuid(), status: Type.Union([Type.Literal("restored"), Type.Literal("failed")]), state_hash: hash() });
export const ShutdownSchema = exact({ type: Type.Literal("shutdown"), reason: Type.String() });
export const ShutdownAckSchema = exact({ type: Type.Literal("shutdown_ack") });
export const PingSchema = exact({ type: Type.Literal("ping"), nonce: Type.String() });
export const PongSchema = exact({ type: Type.Literal("pong"), nonce: Type.String() });

export const ClientMessageSchema = Type.Union([HelloSchema, RequestSchema, CancelSchema, RollbackAckSchema, ShutdownSchema, PingSchema]);
export const ServerMessageSchema = Type.Union([HelloAckSchema, ProgressSchema, ResponseSchema, ErrorSchema, CancelAckSchema, ShutdownAckSchema, PongSchema]);

export type StartupRecord = Static<typeof StartupRecordSchema>;
export type Hello = Static<typeof HelloSchema>;
export type HelloAck = Static<typeof HelloAckSchema>;
export type Request = Static<typeof RequestSchema>;
export type Cancel = Static<typeof CancelSchema>;
export type ClientMessage = Static<typeof ClientMessageSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;

export const parseStartupRecord = (input: unknown): StartupRecord => Parse(StartupRecordSchema, input);
export const parseHello = (input: unknown): Hello => Parse(HelloSchema, input);
export const parseHelloAck = (input: unknown): HelloAck => Parse(HelloAckSchema, input);
export const parseRequest = (input: unknown): Request => Parse(RequestSchema, input);
export const parseCancel = (input: unknown): Cancel => Parse(CancelSchema, input);
export function parseClientMessage(input: unknown): ClientMessage {
	const type = typeof input === "object" && input !== null ? (input as { type?: unknown }).type : undefined;
	switch (type) {
		case "hello": return Parse(HelloSchema, input);
		case "request": return Parse(RequestSchema, input);
		case "cancel": return Parse(CancelSchema, input);
		case "rollback_ack": return Parse(RollbackAckSchema, input);
		case "shutdown": return Parse(ShutdownSchema, input);
		case "ping": return Parse(PingSchema, input);
		default: throw new Error(`unknown client message type: ${String(type)}`);
	}
}

export function parseServerMessage(input: unknown): ServerMessage {
	const type = typeof input === "object" && input !== null ? (input as { type?: unknown }).type : undefined;
	switch (type) {
		case "hello_ack": return Parse(HelloAckSchema, input);
		case "progress": return Parse(ProgressSchema, input);
		case "response": return Parse(ResponseSchema, input);
		case "error": return Parse(ErrorSchema, input);
		case "cancel_ack": return Parse(CancelAckSchema, input);
		case "shutdown_ack": return Parse(ShutdownAckSchema, input);
		case "pong": return Parse(PongSchema, input);
		default: throw new Error(`unknown server message type: ${String(type)}`);
	}
}
