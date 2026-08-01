import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DirectorProjectWriteInput, RevisionOperationEntryV2 } from "../src/project-store.ts";
import { ProjectStore, ProjectStoreError } from "../src/project-store.ts";

const BASE = "a".repeat(64);
const CHILD = "b".repeat(64);
const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const KEY = "223e4567-e89b-42d3-a456-426614174000";
const entry: RevisionOperationEntryV2 = {
	schema_version: 2,
	operation: "stage_scene",
	request_id: "323e4567-e89b-42d3-a456-426614174000",
	plan_sha256: "c".repeat(64),
	base_scene_hash: "d".repeat(64),
	candidate_scene_hash: "e".repeat(64),
};

function project(revisionId: string): DirectorProjectWriteInput {
	return {
		project_id: PROJECT_ID,
		schema_version: 1,
		current_revision_id: revisionId,
		manifest: {
			schemaVersion: 4,
			projectId: PROJECT_ID,
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

const child = project(CHILD);

describe("Architecture §§6, 7, 15.3 transaction persistence substrate", () => {
	it("Architecture §6: durable child journal commit completes before current index exposure", async () => {
		const events: string[] = [];
		const store = new ProjectStore("unused");
		store.readProject = async () => project(BASE);
		store.appendJournal = async () => {
			events.push("journal:durable");
		};
		store.writeProject = async () => {
			events.push("index:exposed");
		};
		await store.commitRevision(KEY, BASE, child, entry);
		assert.deepEqual(events, ["journal:durable", "index:exposed"]);
	});

	it("Architecture §§6, 15.3: a journal crash barrier prevents child index exposure", async () => {
		let exposed = false;
		const store = new ProjectStore("unused");
		store.readProject = async () => project(BASE);
		store.appendJournal = async () => {
			throw new Error("simulated fsync failure");
		};
		store.writeProject = async () => {
			exposed = true;
		};
		await assert.rejects(store.commitRevision(KEY, BASE, child, entry), /fsync failure/);
		assert.equal(exposed, false);
	});

	it("Architecture §15.3: stale-base commits fail before journal or index mutation", async () => {
		let mutated = false;
		const store = new ProjectStore("unused");
		store.readProject = async () => child;
		store.appendJournal = async () => {
			mutated = true;
		};
		store.writeProject = async () => {
			mutated = true;
		};
		await assert.rejects(
			store.commitRevision(KEY, BASE, child, entry),
			(error: unknown) => error instanceof ProjectStoreError && error.code === "STALE_BASE",
		);
		assert.equal(mutated, false);
	});
});
