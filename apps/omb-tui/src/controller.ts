import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
	DIRECTOR_STREAM_CAPABILITY,
	DIRECTOR_TRANSCRIPT_CAPABILITY,
	DIRECTOR_TURN_CAPABILITY,
	SNAPSHOT_CURSOR_V2_FEATURE,
} from "@oh-my-blender/protocol";
import {
	defaultRuntimeBaseDirectory,
	discoverControllers,
	persistControllerCredential,
	removeControllerCredential,
	type DiscoveredController,
} from "./discovery.ts";
import { launchDaemon, terminateDaemon } from "./launcher.ts";
import {
	isDirectorServerMessage,
	isDirectorStreamMessage,
	type DirectorEvent,
	type DirectorServerMessage,
	type DirectorTranscriptRequest,
	type DirectorTurnRequest,
} from "./protocol.ts";
import { connectWebSocket, type ControllerWebSocket } from "./ws-client.ts";

const ZERO_REVISION = "0".repeat(64);
const DIRECTOR_TRANSCRIPT_PAGE_SIZE = 64;
const CONTROLLER_KEEPALIVE_INTERVAL_MS = 20_000;

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("CONTROLLER_RECONNECT_ABORTED");
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("CONTROLLER_RECONNECT_ABORTED"));
			return;
		}
		const timer = setTimeout(done, delayMs);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			resolve();
		}
		function aborted(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			reject(new Error("CONTROLLER_RECONNECT_ABORTED"));
		}
		signal?.addEventListener("abort", aborted, { once: true });
		timer.unref();
	});
}

function isDirectorEvent(message: DirectorServerMessage): message is DirectorEvent {
	return message.type === "director_turn_started" ||
		message.type === "director_assistant_utterance" ||
		message.type === "director_tool_call_started" ||
		message.type === "director_tool_call_finished" ||
		message.type === "director_turn_completed" ||
		message.type === "director_turn_failed" ||
		message.type === "director_turn_cancelled";
}

function acceptsServerMessage(
	websocket: ControllerWebSocket,
	capabilities: readonly string[],
	message: unknown,
): message is DirectorServerMessage {
	if (!isDirectorServerMessage(message)) {
		websocket.close(1008, "unknown server frame");
		return false;
	}
	if (isDirectorStreamMessage(message) && !capabilities.includes(DIRECTOR_STREAM_CAPABILITY)) {
		websocket.close(1008, "stream capability mismatch");
		return false;
	}
	return true;
}

export interface ConnectControllerOptions {
	readonly projectDirectory: string;
	readonly daemonArguments: readonly string[];
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly repositoryRoot?: string;
	readonly runtimeBaseDirectory?: string;
	readonly startupTimeoutMs?: number;
	readonly keepaliveIntervalMs?: number;
}

export interface BridgeAttachTicket {
	readonly runtimeDirectory: string;
	readonly ticket: string;
	readonly expiresInMs: number;
}

interface ControllerIdentity {
	readonly websocket: ControllerWebSocket;
	readonly resumeToken: string;
	readonly capabilities: readonly string[];
	readonly protocolFeatures: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fallbackProjectId(projectDirectory: string): string {
	const bytes = createHash("sha256").update(projectDirectory).digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The durable project identity drives attach-handoff binding: the daemon
 * embeds this id in attach-handoff.json and the Blender add-on refuses
 * handoffs whose project does not match the scene. Read the real id from
 * .omb/project.json; the path-derived fallback exists only for projects
 * that have not been initialized yet.
 */
export async function resolveProjectId(projectDirectory: string): Promise<string> {
	const file = path.join(projectDirectory, ".omb", "project.json");
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallbackProjectId(projectDirectory);
		throw new Error(`CONTROLLER_PROJECT_INVALID: cannot read ${file}`, { cause: error });
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		const stored = isRecord(parsed) && parsed.schema_version === 1 ? parsed.project_id : undefined;
		if (typeof stored === "string" && UUID_PATTERN.test(stored)) return stored;
	} catch (error) {
		throw new Error(`CONTROLLER_PROJECT_INVALID: malformed JSON in ${file}`, { cause: error });
	}
	throw new Error(`CONTROLLER_PROJECT_INVALID: invalid project record in ${file}`);
}

async function authenticateController(options: {
	readonly port: number;
	readonly credential: string;
	readonly projectDirectory: string;
	readonly launchId?: string;
	readonly signal?: AbortSignal;
}): Promise<ControllerIdentity> {
	const websocket = await connectWebSocket({
		host: "127.0.0.1",
		port: options.port,
		credential: options.credential,
		launchId: options.launchId,
		signal: options.signal,
	});
	try {
		const projectIdentity = await resolveProjectId(options.projectDirectory);
		const helloAckPromise = websocket.next(
			(message) => isRecord(message) && message.type === "hello_ack",
			2_000,
			options.signal,
		);
		const authPromise = websocket.next(
			(message) => isRecord(message) && message.type === "controller_auth",
			2_000,
			options.signal,
		);
		websocket.send({
			type: "hello",
			protocol: 1,
			addon_version: "omb-tui/0.1.0",
			blender_version: "n/a",
			project_id: projectIdentity,
			client_nonce: randomBytes(16).toString("base64url"),
		});
		const [helloAck, auth] = await Promise.all([helloAckPromise, authPromise]);
		if (!isDirectorServerMessage(helloAck) || helloAck.type !== "hello_ack") {
			throw new Error("CONTROLLER_PROTOCOL_ERROR: invalid hello acknowledgement");
		}
		if (!isDirectorServerMessage(auth) || auth.type !== "controller_auth") {
			throw new Error("CONTROLLER_PROTOCOL_ERROR: invalid controller credential");
		}
		return {
			websocket,
			resumeToken: auth.resume_token,
			capabilities: helloAck.capabilities,
			protocolFeatures: "protocol_features" in helloAck ? helloAck.protocol_features : [],
		};
	} catch (error) {
		websocket.disconnect();
		throw error;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function attachExisting(
	candidate: DiscoveredController,
	projectDirectory: string,
	signal?: AbortSignal,
): Promise<ControllerIdentity | undefined> {
	if (!processIsAlive(candidate.pid)) return undefined;
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			return await authenticateController({
				port: candidate.port,
				credential: candidate.resumeToken,
				projectDirectory,
				launchId: candidate.launchId,
				signal,
			});
		} catch (error) {
			lastError = error;
			await abortableDelay(20, signal);
		}
	}
	if (lastError instanceof Error && lastError.message.startsWith("CONTROLLER_CONNECT_FAILED:")) return undefined;
	throw lastError;
}
class TranscriptReplay {
	private readonly identity: ControllerIdentity;
	private readonly liveEvents: DirectorEvent[] = [];
	private replayedEvents: readonly DirectorEvent[] = [];
	private readonly listener: (message: unknown) => void;

	constructor(identity: ControllerIdentity) {
		this.identity = identity;
		this.listener = (message: unknown) => {
			if (!acceptsServerMessage(identity.websocket, identity.capabilities, message)) return;
			if (isDirectorEvent(message)) this.liveEvents.push(message);
		};
		identity.websocket.on("message", this.listener);
	}

	setReplayed(events: readonly DirectorEvent[]): void {
		this.replayedEvents = events;
	}

	finish(): readonly DirectorServerMessage[] {
		this.identity.websocket.off("message", this.listener);
		const merged: DirectorEvent[] = [];
		const seen = new Set<string>();
		for (const event of [...this.replayedEvents, ...this.liveEvents]) {
			const key = `${event.id}:${event.sequence}`;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(event);
		}
		return merged;
	}
}

export class ControllerSession {
	readonly connectionKind: "spawned" | "attached";
	readonly pid: number;
	readonly port: number;
	readonly runtimeDirectory: string;
	readonly resumeToken: string;
	readonly capabilities: readonly string[];
	readonly initialMessages: readonly DirectorServerMessage[];
	private readonly websocket: ControllerWebSocket;
	private readonly keepaliveTimer: ReturnType<typeof setInterval>;
	private currentRevisionId = ZERO_REVISION;
	private activeRequestId: string | undefined;
	private bridgeAttached: boolean | undefined;

	constructor(options: {
		readonly connectionKind: "spawned" | "attached";
		readonly pid: number;
		readonly port: number;
		readonly runtimeDirectory: string;
		readonly identity: ControllerIdentity;
		readonly transcriptReplay: TranscriptReplay;
		readonly keepaliveIntervalMs?: number;
	}) {
		this.connectionKind = options.connectionKind;
		this.pid = options.pid;
		this.port = options.port;
		this.runtimeDirectory = options.runtimeDirectory;
		this.websocket = options.identity.websocket;
		this.resumeToken = options.identity.resumeToken;
		this.capabilities = options.identity.capabilities;
		this.websocket.on("message", (message: unknown) => {
			if (!acceptsServerMessage(this.websocket, this.capabilities, message)) return;
			this.observe(message);
			if (message.type === "bridge_status") this.bridgeAttached = message.attached;
		});
		this.keepaliveTimer = setInterval(() => {
			try {
				this.websocket.send({ type: "ping", nonce: randomUUID() });
			} catch {
				// The close event owns connection recovery.
			}
		}, options.keepaliveIntervalMs ?? CONTROLLER_KEEPALIVE_INTERVAL_MS);
		this.keepaliveTimer.unref();
		this.websocket.once("close", () => clearInterval(this.keepaliveTimer));
		this.websocket.send({ type: "bridge_status_request" });
		this.initialMessages = options.transcriptReplay.finish();
		for (const message of this.initialMessages) this.observe(message);
	}

	onMessage(listener: (message: DirectorServerMessage) => void): () => void {
		const wrapped = (message: unknown) => {
			if (isDirectorServerMessage(message)) listener(message);
		};
		this.websocket.on("message", wrapped);
		return () => this.websocket.off("message", wrapped);
	}

	onDisconnect(listener: () => void): () => void {
		this.websocket.on("close", listener);
		return () => this.websocket.off("close", listener);
	}
	onBridgeStatus(listener: (attached: boolean) => void): () => void {
		if (this.bridgeAttached !== undefined) listener(this.bridgeAttached);
		const wrapped = (message: unknown) => {
			if (isDirectorServerMessage(message) && message.type === "bridge_status") listener(message.attached);
		};
		this.websocket.on("message", wrapped);
		return () => this.websocket.off("message", wrapped);
	}

	sendTurn(prompt: string, deadlineMs = 180_000): string {
		const normalized = prompt.trim();
		if (normalized.length === 0 || normalized.length > 8_192) {
			throw new Error("INVALID_PROMPT: prompt must contain 1..8192 characters");
		}
		if (!this.capabilities.includes(DIRECTOR_TURN_CAPABILITY)) {
			throw new Error("CAPABILITY_NOT_NEGOTIATED: daemon does not support director turns");
		}
		if (this.activeRequestId !== undefined) throw new Error("BUSY: one director turn is already active");
		const request: DirectorTurnRequest = {
			type: "director_turn",
			id: randomUUID(),
			prompt: normalized,
			expected_revision_id: this.currentRevisionId,
			deadline_ms: deadlineMs,
		};
		this.activeRequestId = request.id;
		this.websocket.send(request);
		return request.id;
	}

	cancel(requestId: string): void {
		this.websocket.send({ type: "cancel", id: requestId });
	}

	async ping(nonce: string): Promise<string> {
		const response = this.websocket.next(
			(message) => isDirectorServerMessage(message) && message.type === "pong" && message.nonce === nonce,
		);
		this.websocket.send({ type: "ping", nonce });
		const message = await response;
		if (!isDirectorServerMessage(message) || message.type !== "pong") {
			throw new Error("CONTROLLER_PROTOCOL_ERROR: invalid pong");
		}
		return message.nonce;
	}

	async issueBridgeTicket(): Promise<BridgeAttachTicket> {
		const id = randomUUID();
		const response = this.websocket.next(
			(message) =>
				isDirectorServerMessage(message) &&
				message.type === "attach_ticket" &&
				"id" in message &&
				message.id === id,
		);
		this.websocket.send({ type: "issue_attach_ticket", id, role: "bridge" });
		const message = await response;
		if (!isDirectorServerMessage(message) || message.type !== "attach_ticket") {
			throw new Error("CONTROLLER_PROTOCOL_ERROR: invalid attach ticket");
		}
		return {
			runtimeDirectory: this.runtimeDirectory,
			ticket: message.ticket,
			expiresInMs: message.expires_in_ms,
		};
	}

	async disconnect(): Promise<void> {
		this.websocket.disconnect();
	}

	async shutdown(): Promise<void> {
		const acknowledgement = this.websocket.next((message) => isRecord(message) && message.type === "shutdown_ack");
		this.websocket.send({ type: "shutdown", reason: "controller_request" });
		await acknowledgement;
		await removeControllerCredential(this.runtimeDirectory);
		this.websocket.disconnect();
	}

	private observe(message: DirectorServerMessage): void {
		if (message.type === "director_transcript") {
			for (const event of message.events) this.observe(event);
			return;
		}
		if (message.type === "director_turn_started") this.activeRequestId = message.id;
		if (message.type === "director_turn_completed") {
			this.currentRevisionId = message.resulting_revision_id;
			this.activeRequestId = undefined;
		}
		if (message.type === "director_turn_failed" || message.type === "director_turn_cancelled") {
			this.activeRequestId = undefined;
		}
		if (message.type === "error" && message.id === this.activeRequestId) this.activeRequestId = undefined;
	}
}

async function fetchTranscript(identity: ControllerIdentity, signal?: AbortSignal): Promise<TranscriptReplay> {
	throwIfAborted(signal);
	const replay = new TranscriptReplay(identity);
	if (!identity.capabilities.includes(DIRECTOR_TRANSCRIPT_CAPABILITY)) return replay;
	const events: DirectorEvent[] = [];
	const useSnapshotCursor = identity.protocolFeatures.includes(SNAPSHOT_CURSOR_V2_FEATURE);
	let cursor = 0;
	let snapshotCursor: number | null = null;
	try {
		while (true) {
			const request: DirectorTranscriptRequest = useSnapshotCursor
				? {
						type: "director_transcript_request",
						id: randomUUID(),
						cursor,
						page_size: DIRECTOR_TRANSCRIPT_PAGE_SIZE,
						snapshot_cursor: snapshotCursor,
					}
				: {
						type: "director_transcript_request",
						id: randomUUID(),
						cursor,
						page_size: DIRECTOR_TRANSCRIPT_PAGE_SIZE,
					};
			const response = identity.websocket.next(
				(message) => isRecord(message) && message.type === "director_transcript" && message.id === request.id,
				2_000,
				signal,
			);
			identity.websocket.send(request);
			const message = await response;
			if (!acceptsServerMessage(identity.websocket, identity.capabilities, message) || message.type !== "director_transcript") {
				throw new Error("CONTROLLER_PROTOCOL_ERROR: invalid director transcript");
			}
			if (useSnapshotCursor) {
				if (!("snapshot_cursor" in message)) {
					throw new Error("CONTROLLER_PROTOCOL_ERROR: missing director transcript snapshot cursor");
				}
				if (snapshotCursor !== null && message.snapshot_cursor !== snapshotCursor) {
					throw new Error("CONTROLLER_PROTOCOL_ERROR: director transcript snapshot cursor changed");
				}
				snapshotCursor = message.snapshot_cursor;
			} else if ("snapshot_cursor" in message) {
				throw new Error("CONTROLLER_PROTOCOL_ERROR: unexpected director transcript snapshot cursor");
			}
			events.push(...message.events);
			if (message.next_cursor === null) break;
			if (message.next_cursor <= cursor) {
				throw new Error("CONTROLLER_PROTOCOL_ERROR: director transcript cursor did not advance");
			}
			cursor = message.next_cursor;
		}
		replay.setReplayed(events);
		return replay;
	} catch (error) {
		replay.finish();
		identity.websocket.disconnect();
		throw error;
	}
}

async function spawnController(
	options: ConnectControllerOptions,
	projectDirectory: string,
	runtimeBaseDirectory: string,
	environment: Readonly<Record<string, string | undefined>>,
	signal?: AbortSignal,
): Promise<ControllerSession> {
	const repositoryRoot = options.repositoryRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
	const launched = await launchDaemon({
		projectDirectory,
		repositoryRoot,
		daemonArguments: options.daemonArguments,
		environment,
		runtimeBaseDirectory,
		startupTimeoutMs: options.startupTimeoutMs,
		signal,
	});
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	const runtimeDirectory = path.join(runtimeBaseDirectory, `omb-${uid}`, launched.startup.launch_id);
	let identity: ControllerIdentity | undefined;
	try {
		throwIfAborted(signal);
		identity = await authenticateController({
			port: launched.startup.port,
			credential: launched.startup.bearer_token,
			projectDirectory,
			signal,
		});
		throwIfAborted(signal);
		await persistControllerCredential({
			runtimeDirectory,
			projectDirectory,
			launchId: launched.startup.launch_id,
			pid: launched.startup.pid,
			resumeToken: identity.resumeToken,
		});
		throwIfAborted(signal);
		const transcriptReplay = await fetchTranscript(identity, signal);
		throwIfAborted(signal);
		return new ControllerSession({
			connectionKind: "spawned",
			pid: launched.startup.pid,
			port: launched.startup.port,
			runtimeDirectory,
			identity,
			transcriptReplay,
			keepaliveIntervalMs: options.keepaliveIntervalMs,
		});
	} catch (error) {
		identity?.websocket.disconnect();
		try {
			await removeControllerCredential(runtimeDirectory);
		} finally {
			await terminateDaemon(launched.child);
		}
		throw error;
	}
}

async function attachedSession(
	candidate: DiscoveredController,
	projectDirectory: string,
	keepaliveIntervalMs?: number,
	signal?: AbortSignal,
): Promise<ControllerSession | undefined> {
	const identity = await attachExisting(candidate, projectDirectory, signal);
	if (identity === undefined) return undefined;
	try {
		const transcriptReplay = await fetchTranscript(identity, signal);
		throwIfAborted(signal);
		return new ControllerSession({
			connectionKind: "attached",
			pid: candidate.pid,
			port: candidate.port,
			runtimeDirectory: candidate.runtimeDirectory,
			identity,
			transcriptReplay,
			keepaliveIntervalMs,
		});
	} catch (error) {
		identity.websocket.disconnect();
		throw error;
	}
}

export async function connectController(options: ConnectControllerOptions): Promise<ControllerSession> {
	const environment = options.environment ?? process.env;
	const projectDirectory = await realpath(options.projectDirectory);
	const runtimeBaseDirectory = options.runtimeBaseDirectory ?? defaultRuntimeBaseDirectory(environment);
	const candidates = await discoverControllers({ projectDirectory, runtimeBaseDirectory });
	for (const candidate of candidates) {
		const session = await attachedSession(candidate, projectDirectory, options.keepaliveIntervalMs);
		if (session !== undefined) return session;
	}
	return spawnController(options, projectDirectory, runtimeBaseDirectory, environment);
}

export async function reconnectController(
	options: ConnectControllerOptions,
	signal: AbortSignal,
): Promise<ControllerSession> {
	const environment = options.environment ?? process.env;
	const projectDirectory = await realpath(options.projectDirectory);
	const runtimeBaseDirectory = options.runtimeBaseDirectory ?? defaultRuntimeBaseDirectory(environment);
	let delayMs = 100;
	while (!signal.aborted) {
		const candidates = await discoverControllers({ projectDirectory, runtimeBaseDirectory });
		let liveCandidate = false;
		for (const candidate of candidates) {
			if (!processIsAlive(candidate.pid)) continue;
			liveCandidate = true;
			const session = await attachedSession(candidate, projectDirectory, options.keepaliveIntervalMs, signal);
			if (session !== undefined) return session;
		}
		if (!liveCandidate) {
			const session = await spawnController(options, projectDirectory, runtimeBaseDirectory, environment, signal);
			if (signal.aborted) {
				await session.shutdown();
				throw new Error("CONTROLLER_RECONNECT_ABORTED");
			}
			return session;
		}
		await abortableDelay(delayMs, signal);
		delayMs = Math.min(delayMs * 2, 2_000);
	}
	throw new Error("CONTROLLER_RECONNECT_ABORTED");
}
