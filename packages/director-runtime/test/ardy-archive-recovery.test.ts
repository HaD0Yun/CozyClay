// The recoverGenerated contract. commitGenerated mints `.motion.npz.<uuid>.claim`
// names and deliberately retains them when a commit is interrupted, so a
// crash can leave one or more claims with no canonical archive. Recovery must
// pick a deterministic winner (newest mtime, UUID ties descending), restore it
// to the canonical path only when no archive exists, and NEVER unlink
// anything: a claim is only removable once the canonical bytes are
// known-valid, which is exactly what a successful commitGenerated
// establishes -- so removeStaleGeneratedClaims is the only sweep, and it runs
// only after the commit. A corrupt or truncated canonical file must therefore
// never destroy a valid claim. Claims belonging to a different motion are
// never touched.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ArdyArchiveError, ArdyArchiveService, MotionArchiveStore } from "../src/ardy-archive-service.ts";

function claimName(motionId: string, uuid: string): string {
	return `.${motionId}.npz.${uuid}.claim`;
}

function canonicalName(motionId: string): string {
	return `${motionId}.npz`;
}

describe("ardy archive recovery", () => {
	let root: string;
	let service: ArdyArchiveService;
	let motions: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "ardy-recover-"));
		service = new ArdyArchiveService(new MotionArchiveStore(root));
		motions = join(root, ".cclay", "motions");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function plantClaim(
		motionId: string,
		uuid: string,
		bytes: Uint8Array | string,
		mtimeMs?: number,
	): Promise<string> {
		await mkdir(motions, { recursive: true });
		const path = join(motions, claimName(motionId, uuid));
		await writeFile(path, bytes);
		if (mtimeMs !== undefined) {
			await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
		}
		return path;
	}

	async function plantCanonical(motionId: string, bytes: Uint8Array | string): Promise<string> {
		await mkdir(motions, { recursive: true });
		const path = join(motions, canonicalName(motionId));
		await writeFile(path, bytes);
		return path;
	}

	async function motionEntries(): Promise<string[]> {
		return (await readdir(motions).catch(() => [] as string[])).sort();
	}

	test("reports none when no claim and no archive exist, including before the motions directory exists", async () => {
		assert.deepEqual(await service.recoverGenerated("walk-01"), { outcome: "none", claimsRemoved: 0 });
		await mkdir(motions, { recursive: true });
		assert.deepEqual(await service.recoverGenerated("walk-01"), { outcome: "none", claimsRemoved: 0 });
	});

	test("restores the only claim to the canonical path when the archive is absent", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		await plantClaim("walk-01", "00000000-0000-4000-8000-000000000000", bytes);

		assert.deepEqual(await service.recoverGenerated("walk-01"), { outcome: "restored", claimsRemoved: 0 });
		assert.deepEqual(await motionEntries(), [canonicalName("walk-01")]);
		assert.deepEqual(new Uint8Array(await readFile(join(motions, canonicalName("walk-01")))), bytes);
	});

	test("reports already-present without unlinking anything when the archive exists", async () => {
		await plantCanonical("walk-01", "canonical-bytes");
		await plantClaim("walk-01", "00000000-0000-4000-8000-000000000000", "claim-a");
		await plantClaim("walk-01", "11111111-1111-4111-8111-111111111111", "claim-b");

		// Existence is NOT validity: recoverGenerated does not read the
		// canonical bytes, so it must never delete claims on the strength of
		// the file merely being present.
		assert.deepEqual(await service.recoverGenerated("walk-01"), { outcome: "already-present", claimsRemoved: 0 });
		assert.deepEqual(
			await motionEntries(),
			[
				canonicalName("walk-01"),
				claimName("walk-01", "00000000-0000-4000-8000-000000000000"),
				claimName("walk-01", "11111111-1111-4111-8111-111111111111"),
			].sort(),
		);
		assert.equal(await readFile(join(motions, canonicalName("walk-01")), "utf8"), "canonical-bytes");
	});

	test("a corrupt or truncated canonical file never destroys a valid claim", async () => {
		// The delete-on-existence hole, closed: recovery sees the canonical
		// file present, reports already-present, and leaves the claim alone.
		// The claim is the only surviving copy of valid bytes; only a
		// successful commit (which validates and republishes the canonical
		// archive) may sweep it.
		const valid = new Uint8Array([1, 2, 3, 4, 5]);
		await plantCanonical("walk-01", "truncated-garbage");
		await plantClaim("walk-01", "00000000-0000-4000-8000-000000000000", valid);

		assert.deepEqual(await service.recoverGenerated("walk-01"), { outcome: "already-present", claimsRemoved: 0 });
		assert.deepEqual(
			await motionEntries(),
			[canonicalName("walk-01"), claimName("walk-01", "00000000-0000-4000-8000-000000000000")].sort(),
		);
		assert.equal(await readFile(join(motions, canonicalName("walk-01")), "utf8"), "truncated-garbage");
		assert.deepEqual(
			new Uint8Array(await readFile(join(motions, claimName("walk-01", "00000000-0000-4000-8000-000000000000")))),
			valid,
			"the valid claim must survive a corrupt canonical file",
		);
	});

	test("removeStaleGeneratedClaims unlinks only the motion's own claims", async () => {
		await plantCanonical("walk-01", "canonical-bytes");
		await plantClaim("walk-01", "00000000-0000-4000-8000-000000000000", "claim-a");
		await plantClaim("walk-01", "11111111-1111-4111-8111-111111111111", "claim-b");
		await plantClaim("other-motion", "22222222-2222-4222-8222-222222222222", "other-claim");

		// The caller contract: this runs only after a successful
		// commitGenerated made the canonical bytes known-valid.
		await service.removeStaleGeneratedClaims("walk-01");

		assert.deepEqual(
			await motionEntries(),
			[canonicalName("walk-01"), claimName("other-motion", "22222222-2222-4222-8222-222222222222")].sort(),
			"claims of other motions must never be touched",
		);
		await service.removeStaleGeneratedClaims("other-motion");
		assert.deepEqual(await motionEntries(), [canonicalName("walk-01")]);
	});

	test("restores the newest claim when mtimes differ, keeping losers until a successful commit sweeps them", async () => {
		const older = new Uint8Array([9, 9, 9]);
		const newer = new Uint8Array([8, 8, 8, 8]);
		await plantClaim("walk-01", "00000000-0000-4000-8000-000000000000", older, 1_700_000_000_000);
		await plantClaim("walk-01", "11111111-1111-4111-8111-111111111111", newer, 1_700_000_000_001);

		assert.deepEqual(await service.recoverGenerated("walk-01"), { outcome: "restored", claimsRemoved: 0 });
		assert.deepEqual(new Uint8Array(await readFile(join(motions, canonicalName("walk-01")))), newer);
		// The loser survives the restore: until the commit succeeds it may be
		// the only surviving copy of the bytes. Recovery with the canonical
		// present still must not unlink it (existence is not validity) --
		// only the post-commit sweep may.
		assert.deepEqual(
			await motionEntries(),
			[canonicalName("walk-01"), claimName("walk-01", "00000000-0000-4000-8000-000000000000")].sort(),
		);
		assert.deepEqual(await service.recoverGenerated("walk-01"), { outcome: "already-present", claimsRemoved: 0 });
		assert.deepEqual(
			await motionEntries(),
			[canonicalName("walk-01"), claimName("walk-01", "00000000-0000-4000-8000-000000000000")].sort(),
		);
		await service.removeStaleGeneratedClaims("walk-01");
		assert.deepEqual(await motionEntries(), [canonicalName("walk-01")]);
	});

	test("breaks mtime ties on the UUID segment descending, deterministically", async () => {
		const low = new Uint8Array([1, 1, 1]);
		const high = new Uint8Array([2, 2, 2]);
		const tied = 1_700_000_000_000;
		// Both hosts that replay the same request must pick the same file, so
		// the whole selection is re-run from a fresh identical state.
		for (let pass = 0; pass < 2; pass++) {
			await rm(join(motions, canonicalName("walk-01")), { force: true });
			await plantClaim("walk-01", "11111111-1111-4111-8111-111111111111", low, tied);
			await plantClaim("walk-01", "ffffffff-ffff-4fff-8fff-ffffffffffff", high, tied);

			assert.deepEqual(await service.recoverGenerated("walk-01"), { outcome: "restored", claimsRemoved: 0 });
			assert.deepEqual(new Uint8Array(await readFile(join(motions, canonicalName("walk-01")))), high);
			// The loser survives the restore; only the post-commit sweep may
			// remove it.
			assert.deepEqual(
				await motionEntries(),
				[canonicalName("walk-01"), claimName("walk-01", "11111111-1111-4111-8111-111111111111")].sort(),
			);
		}
	});

	test("never touches a claim for a different motion id", async () => {
		await plantClaim("other-motion", "00000000-0000-4000-8000-000000000000", "other-bytes");
		assert.deepEqual(await service.recoverGenerated("walk-01"), { outcome: "none", claimsRemoved: 0 });
		await plantCanonical("walk-01", "walk-bytes");
		assert.deepEqual(await service.recoverGenerated("walk-01"), { outcome: "already-present", claimsRemoved: 0 });
		assert.deepEqual(
			await motionEntries(),
			[canonicalName("walk-01"), claimName("other-motion", "00000000-0000-4000-8000-000000000000")].sort(),
		);
	});

	test("ignores non-claim lookalikes such as the write temp shape", async () => {
		await mkdir(motions, { recursive: true });
		await writeFile(join(motions, ".walk-01.npz.4242.1730000000000.tmp"), "temp-bytes");
		await writeFile(join(motions, ".walk-01.npz.not-a-claim"), "other-bytes");
		assert.deepEqual(await service.recoverGenerated("walk-01"), { outcome: "none", claimsRemoved: 0 });
		await service.removeStaleGeneratedClaims("walk-01");
		assert.deepEqual(await motionEntries(), [".walk-01.npz.4242.1730000000000.tmp", ".walk-01.npz.not-a-claim"]);
	});

	test("fences traversal motion ids like every other store method", async () => {
		await assert.rejects(
			service.recoverGenerated("../outside"),
			(error: unknown) => error instanceof ArdyArchiveError && error.code === "ARDY_ARCHIVE_INVALID_ID",
		);
	});
});
