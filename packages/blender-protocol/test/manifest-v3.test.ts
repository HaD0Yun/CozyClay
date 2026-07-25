import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSceneManifestV2, parseSceneManifestV3 } from "../src/manifest.ts";

const v2 = parseSceneManifestV2(
	JSON.parse(
		await readFile(
			new URL("../../director-core/test/fixtures/scene-manifest-v2-parity.json", import.meta.url),
			"utf8",
		),
	),
);

function stagedManifest(): Record<string, unknown> {
	return {
		...structuredClone(v2),
		schemaVersion: 3,
		stagePrimitives: [
			{
				objectId: "00000000-0000-4000-8000-000000000002",
				primitiveType: "CUBE",
			},
		],
		stageMaterials: [
			{
				objectId: "00000000-0000-4000-8000-000000000002",
				materialName: "CCLAY Material 00000000",
				baseColor: [0.12, 0.18, 0.3, 1],
				useNodes: true,
				principledBaseColor: [0.12, 0.18, 0.3, 1],
			},
		],
	};
}

test("SceneManifestV3 minimally hashes staged primitive and material state", () => {
	const manifest = parseSceneManifestV3(stagedManifest());
	assert.equal(manifest.schemaVersion, 3);
	assert.equal(manifest.stagePrimitives[0]?.primitiveType, "CUBE");
	assert.deepEqual(manifest.stageMaterials[0]?.baseColor, [0.12, 0.18, 0.3, 1]);
	assert.equal(manifest.stageMaterials[0]?.useNodes, true);
	assert.deepEqual(manifest.stageMaterials[0]?.principledBaseColor, [0.12, 0.18, 0.3, 1]);
});

test("V3 stage arrays remain closed and reference scene objects", () => {
	const unknown = stagedManifest();
	(unknown.stagePrimitives as Array<Record<string, unknown>>)[0]!.objectId = "99999999-9999-4999-8999-999999999999";
	assert.throws(() => parseSceneManifestV3(unknown), /stagePrimitives entry must reference a MESH object/);

	const extra = stagedManifest();
	(extra.stageMaterials as Array<Record<string, unknown>>)[0]!.roughness = 0.5;
	assert.throws(() => parseSceneManifestV3(extra));
});

test("V2 negotiation remains unchanged", () => {
	assert.equal(parseSceneManifestV2(v2).schemaVersion, 2);
	assert.throws(() => parseSceneManifestV3(v2));
});
