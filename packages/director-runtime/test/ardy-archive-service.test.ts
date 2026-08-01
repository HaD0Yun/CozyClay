import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArdyArchiveError, ArdyArchiveService, MotionArchiveStore } from "../src/ardy-archive-service.ts";

function u16(value: number): number[] {
	return [value & 255, value >>> 8];
}
function u32(value: number): number[] {
	return [value & 255, value >>> 8, value >>> 16, value >>> 24];
}

function npy(descr: string, shape: string, payload: Uint8Array): Uint8Array {
	const header = new TextEncoder().encode(`{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape}), }`);
	const padding = (16 - ((10 + header.length + 1) % 16)) % 16;
	const text = new Uint8Array([...header, ...new Array(padding).fill(32), 10]);
	return new Uint8Array([0x93, 78, 85, 77, 80, 89, 1, 0, ...u16(text.length), ...text, ...payload]);
}

function zip(members: readonly [string, Uint8Array][]): Uint8Array {
	const chunks: number[] = [];
	const central: number[] = [];
	for (const [name, payload] of members) {
		const nameBytes = new TextEncoder().encode(name);
		const offset = chunks.length;
		chunks.push(
			...u32(0x04034b50),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(payload.length),
			...u32(payload.length),
			...u16(nameBytes.length),
			...u16(0),
			...nameBytes,
			...payload,
		);
		central.push(
			...u32(0x02014b50),
			...u16(20),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(payload.length),
			...u32(payload.length),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(offset),
			...nameBytes,
		);
	}
	const centralOffset = chunks.length;
	chunks.push(
		...central,
		...u32(0x06054b50),
		...u16(0),
		...u16(0),
		...u16(members.length),
		...u16(members.length),
		...u32(central.length),
		...u32(centralOffset),
		...u16(0),
	);
	return new Uint8Array(chunks);
}

function archive(options: { y?: number; fps?: number; malformed?: boolean } = {}): Uint8Array {
	if (options.malformed) return zip([["fps.npy", npy("<i4", "", new Uint8Array(4))]]);
	const rotations = new Float32Array(27 * 9);
	for (let joint = 0; joint < 27; joint++)
		for (let axis = 0; axis < 3; axis++) rotations[joint * 9 + axis * 3 + axis] = 1;
	const joints = new Float32Array(27 * 3);
	joints[1] = options.y ?? 1;
	return zip([
		["local_rot_mats.npy", npy("<f4", "1, 27, 3, 3", new Uint8Array(rotations.buffer))],
		["posed_joints.npy", npy("<f4", "1, 27, 3", new Uint8Array(joints.buffer))],
		["fps.npy", npy("<i4", "", new Uint8Array(new Int32Array([options.fps ?? 20]).buffer))],
	]);
}

async function createService(): Promise<{ root: string; service: ArdyArchiveService }> {
	const root = await mkdtemp(join(tmpdir(), "ardy-archive-"));
	return { root, service: new ArdyArchiveService(new MotionArchiveStore(root)) };
}

test("writes durably and reads a structurally valid motion archive", async () => {
	const { service } = await createService();
	const data = archive();
	await service.write("walk-01", data);
	assert.deepEqual(await service.read("walk-01"), data);
});

test("fences traversal motion ids", async () => {
	const { service } = await createService();
	await assert.rejects(
		service.read("../outside"),
		(error: unknown) => error instanceof ArdyArchiveError && error.code === "ARDY_ARCHIVE_INVALID_ID",
	);
});
test("matches Python's lowercase hyphenated motion-id grammar", async () => {
	const { service } = await createService();
	for (const motionId of ["Walk-01", "walk_01", "-walk", "a".repeat(65)]) {
		await assert.rejects(
			service.read(motionId),
			(error: unknown) => error instanceof ArdyArchiveError && error.code === "ARDY_ARCHIVE_INVALID_ID",
		);
	}
});

test("refuses symlink, oversized, and malformed reads", async () => {
	const { root, service } = await createService();
	const directory = join(root, ".cclay", "motions");
	await mkdir(directory, { recursive: true });
	await writeFile(join(root, "outside.npz"), archive());
	await symlink(join(root, "outside.npz"), join(directory, "linked.npz"));
	await assert.rejects(
		service.read("linked"),
		(error: unknown) => error instanceof ArdyArchiveError && error.code === "ARDY_ARCHIVE_NOT_FOUND",
	);
	await writeFile(join(directory, "huge.npz"), new Uint8Array(64 * 1024 * 1024 + 1));
	await assert.rejects(
		service.read("huge"),
		(error: unknown) => error instanceof ArdyArchiveError && error.code === "ARDY_ARCHIVE_TOO_LARGE",
	);
	await writeFile(join(directory, "broken.npz"), archive({ malformed: true }));
	await assert.rejects(
		service.read("broken"),
		(error: unknown) => error instanceof ArdyArchiveError && error.code === "ARDY_ARCHIVE_MALFORMED",
	);
});

test("rejects replay invariant violations and leaves no temporary write behind", async () => {
	const { root, service } = await createService();
	await assert.rejects(
		service.write("down", archive({ y: 0 })),
		(error: unknown) => error instanceof ArdyArchiveError && error.code === "ARDY_ARCHIVE_INVARIANT",
	);
	const directory = join(root, ".cclay", "motions");
	assert.deepEqual(await readdir(directory).catch(() => []), []);
	await assert.rejects(
		service.write("bad-fps", archive({ fps: 241 })),
		(error: unknown) => error instanceof ArdyArchiveError && error.code === "ARDY_ARCHIVE_INVARIANT",
	);
});
test("cleans the temporary file when rename cannot replace the destination", async () => {
	const { root, service } = await createService();
	const directory = join(root, ".cclay", "motions");
	await mkdir(join(directory, "blocked.npz"), { recursive: true });
	await assert.rejects(
		service.write("blocked", archive()),
		(error: unknown) => error instanceof ArdyArchiveError && error.code === "ARDY_ARCHIVE_IO",
	);
	assert.deepEqual(await readdir(directory), ["blocked.npz"]);
});
test("claims, validates, and durably republishes wrapper-generated output", async () => {
	const { root, service } = await createService();
	const directory = join(root, ".cclay", "motions");
	await mkdir(directory, { recursive: true });
	const generated = archive();
	await writeFile(join(directory, "generated-01.npz"), generated);
	await service.commitGenerated("generated-01");
	assert.deepEqual(await service.read("generated-01"), generated);
	assert.deepEqual(await readdir(directory), ["generated-01.npz"]);
});

test("removes malformed or invariant-violating claimed wrapper output", async () => {
	const { root, service } = await createService();
	const directory = join(root, ".cclay", "motions");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "broken.npz"), archive({ malformed: true }));
	await assert.rejects(
		service.commitGenerated("broken"),
		(error: unknown) => error instanceof ArdyArchiveError && error.code === "ARDY_ARCHIVE_MALFORMED",
	);
	assert.deepEqual(await readdir(directory), []);
	await writeFile(join(directory, "down.npz"), archive({ y: 0 }));
	await assert.rejects(
		service.commitGenerated("down"),
		(error: unknown) => error instanceof ArdyArchiveError && error.code === "ARDY_ARCHIVE_INVARIANT",
	);
	assert.deepEqual(await readdir(directory), []);
});
