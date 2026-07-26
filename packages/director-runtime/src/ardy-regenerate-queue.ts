// Host-side consumer for the add-on's regeneration queue.
//
// The add-on cannot call the host: connection.dispatch_bridge_message is a
// host-to-add-on pull, with no push in the other direction. So the add-on
// writes a self-contained request under .cclay/regenerate-requests/ and the
// host picks it up here. Nothing in this file talks to an LLM or makes a
// choice; it reads a file, runs the already-tested regenerate handler, and
// writes the outcome back. That is what keeps "regenerate" deterministic even
// though a director session is what happens to be running the sweep.
//
// Two properties this file is responsible for:
//
//   Exactly-once. A request is claimed by renaming it before it is executed.
//   rename() is atomic on POSIX, so two concurrent sweeps cannot both claim
//   the same request: the loser gets ENOENT and moves on. Without this a slow
//   generation would be started twice by the next tick.
//
//   No silent loss. The add-on has already detached its IK layer by the time
//   the host sees the request, so a failure that produced no file would be
//   indistinguishable from a host that was never running. Every claimed
//   request produces exactly one outcome file, success or failure.

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type ArdyRegenerateErrorCode,
	type ArdyRegenerateQueueOutcomeV1,
	type ArdyRegenerateRequestV1,
	parseArdyRegenerateQueueOutcome,
	parseArdyRegenerateRequest,
} from "@cclay/protocol";

export const REGENERATE_REQUEST_DIRECTORY = "regenerate-requests";
export const REGENERATE_OUTCOME_DIRECTORY = "regenerate-outcomes";
// Synthetic full-body pose archives the add-on writes so --constrain-pose has
// something to point at. They exist only for the duration of one request; the
// host owns deleting them because the add-on has already detached and stopped
// caring by the time the generator runs. The prefix must match the id
// constraint_capture.capture_regeneration_request mints.
const SYNTHETIC_POSE_PREFIX = "cclay-pose-";
// Marks a request this sweep owns. The suffix is not a lock file: the rename
// itself is the lock, and the name only records who won.
const CLAIMED_SUFFIX = ".claimed";

export interface ArdyRegenerateQueuePaths {
	readonly requests: string;
	readonly outcomes: string;
	readonly motions: string;
}

export function regenerateQueuePaths(projectDirectory: string): ArdyRegenerateQueuePaths {
	return {
		requests: join(projectDirectory, ".cclay", REGENERATE_REQUEST_DIRECTORY),
		outcomes: join(projectDirectory, ".cclay", REGENERATE_OUTCOME_DIRECTORY),
		motions: join(projectDirectory, ".cclay", "motions"),
	};
}

// Deletes the synthetic pose archives a request brought with it, whether the
// generation succeeded or failed. Failure is the case that matters: an error
// path that skipped this would leak an archive per attempt, and the add-on
// mints a fresh id every time so nothing would ever overwrite them.
async function removeSyntheticPoses(motions: string, request: ArdyRegenerateRequestV1): Promise<void> {
	for (const pose of request.full_body) {
		await rm(join(motions, `${pose.synthetic_motion_id}.npz`), { force: true });
	}
}

// The handler shape createArdyRegenerateHandler returns. Injected rather than
// constructed here so a sweep can be tested without a generator or a bridge.
export type ArdyRegenerateQueueHandler = (
	params: unknown,
	context: unknown,
) => Promise<{ result: unknown; resulting_revision_id: string }>;

export interface ArdyRegenerateSweepOptions {
	readonly projectDirectory: string;
	readonly handler: ArdyRegenerateQueueHandler;
	// Built per request because the handler's staleness guard compares the
	// context's expected_revision_id against the request's own. The queue does
	// not decide whether a request is stale; it only supplies the context the
	// handler needs to decide.
	readonly contextFor: (request: ArdyRegenerateRequestV1) => unknown;
}

export interface ArdyRegenerateSweepEntry {
	readonly requestId: string;
	readonly outcome: ArdyRegenerateQueueOutcomeV1;
}

// Maps a thrown error onto the closed error-code vocabulary. The handler
// prefixes its throws with the code it means, so this reads the prefix rather
// than pattern-matching message text.
function classify(error: unknown): { code: ArdyRegenerateErrorCode; message: string } {
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith("STALE_BASE")) {
		return { code: "REVISION_MISMATCH", message };
	}
	if (message.startsWith("INVALID_ARDY_REGENERATE_REQUEST")) {
		return { code: "INVALID_ARDY_REGENERATE_REQUEST", message };
	}
	// Everything else that can reach here comes from running or reading the
	// generator: a non-zero exit, unparseable stdout, or a result the closed
	// schema rejected. They are all "the generation did not produce a motion
	// we can commit", which is what GENERATION_FAILED means.
	return { code: "GENERATION_FAILED", message };
}

// Written temp-then-rename with the same 0600 the add-on uses for requests, so
// a reader never observes a half-written outcome and the file is not
// world-readable while it is being produced.
async function writeOutcomeAtomically(directory: string, outcome: ArdyRegenerateQueueOutcomeV1): Promise<string> {
	await mkdir(directory, { recursive: true });
	const staged = join(directory, `.${randomBytes(8).toString("hex")}.partial`);
	const final = join(directory, `${outcome.request_id}.json`);
	const handle = await open(staged, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(outcome, null, 1)}\n`, "utf8");
	} finally {
		await handle.close();
	}
	try {
		await chmod(staged, 0o600);
		await rename(staged, final);
	} catch (error) {
		await rm(staged, { force: true });
		throw error;
	}
	return final;
}

async function readClaimedRequest(path: string): Promise<unknown> {
	const handle = await open(path, "r");
	try {
		return JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}

// A terminal outcome already on disk, or null if this request has not finished
// before. This is the only thing standing between recovery and a second
// generation: the rename claim excludes concurrent sweeps, but it says nothing
// about a request whose handler already committed a revision before the host
// died. Reading the answer back is what makes replay safe.
async function existingOutcome(outcomes: string, requestId: string): Promise<ArdyRegenerateQueueOutcomeV1 | null> {
	try {
		const body = await readClaimedRequest(join(outcomes, `${requestId}.json`));
		return parseArdyRegenerateQueueOutcome(body);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		// A corrupt or half-schema outcome is not a terminal answer. Treating
		// it as one would strand the request forever, so it is replayed.
		return null;
	}
}

// Everything a finished request leaves behind: the synthetic poses it brought
// and the claim itself. Deliberately ordered AFTER the outcome is durable --
// the poses are the replay input, so deleting them first turns a crash in that
// window into a request that can never be run again.
async function retireClaim(
	claimedPath: string,
	paths: ArdyRegenerateQueuePaths,
	request: ArdyRegenerateRequestV1 | null,
): Promise<void> {
	if (request !== null) {
		await removeSyntheticPoses(paths.motions, request);
	}
	await rm(claimedPath, { force: true });
}

// One request, already claimed. Always produces an outcome file; the synthetic
// inputs and the claim are cleared only once that outcome is durable, so every
// crash window leaves the request replayable rather than half-consumed.
async function runClaimed(
	claimedPath: string,
	paths: ArdyRegenerateQueuePaths,
	options: ArdyRegenerateSweepOptions,
): Promise<ArdyRegenerateQueueOutcomeV1> {
	let requestId = "unknown";
	let parsed: ArdyRegenerateRequestV1 | null = null;
	let outcome: ArdyRegenerateQueueOutcomeV1;
	try {
		const raw = await readClaimedRequest(claimedPath);
		const request = parseArdyRegenerateRequest(raw);
		parsed = request;
		requestId = request.request_id;
		// A terminal outcome means this request already ran to completion,
		// possibly committing a revision, before the host died. Re-running it
		// would generate a second motion and commit a second time, so the
		// recorded answer is returned and only the leftovers are cleared.
		const finished = await existingOutcome(paths.outcomes, requestId);
		if (finished !== null) {
			await retireClaim(claimedPath, paths, parsed);
			return finished;
		}
		const applied = await options.handler(request, options.contextFor(request));
		outcome = parseArdyRegenerateQueueOutcome({
			schema_version: 1,
			request_id: request.request_id,
			status: "succeeded",
			result: applied.result,
			resulting_revision_id: applied.resulting_revision_id,
		});
	} catch (error) {
		const { code, message } = classify(error);
		if (requestId === "unknown") {
			// The id could not be read, so the outcome cannot be addressed to
			// the request that produced it. Naming it after the claimed file
			// keeps the failure visible instead of dropping it on the floor.
			const base = claimedPath.split("/").pop() ?? "unknown";
			requestId = base.replace(/\.json\.claimed$/, "");
		}
		outcome = parseArdyRegenerateQueueOutcome({
			schema_version: 1,
			request_id: requestId,
			status: "failed",
			error_code: code,
			message: message.slice(0, 4096),
		});
	}
	// Outcome first, then the inputs it consumed: the synthetic poses are what
	// a replay would need, so a crash between the two must leave them intact.
	await writeOutcomeAtomically(paths.outcomes, outcome);
	await retireClaim(claimedPath, paths, parsed);
	return outcome;
}

/**
 * Run every pending request once, oldest name first, and return the outcomes.
 *
 * Sequential on purpose. Each request regenerates a motion and commits a
 * revision, and the handler's staleness guard is written against the revision
 * the request was built on; running two at once would make the second one's
 * guard depend on whether the first happened to finish first.
 */
export async function sweepRegenerateRequests(
	options: ArdyRegenerateSweepOptions,
): Promise<ArdyRegenerateSweepEntry[]> {
	const paths = regenerateQueuePaths(options.projectDirectory);
	let names: string[];
	try {
		names = await readdir(paths.requests);
	} catch (error) {
		// No queue directory means the add-on has never published a request.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const entries: ArdyRegenerateSweepEntry[] = [];
	for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
		const requestPath = join(paths.requests, name);
		const claimedPath = `${requestPath}${CLAIMED_SUFFIX}`;
		try {
			await rename(requestPath, claimedPath);
		} catch (error) {
			// ENOENT means another sweep claimed it between readdir and now.
			// That is the exclusion working, not a failure.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				continue;
			}
			throw error;
		}
		const outcome = await runClaimed(claimedPath, paths, options);
		entries.push({ requestId: outcome.request_id, outcome });
	}
	return entries;
}

/**
 * Delete synthetic pose archives no queued request still refers to.
 *
 * A host that died between the add-on writing the poses and the sweep
 * consuming the request leaves them with no owner, and nothing else in the
 * project will ever mention them again. Run at startup, after
 * recoverAbandonedClaims, so requests waiting to be retried keep their poses.
 */
export async function removeOrphanedSyntheticPoses(projectDirectory: string): Promise<string[]> {
	const paths = regenerateQueuePaths(projectDirectory);
	let motionNames: string[];
	try {
		motionNames = await readdir(paths.motions);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const referenced = new Set<string>();
	let requestNames: string[] = [];
	try {
		requestNames = await readdir(paths.requests);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
	for (const name of requestNames) {
		if (!name.endsWith(".json") && !name.endsWith(CLAIMED_SUFFIX)) {
			continue;
		}
		let request: ArdyRegenerateRequestV1;
		try {
			request = parseArdyRegenerateRequest(await readClaimedRequest(join(paths.requests, name)));
		} catch {
			// An unreadable request is about to fail anyway, but until the
			// sweep decides that, treat it as claiming nothing rather than
			// deleting poses it might still name.
			continue;
		}
		for (const pose of request.full_body) {
			referenced.add(`${pose.synthetic_motion_id}.npz`);
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
		await rm(join(paths.motions, name), { force: true });
		removed.push(name);
	}
	return removed;
}

/**
 * Re-queue requests a previous sweep left claimed, so a host that crashed
 * mid-generation does not strand them.
 *
 * A claim is NOT evidence that the work did not happen. runClaimed writes the
 * outcome before it clears the claim, so a crash in that window leaves both.
 * Blindly restoring such a claim would run the generator a second time and
 * commit a second revision for one animator action, which is why every claim
 * is checked against its recorded outcome first and merely retired when one
 * exists.
 *
 * Returns the requests actually put back in the queue.
 */
export async function recoverAbandonedClaims(projectDirectory: string): Promise<string[]> {
	const paths = regenerateQueuePaths(projectDirectory);
	let names: string[];
	try {
		names = await readdir(paths.requests);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const recovered: string[] = [];
	for (const name of names.filter((candidate) => candidate.endsWith(CLAIMED_SUFFIX)).sort()) {
		const claimedPath = join(paths.requests, name);
		let request: ArdyRegenerateRequestV1 | null = null;
		try {
			request = parseArdyRegenerateRequest(await readClaimedRequest(claimedPath));
		} catch {
			// Unreadable: it cannot have a matching outcome to check against,
			// so put it back and let the sweep record the failure properly.
			request = null;
		}
		if (request !== null) {
			const finished = await existingOutcome(paths.outcomes, request.request_id);
			if (finished !== null) {
				await retireClaim(claimedPath, paths, request);
				continue;
			}
		}
		const restored = join(paths.requests, name.slice(0, -CLAIMED_SUFFIX.length));
		await rename(claimedPath, restored);
		recovered.push(restored);
	}
	return recovered;
}

// Writes a request the way the add-on does, for hosts and tests that need to
// drive the queue without a running Blender. Same atomic contract as
// constraint_capture.write_request, so what a sweep sees is identical.
export async function writeRegenerateRequest(
	projectDirectory: string,
	request: ArdyRegenerateRequestV1,
): Promise<string> {
	const paths = regenerateQueuePaths(projectDirectory);
	await mkdir(paths.requests, { recursive: true });
	const staged = join(paths.requests, `.${randomBytes(8).toString("hex")}.partial`);
	await writeFile(staged, `${JSON.stringify(parseArdyRegenerateRequest(request), null, 1)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	const final = join(paths.requests, `${request.request_id}.json`);
	await rename(staged, final);
	return final;
}
