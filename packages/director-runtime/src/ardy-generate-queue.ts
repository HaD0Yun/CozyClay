// Host-side consumer for the add-on's first-pass generation queue.
//
// The claim/outcome/retire machinery lives in ./ardy-queue.ts, shared with
// the other host-side ARDY queues; this file is the generate queue's
// instantiation: the directory names, the closed request/outcome parsers,
// the error classifier, and the write-ahead descriptor that makes the
// generated -> committed -> applied records and claim recovery real for this
// queue (the same contract the crash-matrix harness exercises generically).
//
// The add-on cannot call the host: connection.dispatch_bridge_message is a
// host-to-add-on pull, with no push in the other direction. So the add-on
// writes a self-contained request under .cclay/generate-requests/ and the
// host picks it up here. Nothing in this file talks to an LLM or makes a
// choice; it reads a file, runs the already-tested generate kernel, and
// writes the outcome back.
//
// Write-ahead semantics (see ardy-queue.ts's header for the full contract):
// the handler here is the generate-only kernel (runCli through
// commitGenerated, no apply) and MUST NOT return a revision -- the queue is
// the single apply point, so a composite handler would commit a second
// revision on replay. The kernel records `generated` via its onGenerated
// seam BEFORE the commit; the queue flips the record to `committed`, applies
// exactly once through writeAhead.apply, and flips it to `applied`. A
// request whose `generated` record already exists on disk never calls the
// generator again; a replay recovers the recorded bytes and re-applies.
import {
	type ArdyGenerateErrorCode,
	type ArdyGenerateQueueOutcomeV1,
	type ArdyGenerateRequestV1,
	parseArdyGenerateQueueOutcome,
	parseArdyGenerateRequest,
	parseArdyGenerateResult,
} from "@cclay/protocol";
import {
	ArdyGenerateError,
	ArdyGenerateInvalidRequestError,
	ArdyGenerateRevisionMismatchError,
} from "./ardy-generate-service.ts";
import {
	type ArdyQueueWriteAhead,
	type ArdyQueueWriteAheadDescriptor,
	ardyQueuePaths,
	recoverAbandonedArdyClaims,
	sweepArdyQueue,
	writeArdyQueueRequest,
} from "./ardy-queue.ts";

export const GENERATE_REQUEST_DIRECTORY = "generate-requests";
export const GENERATE_OUTCOME_DIRECTORY = "generate-outcomes";
export const GENERATE_PROGRESS_DIRECTORY = "generate-progress";

export interface ArdyGenerateQueuePaths {
	readonly requests: string;
	readonly outcomes: string;
	readonly progress: string;
}

export function generateQueuePaths(projectDirectory: string): ArdyGenerateQueuePaths {
	const paths = ardyQueuePaths(
		projectDirectory,
		GENERATE_REQUEST_DIRECTORY,
		GENERATE_OUTCOME_DIRECTORY,
		GENERATE_PROGRESS_DIRECTORY,
	);
	return { requests: paths.requests, outcomes: paths.outcomes, progress: paths.progress! };
}

// The handler shape a write-ahead sweep needs: the generate-only kernel,
// which records `generated` itself and returns no revision (the queue
// applies). Injected rather than constructed here so a sweep can be tested
// without a generator or a bridge.
export type ArdyGenerateQueueHandler = (params: unknown, context: unknown) => Promise<{ result: unknown }>;

export interface ArdyGenerateSweepOptions {
	readonly projectDirectory: string;
	readonly handler: ArdyGenerateQueueHandler;
	// The write-ahead recovery/apply machinery, bound to the project's
	// archive store and the director's apply dispatch. The queue is the
	// single apply point; the dispatch MUST bind against the request's own
	// expected_revision_id (see ArdyQueueWriteAhead.apply).
	readonly writeAhead: ArdyQueueWriteAhead<ArdyGenerateRequestV1>;
	// Built per request so the handler gets a context bound to the request it
	// is about to run: the AbortSignal the caller wants used for the run, and
	// the revision the request was built on for its apply-time commit binding.
	readonly contextFor: (request: ArdyGenerateRequestV1) => unknown;
	// The CURRENT project revision, read fresh per request. The write-ahead
	// path runs the generate-only kernel, which has no revision notion of its
	// own, so the sweep itself checks the request's expected_revision_id
	// against this BEFORE the kernel executes: a stale queued request fails
	// as REVISION_MISMATCH with ZERO generator invocations, exactly like the
	// composite service's guard. Required, not optional with a fallback: an
	// optional freshness check that silently defaults is how the original
	// defect survived.
	readonly liveRevisionId: () => string;
}

export interface ArdyGenerateSweepEntry {
	readonly requestId: string;
	readonly outcome: ArdyGenerateQueueOutcomeV1;
}

function classify(error: unknown): { code: ArdyGenerateErrorCode; message: string } {
	if (error instanceof ArdyGenerateError) {
		return { code: error.code, message: error.message };
	}
	return {
		code: "GENERATION_FAILED",
		message: error instanceof Error ? error.message : String(error),
	};
}

function parseQueuedRequest(value: unknown): ArdyGenerateRequestV1 {
	try {
		return parseArdyGenerateRequest(value);
	} catch (error) {
		throw new ArdyGenerateInvalidRequestError(error instanceof Error ? error.message : String(error), {
			cause: error,
		});
	}
}

function generateQueueDescriptor(
	handler: ArdyGenerateQueueHandler,
	writeAhead: ArdyQueueWriteAhead<ArdyGenerateRequestV1>,
	liveRevisionId: () => string,
): ArdyQueueWriteAheadDescriptor<ArdyGenerateRequestV1, ArdyGenerateQueueOutcomeV1, ArdyGenerateErrorCode> {
	return {
		requestDirectory: GENERATE_REQUEST_DIRECTORY,
		outcomeDirectory: GENERATE_OUTCOME_DIRECTORY,
		progressDirectory: GENERATE_PROGRESS_DIRECTORY,
		// The closed union's member for the interrupted-commit condition: a
		// request consumed a generator run but neither its archive nor a
		// claim survives. Terminal; never regenerated.
		interruptedCommitCode: "GENERATION_INTERRUPTED",
		parseRequest: parseQueuedRequest,
		parseOutcome: parseArdyGenerateQueueOutcome,
		parseResult: parseArdyGenerateResult,
		classifyError: classify,
		// The composite service's staleness guard does not exist on the
		// write-ahead path -- its handler is the generate-only kernel, which
		// knows nothing about revisions -- so the sweep binds the guard here,
		// BEFORE the kernel executes. A stale request fails as
		// REVISION_MISMATCH and the generator never runs.
		handler: (request, context) => {
			const live = liveRevisionId();
			if (request.expected_revision_id !== live) {
				throw new ArdyGenerateRevisionMismatchError(request.expected_revision_id, live);
			}
			return handler(request, context);
		},
		writeAhead,
	};
}

/**
 * Run every pending request once, oldest name first, and return the outcomes.
 */
export async function sweepGenerateRequests(options: ArdyGenerateSweepOptions): Promise<ArdyGenerateSweepEntry[]> {
	return sweepArdyQueue({
		projectDirectory: options.projectDirectory,
		descriptor: generateQueueDescriptor(options.handler, options.writeAhead, options.liveRevisionId),
		contextFor: options.contextFor,
	});
}

/**
 * Re-queue requests a previous sweep left claimed, so a host that crashed
 * mid-generation does not strand them.
 */
export async function recoverAbandonedGenerateClaims(projectDirectory: string): Promise<string[]> {
	return recoverAbandonedArdyClaims(
		projectDirectory,
		{
			requestDirectory: GENERATE_REQUEST_DIRECTORY,
			outcomeDirectory: GENERATE_OUTCOME_DIRECTORY,
			progressDirectory: GENERATE_PROGRESS_DIRECTORY,
			parseRequest: parseQueuedRequest,
			parseOutcome: parseArdyGenerateQueueOutcome,
		},
		undefined,
	);
}

// Writes a request the way the add-on does, for hosts and tests that need to
// drive the queue without a running Blender. Same atomic contract as
// constraint_capture.write_request, so what a sweep sees is identical.
export async function writeGenerateRequest(projectDirectory: string, request: ArdyGenerateRequestV1): Promise<string> {
	return writeArdyQueueRequest(projectDirectory, GENERATE_REQUEST_DIRECTORY, parseArdyGenerateRequest, request);
}
