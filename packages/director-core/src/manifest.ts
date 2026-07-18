import type {
	SceneManifestV1,
	SceneManifestV1HashFree,
	SceneManifestV2,
	SceneManifestV2HashFree,
	SceneSnapshot,
} from "@oh-my-blender/protocol";
import { parseSceneManifestV2, validateManifest } from "@oh-my-blender/protocol";
import { canonicalJson, canonicalRevision } from "./canonical.ts";
import { initialRevisionId, sceneHash } from "./revision.ts";

const HASH_PLACEHOLDER = "0".repeat(64);

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

export function buildSceneManifestRevision(manifestWithoutHashes: SceneManifestV1HashFree): SceneManifestV1 {
	// Runtime callers (not just the type system) must never let a stale
	// revisionId/sceneHash leak into the hash preimage: strip both keys
	// unconditionally before validating or hashing, mirroring the Python
	// finalize_scene_manifest()'s explicit .pop() of both fields.
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...clean } = manifestWithoutHashes as SceneManifestV1;
	validateManifest(clean);
	const computedSceneHash = canonicalRevision(clean);
	return {
		...clean,
		revisionId: initialRevisionId(clean.projectId, computedSceneHash),
		sceneHash: computedSceneHash,
	};
}

export function buildSceneManifestV2Revision(manifestWithoutHashes: SceneManifestV2HashFree): SceneManifestV2 {
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...unparsed } = manifestWithoutHashes as SceneManifestV2;
	// Reuse the protocol's closed TypeBox schema before hashing so this
	// preimage cannot contain fields that a receiving protocol parser rejects.
	const parsed = parseSceneManifestV2({
		...unparsed,
		revisionId: HASH_PLACEHOLDER,
		sceneHash: HASH_PLACEHOLDER,
	});
	const { revisionId: _parsedRevisionId, sceneHash: _parsedSceneHash, ...clean } = parsed;
	const computedSceneHash = canonicalRevision(clean);
	return {
		...clean,
		revisionId: initialRevisionId(clean.projectId, computedSceneHash),
		sceneHash: computedSceneHash,
	};
}
