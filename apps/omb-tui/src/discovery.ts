import { lstat, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface DiscoveredController {
	readonly runtimeDirectory: string;
	readonly host: "127.0.0.1";
	readonly port: number;
	readonly launchId: string;
	readonly pid: number;
	readonly resumeToken: string;
}

interface ControllerRecord {
	readonly schema_version: 1;
	readonly launch_id: string;
	readonly project_directory: string;
	readonly pid: number;
	readonly resume_token: string;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function controllerCredentialPath(runtimeDirectory: string): string {
	return path.join(path.dirname(runtimeDirectory), `controller-${path.basename(runtimeDirectory)}.json`);
}

function userRuntimeDirectory(baseDirectory: string): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	return path.join(baseDirectory, `omb-${uid}`);
}

export function defaultRuntimeBaseDirectory(environment: Readonly<Record<string, string | undefined>>): string {
	const xdgRuntimeDirectory = environment.XDG_RUNTIME_DIR;
	if (xdgRuntimeDirectory && path.isAbsolute(xdgRuntimeDirectory)) return xdgRuntimeDirectory;
	return environment.TMPDIR && path.isAbsolute(environment.TMPDIR) ? environment.TMPDIR : os.tmpdir();
}

async function verifyPrivateDirectory(directory: string): Promise<void> {
	const metadata = await lstat(directory);
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (
		metadata.isSymbolicLink() ||
		!metadata.isDirectory() ||
		(uid !== undefined && metadata.uid !== uid) ||
		(metadata.mode & 0o077) !== 0
	) {
		throw new Error(`UNSAFE_RUNTIME_DIRECTORY: ${directory}`);
	}
}

function parseEndpoint(value: unknown): { host: "127.0.0.1"; port: number; launchId: string } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.schema_version !== 1 ||
		record.host !== "127.0.0.1" ||
		!Number.isInteger(record.port) ||
		(record.port as number) < 1 ||
		(record.port as number) > 65_535 ||
		typeof record.launch_id !== "string" ||
		!UUID.test(record.launch_id)
	) return undefined;
	return { host: "127.0.0.1", port: record.port as number, launchId: record.launch_id };
}

function parseControllerRecord(value: unknown): ControllerRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.schema_version !== 1 ||
		typeof record.launch_id !== "string" ||
		!UUID.test(record.launch_id) ||
		typeof record.project_directory !== "string" ||
		!path.isAbsolute(record.project_directory) ||
		!Number.isInteger(record.pid) ||
		(record.pid as number) < 1 ||
		typeof record.resume_token !== "string" ||
		!TOKEN.test(record.resume_token)
	) return undefined;
	return record as unknown as ControllerRecord;
}

async function readJsonFile(file: string): Promise<unknown> {
	const metadata = await lstat(file);
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (
		metadata.isSymbolicLink() ||
		!metadata.isFile() ||
		metadata.size > 16 * 1024 ||
		(metadata.mode & 0o077) !== 0 ||
		(uid !== undefined && metadata.uid !== uid)
	) {
		throw new Error(`UNSAFE_RUNTIME_FILE: ${file}`);
	}
	return JSON.parse(await readFile(file, "utf8"));
}

export async function persistControllerCredential(options: {
	readonly runtimeDirectory: string;
	readonly projectDirectory: string;
	readonly launchId: string;
	readonly pid: number;
	readonly resumeToken: string;
}): Promise<void> {
	await verifyPrivateDirectory(options.runtimeDirectory);
	await verifyPrivateDirectory(path.dirname(options.runtimeDirectory));
	const projectDirectory = await realpath(options.projectDirectory);
	const record: ControllerRecord = {
		schema_version: 1,
		launch_id: options.launchId,
		project_directory: projectDirectory,
		pid: options.pid,
		resume_token: options.resumeToken,
	};
	const file = controllerCredentialPath(options.runtimeDirectory);
	try {
		const handle = await open(file, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = parseControllerRecord(await readJsonFile(file));
		if (
			existing?.launch_id !== record.launch_id ||
			existing.project_directory !== projectDirectory ||
			existing.pid !== record.pid ||
			existing.resume_token !== record.resume_token
		) {
			throw new Error("UNSAFE_RUNTIME_FILE: controller credential collision");
		}
	}
}

export async function removeControllerCredential(runtimeDirectory: string): Promise<void> {
	try {
		await unlink(controllerCredentialPath(runtimeDirectory));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function discoverControllers(options: {
	readonly projectDirectory: string;
	readonly runtimeBaseDirectory: string;
}): Promise<DiscoveredController[]> {
	const projectDirectory = await realpath(options.projectDirectory);
	const userDirectory = userRuntimeDirectory(options.runtimeBaseDirectory);
	try {
		await verifyPrivateDirectory(userDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const entries = await readdir(userDirectory, { withFileTypes: true });
	const discovered: DiscoveredController[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
		const runtimeDirectory = path.join(userDirectory, entry.name);
		try {
			await verifyPrivateDirectory(runtimeDirectory);
			const endpoint = parseEndpoint(await readJsonFile(path.join(runtimeDirectory, "endpoint.json")));
			const controller = parseControllerRecord(
				await readJsonFile(controllerCredentialPath(runtimeDirectory)),
			);
			if (
				endpoint === undefined ||
				controller === undefined ||
				endpoint.launchId !== entry.name ||
				controller.launch_id !== entry.name ||
				controller.project_directory !== projectDirectory
			) continue;
			discovered.push({
				runtimeDirectory,
				host: endpoint.host,
				port: endpoint.port,
				launchId: endpoint.launchId,
				pid: controller.pid,
				resumeToken: controller.resume_token,
			});
		} catch {
			continue;
		}
	}
	return discovered;
}
