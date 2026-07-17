import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProjectManifest, parseSceneSnapshot } from "../src/manifest.ts";

const validSnapshot = {
	schemaVersion: 1,
	scene: { name: "Boxing", frameStart: 1, frameEnd: 384, fps: 24 },
	objects: [
		{
			name: "Fighter",
			type: "MESH",
			location: [0, 0, 0],
			rotationEuler: [0, 0, 0],
			scale: [1, 1, 1],
			visible: true,
		},
	],
};

describe("scene manifest", () => {
	it("parses a Blender snapshot and creates a stable revision", () => {
		// Given a JSON-compatible snapshot emitted by Blender
		const snapshot = parseSceneSnapshot(validSnapshot);

		// When the same project manifest is created twice
		const first = createProjectManifest(snapshot);
		const second = createProjectManifest(snapshot);

		// Then both revisions identify the exact same scene state
		assert.match(first.revision, /^[a-f0-9]{64}$/);
		assert.deepEqual(second, first);
		assert.equal(first.snapshot.scene.fps, 24);
	});

	it("rejects malformed scene data at the process boundary", () => {
		// Given a snapshot with an invalid frame rate
		const malformed = { ...validSnapshot, scene: { ...validSnapshot.scene, fps: 0 } };

		// When parsing the boundary value, then it fails before reaching Pi
		assert.throws(() => parseSceneSnapshot(malformed));
	});
});
