// Loads the poser network once, lazily, on the first use of the Auto Pose tool. The network runs in a module worker; if
// the worker itself cannot start (not the model: a missing model is a failure either way) it runs on the main thread.
// Progress and failure go to Auto Pose store so the panel can show them; nothing else in Pose mode waits on it.
// A worker that dies after it was ready (a crash, or a run that never answers) is dropped and the network loads again
// (from Cache Storage). Callers hold one stable network whose runs wait for the replacement, so nothing is rebuilt.
import { POSER_MODEL } from "../config.js";
import { PoserModelError } from "../model-source.js";
import { updatePoserState } from "./poser-store.js";

let pending = null, current = null;
const RUN_TIMEOUT_MS = 10000;
// what callers hold: runs go to the network loaded now, or wait for the one loading
const shared = { info: null, run: (inputs) => (current ?? Promise.reject(new Error("the pose network is not loaded"))).then((network) => network.run(inputs)) };

const infraFailure = (message) => Object.assign(new Error(message), { workerFailed: true });

function workerNetwork(onProgress, onLost) {
	return new Promise((resolve, reject) => {
		let worker, ready = false, lost = false, nextId = 1;
		const calls = new Map();
		const lose = (message) => { if (lost) return; lost = true; worker.terminate(); failAll(message); onLost(); };
		try { worker = new Worker(new URL("./network-worker.js", import.meta.url), { type: "module" }); } catch (error) { reject(infraFailure(String(error?.message ?? error))); return; }
		const failAll = (message) => { for (const call of calls.values()) call.reject(new Error(message)); calls.clear(); };
		worker.onerror = (event) => {
			event.preventDefault?.();
			if (!ready) { worker.terminate(); reject(infraFailure(event.message || "the poser worker failed to start")); } else lose(event.message || "the poser worker stopped");
		};
		worker.onmessage = ({ data }) => {
			if (data.type === "progress") onProgress(data.done, data.total);
			else if (data.type === "ready") {
				ready = true;
				resolve({
					info: { ...data.info, worker: true },
					// a run that never answers (a stuck or dead worker) fails after RUN_TIMEOUT_MS and the worker is replaced
					run: (inputs) => new Promise((res, rej) => {
						if (lost) { rej(new Error("the pose network stopped")); return; }
						const id = nextId++, timer = setTimeout(() => { calls.delete(id); rej(new Error("the pose network did not answer")); lose("the pose network did not answer"); }, RUN_TIMEOUT_MS);
						calls.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
						worker.postMessage({ type: "run", id, inputs });
					}),
					release: () => { lost = true; failAll("released"); worker.terminate(); },
				});
			} else if (data.type === "failed") {
				worker.terminate();
				reject(data.code ? new PoserModelError(data.code, data.message) : infraFailure(data.message));
			} else if (data.type === "result" || data.type === "error") {
				const call = calls.get(data.id);
				calls.delete(data.id);
				if (data.type === "result") call?.resolve({ draft: data.draft, rot6d: data.rot6d });
				else call?.reject(new Error(data.message));
			}
		};
		worker.postMessage({ type: "load" });
	});
}

async function mainThreadNetwork(onProgress) {
	const { createWebNetwork } = await import("../ort-web.js");
	const network = await createWebNetwork({ onProgress });
	network.info = { ...network.info, worker: false };
	return network;
}

/**
 * The shared poser network: resolves once loaded (cached by Cache Storage across visits), rejects with a
 * PoserModelError (`code`: offline, stalled, http, checksum, no-crypto) or a runtime error. A failed load can be retried.
 * A build that does not ship the model rejects with code "unavailable" at once: no request, nothing to retry.
 */
export function ensurePoserNetwork({ worker = true } = {}) {
	if (!POSER_MODEL.bundled) {
		updatePoserState({ model: { status: "unavailable", progress: 0, code: "unavailable" } });
		return Promise.reject(new PoserModelError("unavailable", "this build does not include the Auto Pose model"));
	}
	if (pending) return pending;
	let shown = -1;
	const onProgress = (done, total) => {
		const progress = total ? Math.min(1, done / total) : 0;
		if (Math.round(progress * 100) === shown) return;
		shown = Math.round(progress * 100);
		updatePoserState({ model: { status: "loading", progress } });
	};
	updatePoserState({ model: { status: "loading", progress: 0 } });
	const useWorker = worker && typeof Worker !== "undefined";
	// a lost worker reloads the network if its load is still the current one; the panel shows Loading, then Ready
	const onLost = () => { if (current === mine) { pending = null; ensurePoserNetwork({ worker }).catch(() => {}); } };
	const load = useWorker ? workerNetwork(onProgress, onLost).catch((error) => { if (!error?.workerFailed) throw error; return mainThreadNetwork(onProgress); }) : mainThreadNetwork(onProgress);
	const mine = load.then((network) => {
		shared.info = network.info;
		updatePoserState({ model: { status: "ready", progress: 1, info: network.info } });
		return network;
	}, (error) => {
		if (current === mine) { pending = null; current = null; }
		updatePoserState({ model: { status: "failed", progress: 0, code: error?.code ?? "error", message: String(error?.message ?? error) } });
		throw error;
	});
	current = mine;
	pending = mine.then(() => shared);
	return pending;
}
