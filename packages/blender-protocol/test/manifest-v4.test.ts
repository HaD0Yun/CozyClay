import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSceneManifestV2, parseSceneManifestV4 } from "../src/manifest.ts";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const ASSEMBLY_ID = "33333333-3333-4333-8333-333333333333";

const v2 = parseSceneManifestV2(
	JSON.parse(
		await readFile(
			new URL("../../director-core/test/fixtures/scene-manifest-v2-parity.json", import.meta.url),
			"utf8",
		),
	),
);

function v3Manifest(): Record<string, unknown> {
	return {
		...structuredClone(v2),
		schemaVersion: 3,
		stagePrimitives: [],
		stageMaterials: [],
	};
}

function v4Manifest(): Record<string, unknown> {
	const manifest = v3Manifest();
	manifest.schemaVersion = 4;
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

test("SceneManifestV3 parses through the V4 parser with empty hierarchy defaults", () => {
	const parsed = parseSceneManifestV4(v3Manifest());
	assert.equal(parsed.schemaVersion, 4);
	assert.ok(parsed.objects.every((object) => object.parentId === null));
	assert.deepEqual(parsed.assemblies, []);
});

test("SceneManifestV4 rejects unknown fields", () => {
	const manifest = v4Manifest();
	(manifest.assemblies as Array<Record<string, unknown>>)[0]!.unknown = true;
	assert.throws(() => parseSceneManifestV4(manifest));
});
