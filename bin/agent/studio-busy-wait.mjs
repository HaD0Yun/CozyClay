// Waiting out the user's gesture. The editor refuses an agent or task command with TARGET_BUSY "Finish the current
// editor gesture first." while the user drags something (src/studio-busy.js). That is not a failure of the command:
// the sidecar re-sends it with backoff (250 ms doubling to 2 s) for up to 20 s, and says it is waiting meanwhile
// (`onWait(true)`, then `onWait(false)` once it stops). Only a gesture still held after 20 s reaches the model, as a
// soft TARGET_BUSY that says so; the task keeps running. Any other refusal is thrown at once, untouched.
export const GESTURE_WAIT_MS = 20_000;
const FIRST_DELAY_MS = 250, MAX_DELAY_MS = 2_000;

/** A TARGET_BUSY that names the user's gesture (not an open transaction or agent turn). */
export const isGestureBusy = error => error?.code === "TARGET_BUSY" && /editor gesture/i.test(String(error?.message ?? ""));

export const sleepUnlessAborted = (ms, signal) => new Promise(resolve => {
	if (signal?.aborted) return resolve(false);
	const done = value => { clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); resolve(value); };
	const onAbort = () => done(false);
	const timer = setTimeout(() => done(true), ms);
	signal?.addEventListener?.("abort", onAbort, { once: true });
});

/**
 * Runs `send()` until it answers anything but a gesture TARGET_BUSY. Resolves { result, waitedMs, tries }; waitedMs
 * is the backoff slept, so the budget holds whatever the clock. Throws the last refusal (marked `gestureTimedOut`)
 * once the next pause would pass `maxMs`, or at once when `signal` aborts. `refused`: the refusal that already
 * came back for this command, so the first thing done is a pause, not a send.
 */
export async function waitOutGesture(send, { refused = null, signal, maxMs = GESTURE_WAIT_MS, sleep = sleepUnlessAborted, onWait } = {}) {
	let tries = refused ? 1 : 0, delay = FIRST_DELAY_MS, waitedMs = 0, waiting = false, error = refused;
	try {
		for (;;) {
			if (!error) {
				tries++;
				try { return { result: await send(), waitedMs, tries }; } catch (thrown) { error = thrown; }
			}
			if (!isGestureBusy(error)) throw error;
			if (waitedMs + delay > maxMs) throw Object.assign(error, { gestureTimedOut: true, waitedMs, tries });
			if (!waiting) { waiting = true; onWait?.(true); }
			if (!await sleep(delay, signal)) throw error;
			waitedMs += delay; delay = Math.min(MAX_DELAY_MS, delay * 2); error = null;
		}
	} finally { if (waiting) onWait?.(false); }
}
