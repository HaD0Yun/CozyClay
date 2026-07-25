import type {
	SceneManifestV1,
	SceneManifestV1HashFree,
	SceneManifestV2,
	SceneManifestV2HashFree,
	SceneManifestV3,
	SceneManifestV3HashFree,
	SceneManifestV4,
	SceneManifestV4HashFree,
	SceneSnapshot,
} from "@cclay/protocol";
import { parseSceneManifestV2, parseSceneManifestV3, parseSceneManifestV4, validateManifest } from "@cclay/protocol";
import { canonicalJson, canonicalRevision } from "./canonical.ts";
import { childRevisionId, initialRevisionId, sceneHash } from "./revision.ts";

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
	const { selectedEntityIds: _selectedEntityIds, blenderVersion: _blenderVersion, ...hashPreimage } = clean;
	const computedSceneHash = canonicalRevision(hashPreimage);
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
	const { selectedEntityIds: _selectedEntityIds, blenderVersion: _blenderVersion, ...hashPreimage } = clean;
	const computedSceneHash = canonicalRevision(hashPreimage);
	return {
		...clean,
		revisionId: initialRevisionId(clean.projectId, computedSceneHash),
		sceneHash: computedSceneHash,
	};
}
export function buildSceneManifestV3Revision(
	manifestWithoutHashes: SceneManifestV3HashFree,
	parentRevisionId: string,
	canonicalOperation: unknown,
	canonicalDependencyHashes: unknown = [],
): SceneManifestV3 {
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...unparsed } = manifestWithoutHashes as SceneManifestV3;
	const parsed = parseSceneManifestV3({
		...unparsed,
		revisionId: HASH_PLACEHOLDER,
		sceneHash: HASH_PLACEHOLDER,
	});
	const { revisionId: _parsedRevisionId, sceneHash: _parsedSceneHash, ...clean } = parsed;
	const { selectedEntityIds: _selectedEntityIds, blenderVersion: _blenderVersion, ...hashPreimage } = clean;
	const computedSceneHash = canonicalRevision(hashPreimage);
	return {
		...clean,
		revisionId: childRevisionId(
			clean.projectId,
			parentRevisionId,
			canonicalJson(canonicalOperation),
			computedSceneHash,
			canonicalJson(canonicalDependencyHashes),
		),
		sceneHash: computedSceneHash,
	};
}

export function buildSceneManifestV4Revision(
	manifestWithoutHashes: SceneManifestV4HashFree,
	parentRevisionId: string,
	canonicalOperation: unknown,
	canonicalDependencyHashes: unknown = [],
): SceneManifestV4 {
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...unparsed } = manifestWithoutHashes as SceneManifestV4;
	const parsed = parseSceneManifestV4({
		...unparsed,
		revisionId: HASH_PLACEHOLDER,
		sceneHash: HASH_PLACEHOLDER,
	});
	const { revisionId: _parsedRevisionId, sceneHash: _parsedSceneHash, ...clean } = parsed;
	const {
		selectedEntityIds: _selectedEntityIds,
		blenderVersion: _blenderVersion,
		assemblies,
		objects,
		...hashFields
	} = clean;
	// parentId has been part of the object shape (and therefore the hash
	// preimage) since V1; never strip it. Hierarchy-free V4 manifests
	// normalize to the V3 preimage (schemaVersion 3, no assemblies key) so
	// existing flat scenes keep their recorded hashes across the upgrade.
	const hasHierarchy = objects.some((object) => object.parentId !== null) || assemblies.length > 0;
	const hashPreimage = hasHierarchy
		? { ...hashFields, objects, assemblies }
		: { ...hashFields, schemaVersion: 3, objects };
	const computedSceneHash = canonicalRevision(hashPreimage);
	return {
		...clean,
		revisionId: childRevisionId(
			clean.projectId,
			parentRevisionId,
			canonicalJson(canonicalOperation),
			computedSceneHash,
			canonicalJson(canonicalDependencyHashes),
		),
		sceneHash: computedSceneHash,
	};
}
