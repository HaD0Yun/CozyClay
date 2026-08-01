import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSceneManifestV4 } from "../src/manifest.ts";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const ASSEMBLY_ID = "33333333-3333-4333-8333-333333333333";

const base = JSON.parse(
	await readFile(
		new URL("../../director-core/test/fixtures/scene-manifest-v3-hierarchy-compat.json", import.meta.url),
		"utf8",
	),
) as Record<string, unknown>;

function v4Manifest(): Record<string, unknown> {
	const manifest: Record<string, unknown> = {
		...structuredClone(base),
		schemaVersion: 4,
	};
	manifest.objects = [
		{
			entityId: ROOT_ID,
			name: "Assembly Root",
			type: "EMPTY",
			parentId: null,
			visible: true,
			location: [0, 0, 0],
			rotationQuaternion: [1, 0, 0, 0],
			scale: [1, 1, 1],
		},
		{
			entityId: MEMBER_ID,
			name: "Member",
			type: "MESH",
			parentId: ROOT_ID,
			visible: true,
			location: [0, 0, 0],
			rotationQuaternion: [1, 0, 0, 0],
			scale: [1, 1, 1],
		},
	];
	manifest.cameras = [];
	manifest.lights = [];
	manifest.markers = [];
	manifest.cameraAnimations = [];
	manifest.stagePrimitives = [];
	manifest.stageMaterials = [];
	manifest.scene = { ...(manifest.scene as Record<string, unknown>), activeCameraId: null };
	manifest.assemblies = [
		{ assemblyId: ASSEMBLY_ID, name: "Vehicle", rootEntityId: ROOT_ID, memberIds: [ROOT_ID, MEMBER_ID] },
	];
	return manifest;
}

test("SceneManifestV4 rejects an assembly whose root is not an EMPTY", () => {
	const manifest = v4Manifest();
	(manifest.objects as Array<Record<string, unknown>>)[0]!.type = "MESH";
	assert.throws(() => parseSceneManifestV4(manifest), /rootEntityId must reference an EMPTY object/);
});

test("SceneManifestV4 rejects entities shared across assemblies", () => {
	const manifest = v4Manifest();
	(manifest.assemblies as Array<Record<string, unknown>>).push({
		assemblyId: "44444444-4444-4444-8444-444444444444",
		name: "Other",
		rootEntityId: ROOT_ID,
		memberIds: [ROOT_ID],
	});
	assert.throws(() => parseSceneManifestV4(manifest), /memberId .* belongs to more than one assembly/);
});

test("SceneManifestV4 parses and round-trips assembly hierarchy", () => {
	const parsed = parseSceneManifestV4(v4Manifest());
	assert.equal(parsed.schemaVersion, 4);
	assert.equal(parsed.objects[1]?.parentId, ROOT_ID);
	assert.deepEqual(parsed.assemblies, [
		{ assemblyId: ASSEMBLY_ID, name: "Vehicle", rootEntityId: ROOT_ID, memberIds: [ROOT_ID, MEMBER_ID] },
	]);
	assert.deepEqual(parseSceneManifestV4(structuredClone(parsed)), parsed);
});

test("SceneManifestV4 rejects unknown fields", () => {
	const manifest = v4Manifest();
	(manifest.assemblies as Array<Record<string, unknown>>)[0]!.unknown = true;
	assert.throws(() => parseSceneManifestV4(manifest));
});
test("SceneManifestV4 accepts opaque namespaces but rejects invalid extension values and outer fields", () => {
	const manifest = v4Manifest();
	manifest.extensions = { "x-newer-addon": { arbitrary: ["payload", true] } };
	assert.deepEqual(parseSceneManifestV4(manifest).extensions, manifest.extensions);

	manifest.extensions = { "x-newer-addon": "x".repeat(4097) };
	assert.throws(() => parseSceneManifestV4(manifest), /4096/);

	const outside = v4Manifest();
	outside.unrecognized = true;
	assert.throws(() => parseSceneManifestV4(outside));
});
test("SceneManifestV4 rejects unpaired surrogates but accepts astral extension strings", () => {
	const highSurrogate = v4Manifest();
	highSurrogate.extensions = { "x-newer-addon": { value: "\uD800" } };
	assert.throws(() => parseSceneManifestV4(highSurrogate), /unpaired surrogate/);

	const lowSurrogate = v4Manifest();
	lowSurrogate.extensions = { "x-newer-addon": { value: "\uDC00" } };
	assert.throws(() => parseSceneManifestV4(lowSurrogate), /unpaired surrogate/);

	const astral = { "x-newer-addon": { value: "😀" } };
	const validPair = v4Manifest();
	validPair.extensions = astral;
	assert.deepEqual(parseSceneManifestV4(validPair).extensions, astral);
	assert.equal(Buffer.byteLength('{"x-newer-addon":{"value":"😀"}}', "utf8"), 34);
});
