// Synthetic full-body pose archive lifecycle, shared by the regeneration and
// in-between queues.
//
// Both queues' requests bring `cclay-pose-*` archives with them: the add-on
// writes one single-frame pose archive per constrained frame, the host owns
// deleting them (the add-on has already detached and stopped caring by the
// time the generator runs), and a host that dies between the add-on writing
// the poses and the sweep consuming the request leaves them with no owner.
//
// The two queues share the motions directory and the `cclay-pose-` prefix
// (constraint_capture.capture_regeneration_request mints
// `cclay-pose-<request_id[:16]>-f<frame>`; capture_evaluated_pose mints
// `cclay-pose-<request_id>-<index + 1>`), so an orphan sweep can NEVER know
// only its own queue: a sweep that treats just the regenerate requests as
// owners would delete an in-between request's in-flight poses and vice
// versa. Both queues therefore delegate to the sweep below with the FULL
// owner set -- every request directory whose pending or claimed requests may
// reference synthetic archives, with the derivation that names them.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CLAIMED_SUFFIX, readClaimedRequest } from "./ardy-queue.ts";

// The prefix must match the ids constraint_capture.py mints for both
// surfaces (capture_regeneration_request and capture_evaluated_pose).
export const SYNTHETIC_POSE_PREFIX = "cclay-pose-";

export interface SyntheticPoseOwnerQueue {
	readonly requestDirectory: string;
	// Derives the synthetic pose ids a request names, so a sweep can
	// attribute each archive to the requests that own it. A request that
	// cannot be read or parsed ABORTS the whole sweep (see
	// removeOrphanedSyntheticPoses): an unreadable request may still
	// reference archives that are in flight, and deleting a live input is
	// unrecoverable while leaving garbage behind is not.
	readonly syntheticPoseIds: (request: unknown) => readonly string[];
}

/**
 * Delete every `cclay-pose-*.npz` no pending or claimed request in ANY of
 * the owner queues still references.
 *
 * Run at startup, after recoverAbandoned*Claims, so requests waiting to be
 * retried keep their poses.
 *
 * Fails CLOSED: if ANY owner request cannot be read or parsed, the sweep
 * rejects and NOTHING is deleted. An unreadable request may still own
 * archives that are in flight, and deleting a live input is unrecoverable
 * while leaving garbage behind is not.
 */
export async function removeOrphanedSyntheticPoses(
	projectDirectory: string,
	owners: readonly SyntheticPoseOwnerQueue[],
): Promise<string[]> {
	const motions = join(projectDirectory, ".cclay", "motions");
	let motionNames: string[];
	try {
		motionNames = await readdir(motions);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const referenced = new Set<string>();
	for (const owner of owners) {
		let requestNames: string[] = [];
		try {
			requestNames = await readdir(join(projectDirectory, ".cclay", owner.requestDirectory));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
		for (const name of requestNames) {
			if (!name.endsWith(".json") && !name.endsWith(CLAIMED_SUFFIX)) {
				continue;
			}
			let request: unknown;
			try {
				request = await readClaimedRequest(join(projectDirectory, ".cclay", owner.requestDirectory, name));
			} catch (error) {
				// Fail CLOSED: an unreadable owner request may still reference
				// synthetic poses that are in flight. Treating it as owning
				// nothing would let the sweep delete those poses out from
				// under the pending request -- a live input is unrecoverable,
				// while leaving garbage behind is not -- so the whole sweep
				// aborts and nothing is deleted.
				throw new Error(
					`cannot read owner request ${name} in .cclay/${owner.requestDirectory}: ` +
						`${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
			let requestIds: readonly string[];
			try {
				requestIds = owner.syntheticPoseIds(request);
			} catch (error) {
				// Same fail-closed contract as the read failure above: an
				// unparseable owner request aborts the sweep rather than
				// claiming nothing.
				throw new Error(
					`cannot parse owner request ${name} in .cclay/${owner.requestDirectory}: ` +
						`${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
			for (const poseId of requestIds) {
				referenced.add(`${poseId}.npz`);
			}
		}
	}
	const removed: string[] = [];
	for (const name of motionNames.sort()) {
		if (!name.startsWith(SYNTHETIC_POSE_PREFIX) || !name.endsWith(".npz")) {
			continue;
		}
		if (referenced.has(name)) {
			continue;
		}
		await rm(join(motions, name), { force: true });
		removed.push(name);
	}
	return removed;
}
