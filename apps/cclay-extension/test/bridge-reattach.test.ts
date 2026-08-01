import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BlenderBridge } from "../src/bridge.ts";
import { FakeAddon, PROJECT_ID, REVISION } from "./bridge-test-fixture.ts";

async function temporaryProject(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "cclay-bridge-"));
}

async function sleep(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForAttach(bridge: BlenderBridge, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.min(250, deadline - Date.now()));
		try {
			await bridge.waitForAttach(controller.signal);
			return;
		} catch (error) {
			if (!(error instanceof Error) || !error.message.startsWith("ATTACH_ABORTED")) {
				await sleep(25);
			}
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(`TEST_TIMEOUT: bridge did not attach within ${timeoutMs}ms`);
}

async function waitForFailure(bridge: BlenderBridge): Promise<Error> {
	await assert.rejects(bridge.waitForAttach());
	return new Error(bridge.attachFailure);
}

test("G002 reattaches after a TUI restart", async () => {
	const project = await temporaryProject();
	const addon = new FakeAddon(project);
	const first = new BlenderBridge(project, { projectId: PROJECT_ID });
	try {
		await addon.start();
		await first.start();
		await waitForAttach(first);
		await first.close();

		const restarted = new BlenderBridge(project, { projectId: PROJECT_ID });
		await restarted.start();
		await waitForAttach(restarted);
		assert.equal(restarted.attachedProjectId, PROJECT_ID);
		await restarted.close();
	} finally {
		await first.close();
		await addon.stop();
		await rm(project, { recursive: true, force: true });
	}
});
test("G002 repair preserves a prepared transaction for reconciliation", async () => {
	const project = await temporaryProject();
	const addon = new FakeAddon(project);
	const bridge = new BlenderBridge(project, { projectId: PROJECT_ID });
	try {
		await addon.start();
		await bridge.start();
		await waitForAttach(bridge);

		const candidate = "b".repeat(64);
		const mutation = bridge.stageScene({
			schema_version: 1,
			expected_revision_id: REVISION,
			operations: [{
				op: "add_character",
				entity_id: randomUUID(),
				character_type: "Y_BOT",
				name: "Character",
				location: [0, 0, 0],
				rotation: [0, 0, 0],
				scale: [1, 1, 1],
			}],
		}, { reportProgress() {} });
		const request = await addon.receive();
		const transactionId = randomUUID();
		addon.send({
			type: "bridge_transaction_prepared",
			id: request.id,
			transaction_id: transactionId,
			operation: "stage_scene",
			project_id: PROJECT_ID,
			base_revision_id: REVISION,
			base_scene_hash: "c".repeat(64),
			candidate_revision_id: candidate,
			candidate_scene_hash: "d".repeat(64),
			base_backup_sha256: "e".repeat(64),
			canonical_blend_sha256: "f".repeat(64),
		});
		addon.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: {
				manifest: { revisionId: candidate, sceneHash: "d".repeat(64) },
				scene_hash: "d".repeat(64),
				entity_identities: [],
			},
		});
		await mutation;

		assert.throws(() => bridge.repairBridge(), /TRANSACTION_RECONCILIATION_REQUIRED/);
		assert.equal(bridge.inspectBridgeState().prepared_transaction_id, transactionId);

		const committing = bridge.finishDurableCommit(candidate);
		assert.deepEqual(await addon.receive(), {
			type: "bridge_transaction_ack",
			id: request.id,
			transaction_id: transactionId,
			status: "committed",
			resulting_revision_id: candidate,
		});
		addon.send({ type: "bridge_transaction_acknowledged", id: request.id, transaction_id: transactionId });
		await committing;
		assert.equal(bridge.inspectBridgeState().prepared_transaction_id, null);
	} finally {
		await bridge.close();
		await addon.stop();
		await rm(project, { recursive: true, force: true });
	}
});
test("G002 reconciles a prepared transaction through a replacement transport", async () => {
	const project = await temporaryProject();
	const addon = new FakeAddon(project);
	let replacement: FakeAddon | undefined;
	const bridge = new BlenderBridge(project, { projectId: PROJECT_ID });
	try {
		await addon.start();
		await bridge.start();
		await waitForAttach(bridge);

		const candidate = "b".repeat(64);
		const mutation = bridge.stageScene({
			schema_version: 1,
			expected_revision_id: REVISION,
			operations: [{
				op: "add_character",
				entity_id: randomUUID(),
				character_type: "Y_BOT",
				name: "Character",
				location: [0, 0, 0],
				rotation: [0, 0, 0],
				scale: [1, 1, 1],
			}],
		}, { reportProgress() {} });
		const request = await addon.receive();
		const transactionId = randomUUID();
		addon.send({
			type: "bridge_transaction_prepared",
			id: request.id,
			transaction_id: transactionId,
			operation: "stage_scene",
			project_id: PROJECT_ID,
			base_revision_id: REVISION,
			base_scene_hash: "c".repeat(64),
			candidate_revision_id: candidate,
			candidate_scene_hash: "d".repeat(64),
			base_backup_sha256: "e".repeat(64),
			canonical_blend_sha256: "f".repeat(64),
		});
		addon.send({
			type: "bridge_result",
			id: request.id,
			request_id: request.request_id,
			result: {
				manifest: { revisionId: candidate, sceneHash: "d".repeat(64) },
				scene_hash: "d".repeat(64),
				entity_identities: [],
			},
		});
		await mutation;

		await addon.stop();
		replacement = new FakeAddon(project);
		await replacement.start(1);
		await waitForAttach(bridge);
		assert.equal(bridge.inspectBridgeState().prepared_transaction_id, transactionId);

		const committing = bridge.finishDurableCommit(candidate);
		assert.deepEqual(await replacement.receive(), {
			type: "bridge_transaction_ack",
			id: request.id,
			transaction_id: transactionId,
			status: "committed",
			resulting_revision_id: candidate,
		});
		assert.equal(bridge.inspectBridgeState().prepared_transaction_id, transactionId);
		replacement.send({ type: "bridge_transaction_acknowledged", id: request.id, transaction_id: transactionId });
		await committing;
		assert.equal(bridge.inspectBridgeState().prepared_transaction_id, null);
	} finally {
		await bridge.close();
		await replacement?.stop();
		await addon.stop();
		await rm(project, { recursive: true, force: true });
	}
});

test("G002 rotates generations and queries an ambiguous operation outcome", async () => {
	const project = await temporaryProject();
	const addon = new FakeAddon(project);
	const bridge = new BlenderBridge(project, { projectId: PROJECT_ID });
	try {
		await addon.start();
		await bridge.start();
		await waitForAttach(bridge);
		const pending = bridge.inspectProject();
		const request = await addon.receive();
		await addon.stop();
		await addon.start(1);
		assert.deepEqual(await addon.receive(), { type: "get_execution_outcome", request_id: request.request_id });
		addon.send({ type: "execution_outcome_not_found", request_id: request.request_id });
		await assert.rejects(pending, /OUTCOME_UNKNOWN/);
	} finally {
		await bridge.close();
		await addon.stop();
		await rm(project, { recursive: true, force: true });
	}
});

test("G002 treats absent discovery as Blender waiting and attaches when it appears", async () => {
	const project = await temporaryProject();
	const bridge = new BlenderBridge(project);
	const controller = new AbortController();
	try {
		await bridge.start();
		setTimeout(() => controller.abort(), 100);
		await assert.rejects(bridge.waitForAttach(controller.signal), /ATTACH_ABORTED/);
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		await assert.rejects(bridge.waitForAttach(alreadyAborted.signal), /ATTACH_ABORTED/);
		assert.equal(bridge.attachFailure, undefined);
		const addon = new FakeAddon(project);
		try {
			await addon.start();
			await waitForAttach(bridge);
		} finally {
			await addon.stop();
		}
	} finally {
		await bridge.close();
		await rm(project, { recursive: true, force: true });
	}
});

test("G002 rejects malformed discovery for current attach waiters", async () => {
	const project = await temporaryProject();
	const bridge = new BlenderBridge(project);
	try {
		await mkdir(path.join(project, ".cclay"));
		await writeFile(path.join(project, ".cclay", "bridge-endpoint.json"), "{");
		await bridge.start();
		const error = await waitForFailure(bridge);
		assert.match(error.message, /ADDON_STALE/);
	} finally {
		await bridge.close();
		await rm(project, { recursive: true, force: true });
	}
});

test("G002 rejects a discovery endpoint with a bad token", async () => {
	const project = await temporaryProject();
	const addon = new FakeAddon(project);
	const bridge = new BlenderBridge(project);
	try {
		await addon.start();
		await addon.publish({ token: "bad-token" });
		await bridge.start();
		const error = await waitForFailure(bridge);
		assert.match(error.message, /ADDON_STALE/);
	} finally {
		await bridge.close();
		await addon.stop();
		await rm(project, { recursive: true, force: true });
	}
});
test("G002 rejects a silent hello peer within the handshake deadline", async () => {
	const project = await temporaryProject();
	const addon = new FakeAddon(project, { acknowledgeHello: false });
	const bridge = new BlenderBridge(project);
	try {
		await addon.start();
		await bridge.start();
		const error = await waitForFailure(bridge);
		assert.match(error.message, /did not acknowledge bridge hello within 5 seconds/);
		await addon.waitForSocketClose(6_000);
	} finally {
		await bridge.close();
		await addon.stop();
		await rm(project, { recursive: true, force: true });
	}
});

test("G002 rejects an add-on version mismatch and recovers with the matching version", async () => {
	const project = await temporaryProject();
	const stale = new FakeAddon(project, { addonVersion: "0.0.1" });
	const bridge = new BlenderBridge(project);
	try {
		await stale.start();
		await bridge.start();
		await stale.waitForSocketClose();
		assert.match((await waitForFailure(bridge)).message, /ADDON_STALE.*does not match repo/);
		await stale.stop();

		const fresh = new FakeAddon(project);
		await fresh.start(1);
		await waitForAttach(bridge);
		assert.equal(bridge.attachedAddonVersion, fresh.addonVersion);
		await fresh.stop();
	} finally {
		await bridge.close();
		await stale.stop();
		await rm(project, { recursive: true, force: true });
	}
});

test("G002 rejects an add-on missing the required capability and recovers", async () => {
	const project = await temporaryProject();
	const stale = new FakeAddon(project, { capabilities: [] });
	const bridge = new BlenderBridge(project);
	try {
		await stale.start();
		await bridge.start();
		await stale.waitForSocketClose();
		assert.match((await waitForFailure(bridge)).message, /required capability execute_blender_python_v1/);
		await stale.stop();
		const fresh = new FakeAddon(project);
		await fresh.start(1);
		await waitForAttach(bridge);
		assert.equal(bridge.attachedAddonVersion, fresh.addonVersion);
		await fresh.stop();
	} finally {
		await bridge.close();
		await stale.stop();
		await rm(project, { recursive: true, force: true });
	}
});

test("G002 disconnects malformed and oversized framed responses and reconnects", async () => {
	const project = await temporaryProject();
	const addon = new FakeAddon(project);
	const bridge = new BlenderBridge(project);
	try {
		await addon.start();
		await bridge.start();
		await waitForAttach(bridge);
		addon.sendBytes(Buffer.from("not-json"));
		await addon.waitForSocketClose();
		await addon.stop();
		await addon.start(1);
		await waitForAttach(bridge);

		addon.sendOversizedFrame();
		await addon.waitForSocketClose();
		await addon.stop();
		await addon.start(2);
		await waitForAttach(bridge);
	} finally {
		await bridge.close();
		await addon.stop();
		await rm(project, { recursive: true, force: true });
	}
});
