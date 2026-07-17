import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSceneSnapshot } from "../src/snapshot.ts";

const validSnapshot = {
	schemaVersion: 2,
	scene: { name: "Boxing", frameStart: 1, frameEnd: 384, fps: 24, activeCamera: "Camera" },
	render: { resolutionX: 1920, resolutionY: 1080, resolutionPercentage: 100 },
	objects: [
		{
			name: "Camera",
			type: "CAMERA",
			parent: null,
			visible: true,
			location: [0, 0, 0],
			rotationMode: "QUATERNION",
			rotationQuaternion: [1, 0, 0, 0],
			scale: [1, 1, 1],
		},
		{
			name: "Fighter",
			type: "MESH",
			parent: null,
			visible: true,
			location: [0, 0, 0],
			rotationMode: "XYZ",
			rotationQuaternion: [1, 0, 0, 0],
			scale: [1, 1, 1],
		},
	],
	cameras: [
		{
			name: "Camera",
			lens: 50,
			sensorFit: "AUTO",
			sensorWidth: 36,
			sensorHeight: 24,
			verticalFovRadians: 0.5,
			clipStart: 0.1,
			clipEnd: 100,
		},
	],
	markers: [{ name: "CUT_10", frame: 10, camera: "Camera" }],
	animations: [
		{
			objectName: "Camera",
			target: "object",
			fcurves: [
				{
					dataPath: "location",
					arrayIndex: 0,
					keyframes: [
						{ frame: 1, value: 0, interpolation: "LINEAR", handleLeft: [0, 0], handleRight: [2, 0] },
						{ frame: 10, value: 1, interpolation: "LINEAR", handleLeft: [9, 1], handleRight: [11, 1] },
					],
				},
			],
		},
	],
};

function copyValid(): any {
	return structuredClone(validSnapshot);
}

describe("scene manifest v2", () => {
	it("parses a valid document", () => {
		const snapshot = parseSceneSnapshot(validSnapshot);
		assert.equal(snapshot.scene.fps, 24);
	});

	it("rejects an unknown top-level field", () => {
		assert.throws(() => parseSceneSnapshot({ ...validSnapshot, unknown: true }));
	});

	it("rejects an unknown nested field", () => {
		const malformed = copyValid();
		malformed.scene.unknown = true;
		assert.throws(() => parseSceneSnapshot(malformed));
	});

	it("rejects duplicate object names", () => {
		const malformed = copyValid();
		malformed.objects.push(structuredClone(malformed.objects[1]));
		assert.throws(() => parseSceneSnapshot(malformed), /duplicate object name/);
	});
	it("rejects strings that are not NFC-normalized before duplicate checks", () => {
		const malformed = copyValid();
		const composed = structuredClone(malformed.objects[1]);
		composed.name = "\u00e9";
		const decomposed = structuredClone(malformed.objects[1]);
		decomposed.name = "e\u0301";
		malformed.objects = [malformed.objects[0], decomposed, composed];
		assert.throws(() => parseSceneSnapshot(malformed), /\$\.objects\[1\]\.name must be NFC-normalized/);
	});

	it("rejects a non-unit quaternion", () => {
		const malformed = copyValid();
		malformed.objects[0].rotationQuaternion = [2, 0, 0, 0];
		assert.throws(() => parseSceneSnapshot(malformed), /unit length/);
	});

	it("rejects a negative-w quaternion", () => {
		const malformed = copyValid();
		malformed.objects[0].rotationQuaternion = [-1, 0, 0, 0];
		assert.throws(() => parseSceneSnapshot(malformed), /canonical quaternion sign/);
	});

	it("rejects a zero-w quaternion whose first nonzero vector component is negative", () => {
		const malformed = copyValid();
		malformed.objects[0].rotationQuaternion = [0, -1, 0, 0];
		assert.throws(() => parseSceneSnapshot(malformed), /canonical quaternion sign/);
	});

	it("accepts a unit quaternion with canonical sign", () => {
		const snapshot = copyValid();
		snapshot.objects[0].rotationQuaternion = [0, 0, 1, 0];
		assert.deepEqual(parseSceneSnapshot(snapshot).objects[0].rotationQuaternion, [0, 0, 1, 0]);
	});

	it("rejects non-increasing keyframe frames", () => {
		const malformed = copyValid();
		malformed.animations[0].fcurves[0].keyframes[1].frame = 1;
		assert.throws(() => parseSceneSnapshot(malformed), /strictly increasing/);
	});

	it("rejects fps zero", () => {
		const malformed = copyValid();
		malformed.scene.fps = 0;
		assert.throws(() => parseSceneSnapshot(malformed));
	});

	it("rejects schemaVersion 1", () => {
		assert.throws(() => parseSceneSnapshot({ ...validSnapshot, schemaVersion: 1 }));
	});

	it("rejects unsorted objects", () => {
		const malformed = copyValid();
		malformed.objects.reverse();
		assert.throws(() => parseSceneSnapshot(malformed), /semantic order/);
	});

	it("rejects a dangling parent reference", () => {
		const malformed = copyValid();
		malformed.objects[1].parent = "Missing";
		assert.throws(() => parseSceneSnapshot(malformed), /unknown parent/);
	});

	it("rejects a dangling active camera reference", () => {
		const malformed = copyValid();
		malformed.scene.activeCamera = "Missing";
		assert.throws(() => parseSceneSnapshot(malformed), /unknown camera/);
	});
});
