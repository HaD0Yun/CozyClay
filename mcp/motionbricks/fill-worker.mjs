// The MotionBricks fill on its own thread (service.mjs fillInWorker): the fill compiles the spec many times in synchronous chunks
// (seconds each on a loaded box), and on the dev server's main thread that starves the live hub's heartbeat, so the editor drops
// the connection mid-command (bench box t2F1: UNCERTAIN_APPLY after a 45.7 s fill). One request at a time; the model loads once.
import { parentPort } from "node:worker_threads";
import { fillRequest } from "./service.mjs";

parentPort.on("message", async ({ id, args }) => {
	try {
		parentPort.postMessage({ id, ok: true, value: await fillRequest(args) });
	} catch (error) {
		parentPort.postMessage({ id, ok: false, error: { message: String(error?.message ?? error), code: error?.code } });
	}
});
