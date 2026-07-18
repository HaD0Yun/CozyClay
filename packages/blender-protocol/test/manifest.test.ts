import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSceneManifest } from "../src/manifest.ts";

const CAMERA_OBJECT = "00000000-0000-4000-8000-000000000001";
const ARMATURE_OBJECT = "00000000-0000-4000-8000-000000000002";
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
const bone = (entityId: string, armatureObjectId: string, parentBoneId: string | null = null) => ({
	entityId,
	name: "b",
	armatureObjectId,
	parentBoneId,
	location: [0, 0, 0],
	rotationQuaternion: [1, 0, 0, 0],
	scale: [1, 1, 1],
});
const camera = (objectId = CAMERA_OBJECT) => ({
	objectId,
	lens: 50,
	sensorFit: "AUTO",
	sensorWidth: 36,
	sensorHeight: 24,
	verticalFovRadians: 0.5,
	clipStart: 0.1,
	clipEnd: 100,
});
const light = (
	objectId: string,
	lightType = "POINT",
	spotSize: number | null = null,
	spotBlend: number | null = null,
) => ({
	objectId,
	lightType,
	color: [1, 1, 1],
	energy: 10,
	spotSize,
	spotBlend,
});

const valid = {
	schemaVersion: 1,
	projectId: "00000000-0000-4000-8000-000000000000",
	revisionId: HASH,
	sceneHash: HASH,
	blenderVersion: "4.3.0",
	scene: {
		name: "Scene",
		frameStart: 1,
		frameEnd: 250,
		fpsNumerator: 24,
		fpsDenominator: 1,
		activeCameraId: CAMERA_OBJECT,
	},
	render: { resolutionX: 1920, resolutionY: 1080, resolutionPercentage: 100 },
	objects: [object()],
	bones: [],
	cameras: [camera()],
	lights: [],
	markers: [{ name: "cut", frame: 1, cameraId: CAMERA_OBJECT }],
	selectedEntityIds: [],
};
const copy = (): any => structuredClone(valid);

describe("SceneManifestV1 canonical state (architecture section 6)", () => {
	it("accepts the minimal stable-ID manifest", () => assert.equal(parseSceneManifest(valid).schemaVersion, 1));

	it("accepts object, armature bone, light, and selected stable IDs (camera/light identity is the owning object id)", () => {
		const value = copy();
		value.objects.push(object(ARMATURE_OBJECT, "ARMATURE"), object(OTHER, "LIGHT"));
		value.bones.push(bone("00000000-0000-4000-8000-000000000004", ARMATURE_OBJECT));
		value.lights.push(light(OTHER));
		value.selectedEntityIds = [CAMERA_OBJECT, ARMATURE_OBJECT];
		const parsed = parseSceneManifest(value);
		assert.equal(parsed.bones.length, 1);
		assert.equal((parsed.cameras[0] as { objectId: string }).objectId, CAMERA_OBJECT);
		assert.equal((parsed.lights[0] as { objectId: string }).objectId, OTHER);
		assert.ok(!("entityId" in parsed.cameras[0]!));
		assert.ok(!("entityId" in parsed.lights[0]!));
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
				v.bones = [bone(OTHER, MISSING)];
			},
			/armatureObjectId/,
		],
		[
			"bone armatureObjectId references a non-ARMATURE object",
			(v) => {
				v.bones = [bone(OTHER, CAMERA_OBJECT)];
			},
			/ARMATURE object/,
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
				v.objects[0].type = "MESH";
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
		[
			"dangling parentBoneId",
			(v) => {
				v.objects.push(object(ARMATURE_OBJECT, "ARMATURE"));
				v.bones = [bone(OTHER, ARMATURE_OBJECT, MISSING)];
			},
			/parentBoneId/,
		],
		[
			"light objectId not LIGHT",
			(v) => {
				v.lights = [light(CAMERA_OBJECT)];
			},
			/LIGHT object/,
		],
		[
			"missing light entry for a LIGHT object",
			(v) => {
				v.objects.push(object(OTHER, "LIGHT"));
			},
			/LIGHT object must have exactly one/,
		],
		[
			"duplicate camera entry for the same object",
			(v) => {
				v.cameras.push(camera());
			},
			/duplicate/,
		],
		[
			"duplicate light entry for the same object",
			(v) => {
				v.objects.push(object(OTHER, "LIGHT"));
				v.lights = [light(OTHER), light(OTHER)];
			},
			/duplicate/,
		],
		[
			"unknown top-level field",
			(v) => {
				v.unknown = true;
			},
			/./,
		],
		[
			"unknown nested field",
			(v) => {
				v.scene.unknown = true;
			},
			/./,
		],
		[
			"non-reduced fps rational",
			(v) => {
				v.scene.fpsNumerator = 48;
				v.scene.fpsDenominator = 2;
			},
			/reduced rational/,
		],
		[
			"non-NFC object name",
			(v) => {
				v.objects[0].name = "e\u0301";
			},
			/NFC/,
		],
	];
	for (const [label, mutate, pattern] of violations) {
		it(`rejects ${label}`, () => {
			const value = copy();
			mutate(value);
			assert.throws(() => parseSceneManifest(value), pattern);
		});
	}

	for (const [kind, size, blend] of [
		["POINT", 1, null],
		["SPOT", null, null],
	] as const) {
		it(`rejects invalid ${kind} spot fields`, () => {
			const v = copy();
			v.objects.push(object(OTHER, "LIGHT"));
			v.lights = [light(OTHER, kind, size, blend)];
			assert.throws(() => parseSceneManifest(v), /if and only if/);
		});
	}

	for (const field of ["objects", "bones", "cameras", "lights"] as const) {
		it(`rejects out-of-order ${field}`, () => {
			const v = copy();
			if (field === "objects") {
				v.objects = [object(OTHER, "MESH"), ...v.objects];
			} else if (field === "bones") {
				v.objects.push(object(ARMATURE_OBJECT, "ARMATURE"));
				v.bones = [bone(OTHER, ARMATURE_OBJECT), bone(CAMERA_OBJECT, ARMATURE_OBJECT)];
			} else if (field === "cameras") {
				v.objects.push(object(OTHER, "CAMERA"));
				v.cameras = [camera(OTHER), camera(CAMERA_OBJECT)];
			} else {
				v.objects.push(object(ARMATURE_OBJECT, "LIGHT"), object(OTHER, "LIGHT"));
				v.lights = [light(OTHER), light(ARMATURE_OBJECT)];
			}
			assert.throws(() => parseSceneManifest(v), /semantic order/);
		});
	}

	it("rejects out-of-order and duplicate selectedEntityIds", () => {
		const v = copy();
		v.objects.push(object(OTHER, "MESH"));
		v.selectedEntityIds = [OTHER, CAMERA_OBJECT];
		assert.throws(() => parseSceneManifest(v), /semantic order/);
		v.selectedEntityIds = [CAMERA_OBJECT, CAMERA_OBJECT];
		assert.throws(() => parseSceneManifest(v), /duplicates/);
	});

	for (const target of ["objects", "bones"] as const) {
		for (const quaternion of [
			[2, 0, 0, 0],
			[-1, 0, 0, 0],
		]) {
			it(`rejects ${target} non-unit/non-canonical quaternion`, () => {
				const v = copy();
				if (target === "bones") {
					v.objects.push(object(ARMATURE_OBJECT, "ARMATURE"));
					v.bones = [{ ...bone(OTHER, ARMATURE_OBJECT), rotationQuaternion: quaternion }];
				} else {
					v.objects[0].rotationQuaternion = quaternion;
				}
				assert.throws(() => parseSceneManifest(v), /unit length|canonical quaternion sign/);
			});
		}
	}
});
