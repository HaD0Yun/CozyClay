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
		assert.equal(rebuilt.sceneHash, "fc2615b638ee023e6648fa5761a251fd1d2f85e857442243eb74b53e37ddc739");
		assert.equal(rebuilt.sceneHash, parsed.sceneHash);
		assert.equal(rebuilt.revisionId, "232f91e79494865fa4f664cf164ae66b6602b57d8d7a82d1d47ff84c900d1ac2");
		assert.equal(rebuilt.revisionId, parsed.revisionId);
	});
});
