import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";
import { validateNfc, validateQuaternion } from "./snapshot.ts";

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
	// The owning CAMERA object's entityId (architecture doc line 203: "Camera,
	// light, and armature identities use their owning object ID").
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
// No entityId: identity is the owning CAMERA object's entityId (line 203).
const CameraSchema = exact({
	objectId: uuid(),
	lens: Type.Number({ exclusiveMinimum: 0 }),
	sensorFit: Type.Union([Type.Literal("AUTO"), Type.Literal("HORIZONTAL"), Type.Literal("VERTICAL")]),
	sensorWidth: Type.Number({ exclusiveMinimum: 0 }),
	sensorHeight: Type.Number({ exclusiveMinimum: 0 }),
	verticalFovRadians: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: Math.PI }),
	clipStart: Type.Number({ exclusiveMinimum: 0 }),
	clipEnd: Type.Number({ exclusiveMinimum: 0 }),
});
// No entityId: identity is the owning LIGHT object's entityId (line 203).
const LightSchema = exact({
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
const LightV3Schema = exact({
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
	areaSize: Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]),
});
/**
 * The one list of buildable shapes. `stage-scene.ts` imports this rather than
 * repeating the union, because the two copies are what let the request schema and
 * the manifest schema disagree about what a scene may contain.
 *
 * Every shape is authored to fit the -1..1 unit box so `scale` means the same
 * thing for all of them.
 */
export const primitiveTypeSchema = () =>
	Type.Union([
		Type.Literal("PLANE"),
		Type.Literal("CUBE"),
		Type.Literal("UV_SPHERE"),
		Type.Literal("CYLINDER"),
		Type.Literal("CONE"),
		Type.Literal("CIRCLE"),
		Type.Literal("TORUS"),
	]);

const StagePrimitiveSchema = exact({
	objectId: uuid(),
	primitiveType: primitiveTypeSchema(),
	// Optional so an all-flat scene -- which is every scene built before the add-on
	// shaded anything -- exports byte-identically and keeps its revision hash.
	// Present means the mesh genuinely differs from that flat one, which is what
	// lets a stored revision prove its shading instead of assuming it.
	shading: Type.Optional(Type.Union([Type.Literal("SMOOTH"), Type.Literal("MIXED")])),
});
const StageMaterialSchema = exact({
	objectId: uuid(),
	materialName: name(),
	baseColor: Type.Tuple([
		Type.Number({ minimum: 0, maximum: 1 }),
		Type.Number({ minimum: 0, maximum: 1 }),
		Type.Number({ minimum: 0, maximum: 1 }),
		Type.Number({ minimum: 0, maximum: 1 }),
	]),
	useNodes: Type.Boolean(),
	principledBaseColor: Type.Union([
		Type.Tuple([
			Type.Number({ minimum: 0, maximum: 1 }),
			Type.Number({ minimum: 0, maximum: 1 }),
			Type.Number({ minimum: 0, maximum: 1 }),
			Type.Number({ minimum: 0, maximum: 1 }),
		]),
		Type.Null(),
	]),
	// Emitted only when they differ from the Principled defaults the add-on has
	// always produced (0.5 / 0.0), so every scene built before surface finish
	// existed keeps a byte-identical manifest and revision hash.
	principledRoughness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	principledMetallic: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
// The owning CAMERA object's entityId, or null.
const MarkerSchema = exact({ name: name(), frame: Type.Integer(), cameraId: nullableUuid() });
const CameraKeyframeSchema = exact({
	frame: Type.Number(),
	value: Type.Number(),
	interpolation: Type.String({ minLength: 1 }),
	handleLeft: Type.Tuple([Type.Number(), Type.Number()]),
	handleRight: Type.Tuple([Type.Number(), Type.Number()]),
	handleLeftType: Type.String({ minLength: 1 }),
	handleRightType: Type.String({ minLength: 1 }),
});
const CameraFCurveSchema = exact({
	dataPath: Type.String({ minLength: 1 }),
	arrayIndex: Type.Integer({ minimum: 0 }),
	keyframes: Type.Array(CameraKeyframeSchema),
});
const CameraAnimationSchema = exact({
	objectId: uuid(),
	target: Type.Union([Type.Literal("object"), Type.Literal("cameraData")]),
	fcurves: Type.Array(CameraFCurveSchema),
});
const AssemblySchema = exact({
	assemblyId: uuid(),
	name: name(),
	rootEntityId: uuid(),
	memberIds: Type.Array(uuid()),
});

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
export type SceneManifestV1HashFree = Omit<SceneManifestV1, "revisionId" | "sceneHash">;
export const SceneManifestV2Schema = exact({
	schemaVersion: Type.Literal(2),
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
	cameraAnimations: Type.Array(CameraAnimationSchema),
});
export type SceneManifestV2 = Static<typeof SceneManifestV2Schema>;
export type SceneManifestV2HashFree = Omit<SceneManifestV2, "revisionId" | "sceneHash">;
export const SceneManifestV3Schema = exact({
	schemaVersion: Type.Literal(3),
	projectId: uuid(),
	revisionId: Type.String({ pattern: HASH_64 }),
	sceneHash: Type.String({ pattern: HASH_64 }),
	blenderVersion: Type.String(),
	scene: SceneSchema,
	render: RenderSchema,
	objects: Type.Array(ObjectSchema),
	bones: Type.Array(BoneSchema),
	cameras: Type.Array(CameraSchema),
	lights: Type.Array(LightV3Schema),
	markers: Type.Array(MarkerSchema),
	selectedEntityIds: Type.Array(uuid()),
	cameraAnimations: Type.Array(CameraAnimationSchema),
	stagePrimitives: Type.Array(StagePrimitiveSchema),
	stageMaterials: Type.Array(StageMaterialSchema),
});
export type SceneManifestV3 = Static<typeof SceneManifestV3Schema>;
export type SceneManifestV3HashFree = Omit<SceneManifestV3, "revisionId" | "sceneHash">;
export const SceneManifestV4Schema = exact({
	schemaVersion: Type.Literal(4),
	projectId: uuid(),
	revisionId: Type.String({ pattern: HASH_64 }),
	sceneHash: Type.String({ pattern: HASH_64 }),
	blenderVersion: Type.String(),
	scene: SceneSchema,
	render: RenderSchema,
	objects: Type.Array(ObjectSchema),
	bones: Type.Array(BoneSchema),
	cameras: Type.Array(CameraSchema),
	lights: Type.Array(LightV3Schema),
	markers: Type.Array(MarkerSchema),
	selectedEntityIds: Type.Array(uuid()),
	cameraAnimations: Type.Array(CameraAnimationSchema),
	stagePrimitives: Type.Array(StagePrimitiveSchema),
	stageMaterials: Type.Array(StageMaterialSchema),
	assemblies: Type.Array(AssemblySchema),
});
export const SceneManifestV3OrV4Schema = Type.Union([SceneManifestV3Schema, SceneManifestV4Schema]);
export type SceneManifestV4 = Static<typeof SceneManifestV4Schema>;
export type SceneManifestV4HashFree = Omit<SceneManifestV4, "revisionId" | "sceneHash">;

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
function assertUniqueBy<T>(values: readonly T[], key: (value: T) => string, label: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		const id = key(value);
		if (seen.has(id)) throw new Error(`duplicate ${label}: ${id}`);
		seen.add(id);
	}
}
function gcd(a: number, b: number): number {
	while (b !== 0) [a, b] = [b, a % b];
	return a;
}

export function validateManifest(
	manifest: SceneManifestV1HashFree | SceneManifestV2HashFree | SceneManifestV3HashFree | SceneManifestV4HashFree,
): void {
	validateNfc(manifest);
	if (manifest.scene.frameStart > manifest.scene.frameEnd) {
		throw new Error("scene.frameStart must not exceed scene.frameEnd");
	}
	if (gcd(manifest.scene.fpsNumerator, manifest.scene.fpsDenominator) !== 1) {
		throw new Error("scene.fpsNumerator/fpsDenominator must be a reduced rational");
	}
	const byEntityId = (left: { entityId: string }, right: { entityId: string }) =>
		compareCodePoints(left.entityId, right.entityId);
	const byObjectId = (left: { objectId: string }, right: { objectId: string }) =>
		compareCodePoints(left.objectId, right.objectId);
	assertSorted(manifest.objects, byEntityId, "objects");
	assertSorted(manifest.bones, byEntityId, "bones");
	assertSorted(manifest.cameras, byObjectId, "cameras");
	assertSorted(manifest.lights, byObjectId, "lights");
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
	assertUniqueBy(manifest.objects, (object) => object.entityId, "object entityId");
	assertUniqueBy(manifest.bones, (bone) => bone.entityId, "bone entityId");
	assertUniqueBy(manifest.cameras, (camera) => camera.objectId, "camera objectId");
	assertUniqueBy(manifest.lights, (light) => light.objectId, "light objectId");

	const objects = new Map(manifest.objects.map((object) => [object.entityId, object]));
	const bones = new Set(manifest.bones.map((bone) => bone.entityId));
	for (const object of manifest.objects) {
		validateQuaternion(object.rotationQuaternion, `objects[${JSON.stringify(object.entityId)}].rotationQuaternion`);
		if (object.parentId !== null && !objects.has(object.parentId))
			throw new Error(`object ${object.entityId} has unknown parentId: ${object.parentId}`);
	}
	for (const bone of manifest.bones) {
		validateQuaternion(bone.rotationQuaternion, `bones[${JSON.stringify(bone.entityId)}].rotationQuaternion`);
		const armature = objects.get(bone.armatureObjectId);
		if (armature === undefined)
			throw new Error(`bone ${bone.entityId} has unknown armatureObjectId: ${bone.armatureObjectId}`);
		if (armature.type !== "ARMATURE")
			throw new Error(`bone ${bone.entityId} armatureObjectId must reference an ARMATURE object`);
		if (bone.parentBoneId !== null && !bones.has(bone.parentBoneId))
			throw new Error(`bone ${bone.entityId} has unknown parentBoneId: ${bone.parentBoneId}`);
	}

	const cameraObjectIds = new Set<string>();
	for (const camera of manifest.cameras) {
		if (objects.get(camera.objectId)?.type !== "CAMERA")
			throw new Error(`camera entry must reference a CAMERA object: ${camera.objectId}`);
		cameraObjectIds.add(camera.objectId);
		if (camera.clipEnd <= camera.clipStart)
			throw new Error(`camera ${camera.objectId} clipEnd must be greater than clipStart`);
	}
	const expectedCameraObjects = new Set(
		manifest.objects.filter((object) => object.type === "CAMERA").map((object) => object.entityId),
	);
	if (
		cameraObjectIds.size !== expectedCameraObjects.size ||
		[...expectedCameraObjects].some((id) => !cameraObjectIds.has(id))
	) {
		throw new Error("every CAMERA object must have exactly one camera entry");
	}

	const lightObjectIds = new Set<string>();
	for (const light of manifest.lights) {
		if (objects.get(light.objectId)?.type !== "LIGHT")
			throw new Error(`light entry must reference a LIGHT object: ${light.objectId}`);
		lightObjectIds.add(light.objectId);
		const isSpot = light.lightType === "SPOT";
		if (
			(isSpot && (light.spotSize === null || light.spotBlend === null)) ||
			(!isSpot && (light.spotSize !== null || light.spotBlend !== null))
		) {
			throw new Error(
				`light ${light.objectId} spotSize and spotBlend must be non-null if and only if lightType is SPOT`,
			);
		}
	}
	const expectedLightObjects = new Set(
		manifest.objects.filter((object) => object.type === "LIGHT").map((object) => object.entityId),
	);
	if (
		lightObjectIds.size !== expectedLightObjects.size ||
		[...expectedLightObjects].some((id) => !lightObjectIds.has(id))
	) {
		throw new Error("every LIGHT object must have exactly one light entry");
	}

	if (manifest.scene.activeCameraId !== null && !cameraObjectIds.has(manifest.scene.activeCameraId))
		throw new Error(`scene.activeCameraId references unknown camera object: ${manifest.scene.activeCameraId}`);
	for (const marker of manifest.markers)
		if (marker.cameraId !== null && !cameraObjectIds.has(marker.cameraId))
			throw new Error(`marker ${marker.name} references unknown camera object: ${marker.cameraId}`);
	if (manifest.schemaVersion !== 1) {
		assertSorted(
			manifest.cameraAnimations,
			(left, right) =>
				compareCodePoints(left.objectId, right.objectId) || compareCodePoints(left.target, right.target),
			"cameraAnimations",
		);
		assertUniqueBy(
			manifest.cameraAnimations,
			(animation) => `${animation.objectId}\0${animation.target}`,
			"camera animation target",
		);
		for (const animation of manifest.cameraAnimations) {
			if (!cameraObjectIds.has(animation.objectId)) {
				throw new Error(`cameraAnimations entry must reference a CAMERA object: ${animation.objectId}`);
			}
			assertSorted(
				animation.fcurves,
				(left, right) => compareCodePoints(left.dataPath, right.dataPath) || left.arrayIndex - right.arrayIndex,
				`cameraAnimations ${animation.objectId} fcurves`,
			);
			assertUniqueBy(
				animation.fcurves,
				(fcurve) => `${fcurve.dataPath}\0${fcurve.arrayIndex}`,
				`cameraAnimations ${animation.objectId} fcurve`,
			);
			for (const fcurve of animation.fcurves) {
				assertSorted(
					fcurve.keyframes,
					(left, right) => left.frame - right.frame,
					`cameraAnimations ${animation.objectId} keyframes`,
				);
				for (let index = 1; index < fcurve.keyframes.length; index += 1) {
					if (fcurve.keyframes[index - 1]!.frame >= fcurve.keyframes[index]!.frame) {
						throw new Error(`cameraAnimations ${animation.objectId} keyframe frames must be strictly increasing`);
					}
				}
			}
		}
	}
	if (manifest.schemaVersion === 3 || manifest.schemaVersion === 4) {
		for (const light of manifest.lights) {
			const isArea = light.lightType === "AREA";
			if ((isArea && light.areaSize === null) || (!isArea && light.areaSize !== null)) {
				throw new Error(`light ${light.objectId} areaSize must be non-null if and only if lightType is AREA`);
			}
		}
		assertSorted(manifest.stagePrimitives, byObjectId, "stagePrimitives");
		assertUniqueBy(manifest.stagePrimitives, (primitive) => primitive.objectId, "stage primitive objectId");
		for (const primitive of manifest.stagePrimitives) {
			if (objects.get(primitive.objectId)?.type !== "MESH") {
				throw new Error(`stagePrimitives entry must reference a MESH object: ${primitive.objectId}`);
			}
		}
		assertSorted(manifest.stageMaterials, byObjectId, "stageMaterials");
		assertUniqueBy(manifest.stageMaterials, (material) => material.objectId, "stage material objectId");
		for (const material of manifest.stageMaterials) {
			if (objects.get(material.objectId)?.type !== "MESH") {
				throw new Error(`stageMaterials entry must reference a MESH object: ${material.objectId}`);
			}
		}
		if (manifest.schemaVersion === 4) {
			const byAssemblyId = (left: { assemblyId: string }, right: { assemblyId: string }) =>
				compareCodePoints(left.assemblyId, right.assemblyId);
			assertSorted(manifest.assemblies, byAssemblyId, "assemblies");
			assertUniqueBy(manifest.assemblies, (assembly) => assembly.assemblyId, "assemblyId");
			const assemblyMemberIds = new Set<string>();
			for (const assembly of manifest.assemblies) {
				if (!objects.has(assembly.rootEntityId))
					throw new Error(`assembly ${assembly.assemblyId} has unknown rootEntityId: ${assembly.rootEntityId}`);
				if (objects.get(assembly.rootEntityId)?.type !== "EMPTY")
					throw new Error(`assembly ${assembly.assemblyId} rootEntityId must reference an EMPTY object`);
				assertSorted(assembly.memberIds, compareCodePoints, `assembly ${assembly.assemblyId} memberIds`);
				for (let index = 1; index < assembly.memberIds.length; index += 1) {
					if (assembly.memberIds[index - 1] === assembly.memberIds[index])
						throw new Error(`assembly ${assembly.assemblyId} memberIds must not contain duplicates`);
				}
				if (!assembly.memberIds.includes(assembly.rootEntityId))
					throw new Error(`assembly ${assembly.assemblyId} memberIds must include rootEntityId`);
				for (const memberId of assembly.memberIds)
					if (!objects.has(memberId))
						throw new Error(`assembly ${assembly.assemblyId} has unknown memberId: ${memberId}`);
				for (const memberId of assembly.memberIds) {
					if (assemblyMemberIds.has(memberId))
						throw new Error(`assembly memberId ${memberId} belongs to more than one assembly`);
					assemblyMemberIds.add(memberId);
				}
			}
		}
	}
}

export function parseSceneManifest(input: unknown): SceneManifestV1 {
	const manifest = Parse(SceneManifestV1Schema, input);
	validateManifest(manifest);
	return manifest;
}

export function parseSceneManifestV2(input: unknown): SceneManifestV2 {
	const manifest = Parse(SceneManifestV2Schema, input);
	validateManifest(manifest);
	return manifest;
}
export function parseSceneManifestV3(input: unknown): SceneManifestV3 {
	const manifest = Parse(SceneManifestV3Schema, input);
	validateManifest(manifest);
	return manifest;
}
export function parseSceneManifestV4(input: unknown): SceneManifestV4 {
	if (
		typeof input === "object" &&
		input !== null &&
		"schemaVersion" in input &&
		(input as { schemaVersion?: unknown }).schemaVersion === 3
	) {
		const manifest = parseSceneManifestV3(input);
		return Parse(SceneManifestV4Schema, {
			...manifest,
			schemaVersion: 4,
			objects: manifest.objects.map((object) => ({ ...object, parentId: object.parentId ?? null })),
			assemblies: [],
		});
	}
	const manifest = Parse(SceneManifestV4Schema, input);
	validateManifest(manifest);
	return manifest;
}
