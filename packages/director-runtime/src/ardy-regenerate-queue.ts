// Host-side consumer for the add-on's regeneration queue.
//
// The claim/outcome/retire machinery lives in ./ardy-queue.ts, shared with
// the other host-side ARDY queues; this file is the regeneration queue's
// instantiation: the directory names, the closed request/outcome parsers,
// the error classifier, and the synthetic-pose lifecycle that only
// regeneration requests have.
//
// The add-on cannot call the host: connection.dispatch_bridge_message is a
// host-to-add-on pull, with no push in the other direction. So the add-on
// writes a self-contained request under .cclay/regenerate-requests/ and the
// host picks it up here. Nothing in this file talks to an LLM or makes a
// choice; it reads a file, runs the already-tested regenerate handler, and
// writes the outcome back. That is what keeps "regenerate" deterministic even
// though a director session is what happens to be running the sweep.
//
// Three properties this queue is responsible for (the first two enforced by
// the shared machinery, the third a deliberate boundary):
//
//   Exactly-once claiming. A request is claimed by renaming it before it is
//   executed. rename() is atomic on POSIX, so two concurrent sweeps cannot
//   both claim the same request: the loser gets ENOENT and moves on. Without
//   this a slow generation would be started twice by the next tick.
//
//   No silent loss. The add-on has already detached its IK layer by the time
//   the host sees the request, so a failure that produced no file would be
//   indistinguishable from a host that was never running. Every claimed
//   request produces exactly one outcome file, success or failure.
//
//   Deliberately legacy. This queue predates write-ahead and keeps its
//   pre-write-ahead semantics exactly: its closed outcome union is a
//   contract the add-on parses and cannot carry new codes, so it never
//   gains progress records. A host that dies mid-request leaves a claim
//   that recovery re-queues, and the request runs again -- there is no
//   "no regeneration after a recorded generation" guarantee here, and none
//   is claimed.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type ArdyRegenerateErrorCode,
	type ArdyRegenerateQueueOutcomeV1,
	type ArdyRegenerateRequestV1,
	parseArdyInbetweenRequest,
	parseArdyRegenerateQueueOutcome,
	parseArdyRegenerateRequest,
} from "@cclay/protocol";
import { inbetweenSyntheticPoseIds } from "./ardy-inbetween-service.ts";
import {
	type ArdyQueueDescriptor,
	ardyQueuePaths,
	recoverAbandonedArdyClaims,
	sweepArdyQueue,
	writeArdyQueueRequest,
} from "./ardy-queue.ts";
import { ArdyRegenerateError, ArdyRegenerateInvalidRequestError } from "./ardy-regenerate-service.ts";
import { removeOrphanedSyntheticPoses as removeOrphanedSyntheticPosesShared } from "./ardy-synthetic-poses.ts";

export const REGENERATE_REQUEST_DIRECTORY = "regenerate-requests";
export const REGENERATE_OUTCOME_DIRECTORY = "regenerate-outcomes";
// Write-ahead progress records are for the NEW capability queues
// (generate, in-between) only. This queue is deliberately legacy: its
// closed outcome union is a contract the add-on parses and cannot carry
// new codes, so it declares no progress directory and nothing drives one.
// Synthetic full-body pose archives the add-on writes so --constrain-pose has
// something to point at. They exist only for the duration of one request; the
// host owns deleting them because the add-on has already detached and stopped
// caring by the time the generator runs. The prefix and the cross-queue
// orphan lifecycle live in ./ardy-synthetic-poses.ts, shared with the
// in-between queue (which mints the same cclay-pose- prefix for its
// captured poses).

export interface ArdyRegenerateQueuePaths {
	readonly requests: string;
	readonly outcomes: string;
	readonly motions: string;
}

export function regenerateQueuePaths(projectDirectory: string): ArdyRegenerateQueuePaths {
	const paths = ardyQueuePaths(projectDirectory, REGENERATE_REQUEST_DIRECTORY, REGENERATE_OUTCOME_DIRECTORY);
	return {
		requests: paths.requests,
		outcomes: paths.outcomes,
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
	// Built per request so the handler gets a context bound to the request it
	// is about to run: the AbortSignal the caller wants used for the run, and
	// the revision the request was built on for its apply-time commit binding.
	// The queue does not decide whether a request is stale; it only supplies
	// the context the handler needs to run and bind.
	readonly contextFor: (request: ArdyRegenerateRequestV1) => unknown;
}

export interface ArdyRegenerateSweepEntry {
	readonly requestId: string;
	readonly outcome: ArdyRegenerateQueueOutcomeV1;
}

function classify(error: unknown): { code: ArdyRegenerateErrorCode; message: string } {
	if (error instanceof ArdyRegenerateError) {
		return { code: error.code, message: error.message };
	}
	return {
		code: "GENERATION_FAILED",
		message: error instanceof Error ? error.message : String(error),
	};
}

function parseQueuedRequest(value: unknown): ArdyRegenerateRequestV1 {
	try {
		return parseArdyRegenerateRequest(value);
	} catch (error) {
		throw new ArdyRegenerateInvalidRequestError(error instanceof Error ? error.message : String(error), {
			cause: error,
		});
	}
}

function regenerateQueueDescriptor(
	handler: ArdyRegenerateQueueHandler,
): ArdyQueueDescriptor<ArdyRegenerateRequestV1, ArdyRegenerateQueueOutcomeV1, ArdyRegenerateErrorCode> {
	return {
		requestDirectory: REGENERATE_REQUEST_DIRECTORY,
		outcomeDirectory: REGENERATE_OUTCOME_DIRECTORY,
		parseRequest: parseQueuedRequest,
		parseOutcome: parseArdyRegenerateQueueOutcome,
		classifyError: classify,
		handler,
	};
}

/**
 * Run every pending request once, oldest name first, and return the outcomes.
 */
export async function sweepRegenerateRequests(
	options: ArdyRegenerateSweepOptions,
): Promise<ArdyRegenerateSweepEntry[]> {
	const paths = regenerateQueuePaths(options.projectDirectory);
	return sweepArdyQueue({
		projectDirectory: options.projectDirectory,
		descriptor: regenerateQueueDescriptor(options.handler),
		contextFor: options.contextFor,
		removeRequestInputs: (request) => removeSyntheticPoses(paths.motions, request),
	});
}

/**
 * Delete synthetic pose archives no queued request still refers to.
 *
 * A host that died between the add-on writing the poses and the sweep
 * consuming the request leaves them with no owner, and nothing else in the
 * project will ever mention them again. Run at startup, after
 * recoverAbandonedClaims, so requests waiting to be retried keep their poses.
 *
 * Both pose-minting queues are owners: the in-between surface mints the SAME
 * cclay-pose- prefix into the SAME motions directory
 * (cclay-pose-<request_id>-<n>), so a sweep that knew only the regenerate
 * requests would delete an in-between request's in-flight poses. The shared
 * sweep in ./ardy-synthetic-poses.ts computes the full owner set.
 */
export async function removeOrphanedSyntheticPoses(projectDirectory: string): Promise<string[]> {
	return removeOrphanedSyntheticPosesShared(projectDirectory, [
		{
			requestDirectory: REGENERATE_REQUEST_DIRECTORY,
			syntheticPoseIds: (request) => {
				const parsed = parseArdyRegenerateRequest(request);
				return parsed.full_body.map((pose) => pose.synthetic_motion_id);
			},
		},
		{
			// The in-between surface mints the same prefix; the literal must
			// match INBETWEEN_REQUEST_DIRECTORY in ardy-inbetween-queue.ts.
			// It lives here because the import direction is one-way:
			// ardy-inbetween-queue.ts re-exports this file's sweep and
			// imports this file's constants, so this file must not import
			// that one back.
			requestDirectory: "inbetween-requests",
			syntheticPoseIds: (request) => inbetweenSyntheticPoseIds(parseArdyInbetweenRequest(request)),
		},
	]);
}

/**
 * Re-queue requests a previous sweep left claimed, so a host that crashed
 * mid-generation does not strand them.
 */
export async function recoverAbandonedClaims(projectDirectory: string): Promise<string[]> {
	const paths = regenerateQueuePaths(projectDirectory);
	return recoverAbandonedArdyClaims(
		projectDirectory,
		{
			requestDirectory: REGENERATE_REQUEST_DIRECTORY,
			outcomeDirectory: REGENERATE_OUTCOME_DIRECTORY,
			parseRequest: parseQueuedRequest,
			parseOutcome: parseArdyRegenerateQueueOutcome,
		},
		(request) => removeSyntheticPoses(paths.motions, request),
	);
}

// Writes a request the way the add-on does, for hosts and tests that need to
// drive the queue without a running Blender. Same atomic contract as
// constraint_capture.write_request, so what a sweep sees is identical.
export async function writeRegenerateRequest(
	projectDirectory: string,
	request: ArdyRegenerateRequestV1,
): Promise<string> {
	return writeArdyQueueRequest(projectDirectory, REGENERATE_REQUEST_DIRECTORY, parseArdyRegenerateRequest, request);
}
