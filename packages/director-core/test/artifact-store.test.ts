import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ArtifactStore, type ArtifactStoreError, type ArtifactStoreLimits } from "../src/artifact-store.ts";

const roots: string[] = [];
const stores: ArtifactStore[] = [];
afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function root() {
	const value = await mkdtemp(join(tmpdir(), "cclay-artifacts-"));
	roots.push(value);
	return value;
}
async function openStore(project: string, options: { limits: ArtifactStoreLimits }) {
	const store = await ArtifactStore.open(project, options);
	stores.push(store);
	return store;
}
const limits: ArtifactStoreLimits = {
	maxArtifactBytes: 8,
	maxProjectBytes: 12,
	maxConcurrentUploads: 2,
	maxActiveReservationBytes: 10,
};

async function publish(store: ArtifactStore, bytes: Uint8Array) {
	return store.publish({ expectedSha256: digest(bytes), byteLength: bytes.byteLength }, [bytes]);
}

test("Architecture §6: SHA-256-keyed storage returns only cclay-artifact://sha256/<digest>", async () => {
	const store = await openStore(await root(), { limits });
	const bytes = Buffer.from("artifact");
	const result = await publish(store, bytes);
	assert.equal(result.uri, `cclay-artifact://sha256/${digest(bytes)}`);
	assert.deepEqual(await store.read(result.uri), bytes);
});

test("Architecture §6: reservation limits enforce per-artifact/project/concurrency/active bytes", async () => {
	const store = await openStore(await root(), { limits });
	await assert.rejects(
		store.reserve({ expectedSha256: "a".repeat(64), byteLength: 9 }),
		(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_TOO_LARGE",
	);
	const first = await store.reserve({ expectedSha256: "a".repeat(64), byteLength: 5 });
	const second = await store.reserve({ expectedSha256: "b".repeat(64), byteLength: 5 });
	await assert.rejects(
		store.reserve({ expectedSha256: "c".repeat(64), byteLength: 1 }),
		(error: unknown) => (error as ArtifactStoreError).code === "TOO_MANY_UPLOADS",
	);
	await first.abort();
	await second.abort();
	await publish(store, Buffer.from("12345678"));
	await assert.rejects(
		store.reserve({ expectedSha256: "d".repeat(64), byteLength: 5 }),
		(error: unknown) => (error as ArtifactStoreError).code === "PROJECT_QUOTA_EXCEEDED",
	);
	const activeStore = await openStore(await root(), {
		limits: { ...limits, maxConcurrentUploads: 3, maxActiveReservationBytes: 9 },
	});
	const activeFirst = await activeStore.reserve({ expectedSha256: "e".repeat(64), byteLength: 5 });
	await assert.rejects(
		activeStore.reserve({ expectedSha256: "f".repeat(64), byteLength: 5 }),
		(error: unknown) => (error as ArtifactStoreError).code === "ACTIVE_RESERVATION_QUOTA_EXCEEDED",
	);
	await activeFirst.abort();
});

test("Architecture §6: one transactional batch reserves multiple artifacts under one upload slot", async () => {
	const store = await openStore(await root(), {
		limits: { ...limits, maxProjectBytes: 20, maxActiveReservationBytes: 20 },
	});
	const batch = await store.reserveBatch([
		{ expectedSha256: "a".repeat(64), byteLength: 3 },
		{ expectedSha256: "b".repeat(64), byteLength: 3 },
		{ expectedSha256: "c".repeat(64), byteLength: 3 },
	]);
	assert.equal(batch.length, 3);
	const competing = await store.reserve({ expectedSha256: "d".repeat(64), byteLength: 1 });
	await assert.rejects(
		store.reserve({ expectedSha256: "e".repeat(64), byteLength: 1 }),
		(error: unknown) => (error as ArtifactStoreError).code === "TOO_MANY_UPLOADS",
	);
	await competing.abort();
	await Promise.all(batch.map((reservation) => reservation.abort()));
});

test("Architecture §6: no-follow anchoring rejects symlink, hardlink, wrong-owner, wrong-type, and unsafe-mode targets", async () => {
	const project = await root();
	await mkdir(join(project, ".cclay"));
	await symlink(await root(), join(project, ".cclay", "artifacts"));
	await assert.rejects(
		ArtifactStore.open(project, { limits }),
		(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_PATH_UNSAFE",
	);

	const project2 = await root();
	const store = await openStore(project2, { limits });
	const bytes = Buffer.from("artifact");
	const hash = digest(bytes);
	const digestDir = join(project2, ".cclay", "artifacts", hash);
	await mkdir(digestDir);
	const external = join(project2, "external");
	await writeFile(external, bytes);
	await link(external, join(digestDir, "payload"));
	await assert.rejects(
		store.read(`cclay-artifact://sha256/${hash}`),
		(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_PATH_UNSAFE",
	);
	await rm(join(digestDir, "payload"));
	await mkdir(join(digestDir, "payload"));
	await assert.rejects(
		store.read(`cclay-artifact://sha256/${hash}`),
		(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_PATH_UNSAFE",
	);
	await rm(join(digestDir, "payload"), { recursive: true });
	await writeFile(join(digestDir, "payload"), bytes);
	await chmod(join(digestDir, "payload"), 0o644);
	await assert.rejects(
		store.read(`cclay-artifact://sha256/${hash}`),
		(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_PATH_UNSAFE",
	);

	const getuid = process.getuid;
	if (getuid !== undefined) {
		Object.defineProperty(process, "getuid", { configurable: true, value: () => getuid() + 1 });
		try {
			await assert.rejects(
				ArtifactStore.open(await root(), { limits }),
				(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_PATH_UNSAFE",
			);
		} finally {
			Object.defineProperty(process, "getuid", { configurable: true, value: getuid });
		}
	}
});

test("Architecture §6: no-replace publish is idempotent for identical bytes and rejects mismatches", async () => {
	const project = await root();
	const store = await openStore(project, { limits });
	const bytes = Buffer.from("artifact");
	const first = await publish(store, bytes);
	const second = await publish(store, bytes);
	assert.deepEqual(second, first);
	await writeFile(join(project, ".cclay", "artifacts", first.sha256, "payload"), Buffer.from("corrupt"), {
		mode: 0o600,
	});
	await assert.rejects(
		publish(store, bytes),
		(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_COLLISION",
	);
});

test("Architecture §6: startup recovery removes only safely anchored crash temporary files", async () => {
	const project = await root();
	const store = await openStore(project, { limits });
	const temporary = join(project, ".cclay", "artifacts", ".tmp", "upload-00000000000000000000000000000000");
	await writeFile(temporary, "partial", { mode: 0o600 });
	await store.recoverTemps();
	await assert.rejects(readFile(temporary), { code: "ENOENT" });

	const crashBytes = Buffer.from("linked-crash");
	const crashDigest = digest(crashBytes);
	const digestDir = join(project, ".cclay", "artifacts", crashDigest);
	await mkdir(digestDir);
	const linkedTemporary = join(project, ".cclay", "artifacts", ".tmp", "upload-11111111111111111111111111111111");
	await writeFile(linkedTemporary, crashBytes, { mode: 0o600 });
	await link(linkedTemporary, join(digestDir, "payload"));
	await store.recoverTemps();
	assert.deepEqual(await store.read(`cclay-artifact://sha256/${crashDigest}`), crashBytes);
});

test("Architecture §6: retained directory descriptors reject hierarchy replacement", async () => {
	const project = await root();
	const store = await openStore(project, { limits });
	const artifacts = join(project, ".cclay", "artifacts");
	await rename(artifacts, `${artifacts}-original`);
	await mkdir(artifacts);
	await mkdir(join(artifacts, ".tmp"));

	await assert.rejects(
		store.reserve({ expectedSha256: "a".repeat(64), byteLength: 1 }),
		(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_PATH_UNSAFE",
	);
});

test("Architecture §6: project-scoped accounting coordinates distinct store instances", async () => {
	const project = await root();
	const sharedLimits = { ...limits, maxConcurrentUploads: 1, maxActiveReservationBytes: 5 };
	const firstStore = await openStore(project, { limits: sharedLimits });
	const secondStore = await openStore(project, { limits: sharedLimits });
	const attempts = await Promise.allSettled([
		firstStore.reserve({ expectedSha256: "a".repeat(64), byteLength: 5 }),
		secondStore.reserve({ expectedSha256: "b".repeat(64), byteLength: 5 }),
	]);
	const accepted = attempts.filter(
		(result): result is PromiseFulfilledResult<Awaited<ReturnType<ArtifactStore["reserve"]>>> =>
			result.status === "fulfilled",
	);
	const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	assert.equal(accepted.length, 1);
	assert.equal(rejected.length, 1);
	assert.equal((rejected[0]!.reason as ArtifactStoreError).code, "TOO_MANY_UPLOADS");
	await accepted[0]!.value.abort();
});

test("Architecture §6: opening the store recovers crash-orphaned temporary files", async () => {
	const project = await root();
	await openStore(project, { limits });
	const temporary = join(project, ".cclay", "artifacts", ".tmp", "upload-22222222222222222222222222222222");
	await writeFile(temporary, "partial", { mode: 0o600 });

	await openStore(project, { limits });

	await assert.rejects(readFile(temporary), { code: "ENOENT" });
});

test("Architecture §6: project quota counts every committed regular file", async () => {
	const project = await root();
	const store = await openStore(project, { limits });
	const artifact = await publish(store, Buffer.from("12345678"));
	await writeFile(join(project, ".cclay", "artifacts", artifact.sha256, "metadata"), "1234", { mode: 0o600 });

	await assert.rejects(
		store.reserve({ expectedSha256: "a".repeat(64), byteLength: 1 }),
		(error: unknown) => (error as ArtifactStoreError).code === "PROJECT_QUOTA_EXCEEDED",
	);
});

test("Architecture §6: positional reservation writes stream out-of-order chunks without whole-payload buffering", async () => {
	const project = await root();
	const store = await openStore(project, { limits });
	const bytes = Buffer.from("artifact");
	const reservation = await store.reserve({ expectedSha256: digest(bytes), byteLength: bytes.byteLength });
	await reservation.writeAt(4, bytes.subarray(4));
	await reservation.writeAt(0, bytes.subarray(0, 4));

	const artifact = await reservation.commit();

	assert.deepEqual(await store.read(artifact.uri), bytes);
});
