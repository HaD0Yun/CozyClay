import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInspectProjectTool, type ProjectManifest } from "../src/inspect-project.ts";

const manifest = { revision: "revision-live", snapshot: { schemaVersion: 2 } } as unknown as ProjectManifest;

describe("inspect_project", () => {
	it("reads the bridge at execution time and returns JSON text plus details", async () => {
		let current = manifest;
		const tool = createInspectProjectTool({ inspectProject: async () => current });
		const replacement = { ...manifest, revision: "revision-new" };
		current = replacement;
		const result = await tool.execute("test", {}, undefined, undefined, undefined as never);
		assert.equal(tool.name, "inspect_project");
		assert.equal(tool.label, "inspect_project");
		assert.equal(result.content[0]?.type, "text");
		assert.equal(result.content[0]?.text, JSON.stringify(replacement));
		assert.equal(result.details, replacement);
	});

	it("preserves assembly hierarchy in the model-visible payload", async () => {
		const hierarchical = {
			revision: "revision-hierarchy",
			snapshot: {
				schemaVersion: 4,
				objects: [
					{ entityId: "root", name: "Table", type: "EMPTY", parentId: null },
					{ entityId: "top", name: "Top", type: "MESH", parentId: "root" },
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
		assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), hierarchical);
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
