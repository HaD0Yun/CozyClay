import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { expectedAddonVersion } from "../src/bridge.ts";

export const PROJECT_ID = "356ae9c2-9cc1-4541-8e8e-a6d759b4df64";
export const REVISION = "a".repeat(64);
export const SNAPSHOT = {
	schemaVersion: 2 as const,
	scene: { name: "Scene", frameStart: 1, frameEnd: 250, fps: 24, activeCamera: null },
	render: { resolutionX: 1920, resolutionY: 1080, resolutionPercentage: 100 },
	objects: [], cameras: [], markers: [], animations: [],
};
async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`TEST_TIMEOUT: ${label} did not complete within ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export class FakeAddon {
	private server: Server | undefined;
	private socket: Socket | undefined;
	private buffer = Buffer.alloc(0);
	private readonly inbox: Record<string, unknown>[] = [];
	private readonly waiters: Array<(message: Record<string, unknown>) => void> = [];
	private readonly closeWaiters: Array<() => void> = [];
	private socketClosed = false;
	readonly project: string;
	generation = 0;
	private readonly ackCapabilities: readonly string[];
	readonly addonVersion: string;
	private endpointToken = "";
	private readonly acknowledgeHello: boolean;

	constructor(
		project: string,
		options: {
			readonly capabilities?: readonly string[];
			readonly addonVersion?: string;
			readonly acknowledgeHello?: boolean;
		} = {},
	) {
		this.project = project;
		this.ackCapabilities = options.capabilities ?? ["execute_blender_python_v1"];
		this.addonVersion = options.addonVersion ?? expectedAddonVersion();
		this.acknowledgeHello = options.acknowledgeHello ?? true;
	}

	async start(generation = this.generation): Promise<void> {
		this.generation = generation;
		this.server = createServer((socket) => {
			this.socket = socket;
			this.socketClosed = false;
			socket.once("close", () => {
				this.socketClosed = true;
				for (const resolve of this.closeWaiters.splice(0)) resolve();
			});
			socket.on("data", (chunk) => this.read(chunk));
		});
		await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
		const address = this.server.address();
		assert.ok(address && typeof address !== "string");
		await this.publish({ port: address.port, token_generation: generation });
	}

	async publish(overrides: Record<string, unknown> = {}): Promise<void> {
		const endpoint = {
			schema_version: 1,
			host: "127.0.0.1",
			port: 1,
			pid: process.pid,
			token: randomBytes(32).toString("base64url"),
			token_generation: this.generation,
			addon_version: this.addonVersion,
			protocol_version: 1,
			...overrides,
		};
		if (typeof endpoint.token === "string" && !("token" in overrides)) this.endpointToken = endpoint.token;
		await mkdir(path.join(this.project, ".cclay"), { recursive: true });
		await writeFile(path.join(this.project, ".cclay", "bridge-endpoint.json"), JSON.stringify(endpoint));
	}

	async stop(): Promise<void> {
		this.socket?.destroy();
		const server = this.server;
		this.server = undefined;
		if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	send(message: Record<string, unknown>): void {
		this.sendBytes(Buffer.from(JSON.stringify(message)));
	}

	sendBytes(body: Buffer): void {
		assert.ok(this.socket);
		const header = Buffer.alloc(4);
		header.writeUInt32BE(body.length);
		this.socket.write(Buffer.concat([header, body]));
	}

	sendOversizedFrame(): void {
		assert.ok(this.socket);
		const header = Buffer.alloc(4);
		header.writeUInt32BE(18 * 1024 * 1024 + 1);
		this.socket.write(header);
	}

	receive(timeoutMs?: number): Promise<Record<string, unknown>> {
		const message = this.inbox.shift();
		return message === undefined
			? withTimeout(new Promise((resolve) => this.waiters.push(resolve)), "addon receive", timeoutMs)
			: Promise.resolve(message);
	}

	waitForSocketClose(timeoutMs?: number): Promise<void> {
		return this.socketClosed
			? Promise.resolve()
			: withTimeout(new Promise((resolve) => this.closeWaiters.push(resolve)), "addon socket close", timeoutMs);
	}

	private read(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 4) {
			const length = this.buffer.readUInt32BE();
			if (this.buffer.length < length + 4) return;
			const message = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
			this.buffer = this.buffer.subarray(length + 4);
			if (message.type === "hello") {
				if (message.token !== this.endpointToken) {
					this.socket?.destroy();
					continue;
				}
				if (this.acknowledgeHello) {
					this.send({ type: "hello_ack", addon_version: this.addonVersion, protocol_version: 1, capabilities: [...this.ackCapabilities] });
				}
				continue;
			}
			const waiter = this.waiters.shift();
			if (waiter) waiter(message);
			else this.inbox.push(message);
		}
	}
}
