import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { parseSceneSnapshot } from "@cclay/protocol";
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
		assert.equal(manifest.revision, "be8b5bc1f52ad393d57e7b37242909fa5d30e161ca44741d604b8ac9777dee48");
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
		const { selectedEntityIds: _selectedEntityIds, blenderVersion: _blenderVersion, ...hashPreimage } = input;
		assert.equal(manifest.sceneHash, canonicalRevision(hashPreimage));
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
		const { selectedEntityIds: _selection, blenderVersion: _runtimeVersion, ...sameDurablePreimage } = samePreimage;
		assert.equal(manifest.sceneHash, canonicalRevision(sameDurablePreimage));
	});
	it("keeps scene content addresses stable across Blender upgrades", () => {
		const input = {
			schemaVersion: 1 as const,
			projectId: "00000000-0000-4000-8000-000000000000",
			blenderVersion: "5.1.2",
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
		assert.equal(
			buildSceneManifestRevision(input).sceneHash,
			buildSceneManifestRevision({ ...input, blenderVersion: "5.2.0 LTS" }).sceneHash,
		);
	});
	it("strips a runtime-present revisionId/sceneHash before hashing, not just at the type level", () => {
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
		const clean = buildSceneManifestRevision(input);
		// A caller passes an object that ALREADY has (bogus, stale) hash fields
		// at runtime -- e.g. from spreading a previously-hashed manifest. The
		// TS `Omit<...>` parameter type does not prevent this at runtime.
		const polluted = { ...input, revisionId: "f".repeat(64), sceneHash: "f".repeat(64) } as unknown as Parameters<
			typeof buildSceneManifestRevision
		>[0];
		const rebuilt = buildSceneManifestRevision(polluted);
		assert.equal(rebuilt.sceneHash, clean.sceneHash, "polluted input must hash identically to hash-free input");
		assert.equal(rebuilt.revisionId, clean.revisionId);
	});
	it("validates the hash-free input before hashing and rejects malformed order", () => {
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
			objects: [
				{
					entityId: `${"b".repeat(8)}-0000-4000-8000-000000000000`,
					name: "b",
					type: "MESH",
					parentId: null,
					visible: true,
					location: [0, 0, 0],
					rotationQuaternion: [1, 0, 0, 0],
					scale: [1, 1, 1],
				},
				{
					entityId: `${"a".repeat(8)}-0000-4000-8000-000000000000`,
					name: "a",
					type: "MESH",
					parentId: null,
					visible: true,
					location: [0, 0, 0],
					rotationQuaternion: [1, 0, 0, 0],
					scale: [1, 1, 1],
				},
			],
			bones: [],
			cameras: [],
			lights: [],
			markers: [],
			selectedEntityIds: [],
		};
		assert.throws(
			() => buildSceneManifestRevision(input as unknown as Parameters<typeof buildSceneManifestRevision>[0]),
			/semantic order/,
		);
	});
});
