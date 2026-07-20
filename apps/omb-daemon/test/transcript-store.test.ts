import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DirectorTranscriptStore, TRANSCRIPT_CURSOR_ERROR } from "../src/transcript-store.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000000";
const requestId = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const event = (sequence: number) => ({
	type: "director_turn_started" as const,
	id: requestId(sequence + 100),
	sequence,
	at: "2026-07-19T18:00:00.000Z",
	prompt: `Prompt ${sequence}`,
});

async function temporaryRoot(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

async function writeTranscript(root: string, transcript: unknown): Promise<string> {
	const directory = join(root, ".omb");
	await mkdir(directory, { recursive: true });
	const path = join(directory, "director-transcript.json");
	await writeFile(path, JSON.stringify(transcript));
	return path;
}

test("atomically migrates a valid closed schema-v1 transcript to schema v2", async () => {
	const root = await temporaryRoot("omb-transcript-migrate-");
	try {
		const events = [event(0), event(1)];
		const path = await writeTranscript(root, { schema_version: 1, session_id: SESSION_ID, events });
		const store = await DirectorTranscriptStore.open(root);

		assert.equal(store.sessionId, SESSION_ID);
		assert.deepEqual(store.events, events);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { schema_version: 2, session_id: SESSION_ID, events });
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.deepEqual(await readdir(join(root, ".omb")), ["director-transcript.json"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("pages a fixed v2 snapshot with global cursors despite concurrent appends", async () => {
	const root = await temporaryRoot("omb-transcript-snapshot-");
	try {
		const store = await DirectorTranscriptStore.open(root);
		const initialEvents = Array.from({ length: 70 }, (_, index) => event(index));
		for (const item of initialEvents) await store.append(item);

		const first = store.page({
			type: "director_transcript_request",
			id: requestId(1),
			cursor: 0,
			page_size: 64,
			snapshot_cursor: null,
		});
		assert("schema_version" in first);
		assert.equal(first.schema_version, 2);
		assert.equal(first.snapshot_cursor, 70);
		assert(first.next_cursor !== null);
		assert.equal(first.next_cursor, 64);
		assert.equal(first.events.length, 64);

		await store.append(event(70));
		await store.append(event(71));
		const second = store.page({
			type: "director_transcript_request",
			id: requestId(2),
			cursor: first.next_cursor,
			page_size: 64,
			snapshot_cursor: first.snapshot_cursor,
		});
		assert("schema_version" in second);
		assert.equal(second.snapshot_cursor, 70);
		assert.equal(second.next_cursor, null);
		assert.deepEqual([...first.events, ...second.events], initialEvents);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects invalid v2 cursor and watermark combinations with the fixed store error", async () => {
	const root = await temporaryRoot("omb-transcript-cursor-");
	try {
		const store = await DirectorTranscriptStore.open(root);
		await store.append(event(0));
		const invalidRequests = [
			{ cursor: 1, snapshot_cursor: null },
			{ cursor: 0, snapshot_cursor: 2 },
			{ cursor: 1, snapshot_cursor: 0 },
		];
		for (const [index, invalid] of invalidRequests.entries()) {
			assert.throws(
				() =>
					store.page({
						type: "director_transcript_request",
						id: requestId(index + 10),
						page_size: 1,
						...invalid,
					}),
				(error: Error) => error.message === TRANSCRIPT_CURSOR_ERROR,
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects unknown schemas, invalid sessions, and closed-root extras", async () => {
	for (const transcript of [
		{ schema_version: 3, session_id: SESSION_ID, events: [] },
		{ schema_version: 2, session_id: SESSION_ID, events: [], extra: true },
		{ schema_version: 2, session_id: "invalid", events: [] },
	]) {
		const root = await temporaryRoot("omb-transcript-corrupt-");
		try {
			await writeTranscript(root, transcript);
			await assert.rejects(DirectorTranscriptStore.open(root), /TRANSCRIPT_CORRUPT/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});

test("keeps the legacy v1 page response shape without a snapshot watermark", async () => {
	const root = await temporaryRoot("omb-transcript-v1-page-");
	try {
		const store = await DirectorTranscriptStore.open(root);
		await store.append(event(0));
		const page = store.page({
			type: "director_transcript_request",
			id: requestId(20),
			cursor: 0,
			page_size: 1,
		});
		assert.deepEqual(page, {
			type: "director_transcript",
			id: requestId(20),
			session_id: store.sessionId,
			events: [event(0)],
			next_cursor: null,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
