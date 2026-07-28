import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSceneManifestV2 } from "@cclay/protocol";
import { buildSceneManifestV3Revision, canonicalJson, childRevisionId } from "../src/index.ts";

const v2 = parseSceneManifestV2(
	JSON.parse(await readFile(new URL("fixtures/scene-manifest-v2-parity.json", import.meta.url), "utf8")),
);
const parent = "a".repeat(64);
const operation = {
	schema_version: 1,
	expected_revision_id: parent,
	operations: [
		{
			op: "add_primitive",
			entity_id: "00000000-0000-4000-8000-000000000002",
			primitive_type: "CUBE",
			name: "Parity Subject",
			location: [0, 0, 0],
			rotation: [0, 0, 0],
			scale: [1, 1, 1],
		},
	],
};

test("builds a real child revision from parent, canonical operation, and V3 scene hash", () => {
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...base } = v2;
	const manifest = buildSceneManifestV3Revision(
		{
			...base,
			schemaVersion: 3,
			lights: [],
			stagePrimitives: [{ objectId: "00000000-0000-4000-8000-000000000002", primitiveType: "CUBE" }],
			stageMaterials: [],
		},
		parent,
		operation,
	);
	assert.equal(
		manifest.revisionId,
		childRevisionId(manifest.projectId, parent, canonicalJson(operation), manifest.sceneHash, canonicalJson([])),
	);
	assert.notEqual(manifest.revisionId, manifest.sceneHash);
});

test("each authoritative staged material field advances scene and child revisions", () => {
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...base } = v2;
	const common = {
		...base,
		schemaVersion: 3 as const,
		lights: [],
		stagePrimitives: [{ objectId: "00000000-0000-4000-8000-000000000002" as const, primitiveType: "CUBE" as const }],
	};
	const material = {
		objectId: "00000000-0000-4000-8000-000000000002",
		materialName: "CCLAY Material",
		baseColor: [0.1, 0.2, 0.3, 1] as [number, number, number, number],
		useNodes: true,
		principledBaseColor: [0.1, 0.2, 0.3, 1] as [number, number, number, number],
	};
	const build = (stageMaterial: typeof material) =>
		buildSceneManifestV3Revision({ ...common, stageMaterials: [stageMaterial] }, parent, operation);
	const first = build(material);
	for (const changed of [
		{ ...material, baseColor: [0.8, 0.2, 0.3, 1] as [number, number, number, number] },
		{
			...material,
			principledBaseColor: [0.8, 0.2, 0.3, 1] as [number, number, number, number],
		},
		{ ...material, useNodes: false },
	]) {
		const next = build(changed);
		assert.notEqual(first.sceneHash, next.sceneHash);
		assert.notEqual(first.revisionId, next.revisionId);
	}
});
