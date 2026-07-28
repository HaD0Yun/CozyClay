import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import test from "node:test";
import { BlenderBridge } from "../src/bridge.ts";
import { surfaceCapabilities } from "./addon-surface.ts";

class BlenderClient {
	private socket!: Socket;
	private buffer = Buffer.alloc(0);
	private readonly inbox: string[] = [];
	private waiters: Array<(value: string) => void> = [];

	async connect(port: number, token: string): Promise<void> {
		this.socket = connect(port, "127.0.0.1");
		await new Promise<void>((resolve) => this.socket.once("connect", resolve));
		const key = randomBytes(16).toString("base64");
		this.socket.write(
			`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
				`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n` +
				"X-CCLAY-Role: bridge\r\n\r\n",
		);
		await new Promise<void>((resolve) => {
			const readHead = (chunk: Buffer) => {
				this.buffer = Buffer.concat([this.buffer, chunk]);
				const marker = this.buffer.indexOf("\r\n\r\n");
				if (marker < 0) return;
				this.socket.off("data", readHead);
				this.buffer = this.buffer.subarray(marker + 4);
				resolve();
			};
			this.socket.on("data", readHead);
		});
		this.socket.on("data", (chunk) => this.read(chunk));
	}

	hello(projectId: string): void {
		this.send({
			type: "hello",
			protocol: 2,
			addon_version: "0.1.0",
			blender_version: "5.2.0 LTS",
			project_id: projectId,
			client_nonce: randomBytes(16).toString("base64url"),
			capabilities: surfaceCapabilities(),
		});
	}

	send(value: unknown): void {
		const payload = Buffer.from(JSON.stringify(value));
		const mask = randomBytes(4);
		const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.alloc(4);
		if (payload.length >= 126) {
			header[0] = 0x81;
			header[1] = 0x80 | 126;
			header.writeUInt16BE(payload.length, 2);
		}
		const masked = Buffer.from(payload);
		for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]!;
		this.socket.write(Buffer.concat([header, mask, masked]));
	}

	receive(): Promise<Record<string, unknown>> {
		const buffered = this.inbox.shift();
		if (buffered !== undefined) return Promise.resolve(JSON.parse(buffered));
		return new Promise((resolve) => this.waiters.push((value) => resolve(JSON.parse(value))));
	}

	close(): void {
		this.socket.destroy();
	}

	private read(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 2) {
			let length = this.buffer[1]! & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			}
			if (this.buffer.length < offset + length) return;
			const value = this.buffer.subarray(offset, offset + length).toString("utf8");
			this.buffer = this.buffer.subarray(offset + length);
			const waiter = this.waiters.shift();
			if (waiter !== undefined) waiter(value);
			else this.inbox.push(value);
		}
	}
}

const PROJECT_ID = "356ae9c2-9cc1-4541-8e8e-a6d759b4df64";
const BASE = "a".repeat(64);
const CANDIDATE = "b".repeat(64);

async function attached(): Promise<{ bridge: BlenderBridge; client: BlenderClient }> {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new BlenderClient();
	await client.connect(endpoint.port, endpoint.token);
	client.hello(PROJECT_ID);
	await client.receive();
	await bridge.waitForAttach();
	return { bridge, client };
}

test("stage_scene retains prepared evidence and acknowledges only after the local commit", async () => {
	const { bridge, client } = await attached();
	try {
		// Bind the bridge to the durable base revision first.
		const inspect = bridge.inspectProject();
		const inspectRequest = await client.receive();
		client.send({
			type: "bridge_result",
			id: inspectRequest.id,
			request_id: inspectRequest.request_id,
			result: {
				revision: BASE,
				snapshot: {
					schemaVersion: 2,
					scene: { name: "Scene", frameStart: 1, frameEnd: 250, fps: 24, activeCamera: null },
					render: { resolutionX: 1920, resolutionY: 1080, resolutionPercentage: 100 },
					objects: [], cameras: [], markers: [], animations: [],
				},
			},
		});
		await inspect;

		const entityId = randomUUID();
		const mutation = bridge.stageScene(
			{
				schema_version: 1,
				expected_revision_id: BASE,
				operations: [{
					op: "add_primitive",
					entity_id: entityId,
					primitive_type: "CUBE",
					name: "Cube",
					location: [0, 0, 0],
					rotation: [0, 0, 0],
					scale: [1, 1, 1],
				}],
			},
			{ reportProgress: () => {} },
		);
		const request = await client.receive();
		const transactionId = randomUUID();
		client.send({
			type: "bridge_transaction_prepared",
			id: request.id,
			transaction_id: transactionId,
			operation: "stage_scene",
			project_id: PROJECT_ID,
			base_revision_id: BASE,
			base_scene_hash: "c".repeat(64),
			candidate_revision_id: CANDIDATE,
			candidate_scene_hash: "d".repeat(64),
			base_backup_sha256: "e".repeat(64),
			canonical_blend_sha256: "f".repeat(64),
		});
		client.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: {
				manifest: { revisionId: CANDIDATE, sceneHash: "d".repeat(64) },
				scene_hash: "d".repeat(64),
				entity_identities: [{ operation_index: 0, entity_id: entityId, name: "Cube" }],
			},
		});
		const prepared = await mutation;
		assert.equal(prepared.transaction.transaction_id, transactionId);
		assert.equal(prepared.requestId, request.request_id);

		const finishing = bridge.finishDurableCommit(CANDIDATE);
		const ack = await client.receive();
		assert.deepEqual(ack, {
			type: "bridge_transaction_ack",
			id: request.id,
			transaction_id: transactionId,
			status: "committed",
			resulting_revision_id: CANDIDATE,
		});
		client.send({ type: "bridge_transaction_acknowledged", id: request.id, transaction_id: transactionId });
		await finishing;
		assert.equal(bridge.revisionId, CANDIDATE);
	} finally {
		client.close();
		await bridge.close();
	}
});
