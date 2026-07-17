import type { SceneSnapshot } from "@oh-my-blender/protocol";
import { canonicalJson } from "./canonical.ts";
import { sceneHash } from "./revision.ts";

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
