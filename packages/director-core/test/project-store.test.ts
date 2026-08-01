import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { canonicalRevision } from "../src/canonical.ts";
import type { DirectorProjectWriteInput, RevisionOperationEntryV2 } from "../src/project-store.ts";
import { ProjectStore, ProjectStoreError } from "../src/project-store.ts";

const roots: string[] = [];
async function createStore(): Promise<{ root: string; store: ProjectStore }> {
	const root = await mkdtemp(join(tmpdir(), "cclay-store-"));
	roots.push(root);
	return { root, store: new ProjectStore(root) };
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const KEY = "223e4567-e89b-42d3-a456-426614174000";
const ENTRY: RevisionOperationEntryV2 = {
	schema_version: 2,
	operation: "stage_scene",
	request_id: "323e4567-e89b-42d3-a456-426614174000",
	plan_sha256: "a".repeat(64),
	base_scene_hash: "b".repeat(64),
	candidate_scene_hash: "c".repeat(64),
};

function project(index: number): DirectorProjectWriteInput {
	const revisionId = index.toString(16).padStart(64, "0");
	return {
		project_id: "123e4567-e89b-42d3-a456-426614174000",
		schema_version: 1 as const,
		current_revision_id: revisionId,
		manifest: {
			schemaVersion: 4 as const,
			projectId: "123e4567-e89b-42d3-a456-426614174000",
			revisionId,
			sceneHash: revisionId,
			blenderVersion: "4.3.0",
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
		},
	};
}

describe("project persistence (architecture §6)", () => {
	it("atomically replaces project.json without torn JSON under interleaved writes", async () => {
		const { store } = await createStore();
		await Promise.all(Array.from({ length: 40 }, (_, index) => store.writeProject(project(index))));
		const value = await store.readProject();
		assert.match(value.current_revision_id, /^[0-9a-f]{64}$/);
	});

	it("appends one parseable JSON line per journal entry", async () => {
		const { root, store } = await createStore();
		await Promise.all(
			Array.from({ length: 100 }, (_, index) => store.appendJournal({ index, text: `entry-${index}` })),
		);
		const lines = (await readFile(join(root, ".cclay", "journal.jsonl"), "utf8")).trimEnd().split("\n");
		assert.equal(lines.length, 100);
		assert.deepEqual(
			new Set(lines.map((line) => JSON.parse(line).index)),
			new Set(Array.from({ length: 100 }, (_, index) => index)),
		);
	});

	it("raises typed errors for missing, corrupt, and invalid project.json", async () => {
		const { root, store } = await createStore();
		await assert.rejects(
			store.readProject(),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "PROJECT_NOT_FOUND",
		);
		await mkdir(join(root, ".cclay"));
		await writeFile(join(root, ".cclay", "project.json"), "{");
		await assert.rejects(
			store.readProject(),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "PROJECT_CORRUPT",
		);
		await writeFile(join(root, ".cclay", "project.json"), JSON.stringify({ project_id: "x" }));
		await assert.rejects(
			store.readProject(),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "PROJECT_INVALID",
		);
	});
	it("persists and re-verifies the director-computed extensions digest", async () => {
		const { root, store } = await createStore();
		const value = project(1);
		value.manifest.extensions = { "x-newer-addon": { opaque: "漢" } };
		await store.writeProject(value);

		const restarted = new ProjectStore(root);
		const reread = (await restarted.readProject()) as unknown as { manifest: { extensions?: unknown } };
		assert.deepEqual(reread.manifest.extensions, value.manifest.extensions);
		const path = join(root, ".cclay", "project.json");
		const stored = JSON.parse(await readFile(path, "utf8")) as { extensionsDigest: string };
		assert.match(stored.extensionsDigest, /^[0-9a-f]{64}$/);
		delete (stored as { extensionsDigest?: string }).extensionsDigest;
		await writeFile(path, JSON.stringify(stored));
		await assert.rejects(
			restarted.readProject(),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "PROJECT_INVALID",
		);
		stored.extensionsDigest = "0".repeat(64);
		await writeFile(path, JSON.stringify(stored));
		await assert.rejects(
			restarted.readProject(),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "PROJECT_INVALID",
		);
	});
	it("rejects fields outside the closed durable project shape", async () => {
		const { root, store } = await createStore();
		const value = project(1);
		value.legacyOptOut = false;
		await assert.rejects(
			store.writeProject(value),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "PROJECT_INVALID",
		);

		await mkdir(join(root, ".cclay"));
		await writeFile(join(root, ".cclay", "project.json"), JSON.stringify(value));
		await assert.rejects(
			store.readProject(),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "PROJECT_INVALID",
		);
	});
	it("reads a legacy project without extensionsDigest or extensions", async () => {
		const { root, store } = await createStore();
		const legacy = project(1);
		await mkdir(join(root, ".cclay"));
		await writeFile(join(root, ".cclay", "project.json"), JSON.stringify(legacy));

		const reread = (await store.readProject()) as unknown as { manifest: Record<string, unknown> };
		assert.equal("extensions" in reread.manifest, false);
	});
	it("reads a legacy project without extensionsDigest and with empty extensions", async () => {
		const { root, store } = await createStore();
		const legacy = project(1);
		legacy.manifest.extensions = {};
		await mkdir(join(root, ".cclay"));
		await writeFile(join(root, ".cclay", "project.json"), JSON.stringify(legacy));

		const reread = (await store.readProject()) as unknown as { manifest: { extensions?: unknown } };
		assert.deepEqual(reread.manifest.extensions, {});
	});
	it("rejects a legacy manifest version with an actionable re-initialization command", async () => {
		const { root, store } = await createStore();
		const legacy = project(1);
		legacy.manifest.schemaVersion = 3 as never;
		await mkdir(join(root, ".cclay"));
		await writeFile(join(root, ".cclay", "project.json"), JSON.stringify(legacy));

		await assert.rejects(
			store.readProject(),
			(error: unknown) =>
				error instanceof ProjectStoreError &&
				error.code === "UNSUPPORTED_PROJECT_VERSION" &&
				error.message.includes("`cclay`"),
		);
	});
	it("rejects every non-V4 manifest discriminator before project validation", async () => {
		for (const schemaVersion of [1, 2, 3, undefined, "four"] as const) {
			const { root, store } = await createStore();
			const invalid = project(1);
			if (schemaVersion === undefined) {
				delete (invalid.manifest as { schemaVersion?: unknown }).schemaVersion;
			} else {
				(invalid.manifest as { schemaVersion: unknown }).schemaVersion = schemaVersion;
			}
			await mkdir(join(root, ".cclay"));
			await writeFile(join(root, ".cclay", "project.json"), JSON.stringify(invalid));
			await assert.rejects(
				store.readProject(),
				(error: unknown) => error instanceof ProjectStoreError && error.code === "UNSUPPORTED_PROJECT_VERSION",
			);
		}
	});
	it("rejects a legacy journal-forwarded project with a non-V4 manifest", async () => {
		const { root, store } = await createStore();
		const base = project(1);
		const legacy = project(2);
		legacy.manifest.schemaVersion = 3 as never;
		await store.writeProject(base);
		const payload = {
			kind: "revision_commit_v1",
			expected_revision_id: base.current_revision_id,
			target_revision_id: legacy.current_revision_id,
			project: legacy,
			entry: {},
		};
		const record = { ...payload, transaction_id: canonicalRevision(payload) };
		await writeFile(join(root, ".cclay", "journal.jsonl"), `${JSON.stringify(record)}\n`);
		await assert.rejects(
			store.commitRevision(KEY, base.current_revision_id, project(3), ENTRY),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "UNSUPPORTED_PROJECT_VERSION",
		);
	});
	it("recovers a durable journal entry after failure before index replacement without duplicating it", async () => {
		const { root, store } = await createStore();
		const base = project(1);
		const child = project(2);
		await store.writeProject(base);

		const writeProject = store.writeProject.bind(store);
		store.writeProject = async (value) => {
			if (value.current_revision_id === child.current_revision_id) throw new Error("simulated index failure");
			await writeProject(value);
		};
		await assert.rejects(
			store.commitRevision(KEY, base.current_revision_id, child, ENTRY),
			/simulated index failure/,
		);

		assert.deepEqual(await store.readProject(), base);
		const journalPath = join(root, ".cclay", "journal.jsonl");
		assert.equal((await readFile(journalPath, "utf8")).trimEnd().split("\n").length, 1);

		const restartedStore = new ProjectStore(root);
		await restartedStore.commitRevision(KEY, base.current_revision_id, child, ENTRY);

		assert.deepEqual(await restartedStore.readProject(), child);
		assert.equal((await readFile(journalPath, "utf8")).trimEnd().split("\n").length, 1);
	});

	it("treats retry as successful when index replacement completed before reporting failure", async () => {
		const { root, store } = await createStore();
		const base = project(1);
		const child = project(2);
		await store.writeProject(base);

		const writeProject = store.writeProject.bind(store);
		store.writeProject = async (value) => {
			await writeProject(value);
			if (value.current_revision_id === child.current_revision_id) throw new Error("simulated post-index crash");
		};
		await assert.rejects(
			store.commitRevision(KEY, base.current_revision_id, child, ENTRY),
			/simulated post-index crash/,
		);

		const restartedStore = new ProjectStore(root);
		await restartedStore.commitRevision(KEY, base.current_revision_id, child, ENTRY);

		assert.deepEqual(await restartedStore.readProject(), child);
		const lines = (await readFile(join(root, ".cclay", "journal.jsonl"), "utf8")).trimEnd().split("\n");
		assert.equal(lines.length, 1);
		const record = JSON.parse(lines[0]) as Record<string, unknown>;
		assert.match(record.commit_hash as string, /^[0-9a-f]{64}$/);
		assert.equal(record.expected_revision_id, base.current_revision_id);
		assert.equal(record.target_revision_id, child.current_revision_id);
	});
});
