import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";
import { validateQuaternion } from "./snapshot.ts";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const HASH_64 = "^[0-9a-f]{64}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const uuid = () => Type.String({ pattern: UUID_V4_LOWERCASE });
const nullableUuid = () => Type.Union([uuid(), Type.Null()]);
const vector3 = () => Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);
const quaternion = () => Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]);
const name = () => Type.String({ minLength: 1, maxLength: 256 });

const SceneSchema = exact({
	name: name(),
	frameStart: Type.Integer({ minimum: 0, maximum: 1_048_574 }),
	frameEnd: Type.Integer({ minimum: 0, maximum: 1_048_574 }),
	fpsNumerator: Type.Integer({ minimum: 1 }),
	fpsDenominator: Type.Integer({ minimum: 1 }),
	activeCameraId: nullableUuid(),
});
const RenderSchema = exact({
	resolutionX: Type.Integer({ minimum: 1, maximum: 65_536 }),
	resolutionY: Type.Integer({ minimum: 1, maximum: 65_536 }),
	resolutionPercentage: Type.Integer({ minimum: 1, maximum: 100 }),
});
const ObjectSchema = exact({
	entityId: uuid(),
	name: name(),
	type: Type.String({ minLength: 1 }),
	parentId: nullableUuid(),
	visible: Type.Boolean(),
	location: vector3(),
	rotationQuaternion: quaternion(),
	scale: vector3(),
});
const BoneSchema = exact({
	entityId: uuid(),
	name: name(),
	armatureObjectId: uuid(),
	parentBoneId: nullableUuid(),
	location: vector3(),
	rotationQuaternion: quaternion(),
	scale: vector3(),
});
const CameraSchema = exact({
	entityId: uuid(),
	objectId: uuid(),
	lens: Type.Number({ exclusiveMinimum: 0 }),
	sensorFit: Type.Union([Type.Literal("AUTO"), Type.Literal("HORIZONTAL"), Type.Literal("VERTICAL")]),
	sensorWidth: Type.Number({ exclusiveMinimum: 0 }),
	sensorHeight: Type.Number({ exclusiveMinimum: 0 }),
	verticalFovRadians: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: Math.PI }),
	clipStart: Type.Number({ exclusiveMinimum: 0 }),
	clipEnd: Type.Number({ exclusiveMinimum: 0 }),
});
const LightSchema = exact({
	entityId: uuid(),
	objectId: uuid(),
	lightType: Type.Union([Type.Literal("POINT"), Type.Literal("SUN"), Type.Literal("SPOT"), Type.Literal("AREA")]),
	color: Type.Tuple([
		Type.Number({ minimum: 0, maximum: 1 }),
		Type.Number({ minimum: 0, maximum: 1 }),
		Type.Number({ minimum: 0, maximum: 1 }),
	]),
	energy: Type.Number({ minimum: 0 }),
	spotSize: Type.Union([Type.Number(), Type.Null()]),
	spotBlend: Type.Union([Type.Number(), Type.Null()]),
});
const MarkerSchema = exact({ name: name(), frame: Type.Integer(), cameraId: nullableUuid() });

export const SceneManifestV1Schema = exact({
	schemaVersion: Type.Literal(1),
	projectId: uuid(),
	revisionId: Type.String({ pattern: HASH_64 }),
	sceneHash: Type.String({ pattern: HASH_64 }),
	blenderVersion: Type.String(),
	scene: SceneSchema,
	render: RenderSchema,
	objects: Type.Array(ObjectSchema),
	bones: Type.Array(BoneSchema),
	cameras: Type.Array(CameraSchema),
	lights: Type.Array(LightSchema),
	markers: Type.Array(MarkerSchema),
	selectedEntityIds: Type.Array(uuid()),
});
export type SceneManifestV1 = Static<typeof SceneManifestV1Schema>;

function compareCodePoints(left: string, right: string): number {
	const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
	const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
	for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
		if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
	}
	return leftPoints.length - rightPoints.length;
}
function compareNullable(left: string | null, right: string | null): number {
	if (left === right) return 0;
	if (left === null) return -1;
	if (right === null) return 1;
	return compareCodePoints(left, right);
}
function assertSorted<T>(values: readonly T[], compare: (left: T, right: T) => number, label: string): void {
	for (let index = 1; index < values.length; index += 1) {
		if (compare(values[index - 1]!, values[index]!) > 0) throw new Error(`${label} must be in semantic order`);
	}
}
function assertUniqueIds<T extends { entityId: string }>(values: readonly T[], label: string): void {
	const ids = new Set<string>();
	for (const value of values) {
		if (ids.has(value.entityId)) throw new Error(`duplicate ${label} entityId: ${value.entityId}`);
		ids.add(value.entityId);
	}
}

export function validateManifest(manifest: SceneManifestV1): void {
	if (manifest.scene.name !== manifest.scene.name.normalize("NFC"))
		throw new Error("scene.name must be NFC-normalized");
	if (manifest.scene.frameStart > manifest.scene.frameEnd)
		throw new Error("scene.frameStart must not exceed scene.frameEnd");
	const byEntityId = (left: { entityId: string }, right: { entityId: string }) =>
		compareCodePoints(left.entityId, right.entityId);
	assertSorted(manifest.objects, byEntityId, "entity array");
	assertSorted(manifest.bones, byEntityId, "entity array");
	assertSorted(manifest.cameras, byEntityId, "entity array");
	assertSorted(manifest.lights, byEntityId, "entity array");
	assertSorted(
		manifest.markers,
		(left, right) =>
			compareCodePoints(left.name, right.name) ||
			left.frame - right.frame ||
			compareNullable(left.cameraId, right.cameraId),
		"markers",
	);
	assertSorted(manifest.selectedEntityIds, compareCodePoints, "selectedEntityIds");
	for (let index = 1; index < manifest.selectedEntityIds.length; index += 1) {
		if (manifest.selectedEntityIds[index - 1] === manifest.selectedEntityIds[index])
			throw new Error("selectedEntityIds must not contain duplicates");
	}
	assertUniqueIds(manifest.objects, "object");
	assertUniqueIds(manifest.bones, "bone");
	assertUniqueIds(manifest.cameras, "camera");
	assertUniqueIds(manifest.lights, "light");
	const objects = new Map(manifest.objects.map((object) => [object.entityId, object]));
	const bones = new Set(manifest.bones.map((bone) => bone.entityId));
	const cameras = new Map(manifest.cameras.map((camera) => [camera.entityId, camera]));
	for (const object of manifest.objects) {
		validateQuaternion(object.rotationQuaternion, `objects[${JSON.stringify(object.entityId)}].rotationQuaternion`);
		if (object.parentId !== null && !objects.has(object.parentId))
			throw new Error(`object ${object.entityId} has unknown parentId: ${object.parentId}`);
	}
	for (const bone of manifest.bones) {
		validateQuaternion(bone.rotationQuaternion, `bones[${JSON.stringify(bone.entityId)}].rotationQuaternion`);
		if (!objects.has(bone.armatureObjectId))
			throw new Error(`bone ${bone.entityId} has unknown armatureObjectId: ${bone.armatureObjectId}`);
		if (bone.parentBoneId !== null && !bones.has(bone.parentBoneId))
			throw new Error(`bone ${bone.entityId} has unknown parentBoneId: ${bone.parentBoneId}`);
	}
	const cameraObjectIds = new Set<string>();
	for (const camera of manifest.cameras) {
		if (objects.get(camera.objectId)?.type !== "CAMERA")
			throw new Error(`camera ${camera.entityId} must reference a CAMERA object`);
		if (cameraObjectIds.has(camera.objectId))
			throw new Error(`CAMERA object ${camera.objectId} must have exactly one camera entry`);
		cameraObjectIds.add(camera.objectId);
		if (camera.clipEnd <= camera.clipStart)
			throw new Error(`camera ${camera.entityId} clipEnd must be greater than clipStart`);
	}
	for (const object of manifest.objects)
		if (object.type === "CAMERA" && !cameraObjectIds.has(object.entityId))
			throw new Error(`CAMERA object ${object.entityId} must have exactly one camera entry`);
	for (const light of manifest.lights) {
		if (objects.get(light.objectId)?.type !== "LIGHT")
			throw new Error(`light ${light.entityId} must reference a LIGHT object`);
		const isSpot = light.lightType === "SPOT";
		if (
			(isSpot && (light.spotSize === null || light.spotBlend === null)) ||
			(!isSpot && (light.spotSize !== null || light.spotBlend !== null))
		) {
			throw new Error(
				`light ${light.entityId} spotSize and spotBlend must be non-null if and only if lightType is SPOT`,
			);
		}
	}
	if (manifest.scene.activeCameraId !== null && !cameras.has(manifest.scene.activeCameraId))
		throw new Error(`scene.activeCameraId references unknown camera: ${manifest.scene.activeCameraId}`);
	for (const marker of manifest.markers)
		if (marker.cameraId !== null && !cameras.has(marker.cameraId))
			throw new Error(`marker ${marker.name} references unknown camera: ${marker.cameraId}`);
}

export function parseSceneManifest(input: unknown): SceneManifestV1 {
	const manifest = Parse(SceneManifestV1Schema, input);
	validateManifest(manifest);
	return manifest;
}
