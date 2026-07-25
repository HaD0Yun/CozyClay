import type { SceneSnapshot } from "@cclay/protocol";

/**
 * Compact, model-facing summary of a scene snapshot.
 *
 * The full {@link SceneSnapshot} carries every object transform, every camera
 * and light parameter, and (for rigged characters) hundreds of bones ×
 * keyframes. Returning that verbatim on every inspect_project call burns
 * context linearly with scene complexity. Instead the model gets this summary
 * and fetches entity detail on demand through inspect_entity.
 */
export interface InspectSummary {
	readonly revision: string;
	readonly scene: {
		readonly name: string;
		readonly frameStart: number;
		readonly frameEnd: number;
		readonly fps: number;
		readonly activeCamera: string | null;
	};
	readonly render: {
		readonly resolutionX: number;
		readonly resolutionY: number;
		readonly resolutionPercentage: number;
	};
	readonly objects: ReadonlyArray<{
		readonly entityId: string | null;
		readonly name: string;
		readonly type: string;
		readonly parent: string | null;
		readonly visible: boolean;
		readonly location: readonly [number, number, number];
		// Omitted when the object carries no rotation (identity quaternion) or
		// default unit scale — those values are pure noise for the axis-aligned
		// unit primitives that dominate a staged scene. Absent means the default.
		readonly rotationQuaternion?: readonly [number, number, number, number];
		readonly scale?: readonly [number, number, number];
	}>;
	readonly cameras: ReadonlyArray<{
		readonly name: string;
		readonly lens: number;
		readonly sensorFit: string;
	}>;
	readonly assemblies: ReadonlyArray<{
		readonly name: string;
		readonly rootEntityId: string;
		readonly memberCount: number;
	}>;
	readonly animationCount: number;
	/**
	 * Per-rig bone counts so the model knows which entities have heavy motion
	 * data without loading it. Keyed by object name.
	 */
	readonly boneCounts: ReadonlyArray<{ readonly name: string; readonly boneCount: number }>;
}

/**
 * Build the compact summary the model sees from a full snapshot.
 *
 * Bone counts are derived from `assemblies` members of type ARMATURE would
 * require the manifest; the snapshot does not carry bones, so callers pass the
 * optional `boneCounts` map (object name → bone count) extracted on the add-on
 * side. When absent, the rig summary is empty.
 */
// 3 decimals = 1mm at Blender's meter scale: preserves any deliberate sub-cm
// placement while stripping f32 dither (blender-mcp ships 2; 1mm is the
// conservative floor given real sessions contain sub-cm fractions).
const TRANSFORM_PRECISION = 3;
const IDENTITY_QUATERNION: readonly [number, number, number, number] = [1, 0, 0, 0];
const UNIT_SCALE: readonly [number, number, number] = [1, 1, 1];

function roundComponent(value: number): number {
	// Collapse f32 dither like 7.358891487121582 to a model-legible 7.359
	// without changing any spatial reasoning at Blender-scene precision.
	const rounded = Number(value.toFixed(TRANSFORM_PRECISION));
	return Object.is(rounded, -0) ? 0 : rounded;
}

function roundVector<T extends readonly number[]>(vector: T): T {
	return vector.map(roundComponent) as unknown as T;
}

function nearlyEquals(vector: readonly number[], reference: readonly number[]): boolean {
	return vector.every((component, index) => Math.abs(component - (reference[index] ?? 0)) <= 1e-6);
}

export function summarizeSnapshot(
	snapshot: SceneSnapshot,
	revision: string,
	boneCounts?: ReadonlyMap<string, number>,
): InspectSummary {
	return {
		revision,
		scene: {
			name: snapshot.scene.name,
			frameStart: snapshot.scene.frameStart,
			frameEnd: snapshot.scene.frameEnd,
			fps: snapshot.scene.fps,
			activeCamera: snapshot.scene.activeCamera,
		},
		render: {
			resolutionX: snapshot.render.resolutionX,
			resolutionY: snapshot.render.resolutionY,
			resolutionPercentage: snapshot.render.resolutionPercentage,
		},
		objects: snapshot.objects.map((object) => ({
			entityId: object.entityId ?? null,
			name: object.name,
			type: object.type,
			parent: object.parent,
			visible: object.visible,
			location: roundVector(object.location),
			// Drop identity rotation and unit scale entirely; only carry them
			// when they actually differ from the default, rounded to legible
			// precision. This removes ~7 of 10 float components per staged
			// primitive without losing any spatial signal.
			...(nearlyEquals(object.rotationQuaternion, IDENTITY_QUATERNION)
				? {}
				: { rotationQuaternion: roundVector(object.rotationQuaternion) }),
			...(nearlyEquals(object.scale, UNIT_SCALE) ? {} : { scale: roundVector(object.scale) }),
		})),
		cameras: snapshot.cameras.map((camera) => ({
			name: camera.name,
			lens: camera.lens,
			sensorFit: camera.sensorFit,
		})),
		assemblies: (snapshot.assemblies ?? []).map((assembly) => ({
			name: assembly.name,
			rootEntityId: assembly.rootEntityId,
			memberCount: assembly.memberIds.length,
		})),
		animationCount: snapshot.animations.length,
		boneCounts: boneCounts ? Array.from(boneCounts, ([name, boneCount]) => ({ name, boneCount })) : [],
	};
}

export type InspectSummaryObject = InspectSummary["objects"][number];

/**
 * Object-list delta between two consecutive summaries, keyed by object name
 * (unique per Blender scene). Everything except the object list is cheap to
 * resend, so the diff only covers `objects` — the one unbounded section.
 */
export interface InspectObjectsDiff {
	readonly added: readonly InspectSummaryObject[];
	readonly changed: readonly InspectSummaryObject[];
	readonly removedNames: readonly string[];
	readonly unchangedCount: number;
}

export function diffSummaryObjects(
	previous: InspectSummary["objects"],
	current: InspectSummary["objects"],
): InspectObjectsDiff {
	const previousByName = new Map(previous.map((object) => [object.name, object]));
	const added: InspectSummaryObject[] = [];
	const changed: InspectSummaryObject[] = [];
	let unchangedCount = 0;
	const currentNames = new Set<string>();
	for (const object of current) {
		currentNames.add(object.name);
		const before = previousByName.get(object.name);
		if (before === undefined) {
			added.push(object);
		} else if (JSON.stringify(before) !== JSON.stringify(object)) {
			// Entries are built with a deterministic key order by
			// summarizeSnapshot, so string equality is exact structural
			// equality here.
			changed.push(object);
		} else {
			unchangedCount += 1;
		}
	}
	const removedNames = previous.filter((object) => !currentNames.has(object.name)).map((object) => object.name);
	return { added, changed, removedNames, unchangedCount };
}
