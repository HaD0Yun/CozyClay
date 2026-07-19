import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSceneManifestV2 } from "@oh-my-blender/protocol";
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

test("changing only staged material color advances both scene hash and child revision", () => {
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...base } = v2;
	const common = {
		...base,
		schemaVersion: 3 as const,
		lights: [],
		stagePrimitives: [{ objectId: "00000000-0000-4000-8000-000000000002" as const, primitiveType: "CUBE" as const }],
	};
	const first = buildSceneManifestV3Revision(
		{
			...common,
			stageMaterials: [
				{
					objectId: "00000000-0000-4000-8000-000000000002",
					materialName: "OMB Material",
					baseColor: [0.1, 0.2, 0.3, 1],
				},
			],
		},
		parent,
		operation,
	);
	const second = buildSceneManifestV3Revision(
		{
			...common,
			stageMaterials: [
				{
					objectId: "00000000-0000-4000-8000-000000000002",
					materialName: "OMB Material",
					baseColor: [0.8, 0.2, 0.3, 1],
				},
			],
		},
		parent,
		operation,
	);
	assert.notEqual(first.sceneHash, second.sceneHash);
	assert.notEqual(first.revisionId, second.revisionId);
});
