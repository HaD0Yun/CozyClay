import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
	defaultRuntimeBaseDirectory,
	discoverControllers,
	persistControllerCredential,
	removeControllerCredential,
	type DiscoveredController,
} from "./discovery.ts";
import { launchDaemon } from "./launcher.ts";
import {
	isDirectorServerMessage,
	type DirectorEvent,
	type DirectorServerMessage,
	type DirectorTranscriptRequest,
	type DirectorTurnRequest,
} from "./protocol.ts";
import { connectWebSocket, type ControllerWebSocket } from "./ws-client.ts";

const ZERO_REVISION = "0".repeat(64);
const DIRECTOR_TRANSCRIPT_CAPABILITY = "director_transcript_v1";
const DIRECTOR_TURN_CAPABILITY = "director_turn_v1";
const DIRECTOR_TRANSCRIPT_PAGE_SIZE = 64;
const CONTROLLER_KEEPALIVE_INTERVAL_MS = 20_000;

function isDirectorEvent(message: DirectorServerMessage): message is DirectorEvent {
	return message.type === "director_turn_started" ||
		message.type === "director_tool_call_started" ||
		message.type === "director_tool_call_finished" ||
		message.type === "director_turn_completed" ||
		message.type === "director_turn_failed" ||
		message.type === "director_turn_cancelled";
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectId(projectDirectory: string): string {
	const bytes = createHash("sha256").update(projectDirectory).digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function authenticateController(options: {
	readonly port: number;
	readonly credential: string;
	readonly projectDirectory: string;
}): Promise<ControllerIdentity> {
	const websocket = await connectWebSocket({ host: "127.0.0.1", port: options.port, credential: options.credential });
	const helloAckPromise = websocket.next((message) => isRecord(message) && message.type === "hello_ack");
	const authPromise = websocket.next((message) => isRecord(message) && message.type === "controller_auth");
	websocket.send({
		type: "hello",
		protocol: 1,
		addon_version: "omb-tui/0.1.0",
		blender_version: "n/a",
		project_id: projectId(options.projectDirectory),
		client_nonce: randomBytes(16).toString("base64url"),
	});
	try {
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
): Promise<ControllerIdentity | undefined> {
	if (!processIsAlive(candidate.pid)) return undefined;
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			return await authenticateController({
				port: candidate.port,
				credential: candidate.resumeToken,
				projectDirectory,
			});
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	if (lastError instanceof Error && lastError.message.startsWith("CONTROLLER_CONNECT_FAILED:")) return undefined;
	throw lastError;
}
class TranscriptReplay {
	private readonly websocket: ControllerWebSocket;
	private readonly liveEvents: DirectorEvent[] = [];
	private replayedEvents: readonly DirectorEvent[] = [];
	private readonly listener: (message: unknown) => void;

	constructor(websocket: ControllerWebSocket) {
		this.websocket = websocket;
		this.listener = (message: unknown) => {
			if (isDirectorServerMessage(message) && isDirectorEvent(message)) this.liveEvents.push(message);
		};
		this.websocket.on("message", this.listener);
	}

	setReplayed(events: readonly DirectorEvent[]): void {
		this.replayedEvents = events;
	}

	finish(): readonly DirectorServerMessage[] {
		this.websocket.off("message", this.listener);
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
			if (isDirectorServerMessage(message)) this.observe(message);
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

	sendTurn(prompt: string, deadlineMs = 30_000): string {
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
		const response = this.websocket.next((message) => isRecord(message) && message.type === "attach_ticket");
		this.websocket.send({ type: "issue_attach_ticket", role: "bridge" });
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

async function fetchTranscript(identity: ControllerIdentity): Promise<TranscriptReplay> {
	const replay = new TranscriptReplay(identity.websocket);
	if (!identity.capabilities.includes(DIRECTOR_TRANSCRIPT_CAPABILITY)) return replay;
	const events: DirectorEvent[] = [];
	let cursor = 0;
	try {
		while (true) {
			const request: DirectorTranscriptRequest = {
				type: "director_transcript_request",
				id: randomUUID(),
				cursor,
				page_size: DIRECTOR_TRANSCRIPT_PAGE_SIZE,
			};
			const response = identity.websocket.next(
				(message) => isRecord(message) && message.type === "director_transcript" && message.id === request.id,
			);
			identity.websocket.send(request);
			const message = await response;
			if (!isDirectorServerMessage(message) || message.type !== "director_transcript") {
				throw new Error("CONTROLLER_PROTOCOL_ERROR: invalid director transcript");
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
): Promise<ControllerSession> {
	const repositoryRoot = options.repositoryRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
	const launched = await launchDaemon({
		projectDirectory,
		repositoryRoot,
		daemonArguments: options.daemonArguments,
		environment,
		runtimeBaseDirectory,
		startupTimeoutMs: options.startupTimeoutMs,
	});
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	const runtimeDirectory = path.join(runtimeBaseDirectory, `omb-${uid}`, launched.startup.launch_id);
	const identity = await authenticateController({
		port: launched.startup.port,
		credential: launched.startup.bearer_token,
		projectDirectory,
	});
	await persistControllerCredential({
		runtimeDirectory,
		projectDirectory,
		launchId: launched.startup.launch_id,
		pid: launched.startup.pid,
		resumeToken: identity.resumeToken,
	});
	const transcriptReplay = await fetchTranscript(identity);
	return new ControllerSession({
		connectionKind: "spawned",
		pid: launched.startup.pid,
		port: launched.startup.port,
		runtimeDirectory,
		identity,
		transcriptReplay,
		keepaliveIntervalMs: options.keepaliveIntervalMs,
	});
}

async function attachedSession(
	candidate: DiscoveredController,
	projectDirectory: string,
	keepaliveIntervalMs?: number,
): Promise<ControllerSession | undefined> {
	const identity = await attachExisting(candidate, projectDirectory);
	if (identity === undefined) return undefined;
	const transcriptReplay = await fetchTranscript(identity);
	return new ControllerSession({
		connectionKind: "attached",
		pid: candidate.pid,
		port: candidate.port,
		runtimeDirectory: candidate.runtimeDirectory,
		identity,
		transcriptReplay,
		keepaliveIntervalMs,
	});
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
			const session = await attachedSession(candidate, projectDirectory, options.keepaliveIntervalMs);
			if (session !== undefined) return session;
		}
		if (!liveCandidate) {
			const session = await spawnController(options, projectDirectory, runtimeBaseDirectory, environment);
			if (signal.aborted) {
				await session.shutdown();
				throw new Error("CONTROLLER_RECONNECT_ABORTED");
			}
			return session;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, delayMs);
			function done(): void {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			}
			signal.addEventListener("abort", done, { once: true });
			if (signal.aborted) done();
			timer.unref();
		});
		delayMs = Math.min(delayMs * 2, 2_000);
	}
	throw new Error("CONTROLLER_RECONNECT_ABORTED");
}
