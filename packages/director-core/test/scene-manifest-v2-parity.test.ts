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
		assert.equal(rebuilt.sceneHash, "f65db0255801e77b209e1019a70d9d1bb4e82fe37e709ead111290934a8b8816");
		assert.equal(rebuilt.sceneHash, parsed.sceneHash);
		assert.equal(rebuilt.revisionId, "ca8d4e064f2e3391958eeb0a7885cc4cd92f9d15d39cf2950909ec6294903ca3");
		assert.equal(rebuilt.revisionId, parsed.revisionId);
	});
});
