import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const HASH_64 = "^[0-9a-f]{64}$";
const BASE64URL_32_BYTES = "^[A-Za-z0-9_-]{43}$";
const EXTERNAL_SIDE_EFFECT_DISCLOSURE =
	"Blender scene state rolled back; external side effects (files, network, processes) are not and cannot be undone.";

const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

/** Protocol version for the Blender-owned loopback execution transport. */
export const EXECUTE_BLENDER_PYTHON_PROTOCOL_VERSION = 1;
/** UTF-8 input ceiling for one Blender Python execution request. */
export const EXECUTE_BLENDER_PYTHON_MAX_SCRIPT_BYTES = 8192;
/** UTF-8 output capture ceiling for one Blender Python execution result. */
export const EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES = 4096;
export const EXECUTE_BLENDER_PYTHON_MAX_DEADLINE_MS = 30_000;
export const EXECUTE_BLENDER_PYTHON_MAX_ERROR_MESSAGE_BYTES = 1024;
export const EXECUTE_BLENDER_PYTHON_MAX_TRACEBACK_BYTES = 8192;
export const EXECUTE_BLENDER_PYTHON_MAX_REASON_BYTES = 256;
export const EXECUTE_BLENDER_PYTHON_MAX_CAPABILITIES = 16;
export const EXECUTE_BLENDER_PYTHON_EXTERNAL_SIDE_EFFECT_DISCLOSURE = EXTERNAL_SIDE_EFFECT_DISCLOSURE;

const requestId = () => Type.String({ pattern: UUID_V4_LOWERCASE });
const revisionId = () => Type.String({ pattern: HASH_64 });
const capturedOutput = () => Type.String({ maxLength: EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES });

export const ExecuteBlenderPythonRequestV1Schema = exact({
	type: Type.Literal("execute_blender_python"),
	request_id: requestId(),
	script: Type.String({ minLength: 1, maxLength: EXECUTE_BLENDER_PYTHON_MAX_SCRIPT_BYTES }),
	deadline_ms: Type.Integer({ minimum: 1, maximum: EXECUTE_BLENDER_PYTHON_MAX_DEADLINE_MS }),
	capture_stdout: Type.Boolean(),
	expected_revision_id: revisionId(),
});

const executionResultBase = {
	type: Type.Literal("execute_result"),
	request_id: requestId(),
};

export const ExecuteBlenderPythonSuccessResultV1Schema = exact({
	...executionResultBase,
	outcome: Type.Literal("success"),
	new_revision_id: revisionId(),
	stdout: capturedOutput(),
	stdout_truncated: Type.Boolean(),
	stderr: capturedOutput(),
	stderr_truncated: Type.Boolean(),
});

export const ExecuteBlenderPythonFailedRecoveredResultV1Schema = exact({
	...executionResultBase,
	outcome: Type.Literal("failed_recovered"),
	restored_revision_id: revisionId(),
	error: exact({
		message: Type.String({ minLength: 1, maxLength: EXECUTE_BLENDER_PYTHON_MAX_ERROR_MESSAGE_BYTES }),
		traceback: Type.String({ minLength: 1, maxLength: EXECUTE_BLENDER_PYTHON_MAX_TRACEBACK_BYTES }),
	}),
	stdout: capturedOutput(),
	stdout_truncated: Type.Boolean(),
	stderr: capturedOutput(),
	stderr_truncated: Type.Boolean(),
	disclosure: Type.Literal(EXTERNAL_SIDE_EFFECT_DISCLOSURE),
});

export const ExecuteBlenderPythonRecoveryRequiredResultV1Schema = exact({
	...executionResultBase,
	outcome: Type.Literal("recovery_required"),
	journal_status: Type.Literal("recovery_verification_failed"),
});

export const ExecuteBlenderPythonOutcomeUnknownResultV1Schema = exact({
	...executionResultBase,
	outcome: Type.Literal("outcome_unknown"),
	reason: Type.String({ minLength: 1, maxLength: EXECUTE_BLENDER_PYTHON_MAX_REASON_BYTES }),
});

/** The four terminal post-start outcomes; excludes pre-execution rejections. */
export const ExecuteBlenderPythonResultV1Schema = Type.Union([
	ExecuteBlenderPythonSuccessResultV1Schema,
	ExecuteBlenderPythonFailedRecoveredResultV1Schema,
	ExecuteBlenderPythonRecoveryRequiredResultV1Schema,
	ExecuteBlenderPythonOutcomeUnknownResultV1Schema,
]);

export const ExecuteBlenderPythonPreconditionFailedV1Schema = exact({
	type: Type.Literal("precondition_failed"),
	request_id: requestId(),
	code: Type.Union([
		Type.Literal("BACKUP_UNAVAILABLE"),
		Type.Literal("UNSAVED_PROJECT"),
		Type.Literal("REVISION_STALE"),
		Type.Literal("AUTH_INVALID"),
		Type.Literal("VERSION_MISMATCH"),
	]),
	message: Type.String({ minLength: 1, maxLength: EXECUTE_BLENDER_PYTHON_MAX_ERROR_MESSAGE_BYTES }),
});

/** A response may include a pre-execution rejection, but it is not an execution outcome. */
export const ExecuteBlenderPythonResponseV1Schema = Type.Union([
	ExecuteBlenderPythonResultV1Schema,
	ExecuteBlenderPythonPreconditionFailedV1Schema,
]);

export const GetExecutionOutcomeRequestV1Schema = exact({
	type: Type.Literal("get_execution_outcome"),
	request_id: requestId(),
});

export const ExecutionOutcomeNotFoundV1Schema = exact({
	type: Type.Literal("execution_outcome_not_found"),
	request_id: requestId(),
});

export const GetExecutionOutcomeResponseV1Schema = Type.Union([
	ExecuteBlenderPythonResultV1Schema,
	ExecutionOutcomeNotFoundV1Schema,
]);

export const BlenderBridgeDiscoveryV1Schema = exact({
	schema_version: Type.Literal(1),
	host: Type.Literal("127.0.0.1"),
	port: Type.Integer({ minimum: 1, maximum: 65535 }),
	pid: Type.Integer({ minimum: 1 }),
	token: Type.String({ pattern: BASE64URL_32_BYTES }),
	token_generation: Type.Integer({ minimum: 0 }),
	addon_version: Type.String({ minLength: 1, maxLength: 64 }),
	protocol_version: Type.Literal(EXECUTE_BLENDER_PYTHON_PROTOCOL_VERSION),
});

export const BlenderBridgeHelloV1Schema = exact({
	type: Type.Literal("hello"),
	token: Type.String({ pattern: BASE64URL_32_BYTES }),
	client: Type.Literal("cclay-extension"),
	protocol_version: Type.Literal(EXECUTE_BLENDER_PYTHON_PROTOCOL_VERSION),
	capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
		maxItems: EXECUTE_BLENDER_PYTHON_MAX_CAPABILITIES,
	}),
});

export const BlenderBridgeHelloAckV1Schema = exact({
	type: Type.Literal("hello_ack"),
	addon_version: Type.String({ minLength: 1, maxLength: 64 }),
	protocol_version: Type.Literal(EXECUTE_BLENDER_PYTHON_PROTOCOL_VERSION),
	capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
		maxItems: EXECUTE_BLENDER_PYTHON_MAX_CAPABILITIES,
	}),
});

export const BlenderBridgeHelloRejectV1Schema = exact({
	type: Type.Literal("hello_reject"),
	reason: Type.Union([
		Type.Literal("BAD_TOKEN"),
		Type.Literal("VERSION_MISMATCH"),
		Type.Literal("QUEUE_FULL"),
		Type.Literal("PROJECT_ALREADY_ATTACHED"),
	]),
});

export type ExecuteBlenderPythonRequestV1 = Static<typeof ExecuteBlenderPythonRequestV1Schema>;
export type ExecuteBlenderPythonSuccessResultV1 = Static<typeof ExecuteBlenderPythonSuccessResultV1Schema>;
export type ExecuteBlenderPythonFailedRecoveredResultV1 = Static<
	typeof ExecuteBlenderPythonFailedRecoveredResultV1Schema
>;
export type ExecuteBlenderPythonRecoveryRequiredResultV1 = Static<
	typeof ExecuteBlenderPythonRecoveryRequiredResultV1Schema
>;
export type ExecuteBlenderPythonOutcomeUnknownResultV1 = Static<
	typeof ExecuteBlenderPythonOutcomeUnknownResultV1Schema
>;
export type ExecuteBlenderPythonResultV1 = Static<typeof ExecuteBlenderPythonResultV1Schema>;
export type ExecuteBlenderPythonPreconditionFailedV1 = Static<typeof ExecuteBlenderPythonPreconditionFailedV1Schema>;
export type ExecuteBlenderPythonResponseV1 = Static<typeof ExecuteBlenderPythonResponseV1Schema>;
export type GetExecutionOutcomeRequestV1 = Static<typeof GetExecutionOutcomeRequestV1Schema>;
export type ExecutionOutcomeNotFoundV1 = Static<typeof ExecutionOutcomeNotFoundV1Schema>;
export type GetExecutionOutcomeResponseV1 = Static<typeof GetExecutionOutcomeResponseV1Schema>;
export type BlenderBridgeDiscoveryV1 = Static<typeof BlenderBridgeDiscoveryV1Schema>;
export type BlenderBridgeHelloV1 = Static<typeof BlenderBridgeHelloV1Schema>;
export type BlenderBridgeHelloAckV1 = Static<typeof BlenderBridgeHelloAckV1Schema>;
export type BlenderBridgeHelloRejectV1 = Static<typeof BlenderBridgeHelloRejectV1Schema>;

const utf8Encoder = new TextEncoder();

function assertUtf8ByteLength(value: string, maximum: number, errorCode: string): void {
	if (utf8Encoder.encode(value).byteLength > maximum) {
		throw new Error(`${errorCode}: string exceeds ${maximum} UTF-8 bytes`);
	}
}

function validateExecutionResultStrings(result: ExecuteBlenderPythonResultV1, errorCode: string): void {
	switch (result.outcome) {
		case "success":
			assertUtf8ByteLength(result.stdout, EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES, errorCode);
			assertUtf8ByteLength(result.stderr, EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES, errorCode);
			break;
		case "failed_recovered":
			assertUtf8ByteLength(result.error.message, EXECUTE_BLENDER_PYTHON_MAX_ERROR_MESSAGE_BYTES, errorCode);
			assertUtf8ByteLength(result.error.traceback, EXECUTE_BLENDER_PYTHON_MAX_TRACEBACK_BYTES, errorCode);
			assertUtf8ByteLength(result.stdout, EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES, errorCode);
			assertUtf8ByteLength(result.stderr, EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES, errorCode);
			break;
		case "outcome_unknown":
			assertUtf8ByteLength(result.reason, EXECUTE_BLENDER_PYTHON_MAX_REASON_BYTES, errorCode);
			break;
	}
}

function parse<T>(schema: TSchema, input: unknown, errorCode: string): T {
	try {
		return Parse(schema, input) as T;
	} catch {
		throw new Error(`${errorCode}: input must match its closed schema`);
	}
}

export function parseExecuteBlenderPythonRequest(input: unknown): ExecuteBlenderPythonRequestV1 {
	const request = parse<ExecuteBlenderPythonRequestV1>(
		ExecuteBlenderPythonRequestV1Schema,
		input,
		"INVALID_EXECUTE_BLENDER_PYTHON_REQUEST",
	);
	assertUtf8ByteLength(
		request.script,
		EXECUTE_BLENDER_PYTHON_MAX_SCRIPT_BYTES,
		"INVALID_EXECUTE_BLENDER_PYTHON_REQUEST",
	);
	return request;
}

export function parseExecuteBlenderPythonResult(input: unknown): ExecuteBlenderPythonResultV1 {
	const result = parse<ExecuteBlenderPythonResultV1>(
		ExecuteBlenderPythonResultV1Schema,
		input,
		"INVALID_EXECUTE_BLENDER_PYTHON_RESULT",
	);
	validateExecutionResultStrings(result, "INVALID_EXECUTE_BLENDER_PYTHON_RESULT");
	return result;
}

export function parseExecuteBlenderPythonResponse(input: unknown): ExecuteBlenderPythonResponseV1 {
	const response = parse<ExecuteBlenderPythonResponseV1>(
		ExecuteBlenderPythonResponseV1Schema,
		input,
		"INVALID_EXECUTE_BLENDER_PYTHON_RESPONSE",
	);
	if (response.type === "execute_result") {
		validateExecutionResultStrings(response, "INVALID_EXECUTE_BLENDER_PYTHON_RESPONSE");
	} else {
		assertUtf8ByteLength(
			response.message,
			EXECUTE_BLENDER_PYTHON_MAX_ERROR_MESSAGE_BYTES,
			"INVALID_EXECUTE_BLENDER_PYTHON_RESPONSE",
		);
	}
	return response;
}

export function parseGetExecutionOutcomeRequest(input: unknown): GetExecutionOutcomeRequestV1 {
	return parse(GetExecutionOutcomeRequestV1Schema, input, "INVALID_EXECUTE_BLENDER_PYTHON_OUTCOME_REQUEST");
}

export function parseGetExecutionOutcomeResponse(input: unknown): GetExecutionOutcomeResponseV1 {
	const response = parse<GetExecutionOutcomeResponseV1>(
		GetExecutionOutcomeResponseV1Schema,
		input,
		"INVALID_EXECUTE_BLENDER_PYTHON_OUTCOME_RESPONSE",
	);
	if (response.type === "execute_result") {
		validateExecutionResultStrings(response, "INVALID_EXECUTE_BLENDER_PYTHON_OUTCOME_RESPONSE");
	}
	return response;
}

export function parseBlenderBridgeDiscovery(input: unknown): BlenderBridgeDiscoveryV1 {
	return parse(BlenderBridgeDiscoveryV1Schema, input, "INVALID_EXECUTE_BLENDER_PYTHON_DISCOVERY");
}

export function parseBlenderBridgeHello(input: unknown): BlenderBridgeHelloV1 {
	return parse(BlenderBridgeHelloV1Schema, input, "INVALID_EXECUTE_BLENDER_PYTHON_HELLO");
}

export function parseBlenderBridgeHelloAck(input: unknown): BlenderBridgeHelloAckV1 {
	return parse(BlenderBridgeHelloAckV1Schema, input, "INVALID_EXECUTE_BLENDER_PYTHON_HELLO_ACK");
}

export function parseBlenderBridgeHelloReject(input: unknown): BlenderBridgeHelloRejectV1 {
	return parse(BlenderBridgeHelloRejectV1Schema, input, "INVALID_EXECUTE_BLENDER_PYTHON_HELLO_REJECT");
}
