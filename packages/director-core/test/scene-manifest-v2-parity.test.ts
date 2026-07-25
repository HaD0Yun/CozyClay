import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { parseSceneManifestV2 } from "@cclay/protocol";
import { buildSceneManifestV2Revision } from "../src/manifest.ts";

const fixtureUrl = new URL("fixtures/scene-manifest-v2-parity.json", import.meta.url);

describe("Architecture §6 / Snapshot v2 §2.6 SceneManifestV2 cross-language parity", () => {
	it("Architecture §6 / Snapshot v2 §2.6: TypeScript reproduces Python canonical bytes and hashes", async () => {
		const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
		const parsed = parseSceneManifestV2(fixture);
		const { revisionId: _revisionId, sceneHash: _sceneHash, ...preimage } = parsed;
		const rebuilt = buildSceneManifestV2Revision(preimage);
		assert.equal(rebuilt.sceneHash, "6639e6f51d566f8ef2cf2c7384d2e71bd66e3d5d17bb849a398cf8d38c2d4428");
		assert.equal(rebuilt.sceneHash, parsed.sceneHash);
		assert.equal(rebuilt.revisionId, "4980333b4c20af4822ac222977ae82108fd637c719110f8a439501e37c26c7ab");
		assert.equal(rebuilt.revisionId, parsed.revisionId);
	});
});
