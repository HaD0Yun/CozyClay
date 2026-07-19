import { randomUUID } from "node:crypto";
import type { StageSceneResult } from "@oh-my-blender/blender-tools";
import { buildSceneManifestV3Revision, type DirectorProject, ProjectStore } from "@oh-my-blender/director-core";
import {
	canonicalizeStageScenePlan,
	parseStageSceneMutationCandidate,
	type StageSceneMutationCandidate,
	type StageScenePlanV1,
} from "@oh-my-blender/protocol";
import type { DirectorHandlerContext } from "./inspect-service.ts";

export interface StageSceneRevisionStore {
	readProject(): Promise<DirectorProject>;
	commitRevision(expectedRevisionId: string, project: DirectorProject, journalEntry: unknown): Promise<void>;
}

export interface StageSceneHandlerOptions {
	readonly store?: StageSceneRevisionStore;
	readonly allocateEntityId?: () => string;
}

export const createStageSceneProjectStore = (rootDir: string): StageSceneRevisionStore => new ProjectStore(rootDir);

function validateEntityIdentities(plan: StageScenePlanV1, candidate: StageSceneMutationCandidate): void {
	const namedOperations = plan.operations.filter(
		(operation) => operation.op === "add_primitive" || operation.op === "upsert_area_light",
	);
	if (candidate.entity_identities.length !== namedOperations.length) {
		throw new Error("INVALID_MUTATION_RESULT: entity identity mapping must cover every named operation");
	}
	const objectsById = new Map(candidate.manifest.objects.map((object) => [object.entityId, object]));
	for (const [index, operation] of namedOperations.entries()) {
		const identity = candidate.entity_identities[index];
		const actualObject = objectsById.get(operation.entity_id);
		if (
			identity?.entity_id !== operation.entity_id ||
			identity.requested_name !== operation.name ||
			actualObject === undefined ||
			identity.actual_name !== actualObject.name
		) {
			throw new Error("INVALID_MUTATION_RESULT: entity identity mapping disagrees with the plan or manifest");
		}
	}
}

export async function commitStageSceneMutation(
	store: StageSceneRevisionStore,
	plan: StageScenePlanV1,
	input: unknown,
	beginDurableCommit: () => void = () => {},
): Promise<StageSceneResult> {
	const candidate = parseStageSceneMutationCandidate(input);
	if (candidate.expected_revision_id !== plan.expected_revision_id) {
		throw new Error(
			`STALE_BASE: add-on expected ${candidate.expected_revision_id}, plan expected ${plan.expected_revision_id}`,
		);
	}
	if (candidate.scene_hash !== candidate.manifest.sceneHash) {
		throw new Error("INVALID_MUTATION_RESULT: scene_hash must equal manifest.sceneHash");
	}
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...hashFreeManifest } = candidate.manifest;
	const rebuiltManifest = buildSceneManifestV3Revision(hashFreeManifest, plan.expected_revision_id, plan);
	if (
		candidate.scene_hash !== rebuiltManifest.sceneHash ||
		candidate.manifest.sceneHash !== rebuiltManifest.sceneHash ||
		candidate.manifest.revisionId !== rebuiltManifest.revisionId
	) {
		throw new Error("INVALID_MUTATION_RESULT: manifest hashes do not match the child revision chain");
	}
	validateEntityIdentities(plan, candidate);
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
		type: "stage_scene",
		expected_revision_id: plan.expected_revision_id,
		resulting_revision_id: candidate.manifest.revisionId,
		scene_hash: candidate.scene_hash,
		canonical_plan: plan,
	});
	return {
		resulting_revision_id: candidate.manifest.revisionId,
		scene_hash: candidate.scene_hash,
		entity_identities: candidate.entity_identities,
	};
}

export function createStageSceneHandler(options: StageSceneHandlerOptions = {}) {
	const store = options.store ?? createStageSceneProjectStore(process.cwd());
	const allocateEntityId = options.allocateEntityId ?? randomUUID;
	return async (params: unknown, context: DirectorHandlerContext) => {
		const expectedRevision = context.request?.expected_revision_id;
		if (
			typeof params !== "object" ||
			params === null ||
			(params as { expected_revision_id?: unknown }).expected_revision_id !== expectedRevision
		) {
			throw new Error(
				`STALE_BASE: request expected ${String(expectedRevision)}, plan expected ${String((params as { expected_revision_id?: unknown } | null)?.expected_revision_id)}`,
			);
		}
		const plan = canonicalizeStageScenePlan(params, allocateEntityId);
		if (context.stageScene === undefined) {
			throw new Error("MUTATION_BRIDGE_UNAVAILABLE: protocol v2 mutation bridge is required");
		}
		const candidate: StageSceneMutationCandidate = await context.stageScene(plan, {
			signal: context.signal,
			reportProgress: (progress) => {
				context.reportProgress?.(progress.phase, progress.completed, progress.total);
			},
		});
		const result = await commitStageSceneMutation(store, plan, candidate, context.beginDurableCommit);
		return { result, resulting_revision_id: result.resulting_revision_id };
	};
}
