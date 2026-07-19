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
	type DirectorServerMessage,
	type DirectorTurnRequest,
} from "./protocol.ts";
import { connectWebSocket, type ControllerWebSocket } from "./ws-client.ts";

const ZERO_REVISION = "0".repeat(64);
const DIRECTOR_TRANSCRIPT_CAPABILITY = "director_transcript_v1";
const DIRECTOR_TURN_CAPABILITY = "director_turn_v1";

export interface ConnectControllerOptions {
	readonly projectDirectory: string;
	readonly daemonArguments: readonly string[];
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly repositoryRoot?: string;
	readonly runtimeBaseDirectory?: string;
	readonly startupTimeoutMs?: number;
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
		if (!isRecord(helloAck) || !Array.isArray(helloAck.capabilities)) {
			throw new Error("CONTROLLER_PROTOCOL_ERROR: invalid hello acknowledgement");
		}
		if (!isRecord(auth) || typeof auth.resume_token !== "string") {
			throw new Error("CONTROLLER_PROTOCOL_ERROR: invalid controller credential");
		}
		return {
			websocket,
			resumeToken: auth.resume_token,
			capabilities: helloAck.capabilities.filter((value): value is string => typeof value === "string"),
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

export class ControllerSession {
	readonly connectionKind: "spawned" | "attached";
	readonly pid: number;
	readonly port: number;
	readonly runtimeDirectory: string;
	readonly resumeToken: string;
	readonly capabilities: readonly string[];
	readonly initialMessages: readonly DirectorServerMessage[];
	private readonly websocket: ControllerWebSocket;
	private currentRevisionId = ZERO_REVISION;
	private activeRequestId: string | undefined;

	constructor(options: {
		readonly connectionKind: "spawned" | "attached";
		readonly pid: number;
		readonly port: number;
		readonly runtimeDirectory: string;
		readonly identity: ControllerIdentity;
		readonly initialMessages: readonly DirectorServerMessage[];
	}) {
		this.connectionKind = options.connectionKind;
		this.pid = options.pid;
		this.port = options.port;
		this.runtimeDirectory = options.runtimeDirectory;
		this.websocket = options.identity.websocket;
		this.resumeToken = options.identity.resumeToken;
		this.capabilities = options.identity.capabilities;
		this.initialMessages = options.initialMessages;
		for (const message of this.initialMessages) this.observe(message);
		this.websocket.on("message", (message: unknown) => {
			if (isDirectorServerMessage(message)) this.observe(message);
		});
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
			(message) => isRecord(message) && message.type === "pong" && message.nonce === nonce,
		);
		this.websocket.send({ type: "ping", nonce });
		const message = await response;
		if (!isRecord(message) || typeof message.nonce !== "string") {
			throw new Error("CONTROLLER_PROTOCOL_ERROR: invalid pong");
		}
		return message.nonce;
	}

	async issueBridgeTicket(): Promise<BridgeAttachTicket> {
		const response = this.websocket.next((message) => isRecord(message) && message.type === "attach_ticket");
		this.websocket.send({ type: "issue_attach_ticket", role: "bridge" });
		const message = await response;
		if (
			!isRecord(message) ||
			typeof message.ticket !== "string" ||
			typeof message.expires_in_ms !== "number"
		) throw new Error("CONTROLLER_PROTOCOL_ERROR: invalid attach ticket");
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

async function fetchTranscript(identity: ControllerIdentity): Promise<readonly DirectorServerMessage[]> {
	if (!identity.capabilities.includes(DIRECTOR_TRANSCRIPT_CAPABILITY)) return [];
	const id = randomUUID();
	const response = identity.websocket.next(
		(message) => isRecord(message) && message.type === "director_transcript" && message.id === id,
	);
	identity.websocket.send({ type: "director_transcript_request", id });
	const message = await response;
	if (!isDirectorServerMessage(message) || message.type !== "director_transcript") {
		throw new Error("CONTROLLER_PROTOCOL_ERROR: invalid director transcript");
	}
	return [message];
}

export async function connectController(options: ConnectControllerOptions): Promise<ControllerSession> {
	const environment = options.environment ?? process.env;
	const projectDirectory = await realpath(options.projectDirectory);
	const runtimeBaseDirectory = options.runtimeBaseDirectory ?? defaultRuntimeBaseDirectory(environment);
	const candidates = await discoverControllers({ projectDirectory, runtimeBaseDirectory });
	for (const candidate of candidates) {
		const identity = await attachExisting(candidate, projectDirectory);
		if (identity === undefined) continue;
		const initialMessages = await fetchTranscript(identity);
		return new ControllerSession({
			connectionKind: "attached",
			pid: candidate.pid,
			port: candidate.port,
			runtimeDirectory: candidate.runtimeDirectory,
			identity,
			initialMessages,
		});
	}

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
	const initialMessages = await fetchTranscript(identity);
	return new ControllerSession({
		connectionKind: "spawned",
		pid: launched.startup.pid,
		port: launched.startup.port,
		runtimeDirectory,
		identity,
		initialMessages,
	});
}
