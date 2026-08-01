import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BlenderBridge } from "../src/bridge.ts";
import { FakeAddon, PROJECT_ID, REVISION, SNAPSHOT } from "./bridge-test-fixture.ts";

test("framed prepared mutation is acknowledged only after the local durable commit", async () => {
	const project = await mkdtemp(path.join(tmpdir(), "cclay-transaction-"));
	const addon = new FakeAddon(project);
	const bridge = new BlenderBridge(project, { projectId: PROJECT_ID });
	try {
		await addon.start();
		await bridge.start();
		await bridge.waitForAttach();
		const inspect = bridge.inspectProject();
		const initial = await addon.receive();
		addon.send({ type: "bridge_result", id: initial.id, request_id: initial.request_id, result: { revision: REVISION, snapshot: SNAPSHOT } });
		await inspect;

		const candidate = "b".repeat(64);
		const mutation = bridge.stageScene({
			schema_version: 1,
			expected_revision_id: REVISION,
			operations: [{ op: "add_character", entity_id: randomUUID(), character_type: "Y_BOT", name: "Character", location: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
		}, { reportProgress() {} });
		const request = await addon.receive();
		const transactionId = randomUUID();
		addon.send({ type: "bridge_transaction_prepared", id: request.id, transaction_id: transactionId, operation: "stage_scene", project_id: PROJECT_ID, base_revision_id: REVISION, base_scene_hash: "c".repeat(64), candidate_revision_id: candidate, candidate_scene_hash: "d".repeat(64), base_backup_sha256: "e".repeat(64), canonical_blend_sha256: "f".repeat(64) });
		addon.send({ type: "bridge_result", id: request.id, request_id: request.request_id, result: { manifest: { revisionId: candidate, sceneHash: "d".repeat(64) }, scene_hash: "d".repeat(64), entity_identities: [] } });
		const prepared = await mutation;
		assert.equal(prepared.transaction.transaction_id, transactionId);
		assert.equal(prepared.requestId, request.request_id);

		const committing = bridge.finishDurableCommit(candidate);
		assert.deepEqual(await addon.receive(), { type: "bridge_transaction_ack", id: request.id, transaction_id: transactionId, status: "committed", resulting_revision_id: candidate });
		addon.send({ type: "bridge_transaction_acknowledged", id: request.id, transaction_id: transactionId });
		await committing;
		assert.equal(bridge.revisionId, candidate);
	} finally {
		await bridge.close();
		await addon.stop();
		await rm(project, { recursive: true, force: true });
	}
});
