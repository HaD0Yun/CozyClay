import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createInspectProjectTool,
	type ProjectManifest,
	summarizeInspectProjectContent,
} from "../src/inspect-project.ts";

const baseSnapshot = {
	schemaVersion: 2 as const,
	scene: {
		name: "Scene",
		frameStart: 1,
		frameEnd: 250,
		fps: 24,
		activeCamera: "Camera",
	},
	render: { resolutionX: 1920, resolutionY: 1080, resolutionPercentage: 100 },
	objects: [],
	cameras: [],
	markers: [],
	animations: [],
};

const manifest = {
	revision: "revision-live",
	snapshot: baseSnapshot,
} as unknown as ProjectManifest;

describe("inspect_project", () => {
	it("reads the bridge at execution time and returns a compact summary plus full details", async () => {
		let current = manifest;
		const tool = createInspectProjectTool({ inspectProject: async () => current });
		const replacement = { ...manifest, revision: "revision-new" } as unknown as ProjectManifest;
		current = replacement;
		const result = await tool.execute("test", {}, undefined, undefined, undefined as never);
		assert.equal(tool.name, "inspect_project");
		assert.equal(tool.label, "inspect_project");
		assert.equal(result.content[0]?.type, "text");
		const summary = JSON.parse(result.content[0]?.text ?? "{}");
		assert.equal(summary.revision, "revision-new");
		assert.equal(result.details, replacement);
	});

	it("summarizes assembly hierarchy as member counts in the model-facing payload", async () => {
		const hierarchical = {
			revision: "revision-hierarchy",
			snapshot: {
				...baseSnapshot,
				schemaVersion: 4 as const,
				objects: [
					{
						entityId: "root",
						name: "Table",
						type: "EMPTY",
						parent: null,
						visible: true,
						location: [0, 0, 0],
						rotationMode: "XYZ",
						rotationQuaternion: [1, 0, 0, 0],
						scale: [1, 1, 1],
					},
					{
						entityId: "top",
						name: "Top",
						type: "MESH",
						parent: "Table",
						visible: true,
						location: [0, 0, 1],
						rotationMode: "XYZ",
						rotationQuaternion: [1, 0, 0, 0],
						scale: [1, 1, 1],
					},
				],
				assemblies: [
					{
						assemblyId: "assembly",
						name: "Table",
						rootEntityId: "root",
						memberIds: ["root", "top"],
					},
				],
			},
		} as unknown as ProjectManifest;
		const tool = createInspectProjectTool({ inspectProject: async () => hierarchical });

		const result = await tool.execute("test", {}, undefined, undefined, undefined as never);
		assert.equal(result.content[0]?.type, "text");
		const summary = JSON.parse(result.content[0]?.text ?? "{}");
		assert.equal(summary.revision, "revision-hierarchy");
		assert.equal(summary.assemblies[0]?.name, "Table");
		assert.equal(summary.assemblies[0]?.memberCount, 2);
		// Identity rotation and unit scale are pure noise for staged primitives:
		// the compact summary must omit them entirely.
		assert.equal(summary.objects[0]?.rotationQuaternion, undefined);
		assert.equal(summary.objects[0]?.scale, undefined);
		assert.deepEqual(summary.objects[1]?.location, [0, 0, 1]);
		assert.equal(result.details, hierarchical);
	});

	it("keeps and rounds only non-default transforms and drops f32 dither", async () => {
		const noisy = {
			revision: "revision-noisy",
			snapshot: {
				...baseSnapshot,
				schemaVersion: 4 as const,
				objects: [
					{
						entityId: "rot",
						name: "Tilted",
						type: "MESH",
						parent: null,
						visible: true,
						location: [7.358891487121582, -6.925790786743164, 4.958309173583984],
						rotationMode: "XYZ",
						rotationQuaternion: [0.780482700300508, 0.48353602918017763, 0.2087036048854644, 0.33687159025970953],
						scale: [2, 2, 2],
					},
				],
			},
		} as unknown as ProjectManifest;
		const tool = createInspectProjectTool({ inspectProject: async () => noisy });
		const result = await tool.execute("test", {}, undefined, undefined, undefined as never);
		const block = result.content[0];
		const summary = JSON.parse(block && block.type === "text" ? block.text : "{}");
		const object = summary.objects[0];
		assert.deepEqual(object.location, [7.359, -6.926, 4.958]);
		assert.deepEqual(object.rotationQuaternion, [0.78, 0.484, 0.209, 0.337]);
		assert.deepEqual(object.scale, [2, 2, 2]);
	});

	it("returns an object diff on repeat inspects and the full list on demand", async () => {
		const makeObject = (name: string, z: number) => ({
			entityId: `id-${name}`,
			name,
			type: "MESH",
			parent: null,
			visible: true,
			location: [0, 0, z],
			rotationMode: "XYZ",
			rotationQuaternion: [1, 0, 0, 0],
			scale: [1, 1, 1],
		});
		const first = {
			revision: "rev-1",
			snapshot: {
				...baseSnapshot,
				schemaVersion: 4 as const,
				objects: [makeObject("Keep", 0), makeObject("Move", 1), makeObject("Drop", 2)],
			},
		} as unknown as ProjectManifest;
		const second = {
			revision: "rev-2",
			snapshot: {
				...baseSnapshot,
				schemaVersion: 4 as const,
				objects: [makeObject("Keep", 0), makeObject("Move", 5), makeObject("New", 3)],
			},
		} as unknown as ProjectManifest;
		let current = first;
		const tool = createInspectProjectTool({ inspectProject: async () => current });

		const initial = await tool.execute("test", {}, undefined, undefined, undefined as never);
		const initialSummary = JSON.parse(initial.content[0]?.type === "text" ? initial.content[0].text : "{}");
		assert.equal(initialSummary.objects.length, 3);
		assert.equal(initialSummary.objectsDiff, undefined);

		current = second;
		const repeat = await tool.execute("test", {}, undefined, undefined, undefined as never);
		const diffPayload = JSON.parse(repeat.content[0]?.type === "text" ? repeat.content[0].text : "{}");
		assert.equal(diffPayload.objects, undefined);
		assert.equal(diffPayload.objectCount, 3);
		assert.equal(diffPayload.objectsDiff.baseRevision, "rev-1");
		assert.deepEqual(
			diffPayload.objectsDiff.added.map((object: { name: string }) => object.name),
			["New"],
		);
		assert.deepEqual(
			diffPayload.objectsDiff.changed.map((object: { name: string }) => object.name),
			["Move"],
		);
		assert.deepEqual(diffPayload.objectsDiff.removedNames, ["Drop"]);
		assert.equal(diffPayload.objectsDiff.unchangedCount, 1);
		// Full manifest stays available to the harness regardless of mode.
		assert.equal(repeat.details, second);

		const forced = await tool.execute("test", { full: true }, undefined, undefined, undefined as never);
		const fullSummary = JSON.parse(forced.content[0]?.type === "text" ? forced.content[0].text : "{}");
		assert.equal(fullSummary.objectsDiff, undefined);
		assert.equal(fullSummary.objects.length, 3);
	});

	it("surfaces bridge rejection as a tool error", async () => {
		const failure = new Error("bridge unavailable");
		const tool = createInspectProjectTool({
			inspectProject: async () => {
				throw failure;
			},
		});
		await assert.rejects(tool.execute("test", {}, undefined, undefined, undefined as never), failure);
	});

	it("folds a full summary into scene, render, counts, and a bounded object list", () => {
		const lines = summarizeInspectProjectContent({
			revision: "a".repeat(64),
			scene: { name: "Scene", frameStart: 1, frameEnd: 250, fps: 24, activeCamera: "Camera" },
			render: { resolutionX: 1920, resolutionY: 1080, resolutionPercentage: 100 },
			objects: [
				{ entityId: "id-1", name: "Rig", type: "ARMATURE", parent: null, visible: true, location: [0, 0, 0] },
				{ entityId: "id-2", name: "Slab", type: "MESH", parent: null, visible: false, location: [1, 0, 0.18] },
			],
			cameras: [{ name: "Camera", lens: 50, sensorFit: "AUTO" }],
			assemblies: [],
			animationCount: 1,
			boneCounts: [{ name: "Rig", boneCount: 65 }],
		});
		assert.deepEqual(lines, [
			`Scene  frames 1-250  @24fps  cam Camera  rev ${"a".repeat(12)}`,
			"render 1920x1080 @ 100%",
			"2 objects, 1 cameras, 0 assemblies, 1 animations, 1 rigs",
			"  Rig  ARMATURE  loc [0, 0, 0]",
			"  Slab  MESH hidden  loc [1, 0, 0.18]",
		]);
	});

	it("folds an objectsDiff payload into counts and bounded name lists", () => {
		const lines = summarizeInspectProjectContent({
			revision: "b".repeat(64),
			objectCount: 3,
			objectsDiff: {
				baseRevision: "a".repeat(64),
				added: [{ name: "New" }],
				changed: [{ name: "Move" }],
				removedNames: ["Drop"],
				unchangedCount: 1,
			},
		});
		assert.deepEqual(lines, [
			`3 objects  +1 ~1 -1  unchanged 1  rev ${"b".repeat(12)}`,
			"  + New",
			"  ~ Move",
			"  - Drop",
		]);
	});

	it("a malformed fold input summarizes to nothing rather than throwing", () => {
		assert.deepEqual(summarizeInspectProjectContent(undefined), []);
		assert.deepEqual(summarizeInspectProjectContent({ objects: "not-a-list" }), []);
	});
});
