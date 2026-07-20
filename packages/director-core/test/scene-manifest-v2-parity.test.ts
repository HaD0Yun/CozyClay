import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { parseSceneManifestV2 } from "@oh-my-blender/protocol";
import { buildSceneManifestV2Revision } from "../src/manifest.ts";

const fixtureUrl = new URL("fixtures/scene-manifest-v2-parity.json", import.meta.url);

describe("Architecture §6 / Snapshot v2 §2.6 SceneManifestV2 cross-language parity", () => {
	it("Architecture §6 / Snapshot v2 §2.6: TypeScript reproduces Python canonical bytes and hashes", async () => {
		const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
		const parsed = parseSceneManifestV2(fixture);
		const { revisionId: _revisionId, sceneHash: _sceneHash, ...preimage } = parsed;
		const rebuilt = buildSceneManifestV2Revision(preimage);
		assert.equal(rebuilt.sceneHash, "559112581ea706ec04bffce0812c457d64236aaed05fdcf2fd8ac84a25540a35");
		assert.equal(rebuilt.sceneHash, parsed.sceneHash);
		assert.equal(rebuilt.revisionId, "92d7e869a4e824244c1d86019f2d30cba4054142543a9de0414bd806b81abaa6");
		assert.equal(rebuilt.revisionId, parsed.revisionId);
	});
});
