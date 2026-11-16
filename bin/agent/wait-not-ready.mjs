// A TARGET_NOT_READY whose cause clears by itself (the editor marks it recovery { action: "retry", retryAllowed: true }:
// a character's rig still loading) is re-sent by the sidecar with backoff (250 ms doubling to 2 s) for up to
// NOT_READY_WAIT_MS, instead of handing the model a refusal it can only wait out. A command that lands after a wait
// carries a NOT_READY_WAITED warning; one still not ready after the bound reaches the model with the time waited.
// Every other refusal passes through at once, untouched.
import { sleepUnlessAborted } from "./studio-busy-wait.mjs";

export const NOT_READY_WAIT_MS = 8_000;
const FIRST_DELAY_MS = 250, MAX_DELAY_MS = 2_000;

const transient = error => error?.code === "TARGET_NOT_READY" && error?.receipt?.recovery?.retryAllowed === true;

/** `run(name, args, callId)` that waits out a transient TARGET_NOT_READY; `options` { signal, sleep, maxMs } (tests pass sleep). */
export function waitWhileNotReady(run, { signal, sleep = sleepUnlessAborted, maxMs = NOT_READY_WAIT_MS } = {}) {
	return async (name, args, callId) => {
		let waitedMs = 0, delay = FIRST_DELAY_MS;
		for (;;) {
			try {
				const result = await run(name, args, callId);
				if (!waitedMs || !result || typeof result !== "object") return result;
				const warning = { code: "NOT_READY_WAITED", message: `The target was not ready (a rig loading); waited ${waitedMs} ms and re-sent the command.` };
				return { ...result, warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), warning] };
			} catch (error) {
				if (!transient(error)) throw error;
				if (waitedMs + delay > maxMs || !await sleep(delay, signal)) {
					error.message = `${error.message} Waited ${waitedMs} ms for it to become ready (the bound is ${maxMs} ms); still not ready.`;
					throw error;
				}
				waitedMs += delay; delay = Math.min(MAX_DELAY_MS, delay * 2);
			}
		}
	};
}
