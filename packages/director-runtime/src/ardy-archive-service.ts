import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export const MAX_MOTION_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_MOTION_PAYLOAD_BYTES = 96 * 1024 * 1024;
const MAX_NPY_HEADER_BYTES = 16 * 1024;
const REQUIRED_MEMBERS = new Set(["local_rot_mats.npy", "posed_joints.npy", "fps.npy"]);
const OPTIONAL_MEMBERS = new Set([
	"foot_contacts.npy",
	"global_rot_mats.npy",
	"global_root_heading.npy",
	"root_positions.npy",
	"smooth_root_pos.npy",
	"text.npy",
]);
const ALL_MEMBERS = new Set([...REQUIRED_MEMBERS, ...OPTIONAL_MEMBERS]);

export type ArdyArchiveErrorCode =
	| "ARDY_ARCHIVE_INVALID_ID"
	| "ARDY_ARCHIVE_NOT_FOUND"
	| "ARDY_ARCHIVE_UNSAFE_PATH"
	| "ARDY_ARCHIVE_TOO_LARGE"
	| "ARDY_ARCHIVE_MALFORMED"
	| "ARDY_ARCHIVE_INVARIANT"
	| "ARDY_ARCHIVE_IO";

export class ArdyArchiveError extends Error {
	readonly code: ArdyArchiveErrorCode;
	readonly cause?: unknown;

	constructor(code: ArdyArchiveErrorCode, message: string, cause?: unknown) {
		super(`${code}: ${message}`);
		this.name = "ArdyArchiveError";
		this.code = code;
		this.cause = cause;
	}
}

export interface MotionArchiveValidator {
	validateStructure(archive: Uint8Array, motionId: string): void;
	validateForWrite(archive: Uint8Array, motionId: string): void;
}

interface NpyMember {
	readonly name: string;
	readonly shape: readonly number[];
	readonly kind: string;
	readonly itemSize: number;
	readonly byteOrder: string;
	readonly payload: Uint8Array;
}

interface ZipMember {
	readonly name: string;
	readonly compressed: Uint8Array;
	readonly compression: number;
	readonly uncompressedSize: number;
}

function fail(code: ArdyArchiveErrorCode, message: string): never {
	throw new ArdyArchiveError(code, message);
}

function motionFileName(motionId: string): string {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(motionId)) {
		fail("ARDY_ARCHIVE_INVALID_ID", "motion id must be a lowercase [a-z0-9-] slug of at most 64 characters");
	}
	return `${motionId}.npz`;
}

function readU16(data: Uint8Array, offset: number): number {
	if (offset + 2 > data.length) fail("ARDY_ARCHIVE_MALFORMED", "truncated ZIP record");
	return data[offset]! | (data[offset + 1]! << 8);
}

function readU32(data: Uint8Array, offset: number): number {
	if (offset + 4 > data.length) fail("ARDY_ARCHIVE_MALFORMED", "truncated ZIP record");
	return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
}

function parseZip(data: Uint8Array): ZipMember[] {
	let eocd = -1;
	for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65_557); offset--) {
		if (readU32(data, offset) === 0x06054b50) {
			eocd = offset;
			break;
		}
	}
	if (eocd < 0) fail("ARDY_ARCHIVE_MALFORMED", "not a ZIP/NPZ archive");
	const entries = readU16(data, eocd + 10);
	const centralSize = readU32(data, eocd + 12);
	let offset = readU32(data, eocd + 16);
	if (offset + centralSize > data.length) fail("ARDY_ARCHIVE_MALFORMED", "truncated ZIP central directory");
	const members: ZipMember[] = [];
	for (let index = 0; index < entries; index++) {
		if (readU32(data, offset) !== 0x02014b50) fail("ARDY_ARCHIVE_MALFORMED", "invalid ZIP central-directory entry");
		const compression = readU16(data, offset + 10);
		const compressedSize = readU32(data, offset + 20);
		const uncompressedSize = readU32(data, offset + 24);
		const nameLength = readU16(data, offset + 28);
		const extraLength = readU16(data, offset + 30);
		const commentLength = readU16(data, offset + 32);
		const localOffset = readU32(data, offset + 42);
		const name = new TextDecoder("utf-8", { fatal: true }).decode(
			data.subarray(offset + 46, offset + 46 + nameLength),
		);
		if (readU32(data, localOffset) !== 0x04034b50) fail("ARDY_ARCHIVE_MALFORMED", "invalid ZIP local entry");
		const localNameLength = readU16(data, localOffset + 26);
		const localExtraLength = readU16(data, localOffset + 28);
		const start = localOffset + 30 + localNameLength + localExtraLength;
		const end = start + compressedSize;
		if (end > data.length) fail("ARDY_ARCHIVE_MALFORMED", "truncated ZIP member");
		members.push({ name, compression, compressed: data.subarray(start, end), uncompressedSize });
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return members;
}

function decodeMember(member: ZipMember): Uint8Array {
	try {
		const payload =
			member.compression === 0
				? member.compressed
				: member.compression === 8
					? inflateRawSync(member.compressed)
					: null;
		if (payload === null || payload.length !== member.uncompressedSize)
			fail("ARDY_ARCHIVE_MALFORMED", `invalid compressed member ${member.name}`);
		return payload;
	} catch (error) {
		if (error instanceof ArdyArchiveError) throw error;
		fail("ARDY_ARCHIVE_MALFORMED", `cannot decompress ${member.name}`);
	}
}

function parseNpy(name: string, bytes: Uint8Array): NpyMember {
	if (bytes.length < 10 || String.fromCharCode(...bytes.subarray(0, 6)) !== "\u0093NUMPY")
		fail("ARDY_ARCHIVE_MALFORMED", `${name} has an invalid NPY magic`);
	const major = bytes[6]!;
	const headerSize = major === 1 ? 2 : major === 2 || major === 3 ? 4 : 0;
	if (headerSize === 0 || bytes.length < 8 + headerSize)
		fail("ARDY_ARCHIVE_MALFORMED", `${name} has an unsupported or truncated NPY header`);
	const headerLength = headerSize === 2 ? readU16(bytes, 8) : readU32(bytes, 8);
	const start = 8 + headerSize;
	if (headerLength > MAX_NPY_HEADER_BYTES || start + headerLength > bytes.length)
		fail("ARDY_ARCHIVE_MALFORMED", `${name} has an invalid NPY header length`);
	const header = new TextDecoder(major === 3 ? "utf-8" : "latin1", { fatal: true }).decode(
		bytes.subarray(start, start + headerLength),
	);
	const match =
		/^\{'descr': '([<>=|])([A-Za-z?])(\d{1,4})', 'fortran_order': (False|True), 'shape': \(([^)]*)\),? \}\s*$/.exec(
			header,
		);
	if (match === null || match[4] !== "False") fail("ARDY_ARCHIVE_MALFORMED", `${name} has unsupported NPY metadata`);
	const shape =
		match[5] === ""
			? []
			: match[5]!
					.split(",")
					.filter(Boolean)
					.map((value) => Number(value.trim()));
	if (shape.some((value) => !Number.isSafeInteger(value) || value < 0))
		fail("ARDY_ARCHIVE_MALFORMED", `${name} has an invalid shape`);
	const itemSize = Number(match[3]);
	const byteSize = match[2] === "U" ? itemSize * 4 : itemSize;
	const expected = shape.reduce((total, value) => total * value, 1) * byteSize;
	const payload = bytes.subarray(start + headerLength);
	if (!Number.isSafeInteger(expected) || payload.length !== expected)
		fail("ARDY_ARCHIVE_MALFORMED", `${name} payload size does not match its header`);
	return { name, shape, kind: match[2]!, itemSize: byteSize, byteOrder: match[1]!, payload };
}

function isNumeric(member: NpyMember): boolean {
	return (
		((member.kind === "i" || member.kind === "u") && [1, 2, 4, 8].includes(member.itemSize)) ||
		(member.kind === "f" && [2, 4, 8].includes(member.itemSize))
	);
}

function scalarInteger(member: NpyMember): number {
	if (member.shape.length !== 0 || !["i", "u"].includes(member.kind) || ![1, 2, 4, 8].includes(member.itemSize))
		fail("ARDY_ARCHIVE_MALFORMED", "fps.npy must be an integral scalar");
	const view = new DataView(member.payload.buffer, member.payload.byteOffset, member.payload.byteLength);
	const little = member.byteOrder !== ">";
	if (member.itemSize === 1) return member.kind === "i" ? view.getInt8(0) : view.getUint8(0);
	if (member.itemSize === 2) return member.kind === "i" ? view.getInt16(0, little) : view.getUint16(0, little);
	if (member.itemSize === 4) return member.kind === "i" ? view.getInt32(0, little) : view.getUint32(0, little);
	const value = member.kind === "i" ? view.getBigInt64(0, little) : view.getBigUint64(0, little);
	if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
		fail("ARDY_ARCHIVE_MALFORMED", "fps.npy is outside JavaScript's safe integer range");
	return Number(value);
}

function firstFloat(member: NpyMember, offset: number): number {
	if (member.kind !== "f" || ![4, 8].includes(member.itemSize))
		fail("ARDY_ARCHIVE_INVARIANT", `${member.name} must use float32 or float64 for replay validation`);
	const view = new DataView(member.payload.buffer, member.payload.byteOffset, member.payload.byteLength);
	return member.itemSize === 4
		? view.getFloat32(offset * 4, member.byteOrder !== ">")
		: view.getFloat64(offset * 8, member.byteOrder !== ">");
}

export class NpzMotionArchiveValidator implements MotionArchiveValidator {
	validateStructure(archive: Uint8Array, motionId: string): void {
		const members = parseZip(archive);
		const names = new Set<string>();
		let declared = 0;
		const decoded = new Map<string, NpyMember>();
		for (const member of members) {
			if (
				names.has(member.name) ||
				member.name !== basename(member.name) ||
				member.name.includes("\\") ||
				!ALL_MEMBERS.has(member.name)
			)
				fail("ARDY_ARCHIVE_MALFORMED", `motion ${motionId} contains an unsafe or unknown member`);
			names.add(member.name);
			declared += member.uncompressedSize;
			if (declared > MAX_MOTION_PAYLOAD_BYTES)
				fail("ARDY_ARCHIVE_MALFORMED", `motion ${motionId} exceeds the uncompressed payload limit`);
			decoded.set(member.name, parseNpy(member.name, decodeMember(member)));
		}
		for (const name of REQUIRED_MEMBERS)
			if (!decoded.has(name)) fail("ARDY_ARCHIVE_MALFORMED", `motion ${motionId} is missing ${name}`);
		const rotations = decoded.get("local_rot_mats.npy")!;
		const joints = decoded.get("posed_joints.npy")!;
		if (
			rotations.shape.length !== 4 ||
			rotations.shape[1] !== 27 ||
			rotations.shape[2] !== 3 ||
			rotations.shape[3] !== 3 ||
			!rotations.shape[0] ||
			rotations.shape[0]! > 24_000 ||
			!isNumeric(rotations)
		)
			fail("ARDY_ARCHIVE_MALFORMED", "local_rot_mats.npy must be numeric (F, 27, 3, 3)");
		if (
			joints.shape.length !== 3 ||
			joints.shape[0] !== rotations.shape[0] ||
			joints.shape[1] !== 27 ||
			joints.shape[2] !== 3 ||
			!isNumeric(joints)
		)
			fail("ARDY_ARCHIVE_MALFORMED", "posed_joints.npy must be numeric (F, 27, 3)");
		scalarInteger(decoded.get("fps.npy")!);
		const optional = [
			["foot_contacts.npy", ["b"], [rotations.shape[0], 4]],
			["global_rot_mats.npy", ["f"], [rotations.shape[0], 27, 3, 3]],
			["global_root_heading.npy", ["f"], [rotations.shape[0], 2]],
			["root_positions.npy", ["f"], [rotations.shape[0], 3]],
			["smooth_root_pos.npy", ["f"], [rotations.shape[0], 3]],
			["text.npy", ["U"], []],
		] as const;
		for (const [name, kinds, shape] of optional) {
			const member = decoded.get(name);
			if (
				member !== undefined &&
				(!kinds.some((kind) => kind === member.kind) ||
					member.shape.length !== shape.length ||
					member.shape.some((value, index) => value !== shape[index]))
			) {
				fail("ARDY_ARCHIVE_MALFORMED", `${name} has an unsupported replay shape or dtype`);
			}
		}
	}

	validateForWrite(archive: Uint8Array, motionId: string): void {
		this.validateStructure(archive, motionId);
		const members = new Map(
			parseZip(archive).map((member) => [member.name, parseNpy(member.name, decodeMember(member))]),
		);
		const fps = scalarInteger(members.get("fps.npy")!);
		if (fps < 1 || fps > 240) fail("ARDY_ARCHIVE_INVARIANT", "fps must be in 1..240");
		const joints = members.get("posed_joints.npy")!;
		const rotations = members.get("local_rot_mats.npy")!;
		for (let offset = 0; offset < joints.shape[0]! * 27 * 3; offset++)
			if (!Number.isFinite(firstFloat(joints, offset)))
				fail("ARDY_ARCHIVE_INVARIANT", "posed_joints.npy contains a non-finite replay value");
		for (let offset = 0; offset < rotations.shape[0]! * 27 * 9; offset++)
			if (!Number.isFinite(firstFloat(rotations, offset)))
				fail("ARDY_ARCHIVE_INVARIANT", "local_rot_mats.npy contains a non-finite replay value");
		const x = firstFloat(joints, 0);
		const y = firstFloat(joints, 1);
		const z = firstFloat(joints, 2);
		if (!(y > Math.abs(x) && y > Math.abs(z)))
			fail("ARDY_ARCHIVE_INVARIANT", "frame-0 cskel27 Hips must be +Y dominant");
	}
}

export class MotionArchiveStore {
	readonly motionsDirectory: string;
	readonly validator: MotionArchiveValidator;

	constructor(projectDirectory: string, validator: MotionArchiveValidator = new NpzMotionArchiveValidator()) {
		this.motionsDirectory = join(resolve(projectDirectory), ".cclay", "motions");
		this.validator = validator;
	}

	private pathFor(motionId: string): string {
		const path = join(this.motionsDirectory, motionFileName(motionId));
		if (!path.startsWith(`${this.motionsDirectory}${sep}`))
			fail("ARDY_ARCHIVE_UNSAFE_PATH", "motion path escapes the archive directory");
		return path;
	}

	async read(motionId: string): Promise<Uint8Array> {
		const path = this.pathFor(motionId);
		try {
			const directory = await lstat(this.motionsDirectory);
			if (!directory.isDirectory() || directory.isSymbolicLink())
				fail("ARDY_ARCHIVE_UNSAFE_PATH", "motions directory is not a real directory");
			const stat = await lstat(path);
			if (!stat.isFile() || stat.isSymbolicLink())
				fail("ARDY_ARCHIVE_NOT_FOUND", `motion ${motionId} is not a regular file`);
			if (stat.size > MAX_MOTION_ARCHIVE_BYTES)
				fail("ARDY_ARCHIVE_TOO_LARGE", `motion ${motionId} exceeds ${MAX_MOTION_ARCHIVE_BYTES} bytes`);
			const archive = await readFile(path);
			if (archive.length > MAX_MOTION_ARCHIVE_BYTES)
				fail("ARDY_ARCHIVE_TOO_LARGE", `motion ${motionId} exceeds ${MAX_MOTION_ARCHIVE_BYTES} bytes`);
			try {
				this.validator.validateStructure(archive, motionId);
			} catch (error) {
				if (error instanceof ArdyArchiveError) throw error;
				throw new ArdyArchiveError(
					"ARDY_ARCHIVE_MALFORMED",
					`motion ${motionId} failed structural validation`,
					error,
				);
			}
			return new Uint8Array(archive);
		} catch (error) {
			if (error instanceof ArdyArchiveError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				fail("ARDY_ARCHIVE_NOT_FOUND", `motion ${motionId} was not found`);
			throw new ArdyArchiveError("ARDY_ARCHIVE_IO", `could not read motion ${motionId}`, error);
		}
	}

	async write(motionId: string, archive: Uint8Array): Promise<void> {
		const path = this.pathFor(motionId);
		if (archive.length > MAX_MOTION_ARCHIVE_BYTES)
			fail("ARDY_ARCHIVE_TOO_LARGE", `motion ${motionId} exceeds ${MAX_MOTION_ARCHIVE_BYTES} bytes`);
		try {
			this.validator.validateForWrite(archive, motionId);
		} catch (error) {
			if (error instanceof ArdyArchiveError) throw error;
			throw new ArdyArchiveError("ARDY_ARCHIVE_MALFORMED", `motion ${motionId} failed archive validation`, error);
		}
		let temporary: string | undefined;
		try {
			await mkdir(this.motionsDirectory, { recursive: true });
			const directoryStat = await lstat(this.motionsDirectory);
			if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
				fail("ARDY_ARCHIVE_UNSAFE_PATH", "motions directory is not a real directory");
			const directory = await open(this.motionsDirectory, constants.O_RDONLY);
			try {
				temporary = join(this.motionsDirectory, `.${motionFileName(motionId)}.${process.pid}.${Date.now()}.tmp`);
				const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
				try {
					await file.writeFile(archive);
					await file.sync();
				} finally {
					await file.close();
				}
				await rename(temporary, path);
				temporary = undefined;
				await directory.sync();
			} finally {
				await directory.close();
			}
		} catch (error) {
			if (temporary !== undefined) await unlink(temporary).catch(() => undefined);
			if (error instanceof ArdyArchiveError) throw error;
			throw new ArdyArchiveError("ARDY_ARCHIVE_IO", `could not write motion ${motionId}`, error);
		}
	}
	async commitGenerated(motionId: string): Promise<void> {
		const path = this.pathFor(motionId);
		const claim = join(this.motionsDirectory, `.${motionFileName(motionId)}.${randomUUID()}.claim`);
		const directory = await lstat(this.motionsDirectory).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				fail("ARDY_ARCHIVE_NOT_FOUND", `generated motion ${motionId} was not found`);
			throw new ArdyArchiveError("ARDY_ARCHIVE_IO", "could not inspect motions directory", error);
		});
		if (!directory.isDirectory() || directory.isSymbolicLink())
			fail("ARDY_ARCHIVE_UNSAFE_PATH", "motions directory is not a real directory");
		try {
			await rename(path, claim);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				fail("ARDY_ARCHIVE_NOT_FOUND", `generated motion ${motionId} was not found`);
			throw new ArdyArchiveError("ARDY_ARCHIVE_IO", `could not claim generated motion ${motionId}`, error);
		}

		let archive: Uint8Array;
		try {
			const stat = await lstat(claim);
			if (!stat.isFile() || stat.isSymbolicLink())
				fail("ARDY_ARCHIVE_UNSAFE_PATH", `claimed motion ${motionId} is not a regular file`);
			if (stat.size > MAX_MOTION_ARCHIVE_BYTES)
				fail("ARDY_ARCHIVE_TOO_LARGE", `claimed motion ${motionId} exceeds ${MAX_MOTION_ARCHIVE_BYTES} bytes`);
			archive = await readFile(claim);
			if (archive.length > MAX_MOTION_ARCHIVE_BYTES)
				fail("ARDY_ARCHIVE_TOO_LARGE", `claimed motion ${motionId} exceeds ${MAX_MOTION_ARCHIVE_BYTES} bytes`);
			try {
				this.validator.validateForWrite(archive, motionId);
			} catch (error) {
				if (error instanceof ArdyArchiveError) throw error;
				throw new ArdyArchiveError(
					"ARDY_ARCHIVE_MALFORMED",
					`generated motion ${motionId} failed archive validation`,
					error,
				);
			}
		} catch (error) {
			if (
				error instanceof ArdyArchiveError &&
				(error.code === "ARDY_ARCHIVE_MALFORMED" || error.code === "ARDY_ARCHIVE_INVARIANT")
			) {
				try {
					await unlink(claim);
				} catch (cleanupError) {
					throw new ArdyArchiveError(
						"ARDY_ARCHIVE_IO",
						`could not remove invalid generated motion ${motionId}`,
						cleanupError,
					);
				}
			}
			if (error instanceof ArdyArchiveError) throw error;
			throw new ArdyArchiveError("ARDY_ARCHIVE_IO", `could not read generated motion ${motionId}`, error);
		}

		try {
			await this.write(motionId, archive);
			await unlink(claim);
		} catch (error) {
			if (error instanceof ArdyArchiveError) throw error;
			throw new ArdyArchiveError(
				"ARDY_ARCHIVE_IO",
				`could not publish generated motion ${motionId}; claim retained for retry`,
				error,
			);
		}
	}
}

export class ArdyArchiveService {
	readonly store: MotionArchiveStore;

	constructor(store: MotionArchiveStore) {
		this.store = store;
	}

	read(motionId: string): Promise<Uint8Array> {
		return this.store.read(motionId);
	}

	write(motionId: string, archive: Uint8Array): Promise<void> {
		return this.store.write(motionId, archive);
	}
	commitGenerated(motionId: string): Promise<void> {
		return this.store.commitGenerated(motionId);
	}
}
