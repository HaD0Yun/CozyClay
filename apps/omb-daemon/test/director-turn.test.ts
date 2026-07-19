import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import net, { type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createDirectorTurnHandler,
	DirectorLoopContractError,
	type CameraPlanRevisionStore,
} from "@oh-my-blender/director-runtime";
import {
	buildSceneManifestV3Revision,
	type DirectorProject,
} from "@oh-my-blender/director-core";
import {
	parseSceneManifestV2,
	parseSceneSnapshot,
	type CameraPlanV1,
	type StageScenePlanV1,
} from "@oh-my-blender/protocol";
import { createBootRuntime } from "../src/boot.ts";
import { start, type Daemon, type DirectorTurnService, type DirectorTurnToolEvent } from "../src/daemon.ts";

const PARENT_REVISION = "a".repeat(64);
const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
	"base64",
);
const PNG_DIGEST = createHash("sha256").update(PNG_BYTES).digest("hex");
const websocketKey = "AAAAAAAAAAAAAAAAAAAAAA==";
const nonce = () => Buffer.from(randomUUID()).subarray(0, 16).toString("base64url");

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
	readonly messageByteLengths: number[] = [];
	readonly socket: Socket;
	private buffer = Buffer.alloc(0);

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk) => this.read(chunk));
	}

	send(value: unknown): void {
		this.socket.write(frame(value));
	}

	async next(predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 5_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const value = this.messages.find(predicate);
			if (value !== undefined) return value;
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		throw new Error("message timeout");
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
			} else if (length === 127) {
				if (this.buffer.length < 10) return;
				length = Number(this.buffer.readBigUInt64BE(2));
				offset = 10;
			}
			if (this.buffer.length < offset + length) return;
			const opcode = this.buffer[0]! & 15;
			const payload = this.buffer.subarray(offset, offset + length);
			this.buffer = this.buffer.subarray(offset + length);
			if (opcode === 1) {
				this.messageByteLengths.push(payload.byteLength);
				this.messages.push(JSON.parse(payload.toString()) as Record<string, unknown>);
			}
		}
	}
}

async function connect(port: number, credential: string, role: "controller" | "bridge"): Promise<Client> {
	return new Promise((resolve, reject) => {
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

async function attachController(daemon: Daemon, credential = daemon.startup.bearer_token) {
	const client = await connect(daemon.port, credential, "controller");
	client.send({
		type: "hello",
		protocol: 1,
		addon_version: "controller-test",
		blender_version: "n/a",
		project_id: randomUUID(),
		client_nonce: nonce(),
	});
	const hello = await client.next((message) => message.type === "hello_ack");
	const auth = await client.next((message) => message.type === "controller_auth");
	return { client, hello, resumeToken: auth.resume_token as string };
}

async function attachBridge(daemon: Daemon, controller: Client) {
	controller.send({ type: "issue_attach_ticket", role: "bridge" });
	const ticket = await controller.next((message) => message.type === "attach_ticket");
	const bridge = await connect(daemon.port, ticket.ticket as string, "bridge");
	bridge.send({
		type: "hello",
		protocol: 2,
		addon_version: "bridge-test",
		blender_version: "4.3",
		project_id: randomUUID(),
		client_nonce: nonce(),
		capabilities: ["mutation_bridge_v2", "scene_manifest_v3"],
	});
	await bridge.next((message) => message.type === "hello_ack");
	return bridge;
}

test("a faux AgentSession completes a deterministic director turn over real controller and bridge sockets", async () => {
	const root = await mkdtemp(join(tmpdir(), "omb-director-e2e-"));
	const runtime = await createBootRuntime({ port: 0, mode: "faux" });
	const snapshot = parseSceneSnapshot(
		JSON.parse(
			await readFile(
				new URL("../../../packages/blender-protocol/test/fixtures/blender-exported-snapshot.json", import.meta.url),
				"utf8",
			),
		),
	);
	const v2 = parseSceneManifestV2(
		JSON.parse(
			await readFile(
				new URL("../../../packages/director-core/test/fixtures/scene-manifest-v2-parity.json", import.meta.url),
				"utf8",
			),
		),
	);
	let project: DirectorProject = {
		schema_version: 1,
		project_id: v2.projectId,
		current_revision_id: PARENT_REVISION,
		manifest: v2,
	};
	const store: CameraPlanRevisionStore = {
		readProject: async () => project,
		commitRevision: async (expectedRevisionId, child) => {
			assert.equal(project.current_revision_id, expectedRevisionId);
			project = child;
		},
	};
	const reservations = (declarations: readonly { readonly sha256: string; readonly byteLength: number }[]) =>
		Promise.resolve(
			declarations.map((declaration) => ({
				writeAt: async () => {},
				commit: async () => ({
					sha256: declaration.sha256,
					byteLength: declaration.byteLength,
					uri: `omb-artifact://sha256/${declaration.sha256}`,
				}),
				abort: async () => {},
			})),
		);
	const directorTurn = createDirectorTurnHandler({
		model: runtime.model,
		modelRuntime: runtime.modelRuntime,
		store,
		cwd: root,
	});
	let daemon = await start({
		port: 0,
		handlers: {},
		directorTurn,
		projectDirectory: root,
		beginArtifactReservations: reservations,
		stdout: () => {},
	});
	let control: Awaited<ReturnType<typeof attachController>> | undefined;
	let bridge: Client | undefined;
	try {
		control = await attachController(daemon);
		assert.deepEqual(control.hello.capabilities, ["inspect_project", "director_turn_v1", "director_transcript_v1"]);
		bridge = await attachBridge(daemon, control.client);
		const turnId = randomUUID();
		control.client.send({
			type: "director_turn",
			id: turnId,
			prompt: "Build a deterministic hero product shot.",
			expected_revision_id: "0".repeat(64),
			deadline_ms: 30_000,
		});

		const seenBridgeIds = new Set<string>();
		const methods: string[] = [];
		for (const method of ["inspect_project", "stage_scene", "inspect_project", "render_qa_frames", "apply_camera_plan"]) {
			const request: Record<string, unknown> = await bridge.next(
				(message) => message.type === "bridge_request" && !seenBridgeIds.has(message.id as string),
			);
			seenBridgeIds.add(request.id as string);
			methods.push(request.method as string);
			assert.equal(request.method, method);
			if (method === "inspect_project") {
				bridge.send({
					type: "bridge_result",
					id: request.id,
					request_id: turnId,
					result: {
						revision: request.expected_revision_id === "0".repeat(64) ? PARENT_REVISION : request.expected_revision_id,
						snapshot,
					},
				});
			} else if (method === "stage_scene") {
				const plan = request.params as StageScenePlanV1;
				const operation = plan.operations[0];
				assert.equal(operation?.op, "add_primitive");
				if (operation?.op !== "add_primitive") throw new Error("expected add_primitive");
				const { revisionId: _revisionId, sceneHash: _sceneHash, ...base } = v2;
				const manifest = buildSceneManifestV3Revision(
					{
						...base,
						schemaVersion: 3,
						objects: [
							...base.objects,
							{
								entityId: operation.entity_id,
								name: operation.name,
								type: "MESH",
								parentId: null,
								visible: true,
								location: operation.location,
								rotationQuaternion: [1, 0, 0, 0],
								scale: operation.scale,
							},
						],
						lights: [],
						stagePrimitives: [{ objectId: operation.entity_id, primitiveType: operation.primitive_type }],
						stageMaterials: [],
					},
					plan.expected_revision_id,
					plan,
				);
				bridge.send({
					type: "bridge_result",
					id: request.id,
					request_id: turnId,
					result: {
						expected_revision_id: plan.expected_revision_id,
						scene_hash: manifest.sceneHash,
						manifest,
						entity_identities: [{ entity_id: operation.entity_id, requested_name: operation.name, actual_name: operation.name }],
					},
				});
			} else if (method === "render_qa_frames") {
				bridge.send({
					type: "bridge_artifact_batch_begin",
					id: request.id,
					request_id: turnId,
					frames: [{ frame: 1, total_chunks: 1, total_byte_length: PNG_BYTES.length, sha256: PNG_DIGEST }],
				});
				bridge.send({
					type: "bridge_artifact_chunk",
					id: request.id,
					request_id: turnId,
					frame: 1,
					chunk_index: 0,
					total_chunks: 1,
					byte_offset: 0,
					byte_length: PNG_BYTES.length,
					data_base64: PNG_BYTES.toString("base64"),
				});
				bridge.send({
					type: "bridge_result",
					id: request.id,
					request_id: turnId,
					result: {
						schema_version: 1,
						revision_id: request.expected_revision_id,
						profile_version: "omb-qa-png-v1",
						frames: [{
							frame: 1,
							width: 640,
							height: 360,
							profile_version: "omb-qa-png-v1",
							byte_length: PNG_BYTES.length,
							sha256: PNG_DIGEST,
							image: { mime_type: "image/png", data_base64: PNG_BYTES.toString("base64") },
						}],
					},
				});
			} else {
				const plan = request.params as CameraPlanV1;
				const currentManifest = project.manifest as ReturnType<typeof buildSceneManifestV3Revision>;
				const { revisionId: _revisionId, sceneHash: _sceneHash, ...base } = currentManifest;
				const manifest = buildSceneManifestV3Revision(base, plan.expected_revision_id, plan);
				bridge.send({
					type: "bridge_result",
					id: request.id,
					request_id: turnId,
					result: { expected_revision_id: plan.expected_revision_id, scene_hash: manifest.sceneHash, manifest },
				});
			}
		}

		const completed = await control.client.next(
			(message) => message.type === "director_turn_completed" && message.id === turnId,
		);
		assert.deepEqual(methods, ["inspect_project", "stage_scene", "inspect_project", "render_qa_frames", "apply_camera_plan"]);
		assert.equal(completed.resulting_revision_id, project.current_revision_id);
		const toolStarts = control.client.messages.filter(
			(message) => message.type === "director_tool_call_started" && message.id === turnId,
		);
		assert.deepEqual(toolStarts.map((message) => message.tool_name), methods);

		const fetchId = randomUUID();
		control.client.send({ type: "director_transcript_request", id: fetchId, cursor: 0, page_size: 64 });
		const liveTranscript = await control.client.next(
			(message) => message.type === "director_transcript" && message.id === fetchId,
		);
		assert.equal((liveTranscript.events as unknown[]).length, 12);
		const firstSessionId = liveTranscript.session_id;

		bridge.socket.destroy();
		control.client.socket.destroy();
		await daemon.close();
		daemon = await start({ port: 0, handlers: {}, projectDirectory: root, stdout: () => {} });
		const resumed = await attachController(daemon);
		try {
			const resumedFetchId = randomUUID();
			resumed.client.send({
				type: "director_transcript_request",
				id: resumedFetchId,
				cursor: 0,
				page_size: 64,
			});
			const resumedTranscript = await resumed.client.next(
				(message) => message.type === "director_transcript" && message.id === resumedFetchId,
			);
			assert.equal(resumedTranscript.session_id, firstSessionId);
			assert.deepEqual(resumedTranscript.events, liveTranscript.events);
		} finally {
			resumed.client.socket.destroy();
		}
	} finally {
		bridge?.socket.destroy();
		control?.client.socket.destroy();
		await daemon.close();
		await runtime.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
test("bridge transport accepts QA payloads large enough for the daemon image-content cap", async () => {
	const root = await mkdtemp(join(tmpdir(), "omb-director-qa-cap-"));
	const daemon = await start({
		port: 0,
		projectDirectory: root,
		stdout: () => {},
		handlers: {
			render: async (_params, { renderQaFrames, signal }) => ({
				result: await renderQaFrames(
					{ schema_version: 1, revision_id: PARENT_REVISION, frames: [1] },
					{ signal, reportProgress: () => {} },
				),
				resulting_revision_id: PARENT_REVISION,
			}),
		},
	});
	let control: Awaited<ReturnType<typeof attachController>> | undefined;
	let bridge: Client | undefined;
	try {
		control = await attachController(daemon);
		bridge = await attachBridge(daemon, control.client);
		const requestId = randomUUID();
		control.client.send({
			type: "request",
			id: requestId,
			method: "render",
			params: {},
			expected_revision_id: PARENT_REVISION,
			deadline_ms: 30_000,
		});
		const request = await bridge.next(
			(message) => message.type === "bridge_request" && message.request_id === requestId,
		);
		const bytes = Buffer.concat([
			Buffer.from("89504e470d0a1a0a", "hex"),
			Buffer.alloc(2 * 1024 * 1024),
		]);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		bridge.send({
			type: "bridge_result",
			id: request.id,
			request_id: requestId,
			result: {
				schema_version: 1,
				revision_id: PARENT_REVISION,
				profile_version: "omb-qa-png-v1",
				frames: [{
					frame: 1,
					width: 640,
					height: 360,
					profile_version: "omb-qa-png-v1",
					byte_length: bytes.byteLength,
					sha256,
					image: { mime_type: "image/png", data_base64: bytes.toString("base64") },
				}],
			},
		});
		const error = await control.client.next(
			(message) => message.type === "error" && message.id === requestId,
			10_000,
		);
		assert.equal(error.code, "RENDER_QA_IMAGE_CONTENT_LIMIT");
	} finally {
		bridge?.socket.destroy();
		control?.client.socket.destroy();
		await daemon.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("director turns reuse top-level cancel and persist one cancelled terminal event", async () => {
	const root = await mkdtemp(join(tmpdir(), "omb-director-cancel-"));
	let running = false;
	const daemon = await start({
		port: 0,
		handlers: {},
		projectDirectory: root,
		stdout: () => {},
		directorTurn: {
			run: async (_turn, context) => {
				if (running) throw new Error("DIRECTOR_LOOP_BUSY: cleanup is still active");
				running = true;
				try {
					if (_turn.prompt === "Complete immediately.") {
						return {
							summary: "Second turn completed.",
							resultingRevisionId: PARENT_REVISION,
							toolCallOrder: [],
						};
					}
					await new Promise<void>((_resolve, reject) => {
						const abort = () => {
							setTimeout(() => reject(new Error("aborted")), 25);
						};
						context.signal.addEventListener("abort", abort, { once: true });
						if (context.signal.aborted) abort();
					});
					throw new Error("unreachable");
				} finally {
					running = false;
				}
			},
			dispose: () => {},
			forceDispose() {
				return this;
			},
		},
	});
	let control: Awaited<ReturnType<typeof attachController>> | undefined;
	try {
		control = await attachController(daemon);
		const turnId = randomUUID();
		control.client.send({
			type: "director_turn",
			id: turnId,
			prompt: "Wait until cancelled.",
			expected_revision_id: PARENT_REVISION,
			deadline_ms: 30_000,
		});
		await control.client.next((message) => message.type === "director_turn_started" && message.id === turnId);
		control.client.send({ type: "cancel", id: turnId });
		const ack = await control.client.next((message) => message.type === "cancel_ack" && message.id === turnId);
		assert.equal(ack.status, "accepted");
		await control.client.next((message) => message.type === "director_turn_cancelled" && message.id === turnId);
		const secondTurnId = randomUUID();
		control.client.send({
			type: "director_turn",
			id: secondTurnId,
			prompt: "Complete immediately.",
			expected_revision_id: PARENT_REVISION,
			deadline_ms: 30_000,
		});
		const completed = await control.client.next(
			(message) => message.type === "director_turn_completed" && message.id === secondTurnId,
		);
		assert.equal(completed.summary, "Second turn completed.");
		assert.equal(
			control.client.messages.some(
				(message) =>
					message.id === secondTurnId &&
					message.type === "director_turn_failed" &&
					(message.code === "MODEL_PROVIDER_ERROR" || message.code === "DIRECTOR_LOOP_BUSY"),
			),
			false,
		);
		assert.equal(
			control.client.messages.some(
				(message) =>
					message.id === turnId &&
					(message.type === "director_turn_completed" || message.type === "director_turn_failed"),
			),
			false,
		);
	} finally {
		control?.client.socket.destroy();
		await daemon.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("a non-settling cancelled director turn is quarantined before the replacement runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "omb-director-quarantine-"));
	let settleWedged!: (result: {
		summary: string;
		resultingRevisionId: string;
		toolCallOrder: [];
	}) => void;
	let emitWedged!: (event: DirectorTurnToolEvent) => void;
	const replacement: DirectorTurnService = {
		run: async () => ({
			summary: "Replacement completed.",
			resultingRevisionId: PARENT_REVISION,
			toolCallOrder: [] as const,
		}),
		dispose: () => {},
		forceDispose() {
			return this;
		},
	};
	const wedged: DirectorTurnService = {
		run: async (_turn, _context, onToolEvent) =>
			await new Promise<{
				summary: string;
				resultingRevisionId: string;
				toolCallOrder: [];
			}>((resolve) => {
				settleWedged = resolve;
				emitWedged = onToolEvent;
			}),
		dispose: () => {},
		forceDispose: () => replacement,
	};
	const daemon = await start({
		port: 0,
		handlers: {},
		projectDirectory: root,
		stdout: () => {},
		directorTurn: wedged,
		directorTeardownTimeoutMs: 25,
	});
	let control: Awaited<ReturnType<typeof attachController>> | undefined;
	try {
		control = await attachController(daemon);
		const wedgedId = randomUUID();
		control.client.send({
			type: "director_turn",
			id: wedgedId,
			prompt: "Never settle.",
			expected_revision_id: PARENT_REVISION,
			deadline_ms: 30_000,
		});
		await control.client.next((message) => message.type === "director_turn_started" && message.id === wedgedId);
		control.client.send({ type: "cancel", id: wedgedId });
		await control.client.next((message) => message.type === "director_turn_cancelled" && message.id === wedgedId);

		const replacementId = randomUUID();
		control.client.send({
			type: "director_turn",
			id: replacementId,
			prompt: "Complete.",
			expected_revision_id: PARENT_REVISION,
			deadline_ms: 30_000,
		});
		const completed = await control.client.next(
			(message) => message.type === "director_turn_completed" && message.id === replacementId,
		);
		assert.equal(completed.summary, "Replacement completed.");

		const eventCount = control.client.messages.length;
		emitWedged({
			type: "started",
			toolName: "inspect_project",
			toolCallId: "late",
			paramsSummary: "late",
		});
		settleWedged({
			summary: "Late completion.",
			resultingRevisionId: PARENT_REVISION,
			toolCallOrder: [],
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(control.client.messages.length, eventCount);
	} finally {
		control?.client.socket.destroy();
		await daemon.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("transcript replay pages more than 1 MiB of history below the controller frame limit", async () => {
	const root = await mkdtemp(join(tmpdir(), "omb-director-paging-"));
	const events = Array.from({ length: 192 }, (_, sequence) => ({
		type: "director_turn_started",
		id: "00000000-0000-4000-8000-000000000001",
		sequence,
		at: "2026-07-19T18:00:00.000Z",
		prompt: "x".repeat(8_192),
	}));
	assert.ok(Buffer.byteLength(JSON.stringify(events)) > 1024 * 1024);
	await mkdir(join(root, ".omb"), { recursive: true });
	await writeFile(
		join(root, ".omb", "director-transcript.json"),
		JSON.stringify({
			schema_version: 1,
			session_id: "00000000-0000-4000-8000-000000000002",
			events,
		}),
		{ mode: 0o600 },
	);
	const daemon = await start({ port: 0, handlers: {}, projectDirectory: root, stdout: () => {} });
	let control: Awaited<ReturnType<typeof attachController>> | undefined;
	try {
		control = await attachController(daemon);
		const replayed: unknown[] = [];
		let cursor = 0;
		while (true) {
			const id = randomUUID();
			control.client.send({
				type: "director_transcript_request",
				id,
				cursor,
				page_size: 64,
			});
			const page = await control.client.next(
				(message) => message.type === "director_transcript" && message.id === id,
			);
			const messageIndex = control.client.messages.indexOf(page);
			assert.ok(control.client.messageByteLengths[messageIndex]! < 1024 * 1024);
			replayed.push(...(page.events as unknown[]));
			if (page.next_cursor === null) break;
			assert.ok(typeof page.next_cursor === "number" && page.next_cursor > cursor);
			cursor = page.next_cursor;
		}
		assert.deepEqual(replayed, events);
	} finally {
		control?.client.socket.destroy();
		await daemon.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("G013 untrusted provider failures are fixed before WebSocket and persistence sinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "omb-director-sentinel-"));
	const sentinel = "omb-provider-sentinel-DO-NOT-PERSIST";
	const daemon = await start({
		port: 0,
		handlers: {},
		projectDirectory: root,
		stdout: () => {},
		directorTurn: {
			run: async () => {
				throw new Error(`AUTH_ERROR: provider response Authorization: Bearer ${sentinel}`);
			},
			dispose: () => {},
			forceDispose() {
				return this;
			},
		},
	});
	let control: Awaited<ReturnType<typeof attachController>> | undefined;
	try {
		control = await attachController(daemon);
		const turnId = randomUUID();
		control.client.send({
			type: "director_turn",
			id: turnId,
			prompt: "Trigger an adversarial provider failure.",
			expected_revision_id: PARENT_REVISION,
			deadline_ms: 30_000,
		});
		const failed = await control.client.next(
			(message) => message.type === "director_turn_failed" && message.id === turnId,
		);
		assert.equal(failed.code, "MODEL_PROVIDER_ERROR");
		assert.equal(failed.message, "provider request failed");
		assert.doesNotMatch(JSON.stringify(control.client.messages), new RegExp(sentinel));
		const source = await readFile(join(root, ".omb", "director-transcript.json"), "utf8");
		assert.doesNotMatch(source, new RegExp(sentinel));
	} finally {
		control?.client.socket.destroy();
		await daemon.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("director loop contract violations surface their trusted fixed message, not MODEL_PROVIDER_ERROR", async () => {
	const root = await mkdtemp(join(tmpdir(), "omb-director-contract-"));
	const sentinel = "omb-loop-sentinel-DO-NOT-PERSIST";
	const daemon = await start({
		port: 0,
		handlers: {},
		projectDirectory: root,
		stdout: () => {},
		directorTurn: {
			run: async () => {
				throw new DirectorLoopContractError("DIRECTOR_LOOP_INCOMPLETE", `turn ended after mutation ${sentinel}`);
			},
			dispose: () => {},
			forceDispose() {
				return this;
			},
		},
	});
	let control: Awaited<ReturnType<typeof attachController>> | undefined;
	try {
		control = await attachController(daemon);
		const turnId = randomUUID();
		control.client.send({
			type: "director_turn",
			id: turnId,
			prompt: "Trigger a loop contract violation.",
			expected_revision_id: PARENT_REVISION,
			deadline_ms: 30_000,
		});
		const failed = await control.client.next(
			(message) => message.type === "director_turn_failed" && message.id === turnId,
		);
		assert.equal(failed.code, "DIRECTOR_LOOP_INCOMPLETE");
		assert.equal(failed.message, "director turn ended before its verification inspect");
		assert.doesNotMatch(JSON.stringify(control.client.messages), new RegExp(sentinel));
		const source = await readFile(join(root, ".omb", "director-transcript.json"), "utf8");
		assert.doesNotMatch(source, new RegExp(sentinel));
	} finally {
		control?.client.socket.destroy();
		await daemon.close();
		await rm(root, { recursive: true, force: true });
	}
});
