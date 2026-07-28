import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSceneManifestV2Revision, canonicalRevision } from "../src/index.ts";

const CAMERA_ID = "00000000-0000-4000-8000-000000000001";

function input() {
	return {
		schemaVersion: 2 as const,
		projectId: "00000000-0000-4000-8000-000000000000",
		blenderVersion: "4.3.0",
		scene: {
			name: "Scene",
			frameStart: 1,
			frameEnd: 24,
			fpsNumerator: 24,
			fpsDenominator: 1,
			activeCameraId: CAMERA_ID,
		},
		render: { resolutionX: 1920, resolutionY: 1080, resolutionPercentage: 100 },
		objects: [
			{
				entityId: CAMERA_ID,
				name: "Camera",
				type: "CAMERA",
				parentId: null,
				visible: true,
				location: [0, 0, 0] as [number, number, number],
				rotationQuaternion: [1, 0, 0, 0] as [number, number, number, number],
				scale: [1, 1, 1] as [number, number, number],
			},
		],
		bones: [],
		cameras: [
			{
				objectId: CAMERA_ID,
				lens: 50,
				sensorFit: "AUTO" as const,
				sensorWidth: 36,
				sensorHeight: 24,
				verticalFovRadians: 0.5,
				clipStart: 0.1,
				clipEnd: 1000,
			},
		],
		lights: [],
		markers: [],
		selectedEntityIds: [],
		cameraAnimations: [
			{
				objectId: CAMERA_ID,
				target: "cameraData" as const,
				fcurves: [
					{
						dataPath: "angle",
						arrayIndex: 0,
						keyframes: [
							{
								frame: 1,
								value: 0.5,
								interpolation: "BEZIER",
								handleLeft: [0.5, 0.5] as [number, number],
								handleRight: [1.5, 0.5] as [number, number],
								handleLeftType: "AUTO_CLAMPED",
								handleRightType: "AUTO_CLAMPED",
							},
						],
					},
				],
			},
		],
	};
}

describe("Architecture §6 / Snapshot v2 §2.6 canonical SceneManifestV2", () => {
	it("hashes durable V2 state while excluding reported selection", () => {
		const baseline = buildSceneManifestV2Revision(input());
		const selectedInput = { ...input(), selectedEntityIds: [CAMERA_ID] };
		const selected = buildSceneManifestV2Revision(selectedInput);
		const {
			revisionId: _revisionId,
			sceneHash: _sceneHash,
			selectedEntityIds: _selection,
			blenderVersion: _blenderVersion,
			...preimage
		} = selected;
		assert.equal(selected.sceneHash, canonicalRevision(preimage));
		assert.equal(selected.sceneHash, baseline.sceneHash);
		assert.equal(selected.revisionId, baseline.revisionId);
		assert.deepEqual(selected.selectedEntityIds, [CAMERA_ID]);
	});
	it("exact-parses a valid hash-free V2 manifest before hashing", () => {
		const manifestInput = input();
		const manifest = buildSceneManifestV2Revision(manifestInput);
		const { revisionId: _revisionId, sceneHash: _sceneHash, ...hashFree } = manifest;
		assert.deepEqual(hashFree, manifestInput);
	});

	it("rejects unknown top-level fields before hashing", () => {
		const manifestInput = Object.assign(input(), { unexpected: true });
		assert.throws(() => buildSceneManifestV2Revision(manifestInput));
	});

	it("rejects unknown nested camera animation fields before hashing", () => {
		const manifestInput = input();
		Object.assign(manifestInput.cameraAnimations[0]!, { unexpected: true });
		assert.throws(() => buildSceneManifestV2Revision(manifestInput));
	});

	it("rejects the wrong V2 schemaVersion before hashing", () => {
		const manifestInput = { ...input(), schemaVersion: 3 };
		assert.throws(() => buildSceneManifestV2Revision(manifestInput as unknown as ReturnType<typeof input>));
	});

	it("Architecture §6 / Snapshot v2 §2.6: changing only camera f-curves necessarily changes scene_hash", () => {
		const baseline = buildSceneManifestV2Revision(input());
		const changedInput = input();
		changedInput.cameraAnimations[0]!.fcurves[0]!.keyframes[0]!.handleRight[1] = 0.75;
		const changed = buildSceneManifestV2Revision(changedInput);
		assert.notEqual(changed.sceneHash, baseline.sceneHash);
		assert.notEqual(changed.revisionId, baseline.revisionId);
	});

	it("changing an object transform changes scene_hash", () => {
		const baseline = buildSceneManifestV2Revision(input());
		const movedInput = input();
		movedInput.objects[0]!.location[0] = 1;
		const moved = buildSceneManifestV2Revision(movedInput);
		assert.notEqual(moved.sceneHash, baseline.sceneHash);
	});
});
