import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSceneManifestV3, parseSceneManifestV4 } from "@cclay/protocol";
import { buildSceneManifestV3Revision, buildSceneManifestV4Revision } from "../src/index.ts";

const recordedV3 = JSON.parse(
	await readFile(new URL("fixtures/scene-manifest-v3-hierarchy-compat.json", import.meta.url), "utf8"),
);
const parentRevisionId = "c".repeat(64);
const operation = { schema_version: 1, operations: [] };

function withoutHashes<T extends { revisionId: string; sceneHash: string }>(
	manifest: T,
): Omit<T, "revisionId" | "sceneHash"> {
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...hashFree } = manifest;
	return hashFree;
}

test("parentless V4 hashes byte-identically to the recorded V3 manifest", () => {
	const v3 = parseSceneManifestV3(recordedV3);
	const v3Revision = buildSceneManifestV3Revision(withoutHashes(v3), parentRevisionId, operation);
	const v4 = parseSceneManifestV4(recordedV3);
	const v4Revision = buildSceneManifestV4Revision(withoutHashes(v4), parentRevisionId, operation);

	assert.equal(v4Revision.sceneHash, v3Revision.sceneHash);
	assert.equal(v4Revision.schemaVersion, 4);
});

test("parent hierarchy changes the V4 scene hash", () => {
	const base = withoutHashes(parseSceneManifestV4(recordedV3));
	const parented = {
		...base,
		objects: base.objects.map((object) =>
			object.entityId === "00000000-0000-4000-8000-000000000001"
				? { ...object, parentId: "00000000-0000-4000-8000-000000000002" as const }
				: object,
		),
	};

	assert.notEqual(
		buildSceneManifestV4Revision(parented, parentRevisionId, operation).sceneHash,
		buildSceneManifestV4Revision(base, parentRevisionId, operation).sceneHash,
	);
});

test("assembly membership changes the V4 scene hash", () => {
	const base = withoutHashes(parseSceneManifestV4(recordedV3));
	const assembly = {
		assemblyId: "00000000-0000-4000-8000-000000000003" as const,
		name: "Subject Assembly",
		rootEntityId: "00000000-0000-4000-8000-000000000002" as const,
	};
	const rootOnly = { ...base, assemblies: [{ ...assembly, memberIds: [assembly.rootEntityId] }] };
	const withSubject = {
		...base,
		assemblies: [
			{
				...assembly,
				memberIds: ["00000000-0000-4000-8000-000000000001" as const, assembly.rootEntityId],
			},
		],
	};

	assert.notEqual(
		buildSceneManifestV4Revision(rootOnly, parentRevisionId, operation).sceneHash,
		buildSceneManifestV4Revision(withSubject, parentRevisionId, operation).sceneHash,
	);
});

test("V3 parses as parentless V4", () => {
	const parsed = parseSceneManifestV4(recordedV3);

	assert.equal(parsed.schemaVersion, 4);
	assert.deepEqual(
		parsed.objects.map((object) => object.parentId),
		[null, null],
	);
	assert.deepEqual(parsed.assemblies, []);
});
