// Host-owned consumer for the add-on's in-between pose queue.
//
// Same contract as ./regenerate-queue-runner.ts: the add-on cannot call the
// host, so publishing `.cclay/inbetween-requests/<id>` (with its captured
// poses already minted into .cclay/motions/ under the cclay-pose-* rule) is
// the only way an animator's request reaches this process, and the serialized
// sweep here is what consumes it. The in-between queue is write-ahead: the
// handler is the generate-only kernel (runCli through commitGenerated, no
// apply), the kernel records `generated` through its onGenerated seam BEFORE
// the commit, and the queue applies exactly once through the write-ahead
// machinery. The sweep owns deleting the captured pose archives when the
// request retires.
import type {
	ArdyInbetweenQueueOutcomeV1,
	ArdyInbetweenRequestV1,
	StageSceneRequestV1,
} from "@cclay/protocol";
import { parseArdyInbetweenRequest } from "@cclay/protocol";
import {
	ArdyArchiveService,
	ArdyInbetweenKernel,
	type ArdyInbetweenQueueHandler,
	type ArdyArchiveService as ArdyArchiveBoundary,
	type ArdyQueueWriteAhead,
	inbetweenQueuePaths,
	recoverAbandonedInbetweenClaims,
	sweepInbetweenRequests,
	writeArdyQueueProgress,
	writeInbetweenRequest,
	MotionArchiveStore,
} from "@cclay/director-runtime";
import {
	applyMotionRequest,
	CLI_TIMEOUT_MS,
	DEFAULT_TICK_MS,
	REPO_WRAPPER_PATH,
	runWrapper,
} from "./ardy-queue-runner-shared.ts";

export interface InbetweenQueueRunnerOptions {
	readonly cwd: string;
	// The CURRENT project revision, read fresh on every request. The sweep
	// preflight checks each request's expected_revision_id against it BEFORE
	// the kernel runs, so a stale queued request makes ZERO wrapper
	// invocations. Must be a live getter: capturing the revision once would
	// recreate the staleness bug this check exists to catch.
	readonly liveRevisionId: () => string;
	// The same dispatch the stage_scene tool uses, so a generated clip is
	// applied and committed through exactly one code path.
	readonly stageScene: (
		request: StageSceneRequestV1,
		context: unknown,
	) => Promise<{ resulting_revision_id: string }>;
	readonly wrapperPath?: string;
	readonly tickMs?: number;
	readonly onError: (error: unknown) => void;
	// Test seam only. Production always constructs the project-backed archive
	// service, so generation cannot bypass input validation or output commit.
	// The write-ahead machinery shares the same archive: recovery, the
	// readability check, and the commit must observe one store.
	readonly archive?: Pick<
		ArdyArchiveBoundary,
		"read" | "commitGenerated" | "recoverGenerated" | "removeStaleGeneratedClaims"
	>;
}

/**
 * Start consuming the queue. Returns a stop function.
 *
 * Recovery runs once before the first sweep, in that order: a host that died
 * mid-request left a claim, and nothing else will ever look at that file
 * again. The shared orphan sweep is the regeneration runner's startup job;
 * its owner set already covers this queue's pending and claimed requests.
 */
export function startInbetweenQueueRunner(options: InbetweenQueueRunnerOptions) {
	const wrapperPath = options.wrapperPath ?? REPO_WRAPPER_PATH;
	const archive = options.archive ?? new ArdyArchiveService(new MotionArchiveStore(options.cwd));
	const progressDirectory = inbetweenQueuePaths(options.cwd).progress;
	// The generate-only kernel: base and pose preflights, runCli through
	// commitGenerated, never apply -- the queue is the single apply point.
	const kernel = new ArdyInbetweenKernel({
		runCli: runWrapper(wrapperPath, options.cwd),
		archive,
		// Write-ahead seam: the `generated` record must be durable BEFORE the
		// commit makes the motion observable, so a crash between the two
		// leaves the request replayable instead of half-consumed.
		onGenerated: async (motionId, result) => {
			await writeArdyQueueProgress(progressDirectory, {
				schema_version: 1,
				request_id: result.request_id,
				status: "generated",
				motion_id: motionId,
				result,
			});
		},
	});
	const handler: ArdyInbetweenQueueHandler = async (params) => ({
		result: await kernel.inbetween(parseArdyInbetweenRequest(params)),
	});
	const writeAhead: ArdyQueueWriteAhead<ArdyInbetweenRequestV1> = {
		recoverGenerated: (motionId) => archive.recoverGenerated(motionId),
		read: (motionId) => archive.read(motionId),
		commitGenerated: (motionId) => archive.commitGenerated(motionId),
		removeStaleClaims: (motionId) => archive.removeStaleGeneratedClaims(motionId),
		// The queue is the single apply point; the dispatch binds against the
		// request's own expected_revision_id (see ArdyQueueWriteAhead.apply).
		apply: (request, context, motionId) =>
			options.stageScene(applyMotionRequest(motionId, request.entity_id, request.expected_revision_id), context),
	};

	let stopped = false;
	// One sweep at a time. Each request commits a revision, and the sweep's
	// staleness guard is written against the revision its request was built
	// on, so overlapping sweeps would make one request's guard depend on
	// whether another happened to finish first.
	let running: Promise<void> = Promise.resolve();
	type PendingWaiter = {
		resolve: (outcome: ArdyInbetweenQueueOutcomeV1) => void;
		reject: (error: Error) => void;
	};
	const pendingWaiters = new Map<string, PendingWaiter>();

	const tick = async () => {
		if (stopped) return;
		try {
			// Recovery runs every tick, not only at startup: a sweep that threw
			// -- a full disk, a directory yanked out from under it -- leaves the
			// request claimed, and recovering only once would strand it until
			// somebody restarted the host.
			await recoverAbandonedInbetweenClaims(options.cwd);
			for (const entry of await sweepInbetweenRequests({
				projectDirectory: options.cwd,
				handler,
				writeAhead,
				liveRevisionId: options.liveRevisionId,
				contextFor: (request: ArdyInbetweenRequestV1) => ({
					signal: AbortSignal.timeout(CLI_TIMEOUT_MS),
					request: { expected_revision_id: request.expected_revision_id },
				}),
			})) {
				const waiter = pendingWaiters.get(entry.requestId);
				if (waiter !== undefined) {
					pendingWaiters.delete(entry.requestId);
					waiter.resolve(entry.outcome);
				}
			}
		} catch (error) {
			// A sweep failure must not kill the interval: the next animator
			// request would then sit in the queue with nothing watching.
			options.onError(error);
		}
	};

	const schedule = () => {
		running = running.then(tick);
		return running;
	};

	const started = (async () => {
		try {
			// Unleased at startup: this process holds no claim yet, and one
			// left behind by a previous run is abandoned by definition.
			await recoverAbandonedInbetweenClaims(options.cwd);
		} catch (error) {
			options.onError(error);
		}
		await schedule();
	})();

	const timer = setInterval(schedule, options.tickMs ?? DEFAULT_TICK_MS);
	// Node must be free to exit while this is only waiting for the next tick.
	timer.unref?.();

	return {
		started,
		// The generator this host will actually spawn. Exposed because the
		// default is resolved, not passed in, and a wrong default fails only
		// once an animator has already published a request.
		wrapperPath,
		async inbetween(request: ArdyInbetweenRequestV1): Promise<ArdyInbetweenQueueOutcomeV1> {
			if (stopped) {
				throw new Error("INBETWEEN_QUEUE_RUNNER_STOPPED");
			}
			if (pendingWaiters.has(request.request_id)) {
				throw new Error(`DUPLICATE_ACTIVE_INBETWEEN_REQUEST_ID: ${request.request_id}`);
			}
			let resolve: (outcome: ArdyInbetweenQueueOutcomeV1) => void = () => {};
			let reject: (error: Error) => void = () => {};
			const outcome = new Promise<ArdyInbetweenQueueOutcomeV1>((onResolve, onReject) => {
				resolve = onResolve;
				reject = onReject;
			});
			pendingWaiters.set(request.request_id, { resolve, reject });
			try {
				await writeInbetweenRequest(options.cwd, request);
			} catch (error) {
				pendingWaiters.delete(request.request_id);
				reject(error instanceof Error ? error : new Error(String(error)));
				return outcome;
			}
			void schedule();
			return outcome;
		},
		async stop(): Promise<void> {
			stopped = true;
			clearInterval(timer);
			for (const waiter of pendingWaiters.values()) {
				waiter.reject(new Error("INBETWEEN_QUEUE_RUNNER_STOPPED"));
			}
			pendingWaiters.clear();
			await running.catch(() => {});
		},
		// Exposed for tests and for a host that wants to react immediately
		// rather than waiting out the interval.
		sweepNow: schedule,
	};
}
