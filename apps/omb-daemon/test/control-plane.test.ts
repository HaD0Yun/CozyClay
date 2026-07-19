import assert from "node:assert/strict";
import net, { type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CameraPlanV1 } from "@oh-my-blender/protocol";
import { start, type Daemon } from "../src/daemon.ts";
import { AttachTicketBroker } from "../src/control-plane.ts";

const websocketKey = "AAAAAAAAAAAAAAAAAAAAAA==";
const nonce = () => Buffer.alloc(16, Math.floor(Math.random() * 255)).toString("base64url");
const controllerHello = () => ({
	type: "hello",
	protocol: 1,
	addon_version: "controller-test",
	blender_version: "n/a",
	project_id: randomUUID(),
	client_nonce: nonce(),
});
const bridgeHello = () => ({
	type: "hello",
	protocol: 2,
	addon_version: "bridge-test",
	blender_version: "4.3",
	project_id: randomUUID(),
	client_nonce: nonce(),
	capabilities: ["mutation_bridge_v2"],
});
const request = () => ({
	type: "request",
	id: randomUUID(),
	method: "mutate",
	params: {},
	expected_revision_id: "0".repeat(64),
	deadline_ms: 1_000,
});
const bridgePlan = (): CameraPlanV1 => ({
	schema_version: 1,
	expected_revision_id: "0".repeat(64),
	evidence_sha256: "a".repeat(64),
	output_format: { width: 640, height: 360 },
	keyframes: [{
		frame: 1,
		pose: {
			position: [0, 0, 5],
			look_at: [0, 0, 0],
			up: [0, 1, 0],
			vertical_fov_radians: 0.5,
		},
		transition: "smooth",
	}],
});

function frame(value: unknown): Buffer {
	const payload = Buffer.from(JSON.stringify(value));
	const extendedBytes = payload.length < 126 ? 0 : payload.length < 65_536 ? 2 : 8;
	const header = Buffer.alloc(2 + extendedBytes + 4);
	header[0] = 0x81;
	header[1] = 0x80 | (extendedBytes === 0 ? payload.length : extendedBytes === 2 ? 126 : 127);
	if (extendedBytes === 2) header.writeUInt16BE(payload.length, 2);
	if (extendedBytes === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
	const maskOffset = 2 + extendedBytes;
	header.fill(7, maskOffset, maskOffset + 4);
	const masked = Buffer.from(payload);
	for (let index = 0; index < masked.length; index++) masked[index] ^= 7;
	return Buffer.concat([header, masked]);
}

class Client {
	readonly messages: Record<string, unknown>[] = [];
	readonly socket: Socket;
	private buffer = Buffer.alloc(0);

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk) => this.read(chunk));
	}

	send(value: unknown): void {
		this.socket.write(frame(value));
	}

	async next(predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 1_000) {
		const existing = this.messages.find(predicate);
		if (existing !== undefined) return existing;
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				clearInterval(poll);
				reject(new Error("message timeout"));
			}, timeoutMs);
			const poll = setInterval(() => {
				const message = this.messages.find(predicate);
				if (message !== undefined) {
					clearTimeout(timer);
					clearInterval(poll);
					resolve(message);
				}
			}, 2);
		});
	}

	private read(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 2) {
			let length = this.buffer[1]! & 127;
			let offset = 2;
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			}
			if (this.buffer.length < offset + length) return;
			const opcode = this.buffer[0]! & 15;
			const payload = this.buffer.subarray(offset, offset + length);
			this.buffer = this.buffer.subarray(offset + length);
			if (opcode === 1) this.messages.push(JSON.parse(payload.toString()) as Record<string, unknown>);
		}
	}
}

async function connect(port: number, credential: string, role: "controller" | "bridge"): Promise<Client> {
	return new Promise<Client>((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1", () => {
			socket.write(
				`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${websocketKey}\r\nAuthorization: Bearer ${credential}\r\nX-OMB-Role: ${role}\r\n\r\n`,
			);
		});
		let response = "";
		const upgraded = (chunk: Buffer) => {
			response += chunk.toString("latin1");
			if (!response.includes("\r\n\r\n")) return;
			if (!response.startsWith("HTTP/1.1 101")) {
				socket.destroy();
				reject(new Error(response.split("\r\n")[0]));
				return;
			}
			socket.off("data", upgraded);
			resolve(new Client(socket));
		};
		socket.on("data", upgraded);
		socket.on("error", reject);
	});
}

async function controller(daemon: Daemon, credential = daemon.startup.bearer_token) {
	const client = await connect(daemon.port, credential, "controller");
	client.send(controllerHello());
	await client.next((message) => message.type === "hello_ack");
	const auth = await client.next((message) => message.type === "controller_auth");
	return { client, resumeToken: auth.resume_token as string };
}

async function issueBridgeTicket(client: Client): Promise<string> {
	const existing = new Set(
		client.messages
			.filter((message) => message.type === "attach_ticket")
			.map((message) => message.ticket),
	);
	client.send({ type: "issue_attach_ticket", role: "bridge" });
	const issued = await client.next(
		(message) => message.type === "attach_ticket" && !existing.has(message.ticket),
	);
	return issued.ticket as string;
}

test("attach tickets are bridge-scoped, expiring, and burn on first validation", () => {
	let now = 10;
	const broker = new AttachTicketBroker({ now: () => now }, 250);
	const issued = broker.issue("bridge");
	assert.equal(broker.consume(issued.ticket, "controller"), false);
	assert.equal(broker.consume(issued.ticket, "bridge"), true);
	assert.equal(broker.consume(issued.ticket, "bridge"), false);
	const expired = broker.issue("bridge");
	now += 250;
	assert.equal(broker.consume(expired.ticket, "bridge"), false);
});

test("daemon advertises its endpoint in a private runtime launch directory", async () => {
	const base = await mkdtemp(path.join(os.tmpdir(), "omb-control-test-"));
	const daemon = await start({ port: 0, handlers: {}, stdout: () => {}, runtimeBaseDirectory: base });
	try {
		const endpoint = JSON.parse(await readFile(path.join(daemon.runtimeDirectory, "endpoint.json"), "utf8"));
		assert.deepEqual(endpoint, {
			schema_version: 1,
			launch_id: daemon.startup.launch_id,
			host: "127.0.0.1",
			port: daemon.port,
		});
	} finally {
		await daemon.close();
	}
});

test("controller and bridge run simultaneously; controller detach preserves bridge work and replay", async () => {
	const daemon = await start({
		port: 0,
		stdout: () => {},
		handlers: {
			mutate: async (_params, { applyCameraPlan, reportProgress, signal }) => {
				const result = await applyCameraPlan(bridgePlan(), {
					signal,
					reportProgress: (progress) =>
						reportProgress(progress.phase, progress.completed, progress.total),
				});
				return { result, resulting_revision_id: "1".repeat(64) };
			},
		},
	});
	const first = await controller(daemon);
	const ticket = await issueBridgeTicket(first.client);
	const bridge = await connect(daemon.port, ticket, "bridge");
	bridge.send(bridgeHello());
	await bridge.next((message) => message.type === "hello_ack");
	const activeRequest = request();
	first.client.send(activeRequest);
	const bridgeRequest = await bridge.next((message) => message.type === "bridge_request");
	bridge.send({
		type: "bridge_progress",
		id: bridgeRequest.id,
		request_id: activeRequest.id,
		phase: "mutating",
		completed: 1,
		total: 2,
	});
	await first.client.next((message) => message.type === "progress" && message.id === activeRequest.id);
	first.client.socket.destroy();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(bridge.socket.destroyed, false);
	bridge.send({
		type: "bridge_result",
		id: bridgeRequest.id,
		request_id: activeRequest.id,
		result: { ok: true },
	});
	const resumed = await controller(daemon, first.resumeToken);
	try {
		const response = await resumed.client.next(
			(message) => message.type === "response" && message.id === activeRequest.id,
		);
		assert.equal((response.result as { ok: boolean }).ok, true);
	} finally {
		bridge.socket.destroy();
		resumed.client.socket.destroy();
		await daemon.close();
	}
});

test("bridge attach tickets reject connected replay and expiry", async () => {
	const daemon = await start({
		port: 0,
		handlers: {},
		stdout: () => {},
		attachTicketTtlMs: 100,
	});
	const control = await controller(daemon);
	try {
		const replayedTicket = await issueBridgeTicket(control.client);
		const bridge = await connect(daemon.port, replayedTicket, "bridge");
		bridge.send(bridgeHello());
		await bridge.next((message) => message.type === "hello_ack");
		bridge.socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 20));
		await assert.rejects(connect(daemon.port, replayedTicket, "bridge"), /403/);

		const expiredTicket = await issueBridgeTicket(control.client);
		await new Promise((resolve) => setTimeout(resolve, 110));
		await assert.rejects(connect(daemon.port, expiredTicket, "bridge"), /403/);
	} finally {
		control.client.socket.destroy();
		await daemon.close();
	}
});
test("bridge disconnect cancels bridge work but preserves the controller session", async () => {
	const daemon = await start({
		port: 0,
		stdout: () => {},
		handlers: {
			mutate: async (_params, { applyCameraPlan, signal }) => ({
				result: await applyCameraPlan(bridgePlan(), {
					signal,
					reportProgress: () => {},
				}),
				resulting_revision_id: "1".repeat(64),
			}),
		},
	});
	const control = await controller(daemon);
	let bridge = await connect(daemon.port, await issueBridgeTicket(control.client), "bridge");
	bridge.send(bridgeHello());
	await bridge.next((message) => message.type === "hello_ack");
	const interrupted = request();
	control.client.send(interrupted);
	await bridge.next((message) => message.type === "bridge_request");
	bridge.socket.destroy();
	const cancelled = await control.client.next(
		(message) => message.type === "error" && message.id === interrupted.id,
	);
	assert.equal(cancelled.code, "CANCELLED");
	control.client.send({ type: "ping", nonce: "session-alive" });
	assert.equal((await control.client.next((message) => message.type === "pong")).nonce, "session-alive");
	await new Promise((resolve) => setTimeout(resolve, 20));

	bridge = await connect(daemon.port, await issueBridgeTicket(control.client), "bridge");
	bridge.send(bridgeHello());
	await bridge.next((message) => message.type === "hello_ack");
	const resumedRequest = request();
	control.client.send(resumedRequest);
	const bridgeRequest = await bridge.next((message) => message.type === "bridge_request");
	bridge.send({
		type: "bridge_result",
		id: bridgeRequest.id,
		request_id: resumedRequest.id,
		result: { ok: true },
	});
	assert.equal(
		(await control.client.next(
			(message) => message.type === "response" && message.id === resumedRequest.id,
		)).type,
		"response",
	);
	bridge.socket.destroy();
	control.client.socket.destroy();
	await daemon.close();
});
test("only a controller may issue tickets or shut down the daemon", async () => {
	const daemon = await start({ port: 0, handlers: {}, stdout: () => {} });
	const control = await controller(daemon);
	const bridge = await connect(daemon.port, await issueBridgeTicket(control.client), "bridge");
	bridge.send(bridgeHello());
	await bridge.next((message) => message.type === "hello_ack");
	bridge.send({ type: "issue_attach_ticket", role: "bridge" });
	bridge.send({ type: "shutdown", reason: "unauthorized" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(bridge.messages.some((message) => message.type === "attach_ticket"), false);
	assert.equal(bridge.messages.some((message) => message.type === "shutdown_ack"), false);
	assert.equal(daemon.port > 0, true);
	control.client.send({ type: "shutdown", reason: "controller_request" });
	await control.client.next((message) => message.type === "shutdown_ack");
	await daemon.stopped;
});
