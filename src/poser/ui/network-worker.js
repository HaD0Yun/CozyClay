// Module worker that hosts the poser network (onnxruntime-web WASM) off the main thread, so pointer handling and
// drawing stay responsive while a solve runs. Messages in: { type: "load" }, { type: "run", id, inputs }.
// Messages out: progress, ready (with info), failed (with code), result, error.
import { createWebNetwork } from "../ort-web.js";

let network = null;

self.onmessage = async ({ data }) => {
	if (data.type === "load") {
		try {
			let last = 0;
			network = await createWebNetwork({
				onProgress: (done, total) => {
					const now = performance.now();
					if (now - last > 100 || done === total) { last = now; self.postMessage({ type: "progress", done, total }); }
				},
			});
			self.postMessage({ type: "ready", info: network.info });
		} catch (error) {
			self.postMessage({ type: "failed", code: error?.code ?? null, message: String(error?.message ?? error) });
		}
		return;
	}
	if (data.type === "run") {
		try {
			const out = await network.run(data.inputs);
			self.postMessage({ type: "result", id: data.id, draft: out.draft, rot6d: out.rot6d }, [out.draft.buffer, out.rot6d.buffer]);
		} catch (error) {
			self.postMessage({ type: "error", id: data.id, message: String(error?.message ?? error) });
		}
	}
};
