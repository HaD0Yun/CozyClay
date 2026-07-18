import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAddonBridgeMessage, parseDaemonBridgeMessage } from "../src/messages.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);

const validMessages = [
	{
		direction: "daemon" as const,
		value: {
			type: "bridge_request",
			id: ID,
			request_id: REQUEST_ID,
			method: "apply_camera_plan",
			params: { fixture: "boxing-v4" },
			expected_revision_id: HASH,
			deadline_ms: 30_000,
		},
	},
	{
		direction: "addon" as const,
		value: {
			type: "bridge_progress",
			id: ID,
			request_id: REQUEST_ID,
			phase: "checkpoint",
			completed: 1,
			total: 2,
		},
	},
	{
		direction: "addon" as const,
		value: { type: "bridge_result", id: ID, request_id: REQUEST_ID, result: { sceneHash: HASH } },
	},
	{
		direction: "addon" as const,
		value: {
			type: "bridge_error",
			id: ID,
			request_id: REQUEST_ID,
			code: "STALE_BASE",
			message: "scene changed",
			retryable: true,
		},
	},
	{
		direction: "daemon" as const,
		value: { type: "bridge_cancel", id: ID, request_id: REQUEST_ID },
	},
	{
		direction: "addon" as const,
		value: { type: "bridge_cancel_ack", id: ID, request_id: REQUEST_ID, status: "accepted" },
	},
] as const;

describe("Architecture §4 protocol v2 mutation bridge", () => {
	it("Architecture §4: bridge messages are closed and retain bridge/top-request UUID correlation", () => {
		for (const message of validMessages) {
			const parse = message.direction === "daemon" ? parseDaemonBridgeMessage : parseAddonBridgeMessage;
			assert.deepEqual(parse(message.value, 2), message.value);
			assert.throws(() => parse({ ...message.value, unknown: true }, 2));
		}
	});

	it("Architecture §4: protocol v1 peers cannot negotiate mutation messages", () => {
		for (const message of validMessages) {
			const parse = message.direction === "daemon" ? parseDaemonBridgeMessage : parseAddonBridgeMessage;
			assert.throws(() => parse(message.value, 1), /protocol v2/i);
		}
	});

	it("Architecture §4: bridge deadlines are 100..30000 and progress cannot exceed total", () => {
		const request = validMessages[0].value;
		assert.throws(() => parseDaemonBridgeMessage({ ...request, deadline_ms: 99 }, 2));
		assert.throws(() => parseDaemonBridgeMessage({ ...request, deadline_ms: 30_001 }, 2));
		const progress = validMessages[1].value;
		assert.throws(() => parseAddonBridgeMessage({ ...progress, completed: 3, total: 2 }, 2), /completed/i);
	});

	it("Architecture §4: bridge cancellation acknowledgement uses the exact terminal status union", () => {
		const ack = validMessages[5].value;
		for (const status of ["accepted", "already_terminal", "unknown"])
			assert.equal(parseAddonBridgeMessage({ ...ack, status }, 2).type, "bridge_cancel_ack");
		assert.throws(() => parseAddonBridgeMessage({ ...ack, status: "cancelled" }, 2));
	});
});
