import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ControllerSession } from "../src/controller.ts";
import type { ControllerWebSocket } from "../src/ws-client.ts";

const ZERO_REVISION = "0".repeat(64);
const COMMITTED_REVISION = "3".repeat(64);
const TURN_ID = "11111111-1111-4111-8111-111111111111";
const FAILED_TURN_ID = "21111111-1111-4111-8111-111111111111";

class FakeControllerWebSocket extends EventEmitter {
	readonly sent: Array<Record<string, unknown>> = [];
	closed = false;

	send(message: unknown): void {
		this.sent.push(message as Record<string, unknown>);
	}

	next(): Promise<unknown> {
		return new Promise(() => {});
	}

	close(): void {
		this.closed = true;
	}

	disconnect(): void {
		this.closed = true;
	}
}

function session(websocket: FakeControllerWebSocket): ControllerSession {
	return new ControllerSession({
		connectionKind: "attached",
		pid: 1,
		port: 1,
		runtimeDirectory: "/tmp",
		identity: {
			websocket: websocket as unknown as ControllerWebSocket,
			resumeToken: "resume",
			capabilities: ["director_turn_v1"],
			protocolFeatures: [],
		} as never,
		transcriptReplay: { finish: () => [] } as never,
	});
}

test("a failed turn resets the revision expectation to the bootstrap wildcard", () => {
	const websocket = new FakeControllerWebSocket();
	const controller = session(websocket);

	websocket.emit("message", {
		type: "director_turn_completed",
		id: TURN_ID,
		sequence: 1,
		at: "2026-07-20T00:00:00.000Z",
		summary: "done",
		resulting_revision_id: COMMITTED_REVISION,
	});
	controller.sendTurn("first prompt");
	const first = websocket.sent.filter((message) => message.type === "director_turn").at(-1);
	assert.equal(first?.expected_revision_id, COMMITTED_REVISION);

	// A failed turn may still have committed durable revisions before its
	// terminal; the stale client expectation must not deadlock later turns.
	websocket.emit("message", {
		type: "director_turn_failed",
		id: FAILED_TURN_ID,
		sequence: 2,
		at: "2026-07-20T00:00:01.000Z",
		code: "DIRECTOR_LOOP_INCOMPLETE",
		message: "director turn ended before its verification inspect",
		retryable: false,
	});
	controller.sendTurn("second prompt");
	const second = websocket.sent.filter((message) => message.type === "director_turn").at(-1);
	assert.equal(second?.expected_revision_id, ZERO_REVISION);
});
