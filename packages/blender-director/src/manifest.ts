import { type Static, Type } from "typebox";
import { Parse } from "typebox/value";
import { canonicalRevision } from "./canonical.ts";

const NameSchema = Type.String({ minLength: 1, maxLength: 256 });
const NullableNameSchema = Type.Union([NameSchema, Type.Null()]);
const Vector2Schema = Type.Tuple([Type.Number(), Type.Number()]);
const Vector3Schema = Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);
const QuaternionSchema = Type.Tuple([
	Type.Number(),
	Type.Number(),
	Type.Number(),
	Type.Number(),
]);

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
		sensorFit: Type.Union([
			Type.Literal("AUTO"),
			Type.Literal("HORIZONTAL"),
			Type.Literal("VERTICAL"),
		]),
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

export const SceneSnapshotSchema = Type.Object(
	{
		schemaVersion: Type.Literal(2),
		scene: SceneSchema,
		render: RenderSchema,
		objects: Type.Array(SceneObjectSchema),
		cameras: Type.Array(CameraSchema),
		markers: Type.Array(MarkerSchema),
		animations: Type.Array(AnimationSchema),
	},
	{ additionalProperties: false },
);

export type SceneSnapshot = Static<typeof SceneSnapshotSchema>;

export interface ProjectManifest {
	readonly revision: string;
	readonly snapshot: SceneSnapshot;
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

function validateSnapshot(snapshot: SceneSnapshot): void {
	if (snapshot.scene.frameStart > snapshot.scene.frameEnd) {
		throw new Error("scene.frameStart must not exceed scene.frameEnd");
	}

	const objects = new Map<string, (typeof snapshot.objects)[number]>();
	for (const object of snapshot.objects) {
		if (objects.has(object.name)) throw new Error(`duplicate object name: ${object.name}`);
		objects.set(object.name, object);
	}
	for (const object of snapshot.objects) {
		if (object.parent !== null && !objects.has(object.parent)) {
			throw new Error(`object ${object.name} has unknown parent: ${object.parent}`);
		}
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
					throw new Error(`keyframe frames must be strictly increasing: ${animation.objectName}/${fcurve.dataPath}`);
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
	validateSnapshot(snapshot);
	return snapshot;
}

export function createProjectManifest(snapshot: SceneSnapshot): ProjectManifest {
	return { revision: canonicalRevision(snapshot), snapshot };
}
