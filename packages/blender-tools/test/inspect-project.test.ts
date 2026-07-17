import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectManifest } from "../../blender-protocol/src/snapshot.ts";
import { createInspectProjectTool } from "../src/inspect-project.ts";

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
