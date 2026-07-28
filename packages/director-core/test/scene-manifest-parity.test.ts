import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseSceneManifest } from "@cclay/protocol";
import { buildSceneManifestRevision } from "../src/manifest.ts";

const fixturesDirectory = join(import.meta.dirname, "fixtures");

// Committed by blender-addon/cclay/scene_manifest.py's
// build_scene_manifest()/finalize_scene_manifest() (Python, no Blender
// required to regenerate: see the Python-side parity test for the exact
// producer inputs). Proves architecture doc section 6's cross-language
// hashing contract for SceneManifestV1: sceneHash/revisionId are byte-
// identical regardless of which language assembled and hashed the manifest.
const fixture = JSON.parse(readFileSync(join(fixturesDirectory, "scene-manifest-v1-parity.json"), "utf8")) as Record<
	string,
	unknown
>;

describe("SceneManifestV1 cross-language revision parity (architecture doc section 6)", () => {
	it("reproduces the Python-computed sceneHash/revisionId for the shared fixture", () => {
		// Given the Python-finalized fixture, strip its own hash fields to get
		// back the exact preimage buildSceneManifestRevision expects.
		const { revisionId: _pythonRevisionId, sceneHash: _pythonSceneHash, ...withoutHashes } = fixture;
		const rebuilt = buildSceneManifestRevision(withoutHashes as never);
		assert.equal(rebuilt.sceneHash, fixture.sceneHash, "sceneHash must match the Python-computed value");
		assert.equal(rebuilt.revisionId, fixture.revisionId, "revisionId must match the Python-computed value");
	});

	it("the rebuilt manifest still parses and validates as a well-formed SceneManifestV1", () => {
		const { revisionId: _pythonRevisionId, sceneHash: _pythonSceneHash, ...withoutHashes } = fixture;
		const rebuilt = buildSceneManifestRevision(withoutHashes as never);
		assert.equal(parseSceneManifest(rebuilt).schemaVersion, 1);
	});
});
