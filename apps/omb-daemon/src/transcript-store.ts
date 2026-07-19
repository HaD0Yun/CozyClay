import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
	parseDirectorTranscript,
	parseDirectorTurnEvent,
	type DirectorTranscript,
	type DirectorTurnEvent,
} from "@oh-my-blender/protocol";

const TRANSCRIPT_SCHEMA_VERSION = 1;
const MAX_TRANSCRIPT_EVENTS = 10_000;

interface PersistedTranscript {
	readonly schema_version: typeof TRANSCRIPT_SCHEMA_VERSION;
	readonly session_id: string;
	readonly events: readonly DirectorTurnEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedTranscript(input: unknown): PersistedTranscript {
	if (!isRecord(input) || Object.keys(input).sort().join(",") !== "events,schema_version,session_id") {
		throw new Error("TRANSCRIPT_CORRUPT: transcript root must be a closed object");
	}
	if (input.schema_version !== TRANSCRIPT_SCHEMA_VERSION || typeof input.session_id !== "string") {
		throw new Error("TRANSCRIPT_CORRUPT: transcript header is invalid");
	}
	if (!Array.isArray(input.events) || input.events.length > MAX_TRANSCRIPT_EVENTS) {
		throw new Error("TRANSCRIPT_CORRUPT: transcript event list is invalid");
	}
	const events = input.events.map((event) => parseDirectorTurnEvent(event));
	parseDirectorTranscript({
		type: "director_transcript",
		id: randomUUID(),
		session_id: input.session_id,
		events,
	});
	return { schema_version: TRANSCRIPT_SCHEMA_VERSION, session_id: input.session_id, events };
}

export class DirectorTranscriptStore {
	readonly sessionId: string;
	readonly transcriptPath: string;
	private readonly ombDirectory: string;
	private persistedEvents: DirectorTurnEvent[];
	private writeTail: Promise<void> = Promise.resolve();

	private constructor(rootDirectory: string, transcript: PersistedTranscript) {
		this.ombDirectory = join(rootDirectory, ".omb");
		this.transcriptPath = join(this.ombDirectory, "director-transcript.json");
		this.sessionId = transcript.session_id;
		this.persistedEvents = [...transcript.events];
	}

	static async open(rootDirectory: string): Promise<DirectorTranscriptStore> {
		const path = join(rootDirectory, ".omb", "director-transcript.json");
		try {
			const source = await readFile(path, "utf8");
			return new DirectorTranscriptStore(rootDirectory, parsePersistedTranscript(JSON.parse(source)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				if (error instanceof SyntaxError) throw new Error("TRANSCRIPT_CORRUPT: transcript is not valid JSON", { cause: error });
				throw error;
			}
			return new DirectorTranscriptStore(rootDirectory, {
				schema_version: TRANSCRIPT_SCHEMA_VERSION,
				session_id: randomUUID(),
				events: [],
			});
		}
	}

	get events(): readonly DirectorTurnEvent[] {
		return [...this.persistedEvents];
	}

	snapshot(requestId: string): DirectorTranscript {
		return parseDirectorTranscript({
			type: "director_transcript",
			id: requestId,
			session_id: this.sessionId,
			events: this.persistedEvents,
		});
	}

	async append(input: DirectorTurnEvent): Promise<void> {
		const event = parseDirectorTurnEvent(input);
		if (this.persistedEvents.length >= MAX_TRANSCRIPT_EVENTS) {
			throw new Error("TRANSCRIPT_EVENT_LIMIT: transcript contains 10000 events");
		}
		const write = this.writeTail.then(async () => {
			const next = [...this.persistedEvents, event];
			await this.write(next);
			this.persistedEvents = next;
		});
		this.writeTail = write.catch(() => undefined);
		await write;
	}

	private async write(events: readonly DirectorTurnEvent[]): Promise<void> {
		await mkdir(this.ombDirectory, { recursive: true, mode: 0o700 });
		const temporaryPath = join(this.ombDirectory, `.director-transcript.${process.pid}.${randomUUID()}.tmp`);
		const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try {
			await handle.writeFile(
				JSON.stringify({
					schema_version: TRANSCRIPT_SCHEMA_VERSION,
					session_id: this.sessionId,
					events,
				}),
			);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporaryPath, this.transcriptPath);
		const directory = await open(this.ombDirectory, constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
}
