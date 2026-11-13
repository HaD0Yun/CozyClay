// Coalesced solving for a live drag: at most one solve is in flight, and while it runs
// only the latest request waits; older ones are dropped. Results arrive in request order, so a stale pose never
// lands after a newer one.

/**
 * `run(job) -> Promise<result>`; `onResult(result, job)` runs for every finished job, `onError(error, job)` for a
 * failed one. `request(job)` queues the job (replacing any queued one); `idle()` resolves once nothing is running
 * or queued; `clear()` drops the queued job. `stats` counts requested, run and dropped jobs.
 */
export function createSolveLoop(run, { onResult, onError } = {}) {
	let running = false, queued = null, hasQueued = false;
	const waiters = [], stats = { requested: 0, run: 0, dropped: 0 };

	function settle() {
		if (running || hasQueued) return;
		for (const resolve of waiters.splice(0)) resolve();
	}

	async function pump() {
		if (running || !hasQueued) return settle();
		const job = queued;
		queued = null; hasQueued = false; running = true; stats.run += 1;
		try { const result = await run(job); onResult?.(result, job); } catch (error) { onError?.(error, job); }
		running = false;
		pump();
	}

	return {
		request(job) {
			stats.requested += 1;
			if (hasQueued) stats.dropped += 1;
			queued = job; hasQueued = true;
			pump();
		},
		clear() {
			if (hasQueued) stats.dropped += 1;
			queued = null; hasQueued = false;
			settle();
		},
		idle: () => (running || hasQueued ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()),
		get busy() { return running || hasQueued; },
		stats,
	};
}
