import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { canonicalRevision } from "./canonical.ts";

export interface DirectorProject extends Record<string, unknown> {
	project_id: string;
	schema_version: number;
	current_revision_id: string;
}

export type ProjectStoreErrorCode = "PROJECT_NOT_FOUND" | "PROJECT_CORRUPT" | "PROJECT_INVALID" | "STALE_BASE";

export class ProjectStoreError extends Error {
	readonly code: ProjectStoreErrorCode;

	constructor(code: ProjectStoreErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		this.name = "ProjectStoreError";
	}
}

function isProject(value: unknown): value is DirectorProject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const project = value as Record<string, unknown>;
	return (
		typeof project.project_id === "string" &&
		project.project_id.length > 0 &&
		Number.isInteger(project.schema_version) &&
		(project.schema_version as number) >= 1 &&
		typeof project.current_revision_id === "string" &&
		project.current_revision_id.length > 0
	);
}
const REVISION_COMMIT_KIND = "revision_commit_v1";

interface RevisionCommitPayload {
	kind: typeof REVISION_COMMIT_KIND;
	expected_revision_id: string;
	target_revision_id: string;
	project: DirectorProject;
	entry: unknown;
}

interface RevisionCommitRecord extends RevisionCommitPayload {
	transaction_id: string;
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

function createCommitRecord(
	expectedRevisionId: string,
	project: DirectorProject,
	journalEntry: unknown,
): RevisionCommitRecord {
	const normalizedProject = normalizeJson(project, "project");
	if (!isProject(normalizedProject))
		throw new ProjectStoreError("PROJECT_INVALID", "project has invalid required fields");
	const payload: RevisionCommitPayload = {
		kind: REVISION_COMMIT_KIND,
		expected_revision_id: expectedRevisionId,
		target_revision_id: normalizedProject.current_revision_id,
		project: normalizedProject,
		entry: normalizeJson(journalEntry, "journal entry"),
	};
	return { ...payload, transaction_id: canonicalRevision(payload) };
}

function parseCommitRecord(value: unknown): RevisionCommitRecord | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.kind !== REVISION_COMMIT_KIND) return undefined;
	if (
		typeof candidate.expected_revision_id !== "string" ||
		typeof candidate.target_revision_id !== "string" ||
		typeof candidate.transaction_id !== "string" ||
		!Object.hasOwn(candidate, "entry") ||
		!isProject(candidate.project) ||
		candidate.project.current_revision_id !== candidate.target_revision_id
	) {
		throw new ProjectStoreError("PROJECT_CORRUPT", "last revision commit journal entry is invalid");
	}
	const payload: RevisionCommitPayload = {
		kind: REVISION_COMMIT_KIND,
		expected_revision_id: candidate.expected_revision_id,
		target_revision_id: candidate.target_revision_id,
		project: candidate.project,
		entry: candidate.entry,
	};
	if (canonicalRevision(payload) !== candidate.transaction_id) {
		throw new ProjectStoreError("PROJECT_CORRUPT", "last revision commit journal transaction id is invalid");
	}
	return { ...payload, transaction_id: candidate.transaction_id };
}

export class ProjectStore {
	readonly ombDirectory: string;
	readonly projectPath: string;
	readonly journalPath: string;

	readonly rootDir: string;
	private commitTail: Promise<void> = Promise.resolve();

	constructor(rootDir: string) {
		this.rootDir = rootDir;
		this.ombDirectory = join(rootDir, ".omb");
		this.projectPath = join(this.ombDirectory, "project.json");
		this.journalPath = join(this.ombDirectory, "journal.jsonl");
	}

	async writeProject(project: DirectorProject): Promise<void> {
		if (!isProject(project)) throw new ProjectStoreError("PROJECT_INVALID", "project has invalid required fields");
		await mkdir(this.ombDirectory, { recursive: true });
		const temporaryPath = join(this.ombDirectory, `.project.${process.pid}.${randomUUID()}.tmp`);
		const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try {
			await handle.writeFile(JSON.stringify(project));
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
		const line = `${JSON.stringify(entry)}\n`;
		const handle = await open(this.journalPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
		try {
			await handle.writeFile(line);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	private async readLastCommitRecord(): Promise<RevisionCommitRecord | undefined> {
		let source: string;
		try {
			source = await readFile(this.journalPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const content = source.trimEnd();
		if (content === "") return undefined;
		let value: unknown;
		try {
			value = JSON.parse(content.slice(content.lastIndexOf("\n") + 1));
		} catch (error) {
			throw new ProjectStoreError("PROJECT_CORRUPT", "last journal entry is not valid JSON", { cause: error });
		}
		return parseCommitRecord(value);
	}

	async commitRevision(expectedRevisionId: string, project: DirectorProject, journalEntry: unknown): Promise<void> {
		const commit = this.commitTail.then(async () => {
			const requested = createCommitRecord(expectedRevisionId, project, journalEntry);
			let current = await this.readProject();
			const last = await this.readLastCommitRecord();

			if (last && current.current_revision_id === last.expected_revision_id) {
				await this.writeProject(last.project);
				current = last.project;
			}
			if (
				last?.transaction_id === requested.transaction_id &&
				current.current_revision_id === requested.target_revision_id
			) {
				return;
			}
			if (current.current_revision_id !== expectedRevisionId) {
				throw new ProjectStoreError(
					"STALE_BASE",
					`expected revision ${expectedRevisionId}, current revision is ${current.current_revision_id}`,
				);
			}
			await this.appendJournal(requested);
			await this.writeProject(requested.project);
		});
		this.commitTail = commit.catch(() => undefined);
		return commit;
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
		if (!isProject(project))
			throw new ProjectStoreError("PROJECT_INVALID", "project.json has invalid required fields");
		return project;
	}
}
