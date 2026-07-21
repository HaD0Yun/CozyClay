import type { SceneSnapshot } from "@oh-my-blender/protocol";

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
		readonly rotationQuaternion: readonly [number, number, number, number];
		readonly scale: readonly [number, number, number];
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
			location: object.location,
			rotationQuaternion: object.rotationQuaternion,
			scale: object.scale,
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
