import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canonicalRevision } from "../src/canonical.ts";
import { createProjectManifest, parseSceneSnapshot } from "../src/manifest.ts";

const EXPECTED_BLENDER_REVISION = "07dea05acce865052b3b91959cbbdb5c867d898f5ff8706b7c408fe0ad830aa5";
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
