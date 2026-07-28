import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { BlenderBridge, expectedAddonVersion } from "../src/bridge.ts";
import { REPO_ADDON_VERSION, surfaceCapabilities } from "./addon-surface.ts";

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
				`Authorization: Bearer ${token}\r\nX-CCLAY-Role: bridge\r\n\r\n`,
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

	hello(projectId: string, capabilities: string[] = surfaceCapabilities()): void {
		this.send({
			type: "hello",
			protocol: 2,
			addon_version: "0.1.0",
			blender_version: "5.2.0 LTS",
			project_id: projectId,
			client_nonce: randomBytes(16).toString("base64url"),
			capabilities,
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

test("renderQaFrames validates streamed bytes, publishes them, and returns thumbnail-only metadata", async () => {
	const project = await mkdtemp(path.join(tmpdir(), "cclay-extension-render-"));
	const bridge = new BlenderBridge(project);
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive();
		await bridge.waitForAttach();

		const inspect = bridge.inspectProject();
		const inspectRequest = JSON.parse(await client.receive());
		client.send({
			type: "bridge_result",
			id: inspectRequest.id,
			request_id: inspectRequest.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		await inspect;

		const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
		const sha256 = createHash("sha256").update(png).digest("hex");
		const rendering = bridge.renderQaFrames(
			{ schema_version: 1, revision_id: REVISION, frames: [1] },
			{ reportProgress: () => {} },
		);
		const request = JSON.parse(await client.receive());
		client.send({
			type: "bridge_artifact_batch_begin",
			id: request.id,
			request_id: request.request_id,
			frames: [{ frame: 1, total_chunks: 1, total_byte_length: png.length, sha256 }],
		});
		client.send({
			type: "bridge_artifact_chunk",
			id: request.id,
			request_id: request.request_id,
			frame: 1,
			chunk_index: 0,
			total_chunks: 1,
			byte_offset: 0,
			byte_length: png.length,
			data_base64: png.toString("base64"),
		});
		client.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: {
				schema_version: 1,
				revision_id: REVISION,
				profile_version: "cclay-qa-png-v1",
				frames: [{
					frame: 1,
					width: 640,
					height: 360,
					profile_version: "cclay-qa-png-v1",
					byte_length: png.length,
					sha256,
					thumbnail: {
						mime_type: "image/jpeg",
						data_base64: Buffer.from("jpeg-thumbnail-payload").toString("base64"),
						width: 256,
						height: 144,
					},
				}],
			},
		});
		const result = await rendering;
		assert.equal(result.frames[0]?.uri, `cclay-artifact://sha256/${sha256}`);
		// The result metadata carries no PNG copy: the streamed chunks are the
		// only source, so the artifact on disk proves the reassembly path.
		assert.equal("image" in (result.frames[0] as Record<string, unknown>), false);
		assert.deepEqual(
			await readFile(path.join(project, ".cclay", "artifacts", "sha256", `${sha256}.png`)),
			png,
		);
	} finally {
		client.close();
		await bridge.close();
		await rm(project, { recursive: true, force: true });
	}
});

test("a render result whose streamed artifact is not a PNG is refused", async () => {
	const project = await mkdtemp(path.join(tmpdir(), "cclay-extension-notpng-"));
	const bridge = new BlenderBridge(project);
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive();
		await bridge.waitForAttach();

		const inspect = bridge.inspectProject();
		const inspectRequest = JSON.parse(await client.receive());
		client.send({
			type: "bridge_result",
			id: inspectRequest.id,
			request_id: inspectRequest.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		await inspect;

		// Content validation moved here when the metadata stopped restating the
		// PNG, so a non-PNG stream must still fail instead of reaching disk.
		const notPng = Buffer.from("definitely-not-a-png");
		const sha256 = createHash("sha256").update(notPng).digest("hex");
		const rendering = bridge.renderQaFrames(
			{ schema_version: 1, revision_id: REVISION, frames: [1] },
			{ reportProgress: () => {} },
		);
		const request = JSON.parse(await client.receive());
		client.send({
			type: "bridge_artifact_batch_begin",
			id: request.id,
			request_id: request.request_id,
			frames: [{ frame: 1, total_chunks: 1, total_byte_length: notPng.length, sha256 }],
		});
		client.send({
			type: "bridge_artifact_chunk",
			id: request.id,
			request_id: request.request_id,
			frame: 1,
			chunk_index: 0,
			total_chunks: 1,
			byte_offset: 0,
			byte_length: notPng.length,
			data_base64: notPng.toString("base64"),
		});
		client.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: {
				schema_version: 1,
				revision_id: REVISION,
				profile_version: "cclay-qa-png-v1",
				frames: [{
					frame: 1,
					width: 640,
					height: 360,
					profile_version: "cclay-qa-png-v1",
					byte_length: notPng.length,
					sha256,
					thumbnail: {
						mime_type: "image/jpeg",
						data_base64: Buffer.from("jpeg-thumbnail-payload").toString("base64"),
						width: 256,
						height: 144,
					},
				}],
			},
		});
		await assert.rejects(rendering, /INVALID_RENDER_QA_RESULT: streamed artifact is not a PNG/);
	} finally {
		client.close();
		await bridge.close();
		await rm(project, { recursive: true, force: true });
	}
});

test("a mid-render disconnect names the operation, phase, and streamed artifact bytes", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive();
		await bridge.waitForAttach();

		const inspect = bridge.inspectProject();
		const inspectRequest = JSON.parse(await client.receive());
		client.send({
			type: "bridge_result",
			id: inspectRequest.id,
			request_id: inspectRequest.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		await inspect;

		const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
		const sha256 = createHash("sha256").update(png).digest("hex");
		const rendering = bridge.renderQaFrames(
			{ schema_version: 1, revision_id: REVISION, frames: [1] },
			{ reportProgress: () => {} },
		);
		const request = JSON.parse(await client.receive());
		client.send({
			type: "bridge_artifact_batch_begin",
			id: request.id,
			request_id: request.request_id,
			frames: [{ frame: 1, total_chunks: 2, total_byte_length: png.length * 2, sha256 }],
		});
		client.send({
			type: "bridge_progress",
			id: request.id,
			request_id: request.request_id,
			phase: "publishing",
			completed: 1,
			total: 2,
		});
		client.send({
			type: "bridge_artifact_chunk",
			id: request.id,
			request_id: request.request_id,
			frame: 1,
			chunk_index: 0,
			total_chunks: 2,
			byte_offset: 0,
			byte_length: png.length,
			data_base64: png.toString("base64"),
		});
		// Let the streamed chunk land before the transport dies.
		await new Promise((resolve) => setTimeout(resolve, 20));
		client.close();

		// A bare BRIDGE_DISCONNECTED left no way to tell which call died or how
		// far it got; the diagnostics clause is the regression under test.
		await assert.rejects(rendering, (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /^BRIDGE_DISCONNECTED: Blender bridge disconnected \(/);
			assert.match(error.message, /during render_qa_frames/);
			assert.match(error.message, /phase publishing/);
			assert.match(error.message, new RegExp(`artifacts ${png.length}/${png.length * 2} bytes over 1 frame\\(s\\)`));
			return true;
		});
	} finally {
		client.close();
		await bridge.close();
	}
});

test("produceDirectingEvidence sends explicit-null frame bounds with project_id and binds the returned revision", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		const producing = bridge.produceDirectingEvidence({ frame_start: 10 });
		const request = JSON.parse(await client.receive());
		assert.equal(request.type, "bridge_request");
		assert.equal(request.method, "produce_directing_evidence");
		assert.deepEqual(request.params, { project_id: PROJECT_ID, frame_start: 10, frame_end: null });
		assert.equal(request.expected_revision_id, "0".repeat(64));

		const evidence = {
			schema_version: 1,
			evidence_sha256: "e".repeat(64),
			revision_id: REVISION,
			scene_hash: "f".repeat(64),
			frame_range: { start: 10, end: 250 },
			byte_length: 2048,
		};
		client.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: evidence,
		});
		assert.deepEqual(await producing, evidence);
		assert.equal(bridge.revisionId, REVISION);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("produceDirectingEvidence rejects a malformed result and a revision that does not bind", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive();
		await bridge.waitForAttach();

		const inspect = bridge.inspectProject();
		const inspectRequest = JSON.parse(await client.receive());
		client.send({
			type: "bridge_result",
			id: inspectRequest.id,
			request_id: inspectRequest.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		await inspect;

		const malformed = bridge.produceDirectingEvidence();
		const malformedRequest = JSON.parse(await client.receive());
		assert.deepEqual(malformedRequest.params, { project_id: PROJECT_ID, frame_start: null, frame_end: null });
		client.send({
			type: "bridge_result",
			id: malformedRequest.id,
			request_id: malformedRequest.request_id,
			result: { schema_version: 1, evidence_sha256: "not-hex" },
		});
		await assert.rejects(malformed, /INVALID_PRODUCE_EVIDENCE_RESULT/);

		const mismatched = bridge.produceDirectingEvidence();
		const mismatchedRequest = JSON.parse(await client.receive());
		assert.equal(mismatchedRequest.expected_revision_id, REVISION);
		client.send({
			type: "bridge_result",
			id: mismatchedRequest.id,
			request_id: mismatchedRequest.request_id,
			result: {
				schema_version: 1,
				evidence_sha256: "e".repeat(64),
				revision_id: "b".repeat(64),
				scene_hash: "f".repeat(64),
				frame_range: { start: 1, end: 250 },
				byte_length: 2048,
			},
		});
		await assert.rejects(mismatched, /INVALID_PRODUCE_EVIDENCE_RESULT: evidence does not bind the expected revision/);
		assert.equal(bridge.revisionId, REVISION);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("inspectProject adopts a rebound addon revision and a following stage_scene uses it", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		// Bind the bridge to the initial durable revision.
		const first = bridge.inspectProject();
		const firstRequest = JSON.parse(await client.receive());
		client.send({
			type: "bridge_result",
			id: firstRequest.id,
			request_id: firstRequest.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		await first;
		assert.equal(bridge.revisionId, REVISION);

		// The addon recovered a different durable truth (e.g. after an aborted
		// stage_scene); inspect adopts it as the authoritative rebind instead of
		// throwing INVALID_INSPECT_RESULT.
		const reboundRevision = "b".repeat(64);
		const second = bridge.inspectProject();
		const secondRequest = JSON.parse(await client.receive());
		assert.equal(secondRequest.expected_revision_id, REVISION);
		client.send({
			type: "bridge_result",
			id: secondRequest.id,
			request_id: secondRequest.request_id,
			result: { revision: reboundRevision, snapshot: SNAPSHOT },
		});
		const rebound = await second;
		assert.equal(rebound.revision, reboundRevision);
		assert.equal(bridge.revisionId, reboundRevision);

		// A following stage_scene is issued against the rebound revision.
		const staging = bridge.stageScene(
			{
				schema_version: 1,
				expected_revision_id: bridge.revisionId,
				operations: [
					{
						op: "add_primitive",
						entity_id: "356ae9c2-9cc1-4541-8e8e-a6d759b4df64",
						primitive_type: "CUBE",
						name: "Cube",
						location: [0, 0, 0],
						rotation: [0, 0, 0],
						scale: [1, 1, 1],
					},
				],
			},
			{ reportProgress: () => {} },
		);
		const stageRequest = JSON.parse(await client.receive());
		assert.equal(stageRequest.method, "stage_scene");
		assert.equal(stageRequest.expected_revision_id, reboundRevision);
		client.send({
			type: "bridge_error",
			id: stageRequest.id,
			request_id: stageRequest.request_id,
			code: "MUTATION_FAILED",
			message: "test stops before the prepared transaction",
			retryable: false,
		});
		await assert.rejects(staging, /MUTATION_FAILED/);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("inspectProject still rejects a malformed inspection result", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		const inspecting = bridge.inspectProject();
		const request = JSON.parse(await client.receive());
		client.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: { revision: "not-a-hash", snapshot: SNAPSHOT },
		});
		await assert.rejects(inspecting, /INVALID_INSPECT_RESULT/);
		assert.equal(bridge.revisionId, "0".repeat(64));
	} finally {
		client.close();
		await bridge.close();
	}
});
test("concurrent bridge operations serialize FIFO: the second request is only sent after the first result", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		const first = bridge.inspectProject();
		const second = bridge.inspectEntity(PROJECT_ID, { scope: "all" });
		const firstRequest = JSON.parse(await client.receive());
		assert.equal(firstRequest.type, "bridge_request");
		assert.equal(firstRequest.method, "inspect_project");

		// The queued inspect_entity must not reach the wire while the first
		// operation is still in flight (previously this rejected with BUSY).
		const secondWire = client.receive();
		const beforeFirstResult = await Promise.race([
			secondWire,
			new Promise((resolve) => setTimeout(() => resolve("NOT_SENT"), 50)),
		]);
		assert.equal(beforeFirstResult, "NOT_SENT");

		client.send({
			type: "bridge_result",
			id: firstRequest.id,
			request_id: firstRequest.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		const firstResult = await first;
		assert.equal(firstResult.revision, REVISION);

		const secondRequest = JSON.parse(await secondWire);
		assert.equal(secondRequest.type, "bridge_request");
		assert.equal(secondRequest.method, "inspect_entity");
		assert.deepEqual(secondRequest.params, { entity_id: PROJECT_ID, scope: "all" });
		// Dispatch-time revision resolution: the second request binds the
		// revision adopted from the first result, not the bootstrap revision
		// that was current when it was enqueued.
		assert.equal(secondRequest.expected_revision_id, REVISION);
		client.send({
			type: "bridge_result",
			id: secondRequest.id,
			request_id: secondRequest.request_id,
			result: { revision: REVISION, entity_id: PROJECT_ID, scope: "all", detail: { name: "Cube" } },
		});
		const secondResult = await second;
		assert.equal(secondResult.revision, REVISION);
		assert.deepEqual(secondResult.detail, { name: "Cube" });
	} finally {
		client.close();
		await bridge.close();
	}
});

test("a queued operation cancelled before dispatch is dequeued without touching the wire", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		const first = bridge.inspectProject();
		const controller = new AbortController();
		const queued = bridge.stageScene(
			{
				schema_version: 1,
				expected_revision_id: "0".repeat(64),
				operations: [
					{
						op: "add_primitive",
						entity_id: "356ae9c2-9cc1-4541-8e8e-a6d759b4df64",
						primitive_type: "CUBE",
						name: "Cube",
						location: [0, 0, 0],
						rotation: [0, 0, 0],
						scale: [1, 1, 1],
					},
				],
			},
			{ signal: controller.signal, reportProgress: () => {} },
		);
		const firstRequest = JSON.parse(await client.receive());
		assert.equal(firstRequest.method, "inspect_project");

		// Abort while the stage_scene is still queued behind the inspect.
		controller.abort();
		await assert.rejects(queued, /CANCELLED: bridge operation cancelled/);

		client.send({
			type: "bridge_result",
			id: firstRequest.id,
			request_id: firstRequest.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		await first;

		// The cancelled stage_scene never hits the wire; the next frame the
		// client sees is the follow-up inspect, proving the queue advanced.
		const wire = client.receive();
		const afterFirstResult = await Promise.race([
			wire,
			new Promise((resolve) => setTimeout(() => resolve("NOT_SENT"), 50)),
		]);
		assert.equal(afterFirstResult, "NOT_SENT");

		const followUp = bridge.inspectProject();
		const followUpRequest = JSON.parse(await wire);
		assert.equal(followUpRequest.type, "bridge_request");
		assert.equal(followUpRequest.method, "inspect_project");
		client.send({
			type: "bridge_result",
			id: followUpRequest.id,
			request_id: followUpRequest.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		assert.equal((await followUp).revision, REVISION);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("a queued read dispatched after a rebind carries the rebound expected_revision_id", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		// Bind the bridge to the initial durable revision.
		const bind = bridge.inspectProject();
		const bindRequest = JSON.parse(await client.receive());
		client.send({
			type: "bridge_result",
			id: bindRequest.id,
			request_id: bindRequest.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		await bind;
		assert.equal(bridge.revisionId, REVISION);

		// Enqueue two reads back to back: both are queued while the bridge is
		// still bound to REVISION.
		const reboundRevision = "c".repeat(64);
		const first = bridge.inspectProject();
		const second = bridge.inspectEntity(PROJECT_ID, { scope: "all" });

		const firstRequest = JSON.parse(await client.receive());
		assert.equal(firstRequest.method, "inspect_project");
		assert.equal(firstRequest.expected_revision_id, REVISION);
		// The addon rebinds to a different durable truth in the first result.
		client.send({
			type: "bridge_result",
			id: firstRequest.id,
			request_id: firstRequest.request_id,
			result: { revision: reboundRevision, snapshot: SNAPSHOT },
		});
		assert.equal((await first).revision, reboundRevision);

		// The second read resolves its expected revision at dispatch time, so
		// its wire request carries the rebound revision, not the revision that
		// was current when it was enqueued.
		const secondRequest = JSON.parse(await client.receive());
		assert.equal(secondRequest.method, "inspect_entity");
		assert.equal(secondRequest.expected_revision_id, reboundRevision);
		client.send({
			type: "bridge_result",
			id: secondRequest.id,
			request_id: secondRequest.request_id,
			result: { revision: reboundRevision, entity_id: PROJECT_ID, scope: "all", detail: { name: "Cube" } },
		});
		assert.equal((await second).revision, reboundRevision);
	} finally {
		client.close();
		await bridge.close();
	}
});
test("a hello missing the cclay.addon_version capability is refused with ADDON_STALE", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		const attach = bridge.waitForAttach();
		client.hello(PROJECT_ID, ["mutation_bridge_v2", "scene_manifest_v3", "transaction_commit_v2"]);
		await assert.rejects(
			attach,
			/ADDON_STALE.*reported no version \(pre-surface add-on is loaded\).*close Blender and run cclay again/s,
		);
		assert.match(bridge.attachFailure ?? "", /^ADDON_STALE/);
		assert.equal(bridge.attached, false);
		// A later waiter fails immediately instead of hanging forever.
		await assert.rejects(bridge.waitForAttach(), /ADDON_STALE/);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("a hello reporting a version that differs from the repo manifest is refused with ADDON_STALE", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		const attach = bridge.waitForAttach();
		client.hello(PROJECT_ID, surfaceCapabilities("0.0.1"));
		await assert.rejects(
			attach,
			new RegExp(
				`ADDON_STALE: Blender add-on v0\\.0\\.1 does not match repo v${REPO_ADDON_VERSION?.replaceAll(".", "\\.")}`,
			),
		);
		// Bridge tool calls surface the same single actionable line.
		await assert.rejects(bridge.inspectProject(), /ADDON_STALE.*close Blender and run cclay again/s);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("a hello missing a required method or op capability is refused with ADDON_STALE", async () => {
	const cases = [
		{ dropped: "cclay.method.capture_viewport", expected: /ADDON_STALE.*method capture_viewport/s },
		{ dropped: "cclay.op.transform_entity", expected: /ADDON_STALE.*op transform_entity/s },
	];
	for (const { dropped, expected } of cases) {
		const bridge = new BlenderBridge();
		const endpoint = await bridge.start();
		const client = new MockBlenderClient();
		try {
			await client.connect(endpoint.port, endpoint.token);
			const attach = bridge.waitForAttach();
			client.hello(
				PROJECT_ID,
				surfaceCapabilities().filter((capability) => capability !== dropped),
			);
			await assert.rejects(attach, expected);
			assert.equal(bridge.attached, false);
		} finally {
			client.close();
			await bridge.close();
		}
	}
});

test("a matching surface attaches after a refused stale attach and clears attachFailure", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const stale = new MockBlenderClient();
	const fresh = new MockBlenderClient();
	try {
		await stale.connect(endpoint.port, endpoint.token);
		const staleAttach = bridge.waitForAttach();
		stale.hello(PROJECT_ID, surfaceCapabilities("0.0.1"));
		await assert.rejects(staleAttach, /ADDON_STALE/);
		stale.close();

		await fresh.connect(endpoint.port, endpoint.token);
		fresh.hello(PROJECT_ID);
		const ack = JSON.parse(await fresh.receive());
		assert.equal(ack.type, "hello_ack");
		await bridge.waitForAttach();
		assert.equal(bridge.attached, true);
		assert.equal(bridge.attachFailure, undefined);
	} finally {
		fresh.close();
		await bridge.close();
	}
});

test("an attached bridge exposes the add-on version the peer reported", async () => {
	// The TUI footer shows this next to the project id, so a stale add-on is
	// visible without reading the manifest or trusting the repo constant.
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		assert.equal(bridge.attachedAddonVersion, undefined);
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await bridge.waitForAttach();
		assert.equal(bridge.attached, true);
		assert.equal(bridge.attachedAddonVersion, REPO_ADDON_VERSION);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("a refused stale attach never records the rejected add-on version", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		const attach = bridge.waitForAttach();
		client.hello(PROJECT_ID, surfaceCapabilities("0.0.1"));
		await assert.rejects(attach, /ADDON_STALE/);
		assert.equal(bridge.attachedAddonVersion, undefined);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("expectedAddonVersion fails loudly when the manifest is unreadable or versionless", async () => {
	// Missing manifest (extension running outside the repo layout): the read
	// error propagates instead of degrading into a silent version-check skip.
	assert.throws(() =>
		expectedAddonVersion(new URL("file:///nonexistent-cclay-repo/blender_manifest.toml")),
	);
	const dir = await mkdtemp(path.join(tmpdir(), "cclay-manifest-"));
	try {
		// Readable manifest without a version line: same loud failure.
		const versionless = path.join(dir, "blender_manifest.toml");
		await writeFile(versionless, 'id = "cclay"\n');
		assert.throws(
			() => expectedAddonVersion(pathToFileURL(versionless)),
			/blender_manifest\.toml yielded no add-on version/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	// Default path stays anchored to repo truth (module init uses this loader).
	assert.equal(expectedAddonVersion(), REPO_ADDON_VERSION);
});

test("a finalize failure settles the render as a coded error and the queue advances", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	const project = await mkdtemp(path.join(tmpdir(), "cclay-extension-finalize-"));
	const bridge = new BlenderBridge(project);
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		const inspect = bridge.inspectProject();
		const inspectRequest = JSON.parse(await client.receive());
		client.send({
			type: "bridge_result",
			id: inspectRequest.id,
			request_id: inspectRequest.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		await inspect;

		// Declare one artifact but stream no chunks: finalizeRenderResult's
		// artifact-integrity check throws after the bridge_result arrives.
		const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9]);
		const sha256 = createHash("sha256").update(png).digest("hex");
		const rendering = bridge.renderQaFrames(
			{ schema_version: 1, revision_id: REVISION, frames: [1] },
			{ reportProgress: () => {} },
		);
		const request = JSON.parse(await client.receive());
		client.send({
			type: "bridge_artifact_batch_begin",
			id: request.id,
			request_id: request.request_id,
			frames: [{ frame: 1, total_chunks: 1, total_byte_length: png.length, sha256 }],
		});
		client.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: {
				schema_version: 1,
				revision_id: REVISION,
				profile_version: "cclay-qa-png-v1",
				frames: [{
					frame: 1,
					width: 640,
					height: 360,
					profile_version: "cclay-qa-png-v1",
					byte_length: png.length,
					sha256,
					thumbnail: {
						mime_type: "image/jpeg",
						data_base64: Buffer.from("jpeg-thumbnail-payload").toString("base64"),
						width: 256,
						height: 144,
					},
				}],
			},
		});
		// The caller sees a normal coded tool error, not a hung promise.
		await assert.rejects(rendering, /INVALID_RENDER_QA_RESULT: artifact chunks are incomplete/);

		// The FIFO queue is not wedged: a follow-up op reaches the wire and resolves.
		const followUp = bridge.inspectProject();
		const followUpRequest = JSON.parse(await client.receive());
		assert.equal(followUpRequest.type, "bridge_request");
		assert.equal(followUpRequest.method, "inspect_project");
		client.send({
			type: "bridge_result",
			id: followUpRequest.id,
			request_id: followUpRequest.request_id,
			result: { revision: REVISION, snapshot: SNAPSHOT },
		});
		assert.equal((await followUp).revision, REVISION);

		// The rejection was delivered to the caller, never to the process.
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		client.close();
		await bridge.close();
		await rm(project, { recursive: true, force: true });
	}
});

test("a silent addon is reaped by the extension-side deadline and the next op dispatches", async () => {
	const bridge = new BlenderBridge(process.cwd(), { operationTimeoutMs: 150 });
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		const wedged = bridge.inspectProject();
		const wedgedRequest = JSON.parse(await client.receive());
		assert.equal(wedgedRequest.type, "bridge_request");
		assert.equal(wedgedRequest.method, "inspect_project");
		// The mock addon stays connected but never replies; the local
		// deadline reaps the operation instead of stalling the queue forever.
		await assert.rejects(wedged, /DEADLINE_EXCEEDED: bridge operation exceeded its deadline/);

		// The queue advanced: the next queued op reaches the wire and resolves.
		const next = bridge.inspectEntity(PROJECT_ID, { scope: "all" });
		const nextRequest = JSON.parse(await client.receive());
		assert.equal(nextRequest.method, "inspect_entity");
		client.send({
			type: "bridge_result",
			id: nextRequest.id,
			request_id: nextRequest.request_id,
			result: { revision: REVISION, entity_id: PROJECT_ID, scope: "all", detail: { name: "Cube" } },
		});
		assert.equal((await next).revision, REVISION);
	} finally {
		client.close();
		await bridge.close();
	}
});

// inspect_entity param projection + result guards (story G002: bound the
// inspect_entity animation payload). The mock add-on here is the same
// MockBlenderClient used by the rest of this file; only the inspect_entity
// params/result shape are exercised.
const INSPECT_ENTITY_ID = "356ae9c2-9cc1-4541-8e8e-a6d759b4df64";

test("inspect_entity: projects only entity_id, scope, and defined narrowing params onto the wire (a rogue entity_id and extra options key never reach the add-on)", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		// The caller's options object carries an extra `bogus` key and a rogue
		// `entity_id` that must NOT shadow the argument. The closed projection
		// drops both before the wire.
		const inspecting = bridge.inspectEntity(INSPECT_ENTITY_ID, {
			scope: "animation",
			data_path_filter: "LeftFoot",
			frame_start: 12,
			frame_end: 48,
			// Deliberate caller-side skew: an extra key and a rogue entity_id that
			// must not reach the wire or override the argument. One excess-property
			// error covers the whole literal.
			// @ts-expect-error -- InspectEntityOptions has neither key
			bogus: "should-not-leak",
			entity_id: "00000000-0000-4000-8000-000000000000",
		});
		const request = JSON.parse(await client.receive());
		assert.equal(request.type, "bridge_request");
		assert.equal(request.method, "inspect_entity");
		assert.deepEqual(request.params, {
			entity_id: INSPECT_ENTITY_ID,
			scope: "animation",
			data_path_filter: "LeftFoot",
			frame_start: 12,
			frame_end: 48,
		});
		// No undefined narrowing keys and no leaked fields on the wire.
		assert.equal("bogus" in request.params, false);

		client.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: { revision: REVISION, entity_id: INSPECT_ENTITY_ID, scope: "animation", detail: { bones: [] } },
		});
		const result = await inspecting;
		assert.equal(result.revision, REVISION);
		assert.equal(result.entity_id, INSPECT_ENTITY_ID);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("inspect_entity: refuses frame_start > frame_end locally with INVALID_INSPECT_ENTITY_REQUEST and never hits the wire", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		const inspecting = bridge.inspectEntity(INSPECT_ENTITY_ID, {
			scope: "animation",
			frame_start: 48,
			frame_end: 12,
		});
		await assert.rejects(inspecting, /INVALID_INSPECT_ENTITY_REQUEST: frame_start \(48\) must be <= frame_end \(12\)/);

		// The refusal is local: no bridge_request frame is sent for the
		// inverted range (the queue must not have dispatched it).
		const wire = client.receive();
		const beforeTimeout = await Promise.race([
			wire,
			new Promise((resolve) => setTimeout(() => resolve("NOT_SENT"), 50)),
		]);
		assert.equal(beforeTimeout, "NOT_SENT");
	} finally {
		client.close();
		await bridge.close();
	}
});

test("inspect_entity: refuses a result whose detail payload exceeds the 64 KiB ceiling", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		const inspecting = bridge.inspectEntity(INSPECT_ENTITY_ID, { scope: "animation" });
		const request = JSON.parse(await client.receive());
		assert.equal(request.method, "inspect_entity");

		// Build an oversized detail payload: a 70 KiB blob serializes well past
		// the 65536-byte ceiling, so the bridge must refuse it before it can
		// reach the model context window.
		const oversized = "x".repeat(70 * 1024);
		client.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: {
				revision: REVISION,
				entity_id: INSPECT_ENTITY_ID,
				scope: "animation",
				detail: { animationSummary: { blob: oversized } },
			},
		});
		await assert.rejects(inspecting, /INVALID_INSPECT_ENTITY_RESULT: detail payload exceeds the 64 KiB ceiling \(\d+ bytes\)/);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("inspect_entity: refuses a result missing entity_id, scope, or object detail", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		client.hello(PROJECT_ID);
		await client.receive(); // hello_ack
		await bridge.waitForAttach();

		const inspecting = bridge.inspectEntity(INSPECT_ENTITY_ID, { scope: "all" });
		const request = JSON.parse(await client.receive());
		// Valid revision but the envelope is wrong: detail is not an object.
		client.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: { revision: REVISION, entity_id: INSPECT_ENTITY_ID, scope: "all", detail: "not-an-object" },
		});
		await assert.rejects(inspecting, /INVALID_INSPECT_ENTITY_RESULT: bridge did not return entity_id, scope, and object detail/);
	} finally {
		client.close();
		await bridge.close();
	}
});
test("inspect_entity: accepts a result at exactly the ceiling and refuses one byte more", async () => {
	// The add-on reduces to at most 65536 bytes over this same envelope, so the
	// boundary has to be inclusive on the add-on's side or a legitimately
	// reduced result would be thrown away after the work was done.
	for (const [label, delta, expectAccepted] of [
		["at the ceiling", 0, true],
		["one byte over", 1, false],
	] as const) {
		const bridge = new BlenderBridge();
		const endpoint = await bridge.start();
		const client = new MockBlenderClient();
		try {
			await client.connect(endpoint.port, endpoint.token);
			client.hello(PROJECT_ID);
			await client.receive(); // hello_ack
			await bridge.waitForAttach();

			const inspecting = bridge.inspectEntity(INSPECT_ENTITY_ID, { scope: "animation" });
			const request = JSON.parse(await client.receive());
			const envelope = {
				revision: REVISION,
				entity_id: INSPECT_ENTITY_ID,
				scope: "animation",
				detail: { blob: "" },
			};
			const overhead = Buffer.byteLength(JSON.stringify(envelope), "utf8");
			envelope.detail.blob = "x".repeat(65536 - overhead + delta);
			assert.equal(Buffer.byteLength(JSON.stringify(envelope), "utf8"), 65536 + delta, label);
			client.send({
				type: "bridge_result",
				id: request.id,
				request_id: request.request_id,
				result: envelope,
			});
			if (expectAccepted) {
				const result = await inspecting;
				assert.equal(result.entity_id, INSPECT_ENTITY_ID);
			} else {
				await assert.rejects(inspecting, /exceeds the 64 KiB ceiling/);
			}
		} finally {
			client.close();
			await bridge.close();
		}
	}
});

test("inspect_entity: refuses a result bound to another entity or scope", async () => {
	for (const [label, entityId, scope] of [
		["another entity", "11111111-1111-4111-8111-111111111111", "animation"],
		["another scope", INSPECT_ENTITY_ID, "material"],
	] as const) {
		const bridge = new BlenderBridge();
		const endpoint = await bridge.start();
		const client = new MockBlenderClient();
		try {
			await client.connect(endpoint.port, endpoint.token);
			client.hello(PROJECT_ID);
			await client.receive(); // hello_ack
			await bridge.waitForAttach();

			const inspecting = bridge.inspectEntity(INSPECT_ENTITY_ID, { scope: "animation" });
			const request = JSON.parse(await client.receive());
			client.send({
				type: "bridge_result",
				id: request.id,
				request_id: request.request_id,
				result: {
					revision: REVISION,
					entity_id: entityId,
					scope,
					detail: { name: "Rig" },
				},
			});
			await assert.rejects(inspecting, /result binds .*, not the requested/, label);
		} finally {
			client.close();
			await bridge.close();
		}
	}
});
