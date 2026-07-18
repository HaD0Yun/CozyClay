import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type AddonBridgeMessage,
	type DaemonBridgeMessage,
	MutationBridgeSession,
	negotiateMutationBridge,
	parseAddonBridgeMessage,
	parseDaemonBridgeMessage,
} from "../src/messages.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_REQUEST_ID = "00000000-0000-4000-8000-000000000004";
const PROJECT_ID = "00000000-0000-4000-8000-000000000005";
const LAUNCH_ID = "00000000-0000-4000-8000-000000000006";
const SESSION_ID = "00000000-0000-4000-8000-000000000007";
const HASH = "a".repeat(64);
const CAPABILITY = "mutation_bridge_v2";
const ACTIVE_REQUESTS = new Set([REQUEST_ID]);

const v2Hello = {
	type: "hello",
	protocol: 2,
	addon_version: "0.1.0",
	blender_version: "4.5.0",
	project_id: PROJECT_ID,
	client_nonce: "AAAAAAAAAAAAAAAAAAAAAA",
	capabilities: [CAPABILITY],
} as const;
const v2HelloAck = {
	type: "hello_ack",
	protocol: 2,
	daemon_version: "0.1.0",
	launch_id: LAUNCH_ID,
	session_id: SESSION_ID,
	server_nonce: "BBBBBBBBBBBBBBBBBBBBBB",
	capabilities: [CAPABILITY],
} as const;

const request = {
	type: "bridge_request",
	id: ID,
	request_id: REQUEST_ID,
	method: "apply_camera_plan",
	params: { fixture: "boxing-v4" },
	expected_revision_id: HASH,
	deadline_ms: 30_000,
} as const;
const progress = {
	type: "bridge_progress",
	id: ID,
	request_id: REQUEST_ID,
	phase: "checkpoint",
	completed: 1,
	total: 2,
} as const;
const result = { type: "bridge_result", id: ID, request_id: REQUEST_ID, result: { sceneHash: HASH } } as const;
const bridgeError = {
	type: "bridge_error",
	id: ID,
	request_id: REQUEST_ID,
	code: "STALE_BASE",
	message: "scene changed",
	retryable: true,
} as const;
const cancel = { type: "bridge_cancel", id: ID, request_id: REQUEST_ID } as const;
const cancelAck = { type: "bridge_cancel_ack", id: ID, request_id: REQUEST_ID, status: "accepted" } as const;

const validMessages = [
	{ direction: "daemon" as const, value: request },
	{ direction: "addon" as const, value: progress },
	{ direction: "addon" as const, value: result },
	{ direction: "addon" as const, value: bridgeError },
	{ direction: "daemon" as const, value: cancel },
	{ direction: "addon" as const, value: cancelAck },
] as const;

const createSession = () => negotiateMutationBridge(v2Hello, v2HelloAck);

function parseWithOpenBridge(message: unknown): AddonBridgeMessage | DaemonBridgeMessage {
	const session = createSession();
	const type = typeof message === "object" && message !== null ? (message as { type?: unknown }).type : undefined;
	if (type !== "bridge_request") parseDaemonBridgeMessage(request, session, ACTIVE_REQUESTS);
	return type === "bridge_request" || type === "bridge_cancel"
		? parseDaemonBridgeMessage(message, session, ACTIVE_REQUESTS)
		: parseAddonBridgeMessage(message, session);
}

describe("Architecture §4 protocol v2 mutation bridge", () => {
	it("Architecture §4: bridge messages are closed and retain bridge/top-request UUID correlation", () => {
		for (const message of validMessages) {
			assert.deepEqual(parseWithOpenBridge(message.value), message.value);
			assert.throws(() => parseWithOpenBridge({ ...message.value, unknown: true }));
		}
	});

	it("Architecture §4: a real protocol v1 negotiation cannot create a mutation session", () => {
		const v1Hello = { ...v2Hello, protocol: 1, capabilities: undefined };
		const v1HelloAck = { ...v2HelloAck, protocol: 1, capabilities: [] };
		delete (v1Hello as { capabilities?: readonly string[] }).capabilities;
		assert.throws(() => negotiateMutationBridge(v1Hello, v1HelloAck), /protocol v2|mutation/i);
		assert.throws(() => negotiateMutationBridge({ ...v2Hello, unknown: true }, v2HelloAck));
		assert.throws(() => negotiateMutationBridge({ ...v2Hello, capabilities: [CAPABILITY, "unknown"] }, v2HelloAck));
	});

	it("Architecture §4: bridge parsing requires the immutable negotiated-session marker", () => {
		assert.throws(
			() => parseDaemonBridgeMessage(request, new MutationBridgeSession(), ACTIVE_REQUESTS),
			/negotiated protocol v2 session/i,
		);
	});

	it("Architecture §4: bridge request parent must be an active top-level request", () => {
		const session = createSession();
		assert.throws(
			() => parseDaemonBridgeMessage(request, session, new Set([OTHER_REQUEST_ID])),
			/active top-level request/i,
		);
	});

	it("Architecture §4: a parent request permits only one concurrent bridge", () => {
		const session = createSession();
		parseDaemonBridgeMessage(request, session, ACTIVE_REQUESTS);
		assert.throws(
			() => parseDaemonBridgeMessage({ ...request, id: OTHER_ID }, session, ACTIVE_REQUESTS),
			/already has an open bridge/i,
		);
	});

	it("Architecture §4: terminal bridge ids cannot be replayed", () => {
		const session = createSession();
		parseDaemonBridgeMessage(request, session, ACTIVE_REQUESTS);
		parseAddonBridgeMessage(result, session);
		assert.throws(() => parseDaemonBridgeMessage(request, session, ACTIVE_REQUESTS), /terminal|replay/i);
		assert.throws(() => parseAddonBridgeMessage(progress, session), /terminal|open bridge/i);
	});

	it("Architecture §4: correlation id remains consistent through progress to result", () => {
		const session = createSession();
		parseDaemonBridgeMessage(request, session, ACTIVE_REQUESTS);
		assert.throws(() => parseAddonBridgeMessage({ ...progress, id: OTHER_ID }, session), /open bridge|correlation/i);
		assert.throws(
			() => parseAddonBridgeMessage({ ...progress, request_id: OTHER_REQUEST_ID }, session),
			/open bridge|correlation/i,
		);
		assert.deepEqual(parseAddonBridgeMessage(progress, session), progress);
		assert.deepEqual(parseAddonBridgeMessage(result, session), result);
	});

	it("Architecture §4: bridge deadlines are 100..30000 and progress cannot exceed total", () => {
		assert.throws(() => parseWithOpenBridge({ ...request, deadline_ms: 99 }));
		assert.throws(() => parseWithOpenBridge({ ...request, deadline_ms: 30_001 }));
		assert.throws(() => parseWithOpenBridge({ ...progress, completed: 3, total: 2 }), /completed/i);
	});

	it("Architecture §4: bridge cancellation acknowledgement uses the exact terminal status union", () => {
		for (const status of ["accepted", "already_terminal", "unknown"])
			assert.equal(parseWithOpenBridge({ ...cancelAck, status }).type, "bridge_cancel_ack");
		assert.throws(() => parseWithOpenBridge({ ...cancelAck, status: "cancelled" }));
	});
});
