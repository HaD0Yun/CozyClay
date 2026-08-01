import type { SceneManifestV4, SceneManifestV4HashFree, SceneSnapshot } from "@cclay/protocol";
import { parseSceneManifestV4 } from "@cclay/protocol";
import { canonicalJson, canonicalRevision } from "./canonical.ts";
import { childRevisionId, sceneHash } from "./revision.ts";

const HASH_PLACEHOLDER = "0".repeat(64);
export interface ProjectManifest {
	readonly revision: string;
	readonly snapshot: SceneSnapshot;
}
export type ManifestForHashing = Omit<SceneManifestV4, "revisionId" | "sceneHash" | "extensions">;

export function extensionsDigest(extensions: SceneManifestV4["extensions"]): string {
	const byteLength = Buffer.byteLength(canonicalJson(extensions ?? {}), "utf8");
	if (byteLength > 65_536) {
		throw new Error(`EXTENSIONS_TOO_LARGE: canonical extensions are ${byteLength} bytes (maximum 65536)`);
	}
	return canonicalRevision(extensions ?? {});
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

export function buildSceneManifestV4Revision(
	manifestWithoutHashes: SceneManifestV4HashFree,
	parentRevisionId: string,
	canonicalOperation: unknown,
	canonicalDependencyHashes: unknown = [],
): SceneManifestV4 {
	extensionsDigest(manifestWithoutHashes.extensions);
	const {
		revisionId: _revisionId,
		sceneHash: _sceneHash,
		extensions,
		...unparsed
	} = manifestWithoutHashes as SceneManifestV4;
	const hashManifest: ManifestForHashing = unparsed;
	const parsed = parseSceneManifestV4({
		...hashManifest,
		revisionId: HASH_PLACEHOLDER,
		sceneHash: HASH_PLACEHOLDER,
	});
	const {
		revisionId: _parsedRevisionId,
		sceneHash: _parsedSceneHash,
		extensions: _parsedExtensions,
		...clean
	} = parsed;
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
	// extensions are stripped from every hashing input above but re-attached
	// here: the director stores and returns the add-on's opaque payload, it
	// just never lets it influence a hash. Dropping it instead would silently
	// discard the forward-compatibility data this envelope exists to carry.
	return {
		...clean,
		...(extensions === undefined ? {} : { extensions }),
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
