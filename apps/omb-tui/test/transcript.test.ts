import assert from "node:assert/strict";
import test from "node:test";
import {
	createTranscriptState,
	evaluatePromptSubmission,
	formatTranscript,
	reduceDirectorMessage,
	type DirectorServerMessage,
} from "../src/transcript.ts";

const requestId = "22222222-2222-4222-8222-222222222222";
const transcriptId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const at = "2026-07-19T18:00:00.000Z";
const digest = "a".repeat(64);

function reduce(messages: readonly DirectorServerMessage[]) {
	return messages.reduce(reduceDirectorMessage, createTranscriptState());
}

test("turn and tool events reduce to a concise scrolling transcript", () => {
	const state = reduce([
		{ type: "director_turn_started", id: requestId, sequence: 0, at, prompt: "Build a product shot" },
		{
			type: "director_tool_call_started",
			id: requestId,
			sequence: 1,
			at,
			tool_call_id: "tool-1",
			tool_name: "inspect_project",
			params_summary: "{}",
		},
		{
			type: "director_tool_call_finished",
			id: requestId,
			sequence: 2,
			at,
			tool_call_id: "tool-1",
			tool_name: "inspect_project",
			result_digest: digest,
			is_error: false,
		},
		{
			type: "director_turn_completed",
			id: requestId,
			sequence: 3,
			at,
			summary: "Scene staged and checked.",
			resulting_revision_id: digest,
		},
	]);

	assert.equal(state.status, "idle");
	assert.equal(state.activeRequestId, undefined);
	assert.equal(
		formatTranscript(state),
		`> Build a product shot\n[inspect_project] started {}\n[inspect_project] finished ${digest}\nScene staged and checked.`,
	);
});

test("persisted transcript replaces local history on reattach", () => {
	const state = reduce([
		{ type: "director_turn_started", id: requestId, sequence: 0, at, prompt: "stale" },
		{
			type: "director_transcript",
			id: transcriptId,
			session_id: sessionId,
			events: [
				{ type: "director_turn_started", id: requestId, sequence: 0, at, prompt: "Restored prompt" },
				{ type: "director_turn_cancelled", id: requestId, sequence: 1, at },
			],
			next_cursor: null,
		},
	]);

	assert.equal(formatTranscript(state), "> Restored prompt\nTurn cancelled.");
	assert.equal(state.status, "idle");
});

test("failed turns retain the protocol error without exposing raw payloads", () => {
	const state = reduce([
		{ type: "director_turn_started", id: requestId, sequence: 0, at, prompt: "Do it" },
		{
			type: "director_turn_failed",
			id: requestId,
			sequence: 1,
			at,
			code: "MODEL_PROVIDER_ERROR",
			message: "provider request failed",
			retryable: false,
		},
	]);

	assert.equal(state.status, "failed");
	assert.match(formatTranscript(state), /MODEL_PROVIDER_ERROR: provider request failed/);
});

test("a rejected duplicate submission error does not clear active-turn tracking", () => {
	const rejectedId = "55555555-5555-4555-8555-555555555555";
	const state = reduce([
		{ type: "director_turn_started", id: requestId, sequence: 0, at, prompt: "Build a product shot" },
		{ type: "error", id: rejectedId, code: "BUSY", message: "one director turn is already active", retryable: true },
	]);
	assert.equal(state.activeRequestId, requestId);
	assert.equal(state.status, "running");
	assert.match(state.notices.join("\n"), /BUSY/);
});

test("prompt submission gate drops empty prompts and blocks concurrent turns", () => {
	const idle = createTranscriptState();
	assert.deepEqual(evaluatePromptSubmission(idle, "   "), {});
	assert.deepEqual(evaluatePromptSubmission(idle, "  stage a cube  "), { prompt: "stage a cube" });
	const running = reduce([
		{ type: "director_turn_started", id: requestId, sequence: 0, at, prompt: "first" },
	]);
	const blocked = evaluatePromptSubmission(running, "second");
	assert.equal(blocked.prompt, undefined);
	assert.match(blocked.notice ?? "", /still active/);
});
