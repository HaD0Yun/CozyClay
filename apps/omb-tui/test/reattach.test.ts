import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DirectorEvent, DirectorServerMessage } from "../src/protocol.ts";
import { connectController, reconnectController } from "../src/controller.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const launchId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const requestId = "22222222-2222-4222-8222-222222222222";
const resumeToken = "R".repeat(43);
const at = "2026-07-19T18:00:00.000Z";
const digest = "a".repeat(64);

type TranscriptRequest = {
	readonly type: "director_transcript_request";
	readonly id: string;
	readonly cursor?: number;
	readonly page_size?: number;
};

class FakePagedDaemon {
	readonly receivedTurns: unknown[] = [];
	readonly receivedPings: string[] = [];
	maxSentMessageBytes = 0;
	private readonly server: Server;
	private readonly events: readonly DirectorEvent[];
	private readonly raceEvents: readonly DirectorEvent[];
	private socket: Socket | undefined;
	private upgraded = false;
	private input = Buffer.alloc(0);

	private constructor(server: Server, events: readonly DirectorEvent[], raceEvents: readonly DirectorEvent[]) {
		this.server = server;
		this.events = events;
		this.raceEvents = raceEvents;
		server.on("connection", (socket) => this.accept(socket));
	}

	static async start(options: {
		readonly events: readonly DirectorEvent[];
		readonly raceEvents?: readonly DirectorEvent[];
		readonly port?: number;
	}): Promise<FakePagedDaemon> {
		const server = net.createServer();
		const daemon = new FakePagedDaemon(server, options.events, options.raceEvents ?? []);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? 0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		return daemon;
	}

	get port(): number {
		const address = this.server.address();
		if (address === null || typeof address === "string") throw new Error("fake daemon is not listening");
		return address.port;
	}

	async close(): Promise<void> {
		this.socket?.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private accept(socket: Socket): void {
		this.socket = socket;
		let idleTimer = setTimeout(() => socket.destroy(), 2_000);
		socket.on("close", () => clearTimeout(idleTimer));
		socket.on("data", (chunk) => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => socket.destroy(), 2_000);
			this.input = Buffer.concat([this.input, chunk]);
			this.read();
		});
	}

	private read(): void {
		if (!this.upgraded) {
			const end = this.input.indexOf("\r\n\r\n");
			if (end === -1) return;
			const header = this.input.subarray(0, end).toString("latin1");
			const key = /^Sec-WebSocket-Key: (.+)$/im.exec(header)?.[1]?.trim();
			if (key === undefined) throw new Error("missing websocket key");
			const accept = createHash("sha1").update(key + GUID).digest("base64");
			this.socket!.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
			);
			this.input = this.input.subarray(end + 4);
			this.upgraded = true;
		}
		while (this.input.length >= 2) {
			const second = this.input[1]!;
			let length = second & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.input.length < 4) return;
				length = this.input.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.input.length < 10) return;
				length = Number(this.input.readBigUInt64BE(2));
				offset = 10;
			}
			const masked = (second & 0x80) !== 0;
			const frameLength = offset + (masked ? 4 : 0) + length;
			if (this.input.length < frameLength) return;
			const mask = masked ? this.input.subarray(offset, offset + 4) : undefined;
			if (masked) offset += 4;
			const payload = Buffer.from(this.input.subarray(offset, offset + length));
			this.input = this.input.subarray(frameLength);
			if (mask !== undefined) {
				for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3]!;
			}
			this.handle(JSON.parse(payload.toString("utf8")) as unknown);
		}
	}

	readonly receivedHelloProjectIds: string[] = [];

	private handle(value: unknown): void {
		if (typeof value !== "object" || value === null) return;
		const message = value as Record<string, unknown>;
		switch (message.type) {
			case "hello":
				if (typeof message.project_id === "string") this.receivedHelloProjectIds.push(message.project_id);
				this.send({
					type: "hello_ack",
					protocol: 1,
					daemon_version: "fake/1",
					launch_id: launchId,
					session_id: sessionId,
					server_nonce: "N".repeat(22),
					capabilities: ["director_turn_v1", "director_transcript_v1"],
				});
				this.send({ type: "controller_auth", resume_token: resumeToken, launch_id: launchId });
				break;
			case "director_transcript_request":
				this.sendTranscriptPage(message as TranscriptRequest);
				break;
			case "director_turn":
				this.receivedTurns.push(value);
				break;
			case "ping":
				if (typeof message.nonce === "string") this.receivedPings.push(message.nonce);
				this.send({ type: "pong", nonce: message.nonce });
				break;
		}
	}

	private sendTranscriptPage(request: TranscriptRequest): void {
		const cursor = request.cursor ?? 0;
		const pageSize = request.page_size ?? this.events.length;
		const page = this.events.slice(cursor, cursor + pageSize);
		const end = cursor + page.length;
		if (cursor === 0) {
			for (const event of this.raceEvents) this.send(event);
		}
		setTimeout(() => {
			this.send({
				type: "director_transcript",
				id: request.id,
				session_id: sessionId,
				events: page,
				next_cursor: end < this.events.length ? end : null,
			});
		}, 10);
	}

	private send(value: unknown): void {
		const payload = Buffer.from(JSON.stringify(value));
		this.maxSentMessageBytes = Math.max(this.maxSentMessageBytes, payload.length);
		const lengthBytes = payload.length < 126 ? 0 : payload.length <= 65_535 ? 2 : 8;
		const header = Buffer.alloc(2 + lengthBytes);
		header[0] = 0x81;
		header[1] = lengthBytes === 0 ? payload.length : lengthBytes === 2 ? 126 : 127;
		if (lengthBytes === 2) header.writeUInt16BE(payload.length, 2);
		if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
		this.socket!.write(Buffer.concat([header, payload]));
	}
}

async function advertiseFakeDaemon(root: string, projectDirectory: string, daemon: FakePagedDaemon): Promise<void> {
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	const userDirectory = path.join(root, `omb-${uid}`);
	const runtimeDirectory = path.join(userDirectory, launchId);
	await mkdir(userDirectory, { mode: 0o700 });
	await mkdir(runtimeDirectory, { mode: 0o700 });
	await writeFile(
		path.join(runtimeDirectory, "endpoint.json"),
		JSON.stringify({ schema_version: 1, host: "127.0.0.1", port: daemon.port, launch_id: launchId }),
		{ mode: 0o600 },
	);
	await writeFile(
		path.join(userDirectory, `controller-${launchId}.json`),
		JSON.stringify({
			schema_version: 1,
			launch_id: launchId,
			project_directory: await realpath(projectDirectory),
			pid: process.pid,
			resume_token: resumeToken,
		}),
		{ mode: 0o600 },
	);
}

async function writeDaemonStandIn(root: string): Promise<string> {
	const executable = path.join(root, "daemon-stand-in.mjs");
	await writeFile(
		executable,
		`#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";

const mode = fs.readFileSync("stand-in-mode", "utf8").trim();
const server = net.createServer((socket) => {
	socket.once("data", () => {
		fs.writeFileSync("stand-in-requested", String(process.pid));
		if (mode === "reject") socket.end("HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\n\\r\\n");
	});
});
server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	fs.writeFileSync("stand-in-pid", String(process.pid));
	console.log(JSON.stringify({
		type: "omb_daemon_ready",
		protocol: 1,
		port: address.port,
		pid: process.pid,
		launch_id: "${launchId}",
		bearer_token: "${"B".repeat(43)}",
		expires_in_ms: 10000
	}));
});
`,
	);
	await chmod(executable, 0o700);
	return realpath(executable);
}

async function waitForFile(file: string): Promise<string> {
	const deadline = Date.now() + 1_000;
	while (true) {
		try {
			return await readFile(file, "utf8");
		} catch {
			if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (true) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		if (Date.now() >= deadline) throw new Error(`child process ${pid} was not terminated`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function unusedPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("port reservation failed");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

async function advertiseController(
	root: string,
	projectDirectory: string,
	options: { readonly port: number; readonly pid: number },
): Promise<void> {
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	const userDirectory = path.join(root, `omb-${uid}`);
	const runtimeDirectory = path.join(userDirectory, launchId);
	await mkdir(userDirectory, { mode: 0o700 });
	await mkdir(runtimeDirectory, { mode: 0o700 });
	await writeFile(
		path.join(runtimeDirectory, "endpoint.json"),
		JSON.stringify({ schema_version: 1, host: "127.0.0.1", port: options.port, launch_id: launchId }),
		{ mode: 0o600 },
	);
	await writeFile(
		path.join(userDirectory, `controller-${launchId}.json`),
		JSON.stringify({
			schema_version: 1,
			launch_id: launchId,
			project_directory: await realpath(projectDirectory),
			pid: options.pid,
			resume_token: resumeToken,
		}),
		{ mode: 0o600 },
	);
}

function transcriptEvents(messages: readonly DirectorServerMessage[]): DirectorEvent[] {
	const events: DirectorEvent[] = [];
	for (const message of messages) {
		if (message.type === "director_transcript") {
			events.push(...message.events);
		} else if (
			message.type === "director_turn_started" ||
			message.type === "director_tool_call_started" ||
			message.type === "director_tool_call_finished" ||
			message.type === "director_turn_completed" ||
			message.type === "director_turn_failed" ||
			message.type === "director_turn_cancelled"
		) {
			events.push(message);
		}
	}
	return events;
}
async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("fake daemon message timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("the controller hello carries the durable project identity when one exists", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-project-id-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	const durableId = "9c956df6-c126-4008-b793-33e28ff904da";
	await mkdir(path.join(projectDirectory, ".omb"));
	await writeFile(
		path.join(projectDirectory, ".omb", "project.json"),
		JSON.stringify({ schema_version: 1, project_id: durableId }),
	);
	const daemon = await FakePagedDaemon.start({ events: [] });
	try {
		await advertiseFakeDaemon(runtimeBaseDirectory, projectDirectory, daemon);
		const session = await connectController({ projectDirectory, runtimeBaseDirectory, daemonArguments: [] });
		assert.deepEqual(daemon.receivedHelloProjectIds, [durableId]);
		await session.disconnect();
	} finally {
		await daemon.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("controller keepalive prevents an idle daemon disconnect and stops on exit", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-keepalive-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	const daemon = await FakePagedDaemon.start({ events: [] });
	try {
		await advertiseFakeDaemon(runtimeBaseDirectory, projectDirectory, daemon);
		const session = await connectController({
			projectDirectory,
			runtimeBaseDirectory,
			daemonArguments: [],
			keepaliveIntervalMs: 200,
		});
		await new Promise((resolve) => setTimeout(resolve, 5_100));
		assert.ok(daemon.receivedPings.length >= 20);
		assert.equal(new Set(daemon.receivedPings).size, daemon.receivedPings.length);
		assert.equal(await session.ping("still-alive"), "still-alive");
		await session.disconnect();
		const countAfterExit = daemon.receivedPings.length;
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(daemon.receivedPings.length, countAfterExit);
	} finally {
		await daemon.close();
		await rm(root, { recursive: true, force: true });
	}
});
test("reattach fetches a transcript larger than 1 MiB through bounded pages", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-paged-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	const events = Array.from({ length: 160 }, (_, sequence): DirectorEvent => ({
		type: "director_turn_started",
		id: requestId,
		sequence,
		at,
		prompt: `${sequence}:`.padEnd(8_000, "x"),
	}));
	assert.ok(Buffer.byteLength(JSON.stringify(events)) > 1024 * 1024);
	const daemon = await FakePagedDaemon.start({ events });
	try {
		await advertiseFakeDaemon(runtimeBaseDirectory, projectDirectory, daemon);
		const session = await connectController({ projectDirectory, runtimeBaseDirectory, daemonArguments: [] });
		assert.equal(session.connectionKind, "attached");
		assert.deepEqual(transcriptEvents(session.initialMessages).map((event) => event.sequence), events.map((event) => event.sequence));
		assert.ok(daemon.maxSentMessageBytes < 1024 * 1024);
		assert.equal(await session.ping("still-connected"), "still-connected");
		await session.disconnect();
	} finally {
		await daemon.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("reattach merges live terminal events emitted while replay is in flight", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-race-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	const started: DirectorEvent = { type: "director_turn_started", id: requestId, sequence: 0, at, prompt: "Build it" };
	const raced: readonly DirectorEvent[] = [
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
			type: "director_turn_completed",
			id: requestId,
			sequence: 2,
			at,
			summary: "Done",
			resulting_revision_id: digest,
		},
	];
	const daemon = await FakePagedDaemon.start({ events: [started, raced[0]!], raceEvents: raced });
	try {
		await advertiseFakeDaemon(runtimeBaseDirectory, projectDirectory, daemon);
		const session = await connectController({ projectDirectory, runtimeBaseDirectory, daemonArguments: [] });
		assert.deepEqual(transcriptEvents(session.initialMessages).map((event) => event.sequence), [0, 1, 2]);
		assert.doesNotThrow(() => session.sendTurn("A subsequent turn"));
		await waitFor(() => daemon.receivedTurns.length === 1);
		assert.equal(daemon.receivedTurns.length, 1);
		await session.disconnect();
	} finally {
		await daemon.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("reconnect retries a live advertised daemon without spawning until its endpoint accepts", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-reconnect-live-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	const port = await unusedPort();
	await advertiseController(runtimeBaseDirectory, projectDirectory, { port, pid: process.pid });
	const abortController = new AbortController();
	const reconnect = reconnectController(
		{ projectDirectory, runtimeBaseDirectory, daemonArguments: [], environment: {} },
		abortController.signal,
	);
	let daemon: FakePagedDaemon | undefined;
	try {
		await new Promise((resolve) => setTimeout(resolve, 250));
		daemon = await FakePagedDaemon.start({ events: [], port });
		const session = await reconnect;
		assert.equal(session.connectionKind, "attached");
		assert.equal(session.port, port);
		await session.disconnect();
	} finally {
		abortController.abort();
		await daemon?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("reconnect attempts to spawn when the advertised daemon process is dead", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-reconnect-dead-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	await advertiseController(runtimeBaseDirectory, projectDirectory, {
		port: await unusedPort(),
		pid: 2_147_483_647,
	});
	try {
		await assert.rejects(
			reconnectController(
				{ projectDirectory, runtimeBaseDirectory, daemonArguments: ["--faux"], environment: {} },
				new AbortController().signal,
			),
			/NOT_CONFIGURED: set OMB_DAEMON_EXECUTABLE or OMB_NODE_EXECUTABLE/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("aborting an in-flight reconnect stops promptly without spawning a daemon", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-reconnect-abort-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	await advertiseController(runtimeBaseDirectory, projectDirectory, {
		port: await unusedPort(),
		pid: process.pid,
	});
	const abortController = new AbortController();
	try {
		const startedAt = Date.now();
		const reconnect = reconnectController(
			{ projectDirectory, runtimeBaseDirectory, daemonArguments: [], environment: {} },
			abortController.signal,
		);
		setTimeout(() => abortController.abort(), 25);
		await assert.rejects(reconnect, /CONTROLLER_RECONNECT_ABORTED/);
		assert.ok(Date.now() - startedAt < 500, "aborted reconnect should settle promptly");
	} finally {
		abortController.abort();
		await rm(root, { recursive: true, force: true });
	}
});

test("aborting reconnect to a silent advertised endpoint settles promptly without spawning", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-reconnect-silent-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	const sockets = new Set<Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("silent endpoint is not listening");
	await advertiseController(runtimeBaseDirectory, projectDirectory, { port: address.port, pid: process.pid });
	const abortController = new AbortController();
	try {
		const startedAt = Date.now();
		const reconnect = reconnectController(
			{ projectDirectory, runtimeBaseDirectory, daemonArguments: [], environment: {} },
			abortController.signal,
		);
		setTimeout(() => abortController.abort(), 25);
		await assert.rejects(reconnect, /CONTROLLER_RECONNECT_ABORTED/);
		assert.ok(Date.now() - startedAt < 500, "silent endpoint abort should settle promptly");
	} finally {
		abortController.abort();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});

test("post-launch controller authentication failure terminates the spawned daemon", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-spawn-auth-failure-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	await writeFile(path.join(projectDirectory, "stand-in-mode"), "reject");
	const executable = await writeDaemonStandIn(root);
	try {
		await assert.rejects(
			connectController({
				projectDirectory,
				runtimeBaseDirectory,
				daemonArguments: ["--faux"],
				environment: { OMB_DAEMON_EXECUTABLE: executable, PATH: process.env.PATH },
			}),
			/CONTROLLER_AUTH_FAILED/,
		);
		const pid = Number(await waitForFile(path.join(projectDirectory, "stand-in-pid")));
		await waitForProcessExit(pid);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("aborting after daemon startup while authentication is silent terminates the child promptly", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-spawn-auth-abort-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	await writeFile(path.join(projectDirectory, "stand-in-mode"), "silent");
	const executable = await writeDaemonStandIn(root);
	const abortController = new AbortController();
	try {
		const startedAt = Date.now();
		const reconnect = reconnectController(
			{
				projectDirectory,
				runtimeBaseDirectory,
				daemonArguments: ["--faux"],
				environment: { OMB_DAEMON_EXECUTABLE: executable, PATH: process.env.PATH },
			},
			abortController.signal,
		);
		const pid = Number(await waitForFile(path.join(projectDirectory, "stand-in-requested")));
		abortController.abort();
		await assert.rejects(reconnect, /CONTROLLER_RECONNECT_ABORTED/);
		assert.ok(Date.now() - startedAt < 500, "post-startup abort should settle promptly");
		await waitForProcessExit(pid);
	} finally {
		abortController.abort();
		await rm(root, { recursive: true, force: true });
	}
});
