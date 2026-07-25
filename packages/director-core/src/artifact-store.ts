import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HASH_64 = /^[0-9a-f]{64}$/;
const URI = /^cclay-artifact:\/\/sha256\/([0-9a-f]{64})$/;
const UPLOAD = /^upload-([0-9a-f]{32})$/;
const RESERVATION = /^upload-([0-9a-f]{32})\.reservation$/;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const descriptorFallbacks = new Map<number, string>();

export interface ArtifactStoreLimits {
	readonly maxArtifactBytes: number;
	readonly maxProjectBytes: number;
	readonly maxConcurrentUploads: number;
	readonly maxActiveReservationBytes: number;
}

export const DEFAULT_ARTIFACT_STORE_LIMITS: ArtifactStoreLimits = {
	maxArtifactBytes: 512 * 1024 * 1024,
	maxProjectBytes: 20 * 1024 * 1024 * 1024,
	maxConcurrentUploads: 2,
	maxActiveReservationBytes: 1024 * 1024 * 1024,
};

export type ArtifactStoreErrorCode =
	| "INVALID_ARTIFACT_DESCRIPTOR"
	| "ARTIFACT_TOO_LARGE"
	| "PROJECT_QUOTA_EXCEEDED"
	| "TOO_MANY_UPLOADS"
	| "ACTIVE_RESERVATION_QUOTA_EXCEEDED"
	| "ARTIFACT_PATH_UNSAFE"
	| "ARTIFACT_LENGTH_MISMATCH"
	| "ARTIFACT_DIGEST_MISMATCH"
	| "ARTIFACT_COLLISION"
	| "ARTIFACT_NOT_FOUND"
	| "ARTIFACT_UPLOAD_CLOSED";

export class ArtifactStoreError extends Error {
	readonly code: ArtifactStoreErrorCode;
	constructor(code: ArtifactStoreErrorCode, message: string, options?: ErrorOptions) {
		super(`${code}: ${message}`, options);
		this.name = "ArtifactStoreError";
		this.code = code;
	}
}

export interface ArtifactDescriptor {
	readonly sha256: string;
	readonly uri: string;
	readonly byteLength: number;
}

export interface ArtifactReservationRequest {
	readonly expectedSha256: string;
	readonly byteLength: number;
}

interface ArtifactStoreOptions {
	readonly limits?: ArtifactStoreLimits;
}

interface AnchoredDirectory {
	readonly label: string;
	readonly handle: FileHandle;
	readonly stat: Stats;
	readonly parent?: AnchoredDirectory;
	readonly leaf?: string;
	readonly originalPath?: string;
}

interface ReservationRecord {
	readonly pid: number;
	readonly byteLength: number;
	readonly expectedSha256: string;
	readonly reservedBytes: number;
	readonly groupId: string;
}

const fail = (code: ArtifactStoreErrorCode, message: string, cause?: unknown): never => {
	throw new ArtifactStoreError(code, message, cause === undefined ? undefined : { cause });
};
const currentUid = (): number | undefined => process.getuid?.();
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const descriptorPath = (handle: FileHandle, leaf?: string): string => {
	let base: string;
	if (process.platform === "linux") base = `/proc/self/fd/${handle.fd}`;
	else {
		const fallback = descriptorFallbacks.get(handle.fd);
		if (fallback === undefined) return fail("ARTIFACT_PATH_UNSAFE", "directory descriptor has no verified path");
		// Darwin's /dev/fd directory descriptors cannot be traversed and Node exposes no openat(2).
		// Retain and verify the descriptor before every operation, then verify its parent entry again.
		// A replacement confined to the interval between those checks remains a documented Node limitation.
		base = fallback;
	}
	return leaf === undefined ? base : `${base}/${leaf}`;
};

function assertOwnedDirectory(stat: Stats, label: string, expectedDevice?: number): void {
	if (!stat.isDirectory() || stat.isSymbolicLink())
		fail("ARTIFACT_PATH_UNSAFE", `${label} must be a no-follow directory`);
	const uid = currentUid();
	if (uid !== undefined && stat.uid !== uid) fail("ARTIFACT_PATH_UNSAFE", `${label} has the wrong owner`);
	if (expectedDevice !== undefined && stat.dev !== expectedDevice)
		fail("ARTIFACT_PATH_UNSAFE", `${label} crosses a filesystem boundary`);
}

function assertOwnedFile(stat: Stats, label: string, expectedDevice: number, allowedLinks = 1): void {
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== allowedLinks)
		fail("ARTIFACT_PATH_UNSAFE", `${label} must be a regular file with ${allowedLinks} link(s)`);
	const uid = currentUid();
	if (uid !== undefined && stat.uid !== uid) fail("ARTIFACT_PATH_UNSAFE", `${label} has the wrong owner`);
	if (stat.dev !== expectedDevice) fail("ARTIFACT_PATH_UNSAFE", `${label} crosses a filesystem boundary`);
	if ((stat.mode & 0o077) !== 0) fail("ARTIFACT_PATH_UNSAFE", `${label} must not grant group or other permissions`);
}

async function safeLstat(path: string, label: string): Promise<Stats> {
	try {
		return await lstat(path);
	} catch (error) {
		return fail("ARTIFACT_PATH_UNSAFE", `${label} cannot be anchored`, error);
	}
}

async function openRoot(path: string): Promise<AnchoredDirectory> {
	const entry = await safeLstat(path, "project directory");
	assertOwnedDirectory(entry, "project directory");
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch (error) {
		return fail("ARTIFACT_PATH_UNSAFE", "project directory cannot be opened", error);
	}
	const stat = await handle.stat();
	assertOwnedDirectory(stat, "project directory");
	if (stat.dev !== entry.dev || stat.ino !== entry.ino)
		fail("ARTIFACT_PATH_UNSAFE", "project directory changed while opening");
	descriptorFallbacks.set(handle.fd, path);
	return { label: "project directory", handle, stat, originalPath: path };
}

async function openChild(
	parent: AnchoredDirectory,
	leaf: string,
	label: string,
	create: boolean,
): Promise<AnchoredDirectory> {
	const path = descriptorPath(parent.handle, leaf);
	if (create) {
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST")
				fail("ARTIFACT_PATH_UNSAFE", `${label} cannot be created`, error);
		}
	}
	const entry = await safeLstat(path, label);
	assertOwnedDirectory(entry, label, parent.stat.dev);
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch (error) {
		return fail("ARTIFACT_PATH_UNSAFE", `${label} cannot be opened`, error);
	}
	const stat = await handle.stat();
	assertOwnedDirectory(stat, label, parent.stat.dev);
	if (stat.dev !== entry.dev || stat.ino !== entry.ino) fail("ARTIFACT_PATH_UNSAFE", `${label} changed while opening`);
	descriptorFallbacks.set(handle.fd, path);
	return { label, handle, stat, parent, leaf };
}

async function verifyDirectory(directory: AnchoredDirectory): Promise<void> {
	const own = await directory.handle.stat();
	assertOwnedDirectory(own, directory.label, directory.stat.dev);
	if (own.dev !== directory.stat.dev || own.ino !== directory.stat.ino)
		fail("ARTIFACT_PATH_UNSAFE", `${directory.label} descriptor changed`);
	const entryPath = directory.parent
		? descriptorPath(directory.parent.handle, directory.leaf)
		: directory.originalPath;
	if (entryPath === undefined) return fail("ARTIFACT_PATH_UNSAFE", `${directory.label} has no parent anchor`);
	const entry = await safeLstat(entryPath, directory.label);
	assertOwnedDirectory(entry, directory.label, directory.stat.dev);
	if (entry.dev !== own.dev || entry.ino !== own.ino)
		fail("ARTIFACT_PATH_UNSAFE", `${directory.label} no longer matches its parent entry`);
}

export class ArtifactStore {
	readonly rootDir: string;
	readonly artifactsDir: string;
	readonly tempDir: string;
	readonly limits: ArtifactStoreLimits;
	private readonly project: AnchoredDirectory;
	private readonly cclay: AnchoredDirectory;
	private readonly artifacts: AnchoredDirectory;
	private readonly temp: AnchoredDirectory;
	private closed = false;

	private constructor(
		rootDir: string,
		limits: ArtifactStoreLimits,
		project: AnchoredDirectory,
		cclay: AnchoredDirectory,
		artifacts: AnchoredDirectory,
		temp: AnchoredDirectory,
	) {
		this.rootDir = rootDir;
		this.artifactsDir = join(rootDir, ".cclay", "artifacts");
		this.tempDir = join(this.artifactsDir, ".tmp");
		this.limits = limits;
		this.project = project;
		this.cclay = cclay;
		this.artifacts = artifacts;
		this.temp = temp;
	}

	static async open(rootDir: string, options: ArtifactStoreOptions = {}): Promise<ArtifactStore> {
		const opened: AnchoredDirectory[] = [];
		try {
			const project = await openRoot(rootDir);
			opened.push(project);
			const cclay = await openChild(project, ".cclay", ".cclay", true);
			opened.push(cclay);
			const artifacts = await openChild(cclay, "artifacts", ".cclay/artifacts", true);
			opened.push(artifacts);
			const temp = await openChild(artifacts, ".tmp", ".cclay/artifacts/.tmp", true);
			opened.push(temp);
			const store = new ArtifactStore(
				rootDir,
				options.limits ?? DEFAULT_ARTIFACT_STORE_LIMITS,
				project,
				cclay,
				artifacts,
				temp,
			);
			await store.withProjectLock(() => store.recoverTempsLocked());
			return store;
		} catch (error) {
			for (const directory of opened.reverse()) {
				descriptorFallbacks.delete(directory.handle.fd);
				await directory.handle.close();
			}
			throw error;
		}
	}

	private async verifyHierarchy(): Promise<void> {
		await verifyDirectory(this.project);
		await verifyDirectory(this.cclay);
		await verifyDirectory(this.artifacts);
		await verifyDirectory(this.temp);
	}

	private async withProjectLock<T>(operation: () => Promise<T>): Promise<T> {
		await this.verifyHierarchy();
		const lockPath = descriptorPath(this.cclay.handle, "artifact-store.lock");
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		let lock: FileHandle | undefined;
		while (lock === undefined) {
			try {
				lock = await open(
					lockPath,
					constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR,
					0o600,
				);
				await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
				await lock.sync();
				await this.cclay.handle.sync();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST")
					fail("ARTIFACT_PATH_UNSAFE", "project artifact lock cannot be acquired", error);
				await this.breakStaleLock(lockPath);
				if (Date.now() >= deadline) fail("ARTIFACT_PATH_UNSAFE", "project artifact lock timed out");
				await sleep(LOCK_RETRY_MS);
			}
		}
		const release = async (): Promise<void> => {
			const held = await lock.stat();
			await lock.close();
			try {
				const entry = await lstat(lockPath);
				if (entry.dev !== held.dev || entry.ino !== held.ino)
					fail("ARTIFACT_PATH_UNSAFE", "project artifact lock was replaced");
				await unlink(lockPath);
				await this.cclay.handle.sync();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		};
		let result: T;
		try {
			await this.verifyHierarchy();
			result = await operation();
		} catch (error) {
			await release();
			throw error;
		}
		await release();
		return result;
	}

	private async breakStaleLock(lockPath: string): Promise<void> {
		let stat: Stats;
		try {
			stat = await lstat(lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		assertOwnedFile(stat, "project artifact lock", this.project.stat.dev);
		if (Date.now() - stat.mtimeMs < STALE_LOCK_MS) return;
		let pid = -1;
		try {
			const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
			if (typeof parsed.pid === "number") pid = parsed.pid;
		} catch {}
		if (pid > 0) {
			try {
				process.kill(pid, 0);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
			}
		}
		const current = await lstat(lockPath);
		if (current.dev === stat.dev && current.ino === stat.ino) await unlink(lockPath);
	}

	private async committedBytes(): Promise<number> {
		const walk = async (directory: AnchoredDirectory): Promise<number> => {
			let total = 0;
			for (const entry of await readdir(descriptorPath(directory.handle), { withFileTypes: true })) {
				const path = descriptorPath(directory.handle, entry.name);
				const stat = await safeLstat(path, `artifact entry ${entry.name}`);
				if (stat.isSymbolicLink()) fail("ARTIFACT_PATH_UNSAFE", `artifact entry ${entry.name} is a symlink`);
				if (stat.isFile()) {
					assertOwnedFile(stat, `artifact entry ${entry.name}`, this.project.stat.dev);
					total += stat.size;
					continue;
				}
				if (!stat.isDirectory()) fail("ARTIFACT_PATH_UNSAFE", `artifact entry ${entry.name} has an unsafe type`);
				const child = await openChild(directory, entry.name, `artifact entry ${entry.name}`, false);
				try {
					total += await walk(child);
				} finally {
					await child.handle.close();
				}
			}
			return total;
		};
		let total = 0;
		for (const entry of await readdir(descriptorPath(this.artifacts.handle), { withFileTypes: true })) {
			if (entry.name === ".tmp") continue;
			if (!HASH_64.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
				fail("ARTIFACT_PATH_UNSAFE", `unexpected artifact entry ${entry.name}`);
			const child = await openChild(this.artifacts, entry.name, `artifact directory ${entry.name}`, false);
			try {
				total += await walk(child);
			} finally {
				await child.handle.close();
			}
		}
		return total;
	}

	private async activeReservations(): Promise<{ count: number; bytes: number }> {
		const groups = new Set<string>();
		let bytes = 0;
		for (const entry of await readdir(descriptorPath(this.temp.handle), { withFileTypes: true })) {
			const match = RESERVATION.exec(entry.name);
			if (match === null) continue;
			const record = await this.readReservationRecord(entry.name);
			const uploadPath = descriptorPath(this.temp.handle, `upload-${match[1]}`);
			const stat = await safeLstat(uploadPath, `temporary upload-${match[1]}`);
			assertOwnedFile(stat, `temporary upload-${match[1]}`, this.project.stat.dev);
			if (stat.size !== record.byteLength)
				fail("ARTIFACT_PATH_UNSAFE", "reservation length does not match its temporary file");
			groups.add(record.groupId);
			bytes += record.reservedBytes;
		}
		return { count: groups.size, bytes };
	}

	private async readReservationRecord(leaf: string): Promise<ReservationRecord> {
		const path = descriptorPath(this.temp.handle, leaf);
		const stat = await safeLstat(path, `reservation ${leaf}`);
		assertOwnedFile(stat, `reservation ${leaf}`, this.project.stat.dev);
		try {
			const value = JSON.parse(await readFile(path, "utf8")) as Partial<ReservationRecord>;
			if (
				!Number.isSafeInteger(value.pid) ||
				!Number.isSafeInteger(value.byteLength) ||
				(value.byteLength ?? -1) < 0 ||
				!Number.isSafeInteger(value.reservedBytes) ||
				(value.reservedBytes ?? -1) < 0 ||
				(value.reservedBytes ?? Number.POSITIVE_INFINITY) > (value.byteLength ?? -1) ||
				typeof value.expectedSha256 !== "string" ||
				!HASH_64.test(value.expectedSha256) ||
				typeof value.groupId !== "string" ||
				!HASH_64.test(value.groupId)
			)
				fail("ARTIFACT_PATH_UNSAFE", `reservation ${leaf} is malformed`);
			return value as ReservationRecord;
		} catch (error) {
			if (error instanceof ArtifactStoreError) throw error;
			return fail("ARTIFACT_PATH_UNSAFE", `reservation ${leaf} is malformed`, error);
		}
	}

	async reserve(request: ArtifactReservationRequest): Promise<ArtifactReservation> {
		const reservations = await this.reserveBatch([request]);
		return reservations[0]!;
	}

	async reserveBatch(requests: readonly ArtifactReservationRequest[]): Promise<ArtifactReservation[]> {
		if (requests.length === 0) fail("INVALID_ARTIFACT_DESCRIPTOR", "reservation batch must not be empty");
		for (const request of requests) {
			if (
				!HASH_64.test(request.expectedSha256) ||
				!Number.isSafeInteger(request.byteLength) ||
				request.byteLength < 0
			)
				fail("INVALID_ARTIFACT_DESCRIPTOR", "expectedSha256 and byteLength are invalid");
			if (request.byteLength > this.limits.maxArtifactBytes)
				fail("ARTIFACT_TOO_LARGE", "declared length exceeds the per-artifact limit");
		}
		return this.withProjectLock(async () => {
			const declarations: Array<{ request: ArtifactReservationRequest; reservationBytes: number }> = [];
			for (const request of requests) {
				let reservationBytes = request.byteLength;
				try {
					const existing = await this.read(`cclay-artifact://sha256/${request.expectedSha256}`);
					if (existing.byteLength !== request.byteLength)
						fail("ARTIFACT_COLLISION", "existing payload length differs from the declaration");
					reservationBytes = 0;
				} catch (error) {
					if (!(error instanceof ArtifactStoreError) || error.code !== "ARTIFACT_NOT_FOUND") throw error;
				}
				declarations.push({ request, reservationBytes });
			}
			const active = await this.activeReservations();
			if (active.count >= this.limits.maxConcurrentUploads)
				fail("TOO_MANY_UPLOADS", "concurrent upload limit reached");
			const batchBytes = declarations.reduce((total, declaration) => total + declaration.reservationBytes, 0);
			if (active.bytes + batchBytes > this.limits.maxActiveReservationBytes)
				fail("ACTIVE_RESERVATION_QUOTA_EXCEEDED", "active reservation byte limit reached");
			if ((await this.committedBytes()) + active.bytes + batchBytes > this.limits.maxProjectBytes)
				fail("PROJECT_QUOTA_EXCEEDED", "committed bytes plus reservations exceed the project quota");

			const groupId = randomBytes(32).toString("hex");
			const reservations: ArtifactReservation[] = [];
			try {
				for (const { request, reservationBytes } of declarations) {
					const id = randomBytes(16).toString("hex");
					const leaf = `upload-${id}`;
					const tempPath = descriptorPath(this.temp.handle, leaf);
					const recordLeaf = `${leaf}.reservation`;
					const recordPath = descriptorPath(this.temp.handle, recordLeaf);
					let handle: FileHandle | undefined;
					try {
						handle = await open(
							tempPath,
							constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR,
							0o600,
						);
						await handle.truncate(request.byteLength);
						const stat = await handle.stat();
						assertOwnedFile(stat, leaf, this.project.stat.dev);
						await writeFile(
							recordPath,
							JSON.stringify({ pid: process.pid, ...request, reservedBytes: reservationBytes, groupId }),
							{ flag: "wx", mode: 0o600 },
						);
						reservations.push(new ArtifactReservation(this, request, reservationBytes, leaf, recordLeaf, handle));
					} catch (error) {
						await handle?.close().catch(() => undefined);
						await unlink(tempPath).catch(() => undefined);
						await unlink(recordPath).catch(() => undefined);
						throw error;
					}
				}
				await this.temp.handle.sync();
				return reservations;
			} catch (error) {
				await Promise.allSettled(
					reservations.flatMap((reservation) => [
						reservation.handle.close(),
						unlink(descriptorPath(this.temp.handle, reservation.leaf)),
						unlink(descriptorPath(this.temp.handle, reservation.recordLeaf)),
					]),
				);
				throw error;
			}
		});
	}

	async publish(
		request: ArtifactReservationRequest,
		chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
	): Promise<ArtifactDescriptor> {
		const reservation = await this.reserve(request);
		try {
			for await (const chunk of chunks) await reservation.write(chunk);
			return await reservation.commit();
		} catch (error) {
			await reservation.abort();
			throw error;
		}
	}

	async read(uri: string): Promise<Uint8Array> {
		const match = URI.exec(uri);
		if (match === null) throw new ArtifactStoreError("INVALID_ARTIFACT_DESCRIPTOR", "URI is not canonical");
		await this.verifyHierarchy();
		const digestValue = match[1]!;
		let digestDirectory: AnchoredDirectory;
		try {
			digestDirectory = await openChild(this.artifacts, digestValue, `artifact directory ${digestValue}`, false);
		} catch (error) {
			if (
				(error as ArtifactStoreError).cause &&
				((error as ArtifactStoreError).cause as NodeJS.ErrnoException).code === "ENOENT"
			)
				fail("ARTIFACT_NOT_FOUND", digestValue);
			throw error;
		}
		try {
			const payloadPath = descriptorPath(digestDirectory.handle, "payload");
			let handle: FileHandle;
			try {
				handle = await open(payloadPath, constants.O_RDONLY | constants.O_NOFOLLOW);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("ARTIFACT_NOT_FOUND", digestValue);
				throw error;
			}
			try {
				const stat = await handle.stat();
				assertOwnedFile(stat, `artifact ${digestValue}`, this.project.stat.dev);
				const bytes = await handle.readFile();
				if (createHash("sha256").update(bytes).digest("hex") !== digestValue)
					fail("ARTIFACT_COLLISION", "stored payload does not match its digest directory");
				return bytes;
			} finally {
				await handle.close();
			}
		} finally {
			await digestDirectory.handle.close();
		}
	}

	async recoverTemps(): Promise<void> {
		await this.withProjectLock(() => this.recoverTempsLocked());
	}

	private async recoverTempsLocked(): Promise<void> {
		const entries = await readdir(descriptorPath(this.temp.handle), { withFileTypes: true });
		const live = new Set<string>();
		for (const entry of entries) {
			const match = RESERVATION.exec(entry.name);
			if (match === null) continue;
			const record = await this.readReservationRecord(entry.name);
			let running = record.pid === process.pid;
			if (!running) {
				try {
					process.kill(record.pid, 0);
					running = true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") running = true;
				}
			}
			if (running) live.add(match[1]!);
			else {
				await this.unlinkSafe(`upload-${match[1]}`, true);
				await this.unlinkSafe(entry.name, true);
			}
		}
		for (const entry of entries) {
			const match = UPLOAD.exec(entry.name);
			if (match === null) {
				if (RESERVATION.test(entry.name)) continue;
				return fail("ARTIFACT_PATH_UNSAFE", `unexpected temporary entry ${entry.name}`);
			}
			if (live.has(match[1]!)) continue;
			const path = descriptorPath(this.temp.handle, entry.name);
			const stat = await safeLstat(path, `temporary ${entry.name}`);
			if (stat.nlink === 1) {
				assertOwnedFile(stat, `temporary ${entry.name}`, this.project.stat.dev);
				await unlink(path);
				continue;
			}
			assertOwnedFile(stat, `temporary ${entry.name}`, this.project.stat.dev, 2);
			const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			let digestValue: string;
			try {
				const hash = createHash("sha256");
				for await (const chunk of handle.createReadStream()) hash.update(chunk);
				digestValue = hash.digest("hex");
			} finally {
				await handle.close();
			}
			const digestDirectory = await openChild(
				this.artifacts,
				digestValue,
				`artifact directory ${digestValue}`,
				false,
			);
			try {
				const payload = await safeLstat(
					descriptorPath(digestDirectory.handle, "payload"),
					`artifact ${digestValue}`,
				);
				if (payload.dev !== stat.dev || payload.ino !== stat.ino || payload.nlink !== 2)
					fail("ARTIFACT_PATH_UNSAFE", `temporary ${entry.name} is not linked to its digest payload`);
			} finally {
				await digestDirectory.handle.close();
			}
			await unlink(path);
		}
		await this.temp.handle.sync();
	}

	private async unlinkSafe(leaf: string, allowMissing: boolean, allowedLinks = 1): Promise<void> {
		const path = descriptorPath(this.temp.handle, leaf);
		try {
			const stat = await lstat(path);
			assertOwnedFile(stat, `temporary ${leaf}`, this.project.stat.dev, allowedLinks);
			await unlink(path);
		} catch (error) {
			if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}

	async commitReservation(reservation: ArtifactReservation, actualDigest: string): Promise<ArtifactDescriptor> {
		return this.withProjectLock(async () => {
			await this.verifyHierarchy();
			const finalTemp = await reservation.handle.stat();
			assertOwnedFile(finalTemp, reservation.leaf, this.project.stat.dev);
			const digestDirectory = await openChild(
				this.artifacts,
				actualDigest,
				`artifact directory ${actualDigest}`,
				true,
			);
			try {
				const payloadPath = descriptorPath(digestDirectory.handle, "payload");
				const tempPath = descriptorPath(this.temp.handle, reservation.leaf);
				try {
					// Node exposes neither renameat2(RENAME_NOREPLACE) nor renameatx_np(RENAME_EXCL).
					// A descriptor-anchored hard link is the strongest atomic no-replace primitive it exposes:
					// link creation is exclusive, and a crash before temp unlink is recovered from the two links.
					await link(tempPath, payloadPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const existing = await this.read(`cclay-artifact://sha256/${actualDigest}`);
					if (existing.byteLength !== reservation.request.byteLength)
						fail("ARTIFACT_COLLISION", "existing payload length differs");
					await this.unlinkSafe(reservation.leaf, false);
					await this.unlinkSafe(reservation.recordLeaf, false);
					await this.temp.handle.sync();
					return reservation.descriptor(actualDigest);
				}
				await digestDirectory.handle.sync();
				const published = await safeLstat(payloadPath, `artifact ${actualDigest}`);
				if (published.dev !== finalTemp.dev || published.ino !== finalTemp.ino || published.nlink !== 2)
					fail("ARTIFACT_PATH_UNSAFE", "published payload does not match the verified temporary file");
				await this.unlinkSafe(reservation.leaf, false, 2);
				const singleLink = await safeLstat(payloadPath, `artifact ${actualDigest}`);
				assertOwnedFile(singleLink, `artifact ${actualDigest}`, this.project.stat.dev);
				await this.unlinkSafe(reservation.recordLeaf, false);
				await this.temp.handle.sync();
				await digestDirectory.handle.sync();
				return reservation.descriptor(actualDigest);
			} finally {
				await digestDirectory.handle.close();
			}
		});
	}

	async abortReservation(reservation: ArtifactReservation): Promise<void> {
		await this.withProjectLock(async () => {
			await this.unlinkSafe(reservation.leaf, true);
			await this.unlinkSafe(reservation.recordLeaf, true);
			await this.temp.handle.sync();
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const directory of [this.temp, this.artifacts, this.cclay, this.project]) {
			descriptorFallbacks.delete(directory.handle.fd);
			await directory.handle.close();
		}
	}
}

export class ArtifactReservation {
	readonly store: ArtifactStore;
	readonly request: ArtifactReservationRequest;
	readonly reservationBytes: number;
	readonly leaf: string;
	readonly recordLeaf: string;
	readonly handle: FileHandle;
	private readonly hash = createHash("sha256");
	private readonly ranges: Array<{ start: number; end: number }> = [];
	private written = 0;
	private sequential = true;
	private closed = false;

	constructor(
		store: ArtifactStore,
		request: ArtifactReservationRequest,
		reservationBytes: number,
		leaf: string,
		recordLeaf: string,
		handle: FileHandle,
	) {
		this.store = store;
		this.request = request;
		this.reservationBytes = reservationBytes;
		this.leaf = leaf;
		this.recordLeaf = recordLeaf;
		this.handle = handle;
	}

	async write(chunk: Uint8Array, position = this.written): Promise<void> {
		if (this.closed) fail("ARTIFACT_UPLOAD_CLOSED", "upload is terminal");
		if (!(chunk instanceof Uint8Array) || !Number.isSafeInteger(position) || position < 0)
			fail("INVALID_ARTIFACT_DESCRIPTOR", "artifact chunk and position are invalid");
		const end = position + chunk.byteLength;
		if (end > this.request.byteLength) {
			await this.abort();
			fail("ARTIFACT_LENGTH_MISMATCH", "stream exceeded its declared byte length");
		}
		if (this.ranges.some((range) => position < range.end && end > range.start)) {
			await this.abort();
			fail("ARTIFACT_LENGTH_MISMATCH", "artifact chunks overlap");
		}
		await this.handle.write(chunk, 0, chunk.byteLength, position);
		if (position === this.written && this.sequential) this.hash.update(chunk);
		else this.sequential = false;
		this.ranges.push({ start: position, end });
		this.written += chunk.byteLength;
	}

	async writeAt(position: number, chunk: Uint8Array): Promise<void> {
		await this.write(chunk, position);
	}

	async commit(): Promise<ArtifactDescriptor> {
		if (this.closed) fail("ARTIFACT_UPLOAD_CLOSED", "upload is terminal");
		try {
			if (this.written !== this.request.byteLength)
				fail("ARTIFACT_LENGTH_MISMATCH", "stream did not match its declared byte length");
			let actualDigest: string;
			if (this.sequential) actualDigest = this.hash.digest("hex");
			else {
				const hash = createHash("sha256");
				for await (const chunk of this.handle.createReadStream({
					start: 0,
					end: this.request.byteLength - 1,
					autoClose: false,
				}))
					hash.update(chunk);
				actualDigest = hash.digest("hex");
			}
			if (actualDigest !== this.request.expectedSha256)
				fail("ARTIFACT_DIGEST_MISMATCH", "stream did not match its declared digest");
			await this.handle.sync();
			const descriptor = await this.store.commitReservation(this, actualDigest);
			this.closed = true;
			await this.handle.close();
			return descriptor;
		} catch (error) {
			await this.abort();
			throw error;
		}
	}

	descriptor(actualDigest: string): ArtifactDescriptor {
		return {
			sha256: actualDigest,
			uri: `cclay-artifact://sha256/${actualDigest}`,
			byteLength: this.request.byteLength,
		};
	}

	async abort(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.handle.close().catch(() => undefined);
		await this.store.abortReservation(this);
	}
}
