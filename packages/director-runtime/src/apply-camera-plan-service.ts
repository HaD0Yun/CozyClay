import { randomUUID } from "node:crypto";
import type { ApplyCameraPlanResult } from "@cclay/blender-tools";
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
	type RevisionReconcileResult,
	type TransactionMarkerPhase,
} from "@cclay/director-core";
import {
	type BridgeTransactionPrepared,
	type CameraPlanMutationCandidate,
	type CameraPlanV1,
	parseCameraPlan,
	parseCameraPlanMutationCandidate,
	parseSceneManifestV4,
} from "@cclay/protocol";
import type { DirectorHandlerContext } from "./inspect-service.ts";

export type PreparedMutationCandidate<T> = {
	candidate: T;
	transaction: BridgeTransactionPrepared;
	requestId: string;
};

export interface CameraPlanRevisionStore {
	readProject(): Promise<DirectorProject>;
	commitRevision(
		idempotencyKey: string,
		expectedRevisionId: string,
		project: DirectorProjectWriteInput,
		journalEntry: RevisionOperationEntryV2,
	): Promise<void>;
	reconcileRevision(idempotencyKey: string, markerPhase: TransactionMarkerPhase): Promise<RevisionReconcileResult>;
}

export interface ApplyCameraPlanHandlerOptions {
	readonly store?: CameraPlanRevisionStore;
}

function hierarchyOf(manifest: unknown): {
	hasHierarchy: boolean;
	parentEdges: Array<{ entityId: unknown; parentId: unknown }>;
	assemblies: unknown[];
} {
	if (typeof manifest !== "object" || manifest === null) {
		return { hasHierarchy: false, parentEdges: [], assemblies: [] };
	}
	const value = manifest as { objects?: unknown; assemblies?: unknown };
	const objects = Array.isArray(value.objects) ? value.objects : [];
	const assemblies = Array.isArray(value.assemblies) ? value.assemblies : [];
	// Only non-null edges constitute hierarchy: camera plans legitimately add
	// new parentless objects (the staged camera), which must not trip the fence.
	const parentEdges = objects
		.map((object) => {
			const entry =
				typeof object === "object" && object !== null ? (object as { entityId?: unknown; parentId?: unknown }) : {};
			return { entityId: entry.entityId, parentId: entry.parentId ?? null };
		})
		.filter((edge) => edge.parentId !== null);
	return {
		hasHierarchy: parentEdges.length > 0 || assemblies.length > 0,
		parentEdges,
		assemblies,
	};
}

export const createDirectorProjectStore = (rootDir: string): CameraPlanRevisionStore => new ProjectStore(rootDir);

function isPreparedCandidate<T>(input: unknown): input is PreparedMutationCandidate<T> {
	return (
		typeof input === "object" &&
		input !== null &&
		"candidate" in input &&
		"transaction" in input &&
		"requestId" in input
	);
}

export async function commitCameraPlanMutation(
	store: CameraPlanRevisionStore,
	plan: CameraPlanV1,
	input: unknown,
	beginDurableCommit: () => void = () => {},
): Promise<ApplyCameraPlanResult> {
	const prepared = isPreparedCandidate<CameraPlanMutationCandidate>(input) ? input : undefined;
	const candidate = parseCameraPlanMutationCandidate(prepared?.candidate ?? input);
	if (candidate.expected_revision_id !== plan.expected_revision_id) {
		throw new Error(
			`STALE_BASE: add-on expected ${candidate.expected_revision_id}, plan expected ${plan.expected_revision_id}`,
		);
	}
	if (candidate.scene_hash !== candidate.manifest.sceneHash) {
		throw new Error("INVALID_MUTATION_RESULT: scene_hash must equal manifest.sceneHash");
	}
	const current = await store.readProject();
	const durableManifest =
		typeof current.manifest === "object" && current.manifest !== null
			? (current.manifest as { schemaVersion?: unknown; sceneHash?: unknown })
			: undefined;
	const durableHierarchy = hierarchyOf(current.manifest);
	const candidateHierarchy = hierarchyOf(candidate.manifest);
	if (durableHierarchy.hasHierarchy) {
		if (
			candidate.manifest.schemaVersion !== 4 ||
			JSON.stringify(candidateHierarchy.parentEdges) !== JSON.stringify(durableHierarchy.parentEdges) ||
			JSON.stringify(candidateHierarchy.assemblies) !== JSON.stringify(durableHierarchy.assemblies)
		) {
			throw new Error("INVALID_MUTATION_RESULT: camera plan must preserve the durable hierarchy");
		}
	} else if (candidateHierarchy.hasHierarchy) {
		throw new Error("INVALID_MUTATION_RESULT: camera plan must not introduce hierarchy");
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
		throw new Error("INVALID_MUTATION_RESULT: manifest hashes do not match its canonical content");
	}
	if (current.project_id !== candidate.manifest.projectId) {
		throw new Error("INVALID_MUTATION_RESULT: manifest projectId does not match the current project");
	}
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
		(transaction.operation !== "apply_camera_plan" ||
			transaction.project_id !== current.project_id ||
			transaction.base_revision_id !== plan.expected_revision_id ||
			transaction.base_scene_hash !== baseSceneHash ||
			transaction.candidate_revision_id !== candidate.manifest.revisionId ||
			transaction.candidate_scene_hash !== candidate.scene_hash)
	) {
		throw new Error("INVALID_MUTATION_RESULT: prepared transaction does not match the camera mutation");
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
		operation: "apply_camera_plan",
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
		const candidate = await context.applyCameraPlan(plan, {
			signal: context.signal,
			reportProgress: (progress) => {
				context.reportProgress?.(progress.phase, progress.completed, progress.total);
			},
		});
		const result = await commitCameraPlanMutation(store, plan, candidate, context.beginDurableCommit);
		return { result, resulting_revision_id: result.resulting_revision_id };
	};
}
