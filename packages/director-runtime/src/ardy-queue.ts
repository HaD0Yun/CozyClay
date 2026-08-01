// Shared claim/outcome/retire machinery for the host-side ARDY queues.
//
// The add-on cannot call the host: connection.dispatch_bridge_message is a
// host-to-add-on pull, with no push in the other direction. So the add-on
// writes a self-contained request under .cclay/<request-directory>/ and the
// host picks it up here. Nothing in this file talks to an LLM or makes a
// choice; it reads a file, runs an already-tested queue handler, and writes
// the outcome back. That is what keeps each queue deterministic even though
// a director session is what happens to be running the sweep.
//
// Two properties this machinery is responsible for:
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

// Marks a request this sweep owns. The suffix is not a lock file: the rename
// itself is the lock, and the name only records who won.
export const CLAIMED_SUFFIX = ".claimed";

export interface ArdyQueuePaths {
	readonly requests: string;
	readonly outcomes: string;
}

export function ardyQueuePaths(
	projectDirectory: string,
	requestDirectory: string,
	outcomeDirectory: string,
): ArdyQueuePaths {
	return {
		requests: join(projectDirectory, ".cclay", requestDirectory),
		outcomes: join(projectDirectory, ".cclay", outcomeDirectory),
	};
}

// Everything one queue needs that differs from another. The machinery below
// is deliberately ignorant of every request field except request_id: a queue
// is a directory pair, a closed request schema, a closed outcome schema, an
// error classifier, and a handler.
export interface ArdyQueueDescriptor<RequestT, OutcomeT, ErrorCodeT extends string> {
	readonly requestDirectory: string;
	readonly outcomeDirectory: string;
	readonly parseRequest: (value: unknown) => RequestT;
	readonly parseOutcome: (value: unknown) => OutcomeT;
	readonly classifyError: (error: unknown) => { code: ErrorCodeT; message: string };
	readonly handler: (
		request: RequestT,
		context: unknown,
	) => Promise<{ result: unknown; resulting_revision_id: string }>;
}

export interface ArdyQueueSweepOptions<RequestT, OutcomeT, ErrorCodeT extends string> {
	readonly projectDirectory: string;
	readonly descriptor: ArdyQueueDescriptor<RequestT, OutcomeT, ErrorCodeT>;
	readonly contextFor: (request: RequestT) => unknown;
	// Deletes the input files a request brought with it, whether the request
	// succeeded or failed. Failure is the case that matters: an error path
	// that skipped this would leak a file per attempt, and the add-on mints a
	// fresh id every time so nothing would ever overwrite them.
	readonly removeRequestInputs?: (request: RequestT) => Promise<void>;
}

export interface ArdyQueueSweepEntry<OutcomeT> {
	readonly requestId: string;
	readonly outcome: OutcomeT;
}

// Written temp-then-rename with the same 0600 the add-on uses for requests, so
// a reader never observes a half-written outcome and the file is not
// world-readable while it is being produced.
export async function writeArdyOutcomeAtomically<OutcomeT extends { readonly request_id: string }>(
	directory: string,
	outcome: OutcomeT,
): Promise<string> {
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

export async function readClaimedRequest(path: string): Promise<unknown> {
	const handle = await open(path, "r");
	try {
		return JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}

// A terminal outcome already on disk, or null only when this request has not
// finished before. A malformed or unreadable outcome is an operational error:
// replaying it could commit a second revision and overwriting it would erase
// the only record of the first attempt.
export async function existingArdyOutcome<OutcomeT>(
	outcomes: string,
	requestId: string,
	parseOutcome: (value: unknown) => OutcomeT,
): Promise<OutcomeT | null> {
	try {
		const body = await readClaimedRequest(join(outcomes, `${requestId}.json`));
		return parseOutcome(body);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

// Everything a finished request leaves behind: the input files it brought
// (when the queue has any) and the claim itself. Deliberately ordered AFTER
// the outcome is durable -- the inputs are the replay input, so deleting them
// first turns a crash in that window into a request that can never be run
// again.
export async function retireArdyClaim<RequestT>(
	claimedPath: string,
	request: RequestT | null,
	removeRequestInputs: ((request: RequestT) => Promise<void>) | undefined,
): Promise<void> {
	if (request !== null && removeRequestInputs !== undefined) {
		await removeRequestInputs(request);
	}
	await rm(claimedPath, { force: true });
}

// One request, already claimed. Always produces an outcome file; the request's
// input files and the claim are cleared only once that outcome is durable, so
// every crash window leaves the request replayable rather than half-consumed.
async function runArdyClaimed<
	RequestT extends { readonly request_id: string },
	OutcomeT extends { readonly request_id: string },
	ErrorCodeT extends string,
>(
	claimedPath: string,
	paths: ArdyQueuePaths,
	options: ArdyQueueSweepOptions<RequestT, OutcomeT, ErrorCodeT>,
): Promise<OutcomeT> {
	let requestId = "unknown";
	let parsed: RequestT | null = null;
	let outcome: OutcomeT;
	try {
		const raw = await readClaimedRequest(claimedPath);
		parsed = options.descriptor.parseRequest(raw);
		requestId = parsed.request_id;
	} catch (error) {
		const { code, message } = options.descriptor.classifyError(error);
		const base = claimedPath.split("/").pop() ?? "unknown";
		outcome = options.descriptor.parseOutcome({
			schema_version: 1,
			request_id: requestId === "unknown" ? base.replace(/\.json\.claimed$/, "") : requestId,
			status: "failed",
			error_code: code,
			message: message.slice(0, 4096),
		});
		await writeArdyOutcomeAtomically(paths.outcomes, outcome);
		await retireArdyClaim(claimedPath, parsed, options.removeRequestInputs);
		return outcome;
	}
	// A terminal outcome means this request already ran to completion, possibly
	// committing a revision, before the host died. Re-running it would generate
	// a second motion and commit a second time, so the recorded answer is
	// returned and only the leftovers are cleared. This lookup deliberately
	// stays outside the failure-to-outcome path: a corrupt or unreadable record
	// leaves the claim and replay inputs intact for operator recovery.
	const finished = await existingArdyOutcome(paths.outcomes, requestId, options.descriptor.parseOutcome);
	if (finished !== null) {
		await retireArdyClaim(claimedPath, parsed, options.removeRequestInputs);
		return finished;
	}
	try {
		const applied = await options.descriptor.handler(parsed, options.contextFor(parsed));
		outcome = options.descriptor.parseOutcome({
			schema_version: 1,
			request_id: parsed.request_id,
			status: "succeeded",
			result: applied.result,
			resulting_revision_id: applied.resulting_revision_id,
		});
	} catch (error) {
		const { code, message } = options.descriptor.classifyError(error);
		outcome = options.descriptor.parseOutcome({
			schema_version: 1,
			request_id: requestId,
			status: "failed",
			error_code: code,
			message: message.slice(0, 4096),
		});
	}
	// Outcome first, then the inputs it consumed: the input files are what
	// a replay would need, so a crash between the two must leave them intact.
	await writeArdyOutcomeAtomically(paths.outcomes, outcome);
	await retireArdyClaim(claimedPath, parsed, options.removeRequestInputs);
	return outcome;
}

/**
 * Run every pending request once, oldest name first, and return the outcomes.
 *
 * Sequential on purpose. Each request commits a revision, and the handler
 * validates the request against the revision current when it runs; running
 * two at once would make the second one's guard depend on whether the first
 * happened to finish first.
 */
export async function sweepArdyQueue<
	RequestT extends { readonly request_id: string },
	OutcomeT extends { readonly request_id: string },
	ErrorCodeT extends string,
>(options: ArdyQueueSweepOptions<RequestT, OutcomeT, ErrorCodeT>): Promise<ArdyQueueSweepEntry<OutcomeT>[]> {
	const paths = ardyQueuePaths(
		options.projectDirectory,
		options.descriptor.requestDirectory,
		options.descriptor.outcomeDirectory,
	);
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
	const entries: ArdyQueueSweepEntry<OutcomeT>[] = [];
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
		const outcome = await runArdyClaimed(claimedPath, paths, options);
		entries.push({ requestId: outcome.request_id, outcome });
	}
	return entries;
}

export type ArdyQueueRecoveryDescriptor<RequestT, OutcomeT> = Pick<
	ArdyQueueDescriptor<RequestT, OutcomeT, string>,
	"requestDirectory" | "outcomeDirectory" | "parseRequest" | "parseOutcome"
>;

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
export async function recoverAbandonedArdyClaims<RequestT extends { readonly request_id: string }, OutcomeT>(
	projectDirectory: string,
	descriptor: ArdyQueueRecoveryDescriptor<RequestT, OutcomeT>,
	removeRequestInputs: ((request: RequestT) => Promise<void>) | undefined,
): Promise<string[]> {
	const paths = ardyQueuePaths(projectDirectory, descriptor.requestDirectory, descriptor.outcomeDirectory);
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
		let request: RequestT | null = null;
		try {
			request = descriptor.parseRequest(await readClaimedRequest(claimedPath));
		} catch {
			// Unreadable: it cannot have a matching outcome to check against,
			// so put it back and let the sweep record the failure properly.
			request = null;
		}
		if (request !== null) {
			const finished = await existingArdyOutcome(paths.outcomes, request.request_id, descriptor.parseOutcome);
			if (finished !== null) {
				await retireArdyClaim(claimedPath, request, removeRequestInputs);
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
export async function writeArdyQueueRequest<RequestT extends { readonly request_id: string }>(
	projectDirectory: string,
	requestDirectory: string,
	parseRequest: (value: unknown) => RequestT,
	request: RequestT,
): Promise<string> {
	const requests = join(projectDirectory, ".cclay", requestDirectory);
	await mkdir(requests, { recursive: true });
	const staged = join(requests, `.${randomBytes(8).toString("hex")}.partial`);
	await writeFile(staged, `${JSON.stringify(parseRequest(request), null, 1)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	const final = join(requests, `${request.request_id}.json`);
	await rename(staged, final);
	return final;
}
