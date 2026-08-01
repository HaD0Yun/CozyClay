import { randomUUID } from "node:crypto";
import type { StageSceneResult } from "@cclay/blender-tools";
import {
	buildSceneManifestV4Revision,
	canonicalRevision,
	type DirectorProject,
	type DirectorProjectRecoveryV2,
	type DirectorProjectWriteInput,
	extensionsDigest,
	type ManifestForHashing,
	ProjectStore,
	type RevisionOperationEntryV2,
} from "@cclay/director-core";
import {
	canonicalizeStageScenePlan,
	parseSceneManifestV4,
	parseStageSceneMutationCandidate,
	type StageSceneAppliedHandShape,
	type StageSceneMutationCandidate,
	type StageScenePlanV1,
} from "@cclay/protocol";
import type { PreparedMutationCandidate } from "./apply-camera-plan-service.ts";
import type { DirectorHandlerContext } from "./inspect-service.ts";

export interface StageSceneRevisionStore {
	readProject(): Promise<DirectorProject>;
	commitRevision(
		idempotencyKey: string,
		expectedRevisionId: string,
		project: DirectorProjectWriteInput,
		journalEntry: RevisionOperationEntryV2,
	): Promise<void>;
}

export interface StageSceneHandlerOptions {
	readonly store?: StageSceneRevisionStore;
	readonly allocateEntityId?: () => string;
}

export const createStageSceneProjectStore = (rootDir: string): StageSceneRevisionStore => new ProjectStore(rootDir);

function validateEntityIdentities(plan: StageScenePlanV1, candidate: StageSceneMutationCandidate): void {
	const namedOperations = plan.operations.filter((operation) => operation.op === "add_character");
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

function expectedAppliedHandShapes(plan: StageScenePlanV1): StageSceneAppliedHandShape[] {
	const rows: StageSceneAppliedHandShape[] = [];
	for (const [operationIndex, operation] of plan.operations.entries()) {
		if (operation.op !== "apply_motion") continue;
		const legacy = "hand_pose" in operation ? operation.hand_pose : undefined;
		const handShapes = "hand_shapes" in operation ? operation.hand_shapes : undefined;
		const left = handShapes !== undefined && "left" in handShapes ? handShapes.left : undefined;
		const right = handShapes !== undefined && "right" in handShapes ? handShapes.right : undefined;
		rows.push({
			operation_index: operationIndex,
			entity_id: operation.entity_id,
			motion_id: operation.motion_id,
			left: left ?? legacy ?? "relaxed",
			right: right ?? legacy ?? "relaxed",
			library_version: "1.1.0",
		});
	}
	return rows;
}

function validateAppliedHandShapes(plan: StageScenePlanV1, candidate: StageSceneMutationCandidate): void {
	const expected = expectedAppliedHandShapes(plan);
	if (
		candidate.applied_hand_shapes.length !== expected.length ||
		expected.some((row, index) => {
			const actual = candidate.applied_hand_shapes[index];
			return (
				actual === undefined ||
				actual.operation_index !== row.operation_index ||
				actual.entity_id !== row.entity_id ||
				actual.motion_id !== row.motion_id ||
				actual.left !== row.left ||
				actual.right !== row.right ||
				actual.library_version !== row.library_version
			);
		})
	) {
		throw new Error("INVALID_MUTATION_RESULT: applied hand shapes disagree with the canonical motion operations");
	}
}

function isPreparedCandidate(input: unknown): input is PreparedMutationCandidate<StageSceneMutationCandidate> {
	return (
		typeof input === "object" &&
		input !== null &&
		"candidate" in input &&
		"transaction" in input &&
		"requestId" in input
	);
}

export async function commitStageSceneMutation(
	...args: Parameters<typeof commitStageSceneMutationInner>
): ReturnType<typeof commitStageSceneMutationInner> {
	return await commitStageSceneMutationInner(...args);
}
async function commitStageSceneMutationInner(
	store: StageSceneRevisionStore,
	plan: StageScenePlanV1,
	input: unknown,
	beginDurableCommit: () => void = () => {},
): Promise<StageSceneResult> {
	const prepared = isPreparedCandidate(input) ? input : undefined;
	const candidate = parseStageSceneMutationCandidate(prepared?.candidate ?? input);
	if (candidate.expected_revision_id !== plan.expected_revision_id) {
		throw new Error(
			`STALE_BASE: add-on expected ${candidate.expected_revision_id}, plan expected ${plan.expected_revision_id}`,
		);
	}
	if (candidate.scene_hash !== candidate.manifest.sceneHash) {
		throw new Error("INVALID_MUTATION_RESULT: scene_hash must equal manifest.sceneHash");
	}
	const rebuiltManifest = (() => {
		const {
			revisionId: _revisionId,
			sceneHash: _sceneHash,
			extensions: _extensions,
			...hashFreeManifest
		} = candidate.manifest;
		const manifestForHashing: ManifestForHashing = hashFreeManifest;
		return buildSceneManifestV4Revision(manifestForHashing, plan.expected_revision_id, plan);
	})();
	if (
		candidate.scene_hash !== rebuiltManifest.sceneHash ||
		candidate.manifest.sceneHash !== rebuiltManifest.sceneHash ||
		candidate.manifest.revisionId !== rebuiltManifest.revisionId
	) {
		throw new Error("INVALID_MUTATION_RESULT: manifest hashes do not match the child revision chain");
	}
	validateEntityIdentities(plan, candidate);
	validateAppliedHandShapes(plan, candidate);
	const current = await store.readProject();
	if (current.project_id !== candidate.manifest.projectId) {
		throw new Error("INVALID_MUTATION_RESULT: manifest projectId does not match the current project");
	}
	const durableManifest =
		typeof current.manifest === "object" && current.manifest !== null
			? (current.manifest as { sceneHash?: unknown })
			: undefined;
	const transaction = prepared?.transaction;
	const baseSceneHash =
		typeof durableManifest?.sceneHash === "string"
			? durableManifest.sceneHash
			: transaction === undefined
				? plan.expected_revision_id
				: undefined;
	if (baseSceneHash === undefined) {
		throw new Error("INVALID_MUTATION_RESULT: current project manifest has no scene hash");
	}
	if (
		transaction !== undefined &&
		(transaction.operation !== "stage_scene" ||
			transaction.project_id !== current.project_id ||
			transaction.base_revision_id !== plan.expected_revision_id ||
			transaction.base_scene_hash !== baseSceneHash ||
			transaction.candidate_revision_id !== candidate.manifest.revisionId ||
			transaction.candidate_scene_hash !== candidate.scene_hash)
	) {
		throw new Error("INVALID_MUTATION_RESULT: prepared transaction does not match the stage mutation");
	}
	const target: DirectorProjectRecoveryV2 = {
		project_id: current.project_id,
		schema_version: 1,
		current_revision_id: candidate.manifest.revisionId,
		manifest: parseSceneManifestV4(candidate.manifest),
		extensionsDigest: extensionsDigest(candidate.manifest.extensions),
	};
	const journalEntry: RevisionOperationEntryV2 = {
		schema_version: 2,
		operation: "stage_scene",
		request_id: prepared?.requestId ?? randomUUID(),
		plan_sha256: canonicalRevision(plan),
		base_scene_hash: baseSceneHash,
		candidate_scene_hash: candidate.scene_hash,
	};
	beginDurableCommit();
	await store.commitRevision(
		transaction?.transaction_id ?? randomUUID(),
		plan.expected_revision_id,
		target,
		journalEntry,
	);
	return {
		resulting_revision_id: candidate.manifest.revisionId,
		scene_hash: candidate.scene_hash,
		entity_identities: candidate.entity_identities,
		applied_hand_shapes: candidate.applied_hand_shapes,
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
		const candidate = await context.stageScene(plan, {
			signal: context.signal,
			reportProgress: (progress) => {
				context.reportProgress?.(progress.phase, progress.completed, progress.total);
			},
		});
		const result = await commitStageSceneMutation(store, plan, candidate, context.beginDurableCommit);
		return { result, resulting_revision_id: result.resulting_revision_id };
	};
}
