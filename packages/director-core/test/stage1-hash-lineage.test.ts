import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSceneManifestV4Revision } from "../src/manifest.ts";

test("Stage 1 preserves flat-scene hash lineage", async () => {
	const baseline = JSON.parse(
		await readFile(new URL("fixtures/stage1-hash-baseline.json", import.meta.url), "utf8"),
	) as {
		sourceManifestFixture: string;
		parentRevisionId: string;
		operation: unknown;
		expected: { sceneHash: string; revisionId: string };
	};
	const source = JSON.parse(
		await readFile(new URL(baseline.sourceManifestFixture, import.meta.url), "utf8"),
	) as Record<string, unknown>;
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...hashFree } = source;

	// A failure means preimage normalization was broken; never edit the fixture to make it pass.
	const rebuilt = buildSceneManifestV4Revision(
		{ ...hashFree, schemaVersion: 4, assemblies: [] } as never,
		baseline.parentRevisionId,
		baseline.operation,
	);
	assert.equal(rebuilt.sceneHash, baseline.expected.sceneHash);
	assert.equal(rebuilt.revisionId, baseline.expected.revisionId);
});
