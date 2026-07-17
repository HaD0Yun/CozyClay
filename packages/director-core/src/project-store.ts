import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

export interface DirectorProject extends Record<string, unknown> {
	project_id: string;
	schema_version: number;
	current_revision_id: string;
}

export type ProjectStoreErrorCode = "PROJECT_NOT_FOUND" | "PROJECT_CORRUPT" | "PROJECT_INVALID";

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

export class ProjectStore {
	readonly ombDirectory: string;
	readonly projectPath: string;
	readonly journalPath: string;

	readonly rootDir: string;

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
