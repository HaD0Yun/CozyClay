import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import test from "node:test";
import { BlenderBridge } from "../src/bridge.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Minimal masked WebSocket client that mimics the Blender addon's ws_client. */
class MockBlenderClient {
	private socket!: Socket;
	private buffer = Buffer.alloc(0);
	private readonly inbox: string[] = [];
	private waiters: Array<(value: string) => void> = [];

	async connect(port: number, token: string): Promise<void> {
		this.socket = connect(port, "127.0.0.1");
		await new Promise<void>((resolve, reject) => {
			this.socket.once("error", reject);
			this.socket.once("connect", () => {
				this.socket.off("error", reject);
				resolve();
			});
		});
		const key = randomBytes(16).toString("base64");
		this.socket.write(
			`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
				`Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
				`Authorization: Bearer ${token}\r\nX-OMB-Role: bridge\r\n\r\n`,
		);
		const head = await this.readUpgradeResponse();
		const accept = createHash("sha1").update(key + GUID).digest("base64");
		assert.match(head, /101 Switching Protocols/);
		assert.match(head, new RegExp(`Sec-WebSocket-Accept: ${accept.replace(/\+/g, "\\+")}`));
		this.socket.on("data", (chunk) => this.onData(chunk));
	}

	private readUpgradeResponse(): Promise<string> {
		return new Promise((resolve, reject) => {
			const onData = (chunk: Buffer) => {
				this.buffer = Buffer.concat([this.buffer, chunk]);
				const marker = this.buffer.indexOf("\r\n\r\n");
				if (marker === -1) return;
				this.socket.off("data", onData);
				const head = this.buffer.subarray(0, marker).toString("ascii");
				this.buffer = this.buffer.subarray(marker + 4);
				resolve(head);
			};
			this.socket.on("data", onData);
			this.socket.once("error", reject);
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 2) {
			const opcode = this.buffer[0]! & 0x0f;
			let length = this.buffer[1]! & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.buffer.length < 10) return;
				length = Number(this.buffer.readBigUInt64BE(2));
				offset = 10;
			}
			// Server frames are unmasked.
			if (this.buffer.length < offset + length) return;
			const payload = this.buffer.subarray(offset, offset + length);
			this.buffer = this.buffer.subarray(offset + length);
			if (opcode === 1) {
				const text = payload.toString("utf8");
				const waiter = this.waiters.shift();
				if (waiter !== undefined) waiter(text);
				else this.inbox.push(text);
			}
		}
	}

	send(value: unknown): void {
		const payload = Buffer.from(JSON.stringify(value), "utf8");
		const mask = randomBytes(4);
		const length = payload.byteLength;
		let header: Buffer;
		if (length < 126) {
			header = Buffer.from([0x80 | 0x01, 0x80 | length]);
		} else if (length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x81;
			header[1] = 0x80 | 126;
			header.writeUInt16BE(length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x81;
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		const masked = Buffer.from(payload);
		for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index & 3]!;
		this.socket.write(Buffer.concat([header, mask, masked]));
	}

	receive(): Promise<string> {
		const buffered = this.inbox.shift();
		if (buffered !== undefined) return Promise.resolve(buffered);
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	hello(projectId: string): void {
		this.send({
			type: "hello",
			protocol: 2,
			addon_version: "0.1.0",
			blender_version: "5.2.0 LTS",
			project_id: projectId,
			client_nonce: randomBytes(16).toString("base64url"),
			capabilities: ["mutation_bridge_v2", "scene_manifest_v3", "transaction_commit_v2"],
		});
	}

	close(): void {
		this.socket.destroy();
	}
}

const PROJECT_ID = "356ae9c2-9cc1-4541-8e8e-a6d759b4df64";
const REVISION = "a".repeat(64);

const SNAPSHOT = {
	schemaVersion: 2 as const,
	scene: {
		name: "Scene",
		frameStart: 1,
		frameEnd: 250,
		fps: 24,
		activeCamera: null,
	},
	render: {
		resolutionX: 1920,
		resolutionY: 1080,
		resolutionPercentage: 100,
	},
	objects: [],
	cameras: [],
	markers: [],
	animations: [],
};

test("bridge completes the hello handshake and echoes negotiated capabilities", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		const ack = JSON.parse(await client.receive());
		assert.equal(ack.type, "hello_ack");
		assert.equal(ack.protocol, 2);
		assert.equal(ack.daemon_version, "0.1.0");
		assert.deepEqual(ack.capabilities, [
			"mutation_bridge_v2",
			"scene_manifest_v3",
			"transaction_commit_v2",
		]);
		assert.match(ack.launch_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.match(ack.server_nonce, /^[A-Za-z0-9_-]{22}$/);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("bridge rejects a client without the bridge role or wrong token", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	try {
		const client = new MockBlenderClient();
		await assert.rejects(client.connect(endpoint.port, "wrong-token"));
	} finally {
		await bridge.close();
	}
});

test("inspectProject sends a bridge_request and resolves the bound revision + snapshot", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		const inspectPromise = bridge.inspectProject();
		const request = JSON.parse(await client.receive());
		assert.equal(request.type, "bridge_request");
		assert.equal(request.method, "inspect_project");
		assert.deepEqual(request.params, {});
		assert.equal(request.expected_revision_id, "0".repeat(64));

		client.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		const result = await inspectPromise;
		assert.equal(result.revision, REVISION);
		assert.equal(result.snapshot.scene.name, "Scene");
		assert.equal(bridge.revisionId, REVISION);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("a bridge_error rejects the pending inspect with the addon code", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive();
		await bridge.waitForAttach();

		const inspectPromise = bridge.inspectProject();
		const request = JSON.parse(await client.receive());
		client.send({
			type: "bridge_error",
			id: request.id,
			request_id: request.request_id,
			code: "SCENE_UNAVAILABLE",
			message: "no scene bound",
			retryable: false,
		});
		await assert.rejects(inspectPromise, /SCENE_UNAVAILABLE/);
	} finally {
		client.close();
		await bridge.close();
	}
});
