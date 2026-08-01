import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { canonicalRevision } from "../src/canonical.ts";
import type { DirectorProjectWriteInput, RevisionOperationEntryV2 } from "../src/project-store.ts";
import { ProjectStore, ProjectStoreError } from "../src/project-store.ts";

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const IDEMPOTENCY_KEY = "223e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000";
const BASE_REVISION_ID = "a".repeat(64);
const TARGET_REVISION_ID = "b".repeat(64);
const BASE_SCENE_HASH = "c".repeat(64);
const TARGET_SCENE_HASH = "d".repeat(64);
const PLAN_SHA256 = "e".repeat(64);

type RecoveryProject = DirectorProjectWriteInput;

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function createStore(): Promise<{ root: string; store: ProjectStore }> {
	const root = await mkdtemp(join(tmpdir(), "cclay-transaction-identity-"));
	roots.push(root);
	return { root, store: new ProjectStore(root) };
}

function manifest(revisionId: string, sceneHash: string, blenderVersion = "4.3.0") {
	return {
		schemaVersion: 4 as const,
		projectId: PROJECT_ID,
		revisionId,
		sceneHash,
		blenderVersion,
		scene: {
			name: "Scene",
			frameStart: 1,
			frameEnd: 250,
			fpsNumerator: 24,
			fpsDenominator: 1,
			activeCameraId: null,
		},
		render: { resolutionX: 1920, resolutionY: 1080, resolutionPercentage: 100 },
		objects: [],
		bones: [],
		cameras: [],
		lights: [],
		markers: [],
		selectedEntityIds: [],
		cameraAnimations: [],
		stagePrimitives: [],
		stageMaterials: [],
		assemblies: [],
	};
}

function project(revisionId: string, sceneHash: string, blenderVersion = "4.3.0"): RecoveryProject {
	return {
		project_id: PROJECT_ID,
		schema_version: 1,
		current_revision_id: revisionId,
		manifest: manifest(revisionId, sceneHash, blenderVersion),
	};
}

function entry(operation: RevisionOperationEntryV2["operation"] = "stage_scene"): RevisionOperationEntryV2 {
	return {
		schema_version: 2,
		operation,
		request_id: REQUEST_ID,
		plan_sha256: PLAN_SHA256,
		base_scene_hash: BASE_SCENE_HASH,
		candidate_scene_hash: TARGET_SCENE_HASH,
	};
}

function commitRevision(
	store: ProjectStore,
	idempotencyKey: string,
	expectedRevisionId: string,
	target: RecoveryProject,
	journalEntry: RevisionOperationEntryV2,
): Promise<void> {
	return store.commitRevision(idempotencyKey, expectedRevisionId, target, journalEntry);
}

function isTransactionConflict(error: unknown): boolean {
	return (
		error instanceof ProjectStoreError &&
		String(error.code) === "TRANSACTION_CONFLICT" &&
		error.message === "transaction id was reused with different content"
	);
}

function v3Manifest(revisionId: string, sceneHash: string) {
	const {
		schemaVersion: _schemaVersion,
		stagePrimitives: _stagePrimitives,
		stageMaterials: _stageMaterials,
		assemblies: _assemblies,
		...v4
	} = manifest(revisionId, sceneHash);
	return { ...v4, schemaVersion: 3 as const };
}

describe("revision_commit_v2 UUID transaction identity", () => {
	it("rejects journal projects minted by the pre-assembly build over v3 manifests", async () => {
		const { root, store } = await createStore();
		const legacyProject = {
			project_id: PROJECT_ID,
			schema_version: 1,
			current_revision_id: TARGET_REVISION_ID,
			manifest: v3Manifest(TARGET_REVISION_ID, TARGET_SCENE_HASH),
		};
		await mkdir(join(root, ".cclay"));
		await writeFile(join(root, ".cclay", "project.json"), JSON.stringify(legacyProject));
		await assert.rejects(
			store.readProject(),
			(error: unknown) => error instanceof ProjectStoreError && String(error.code) === "UNSUPPORTED_PROJECT_VERSION",
		);
	});

	it("rejects a legacy record whose payload was tampered without updating commit_hash", async () => {
		const { root, store } = await createStore();
		const targetProject = {
			project_id: PROJECT_ID,
			schema_version: 1 as const,
			current_revision_id: TARGET_REVISION_ID,
			manifest: manifest(TARGET_REVISION_ID, TARGET_SCENE_HASH),
		};
		const payload = {
			kind: "revision_commit_v2",
			idempotency_key: IDEMPOTENCY_KEY,
			expected_revision_id: BASE_REVISION_ID,
			target_revision_id: TARGET_REVISION_ID,
			project: targetProject,
			journal_entry: entry(),
		};
		const tampered = {
			...payload,
			journal_entry: { ...entry(), plan_sha256: "f".repeat(64) },
			commit_hash: canonicalRevision(payload),
		};
		await mkdir(join(root, ".cclay"), { recursive: true });
		await writeFile(join(root, ".cclay", "journal.jsonl"), `${JSON.stringify(tampered)}\n`);
		await store.writeProject(targetProject);

		const next = project("f".repeat(64), "0".repeat(64));
		next.current_revision_id = "f".repeat(64);
		await assert.rejects(
			commitRevision(store, "523e4567-e89b-42d3-a456-426614174000", TARGET_REVISION_ID, next, entry()),
			(error: unknown) => error instanceof ProjectStoreError && String(error.code) === "PROJECT_CORRUPT",
		);
	});

	it("deduplicates the same UUID and byte-identical canonical body", async () => {
		const { root, store } = await createStore();
		const base = project(BASE_REVISION_ID, BASE_SCENE_HASH);
		const target = project(TARGET_REVISION_ID, TARGET_SCENE_HASH);
		await store.writeProject(base);

		await commitRevision(store, IDEMPOTENCY_KEY, BASE_REVISION_ID, target, entry());
		await commitRevision(store, IDEMPOTENCY_KEY, BASE_REVISION_ID, target, entry());

		const lines = (await readFile(join(root, ".cclay", "journal.jsonl"), "utf8")).trimEnd().split("\n");
		assert.equal(lines.length, 1);
		const record = JSON.parse(lines[0]) as Record<string, unknown>;
		assert.equal(record.kind, "revision_commit_v2");
		assert.equal(record.idempotency_key, IDEMPOTENCY_KEY);
		assert.match(String(record.commit_hash), /^[0-9a-f]{64}$/);
		assert.deepEqual(Object.keys(record).sort(), [
			"commit_hash",
			"expected_revision_id",
			"idempotency_key",
			"journal_entry",
			"kind",
			"project",
			"target_revision_id",
		]);
		assert.deepEqual(Object.keys(record.journal_entry as Record<string, unknown>).sort(), [
			"base_scene_hash",
			"candidate_scene_hash",
			"operation",
			"plan_sha256",
			"request_id",
			"schema_version",
		]);
		assert.deepEqual(await store.readProject(), target);
	});

	it("rejects the same UUID with a different operation before any write", async () => {
		const { root, store } = await createStore();
		const base = project(BASE_REVISION_ID, BASE_SCENE_HASH);
		const target = project(TARGET_REVISION_ID, TARGET_SCENE_HASH);
		await store.writeProject(base);
		await commitRevision(store, IDEMPOTENCY_KEY, BASE_REVISION_ID, target, entry());
		const projectBefore = await readFile(join(root, ".cclay", "project.json"), "utf8");
		const journalBefore = await readFile(join(root, ".cclay", "journal.jsonl"), "utf8");

		await assert.rejects(
			commitRevision(store, IDEMPOTENCY_KEY, BASE_REVISION_ID, target, entry("apply_camera_plan")),
			isTransactionConflict,
		);

		assert.equal(await readFile(join(root, ".cclay", "project.json"), "utf8"), projectBefore);
		assert.equal(await readFile(join(root, ".cclay", "journal.jsonl"), "utf8"), journalBefore);
	});

	it("rejects the same UUID when only full target manifest content differs", async () => {
		const { root, store } = await createStore();
		const base = project(BASE_REVISION_ID, BASE_SCENE_HASH);
		const target = project(TARGET_REVISION_ID, TARGET_SCENE_HASH);
		await store.writeProject(base);
		await commitRevision(store, IDEMPOTENCY_KEY, BASE_REVISION_ID, target, entry());
		const projectBefore = await readFile(join(root, ".cclay", "project.json"), "utf8");
		const journalBefore = await readFile(join(root, ".cclay", "journal.jsonl"), "utf8");
		const differentManifest = project(TARGET_REVISION_ID, TARGET_SCENE_HASH, "4.3.1");

		await assert.rejects(
			commitRevision(store, IDEMPOTENCY_KEY, BASE_REVISION_ID, differentManifest, entry()),
			isTransactionConflict,
		);

		assert.equal(await readFile(join(root, ".cclay", "project.json"), "utf8"), projectBefore);
		assert.equal(await readFile(join(root, ".cclay", "journal.jsonl"), "utf8"), journalBefore);
	});
	it("forwards a durable journal only from a candidate-compatible marker phase", async () => {
		const { store } = await createStore();
		const base = project(BASE_REVISION_ID, BASE_SCENE_HASH);
		const target = project(TARGET_REVISION_ID, TARGET_SCENE_HASH);
		await store.writeProject(base);
		await commitRevision(store, IDEMPOTENCY_KEY, BASE_REVISION_ID, target, entry());
		await store.writeProject(base);

		const result = await store.reconcileRevision(IDEMPOTENCY_KEY, "candidate_saved");

		assert.deepEqual(result, {
			status: "candidate_authoritative",
			revisionId: TARGET_REVISION_ID,
		});
		assert.deepEqual(await store.readProject(), target);
	});

	it("classifies rollback_saved plus journal as unknown with zero store writes", async () => {
		const { root, store } = await createStore();
		const base = project(BASE_REVISION_ID, BASE_SCENE_HASH);
		const target = project(TARGET_REVISION_ID, TARGET_SCENE_HASH);
		await store.writeProject(base);
		await commitRevision(store, IDEMPOTENCY_KEY, BASE_REVISION_ID, target, entry());
		await store.writeProject(base);
		const projectBefore = await readFile(join(root, ".cclay", "project.json"), "utf8");
		const journalBefore = await readFile(join(root, ".cclay", "journal.jsonl"), "utf8");

		const result = await store.reconcileRevision(IDEMPOTENCY_KEY, "rollback_saved");

		assert.deepEqual(result, {
			status: "unknown",
			revisionId: BASE_REVISION_ID,
		});
		assert.equal(await readFile(join(root, ".cclay", "project.json"), "utf8"), projectBefore);
		assert.equal(await readFile(join(root, ".cclay", "journal.jsonl"), "utf8"), journalBefore);
	});
});
