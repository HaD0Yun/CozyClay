import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DirectorTranscriptStore } from "../src/transcript-store.ts";

const TURN_ID = "00000000-0000-4000-8000-000000000001";
const REVISION = "a".repeat(64);

test("persists a closed transcript atomically and resumes its stable session id", async () => {
	const root = await mkdtemp(join(tmpdir(), "omb-transcript-"));
	try {
		const first = await DirectorTranscriptStore.open(root);
		await first.append({
			type: "director_turn_started",
			id: TURN_ID,
			sequence: 0,
			at: "2026-07-19T18:00:00.000Z",
			prompt: "Build a product shot.",
		});
		await first.append({
			type: "director_turn_completed",
			id: TURN_ID,
			sequence: 1,
			at: "2026-07-19T18:00:01.000Z",
			summary: "Product shot complete.",
			resulting_revision_id: REVISION,
		});

		const second = await DirectorTranscriptStore.open(root);
		assert.equal(second.sessionId, first.sessionId);
		assert.deepEqual(second.snapshot("00000000-0000-4000-8000-000000000002").events, first.events);
		assert.equal((await stat(join(root, ".omb", "director-transcript.json"))).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(await readFile(join(root, ".omb", "director-transcript.json"), "utf8")), {
			schema_version: 1,
			session_id: first.sessionId,
			events: first.events,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects malformed events without mutating the transcript", async () => {
	const root = await mkdtemp(join(tmpdir(), "omb-transcript-invalid-"));
	try {
		const store = await DirectorTranscriptStore.open(root);
		await assert.rejects(store.append({ type: "director_turn_started", id: TURN_ID, prompt: "missing fields" } as never));
		assert.deepEqual(store.events, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
