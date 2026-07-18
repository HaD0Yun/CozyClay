import type { ApplyCameraPlanResult } from "@oh-my-blender/blender-tools";
import { buildSceneManifestV2Revision, type DirectorProject, ProjectStore } from "@oh-my-blender/director-core";
import {
	type CameraPlanMutationCandidate,
	type CameraPlanV1,
	parseCameraPlan,
	parseCameraPlanMutationCandidate,
} from "@oh-my-blender/protocol";
import type { DirectorHandlerContext } from "./inspect-service.ts";

export interface CameraPlanRevisionStore {
	readProject(): Promise<DirectorProject>;
	commitRevision(expectedRevisionId: string, project: DirectorProject, journalEntry: unknown): Promise<void>;
}

export interface ApplyCameraPlanHandlerOptions {
	readonly store?: CameraPlanRevisionStore;
}

export const createDirectorProjectStore = (rootDir: string): CameraPlanRevisionStore => new ProjectStore(rootDir);

export async function commitCameraPlanMutation(
	store: CameraPlanRevisionStore,
	plan: CameraPlanV1,
	input: unknown,
	beginDurableCommit: () => void = () => {},
): Promise<ApplyCameraPlanResult> {
	const candidate = parseCameraPlanMutationCandidate(input);
	if (candidate.expected_revision_id !== plan.expected_revision_id) {
		throw new Error(
			`STALE_BASE: add-on expected ${candidate.expected_revision_id}, plan expected ${plan.expected_revision_id}`,
		);
	}
	if (candidate.scene_hash !== candidate.manifest.sceneHash) {
		throw new Error("INVALID_MUTATION_RESULT: scene_hash must equal manifest.sceneHash");
	}
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...hashFreeManifest } = candidate.manifest;
	const rebuiltManifest = buildSceneManifestV2Revision(hashFreeManifest);
	if (
		candidate.scene_hash !== rebuiltManifest.sceneHash ||
		candidate.manifest.sceneHash !== rebuiltManifest.sceneHash ||
		candidate.manifest.revisionId !== rebuiltManifest.revisionId
	) {
		throw new Error("INVALID_MUTATION_RESULT: manifest hashes do not match its canonical content");
	}
	const current = await store.readProject();
	if (current.project_id !== candidate.manifest.projectId) {
		throw new Error("INVALID_MUTATION_RESULT: manifest projectId does not match the current project");
	}
	const child: DirectorProject = {
		...current,
		current_revision_id: candidate.manifest.revisionId,
		manifest: candidate.manifest,
	};
	beginDurableCommit();
	await store.commitRevision(plan.expected_revision_id, child, {
		type: "apply_camera_plan",
		evidence_sha256: plan.evidence_sha256,
		expected_revision_id: plan.expected_revision_id,
		resulting_revision_id: candidate.manifest.revisionId,
		scene_hash: candidate.scene_hash,
	});
	return { resulting_revision_id: candidate.manifest.revisionId, scene_hash: candidate.scene_hash };
}

export function createApplyCameraPlanHandler(options: ApplyCameraPlanHandlerOptions = {}) {
	const store = options.store ?? createDirectorProjectStore(process.cwd());
	return async (params: unknown, context: DirectorHandlerContext) => {
		const plan = parseCameraPlan(params);
		const expectedRevision = context.request?.expected_revision_id;
		if (expectedRevision !== plan.expected_revision_id) {
			throw new Error(
				`STALE_BASE: plan expected ${plan.expected_revision_id}, request expected ${String(expectedRevision)}`,
			);
		}
		if (context.applyCameraPlan === undefined) {
			throw new Error("MUTATION_BRIDGE_UNAVAILABLE: protocol v2 mutation bridge is required");
		}
		const candidate: CameraPlanMutationCandidate = await context.applyCameraPlan(plan, {
			signal: context.signal,
			reportProgress: (progress) => {
				context.reportProgress?.(progress.phase, progress.completed, progress.total);
			},
		});
		const result = await commitCameraPlanMutation(store, plan, candidate, context.beginDurableCommit);
		return { result, resulting_revision_id: result.resulting_revision_id };
	};
}
