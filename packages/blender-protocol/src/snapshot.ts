import { type Static, Type } from "typebox";
import { Parse } from "typebox/value";

const NameSchema = Type.String({ minLength: 1, maxLength: 256 });
const NullableNameSchema = Type.Union([NameSchema, Type.Null()]);
const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const UuidSchema = Type.String({ pattern: UUID_V4_LOWERCASE });
const NullableUuidSchema = Type.Union([UuidSchema, Type.Null()]);
const Vector2Schema = Type.Tuple([Type.Number(), Type.Number()]);
const Vector3Schema = Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);
const QuaternionSchema = Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]);

const SceneSchema = Type.Object(
	{
		name: NameSchema,
		frameStart: Type.Integer({ minimum: 0, maximum: 1_048_574 }),
		frameEnd: Type.Integer({ minimum: 0, maximum: 1_048_574 }),
		fps: Type.Integer({ minimum: 1, maximum: 240 }),
		activeCamera: NullableNameSchema,
	},
	{ additionalProperties: false },
);

const RenderSchema = Type.Object(
	{
		resolutionX: Type.Integer({ minimum: 1, maximum: 65_536 }),
		resolutionY: Type.Integer({ minimum: 1, maximum: 65_536 }),
		resolutionPercentage: Type.Integer({ minimum: 1, maximum: 100 }),
	},
	{ additionalProperties: false },
);

const SceneObjectSchema = Type.Object(
	{
		// Optional-and-null-equivalent: snapshots serialized before assembly
		// support omit entityId entirely; parseSceneSnapshot normalizes absence
		// to null so downstream code and hashing see one uniform shape.
		entityId: Type.Optional(NullableUuidSchema),
		name: NameSchema,
		type: Type.String({ minLength: 1 }),
		parent: NullableNameSchema,
		visible: Type.Boolean(),
		location: Vector3Schema,
		rotationMode: Type.String({ minLength: 1 }),
		rotationQuaternion: QuaternionSchema,
		scale: Vector3Schema,
	},
	{ additionalProperties: false },
);

const CameraSchema = Type.Object(
	{
		name: NameSchema,
		lens: Type.Number({ exclusiveMinimum: 0 }),
		sensorFit: Type.Union([Type.Literal("AUTO"), Type.Literal("HORIZONTAL"), Type.Literal("VERTICAL")]),
		sensorWidth: Type.Number({ exclusiveMinimum: 0 }),
		sensorHeight: Type.Number({ exclusiveMinimum: 0 }),
		verticalFovRadians: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: Math.PI }),
		clipStart: Type.Number({ exclusiveMinimum: 0 }),
		clipEnd: Type.Number({ exclusiveMinimum: 0 }),
	},
	{ additionalProperties: false },
);

const MarkerSchema = Type.Object(
	{
		name: NameSchema,
		frame: Type.Integer(),
		camera: NullableNameSchema,
	},
	{ additionalProperties: false },
);

const KeyframeSchema = Type.Object(
	{
		frame: Type.Number(),
		value: Type.Number(),
		interpolation: Type.String({ minLength: 1 }),
		handleLeft: Vector2Schema,
		handleRight: Vector2Schema,
	},
	{ additionalProperties: false },
);

const FCurveSchema = Type.Object(
	{
		dataPath: Type.String(),
		arrayIndex: Type.Integer({ minimum: 0 }),
		keyframes: Type.Array(KeyframeSchema),
	},
	{ additionalProperties: false },
);

const AnimationSchema = Type.Object(
	{
		objectName: NameSchema,
		target: Type.Union([Type.Literal("object"), Type.Literal("cameraData")]),
		fcurves: Type.Array(FCurveSchema),
	},
	{ additionalProperties: false },
);

const AssemblySchema = Type.Object(
	{
		assemblyId: UuidSchema,
		name: NameSchema,
		rootEntityId: UuidSchema,
		memberIds: Type.Array(UuidSchema),
	},
	{ additionalProperties: false },
);

export const SceneSnapshotSchema = Type.Object(
	{
		schemaVersion: Type.Literal(2),
		scene: SceneSchema,
		render: RenderSchema,
		objects: Type.Array(SceneObjectSchema),
		assemblies: Type.Optional(Type.Array(AssemblySchema)),
		cameras: Type.Array(CameraSchema),
		markers: Type.Array(MarkerSchema),
		animations: Type.Array(AnimationSchema),
	},
	{ additionalProperties: false },
);

export type SceneSnapshot = Static<typeof SceneSnapshotSchema>;

export function validateNfc(value: unknown, path = "$"): void {
	if (typeof value === "string") {
		if (value !== value.normalize("NFC")) throw new Error(`${path} must be NFC-normalized`);
		return;
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) validateNfc(value[index], `${path}[${index}]`);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) validateNfc(child, `${path}.${key}`);
	}
}

export function validateQuaternion(quaternion: readonly [number, number, number, number], path: string): void {
	const [w, x, y, z] = quaternion;
	if (Math.abs(Math.hypot(w, x, y, z) - 1) > 1e-6) {
		throw new Error(`${path} must have unit length within 1e-6`);
	}
	const firstNonzeroVectorComponent = x !== 0 ? x : y !== 0 ? y : z;
	if (w < 0 || (w === 0 && firstNonzeroVectorComponent <= 0)) {
		throw new Error(`${path} must use canonical quaternion sign`);
	}
}

function compareCodePoints(left: string, right: string): number {
	const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
	const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
	for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
		if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
	}
	return leftPoints.length - rightPoints.length;
}

function assertSorted<T>(values: readonly T[], compare: (left: T, right: T) => number, label: string): void {
	for (let index = 1; index < values.length; index += 1) {
		if (compare(values[index - 1]!, values[index]!) > 0) {
			throw new Error(`${label} must be in semantic order`);
		}
	}
}

function compareNullableNames(left: string | null, right: string | null): number {
	if (left === right) return 0;
	if (left === null) return -1;
	if (right === null) return 1;
	return compareCodePoints(left, right);
}

export function validateSnapshot(snapshot: SceneSnapshot): void {
	validateNfc(snapshot);
	if (snapshot.scene.frameStart > snapshot.scene.frameEnd) {
		throw new Error("scene.frameStart must not exceed scene.frameEnd");
	}

	const objects = new Map<string, (typeof snapshot.objects)[number]>();
	const objectsByEntityId = new Map<string, (typeof snapshot.objects)[number]>();
	for (const object of snapshot.objects) {
		if (objects.has(object.name)) throw new Error(`duplicate object name: ${object.name}`);
		objects.set(object.name, object);
		if (object.entityId !== null && object.entityId !== undefined) {
			if (objectsByEntityId.has(object.entityId)) throw new Error(`duplicate object entityId: ${object.entityId}`);
			objectsByEntityId.set(object.entityId, object);
		}
		validateQuaternion(object.rotationQuaternion, `objects[${JSON.stringify(object.name)}].rotationQuaternion`);
	}
	for (const object of snapshot.objects) {
		if (object.parent !== null && !objects.has(object.parent)) {
			throw new Error(`object ${object.name} has unknown parent: ${object.parent}`);
		}
	}

	if (snapshot.assemblies !== undefined) {
		const assemblyIds = new Set<string>();
		const assemblyMemberIds = new Set<string>();
		for (const assembly of snapshot.assemblies) {
			if (assemblyIds.has(assembly.assemblyId)) throw new Error(`duplicate assemblyId: ${assembly.assemblyId}`);
			assemblyIds.add(assembly.assemblyId);
			if (!objectsByEntityId.has(assembly.rootEntityId)) {
				throw new Error(`assembly ${assembly.assemblyId} has unknown rootEntityId: ${assembly.rootEntityId}`);
			}
			if (objectsByEntityId.get(assembly.rootEntityId)?.type !== "EMPTY") {
				throw new Error(`assembly ${assembly.assemblyId} rootEntityId must reference an EMPTY object`);
			}
			assertSorted(assembly.memberIds, compareCodePoints, `assembly ${assembly.assemblyId} memberIds`);
			if (!assembly.memberIds.includes(assembly.rootEntityId)) {
				throw new Error(`assembly ${assembly.assemblyId} memberIds must include rootEntityId`);
			}
			const memberIds = new Set<string>();
			for (const memberId of assembly.memberIds) {
				if (memberIds.has(memberId)) {
					throw new Error(`assembly ${assembly.assemblyId} memberIds must not contain duplicates`);
				}
				memberIds.add(memberId);
				if (!objectsByEntityId.has(memberId)) {
					throw new Error(`assembly ${assembly.assemblyId} has unknown member entityId: ${memberId}`);
				}
				if (assemblyMemberIds.has(memberId)) {
					throw new Error(`assembly member entityId ${memberId} belongs to more than one assembly`);
				}
				assemblyMemberIds.add(memberId);
			}
		}
		assertSorted(
			snapshot.assemblies,
			(left, right) => compareCodePoints(left.assemblyId, right.assemblyId),
			"assemblies",
		);
	}

	const cameraNames = new Set<string>();
	for (const camera of snapshot.cameras) {
		if (cameraNames.has(camera.name)) throw new Error(`duplicate camera entry: ${camera.name}`);
		cameraNames.add(camera.name);
		if (objects.get(camera.name)?.type !== "CAMERA") {
			throw new Error(`camera ${camera.name} must reference a CAMERA object`);
		}
		if (camera.clipEnd <= camera.clipStart) {
			throw new Error(`camera ${camera.name} clipEnd must be greater than clipStart`);
		}
	}
	for (const object of snapshot.objects) {
		if (object.type === "CAMERA" && !cameraNames.has(object.name)) {
			throw new Error(`CAMERA object ${object.name} must have exactly one camera entry`);
		}
	}

	if (snapshot.scene.activeCamera !== null && !cameraNames.has(snapshot.scene.activeCamera)) {
		throw new Error(`scene.activeCamera references unknown camera: ${snapshot.scene.activeCamera}`);
	}
	for (const marker of snapshot.markers) {
		if (marker.camera !== null && !cameraNames.has(marker.camera)) {
			throw new Error(`marker ${marker.name} references unknown camera: ${marker.camera}`);
		}
	}

	for (const animation of snapshot.animations) {
		const object = objects.get(animation.objectName);
		if (object === undefined) {
			throw new Error(`animation references unknown object: ${animation.objectName}`);
		}
		if (animation.target === "cameraData" && object.type !== "CAMERA") {
			throw new Error(`cameraData animation requires a CAMERA object: ${animation.objectName}`);
		}
		assertSorted(
			animation.fcurves,
			(left, right) => compareCodePoints(left.dataPath, right.dataPath) || left.arrayIndex - right.arrayIndex,
			`animation ${animation.objectName} fcurves`,
		);
		for (const fcurve of animation.fcurves) {
			for (let index = 1; index < fcurve.keyframes.length; index += 1) {
				if (fcurve.keyframes[index - 1]!.frame >= fcurve.keyframes[index]!.frame) {
					throw new Error(
						`keyframe frames must be strictly increasing: ${animation.objectName}/${fcurve.dataPath}`,
					);
				}
			}
		}
	}

	assertSorted(snapshot.objects, (left, right) => compareCodePoints(left.name, right.name), "objects");
	assertSorted(snapshot.cameras, (left, right) => compareCodePoints(left.name, right.name), "cameras");
	assertSorted(
		snapshot.markers,
		(left, right) =>
			compareCodePoints(left.name, right.name) ||
			left.frame - right.frame ||
			compareNullableNames(left.camera, right.camera),
		"markers",
	);
	assertSorted(
		snapshot.animations,
		(left, right) =>
			compareCodePoints(left.objectName, right.objectName) || compareCodePoints(left.target, right.target),
		"animations",
	);
}

export function parseSceneSnapshot(input: unknown): SceneSnapshot {
	const snapshot = Parse(SceneSnapshotSchema, input);
	for (const object of snapshot.objects) {
		if (object.entityId === undefined) object.entityId = null;
	}
	validateSnapshot(snapshot);
	return snapshot;
}
