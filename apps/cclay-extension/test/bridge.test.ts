import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BlenderBridge } from "../src/bridge.ts";
import { FakeAddon, PROJECT_ID, REVISION, SNAPSHOT } from "./bridge-test-fixture.ts";

async function attached(timeout?: number) {
	const project = await mkdtemp(path.join(tmpdir(), "cclay-bridge-"));
	const addon = new FakeAddon(project);
	await addon.start();
	const bridge = new BlenderBridge(project, { projectId: PROJECT_ID, operationTimeoutMs: timeout });
	await bridge.start();
	await bridge.waitForAttach();
	return { project, addon, bridge };
}

async function bind(bridge: BlenderBridge, addon: FakeAddon, revision = REVISION): Promise<void> {
	const inspecting = bridge.inspectProject();
	const request = await addon.receive();
	addon.send({ type: "bridge_result", id: request.id, request_id: request.request_id, result: { revision, snapshot: SNAPSHOT } });
	await inspecting;
}

async function cleanup(project: string, addon: FakeAddon, bridge: BlenderBridge): Promise<void> {
	await bridge.close();
	await addon.stop();
	await rm(project, { recursive: true, force: true });
}

function stage(expected_revision_id: string) {
	return {
		schema_version: 1 as const,
		expected_revision_id,
		operations: [{ op: "add_character" as const, entity_id: PROJECT_ID, character_type: "Y_BOT" as const, name: "Character", location: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }],
	};
}

function renderResult(png: Buffer, sha256: string) {
	return { schema_version: 1, revision_id: REVISION, profile_version: "cclay-qa-png-v1", frames: [{ frame: 1, width: 640, height: 360, profile_version: "cclay-qa-png-v1", byte_length: png.length, sha256, thumbnail: { mime_type: "image/jpeg", data_base64: Buffer.from("thumbnail").toString("base64"), width: 1, height: 1 } }] };
}

test("framed bridge errors reject pending calls and malformed inspect results do not rebind", async () => {
	const { project, addon, bridge } = await attached();
	try {
		const errored = bridge.inspectProject();
		const errorRequest = await addon.receive();
		addon.send({ type: "bridge_error", id: errorRequest.id, request_id: errorRequest.request_id, code: "SCENE_UNAVAILABLE", message: "no scene", retryable: false });
		await assert.rejects(errored, /SCENE_UNAVAILABLE/);
		const malformed = bridge.inspectProject();
		const malformedRequest = await addon.receive();
		addon.send({ type: "bridge_result", id: malformedRequest.id, request_id: malformedRequest.request_id, result: { revision: "not-a-hash", snapshot: SNAPSHOT } });
		await assert.rejects(malformed, /INVALID_INSPECT_RESULT/);
		assert.equal(bridge.revisionId, "0".repeat(64));
	} finally { await cleanup(project, addon, bridge); }
});

test("framed inspect results rebind revisions and queued calls resolve revisions at dispatch", async () => {
	const { project, addon, bridge } = await attached();
	try {
		await bind(bridge, addon);
		const rebound = "b".repeat(64);
		const first = bridge.inspectProject();
		const second = bridge.inspectEntity(PROJECT_ID, { scope: "all" });
		const firstRequest = await addon.receive();
		addon.send({ type: "bridge_result", id: firstRequest.id, request_id: firstRequest.request_id, result: { revision: rebound, snapshot: SNAPSHOT } });
		await first;
		const secondRequest = await addon.receive();
		assert.equal(secondRequest.expected_revision_id, rebound);
		addon.send({ type: "bridge_result", id: secondRequest.id, request_id: secondRequest.request_id, result: { revision: rebound, entity_id: PROJECT_ID, scope: "all", detail: {} } });
		await second;
	} finally { await cleanup(project, addon, bridge); }
});

test("framed bridge serializes FIFO and removes queued cancellation", async () => {
	const { project, addon, bridge } = await attached();
	try {
		const first = bridge.inspectProject();
		const controller = new AbortController();
		const cancelled = bridge.stageScene(stage("0".repeat(64)), { signal: controller.signal, reportProgress() {} });
		const firstRequest = await addon.receive();
		controller.abort();
		await assert.rejects(cancelled, /CANCELLED/);
		addon.send({ type: "bridge_result", id: firstRequest.id, request_id: firstRequest.request_id, result: { revision: REVISION, snapshot: SNAPSHOT } });
		await first;
		const followUp = bridge.inspectEntity(PROJECT_ID, { scope: "all" });
		const request = await addon.receive();
		assert.equal(request.method, "inspect_entity");
		addon.send({ type: "bridge_result", id: request.id, request_id: request.request_id, result: { revision: REVISION, entity_id: PROJECT_ID, scope: "all", detail: {} } });
		await followUp;
	} finally { await cleanup(project, addon, bridge); }
});

test("framed bridge reaps a silent operation by deadline and advances the queue", async () => {
	const { project, addon, bridge } = await attached(25);
	try {
		const silent = bridge.inspectProject();
		await addon.receive();
		await assert.rejects(silent, /DEADLINE_EXCEEDED/);
		const next = bridge.inspectEntity(PROJECT_ID, { scope: "all" });
		const request = await addon.receive();
		addon.send({ type: "bridge_result", id: request.id, request_id: request.request_id, result: { revision: REVISION, entity_id: PROJECT_ID, scope: "all", detail: {} } });
		await next;
	} finally { await cleanup(project, addon, bridge); }
});

test("framed disconnect diagnostics include method, phase, and artifact bytes", async () => {
	const { project, addon, bridge } = await attached();
	try {
		await bind(bridge, addon);
		const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
		const sha256 = createHash("sha256").update(png).digest("hex");
		const rendering = bridge.renderQaFrames({ schema_version: 1, revision_id: REVISION, frames: [1] }, { reportProgress() {} });
		const request = await addon.receive();
		addon.send({ type: "bridge_artifact_batch_begin", id: request.id, request_id: request.request_id, frames: [{ frame: 1, total_chunks: 2, total_byte_length: png.length * 2, sha256 }] });
		addon.send({ type: "bridge_progress", id: request.id, request_id: request.request_id, phase: "publishing", completed: 1, total: 2 });
		addon.send({ type: "bridge_artifact_chunk", id: request.id, request_id: request.request_id, frame: 1, chunk_index: 0, byte_offset: 0, byte_length: png.length, data_base64: png.toString("base64") });
		await new Promise<void>((resolve) => setImmediate(resolve));
		await addon.stop();
		await assert.rejects(rendering, /during render_qa_frames.*phase publishing.*artifacts 9\/18 bytes over 1 frame/);
	} finally { await bridge.close(); await rm(project, { recursive: true, force: true }); }
});

test("framed directing evidence projects explicit nulls, binds project and revision, and rejects invalid results", async () => {
	const { project, addon, bridge } = await attached();
	try {
		const producing = bridge.produceDirectingEvidence({ frame_start: 10 });
		const request = await addon.receive();
		assert.deepEqual(request.params, { project_id: PROJECT_ID, frame_start: 10, frame_end: null });
		addon.send({ type: "bridge_result", id: request.id, request_id: request.request_id, result: { schema_version: 1, evidence_sha256: "e".repeat(64), revision_id: REVISION, scene_hash: "f".repeat(64), frame_range: { start: 10, end: 250 }, byte_length: 1 } });
		await producing;
		const malformed = bridge.produceDirectingEvidence();
		const bad = await addon.receive();
		assert.deepEqual(bad.params, { project_id: PROJECT_ID, frame_start: null, frame_end: null });
		addon.send({ type: "bridge_result", id: bad.id, request_id: bad.request_id, result: { schema_version: 1 } });
		await assert.rejects(malformed, /INVALID_PRODUCE_EVIDENCE_RESULT/);
		const mismatch = bridge.produceDirectingEvidence();
		const mismatchRequest = await addon.receive();
		addon.send({ type: "bridge_result", id: mismatchRequest.id, request_id: mismatchRequest.request_id, result: { schema_version: 1, evidence_sha256: "e".repeat(64), revision_id: "b".repeat(64), scene_hash: "f".repeat(64), frame_range: { start: 1, end: 2 }, byte_length: 1 } });
		await assert.rejects(mismatch, /does not bind the expected revision/);
	} finally { await cleanup(project, addon, bridge); }
});

test("framed render accepts batch and single begins, chunks, finalization, and rejects non-PNG bytes", async () => {
	const { project, addon, bridge } = await attached();
	try {
		await bind(bridge, addon);
		for (const [beginType, bytes, accepted] of [["bridge_artifact_batch_begin", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]), true], ["bridge_artifact_begin", Buffer.from("not-png"), false]] as const) {
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const rendering = bridge.renderQaFrames({ schema_version: 1, revision_id: REVISION, frames: [1] }, { reportProgress() {} });
			const request = await addon.receive();
			addon.send(beginType === "bridge_artifact_batch_begin" ? { type: beginType, id: request.id, request_id: request.request_id, frames: [{ frame: 1, total_chunks: 1, total_byte_length: bytes.length, sha256 }] } : { type: beginType, id: request.id, request_id: request.request_id, frame: 1, total_chunks: 1, total_byte_length: bytes.length, sha256 });
			addon.send({ type: "bridge_artifact_chunk", id: request.id, request_id: request.request_id, frame: 1, chunk_index: 0, byte_offset: 0, byte_length: bytes.length, data_base64: bytes.toString("base64") });
			addon.send({ type: "bridge_result", id: request.id, request_id: request.request_id, result: renderResult(bytes, sha256) });
			if (accepted) {
				assert.equal((await rendering).frames[0]?.uri, `cclay-artifact://sha256/${sha256}`);
				assert.deepEqual(await readFile(path.join(project, ".cclay", "artifacts", "sha256", `${sha256}.png`)), bytes);
			} else await assert.rejects(rendering, /not a PNG/);
		}
	} finally { await cleanup(project, addon, bridge); }
});

test("framed render finalization failure rejects and advances the queue", async () => {
	const { project, addon, bridge } = await attached();
	try {
		await bind(bridge, addon);
		const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
		const sha256 = createHash("sha256").update(png).digest("hex");
		const rendering = bridge.renderQaFrames({ schema_version: 1, revision_id: REVISION, frames: [1] }, { reportProgress() {} });
		const request = await addon.receive();
		addon.send({ type: "bridge_artifact_batch_begin", id: request.id, request_id: request.request_id, frames: [{ frame: 1, total_chunks: 1, total_byte_length: png.length, sha256 }] });
		addon.send({ type: "bridge_result", id: request.id, request_id: request.request_id, result: renderResult(png, sha256) });
		await assert.rejects(rendering, /artifact chunks are incomplete/);
		await bind(bridge, addon);
	} finally { await cleanup(project, addon, bridge); }
});

test("framed inspect_entity has closed projection, validates bounds and envelopes, binding, and UTF-8 ceiling", async () => {
	const { project, addon, bridge } = await attached();
	try {
		const invalid = bridge.inspectEntity(PROJECT_ID, { scope: "animation", frame_start: 2, frame_end: 1 });
		await assert.rejects(invalid, /frame_start \(2\) must be <= frame_end \(1\)/);
		const inspecting = bridge.inspectEntity(PROJECT_ID, { scope: "animation", data_path_filter: "Foot", frame_start: 1, frame_end: 2 });
		const request = await addon.receive();
		assert.deepEqual(request.params, { entity_id: PROJECT_ID, scope: "animation", data_path_filter: "Foot", frame_start: 1, frame_end: 2 });
		addon.send({ type: "bridge_result", id: request.id, request_id: request.request_id, result: { revision: REVISION, entity_id: PROJECT_ID, scope: "animation", detail: "wrong" } });
		await assert.rejects(inspecting, /entity_id, scope, and object detail/);
		for (const [entity_id, scope, detail, expected] of [[PROJECT_ID, "animation", { blob: "x".repeat(70 * 1024) }, /64 KiB/], ["11111111-1111-4111-8111-111111111111", "animation", {}, /result binds/], [PROJECT_ID, "material", {}, /result binds/]] as const) {
			const operation = bridge.inspectEntity(PROJECT_ID, { scope: "animation" });
			const wire = await addon.receive();
			addon.send({ type: "bridge_result", id: wire.id, request_id: wire.request_id, result: { revision: REVISION, entity_id, scope, detail } });
			await assert.rejects(operation, expected);
		}
		const atCeiling = { revision: REVISION, entity_id: PROJECT_ID, scope: "animation", detail: { blob: "" } };
		atCeiling.detail.blob = "x".repeat(65536 - Buffer.byteLength(JSON.stringify(atCeiling), "utf8"));
		const exact = bridge.inspectEntity(PROJECT_ID, { scope: "animation" });
		const exactRequest = await addon.receive();
		addon.send({ type: "bridge_result", id: exactRequest.id, request_id: exactRequest.request_id, result: atCeiling });
		await exact;
	} finally { await cleanup(project, addon, bridge); }
});
