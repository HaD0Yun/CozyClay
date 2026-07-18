import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const HASH_64 = /^[0-9a-f]{64}$/;
const URI = /^omb-artifact:\/\/sha256\/([0-9a-f]{64})$/;

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

const fail = (code: ArtifactStoreErrorCode, message: string, cause?: unknown): never => {
	throw new ArtifactStoreError(code, message, cause === undefined ? undefined : { cause });
};
const currentUid = (): number | undefined => process.getuid?.();

function assertOwnedDirectory(stat: Stats, label: string, expectedDevice?: bigint): void {
	if (!stat.isDirectory() || stat.isSymbolicLink())
		fail("ARTIFACT_PATH_UNSAFE", `${label} must be a no-follow directory`);
	const uid = currentUid();
	if (uid !== undefined && stat.uid !== uid) fail("ARTIFACT_PATH_UNSAFE", `${label} has the wrong owner`);
	if (expectedDevice !== undefined && BigInt(stat.dev) !== expectedDevice) {
		fail("ARTIFACT_PATH_UNSAFE", `${label} crosses a filesystem boundary`);
	}
}

function assertOwnedPayload(stat: Stats, label: string): void {
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
		fail("ARTIFACT_PATH_UNSAFE", `${label} must be a regular file with one link`);
	}
	const uid = currentUid();
	if (uid !== undefined && stat.uid !== uid) fail("ARTIFACT_PATH_UNSAFE", `${label} has the wrong owner`);
	if ((stat.mode & 0o077) !== 0) fail("ARTIFACT_PATH_UNSAFE", `${label} must not grant group or other permissions`);
}

async function pathStat(path: string, label: string): Promise<Stats> {
	try {
		return await lstat(path, { bigint: false });
	} catch (error) {
		return fail("ARTIFACT_PATH_UNSAFE", `${label} cannot be anchored`, error);
	}
}

async function ensureDirectory(path: string, label: string, expectedDevice?: bigint): Promise<Stats> {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST")
			fail("ARTIFACT_PATH_UNSAFE", `${label} cannot be created`, error);
	}
	const stat = await pathStat(path, label);
	assertOwnedDirectory(stat, label, expectedDevice);
	const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const descriptorStat = await handle.stat();
		assertOwnedDirectory(descriptorStat, label, expectedDevice);
		if (descriptorStat.dev !== stat.dev || descriptorStat.ino !== stat.ino)
			fail("ARTIFACT_PATH_UNSAFE", `${label} changed while opening`);
	} finally {
		await handle.close();
	}
	return stat;
}

export class ArtifactStore {
	readonly rootDir: string;
	readonly artifactsDir: string;
	readonly tempDir: string;
	readonly limits: ArtifactStoreLimits;
	private activeUploads = 0;
	private activeReservationBytes = 0;
	private stateTail: Promise<void> = Promise.resolve();

	private constructor(rootDir: string, limits: ArtifactStoreLimits) {
		this.rootDir = rootDir;
		this.artifactsDir = join(rootDir, ".omb", "artifacts");
		this.tempDir = join(this.artifactsDir, ".tmp");
		this.limits = limits;
	}

	static async open(rootDir: string, options: ArtifactStoreOptions = {}): Promise<ArtifactStore> {
		const store = new ArtifactStore(rootDir, options.limits ?? DEFAULT_ARTIFACT_STORE_LIMITS);
		await store.anchorHierarchy(true);
		return store;
	}

	private async anchorHierarchy(create: boolean): Promise<void> {
		const root = await pathStat(this.rootDir, "project directory");
		assertOwnedDirectory(root, "project directory");
		const device = BigInt(root.dev);
		if (!create) return;
		const omb = await ensureDirectory(join(this.rootDir, ".omb"), ".omb", device);
		await ensureDirectory(this.artifactsDir, ".omb/artifacts", BigInt(omb.dev));
		await ensureDirectory(this.tempDir, ".omb/artifacts/.tmp", device);
	}

	private async serialized<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.stateTail.then(operation);
		this.stateTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async committedBytes(): Promise<number> {
		let total = 0;
		for (const entry of await readdir(this.artifactsDir, { withFileTypes: true })) {
			if (entry.name === ".tmp") continue;
			if (!HASH_64.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
				fail("ARTIFACT_PATH_UNSAFE", `unexpected artifact entry ${entry.name}`);
			}
			const payload = join(this.artifactsDir, entry.name, "payload");
			let stat: Stats;
			try {
				stat = await pathStat(payload, `artifact ${entry.name}`);
			} catch (error) {
				if (
					(error as ArtifactStoreError).cause &&
					((error as ArtifactStoreError).cause as NodeJS.ErrnoException).code === "ENOENT"
				)
					continue;
				throw error;
			}
			assertOwnedPayload(stat, `artifact ${entry.name}`);
			total += stat.size;
		}
		return total;
	}

	async reserve(request: ArtifactReservationRequest): Promise<ArtifactReservation> {
		if (
			!HASH_64.test(request.expectedSha256) ||
			!Number.isSafeInteger(request.byteLength) ||
			request.byteLength < 0
		) {
			fail("INVALID_ARTIFACT_DESCRIPTOR", "expectedSha256 and byteLength are invalid");
		}
		if (request.byteLength > this.limits.maxArtifactBytes)
			fail("ARTIFACT_TOO_LARGE", "declared length exceeds the per-artifact limit");
		return this.serialized(async () => {
			await this.anchorHierarchy(true);
			let reservationBytes = request.byteLength;
			try {
				const existing = await this.read(`omb-artifact://sha256/${request.expectedSha256}`);
				if (existing.byteLength !== request.byteLength) {
					fail("ARTIFACT_COLLISION", "existing payload length differs from the declaration");
				}
				reservationBytes = 0;
			} catch (error) {
				if (!(error instanceof ArtifactStoreError) || error.code !== "ARTIFACT_NOT_FOUND") throw error;
			}
			if (this.activeUploads >= this.limits.maxConcurrentUploads)
				fail("TOO_MANY_UPLOADS", "concurrent upload limit reached");
			if (this.activeReservationBytes + reservationBytes > this.limits.maxActiveReservationBytes) {
				fail("ACTIVE_RESERVATION_QUOTA_EXCEEDED", "active reservation byte limit reached");
			}
			if (
				(await this.committedBytes()) + this.activeReservationBytes + reservationBytes >
				this.limits.maxProjectBytes
			) {
				fail("PROJECT_QUOTA_EXCEEDED", "committed bytes plus reservations exceed the project quota");
			}
			const leaf = `upload-${randomBytes(16).toString("hex")}`;
			const tempPath = join(this.tempDir, leaf);
			const handle = await open(
				tempPath,
				constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
				0o600,
			);
			const stat = await handle.stat();
			assertOwnedPayload(stat, leaf);
			this.activeUploads += 1;
			this.activeReservationBytes += reservationBytes;
			return new ArtifactReservation(this, request, reservationBytes, tempPath, handle);
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
		await this.anchorHierarchy(true);
		const digestValue = match[1]!;
		const payload = join(this.artifactsDir, digestValue, "payload");
		let stat: Stats;
		try {
			stat = await pathStat(payload, `artifact ${digestValue}`);
		} catch (error) {
			if (
				(error as ArtifactStoreError).cause &&
				((error as ArtifactStoreError).cause as NodeJS.ErrnoException).code === "ENOENT"
			)
				fail("ARTIFACT_NOT_FOUND", digestValue);
			throw error;
		}
		assertOwnedPayload(stat, `artifact ${digestValue}`);
		const handle = await open(payload, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const opened = await handle.stat();
			assertOwnedPayload(opened, `artifact ${digestValue}`);
			if (opened.dev !== stat.dev || opened.ino !== stat.ino)
				fail("ARTIFACT_PATH_UNSAFE", "payload changed while opening");
			const bytes = await handle.readFile();
			if (createHash("sha256").update(bytes).digest("hex") !== digestValue)
				fail("ARTIFACT_COLLISION", "stored payload does not match its digest directory");
			return bytes;
		} finally {
			await handle.close();
		}
	}

	async recoverTemps(): Promise<void> {
		await this.anchorHierarchy(true);
		for (const entry of await readdir(this.tempDir, { withFileTypes: true })) {
			if (!/^upload-[0-9a-f]{32}$/.test(entry.name)) {
				fail("ARTIFACT_PATH_UNSAFE", `unexpected temporary entry ${entry.name}`);
			}
			const path = join(this.tempDir, entry.name);
			const stat = await pathStat(path, `temporary ${entry.name}`);
			if (stat.nlink === 1) {
				assertOwnedPayload(stat, `temporary ${entry.name}`);
				await unlink(path);
				continue;
			}
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 2 || (stat.mode & 0o077) !== 0) {
				fail("ARTIFACT_PATH_UNSAFE", `temporary ${entry.name} has unsafe crash metadata`);
			}
			const uid = currentUid();
			if (uid !== undefined && stat.uid !== uid) {
				fail("ARTIFACT_PATH_UNSAFE", `temporary ${entry.name} has the wrong owner`);
			}
			const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			let bytes: Buffer;
			try {
				const opened = await handle.stat();
				if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
					fail("ARTIFACT_PATH_UNSAFE", `temporary ${entry.name} changed while opening`);
				}
				bytes = await handle.readFile();
			} finally {
				await handle.close();
			}
			const digestValue = createHash("sha256").update(bytes).digest("hex");
			const payload = await pathStat(join(this.artifactsDir, digestValue, "payload"), `artifact ${digestValue}`);
			if (payload.dev !== stat.dev || payload.ino !== stat.ino || payload.nlink !== 2) {
				fail("ARTIFACT_PATH_UNSAFE", `temporary ${entry.name} is not linked to its digest payload`);
			}
			await unlink(path);
		}
	}

	async finishReservation(bytes: number): Promise<void> {
		await this.serialized(async () => {
			this.activeUploads -= 1;
			this.activeReservationBytes -= bytes;
		});
	}
}

export class ArtifactReservation {
	private readonly hash = createHash("sha256");
	private readonly store: ArtifactStore;
	private readonly request: ArtifactReservationRequest;
	private readonly reservationBytes: number;
	private readonly tempPath: string;
	private readonly handle: FileHandle;
	private written = 0;
	private closed = false;

	constructor(
		store: ArtifactStore,
		request: ArtifactReservationRequest,
		reservationBytes: number,
		tempPath: string,
		handle: FileHandle,
	) {
		this.store = store;
		this.request = request;
		this.reservationBytes = reservationBytes;
		this.tempPath = tempPath;
		this.handle = handle;
	}

	async write(chunk: Uint8Array): Promise<void> {
		if (this.closed) fail("ARTIFACT_UPLOAD_CLOSED", "upload is terminal");
		if (!(chunk instanceof Uint8Array))
			fail("INVALID_ARTIFACT_DESCRIPTOR", "artifact chunks must be Uint8Array values");
		if (this.written + chunk.byteLength > this.request.byteLength) {
			await this.abort();
			fail("ARTIFACT_LENGTH_MISMATCH", "stream exceeded its declared byte length");
		}
		await this.handle.write(chunk);
		this.hash.update(chunk);
		this.written += chunk.byteLength;
	}

	async commit(): Promise<ArtifactDescriptor> {
		if (this.closed) fail("ARTIFACT_UPLOAD_CLOSED", "upload is terminal");
		try {
			if (this.written !== this.request.byteLength)
				fail("ARTIFACT_LENGTH_MISMATCH", "stream did not match its declared byte length");
			const actualDigest = this.hash.digest("hex");
			if (actualDigest !== this.request.expectedSha256)
				fail("ARTIFACT_DIGEST_MISMATCH", "stream did not match its declared digest");
			await this.handle.sync();
			await this.handle.close();
			const digestDir = join(this.store.artifactsDir, actualDigest);
			await ensureDirectory(digestDir, `artifact directory ${actualDigest}`);
			const payload = join(digestDir, "payload");
			try {
				await link(this.tempPath, payload);
				await unlink(this.tempPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const existing = await this.store.read(`omb-artifact://sha256/${actualDigest}`);
				if (existing.byteLength !== this.request.byteLength)
					fail("ARTIFACT_COLLISION", "existing payload length differs");
				await unlink(this.tempPath);
			}
			const published = await pathStat(payload, `artifact ${actualDigest}`);
			assertOwnedPayload(published, `artifact ${actualDigest}`);
			this.closed = true;
			await this.store.finishReservation(this.reservationBytes);
			return {
				sha256: actualDigest,
				uri: `omb-artifact://sha256/${actualDigest}`,
				byteLength: this.request.byteLength,
			};
		} catch (error) {
			await this.abort();
			throw error;
		}
	}

	async abort(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.handle.close();
		} catch {}
		try {
			await unlink(this.tempPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await this.store.finishReservation(this.reservationBytes);
	}
}
