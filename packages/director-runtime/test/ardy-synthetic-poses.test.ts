// The shared synthetic-pose orphan sweep fails CLOSED: if ANY owner request
// cannot be read or parsed, the sweep rejects and NOTHING is deleted. An
// unreadable request may still own archives that are in flight, and deleting
// a live input is unrecoverable while leaving garbage behind is not.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { removeOrphanedSyntheticPoses } from "../src/ardy-regenerate-queue.ts";

describe("ardy synthetic poses orphan sweep", () => {
	let project: string;

	beforeEach(async () => {
		project = await mkdtemp(join(tmpdir(), "cclay-poses-"));
	});

	afterEach(async () => {
		await rm(project, { recursive: true, force: true });
	});

	async function plantPose(id: string): Promise<void> {
		const motions = join(project, ".cclay", "motions");
		await mkdir(motions, { recursive: true });
		await writeFile(join(motions, `${id}.npz`), "not really an npz", "utf8");
	}

	async function plantOwnerRequest(requestDirectory: string, fileName: string, body: string): Promise<void> {
		const directory = join(project, ".cclay", requestDirectory);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, fileName), body, "utf8");
	}

	it("an unreadable owner request aborts the sweep; the poses it references survive", async () => {
		const poseId = "cclay-pose-unreadable-f1";
		await plantPose(poseId);
		// A claim whose body is not parseable JSON: readClaimedRequest throws
		// on the read. The request may still reference in-flight poses, so
		// the sweep must abort instead of treating it as owning nothing.
		await plantOwnerRequest("regenerate-requests", "deadbeefdeadbeefdeadbeefdeadbeef.json.claimed", "{not json");

		await assert.rejects(removeOrphanedSyntheticPoses(project), /cannot read owner request/);

		assert.deepEqual(
			await readdir(join(project, ".cclay", "motions")),
			[`${poseId}.npz`],
			"nothing may be deleted when an owner request cannot be read",
		);
	});

	it("an unparseable owner request aborts the sweep; the poses it references survive", async () => {
		const poseId = "cclay-pose-unparseable-f2";
		await plantPose(poseId);
		// Valid JSON that no owner queue can parse: the owner's
		// syntheticPoseIds derivation throws. Same fail-closed contract as
		// the unreadable case.
		await plantOwnerRequest(
			"inbetween-requests",
			"0123456789abcdef0123456789abcdef.json.claimed",
			'{"schema_version": 1}',
		);

		await assert.rejects(removeOrphanedSyntheticPoses(project), /cannot parse owner request/);

		assert.deepEqual(
			await readdir(join(project, ".cclay", "motions")),
			[`${poseId}.npz`],
			"nothing may be deleted when an owner request cannot be parsed",
		);
	});
});
