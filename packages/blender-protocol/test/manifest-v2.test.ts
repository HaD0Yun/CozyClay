import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSceneManifestV2 } from "../src/manifest.ts";

const CAMERA_ID = "00000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);

function manifest() {
	return {
		schemaVersion: 2,
		projectId: "00000000-0000-4000-8000-000000000000",
		revisionId: HASH,
		sceneHash: HASH,
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
				location: [0, 0, 0],
				rotationQuaternion: [1, 0, 0, 0],
				scale: [1, 1, 1],
			},
		],
		bones: [],
		cameras: [
			{
				objectId: CAMERA_ID,
				lens: 50,
				sensorFit: "AUTO",
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
				target: "object",
				fcurves: [
					{
						dataPath: "location",
						arrayIndex: 0,
						keyframes: [
							{
								frame: 1,
								value: 0,
								interpolation: "BEZIER",
								handleLeft: [0.5, 0],
								handleRight: [1.5, 0],
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

describe("Architecture §6 / Snapshot v2 §2.6 SceneManifestV2", () => {
	it("Architecture §6 / Snapshot v2 §2.6: V2 is V1 plus the exact closed cameraAnimations shape", () => {
		assert.equal(parseSceneManifestV2(manifest()).schemaVersion, 2);
		assert.throws(() => parseSceneManifestV2({ ...manifest(), unknown: true }));
		const invalid = manifest();
		(invalid.cameraAnimations[0]!.fcurves[0]!.keyframes[0] as Record<string, unknown>).unknown = true;
		assert.throws(() => parseSceneManifestV2(invalid));
	});

	it("Architecture §6 / Snapshot v2 §2.6: camera animations sort by object/target, path/index, and frame", () => {
		const invalid = manifest();
		invalid.cameraAnimations[0]!.fcurves[0]!.keyframes.push({
			...invalid.cameraAnimations[0]!.fcurves[0]!.keyframes[0]!,
			frame: 0,
		});
		assert.throws(() => parseSceneManifestV2(invalid), /cameraAnimations.*semantic order/i);
	});

	it("Architecture §6 / Snapshot v2 §2.6: animation objectId references a CAMERA object", () => {
		const invalid = manifest();
		invalid.cameraAnimations[0]!.objectId = "00000000-0000-4000-8000-000000000099";
		assert.throws(() => parseSceneManifestV2(invalid), /CAMERA object/);
	});
});
