import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { parseSceneSnapshot } from "@oh-my-blender/protocol";
import { assertCanonicalSize, buildProjectManifest, canonicalRevision } from "../src/index.ts";

const fixtureUrl = new URL("../../blender-protocol/test/fixtures/blender-exported-snapshot.json", import.meta.url);

describe("project manifest", () => {
	it("builds the Blender-parity revision", async () => {
		const snapshot = parseSceneSnapshot(JSON.parse(await readFile(fixtureUrl, "utf8")));
		const manifest = buildProjectManifest(snapshot);
		assert.equal(manifest.revision, "b55013088657c73043d7fd104ba41119ab4e4c3e8bec38b861be48de304f1a17");
		assert.equal(manifest.revision, canonicalRevision(snapshot));
		assert.equal(manifest.snapshot, snapshot);
	});

	it("rejects canonical snapshots larger than 1 MiB", async () => {
		const snapshot = parseSceneSnapshot(JSON.parse(await readFile(fixtureUrl, "utf8")));
		const oversized = { ...snapshot, scene: { ...snapshot.scene, name: "x".repeat(1_048_576) } };
		assert.throws(() => assertCanonicalSize(oversized), /SNAPSHOT_TOO_LARGE/);
	});
});
