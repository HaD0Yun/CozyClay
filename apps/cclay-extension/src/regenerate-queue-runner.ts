// Host-owned consumer for the add-on's ARDY regeneration queue.
//
// The add-on cannot call the host: the bridge is a host-to-add-on pull with no
// push in the other direction, so publishing `.cclay/regenerate-requests/<id>`
// is the only way an animator's request reaches this process. Something on
// this side has to look, and that something is here.
//
// The runner remains the host-owned execution path for both animator and model
// requests: callers publish a canonical request, then the serialized sweep
// invokes the existing queue handler.
import type {
	ArdyRegenerateQueueOutcomeV1,
	ArdyRegenerateRequestV1,
	StageSceneRequestV1,
} from "@cclay/protocol";
import {
	ARDY_REGENERATE_WRAPPER,
	ArdyArchiveService,
	type ArdyRegenerateCliResult,
	type ArdyRegenerateQueueHandler,
	type ArdyArchiveService as ArdyArchiveBoundary,
	createArdyRegenerateHandler,
	recoverAbandonedClaims,
	removeOrphanedSyntheticPoses,
	sweepRegenerateRequests,
	writeRegenerateRequest,
	MotionArchiveStore,
} from "@cclay/director-runtime";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// Long because a constrained ARDY run goes out to a GPU box over ssh and back.
// A wrapper that hangs past this is a stuck run, and killing it produces a
// recorded failure the animator can see instead of a queue that never moves.
const CLI_TIMEOUT_MS = 30 * 60 * 1000;
// stdout is one JSON line; anything approaching this is a runaway.
const CLI_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_TICK_MS = 5_000;
// The wrapper ships with the repository, not with the project directory the
// host runs in: `cwd` is the animator's .blend folder, which has no scripts/.
// Resolved from this module so it survives being launched from anywhere.
const REPO_WRAPPER_PATH = fileURLToPath(
	new URL(`../../../scripts/${ARDY_REGENERATE_WRAPPER}`, import.meta.url),
);

export interface RegenerateQueueRunnerOptions {
	readonly cwd: string;
	// The CURRENT project revision, read fresh on every request. The handler
	// checks each request's expected_revision_id against it before spending
	// GPU time on a regeneration, and the apply re-binds against the request's
	// own revision afterwards. Must be a live getter: capturing the revision
	// once would recreate the staleness bug this check exists to catch.
	readonly liveRevisionId: () => string;
	// The same dispatch the stage_scene tool uses, so a regenerated clip is
	// applied and committed through exactly one code path.
	readonly stageScene: (
		request: StageSceneRequestV1,
		context: unknown,
	) => Promise<{ resulting_revision_id: string }>;
	readonly wrapperPath?: string;
	readonly tickMs?: number;
	readonly onError: (error: unknown) => void;
	// Test seam only. Production always constructs the project-backed archive
	// service, so regeneration cannot bypass input validation or output commit.
	readonly archive?: Pick<ArdyArchiveBoundary, "read" | "commitGenerated">;
}

// argv is passed as an array to execFile, never a shell string, so a
// constraint coordinate cannot escape its positional slot.
function runWrapper(wrapperPath: string, cwd: string) {
	return (argv: readonly string[]): Promise<ArdyRegenerateCliResult> =>
		new Promise((resolve) => {
			execFile(
				wrapperPath,
				[...argv],
				{ cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER_BYTES },
				(error, stdout, stderr) => {
					// A non-zero exit is data, not an exception: the queue turns
					// it into a recorded failure so the add-on can recover the
					// rig instead of waiting forever.
					const status =
						error === null ? 0 : typeof error.code === "number" ? error.code : 1;
					resolve({ status, stdout, stderr: error === null ? stderr : `${stderr}${error.message}` });
				},
			);
		});
}

/**
 * The apply_motion the regenerated clip needs, expressed as a stage_scene
 * plan so it travels the same validated, committed path every other mutation
 * takes. Building a second application route would be a second place for the
 * revision bookkeeping to be wrong.
 */
function applyMotionRequest(
	motionId: string,
	entityId: string,
	expectedRevisionId: string,
): StageSceneRequestV1 {
	return {
		schema_version: 1,
		expected_revision_id: expectedRevisionId,
		operations: [{ op: "apply_motion", entity_id: entityId, motion_id: motionId }],
	};
}

/**
 * Start consuming the queue. Returns a stop function.
 *
 * Recovery runs once before the first sweep, and orphan cleanup after it, in
 * that order: a request waiting to be retried still owns its synthetic poses,
 * and sweeping them first would delete the inputs the retry needs.
 */
export function startRegenerateQueueRunner(options: RegenerateQueueRunnerOptions) {
	const wrapperPath = options.wrapperPath ?? REPO_WRAPPER_PATH;
	// The handler's context type is the director's; the queue passes it through
	// opaquely, so the seam is narrowed once here rather than at every call.
	const handler = createArdyRegenerateHandler({
		runCli: runWrapper(wrapperPath, options.cwd),
		archive: options.archive ?? new ArdyArchiveService(new MotionArchiveStore(options.cwd)),
		applyMotion: async (motionId, entityId, expectedRevisionId, context) =>
			options.stageScene(applyMotionRequest(motionId, entityId, expectedRevisionId), context),
		liveRevisionId: options.liveRevisionId,
	}) as ArdyRegenerateQueueHandler;

	let stopped = false;
	// One sweep at a time. Each request commits a revision, and the handler's
	// staleness guard is written against the revision its request was built
	// on, so overlapping sweeps would make one request's guard depend on
	// whether another happened to finish first.
	let running: Promise<void> = Promise.resolve();
	type PendingWaiter = {
		resolve: (outcome: ArdyRegenerateQueueOutcomeV1) => void;
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
			await recoverAbandonedClaims(options.cwd);
			for (const entry of await sweepRegenerateRequests({
				projectDirectory: options.cwd,
				handler,
				contextFor: (request: ArdyRegenerateRequestV1) => ({
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
			// left behind by a previous run is abandoned by definition. Ahead
			// of the orphan sweep so a request waiting to be retried still owns
			// the synthetic poses that retry will need.
			await recoverAbandonedClaims(options.cwd);
			await removeOrphanedSyntheticPoses(options.cwd);
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
		async regenerate(request: ArdyRegenerateRequestV1): Promise<ArdyRegenerateQueueOutcomeV1> {
			if (stopped) {
				throw new Error("REGENERATE_QUEUE_RUNNER_STOPPED");
			}
			if (pendingWaiters.has(request.request_id)) {
				throw new Error(`DUPLICATE_ACTIVE_REGENERATE_REQUEST_ID: ${request.request_id}`);
			}
			let resolve: (outcome: ArdyRegenerateQueueOutcomeV1) => void = () => {};
			let reject: (error: Error) => void = () => {};
			const outcome = new Promise<ArdyRegenerateQueueOutcomeV1>((onResolve, onReject) => {
				resolve = onResolve;
				reject = onReject;
			});
			pendingWaiters.set(request.request_id, { resolve, reject });
			try {
				await writeRegenerateRequest(options.cwd, request);
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
				waiter.reject(new Error("REGENERATE_QUEUE_RUNNER_STOPPED"));
			}
			pendingWaiters.clear();
			await running.catch(() => {});
		},
		// Exposed for tests and for a host that wants to react immediately
		// rather than waiting out the interval.
		sweepNow: schedule,
	};
}
