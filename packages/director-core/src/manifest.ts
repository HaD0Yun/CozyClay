import type { SceneManifestV1, SceneSnapshot } from "@oh-my-blender/protocol";
import { canonicalJson, canonicalRevision } from "./canonical.ts";
import { initialRevisionId, sceneHash } from "./revision.ts";

export interface ProjectManifest {
	readonly revision: string;
	readonly snapshot: SceneSnapshot;
}

export function assertCanonicalSize(snapshot: SceneSnapshot): void {
	const byteLength = Buffer.byteLength(canonicalJson(snapshot), "utf8");
	if (byteLength > 1_048_576) {
		throw new Error(`SNAPSHOT_TOO_LARGE: canonical snapshot is ${byteLength} bytes (maximum 1048576)`);
	}
}

export function buildProjectManifest(snapshot: SceneSnapshot): ProjectManifest {
	return { revision: sceneHash(snapshot), snapshot };
}

export function buildSceneManifestRevision(
	manifestWithoutHashes: Omit<SceneManifestV1, "revisionId" | "sceneHash">,
): SceneManifestV1 {
	const computedSceneHash = canonicalRevision(manifestWithoutHashes);
	return {
		...manifestWithoutHashes,
		revisionId: initialRevisionId(manifestWithoutHashes.projectId, computedSceneHash),
		sceneHash: computedSceneHash,
	};
}
