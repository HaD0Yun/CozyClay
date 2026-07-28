import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DIRECTOR_TRANSCRIPT_CAPABILITY,
	DIRECTOR_TURN_CAPABILITY,
	DIRECTOR_TURN_DEADLINE_MAX_MS,
	parseClientMessage,
	parseDirectorTurnEvent,
	parseServerMessage,
} from "../src/messages.ts";

const TURN_ID = "00000000-0000-4000-8000-000000000001";
const FETCH_ID = "00000000-0000-4000-8000-000000000002";
const SESSION_ID = "00000000-0000-4000-8000-000000000003";
const REVISION = "a".repeat(64);
const DIGEST = "b".repeat(64);
const AT = "2026-07-19T18:00:00.000Z";

const events = [
	{ type: "director_turn_started", id: TURN_ID, sequence: 0, at: AT, prompt: "Build a product shot." },
	{
		type: "director_tool_call_started",
		id: TURN_ID,
		sequence: 1,
		at: AT,
		tool_call_id: "tool-1",
		tool_name: "inspect_project",
		params_summary: "inspect_project()",
	},
	{
		type: "director_tool_call_finished",
		id: TURN_ID,
		sequence: 2,
		at: AT,
		tool_call_id: "tool-1",
		tool_name: "inspect_project",
		result_digest: DIGEST,
		is_error: false,
	},
	{
		type: "director_turn_completed",
		id: TURN_ID,
		sequence: 3,
		at: AT,
		summary: "Product shot staged and verified.",
		resulting_revision_id: REVISION,
	},
	{
		type: "director_turn_failed",
		id: TURN_ID,
		sequence: 3,
		at: AT,
		code: "MODEL_PROVIDER_ERROR",
		message: "provider request failed",
		retryable: false,
	},
	{ type: "director_turn_cancelled", id: TURN_ID, sequence: 3, at: AT },
] as const;

describe("director controller turn protocol", () => {
	it("advertises stable controller capability names", () => {
		assert.equal(DIRECTOR_TURN_CAPABILITY, "director_turn_v1");
		assert.equal(DIRECTOR_TRANSCRIPT_CAPABILITY, "director_transcript_v1");
	});

	it("accepts a closed bounded natural-language turn request", () => {
		const request = {
			type: "director_turn",
			id: TURN_ID,
			prompt: "Build a product shot.",
			expected_revision_id: REVISION,
			deadline_ms: 30_000,
		} as const;
		assert.deepEqual(parseClientMessage(request), request);
		assert.throws(() => parseClientMessage({ ...request, prompt: "" }));
		assert.throws(() => parseClientMessage({ ...request, prompt: "x".repeat(8_193) }));
		assert.deepEqual(parseClientMessage({ ...request, deadline_ms: DIRECTOR_TURN_DEADLINE_MAX_MS }), {
			...request,
			deadline_ms: DIRECTOR_TURN_DEADLINE_MAX_MS,
		});
		assert.throws(() => parseClientMessage({ ...request, deadline_ms: DIRECTOR_TURN_DEADLINE_MAX_MS + 1 }));
		assert.throws(() => parseClientMessage({ ...request, deadline_ms: 99 }));
		assert.throws(() => parseClientMessage({ ...request, extra: true }));
	});

	it("accepts a closed bounded transcript page request", () => {
		const request = { type: "director_transcript_request", id: FETCH_ID, cursor: 0, page_size: 64 } as const;
		assert.deepEqual(parseClientMessage(request), request);
		assert.throws(() => parseClientMessage({ ...request, cursor: -1 }));
		assert.throws(() => parseClientMessage({ ...request, cursor: 10_001 }));
		assert.throws(() => parseClientMessage({ ...request, page_size: 0 }));
		assert.throws(() => parseClientMessage({ ...request, page_size: 65 }));
		assert.throws(() => parseClientMessage({ ...request, extra: true }));
	});

	it("validates every persisted turn event as a server message", () => {
		for (const event of events) {
			assert.deepEqual(parseDirectorTurnEvent(event), event);
			assert.deepEqual(parseServerMessage(event), event);
			assert.throws(() => parseDirectorTurnEvent({ ...event, extra: true }));
		}
	});

	it("rejects invalid turn event fields", () => {
		assert.throws(() => parseDirectorTurnEvent({ ...events[0], sequence: -1 }));
		assert.throws(() => parseDirectorTurnEvent({ ...events[0], at: "yesterday" }));
		assert.throws(() => parseDirectorTurnEvent({ ...events[1], tool_name: "bash" }));
		assert.throws(() => parseDirectorTurnEvent({ ...events[1], params_summary: "x".repeat(513) }));
		assert.throws(() => parseDirectorTurnEvent({ ...events[2], result_digest: "not-a-digest" }));
	});

	it("returns a closed bounded transcript page containing only turn events", () => {
		const transcript = {
			type: "director_transcript",
			id: FETCH_ID,
			session_id: SESSION_ID,
			events: events.slice(0, 4),
			next_cursor: 4,
		} as const;
		assert.deepEqual(parseServerMessage(transcript), transcript);
		assert.deepEqual(parseServerMessage({ ...transcript, next_cursor: null }), {
			...transcript,
			next_cursor: null,
		});
		assert.throws(() => parseServerMessage({ ...transcript, extra: true }));
		assert.throws(() => parseServerMessage({ ...transcript, next_cursor: -1 }));
		assert.throws(() => parseServerMessage({ ...transcript, events: [{ type: "progress" }] }));
		assert.throws(() =>
			parseServerMessage({
				...transcript,
				events: Array.from({ length: 65 }, () => events[0]),
			}),
		);
	});
});
