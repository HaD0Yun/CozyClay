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

test("renderQaFrames validates streamed bytes, publishes them, and returns model-visible PNG content", async () => {
	const project = await mkdtemp(path.join(tmpdir(), "omb-extension-render-"));
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
				profile_version: "omb-qa-png-v1",
				frames: [{
					frame: 1,
					width: 640,
					height: 360,
					profile_version: "omb-qa-png-v1",
					byte_length: png.length,
					sha256,
					image: { mime_type: "image/png", data_base64: png.toString("base64") },
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
		assert.equal(result.frames[0]?.uri, `omb-artifact://sha256/${sha256}`);
		assert.deepEqual(
			await readFile(path.join(project, ".omb", "artifacts", "sha256", `${sha256}.png`)),
			png,
		);
	} finally {
		client.close();
		await bridge.close();
		await rm(project, { recursive: true, force: true });
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
		const second = bridge.inspectEntity(PROJECT_ID, "all");
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
			result: { revision: REVISION, entity: { name: "Cube" } },
		});
		const secondResult = await second;
		assert.equal(secondResult.revision, REVISION);
		assert.deepEqual(secondResult.entity, { name: "Cube" });
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
		const second = bridge.inspectEntity(PROJECT_ID, "all");

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
			result: { revision: reboundRevision, entity: { name: "Cube" } },
		});
		assert.equal((await second).revision, reboundRevision);
	} finally {
		client.close();
		await bridge.close();
	}
});
test("a hello missing the omb.addon_version capability is refused with ADDON_STALE", async () => {
	const bridge = new BlenderBridge();
	const endpoint = await bridge.start();
	const client = new MockBlenderClient();
	try {
		await client.connect(endpoint.port, endpoint.token);
		const attach = bridge.waitForAttach();
		client.hello(PROJECT_ID, ["mutation_bridge_v2", "scene_manifest_v3", "transaction_commit_v2"]);
		await assert.rejects(
			attach,
			/ADDON_STALE.*reported no version \(pre-surface add-on is loaded\).*close Blender and run omb again/s,
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
		await assert.rejects(bridge.inspectProject(), /ADDON_STALE.*close Blender and run omb again/s);
	} finally {
		client.close();
		await bridge.close();
	}
});

test("a hello missing a required method or op capability is refused with ADDON_STALE", async () => {
	const cases = [
		{ dropped: "omb.method.capture_viewport", expected: /ADDON_STALE.*method capture_viewport/s },
		{ dropped: "omb.op.transform_entity", expected: /ADDON_STALE.*op transform_entity/s },
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

test("expectedAddonVersion fails loudly when the manifest is unreadable or versionless", async () => {
	// Missing manifest (extension running outside the repo layout): the read
	// error propagates instead of degrading into a silent version-check skip.
	assert.throws(() =>
		expectedAddonVersion(new URL("file:///nonexistent-omb-repo/blender_manifest.toml")),
	);
	const dir = await mkdtemp(path.join(tmpdir(), "omb-manifest-"));
	try {
		// Readable manifest without a version line: same loud failure.
		const versionless = path.join(dir, "blender_manifest.toml");
		await writeFile(versionless, 'id = "oh_my_blender"\n');
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
	const project = await mkdtemp(path.join(tmpdir(), "omb-extension-finalize-"));
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
				profile_version: "omb-qa-png-v1",
				frames: [{
					frame: 1,
					width: 640,
					height: 360,
					profile_version: "omb-qa-png-v1",
					byte_length: png.length,
					sha256,
					image: { mime_type: "image/png", data_base64: png.toString("base64") },
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
		const next = bridge.inspectEntity(PROJECT_ID, "all");
		const nextRequest = JSON.parse(await client.receive());
		assert.equal(nextRequest.method, "inspect_entity");
		client.send({
			type: "bridge_result",
			id: nextRequest.id,
			request_id: nextRequest.request_id,
			result: { revision: REVISION, entity: { name: "Cube" } },
		});
		assert.equal((await next).revision, REVISION);
	} finally {
		client.close();
		await bridge.close();
	}
});