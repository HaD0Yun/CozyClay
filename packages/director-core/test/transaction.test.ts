import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProjectStore, ProjectStoreError } from "../src/project-store.ts";

const BASE = "a".repeat(64);
const CHILD = "b".repeat(64);
const project = {
	project_id: "00000000-0000-4000-8000-000000000000",
	schema_version: 1,
	current_revision_id: CHILD,
};

describe("Architecture §§6, 7, 15.3 transaction persistence substrate", () => {
	it("Architecture §6: durable child journal commit completes before current index exposure", async () => {
		const events: string[] = [];
		const store = new ProjectStore("unused");
		store.readProject = async () => ({ ...project, current_revision_id: BASE });
		store.appendJournal = async () => {
			events.push("journal:durable");
		};
		store.writeProject = async () => {
			events.push("index:exposed");
		};
		await store.commitRevision(BASE, project, { revision_id: CHILD });
		assert.deepEqual(events, ["journal:durable", "index:exposed"]);
	});

	it("Architecture §§6, 15.3: a journal crash barrier prevents child index exposure", async () => {
		let exposed = false;
		const store = new ProjectStore("unused");
		store.readProject = async () => ({ ...project, current_revision_id: BASE });
		store.appendJournal = async () => {
			throw new Error("simulated fsync failure");
		};
		store.writeProject = async () => {
			exposed = true;
		};
		await assert.rejects(store.commitRevision(BASE, project, { revision_id: CHILD }), /fsync failure/);
		assert.equal(exposed, false);
	});

	it("Architecture §15.3: stale-base commits fail before journal or index mutation", async () => {
		let mutated = false;
		const store = new ProjectStore("unused");
		store.readProject = async () => ({ ...project, current_revision_id: CHILD });
		store.appendJournal = async () => {
			mutated = true;
		};
		store.writeProject = async () => {
			mutated = true;
		};
		await assert.rejects(
			store.commitRevision(BASE, project, { revision_id: CHILD }),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "STALE_BASE",
		);
		assert.equal(mutated, false);
	});
});
