import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ProjectStore, ProjectStoreError } from "../src/project-store.ts";

const roots: string[] = [];
async function createStore(): Promise<{ root: string; store: ProjectStore }> {
	const root = await mkdtemp(join(tmpdir(), "omb-store-"));
	roots.push(root);
	return { root, store: new ProjectStore(root) };
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function project(index: number) {
	return {
		project_id: "123e4567-e89b-42d3-a456-426614174000",
		schema_version: 1,
		current_revision_id: index.toString(16).padStart(64, "0"),
		marker: index,
	};
}

describe("project persistence (architecture §6)", () => {
	it("atomically replaces project.json without torn JSON under interleaved writes", async () => {
		const { store } = await createStore();
		await Promise.all(Array.from({ length: 40 }, (_, index) => store.writeProject(project(index))));
		const value = (await store.readProject()) as ReturnType<typeof project>;
		assert.deepEqual(value, project(value.marker));
	});

	it("appends one parseable JSON line per journal entry", async () => {
		const { root, store } = await createStore();
		await Promise.all(
			Array.from({ length: 100 }, (_, index) => store.appendJournal({ index, text: `entry-${index}` })),
		);
		const lines = (await readFile(join(root, ".omb", "journal.jsonl"), "utf8")).trimEnd().split("\n");
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
		await mkdir(join(root, ".omb"));
		await writeFile(join(root, ".omb", "project.json"), "{");
		await assert.rejects(
			store.readProject(),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "PROJECT_CORRUPT",
		);
		await writeFile(join(root, ".omb", "project.json"), JSON.stringify({ project_id: "x" }));
		await assert.rejects(
			store.readProject(),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "PROJECT_INVALID",
		);
	});
});
