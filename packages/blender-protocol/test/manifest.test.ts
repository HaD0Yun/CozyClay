import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSceneManifest } from "../src/manifest.ts";

const CAMERA_OBJECT = "00000000-0000-4000-8000-000000000001";
const CAMERA = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const MISSING = "00000000-0000-4000-8000-000000000099";
const HASH = "0".repeat(64);
const object = (entityId = CAMERA_OBJECT, type = "CAMERA") => ({
	entityId,
	name: type,
	type,
	parentId: null,
	visible: true,
	location: [0, 0, 0],
	rotationQuaternion: [1, 0, 0, 0],
	scale: [1, 1, 1],
});
const valid = {
	schemaVersion: 1,
	projectId: "00000000-0000-4000-8000-000000000000",
	revisionId: HASH,
	sceneHash: HASH,
	blenderVersion: "4.3.0",
	scene: { name: "Scene", frameStart: 1, frameEnd: 250, fpsNumerator: 24, fpsDenominator: 1, activeCameraId: CAMERA },
	render: { resolutionX: 1920, resolutionY: 1080, resolutionPercentage: 100 },
	objects: [object()],
	bones: [],
	cameras: [
		{
			entityId: CAMERA,
			objectId: CAMERA_OBJECT,
			lens: 50,
			sensorFit: "AUTO",
			sensorWidth: 36,
			sensorHeight: 24,
			verticalFovRadians: 0.5,
			clipStart: 0.1,
			clipEnd: 100,
		},
	],
	lights: [],
	markers: [{ name: "cut", frame: 1, cameraId: CAMERA }],
	selectedEntityIds: [],
};
const copy = (): any => structuredClone(valid);

describe("SceneManifestV1 canonical state (architecture section 6)", () => {
	it("accepts the minimal stable-ID manifest", () => assert.equal(parseSceneManifest(valid).schemaVersion, 1));
	it("accepts object, armature bone, light, and selected stable IDs", () => {
		const value = copy();
		value.objects.push(object(OTHER, "LIGHT"));
		value.bones.push({
			entityId: "00000000-0000-4000-8000-000000000004",
			name: "Bone",
			armatureObjectId: CAMERA_OBJECT,
			parentBoneId: null,
			location: [0, 0, 0],
			rotationQuaternion: [1, 0, 0, 0],
			scale: [1, 1, 1],
		});
		value.lights.push({
			entityId: "00000000-0000-4000-8000-000000000005",
			objectId: OTHER,
			lightType: "POINT",
			color: [1, 1, 1],
			energy: 10,
			spotSize: null,
			spotBlend: null,
		});
		value.selectedEntityIds = [CAMERA_OBJECT, CAMERA];
		assert.equal(parseSceneManifest(value).bones.length, 1);
	});
	const violations: [string, (value: any) => void, RegExp][] = [
		[
			"dangling object parentId",
			(v) => {
				v.objects[0].parentId = MISSING;
			},
			/parentId/,
		],
		[
			"dangling bone armatureObjectId",
			(v) => {
				v.bones = [
					{
						entityId: OTHER,
						name: "b",
						armatureObjectId: MISSING,
						parentBoneId: null,
						location: [0, 0, 0],
						rotationQuaternion: [1, 0, 0, 0],
						scale: [1, 1, 1],
					},
				];
			},
			/armatureObjectId/,
		],
		[
			"camera objectId not CAMERA",
			(v) => {
				v.objects[0].type = "MESH";
			},
			/CAMERA object/,
		],
		[
			"dangling camera objectId",
			(v) => {
				v.cameras[0].objectId = MISSING;
			},
			/CAMERA object/,
		],
		[
			"dangling activeCameraId",
			(v) => {
				v.scene.activeCameraId = MISSING;
			},
			/activeCameraId/,
		],
		[
			"dangling marker cameraId",
			(v) => {
				v.markers[0].cameraId = MISSING;
			},
			/unknown camera/,
		],
	];
	for (const [label, mutate, pattern] of violations)
		it(`rejects ${label} (stable-ID cross references)`, () => {
			const value = copy();
			mutate(value);
			assert.throws(() => parseSceneManifest(value), pattern);
		});
	it("rejects dangling parentBoneId", () => {
		const v = copy();
		v.bones = [
			{
				entityId: OTHER,
				name: "b",
				armatureObjectId: CAMERA_OBJECT,
				parentBoneId: MISSING,
				location: [0, 0, 0],
				rotationQuaternion: [1, 0, 0, 0],
				scale: [1, 1, 1],
			},
		];
		assert.throws(() => parseSceneManifest(v), /parentBoneId/);
	});
	it("rejects light objectId not LIGHT", () => {
		const v = copy();
		v.lights = [
			{
				entityId: OTHER,
				objectId: CAMERA_OBJECT,
				lightType: "POINT",
				color: [1, 1, 1],
				energy: 1,
				spotSize: null,
				spotBlend: null,
			},
		];
		assert.throws(() => parseSceneManifest(v), /LIGHT object/);
	});
	for (const [kind, size, blend] of [
		["POINT", 1, null],
		["SPOT", null, null],
	])
		it(`rejects invalid ${kind} spot fields`, () => {
			const v = copy();
			v.objects.push(object(OTHER, "LIGHT"));
			v.lights = [
				{
					entityId: "00000000-0000-4000-8000-000000000004",
					objectId: OTHER,
					lightType: kind,
					color: [1, 1, 1],
					energy: 1,
					spotSize: size,
					spotBlend: blend,
				},
			];
			assert.throws(() => parseSceneManifest(v), /if and only if/);
		});
	for (const field of ["objects", "bones", "cameras"] as const)
		it(`rejects out-of-order ${field}`, () => {
			const v = copy();
			if (field === "objects") v.objects = [object(OTHER, "MESH"), ...v.objects];
			else if (field === "bones")
				v.bones = [
					{
						entityId: OTHER,
						name: "b",
						armatureObjectId: CAMERA_OBJECT,
						parentBoneId: null,
						location: [0, 0, 0],
						rotationQuaternion: [1, 0, 0, 0],
						scale: [1, 1, 1],
					},
					{
						entityId: CAMERA,
						name: "a",
						armatureObjectId: CAMERA_OBJECT,
						parentBoneId: null,
						location: [0, 0, 0],
						rotationQuaternion: [1, 0, 0, 0],
						scale: [1, 1, 1],
					},
				];
			else
				v[field] = [
					{ ...v[field][0], entityId: OTHER },
					{ ...v[field][0], entityId: CAMERA },
				];
			assert.throws(() => parseSceneManifest(v), /semantic order/);
		});
	it("rejects out-of-order lights", () => {
		const v = copy();
		const lightObjectA = OTHER;
		const lightObjectB = "00000000-0000-4000-8000-000000000004";
		v.objects.push(object(lightObjectA, "LIGHT"), object(lightObjectB, "LIGHT"));
		const light = { lightType: "POINT", color: [1, 1, 1], energy: 1, spotSize: null, spotBlend: null };
		v.lights = [
			{ ...light, entityId: "00000000-0000-4000-8000-000000000006", objectId: lightObjectA },
			{ ...light, entityId: "00000000-0000-4000-8000-000000000005", objectId: lightObjectB },
		];
		assert.throws(() => parseSceneManifest(v), /semantic order/);
	});
	it("rejects out-of-order and duplicate selectedEntityIds", () => {
		const v = copy();
		v.selectedEntityIds = [OTHER, CAMERA];
		assert.throws(() => parseSceneManifest(v), /semantic order/);
		v.selectedEntityIds = [CAMERA, CAMERA];
		assert.throws(() => parseSceneManifest(v), /duplicates/);
	});
	for (const field of ["objects", "bones"] as const)
		for (const quaternion of [
			[2, 0, 0, 0],
			[-1, 0, 0, 0],
		])
			it(`rejects ${field} non-unit/non-canonical quaternion`, () => {
				const v = copy();
				if (field === "bones")
					v.bones = [
						{
							entityId: OTHER,
							name: "b",
							armatureObjectId: CAMERA_OBJECT,
							parentBoneId: null,
							location: [0, 0, 0],
							rotationQuaternion: quaternion,
							scale: [1, 1, 1],
						},
					];
				else v.objects[0].rotationQuaternion = quaternion;
				assert.throws(() => parseSceneManifest(v), /unit length|canonical quaternion sign/);
			});
	it("rejects unknown top-level and nested fields", () => {
		assert.throws(() => parseSceneManifest({ ...valid, unknown: true }));
		const v = copy();
		v.scene.unknown = true;
		assert.throws(() => parseSceneManifest(v));
	});
});
