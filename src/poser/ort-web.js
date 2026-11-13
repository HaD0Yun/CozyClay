// Browser backend: onnxruntime-web on the WASM execution provider, imported lazily on first use. Without cross-origin
// isolation the WASM runtime is single-threaded.
import { POSER_MODEL } from "./config.js";
import { loadModelBytes } from "./model-source.js";
import { sessionNetwork } from "./network.js";

/**
 * `model`: `{ url, sha256, bytes, cacheName }` (default config.js); `wasmPaths`: where ORT finds its .wasm files when
 * the bundler cannot resolve them; `source`: injectables for model-source.js. The returned network carries `info`
 * (`source`, `cached`, `threads`, `downloadMs`, `sessionMs`).
 */
export async function createWebNetwork({ model = POSER_MODEL, wasmPaths, threads, source = {}, onProgress } = {}) {
	const started = performance.now();
	const ort = await import("onnxruntime-web/wasm");
	if (wasmPaths) ort.env.wasm.wasmPaths = wasmPaths;
	ort.env.wasm.numThreads = threads ?? (globalThis.crossOriginIsolated ? Math.min(4, globalThis.navigator?.hardwareConcurrency || 1) : 1);
	const loaded = await loadModelBytes(model, { ...source, onProgress });
	const fetched = performance.now();
	const session = await ort.InferenceSession.create(loaded.bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
	const network = sessionNetwork(session, ort.Tensor);
	network.info = { source: loaded.source, cached: loaded.cached, threads: ort.env.wasm.numThreads, downloadMs: fetched - started, sessionMs: performance.now() - fetched };
	return network;
}
