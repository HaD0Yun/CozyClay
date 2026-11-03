// Where a motion compile runs. In the browser: a pool of module Web Workers (motion3/compile-worker.js), at most
// POOL of them, each started on first need and reused; a job takes an idle worker or waits in arrival order, so a
// compile costs a worker's time and never blocks the viewport (the main thread runs the compiler ~4x slower and freezes
// while it does). Two workers let two Studio tasks compile at once (parallel tasks, case 10) without a third
// starving the editor's cores; the rest wait, and the panel shows which task's compile is waiting (compileActivity).
// Where there is no Worker (Node, tests) or a worker fails: the same job on the calling thread, synchronously, so
// `registry.run("motion.compile", ...)` there still answers at once. The answer is the same either way (compile-job.js
// runs the same code on the same plain inputs), whichever worker runs it.
import { runCompileJob } from "../motion3/compile-job.js";
import { StudioProtocolError } from "../studio-agent-protocol.js";
import { specRefusalPath } from "../motion3/schema/fields.js";

const POOL = 2;

/** A job error (or a worker's serialized one) as the Studio's protocol error when it carries a code. */
function rethrow(error) {
	// A refused spec names its top-level field for studio:refused (command-bus-telemetry.js); the message is unchanged.
	if (error?.code && !(error instanceof StudioProtocolError)) throw new StudioProtocolError(error.code, error.message, error.code === "INVALID_ARGUMENT" ? { path: specRefusalPath(error.message), rule: "spec" } : {});
	if (error instanceof Error) throw error;
	throw Object.assign(new Error(error?.message ?? String(error)), { name: error?.name ?? "Error" });
}
const local = job => { try { return runCompileJob(job); } catch (error) { return rethrow(error); } };

/** The browser's module worker, or null where there is none. */
function browserWorker() {
	if (typeof Worker !== "function") return null;
	return new Worker(new URL("../motion3/compile-worker.js", import.meta.url), { type: "module", name: "motion-compile" });
}

// What the editor's compiles are doing, for the panel: { running: [meta], waiting: [meta] } (meta: { taskId, characterId }).
const watchers = new Set();
let activity = { running: [], waiting: [] };
const publish = next => { activity = next; for (const watcher of watchers) watcher(activity); };
export const compileActivity = () => activity;
export function watchCompileActivity(watcher) { watchers.add(watcher); return () => watchers.delete(watcher); }

/**
 * createCompileRunner({ spawn, size }) -> { run(job, meta?) -> answer | Promise<answer>, takeWarning() -> string | null }
 * spawn() -> a Worker-like object (postMessage, onmessage, onerror, terminate) or null for the calling thread.
 */
export function createCompileRunner({ spawn = browserWorker, size = POOL } = {}) {
	let dead = false, warning = null, next = 0;
	const slots = [], queue = [];
	const report = () => publish({ running: slots.filter(slot => slot.job).map(slot => slot.job.meta), waiting: queue.map(item => item.meta) });
	/** A worker failed (would not start, or crashed): every job from now on, and those in flight or waiting, run here. */
	const fallBack = reason => {
		dead = true;
		warning ??= `The motion compile worker stopped (${reason}); compiling on the main thread, which is slower and blocks the editor while it runs.`;
		const orphans = [...slots.flatMap(slot => (slot.job ? [slot.job] : [])), ...queue.splice(0)];
		for (const slot of slots.splice(0)) slot.worker?.terminate?.();
		for (const { job, resolve, reject } of orphans) { try { resolve(local(job)); } catch (error) { reject(error); } }
		report();
	};
	/** One more worker in the pool: its slot, or null when none can start (dead: every job runs here from now on). */
	const grow = () => {
		let worker;
		try { worker = spawn(); } catch (error) { fallBack(error?.message ?? String(error)); return null; }
		if (!worker) { dead = true; return null; }
		const slot = { worker, job: null };
		worker.onmessage = ({ data: { id, value, error } }) => {
			const job = slot.job;
			if (!job || job.id !== id) return;
			slot.job = null;
			if (error) { try { rethrow(error); } catch (thrown) { job.reject(thrown); } } else job.resolve(value);
			pump();
		};
		worker.onerror = event => { event?.preventDefault?.(); fallBack(event?.message || "worker error"); };
		worker.onmessageerror = () => fallBack("an answer could not be read");
		slots.push(slot);
		return slot;
	};
	const pump = () => {
		while (!dead && queue.length) {
			const slot = slots.find(candidate => !candidate.job) ?? (slots.length < size ? grow() : null);
			if (!slot) break;
			slot.job = queue.shift();
			try { slot.worker.postMessage({ id: slot.job.id, job: slot.job.job }); } catch (error) { fallBack(error?.message ?? String(error)); return; }
		}
		if (dead) for (const item of queue.splice(0)) { try { item.resolve(local(item.job)); } catch (error) { item.reject(error); } }
		report();
	};
	return {
		run(job, meta = {}) {
			// No worker can start here (Node, tests): answer on this thread at once, as before.
			if (dead || (!slots.length && !grow())) return local(job);
			return new Promise((resolve, reject) => { queue.push({ id: ++next, job, meta, resolve, reject }); pump(); });
		},
		/** The fallback note, once (a receipt warning), or null. */
		takeWarning() { const note = warning; if (note) warning = ""; return note || null; },
	};
}
