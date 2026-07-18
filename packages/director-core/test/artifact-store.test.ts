import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ArtifactStore, type ArtifactStoreError, type ArtifactStoreLimits } from "../src/artifact-store.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function root() {
	const value = await mkdtemp(join(tmpdir(), "omb-artifacts-"));
	roots.push(value);
	return value;
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

test("Architecture §6: SHA-256-keyed storage returns only omb-artifact://sha256/<digest>", async () => {
	const store = await ArtifactStore.open(await root(), { limits });
	const bytes = Buffer.from("artifact");
	const result = await publish(store, bytes);
	assert.equal(result.uri, `omb-artifact://sha256/${digest(bytes)}`);
	assert.deepEqual(await store.read(result.uri), bytes);
});

test("Architecture §6: reservation limits enforce per-artifact/project/concurrency/active bytes", async () => {
	const store = await ArtifactStore.open(await root(), { limits });
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
	const activeStore = await ArtifactStore.open(await root(), {
		limits: { ...limits, maxConcurrentUploads: 3, maxActiveReservationBytes: 9 },
	});
	const activeFirst = await activeStore.reserve({ expectedSha256: "e".repeat(64), byteLength: 5 });
	await assert.rejects(
		activeStore.reserve({ expectedSha256: "f".repeat(64), byteLength: 5 }),
		(error: unknown) => (error as ArtifactStoreError).code === "ACTIVE_RESERVATION_QUOTA_EXCEEDED",
	);
	await activeFirst.abort();
});

test("Architecture §6: no-follow anchoring rejects symlink, hardlink, wrong-owner, wrong-type, and unsafe-mode targets", async () => {
	const project = await root();
	await mkdir(join(project, ".omb"));
	await symlink(await root(), join(project, ".omb", "artifacts"));
	await assert.rejects(
		ArtifactStore.open(project, { limits }),
		(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_PATH_UNSAFE",
	);

	const project2 = await root();
	const store = await ArtifactStore.open(project2, { limits });
	const bytes = Buffer.from("artifact");
	const hash = digest(bytes);
	const digestDir = join(project2, ".omb", "artifacts", hash);
	await mkdir(digestDir);
	const external = join(project2, "external");
	await writeFile(external, bytes);
	await link(external, join(digestDir, "payload"));
	await assert.rejects(
		store.read(`omb-artifact://sha256/${hash}`),
		(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_PATH_UNSAFE",
	);
	await rm(join(digestDir, "payload"));
	await mkdir(join(digestDir, "payload"));
	await assert.rejects(
		store.read(`omb-artifact://sha256/${hash}`),
		(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_PATH_UNSAFE",
	);
	await rm(join(digestDir, "payload"), { recursive: true });
	await writeFile(join(digestDir, "payload"), bytes);
	await chmod(join(digestDir, "payload"), 0o644);
	await assert.rejects(
		store.read(`omb-artifact://sha256/${hash}`),
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
	const store = await ArtifactStore.open(project, { limits });
	const bytes = Buffer.from("artifact");
	const first = await publish(store, bytes);
	const second = await publish(store, bytes);
	assert.deepEqual(second, first);
	await writeFile(join(project, ".omb", "artifacts", first.sha256, "payload"), Buffer.from("corrupt"), {
		mode: 0o600,
	});
	await assert.rejects(
		publish(store, bytes),
		(error: unknown) => (error as ArtifactStoreError).code === "ARTIFACT_COLLISION",
	);
});

test("Architecture §6: startup recovery removes only safely anchored crash temporary files", async () => {
	const project = await root();
	const store = await ArtifactStore.open(project, { limits });
	const temporary = join(project, ".omb", "artifacts", ".tmp", "upload-00000000000000000000000000000000");
	await writeFile(temporary, "partial", { mode: 0o600 });
	await store.recoverTemps();
	await assert.rejects(readFile(temporary), { code: "ENOENT" });

	const crashBytes = Buffer.from("linked-crash");
	const crashDigest = digest(crashBytes);
	const digestDir = join(project, ".omb", "artifacts", crashDigest);
	await mkdir(digestDir);
	const linkedTemporary = join(project, ".omb", "artifacts", ".tmp", "upload-11111111111111111111111111111111");
	await writeFile(linkedTemporary, crashBytes, { mode: 0o600 });
	await link(linkedTemporary, join(digestDir, "payload"));
	await store.recoverTemps();
	assert.deepEqual(await store.read(`omb-artifact://sha256/${crashDigest}`), crashBytes);
});
