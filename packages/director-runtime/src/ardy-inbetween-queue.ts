// Host-side consumer for the add-on's in-between pose queue.
//
// The claim/outcome/retire machinery lives in ./ardy-queue.ts, shared with
// the other host-side ARDY queues; this file is the in-between queue's
// instantiation: the directory names, the closed request/outcome parsers,
// the error classifier, the synthetic-pose lifecycle, and the write-ahead
// descriptor that makes the generated -> committed -> applied records and
// claim recovery real for this queue.
//
// The add-on cannot call the host: connection.dispatch_bridge_message is a
// host-to-add-on pull, with no push in the other direction. So the add-on
// writes a self-contained request under .cclay/inbetween-requests/ (its
// captured poses already minted into .cclay/motions/ under the
// cclay-pose-<request_id>-<n> rule) and the host picks it up here. Nothing
// in this file talks to an LLM or makes a choice; it reads a file, runs the
// already-tested in-between kernel, and writes the outcome back.
//
// Write-ahead semantics are the generate queue's, exactly: the handler is
// the generate-only kernel (runCli through commitGenerated, no apply), the
// kernel records `generated` via its onGenerated seam before the commit,
// and the queue applies exactly once. A request whose `generated` record
// already exists on disk never calls the generator again.
//
// Synthetic pose lifecycle: the archives a request brought with it are
// deleted when the request is retired, whether the generation succeeded or
// failed -- the add-on mints a fresh request_id (hence fresh ids) every
// time, so an error path that skipped this would leak an archive per
// attempt. The host owns deletion because the add-on has already detached
// and stopped caring by the time the generator runs.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type ArdyInbetweenErrorCode,
	type ArdyInbetweenQueueOutcomeV1,
	type ArdyInbetweenRequestV1,
	parseArdyInbetweenQueueOutcome,
	parseArdyInbetweenRequest,
	parseArdyInbetweenResult,
} from "@cclay/protocol";
import {
	ArdyInbetweenError,
	ArdyInbetweenInvalidRequestError,
	inbetweenSyntheticPoseIds,
} from "./ardy-inbetween-service.ts";
import {
	type ArdyQueueWriteAhead,
	type ArdyQueueWriteAheadDescriptor,
	ardyQueuePaths,
	recoverAbandonedArdyClaims,
	sweepArdyQueue,
	writeArdyQueueRequest,
} from "./ardy-queue.ts";

export const INBETWEEN_REQUEST_DIRECTORY = "inbetween-requests";
export const INBETWEEN_OUTCOME_DIRECTORY = "inbetween-outcomes";
export const INBETWEEN_PROGRESS_DIRECTORY = "inbetween-progress";

export interface ArdyInbetweenQueuePaths {
	readonly requests: string;
	readonly outcomes: string;
	readonly progress: string;
	readonly motions: string;
}

export function inbetweenQueuePaths(projectDirectory: string): ArdyInbetweenQueuePaths {
	const paths = ardyQueuePaths(
		projectDirectory,
		INBETWEEN_REQUEST_DIRECTORY,
		INBETWEEN_OUTCOME_DIRECTORY,
		INBETWEEN_PROGRESS_DIRECTORY,
	);
	return {
		requests: paths.requests,
		outcomes: paths.outcomes,
		progress: paths.progress!,
		motions: join(projectDirectory, ".cclay", "motions"),
	};
}

// Deletes the synthetic pose archives a request brought with it, whether the
// in-between generation succeeded or failed. Failure is the case that
// matters: an error path that skipped this would leak an archive per attempt,
// and the add-on mints a fresh request_id every time so nothing would ever
// overwrite them.
async function removeSyntheticPoses(motions: string, request: ArdyInbetweenRequestV1): Promise<void> {
	for (const poseId of inbetweenSyntheticPoseIds(request)) {
		await rm(join(motions, `${poseId}.npz`), { force: true });
	}
}

// The handler shape a write-ahead sweep needs: the generate-only kernel,
// which records `generated` itself and returns no revision (the queue
// applies). Injected rather than constructed here so a sweep can be tested
// without a generator or a bridge.
export type ArdyInbetweenQueueHandler = (params: unknown, context: unknown) => Promise<{ result: unknown }>;

export interface ArdyInbetweenSweepOptions {
	readonly projectDirectory: string;
	readonly handler: ArdyInbetweenQueueHandler;
	// The write-ahead recovery/apply machinery, bound to the project's
	// archive store and the director's apply dispatch. The queue is the
	// single apply point; the dispatch MUST bind against the request's own
	// expected_revision_id (see ArdyQueueWriteAhead.apply).
	readonly writeAhead: ArdyQueueWriteAhead<ArdyInbetweenRequestV1>;
	// Built per request so the handler gets a context bound to the request it
	// is about to run: the AbortSignal the caller wants used for the run, and
	// the revision the request was built on for its apply-time commit binding.
	readonly contextFor: (request: ArdyInbetweenRequestV1) => unknown;
}

export interface ArdyInbetweenSweepEntry {
	readonly requestId: string;
	readonly outcome: ArdyInbetweenQueueOutcomeV1;
}

function classify(error: unknown): { code: ArdyInbetweenErrorCode; message: string } {
	if (error instanceof ArdyInbetweenError) {
		return { code: error.code, message: error.message };
	}
	return {
		code: "GENERATION_FAILED",
		message: error instanceof Error ? error.message : String(error),
	};
}

function parseQueuedRequest(value: unknown): ArdyInbetweenRequestV1 {
	try {
		return parseArdyInbetweenRequest(value);
	} catch (error) {
		throw new ArdyInbetweenInvalidRequestError(error instanceof Error ? error.message : String(error), {
			cause: error,
		});
	}
}

function inbetweenQueueDescriptor(
	handler: ArdyInbetweenQueueHandler,
	writeAhead: ArdyQueueWriteAhead<ArdyInbetweenRequestV1>,
): ArdyQueueWriteAheadDescriptor<ArdyInbetweenRequestV1, ArdyInbetweenQueueOutcomeV1, ArdyInbetweenErrorCode> {
	return {
		requestDirectory: INBETWEEN_REQUEST_DIRECTORY,
		outcomeDirectory: INBETWEEN_OUTCOME_DIRECTORY,
		progressDirectory: INBETWEEN_PROGRESS_DIRECTORY,
		// The closed union's member for the interrupted-commit condition: a
		// request consumed a generator run but neither its archive nor a
		// claim survives. Terminal; never regenerated.
		interruptedCommitCode: "GENERATION_INTERRUPTED",
		parseRequest: parseQueuedRequest,
		parseOutcome: parseArdyInbetweenQueueOutcome,
		parseResult: parseArdyInbetweenResult,
		classifyError: classify,
		handler,
		writeAhead,
	};
}

/**
 * Run every pending request once, oldest name first, and return the outcomes.
 */
export async function sweepInbetweenRequests(options: ArdyInbetweenSweepOptions): Promise<ArdyInbetweenSweepEntry[]> {
	const paths = inbetweenQueuePaths(options.projectDirectory);
	return sweepArdyQueue({
		projectDirectory: options.projectDirectory,
		descriptor: inbetweenQueueDescriptor(options.handler, options.writeAhead),
		contextFor: options.contextFor,
		removeRequestInputs: (request) => removeSyntheticPoses(paths.motions, request),
	});
}

// No orphan sweep lives in this file: removeOrphanedSyntheticPoses (in
// ./ardy-regenerate-queue.ts, exported from the package index) is THE sweep
// for the shared motions directory. Both surfaces mint cclay-pose-* archives
// there, and that sweep's owner set covers BOTH queues' pending and claimed
// requests, so a request in either queue protects its archives and no second
// sweep exists to disagree with it.

/**
 * Re-queue requests a previous sweep left claimed, so a host that crashed
 * mid-generation does not strand them.
 */
export async function recoverAbandonedInbetweenClaims(projectDirectory: string): Promise<string[]> {
	const paths = inbetweenQueuePaths(projectDirectory);
	return recoverAbandonedArdyClaims(
		projectDirectory,
		{
			requestDirectory: INBETWEEN_REQUEST_DIRECTORY,
			outcomeDirectory: INBETWEEN_OUTCOME_DIRECTORY,
			progressDirectory: INBETWEEN_PROGRESS_DIRECTORY,
			parseRequest: parseQueuedRequest,
			parseOutcome: parseArdyInbetweenQueueOutcome,
		},
		(request) => removeSyntheticPoses(paths.motions, request),
	);
}

// Writes a request the way the add-on does, for hosts and tests that need to
// drive the queue without a running Blender. Same atomic contract as
// constraint_capture.write_request, so what a sweep sees is identical.
export async function writeInbetweenRequest(
	projectDirectory: string,
	request: ArdyInbetweenRequestV1,
): Promise<string> {
	return writeArdyQueueRequest(projectDirectory, INBETWEEN_REQUEST_DIRECTORY, parseArdyInbetweenRequest, request);
}
