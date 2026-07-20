import assert from "node:assert/strict";
import net, { type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CameraPlanV1 } from "@oh-my-blender/protocol";
import { start as startDaemon, type Daemon, type DaemonOptions } from "../src/daemon.ts";
import {
	AttachTicketBroker,
	OwnerCredential,
	ProjectCredentialBroker,
	createRuntimeAdvertisement,
} from "../src/control-plane.ts";
const TEST_PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const start = (options: Omit<DaemonOptions, "projectId"> & { projectId?: string }) =>
	startDaemon({ projectId: TEST_PROJECT_ID, ...options });

const websocketKey = "AAAAAAAAAAAAAAAAAAAAAA==";
const nonce = () => Buffer.alloc(16, Math.floor(Math.random() * 255)).toString("base64url");
const controllerHello = () => ({
	type: "hello",
	protocol: 1,
	addon_version: "controller-test",
	blender_version: "n/a",
	project_id: TEST_PROJECT_ID,
	client_nonce: nonce(),
});
const bridgeHello = () => ({
	type: "hello",
	protocol: 2,
	addon_version: "bridge-test",
	blender_version: "4.3",
	project_id: TEST_PROJECT_ID,
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

async function connect(
	port: number,
	credential: string,
	role: "controller" | "bridge",
	headers: Readonly<Record<string, string>> = {},
): Promise<Client> {
	return new Promise<Client>((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1", () => {
			const extraHeaders = Object.entries(headers)
				.map(([name, value]) => `${name}: ${value}\r\n`)
				.join("");
			socket.write(
				`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${websocketKey}\r\nAuthorization: Bearer ${credential}\r\nX-OMB-Role: ${role}\r\n${extraHeaders}\r\n`,
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
	const headers: Readonly<Record<string, string>> =
		credential === daemon.startup.bearer_token
			? {}
			: { "X-OMB-Launch-ID": daemon.startup.launch_id };
	const client = await connect(daemon.port, credential, "controller", headers);
	const hello = controllerHello();
	client.send(hello);
	await client.next((message) => message.type === "hello_ack");
	const auth = await client.next((message) => message.type === "controller_auth");
	return { client, resumeToken: auth.resume_token as string, projectId: hello.project_id };
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
	const superseded = broker.issue("bridge");
	const replacement = broker.issue("bridge");
	assert.equal(broker.consume(superseded.ticket, "bridge"), false);
	assert.equal(broker.consume(replacement.ticket, "bridge"), true);
	const expired = broker.issue("bridge");
	now += 250;
	assert.equal(broker.consume(expired.ticket, "bridge"), false);
});

test("ticket records are keyed by SHA-256 digest hex rather than raw credentials", () => {
	const broker = new AttachTicketBroker({ now: () => 0 });
	const issued = broker.issue("bridge");
	const keys = [...(broker as unknown as { tickets: Map<string, unknown> }).tickets.keys()];
	assert.equal(keys.length, 1);
	assert.match(keys[0]!, /^[0-9a-f]{64}$/);
	assert.notEqual(keys[0], issued.ticket);
});

test("project credentials enforce exact binding and independent discovery generations", () => {
	let now = 1_000;
	const broker = new ProjectCredentialBroker({ now: () => now });
	const common = { projectId: randomUUID(), authority: "local-owner", lineageId: randomUUID() };
	const bridge1 = broker.publishBridge(common);
	const peer1 = broker.publishControllerPeer(common);
	assert.equal(bridge1.expiresInMs, 15_000);
	assert.equal(peer1.expiresInMs, 15_000);
	assert.equal(bridge1.principal.generation, 1);
	assert.equal(peer1.principal.generation, 1);
	const bridge2 = broker.publishBridge(common);
	assert.equal(bridge2.principal.generation, 2);
	assert.equal(broker.consumeBridge(bridge1.ticket, common.projectId), undefined);
	assert.equal(broker.consumeControllerPeer(peer1.ticket, common.projectId)?.principal.generation, 1);
	assert.equal(broker.consumeBridge(bridge2.ticket, randomUUID()), undefined);
	const expiring = broker.publishBridge({ ...common, lineageId: randomUUID() });
	now += 15_000;
	assert.equal(broker.consumeBridge(expiring.ticket, common.projectId), undefined);
});

test("controller peer resume ratchets, expires, rejects replay, and revokes lineage", () => {
	let now = 0;
	const broker = new ProjectCredentialBroker({ now: () => now });
	const binding = { projectId: randomUUID(), authority: "local-owner", lineageId: randomUUID() };
	const issued = broker.publishControllerPeer(binding);
	const first = broker.consumeControllerPeer(issued.ticket, binding.projectId);
	assert.ok(first);
	assert.equal(first.expiresInMs, 300_000);
	assert.equal(broker.consumeControllerPeer(issued.ticket, binding.projectId), undefined);
	const second = broker.resumeControllerPeer(first.resumeToken, binding.projectId);
	assert.ok(second);
	assert.notEqual(second.resumeToken, first.resumeToken);
	assert.equal(broker.resumeControllerPeer(first.resumeToken, binding.projectId), undefined);
	now = 300_000;
	assert.equal(broker.resumeControllerPeer(second.resumeToken, binding.projectId), undefined);
	const revocable = broker.consumeControllerPeer(
		broker.publishControllerPeer(binding).ticket,
		binding.projectId,
	);
	assert.ok(revocable);
	broker.revokeControllerPeer(binding.lineageId);
	assert.equal(broker.resumeControllerPeer(revocable.resumeToken, binding.projectId), undefined);
});

test("owner credentials carry immutable exact project authority", () => {
	const projectId = randomUUID();
	const owner = new OwnerCredential({
		projectId,
		authority: "local-owner",
		lineageId: randomUUID(),
	});
	assert.equal(owner.principal.role, "owner");
	assert.equal(Object.isFrozen(owner.principal), true);
	assert.equal(owner.matches(owner.value, randomUUID()), false);
	assert.equal(owner.matches(owner.value, projectId), true);
	owner.zero();
	assert.equal(owner.matches(owner.value, projectId), false);
});

test("runtime discovery slots use independent exact private files", async () => {
	const base = await mkdtemp(path.join(os.tmpdir(), "omb-slots-test-"));
	const advertisement = await createRuntimeAdvertisement({
		launchId: randomUUID(),
		port: 8123,
		baseDirectory: base,
	});
	const bridgeSlot = {
		schema_version: 1 as const,
		project_id: randomUUID(),
		ticket: Buffer.alloc(32, 1).toString("base64url"),
		expires_at_ms: 15_000,
		generation: 1,
	};
	const peerSlot = {
		...bridgeSlot,
		lineage_id: randomUUID(),
		ticket: Buffer.alloc(32, 2).toString("base64url"),
	};
	try {
		await Promise.all([
			advertisement.writeBridgeSlot(bridgeSlot),
			advertisement.writeControllerPeerSlot(peerSlot),
		]);
		const bridgePath = path.join(advertisement.directory, "bridge-slot.json");
		const peerPath = path.join(advertisement.directory, "controller-peer-slot.json");
		assert.deepEqual(JSON.parse(await readFile(bridgePath, "utf8")), bridgeSlot);
		assert.deepEqual(JSON.parse(await readFile(peerPath, "utf8")), peerSlot);
		assert.equal((await stat(bridgePath)).mode & 0o777, 0o600);
		assert.equal((await stat(peerPath)).mode & 0o777, 0o600);
		await advertisement.removeBridgeSlot();
		await assert.rejects(access(bridgePath));
		assert.deepEqual(JSON.parse(await readFile(peerPath, "utf8")), peerSlot);
	} finally {
		await advertisement.cleanup();
	}
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

test("daemon atomically replaces the project-bound private attach handoff and removes it on consumption", async () => {
	const base = await mkdtemp(path.join(os.tmpdir(), "omb-handoff-test-"));
	const daemon = await start({ port: 0, handlers: {}, stdout: () => {}, runtimeBaseDirectory: base });
	try {
		const control = await controller(daemon);
		const first = await issueBridgeTicket(control.client);
		const handoffPath = path.join(daemon.runtimeDirectory, "attach-handoff.json");
		const firstHandoff = JSON.parse(await readFile(handoffPath, "utf8"));
		assert.equal(Number.isSafeInteger(firstHandoff.expires_at_ms), true);
		assert.deepEqual({ ...firstHandoff, expires_at_ms: 0 }, {
			schema_version: 1,
			project_id: daemon.projectId,
			ticket: first,
			expires_at_ms: 0,
		});
		assert.equal((await stat(handoffPath)).mode & 0o777, 0o600);

		const second = await issueBridgeTicket(control.client);
		assert.notEqual(second, first);
		assert.equal(JSON.parse(await readFile(handoffPath, "utf8")).ticket, second);
		await assert.rejects(connect(daemon.port, first, "bridge"), /403/);

		const bridge = await connect(daemon.port, second, "bridge");
		bridge.send(bridgeHello());
		await bridge.next((message) => message.type === "hello_ack");
		await assert.rejects(access(handoffPath));
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

test("closing bridge is unavailable immediately while controller remains active", async () => {
	const daemon = await start({
		port: 0,
		stdout: () => {},
		idleTimeoutMs: 40,
		handlers: {
			mutate: async (_params, { applyCameraPlan, signal }) => ({
				result: await applyCameraPlan(bridgePlan(), { signal, reportProgress: () => {} }),
				resulting_revision_id: "1".repeat(64),
			}),
		},
	});
	const control = await controller(daemon);
	const ticket = await issueBridgeTicket(control.client);
	const bridge = await connect(daemon.port, ticket, "bridge");
	bridge.send(bridgeHello());
	await bridge.next((message) => message.type === "hello_ack");
	bridge.socket.end();
	await new Promise((resolve) => setTimeout(resolve, 10));
	control.client.send({ type: "ping", nonce: "controller-keepalive" });
	await control.client.next((message) => message.type === "pong");
	const activeRequest = request();
	const startedAt = Date.now();
	control.client.send(activeRequest);
	const error = await control.client.next(
		(message) => message.type === "error" && message.id === activeRequest.id,
		200,
	);
	assert.equal(error.code, "MUTATION_BRIDGE_UNAVAILABLE");
	assert.ok(Date.now() - startedAt < 200);
	control.client.socket.destroy();
	bridge.socket.destroy();
	await daemon.close();
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
test("project-bound owner and peer credentials enforce authority and ratchet generations", async () => {
	const projectId = randomUUID();
	const lineageId = randomUUID();
	const base = await mkdtemp(path.join(os.tmpdir(), "omb-peer-auth-test-"));
	let resolveSlow!: () => void;
	const slow = new Promise<void>((resolve) => {
		resolveSlow = resolve;
	});
	const daemon = await start({
		projectId,
		port: 0,
		handlers: {
			slow: async () => {
				await slow;
				return { result: { ok: true }, resulting_revision_id: "1".repeat(64) };
			},
		},
		stdout: () => {},
		runtimeBaseDirectory: base,
	});
	let owner: Client | undefined;
	let peer: Client | undefined;
	try {
		owner = await connect(daemon.port, daemon.startup.bearer_token, "controller");
		owner.send({ ...controllerHello(), project_id: projectId });
		const helloAck = await owner.next((message) => message.type === "hello_ack");
		assert.deepEqual(helloAck.protocol_features, ["snapshot_cursor_v2"]);
		assert.deepEqual(helloAck.capabilities, ["inspect_project", "controller_peers_v1"]);
		const ownerAuth = await owner.next((message) => message.type === "controller_auth");

		const publishId = randomUUID();
		owner.send({ type: "publish_controller_peer_discovery_slot", id: publishId, lineage_id: lineageId });
		const publishAck = await owner.next(
			(message) => message.type === "controller_peer_discovery_slot_ack" && message.id === publishId,
		);
		assert.equal(publishAck.generation, 1);
		const firstPeerSlot = JSON.parse(
			await readFile(path.join(daemon.runtimeDirectory, "controller-peer-slot.json"), "utf8"),
		) as { ticket: string; generation: number };
		const ackCount = owner.messages.filter(
			(message) => message.type === "controller_peer_discovery_slot_ack" && message.id === publishId,
		).length;
		owner.send({ type: "publish_controller_peer_discovery_slot", id: publishId, lineage_id: lineageId });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(
			owner.messages.filter(
				(message) => message.type === "controller_peer_discovery_slot_ack" && message.id === publishId,
			).length,
			ackCount + 1,
		);
		assert.deepEqual(
			JSON.parse(await readFile(path.join(daemon.runtimeDirectory, "controller-peer-slot.json"), "utf8")),
			firstPeerSlot,
		);
		owner.send({ type: "publish_bridge_discovery_slot", id: publishId });
		const conflict = await owner.next(
			(message) => message.type === "error" && message.id === publishId,
		);
		assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
		const peerSlot = JSON.parse(
			await readFile(path.join(daemon.runtimeDirectory, "controller-peer-slot.json"), "utf8"),
		) as { ticket: string };
		peer = await connect(daemon.port, peerSlot.ticket, "controller");
		peer.send({ ...controllerHello(), project_id: projectId });
		await peer.next((message) => message.type === "hello_ack");
		const firstPeerAuth = await peer.next((message) => message.type === "controller_peer_auth");
		assert.equal(firstPeerAuth.generation, 1);
		assert.equal(peer.messages.some((message) => message.type === "controller_auth"), false);
		assert.notEqual(firstPeerAuth.resume_token, ownerAuth.resume_token);

		peer.socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 20));
		peer = await connect(daemon.port, firstPeerAuth.resume_token as string, "controller", {
			"X-OMB-Launch-ID": daemon.startup.launch_id,
			"X-OMB-Peer-Lineage-ID": lineageId,
			"X-OMB-Peer-Generation": "1",
		});
		peer.send({ ...controllerHello(), project_id: projectId });
		await peer.next((message) => message.type === "hello_ack");
		const secondPeerAuth = await peer.next((message) => message.type === "controller_peer_auth");
		assert.equal(secondPeerAuth.generation, 2);
		assert.notEqual(secondPeerAuth.resume_token, firstPeerAuth.resume_token);
		const ownerRequestId = randomUUID();
		owner.send({
			type: "request",
			id: ownerRequestId,
			method: "owner_only_response",
			params: {},
			expected_revision_id: "0".repeat(64),
			deadline_ms: 1_000,
		});
		await owner.next((message) => message.type === "error" && message.id === ownerRequestId);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(peer.messages.some((message) => message.id === ownerRequestId), false);

		const deniedId = randomUUID();
		peer.send({ type: "publish_bridge_discovery_slot", id: deniedId });
		const denied = await peer.next((message) => message.type === "error" && message.id === deniedId);
		assert.equal(denied.code, "AUTHORITY_DENIED");
		assert.equal(owner.messages.some((message) => message.id === deniedId), false);
		const peerRequestId = randomUUID();
		peer.send({
			type: "request",
			id: peerRequestId,
			method: "slow",
			params: {},
			expected_revision_id: "0".repeat(64),
			deadline_ms: 1_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		peer.socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 20));
		resolveSlow();
		await new Promise((resolve) => setTimeout(resolve, 20));
		peer = await connect(daemon.port, secondPeerAuth.resume_token as string, "controller", {
			"X-OMB-Launch-ID": daemon.startup.launch_id,
			"X-OMB-Peer-Lineage-ID": lineageId,
			"X-OMB-Peer-Generation": "2",
		});
		peer.send({ ...controllerHello(), project_id: projectId });
		await peer.next((message) => message.type === "hello_ack");
		const thirdPeerAuth = await peer.next((message) => message.type === "controller_peer_auth");
		assert.equal(thirdPeerAuth.generation, 3);
		const replayed = await peer.next((message) => message.type === "response" && message.id === peerRequestId);
		assert.equal((replayed.result as { ok: boolean }).ok, true);
		assert.equal(owner.messages.some((message) => message.id === peerRequestId), false);

		const revokeId = randomUUID();
		owner.send({ type: "revoke_controller_peer", id: revokeId, lineage_id: lineageId });
		await owner.next((message) => message.type === "revoke_controller_peer_ack" && message.id === revokeId);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(peer.socket.destroyed, true);
		await assert.rejects(
			connect(daemon.port, thirdPeerAuth.resume_token as string, "controller", {
				"X-OMB-Launch-ID": daemon.startup.launch_id,
				"X-OMB-Peer-Lineage-ID": lineageId,
				"X-OMB-Peer-Generation": "3",
			}),
			/403/,
		);
	} finally {
		peer?.socket.destroy();
		owner?.socket.destroy();
		await daemon.close();
	}
});
