import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInspectProjectTool, type ProjectManifest } from "../src/inspect-project.ts";

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
					{ entityId: "root", name: "Table", type: "EMPTY", parent: null, visible: true, location: [0, 0, 0], rotationMode: "XYZ", rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
					{ entityId: "top", name: "Top", type: "MESH", parent: "Table", visible: true, location: [0, 0, 1], rotationMode: "XYZ", rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
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
		assert.equal(result.details, hierarchical);
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
});
