import { createHash } from "node:crypto";
import { canonicalRevision } from "./canonical.ts";

const REVISION_DOMAIN = "omb-revision-v1\0";

function hashPreimage(fields: readonly string[]): string {
	return createHash("sha256").update(Buffer.from(REVISION_DOMAIN + fields.join("\0"), "utf8")).digest("hex");
}

export function sceneHash(snapshot: unknown): string {
	return canonicalRevision(snapshot);
}

export function initialRevisionId(projectId: string, sceneHash: string): string {
	return hashPreimage([projectId, sceneHash]);
}

export function childRevisionId(
	projectId: string,
	parentRevisionId: string,
	canonicalOperationJson: string,
	resultingSceneHash: string,
	canonicalDependencyHashes: string,
): string {
	return hashPreimage([
		projectId,
		parentRevisionId,
		canonicalOperationJson,
		resultingSceneHash,
		canonicalDependencyHashes,
	]);
}
