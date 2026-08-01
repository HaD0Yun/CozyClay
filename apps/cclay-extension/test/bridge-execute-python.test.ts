import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CameraPlanV1 } from "@cclay/protocol";
import { BlenderBridge } from "../src/bridge.ts";
import { FakeAddon, PROJECT_ID, REVISION, SNAPSHOT } from "./bridge-test-fixture.ts";

const NEXT_REVISION = "b".repeat(64);

async function setup(operationTimeoutMs = 1_000) {
	const project = await mkdtemp(path.join(tmpdir(), "cclay-execute-"));
	const addon = new FakeAddon(project);
	const bridge = new BlenderBridge(project, { projectId: PROJECT_ID, operationTimeoutMs });
	await addon.start();
	await bridge.start();
	await bridge.waitForAttach();
	const inspection = bridge.inspectProject();
	const request = await addon.receive();
	addon.send({ type: "bridge_result", id: request.id, request_id: request.request_id, result: { revision: REVISION, snapshot: SNAPSHOT } });
	await inspection;
	return { project, addon, bridge };
}

function execute(bridge: BlenderBridge) {
	return bridge.executeBlenderPython({
		script: "print('✓')",
		deadline_ms: 1,
		capture_stdout: true,
		expected_revision_id: REVISION,
	});
}

async function cleanup(project: string, addon: FakeAddon, bridge: BlenderBridge) {
	await bridge.close();
	await addon.stop();
	await rm(project, { recursive: true, force: true });
}

test("execute_blender_python parses success, recovered failure, and precondition responses", async () => {
	const { project, addon, bridge } = await setup();
	try {
		const success = execute(bridge);
		const successRequest = await addon.receive();
		assert.equal(successRequest.type, "execute_blender_python");
		addon.send({ type: "execute_result", request_id: successRequest.request_id, outcome: "success", new_revision_id: NEXT_REVISION, stdout: "✓", stdout_truncated: false, stderr: "", stderr_truncated: false });
		const successResult = await success;
		assert.equal(successResult.type, "execute_result");
		assert.equal(successResult.outcome, "success");
		assert.equal(bridge.revisionId, NEXT_REVISION);

		const precondition = bridge.executeBlenderPython({ script: "pass", deadline_ms: 1, capture_stdout: false, expected_revision_id: NEXT_REVISION });
		const preconditionRequest = await addon.receive();
		addon.send({ type: "precondition_failed", request_id: preconditionRequest.request_id, code: "BACKUP_UNAVAILABLE", message: "no backup" });
		assert.equal((await precondition).type, "precondition_failed");
		assert.equal(bridge.revisionId, NEXT_REVISION);
		assert.equal(bridge.executionMutationFrozen, false);
	} finally {
		await cleanup(project, addon, bridge);
	}
});

test("disconnect recovery and malformed or absent outcomes freeze mutations while reads remain available", async () => {
	const { project, addon, bridge } = await setup();
	try {
		const pending = execute(bridge);
		const request = await addon.receive();
		await addon.stop();
		await addon.start(1);
		assert.deepEqual(await addon.receive(), { type: "get_execution_outcome", request_id: request.request_id });
		addon.send({ type: "execute_result", request_id: request.request_id, outcome: "failed_recovered", restored_revision_id: REVISION, error: { message: "boom", traceback: "trace" }, stdout: "", stdout_truncated: false, stderr: "", stderr_truncated: false, disclosure: "Blender scene state rolled back; external side effects (files, network, processes) are not and cannot be undone." });
		const recoveredResult = await pending;
		assert.equal(recoveredResult.type, "execute_result");
		assert.equal(recoveredResult.outcome, "failed_recovered");
		assert.equal(bridge.revisionId, REVISION);

		const unknown = execute(bridge);
		const unknownRequest = await addon.receive();
		addon.send({ type: "execute_result", request_id: unknownRequest.request_id, outcome: "success", new_revision_id: "bad", stdout: "", stdout_truncated: false, stderr: "", stderr_truncated: false });
		const unknownResult = await unknown;
		assert.equal(unknownResult.type, "execute_result");
		assert.equal(unknownResult.outcome, "outcome_unknown");
		assert.equal(bridge.executionMutationFrozen, true);
		const cameraPlan: CameraPlanV1 = {
			schema_version: 1,
			expected_revision_id: REVISION,
			output_format: { width: 1, height: 1 },
			keyframes: [{
				frame: 1,
				pose: {
					position: [0, 0, 0],
					look_at: [0, 0, 1],
					up: [0, 1, 0],
					vertical_fov_radians: 1,
				},
				transition: "cut",
			}],
		};
		const frozenMutators = [
			execute(bridge),
			bridge.stageScene({
				schema_version: 1,
				expected_revision_id: REVISION,
				operations: [{
					op: "add_character",
					entity_id: "11111111-1111-4111-8111-111111111111",
					character_type: "Y_BOT",
					name: "Character",
					location: [0, 0, 0],
					rotation: [0, 0, 0],
					scale: [1, 1, 1],
				}],
			}, { reportProgress() {} }),
			bridge.applyCameraPlan(cameraPlan, { reportProgress() {} }),
			bridge.createFallMotion({}),
			bridge.replaceCameraAction({}),
			bridge.applyPerformanceMode({ expected_revision_id: REVISION, profile: "editing" }),
		];
		await Promise.all(frozenMutators.map((mutation) =>
			assert.rejects(mutation, /EXECUTION_RECOVERY_REQUIRED/),
		));

		const read = bridge.inspectProject();
		const outcome = bridge.getExecutionOutcome("11111111-1111-4111-8111-111111111111");
		const readRequest = await addon.receive();
		assert.equal(readRequest.type, "bridge_request");
		assert.equal(readRequest.method, "inspect_project");
		addon.send({ type: "bridge_result", id: readRequest.id, request_id: readRequest.request_id, result: { revision: REVISION, snapshot: SNAPSHOT } });
		await read;
		assert.deepEqual(
			await addon.receive(),
			{ type: "get_execution_outcome", request_id: "11111111-1111-4111-8111-111111111111" },
		);
		addon.send({ type: "execution_outcome_not_found", request_id: "11111111-1111-4111-8111-111111111111" });
		assert.equal((await outcome).type, "execution_outcome_not_found");

		bridge.clearExecutionMutationFreeze();
		assert.equal(bridge.executionMutationFrozen, false);
		const restored = execute(bridge);
		const restoredRequest = await addon.receive();
		assert.equal(restoredRequest.type, "execute_blender_python");
		addon.send({ type: "precondition_failed", request_id: restoredRequest.request_id, code: "BACKUP_UNAVAILABLE", message: "no backup" });
		assert.equal((await restored).type, "precondition_failed");
	} finally {
		await cleanup(project, addon, bridge);
	}
});

test("execution timeout is bounded and freezes mutations as outcome_unknown", async () => {
	const { project, addon, bridge } = await setup(25);
	try {
		const pending = execute(bridge);
		await addon.receive();
		const result = await pending;
		assert.equal(result.type, "execute_result");
		assert.equal(result.outcome, "outcome_unknown");
		assert.equal(bridge.executionMutationFrozen, true);
	} finally {
		await cleanup(project, addon, bridge);
	}
});
test("get_execution_outcome remains FIFO with ordinary bridge reads", async () => {
	const { project, addon, bridge } = await setup();
	try {
		const read = bridge.inspectProject();
		const outcome = bridge.getExecutionOutcome("11111111-1111-4111-8111-111111111111");
		const readRequest = await addon.receive();
		addon.send({ type: "bridge_result", id: readRequest.id, request_id: readRequest.request_id, result: { revision: REVISION, snapshot: SNAPSHOT } });
		await read;
		assert.deepEqual(await addon.receive(), { type: "get_execution_outcome", request_id: "11111111-1111-4111-8111-111111111111" });
		addon.send({ type: "execution_outcome_not_found", request_id: "11111111-1111-4111-8111-111111111111" });
		assert.equal((await outcome).type, "execution_outcome_not_found");
	} finally {
		await cleanup(project, addon, bridge);
	}
});
