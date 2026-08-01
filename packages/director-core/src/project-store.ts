import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, truncate } from "node:fs/promises";
import { join } from "node:path";
import { parseSceneManifestV4, type SceneManifestV4 } from "@cclay/protocol";
import { canonicalRevision } from "./canonical.ts";
import { extensionsDigest } from "./manifest.ts";

export interface DirectorProject extends Record<string, unknown> {
	project_id: string;
	schema_version: number;
	current_revision_id: string;
	extensionsDigest?: string;
}

/**
 * What a caller supplies to writeProject. The director derives extensionsDigest
 * itself, so callers never provide it; DirectorProjectRecoveryV2 below is the
 * durable record that always carries one. These cannot be related with Omit
 * because DirectorProject has an index signature, which Omit would collapse.
 */
export interface DirectorProjectWriteInput extends DirectorProject {
	project_id: string;
	schema_version: 1;
	current_revision_id: string;
	manifest: SceneManifestV4;
}

export interface DirectorProjectRecoveryV2 extends DirectorProjectWriteInput {
	extensionsDigest: string;
}

export interface RevisionOperationEntryV2 {
	schema_version: 2;
	operation: "stage_scene" | "apply_camera_plan";
	request_id: string;
	plan_sha256: string;
	base_scene_hash: string;
	candidate_scene_hash: string;
}

export type TransactionMarkerPhase =
	| "prepared"
	| "candidate_saved"
	| "manifest_committed"
	| "acknowledged"
	| "rollback_saved";

export interface RevisionReconcileResult {
	status: "base_authoritative" | "candidate_authoritative" | "unknown";
	revisionId: string;
}

export type ProjectStoreErrorCode =
	| "PROJECT_NOT_FOUND"
	| "PROJECT_CORRUPT"
	| "PROJECT_INVALID"
	| "UNSUPPORTED_PROJECT_VERSION"
	| "STALE_BASE"
	| "TRANSACTION_CONFLICT";

export class ProjectStoreError extends Error {
	readonly code: ProjectStoreErrorCode;

	constructor(code: ProjectStoreErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		this.name = "ProjectStoreError";
	}
}

const HASH = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V1_KIND = "revision_commit_v1";
const V2_KIND = "revision_commit_v2";
const V1_KEYS = ["kind", "expected_revision_id", "target_revision_id", "project", "entry", "transaction_id"];
const V2_KEYS = [
	"kind",
	"idempotency_key",
	"expected_revision_id",
	"target_revision_id",
	"project",
	"journal_entry",
	"commit_hash",
];

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isProject(value: unknown): value is DirectorProject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const project = value as Record<string, unknown>;
	return (
		typeof project.project_id === "string" &&
		UUID_V4.test(project.project_id) &&
		Number.isSafeInteger(project.schema_version) &&
		(project.schema_version as number) >= 1 &&
		(project.schema_version as number) <= 2_147_483_647 &&
		typeof project.current_revision_id === "string" &&
		HASH.test(project.current_revision_id)
	);
}
function assertManifestV4Project(value: unknown): void {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ProjectStoreError(
			"UNSUPPORTED_PROJECT_VERSION",
			"project manifest schemaVersion is unsupported; remove .cclay and run `cclay` to re-initialize this project",
		);
	}
	const manifest = (value as Record<string, unknown>).manifest;
	if (
		manifest === null ||
		typeof manifest !== "object" ||
		Array.isArray(manifest) ||
		!Number.isInteger((manifest as Record<string, unknown>).schemaVersion) ||
		(manifest as Record<string, unknown>).schemaVersion !== 4
	) {
		throw new ProjectStoreError(
			"UNSUPPORTED_PROJECT_VERSION",
			"project manifest schemaVersion is unsupported; remove .cclay and run `cclay` to re-initialize this project",
		);
	}
}

function normalizeJson(value: unknown, label: string): unknown {
	let source: string | undefined;
	try {
		source = JSON.stringify(value);
	} catch (error) {
		throw new ProjectStoreError("PROJECT_INVALID", `${label} is not JSON serializable`, { cause: error });
	}
	if (source === undefined) throw new ProjectStoreError("PROJECT_INVALID", `${label} is not JSON serializable`);
	return JSON.parse(source);
}

function parseRecoveryProject(value: unknown, code: "PROJECT_INVALID" | "PROJECT_CORRUPT"): DirectorProjectRecoveryV2 {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ProjectStoreError(code, "project has invalid required fields");
	}
	const project = value as Record<string, unknown>;
	assertManifestV4Project(value);
	if (
		(!exactKeys(project, ["project_id", "schema_version", "current_revision_id", "manifest", "extensionsDigest"]) &&
			!exactKeys(project, ["project_id", "schema_version", "current_revision_id", "manifest"])) ||
		typeof project.project_id !== "string" ||
		!UUID_V4.test(project.project_id) ||
		project.schema_version !== 1 ||
		typeof project.current_revision_id !== "string" ||
		!HASH.test(project.current_revision_id) ||
		(project.extensionsDigest !== undefined &&
			(typeof project.extensionsDigest !== "string" || !HASH.test(project.extensionsDigest)))
	) {
		throw new ProjectStoreError(code, "project has invalid required fields");
	}
	let manifest: SceneManifestV4;
	try {
		manifest = parseSceneManifestV4(project.manifest);
	} catch (error) {
		throw new ProjectStoreError(code, "project manifest is invalid", { cause: error });
	}
	const calculatedExtensionsDigest = extensionsDigest(manifest.extensions);
	if (
		(project.extensionsDigest === undefined &&
			manifest.extensions !== undefined &&
			Object.keys(manifest.extensions).length > 0) ||
		(project.extensionsDigest !== undefined && calculatedExtensionsDigest !== project.extensionsDigest)
	) {
		throw new ProjectStoreError(code, "project extensions digest is invalid");
	}
	if (manifest.projectId !== project.project_id || manifest.revisionId !== project.current_revision_id) {
		throw new ProjectStoreError(code, "project manifest binding is invalid");
	}
	return {
		project_id: project.project_id,
		schema_version: 1,
		current_revision_id: project.current_revision_id,
		manifest,
		extensionsDigest: calculatedExtensionsDigest,
	};
}

function parseOperationEntry(value: unknown, code: "PROJECT_INVALID" | "PROJECT_CORRUPT"): RevisionOperationEntryV2 {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ProjectStoreError(code, "journal entry is invalid");
	}
	const entry = value as Record<string, unknown>;
	if (
		!exactKeys(entry, [
			"schema_version",
			"operation",
			"request_id",
			"plan_sha256",
			"base_scene_hash",
			"candidate_scene_hash",
		]) ||
		entry.schema_version !== 2 ||
		(entry.operation !== "stage_scene" && entry.operation !== "apply_camera_plan") ||
		typeof entry.request_id !== "string" ||
		!UUID_V4.test(entry.request_id) ||
		typeof entry.plan_sha256 !== "string" ||
		!HASH.test(entry.plan_sha256) ||
		typeof entry.base_scene_hash !== "string" ||
		!HASH.test(entry.base_scene_hash) ||
		typeof entry.candidate_scene_hash !== "string" ||
		!HASH.test(entry.candidate_scene_hash)
	) {
		throw new ProjectStoreError(code, "journal entry is invalid");
	}
	return {
		schema_version: 2,
		operation: entry.operation,
		request_id: entry.request_id,
		plan_sha256: entry.plan_sha256,
		base_scene_hash: entry.base_scene_hash,
		candidate_scene_hash: entry.candidate_scene_hash,
	};
}

interface RevisionCommitV1 {
	sourceVersion: 1;
	expectedRevisionId: string;
	targetRevisionId: string;
	project: DirectorProject;
	legacyCommitHash: string;
}

interface RevisionCommitV2 {
	sourceVersion: 2;
	idempotencyKey: string;
	expectedRevisionId: string;
	targetRevisionId: string;
	project: DirectorProjectRecoveryV2;
	journalEntry: RevisionOperationEntryV2;
	commitHash: string;
}

type RevisionCommitRecord = RevisionCommitV1 | RevisionCommitV2;

function parseCommitRecord(value: unknown): RevisionCommitRecord | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.kind !== "string") return undefined;
	if (candidate.kind !== V1_KIND && candidate.kind !== V2_KIND) {
		if (candidate.kind.startsWith("revision_commit_")) {
			throw new ProjectStoreError("PROJECT_CORRUPT", "unknown revision commit kind");
		}
		return undefined;
	}
	if (candidate.kind === V1_KIND) {
		if (!isProject(candidate.project)) {
			throw new ProjectStoreError("PROJECT_CORRUPT", "revision commit journal entry is invalid");
		}
		assertManifestV4Project(candidate.project);
		if (
			!exactKeys(candidate, V1_KEYS) ||
			typeof candidate.expected_revision_id !== "string" ||
			!HASH.test(candidate.expected_revision_id) ||
			typeof candidate.target_revision_id !== "string" ||
			!HASH.test(candidate.target_revision_id) ||
			typeof candidate.transaction_id !== "string" ||
			!HASH.test(candidate.transaction_id) ||
			!isProject(candidate.project) ||
			candidate.project.current_revision_id !== candidate.target_revision_id
		) {
			throw new ProjectStoreError("PROJECT_CORRUPT", "revision commit journal entry is invalid");
		}
		const payload = {
			kind: V1_KIND,
			expected_revision_id: candidate.expected_revision_id,
			target_revision_id: candidate.target_revision_id,
			project: candidate.project,
			entry: candidate.entry,
		};
		if (canonicalRevision(payload) !== candidate.transaction_id) {
			throw new ProjectStoreError("PROJECT_CORRUPT", "revision commit journal digest is invalid");
		}
		return {
			sourceVersion: 1,
			expectedRevisionId: candidate.expected_revision_id,
			targetRevisionId: candidate.target_revision_id,
			project: candidate.project,
			legacyCommitHash: candidate.transaction_id,
		};
	}
	if (
		!exactKeys(candidate, V2_KEYS) ||
		typeof candidate.idempotency_key !== "string" ||
		!UUID_V4.test(candidate.idempotency_key) ||
		typeof candidate.expected_revision_id !== "string" ||
		!HASH.test(candidate.expected_revision_id) ||
		typeof candidate.target_revision_id !== "string" ||
		!HASH.test(candidate.target_revision_id) ||
		typeof candidate.commit_hash !== "string" ||
		!HASH.test(candidate.commit_hash)
	) {
		throw new ProjectStoreError("PROJECT_CORRUPT", "revision commit journal entry is invalid");
	}
	const project = parseRecoveryProject(candidate.project, "PROJECT_CORRUPT");
	const journalEntry = parseOperationEntry(candidate.journal_entry, "PROJECT_CORRUPT");
	if (project.current_revision_id !== candidate.target_revision_id) {
		throw new ProjectStoreError("PROJECT_CORRUPT", "revision commit project binding is invalid");
	}
	// The digest must be validated over the RAW stored payload: the writer
	// hashed exactly what it wrote. Re-parsing may normalize an older
	// schemaVersion 3 project manifest to v4, and hashing that upgraded form
	// would reject every record minted by a pre-assembly build.
	const payload = {
		kind: V2_KIND,
		idempotency_key: candidate.idempotency_key,
		expected_revision_id: candidate.expected_revision_id,
		target_revision_id: candidate.target_revision_id,
		project: candidate.project,
		journal_entry: candidate.journal_entry,
	};
	if (canonicalRevision(payload) !== candidate.commit_hash) {
		throw new ProjectStoreError("PROJECT_CORRUPT", "revision commit journal digest is invalid");
	}
	return {
		sourceVersion: 2,
		idempotencyKey: candidate.idempotency_key,
		expectedRevisionId: candidate.expected_revision_id,
		targetRevisionId: candidate.target_revision_id,
		project,
		journalEntry,
		commitHash: candidate.commit_hash,
	};
}

export class ProjectStore {
	readonly ombDirectory: string;
	readonly projectPath: string;
	readonly journalPath: string;
	readonly rootDir: string;
	private commitTail: Promise<void> = Promise.resolve();

	constructor(rootDir: string) {
		this.rootDir = rootDir;
		this.ombDirectory = join(rootDir, ".cclay");
		this.projectPath = join(this.ombDirectory, "project.json");
		this.journalPath = join(this.ombDirectory, "journal.jsonl");
	}

	async writeProject(project: DirectorProject): Promise<void> {
		if (!isProject(project)) throw new ProjectStoreError("PROJECT_INVALID", "project has invalid required fields");
		assertManifestV4Project(project);
		const manifest = parseSceneManifestV4((project as unknown as { manifest: unknown }).manifest);
		const durableProject = { ...project, extensionsDigest: extensionsDigest(manifest.extensions) };
		parseRecoveryProject(durableProject, "PROJECT_INVALID");
		await mkdir(this.ombDirectory, { recursive: true });
		const temporaryPath = join(this.ombDirectory, `.project.${process.pid}.${randomUUID()}.tmp`);
		const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try {
			await handle.writeFile(JSON.stringify(durableProject));
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporaryPath, this.projectPath);
		const directory = await open(this.ombDirectory, constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}

	async appendJournal(entry: unknown): Promise<void> {
		await mkdir(this.ombDirectory, { recursive: true });
		const handle = await open(this.journalPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(entry)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async readCommitRecords(): Promise<RevisionCommitRecord[]> {
		let source: string;
		try {
			source = await readFile(this.journalPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		if (source === "") return [];
		const lines = source.split("\n");
		if (lines.at(-1) === "") lines.pop();
		const records: RevisionCommitRecord[] = [];
		for (const [index, line] of lines.entries()) {
			if (line === "") continue;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch (error) {
				if (index === lines.length - 1 && !source.endsWith("\n")) {
					const completePrefix = `${lines.slice(0, index).join("\n")}${index === 0 ? "" : "\n"}`;
					await truncate(this.journalPath, Buffer.byteLength(completePrefix));
					break;
				}
				throw new ProjectStoreError("PROJECT_CORRUPT", "journal entry is not valid JSON", { cause: error });
			}
			const record = parseCommitRecord(value);
			if (record !== undefined) records.push(record);
		}
		return records;
	}

	private async forwardJournal(
		current: DirectorProject,
		records: readonly RevisionCommitRecord[],
	): Promise<DirectorProject> {
		let recovered = current;
		for (const record of records) {
			if (record.expectedRevisionId !== recovered.current_revision_id) continue;
			await this.writeProject(record.project);
			recovered = record.project;
		}
		return recovered;
	}

	async commitRevision(
		idempotencyKey: string,
		expectedRevisionId: string,
		project: DirectorProjectWriteInput,
		journalEntry: RevisionOperationEntryV2,
	): Promise<void> {
		if (!UUID_V4.test(idempotencyKey)) {
			throw new ProjectStoreError("PROJECT_INVALID", "idempotency key must be a lowercase UUIDv4");
		}
		if (!HASH.test(expectedRevisionId)) {
			throw new ProjectStoreError("PROJECT_INVALID", "expected revision id must be a lowercase SHA-256 digest");
		}
		const normalizedProjectValue = normalizeJson(project, "project");
		if (
			normalizedProjectValue === null ||
			typeof normalizedProjectValue !== "object" ||
			Array.isArray(normalizedProjectValue)
		) {
			throw new ProjectStoreError("PROJECT_INVALID", "project has invalid required fields");
		}
		const projectManifest = parseSceneManifestV4((normalizedProjectValue as { manifest?: unknown }).manifest);
		(normalizedProjectValue as { extensionsDigest?: string }).extensionsDigest = extensionsDigest(
			projectManifest.extensions,
		);
		const normalizedProject = parseRecoveryProject(normalizedProjectValue, "PROJECT_INVALID");
		const normalizedEntry = parseOperationEntry(normalizeJson(journalEntry, "journal entry"), "PROJECT_INVALID");
		const payload = {
			kind: V2_KIND,
			idempotency_key: idempotencyKey,
			expected_revision_id: expectedRevisionId,
			target_revision_id: normalizedProject.current_revision_id,
			project: normalizedProject,
			journal_entry: normalizedEntry,
		};
		const requested = { ...payload, commit_hash: canonicalRevision(payload) };
		const commit = this.commitTail.then(async () => {
			let current = await this.readProject();
			const records = await this.readCommitRecords();
			const prior = records.find(
				(record): record is RevisionCommitV2 =>
					record.sourceVersion === 2 && record.idempotencyKey === idempotencyKey,
			);
			if (prior !== undefined && prior.commitHash !== requested.commit_hash) {
				throw new ProjectStoreError("TRANSACTION_CONFLICT", "transaction id was reused with different content");
			}
			current = await this.forwardJournal(current, records);
			if (prior !== undefined) return;
			if (current.current_revision_id !== expectedRevisionId) {
				throw new ProjectStoreError(
					"STALE_BASE",
					`expected revision ${expectedRevisionId}, current revision is ${current.current_revision_id}`,
				);
			}
			await this.appendJournal(requested);
			await this.writeProject(normalizedProject);
		});
		this.commitTail = commit.catch(() => undefined);
		return commit;
	}

	async reconcileRevision(
		idempotencyKey: string,
		markerPhase: TransactionMarkerPhase,
	): Promise<RevisionReconcileResult> {
		if (!UUID_V4.test(idempotencyKey)) {
			throw new ProjectStoreError("PROJECT_INVALID", "idempotency key must be a lowercase UUIDv4");
		}
		if (
			!["prepared", "candidate_saved", "manifest_committed", "acknowledged", "rollback_saved"].includes(markerPhase)
		) {
			throw new ProjectStoreError("PROJECT_INVALID", "transaction phase is invalid");
		}
		let result: RevisionReconcileResult | undefined;
		const reconciliation = this.commitTail.then(async () => {
			const current = await this.readProject();
			const records = await this.readCommitRecords();
			const matches = records.filter(
				(record): record is RevisionCommitV2 =>
					record.sourceVersion === 2 && record.idempotencyKey === idempotencyKey,
			);
			if (matches.length === 0) {
				result = {
					status:
						markerPhase === "manifest_committed" || markerPhase === "acknowledged"
							? "unknown"
							: "base_authoritative",
					revisionId: current.current_revision_id,
				};
				return;
			}
			if (matches.length !== 1) {
				result = { status: "unknown", revisionId: current.current_revision_id };
				return;
			}
			const record = matches[0];
			if (current.current_revision_id === record.targetRevisionId) {
				result = { status: "candidate_authoritative", revisionId: record.targetRevisionId };
				return;
			}
			if (
				current.current_revision_id === record.expectedRevisionId &&
				(markerPhase === "prepared" || markerPhase === "candidate_saved")
			) {
				await this.writeProject(record.project);
				result = { status: "candidate_authoritative", revisionId: record.targetRevisionId };
				return;
			}
			result = { status: "unknown", revisionId: current.current_revision_id };
		});
		this.commitTail = reconciliation.catch(() => undefined);
		await reconciliation;
		if (result === undefined) throw new ProjectStoreError("PROJECT_CORRUPT", "reconcile result is unavailable");
		return result;
	}

	async readProject(): Promise<DirectorProject> {
		let source: string;
		try {
			source = await readFile(this.projectPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new ProjectStoreError("PROJECT_NOT_FOUND", "project.json does not exist", { cause: error });
			}
			throw error;
		}
		let project: unknown;
		try {
			project = JSON.parse(source);
		} catch (error) {
			throw new ProjectStoreError("PROJECT_CORRUPT", "project.json is not valid JSON", { cause: error });
		}
		if (!isProject(project)) {
			throw new ProjectStoreError("PROJECT_INVALID", "project.json has invalid required fields");
		}
		assertManifestV4Project(project);
		const recovered = parseRecoveryProject(project, "PROJECT_INVALID");
		const { extensionsDigest: _extensionsDigest, ...readProject } = recovered;
		return readProject;
	}
}
