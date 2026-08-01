import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSceneManifestV4 } from "@cclay/protocol";
import { canonicalJson } from "../src/canonical.ts";
import { buildSceneManifestV4Revision, extensionsDigest } from "../src/index.ts";

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

function flatV4Manifest() {
	return parseSceneManifestV4({ ...recordedV3, schemaVersion: 4, assemblies: [] });
}

test("parentless V4 retains the V3-shaped hash preimage", () => {
	const v4 = flatV4Manifest();
	const revision = buildSceneManifestV4Revision(withoutHashes(v4), parentRevisionId, operation);

	assert.equal(revision.schemaVersion, 4);
	assert.match(revision.sceneHash, /^[0-9a-f]{64}$/);
});

test("parent hierarchy changes the V4 scene hash", () => {
	const base = withoutHashes(flatV4Manifest());
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
	const base = withoutHashes(flatV4Manifest());
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
test("extensions are omitted from the scene and child revision hashes", () => {
	const base = withoutHashes(flatV4Manifest());
	const withExtensions = {
		...base,
		extensions: { "x-future-addon": { "unrecognized-field": "opaque payload" } },
	};
	const withoutExtensions = buildSceneManifestV4Revision(base, parentRevisionId, operation);
	const withOpaqueExtensions = buildSceneManifestV4Revision(withExtensions, parentRevisionId, operation);

	assert.equal(withOpaqueExtensions.sceneHash, withoutExtensions.sceneHash);
	assert.equal(withOpaqueExtensions.revisionId, withoutExtensions.revisionId);
});
test("extensions survive revision construction unchanged", () => {
	const extensions = { "x-future-addon": { nested: ["opaque payload", { enabled: true }] } };
	const revision = buildSceneManifestV4Revision(
		{ ...withoutHashes(flatV4Manifest()), extensions },
		parentRevisionId,
		operation,
	);

	assert.equal(revision.extensions, extensions);
	assert.deepEqual(revision.extensions, extensions);
});

test("revision construction does not add absent extensions", () => {
	const revision = buildSceneManifestV4Revision(withoutHashes(flatV4Manifest()), parentRevisionId, operation);

	assert.equal("extensions" in revision, false);
});

test("extensions byte ceiling uses UTF-8 canonical bytes", async () => {
	const fixture = JSON.parse(
		await readFile(new URL("fixtures/extensions-byte-ceiling.json", import.meta.url), "utf8"),
	) as { extensions: Record<string, unknown> };
	const canonical = canonicalJson(fixture.extensions);

	assert.equal(Buffer.byteLength(canonical, "utf8"), 65_536);
	assert.match(extensionsDigest(fixture.extensions), /^[0-9a-f]{64}$/);
	const aboveLimit = structuredClone(fixture.extensions);
	(aboveLimit["x-aa"] as string) += "漢";
	assert.throws(() => extensionsDigest(aboveLimit), /EXTENSIONS_TOO_LARGE/);
});
