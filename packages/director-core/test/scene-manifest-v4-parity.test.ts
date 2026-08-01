import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseSceneManifestV4 } from "@cclay/protocol";
import { buildSceneManifestV4Revision } from "../src/index.ts";

// Cross-language V4 manifest parity.
//
// Stage 1 deleted the V1/V2 parity suites along with their wire schemas, which
// removed the general "do Python and TypeScript agree on a manifest's hash and
// revision" coverage. The Stage 1 golden oracle only pins a single flat scene,
// and a flat scene deliberately hashes through the V3-shaped preimage -- so on
// its own it cannot detect a divergence that only shows up once a scene has
// hierarchy.
//
// Both fixtures below carry sceneHash/revisionId produced by the Python add-on
// (blender-addon/cclay/scene_manifest.py). These tests assert the TypeScript
// builder reproduces them byte-identically from the same inputs. A failure here
// means the two canonicalizers have drifted, which is exactly the guarantee the
// plan kept when it withdrew the canonical-hash-parity deletion.

const PARENT_REVISION = "d".repeat(64);

function loadFixture(name: string) {
	const raw: unknown = JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
	const parsed = parseSceneManifestV4(raw);
	const { revisionId, sceneHash, ...hashFree } = parsed;
	return { recorded: { revisionId, sceneHash }, hashFree };
}

describe("cross-language V4 manifest parity", () => {
	it("reproduces the Python-produced hash for a hierarchy-free scene", () => {
		const { recorded, hashFree } = loadFixture("scene-manifest-v4-parity.json");
		// The flat fixture's recorded values were minted as an initial revision,
		// so only the content hash is comparable here; the hierarchical case
		// below covers the child-revision derivation.
		const built = buildSceneManifestV4Revision(hashFree, PARENT_REVISION, { schema_version: 1, operations: [] });
		assert.equal(built.sceneHash, recorded.sceneHash);
	});

	it("reproduces the Python-produced hash and child revision for a scene with hierarchy", () => {
		const { recorded, hashFree } = loadFixture("scene-manifest-v4-hierarchy-parity.json");
		const parented = hashFree.objects.filter((object) => object.parentId !== null);
		assert.ok(parented.length > 0, "fixture must carry real hierarchy or it exercises the flat preimage path");
		const operation = {
			schema_version: 1,
			expected_revision_id: PARENT_REVISION,
			operations: [
				{
					op: "set_parent",
					entity_id: "00000000-0000-4000-8000-000000000001",
					parent_id: "00000000-0000-4000-8000-000000000002",
				},
			],
		};
		const built = buildSceneManifestV4Revision(hashFree, PARENT_REVISION, operation);
		assert.equal(built.sceneHash, recorded.sceneHash);
		assert.equal(built.revisionId, recorded.revisionId);
	});

	it("hashes the hierarchical scene differently from the flat one", () => {
		// Guards the preimage split itself: if hierarchy stopped affecting the
		// preimage, both fixtures would collapse to the same hash and the test
		// above would still pass for the wrong reason.
		const flat = loadFixture("scene-manifest-v4-parity.json");
		const hierarchical = loadFixture("scene-manifest-v4-hierarchy-parity.json");
		assert.notEqual(flat.recorded.sceneHash, hierarchical.recorded.sceneHash);
	});
});
