import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Parse } from "typebox/value";

const Vector3Schema = Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);

const SceneObjectSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	type: Type.String({ minLength: 1 }),
	location: Vector3Schema,
	rotationEuler: Vector3Schema,
	scale: Vector3Schema,
	visible: Type.Boolean(),
});

export const SceneSnapshotSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	scene: Type.Object({
		name: Type.String({ minLength: 1 }),
		frameStart: Type.Integer(),
		frameEnd: Type.Integer(),
		fps: Type.Integer({ minimum: 1, maximum: 240 }),
	}),
	objects: Type.Array(SceneObjectSchema),
});

export type SceneSnapshot = Static<typeof SceneSnapshotSchema>;

export interface ProjectManifest {
	readonly revision: string;
	readonly snapshot: SceneSnapshot;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, canonicalize(nested)]),
	);
}

export function parseSceneSnapshot(input: unknown): SceneSnapshot {
	return Parse(SceneSnapshotSchema, input);
}

export function createProjectManifest(snapshot: SceneSnapshot): ProjectManifest {
	const canonicalSnapshot = JSON.stringify(canonicalize(snapshot));
	return {
		revision: createHash("sha256").update(canonicalSnapshot).digest("hex"),
		snapshot,
	};
}
