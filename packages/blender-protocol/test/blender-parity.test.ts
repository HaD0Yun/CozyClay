import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canonicalRevision } from "../src/canonical-source.ts";
import { createProjectManifest, parseSceneSnapshot } from "../src/snapshot.ts";

const EXPECTED_BLENDER_REVISION = "b55013088657c73043d7fd104ba41119ab4e4c3e8bec38b861be48de304f1a17";
const fixturePath = join(import.meta.dirname, "fixtures", "blender-exported-snapshot.json");

describe("Blender-exported snapshot parity", () => {
	it("parses and reproduces the Python canonical revision", () => {
		const raw: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
		const snapshot = parseSceneSnapshot(raw);
		const manifest = createProjectManifest(snapshot);

		assert.match(manifest.revision, /^[a-f0-9]{64}$/);
		assert.equal(manifest.revision, canonicalRevision(snapshot));
		assert.equal(manifest.revision, EXPECTED_BLENDER_REVISION);
	});
});
