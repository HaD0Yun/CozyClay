import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { parseSceneSnapshot } from "@oh-my-blender/protocol";
import {
	assertCanonicalSize,
	buildProjectManifest,
	buildSceneManifestRevision,
	canonicalRevision,
} from "../src/index.ts";

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
	it("builds SceneManifestV1 hashes from the hash-free preimage", () => {
		const input = {
			schemaVersion: 1 as const,
			projectId: "00000000-0000-4000-8000-000000000000",
			blenderVersion: "4.3.0",
			scene: {
				name: "Scene",
				frameStart: 1,
				frameEnd: 1,
				fpsNumerator: 24,
				fpsDenominator: 1,
				activeCameraId: null,
			},
			render: { resolutionX: 1, resolutionY: 1, resolutionPercentage: 100 },
			objects: [],
			bones: [],
			cameras: [],
			lights: [],
			markers: [],
			selectedEntityIds: [],
		};
		const manifest = buildSceneManifestRevision(input);
		assert.equal(manifest.sceneHash, canonicalRevision(input));
		assert.equal(
			manifest.revisionId,
			createHash("sha256")
				.update(`omb-revision-v1\0${input.projectId}\0${manifest.sceneHash}`, "utf8")
				.digest("hex"),
		);
		const {
			revisionId: _revisionId,
			sceneHash: _sceneHash,
			...samePreimage
		} = {
			...manifest,
			revisionId: "different-placeholder",
			sceneHash: "different-placeholder",
		};
		assert.equal(manifest.sceneHash, canonicalRevision(samePreimage));
	});
});
