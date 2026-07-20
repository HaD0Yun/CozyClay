import assert from "node:assert/strict";
import test from "node:test";
import { parseServerMessage } from "@oh-my-blender/protocol";
import { isDirectorServerMessage, isDirectorStreamMessage } from "../src/protocol.ts";

const requestId = "22222222-2222-4222-8222-222222222222";
const launchId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const at = "2026-07-19T18:00:00.000Z";
const digest = "a".repeat(64);

function canonicalAccepts(value: unknown): boolean {
	try {
		parseServerMessage(value);
		return true;
	} catch {
		return false;
	}
}

test("TUI accepts and rejects canonical server fixtures identically", () => {
	const fixtures: readonly unknown[] = [
		{
			type: "hello_ack",
			protocol: 1,
			daemon_version: "0.1.0",
			launch_id: launchId,
			session_id: sessionId,
			server_nonce: "A".repeat(22),
			capabilities: ["director_turn_v1", "director_transcript_v1"],
		},
		{ type: "director_turn_started", id: requestId, sequence: 0, at, prompt: "Build a scene" },
		{
			type: "director_turn_completed",
			id: requestId,
			sequence: 1,
			at,
			summary: "Done",
			resulting_revision_id: digest,
		},
		{
			type: "director_transcript",
			id: launchId,
			session_id: sessionId,
			events: [{ type: "director_turn_started", id: requestId, sequence: 0, at, prompt: "Build a scene" }],
			next_cursor: null,
		},
		{
			type: "director_transcript",
			id: launchId,
			session_id: sessionId,
			events: [],
			next_cursor: 0,
		},
		{ type: "pong", nonce: "probe" },
		{ type: "pong", nonce: "probe", extra: true },
		{ type: "shutdown_ack" },
		{ type: "director_turn_started", id: "not-a-uuid", sequence: 0, at, prompt: "Build a scene" },
		{ type: "director_turn_started", id: requestId, sequence: 0, at: "yesterday", prompt: "Build a scene" },
		{ type: "director_turn_started", id: requestId, sequence: 0, at, prompt: "Build a scene", extra: true },
		{
			type: "director_turn_completed",
			id: requestId,
			sequence: 1,
			at,
			summary: "Done",
			resulting_revision_id: "short",
		},
		{ type: "hello_ack" },
	];

	for (const fixture of fixtures) {
		assert.equal(
			isDirectorServerMessage(fixture),
			canonicalAccepts(fixture),
			`parser disagreement for ${JSON.stringify(fixture)}`,
		);
	}
});

test("TUI-only controller messages remain closed schemas", () => {
	assert.equal(isDirectorServerMessage({ type: "controller_auth", resume_token: "A".repeat(43), launch_id: launchId }), true);
	assert.equal(
		isDirectorServerMessage({ type: "controller_auth", resume_token: "A".repeat(43), launch_id: launchId, extra: true }),
		false,
	);
	assert.equal(isDirectorServerMessage({ type: "controller_auth", resume_token: "credential", launch_id: "bad" }), false);
	assert.equal(
		isDirectorServerMessage({
			type: "attach_ticket",
			role: "bridge",
			ticket: "B".repeat(43),
			expires_in_ms: 10_000,
			launch_id: launchId,
			runtime_directory: "/tmp/omb-runtime",
		}),
		true,
	);
	assert.equal(
		isDirectorServerMessage({
			type: "attach_ticket",
			role: "controller",
			ticket: "B".repeat(43),
			expires_in_ms: 10_000,
			launch_id: launchId,
			runtime_directory: "/tmp/omb-runtime",
		}),
		false,
	);
});

test("stream and bridge-status frames are exact and direction-safe", () => {
	const delta = {
		type: "director_turn_delta",
		id: requestId,
		segment_id: launchId,
		content_index: 0,
		delta_sequence: 0,
		delta: "hello",
	} as const;
	const utterance = {
		type: "director_assistant_utterance",
		id: requestId,
		sequence: 1,
		at,
		segment_id: launchId,
		content_index: 0,
		through_delta_sequence: 0,
		content: "hello",
	} as const;
	assert.equal(isDirectorServerMessage(delta), true);
	assert.equal(isDirectorStreamMessage(delta), true);
	assert.equal(isDirectorServerMessage(utterance), true);
	assert.equal(isDirectorStreamMessage(utterance), true);
	assert.equal(isDirectorServerMessage({ type: "bridge_status", attached: true }), true);
	assert.equal(isDirectorServerMessage({ type: "bridge_status", attached: true, extra: true }), false);
	assert.equal(isDirectorStreamMessage({ type: "bridge_status", attached: true }), false);
});
