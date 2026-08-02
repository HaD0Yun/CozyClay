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
// Properties this machinery is responsible for:
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
//   No regeneration after a recorded generation. The new capability queues
//   (generate, in-between) record generated -> committed -> applied
//   transitions per request. Once a `generated` record exists for a
//   request_id, the queue never runs the generator again for it: a replay
//   recovers the recorded bytes, re-applies them, and returns the RECORDED
//   result. The one residual is the window before that record lands: a
//   crash after the generator returned but before the `generated` record
//   was written costs ONE extra run, because nothing was recorded yet.
//   The bound is per crash in that window, not per request: N consecutive
//   crashes in it cost N runs. Nothing here can do better without a
//   host-assigned motion id, which would require changing the wrapper CLI.
//   That residual is a documented, tested property, not a hole to hide.
//   The regeneration queue predates write-ahead and is
//   deliberately legacy: its closed outcome union is a contract the add-on
//   parses and cannot carry new codes, so it keeps exactly its
//   pre-write-ahead semantics (no records, re-run after a crash).

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ArdyQueueProgressV1, parseArdyQueueProgress } from "@cclay/protocol";
import type { ArdyGeneratedClaimRecovery } from "./ardy-archive-service.ts";

// Marks a request this sweep owns. The suffix is not a lock file: the rename
// itself is the lock, and the name only records who won.
export const CLAIMED_SUFFIX = ".claimed";

export interface ArdyQueuePaths {
	readonly requests: string;
	readonly outcomes: string;
	// Present only when the descriptor declares a progress directory.
	readonly progress?: string;
}

export function ardyQueuePaths(
	projectDirectory: string,
	requestDirectory: string,
	outcomeDirectory: string,
	progressDirectory?: string,
): ArdyQueuePaths {
	return {
		requests: join(projectDirectory, ".cclay", requestDirectory),
		outcomes: join(projectDirectory, ".cclay", outcomeDirectory),
		progress: progressDirectory === undefined ? undefined : join(projectDirectory, ".cclay", progressDirectory),
	};
}

// The pieces of a motion-producing queue the write-ahead replay needs. The
// recover/read/commit trio is the archive service's contract; removeStaleClaims
// is the post-commit sweep that unlinks claims only once commitGenerated has
// made the canonical bytes known-valid; apply is the single place a revision
// gets committed for the request. The queue invokes apply once per run, so a
// replay may ATTEMPT it a second time — the mutation boundary rejects that
// attempt as a revision mismatch, so at most one apply ever lands durably.
export interface ArdyQueueWriteAhead<RequestT> {
	readonly recoverGenerated: (motionId: string) => Promise<ArdyGeneratedClaimRecovery>;
	readonly read: (motionId: string) => Promise<Uint8Array>;
	readonly commitGenerated: (motionId: string) => Promise<void>;
	// Unlinks residual `.claim` files for the motion. The queue calls this
	// ONLY after commitGenerated succeeded, the single point at which the
	// canonical bytes are known-valid; it must never be used to "clean up"
	// an archive whose validity is unknown (see recoverGenerated).
	//
	// Its failure is deliberately NOT fatal to the request. By this point the
	// canonical bytes are committed, so a leftover claim is inert garbage
	// holding a duplicate of data that is already safe. Failing the request
	// over it would turn a successful generation into a failure and force the
	// operator to spend another generator run — strictly worse than a stray
	// file. The next successful commit of the same motion sweeps it.
	readonly removeStaleClaims: (motionId: string) => Promise<void>;
	// Applies the generated motion to the entity and returns the revision it
	// committed. The dispatch MUST bind against the request's own
	// expected_revision_id: a `committed` replay calls apply again with the
	// SAME request, so if the first apply already landed, the mutation
	// boundary rejects the second as a revision mismatch. That is the
	// apply-window contract: a kill between a durable apply and the
	// `applied` record yields a conservative failure, never a double apply.
	readonly apply: (
		request: RequestT,
		context: unknown,
		motionId: string,
	) => Promise<{ readonly resulting_revision_id: string }>;
}

// Everything one queue needs that differs from another. The machinery below
// is deliberately ignorant of every request field except request_id: a queue
// is a directory pair, a closed request schema, a closed outcome schema, an
// error classifier, and a handler. The descriptor is one of two shapes,
// discriminated by writeAhead:
//
//   ArdyQueueLegacyDescriptor -- the handler runs the WHOLE request
//   (generate, commit, apply) and MUST return the revision it committed.
//   The regeneration queue keeps this shape forever: its closed outcome
//   union is a contract the add-on parses and cannot carry new codes, so it
//   is openly, deliberately legacy and never gains write-ahead.
//
//   ArdyQueueWriteAheadDescriptor -- the handler is the generate-only kernel
//   (runCli through commitGenerated, no apply) and MUST NOT return a
//   revision: the queue is the single apply point, so a composite handler
//   would commit a second revision on replay.
export interface ArdyQueueLegacyDescriptor<RequestT, OutcomeT, ErrorCodeT extends string> {
	readonly requestDirectory: string;
	readonly outcomeDirectory: string;
	// The closed outcome union's member for the interrupted-commit condition
	// (a request consumed a generator run but neither its archive nor a claim
	// survives). Queues whose union has no such member -- the regeneration
	// queue's GENERATION_FAILED-only failure schema -- omit it and the
	// condition is mapped through classifyError instead.
	readonly interruptedCommitCode?: ErrorCodeT;
	readonly parseRequest: (value: unknown) => RequestT;
	readonly parseOutcome: (value: unknown) => OutcomeT;
	readonly classifyError: (error: unknown) => { code: ErrorCodeT; message: string };
	readonly handler: (
		request: RequestT,
		context: unknown,
	) => Promise<{
		readonly result: unknown;
		readonly resulting_revision_id: string;
	}>;
}

export interface ArdyQueueWriteAheadDescriptor<RequestT, OutcomeT, ErrorCodeT extends string> {
	readonly requestDirectory: string;
	readonly outcomeDirectory: string;
	// Directory (under .cclay) holding the queue's write-ahead progress
	// records, one `<request_id>.json` per request.
	readonly progressDirectory: string;
	readonly interruptedCommitCode?: ErrorCodeT;
	readonly parseRequest: (value: unknown) => RequestT;
	readonly parseOutcome: (value: unknown) => OutcomeT;
	readonly classifyError: (error: unknown) => { code: ErrorCodeT; message: string };
	// The closed result schema of the capability, used to validate the
	// opaque `result` a progress record carries every time the record is
	// read. The record schema itself stays closed at the protocol layer;
	// the capability-specific parse happens here, in the queue.
	readonly parseResult: (value: unknown) => unknown;
	readonly handler: (request: RequestT, context: unknown) => Promise<{ readonly result: unknown }>;
	// Write-ahead progress machinery. When present, every request is
	// protected unconditionally: once a record exists the generator never
	// runs again for that request_id, and a replay recovers the recorded
	// bytes (or reports a terminal interrupted-commit failure) instead of
	// regenerating. No runtime id gate is needed: the capability schemas pin
	// request_id to ^[0-9a-f]{32}$, so a write-ahead queue's ids are
	// filename-safe by construction.
	readonly writeAhead: ArdyQueueWriteAhead<RequestT>;
}

export type ArdyQueueDescriptor<RequestT, OutcomeT, ErrorCodeT extends string> =
	| ArdyQueueLegacyDescriptor<RequestT, OutcomeT, ErrorCodeT>
	| ArdyQueueWriteAheadDescriptor<RequestT, OutcomeT, ErrorCodeT>;

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

// Written temp-then-rename with the same 0600 the add-on uses for requests,
// so a reader never observes a half-written file and the file is not
// world-readable while it is being produced. Both stages are fsynced, like
// MotionArchiveStore.write: the staged file before the rename and the
// containing directory after it, so a record a replay depends on survives a
// power loss, not just a process kill.
async function writeJsonAtomically(directory: string, fileName: string, value: unknown): Promise<string> {
	await mkdir(directory, { recursive: true });
	const staged = join(directory, `.${randomBytes(8).toString("hex")}.partial`);
	const final = join(directory, fileName);
	const handle = await open(staged, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 1)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await chmod(staged, 0o600);
		await rename(staged, final);
		const directoryHandle = await open(directory, fsConstants.O_RDONLY);
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	} catch (error) {
		await rm(staged, { force: true });
		throw error;
	}
	return final;
}

export async function writeArdyOutcomeAtomically<OutcomeT extends { readonly request_id: string }>(
	directory: string,
	outcome: OutcomeT,
): Promise<string> {
	return writeJsonAtomically(directory, `${outcome.request_id}.json`, outcome);
}

// A write-ahead progress record, validated by the closed progress schema so
// a record on disk is always parseable. Same atomic, fsynced contract as the
// outcome writer. Write-ahead queues only ever hold ids in the 32-hex
// filename grammar, so the record name is safe by construction.
export async function writeArdyQueueProgress(directory: string, record: ArdyQueueProgressV1): Promise<string> {
	return writeJsonAtomically(directory, `${record.request_id}.json`, parseArdyQueueProgress(record));
}

// The write-ahead record for a request, or null only when the generator has
// not produced one yet. A malformed or unreadable record is an operational
// error: replaying could spend a second GPU run on a request that already
// consumed one, and overwriting it would erase the only evidence of how far
// the request got. Never rewritten here.
export async function existingArdyQueueProgress(
	directory: string,
	requestId: string,
): Promise<ArdyQueueProgressV1 | null> {
	try {
		const body = await readClaimedRequest(join(directory, `${requestId}.json`));
		return parseArdyQueueProgress(body);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
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

// Raised when a request with a write-ahead record can no longer recover its
// generated bytes: recoverGenerated found neither the canonical archive nor a
// claim, so a generator run was consumed with nothing durable left to show
// for it. Terminal: the queue never runs the generator again for this
// request_id, and the operator must resubmit under a NEW request_id. Queues
// whose closed outcome union declares interruptedCommitCode report the code
// directly; every other queue maps it through classifyError (a
// GENERATION_FAILED-style fallback).
export class ArdyInterruptedCommitError extends Error {
	readonly motionId: string;
	constructor(motionId: string) {
		super(
			`motion ${motionId} was interrupted during commit and neither its archive nor a claim survives; ` +
				`the request_id may already have consumed a generator run, so resubmit under a NEW request_id`,
		);
		this.name = "ArdyInterruptedCommitError";
		this.motionId = motionId;
	}
}

// The record's `result` is opaque at the protocol layer; the write-ahead
// descriptor's own closed result parser validates it every time a record is
// read. A record whose result cannot parse is an operational error, exactly
// like an unreadable record: it must never lead to a second generator run,
// and it is never overwritten.
function parseRecordedResult<RequestT, OutcomeT, ErrorCodeT extends string>(
	descriptor: ArdyQueueWriteAheadDescriptor<RequestT, OutcomeT, ErrorCodeT>,
	record: ArdyQueueProgressV1,
): unknown {
	try {
		return descriptor.parseResult(record.result);
	} catch (error) {
		throw new Error(
			`write-ahead record for request ${record.request_id} carries a result that fails ` +
				`the queue's closed result schema`,
			{ cause: error },
		);
	}
}

// Everything a finished request leaves behind: the input files it brought
// (when the queue has any), the write-ahead progress record (when it has
// one), and the claim itself. Deliberately ordered AFTER the outcome is
// durable -- the inputs are the replay input, so deleting them first turns a
// crash in that window into a request that can never be run again. Within
// the retirement the claim is last: it is the replay token, and the inputs
// and progress record are only hygiene once the outcome is durable.
export async function retireArdyClaim<RequestT>(
	claimedPath: string,
	request: RequestT | null,
	removeRequestInputs: ((request: RequestT) => Promise<void>) | undefined,
	progressPath?: string,
): Promise<void> {
	if (request !== null && removeRequestInputs !== undefined) {
		await removeRequestInputs(request);
	}
	if (progressPath !== undefined) {
		await rm(progressPath, { force: true });
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
	const descriptor = options.descriptor;
	// The claim filename IS the request id, so it is known even when the
	// body cannot be parsed; the progress record (when one exists) is named
	// by that id on every path, including the failure-to-outcome path.
	const derivedId = (claimedPath.split("/").pop() ?? "unknown").replace(/\.json\.claimed$/, "");
	const progressPath = paths.progress !== undefined ? join(paths.progress, `${derivedId}.json`) : undefined;
	let requestId = derivedId;
	let parsed: RequestT | null = null;
	let outcome: OutcomeT;
	try {
		const raw = await readClaimedRequest(claimedPath);
		parsed = descriptor.parseRequest(raw);
		requestId = parsed.request_id;
	} catch (error) {
		const { code, message } = descriptor.classifyError(error);
		outcome = descriptor.parseOutcome({
			schema_version: 1,
			request_id: requestId,
			status: "failed",
			error_code: code,
			message: message.slice(0, 4096),
		});
		await writeArdyOutcomeAtomically(paths.outcomes, outcome);
		await retireArdyClaim(claimedPath, parsed, options.removeRequestInputs, progressPath);
		return outcome;
	}
	// A terminal outcome means this request already ran to completion, possibly
	// committing a revision, before the host died. Re-running it would generate
	// a second motion and commit a second time, so the recorded answer is
	// returned and only the leftovers are cleared. This lookup deliberately
	// stays outside the failure-to-outcome path: a corrupt or unreadable record
	// leaves the claim and replay inputs intact for operator recovery.
	const finished = await existingArdyOutcome(paths.outcomes, requestId, descriptor.parseOutcome);
	if (finished !== null) {
		await retireArdyClaim(claimedPath, parsed, options.removeRequestInputs, progressPath);
		return finished;
	}
	// Same operational contract as the outcome lookup, so it stays outside the
	// failure-to-outcome path: a corrupt or unreadable record leaves the claim
	// and replay inputs intact and is never overwritten. The record is also
	// the generator's one-shot gate -- once it exists, the request_id must
	// never call the generator again. Write-ahead is UNCONDITIONAL for a
	// descriptor that supplies it: the capability schemas pin request_id to
	// ^[0-9a-f]{32}$, so every id is filename-safe by construction and no
	// runtime gate is needed.
	// Write-ahead is UNCONDITIONAL for a descriptor that supplies it: the
	// capability schemas pin request_id to ^[0-9a-f]{32}$, so every id is
	// filename-safe by construction and no runtime gate is needed. The
	// `in` check is the descriptor discriminant (legacy descriptors have no
	// writeAhead member at all).
	let record: ArdyQueueProgressV1 | null = null;
	if ("writeAhead" in descriptor && paths.progress !== undefined) {
		record = await existingArdyQueueProgress(paths.progress, requestId);
		if (record !== null) {
			// Validate the recorded result before anything runs: a record
			// whose result fails the capability's closed schema is an
			// operational error and must never lead to a second run.
			parseRecordedResult(descriptor, record);
		}
	}
	try {
		if (!("writeAhead" in descriptor)) {
			// Legacy queue: no progress machinery at all, the handler runs
			// the whole request exactly as it did before write-ahead existed.
			outcome = await runArdyClaimedLegacy(parsed, descriptor, options.contextFor(parsed));
		} else if (record === null) {
			// The generator has not consumed a run for this request_id. The
			// handler is the generate-only kernel: it records `generated` via
			// its onGenerated seam BEFORE committing, and the queue below is
			// the single apply point, recording `committed` and `applied`.
			// progressDirectory is required on the write-ahead descriptor, so
			// paths.progress is always present here.
			outcome = await runArdyClaimedFresh(
				parsed,
				requestId,
				paths.progress!,
				descriptor,
				options.contextFor(parsed),
			);
		} else {
			outcome = await runArdyClaimedReplay(
				parsed,
				requestId,
				paths.progress!,
				descriptor,
				options.contextFor(parsed),
				record,
			);
		}
	} catch (error) {
		let code: ErrorCodeT;
		let message: string;
		if (error instanceof ArdyInterruptedCommitError && descriptor.interruptedCommitCode !== undefined) {
			code = descriptor.interruptedCommitCode;
			message = error.message;
		} else {
			const classified = descriptor.classifyError(error);
			code = classified.code;
			message = classified.message;
		}
		outcome = descriptor.parseOutcome({
			schema_version: 1,
			request_id: requestId,
			status: "failed",
			error_code: code,
			message: message.slice(0, 4096),
		});
	}
	// Outcome first, then the inputs it consumed and the progress record:
	// the input files are what a replay would need, so a crash between the
	// two must leave them intact. The claim is retired last of all.
	await writeArdyOutcomeAtomically(paths.outcomes, outcome);
	await retireArdyClaim(claimedPath, parsed, options.removeRequestInputs, progressPath);
	return outcome;
}

// Legacy run: the handler does everything (generate, commit, apply) and
// returns the applied answer, as it did before write-ahead existed.
async function runArdyClaimedLegacy<
	RequestT extends { readonly request_id: string },
	OutcomeT extends { readonly request_id: string },
	ErrorCodeT extends string,
>(
	parsed: RequestT,
	descriptor: ArdyQueueLegacyDescriptor<RequestT, OutcomeT, ErrorCodeT>,
	context: unknown,
): Promise<OutcomeT> {
	const handled = await descriptor.handler(parsed, context);
	return descriptor.parseOutcome({
		schema_version: 1,
		request_id: parsed.request_id,
		status: "succeeded",
		result: handled.result,
		resulting_revision_id: handled.resulting_revision_id,
	});
}

// Fresh run under write-ahead: the generate-only kernel has already recorded
// `generated` (with the full capability result) and committed the archive by
// the time it returns. The record is re-read for the motion id and result
// (it is the single source of truth for both), then flipped to `committed`,
// applied exactly once, and flipped to `applied`.
async function runArdyClaimedFresh<
	RequestT extends { readonly request_id: string },
	OutcomeT extends { readonly request_id: string },
	ErrorCodeT extends string,
>(
	parsed: RequestT,
	requestId: string,
	progressDirectory: string,
	descriptor: ArdyQueueWriteAheadDescriptor<RequestT, OutcomeT, ErrorCodeT>,
	context: unknown,
): Promise<OutcomeT> {
	await descriptor.handler(parsed, context);
	const generated = await existingArdyQueueProgress(progressDirectory, requestId);
	if (generated === null || generated.status !== "generated") {
		throw new Error(
			`write-ahead handler for request ${requestId} returned without recording its generated progress record`,
		);
	}
	const result = parseRecordedResult(descriptor, generated);
	await writeArdyQueueProgress(progressDirectory, {
		schema_version: 1,
		request_id: requestId,
		status: "committed",
		motion_id: generated.motion_id,
		result: generated.result,
	});
	const applied = await descriptor.writeAhead.apply(parsed, context, generated.motion_id);
	await writeArdyQueueProgress(progressDirectory, {
		schema_version: 1,
		request_id: requestId,
		status: "applied",
		motion_id: generated.motion_id,
		result: generated.result,
		resulting_revision_id: applied.resulting_revision_id,
	});
	return descriptor.parseOutcome({
		schema_version: 1,
		request_id: requestId,
		status: "succeeded",
		result,
		resulting_revision_id: applied.resulting_revision_id,
	});
}

// Replay of a request that already consumed a generator run. An `applied`
// record returns the RECORDED result verbatim with zero applies -- the
// revision was already committed. `generated` and `committed` records follow
// the fixed recover-read-commit-sweep-apply order, with recovery FIRST
// (before any archive-readability check) so a stale claim is restored while
// it still exists; the post-commit sweep then removes residual claims now
// that commitGenerated has made the canonical bytes known-valid. The
// archive-readable fast path must never skip that sweep. Apply is bound to
// the request's own expected_revision_id, so a `committed` replay of an
// apply that already landed is rejected by the mutation boundary as a
// revision mismatch: a conservative failure, never a double apply.
async function runArdyClaimedReplay<
	RequestT extends { readonly request_id: string },
	OutcomeT extends { readonly request_id: string },
	ErrorCodeT extends string,
>(
	parsed: RequestT,
	requestId: string,
	progressDirectory: string,
	descriptor: ArdyQueueWriteAheadDescriptor<RequestT, OutcomeT, ErrorCodeT>,
	context: unknown,
	record: ArdyQueueProgressV1,
): Promise<OutcomeT> {
	const writeAhead = descriptor.writeAhead;
	// The recorded result is validated before ANY recovery or apply runs
	// (the gate already validated it too; this is where its value is used).
	const result = parseRecordedResult(descriptor, record);
	if (record.status === "applied") {
		return descriptor.parseOutcome({
			schema_version: 1,
			request_id: requestId,
			status: "succeeded",
			result,
			resulting_revision_id: record.resulting_revision_id,
		});
	}
	const recovery = await writeAhead.recoverGenerated(record.motion_id);
	if (recovery.outcome === "none") {
		throw new ArdyInterruptedCommitError(record.motion_id);
	}
	await writeAhead.read(record.motion_id);
	await writeAhead.commitGenerated(record.motion_id);
	// Best-effort: the bytes are committed, so a surviving claim is garbage
	// rather than data. See the removeStaleClaims contract above for why this
	// must not fail the request.
	await writeAhead.removeStaleClaims(record.motion_id).catch(() => undefined);
	if (record.status === "generated") {
		await writeArdyQueueProgress(progressDirectory, {
			schema_version: 1,
			request_id: requestId,
			status: "committed",
			motion_id: record.motion_id,
			result: record.result,
		});
	}
	const applied = await writeAhead.apply(parsed, context, record.motion_id);
	await writeArdyQueueProgress(progressDirectory, {
		schema_version: 1,
		request_id: requestId,
		status: "applied",
		motion_id: record.motion_id,
		result: record.result,
		resulting_revision_id: applied.resulting_revision_id,
	});
	return descriptor.parseOutcome({
		schema_version: 1,
		request_id: requestId,
		status: "succeeded",
		result,
		resulting_revision_id: applied.resulting_revision_id,
	});
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
	const progressDirectory = "writeAhead" in options.descriptor ? options.descriptor.progressDirectory : undefined;
	const paths = ardyQueuePaths(
		options.projectDirectory,
		options.descriptor.requestDirectory,
		options.descriptor.outcomeDirectory,
		progressDirectory,
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

// The subset of a descriptor claim recovery needs: the directory names and
// the two closed parsers. progressDirectory is optional because legacy
// queues (the regeneration queue) never write progress records.
export interface ArdyQueueRecoveryDescriptor<RequestT, OutcomeT> {
	readonly requestDirectory: string;
	readonly outcomeDirectory: string;
	readonly progressDirectory?: string;
	readonly parseRequest: (value: unknown) => RequestT;
	readonly parseOutcome: (value: unknown) => OutcomeT;
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
export async function recoverAbandonedArdyClaims<RequestT extends { readonly request_id: string }, OutcomeT>(
	projectDirectory: string,
	descriptor: ArdyQueueRecoveryDescriptor<RequestT, OutcomeT>,
	removeRequestInputs: ((request: RequestT) => Promise<void>) | undefined,
): Promise<string[]> {
	const paths = ardyQueuePaths(
		projectDirectory,
		descriptor.requestDirectory,
		descriptor.outcomeDirectory,
		descriptor.progressDirectory,
	);
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
				const progressPath =
					paths.progress !== undefined ? join(paths.progress, `${request.request_id}.json`) : undefined;
				await retireArdyClaim(claimedPath, request, removeRequestInputs, progressPath);
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
