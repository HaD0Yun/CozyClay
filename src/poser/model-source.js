// Auto Pose model bytes: Cache Storage first, else fetch; SHA-256 checked either way. Refusals are typed
// (`PoserModelError.code`: "no-crypto", "offline", "stalled", "http", "checksum"). A connection that drops mid-body is
// "offline"; one that sends nothing for `stallMs` is aborted as "stalled". `fetch`, `caches` and `subtle` are injectable.
import { POSER_MODEL } from "./config.js";

export class PoserModelError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "PoserModelError";
		this.code = code;
	}
}

async function sha256Hex(subtle, bytes) {
	const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

// how long the download may go without a single byte before it is given up
const STALL_MS = 30000;

/** `step` with the stall clock: rejects "stalled" and calls `abort` when nothing arrives within `ms`. */
function beforeStall(step, ms, abort) {
	let timer;
	const stalled = new Promise((_, reject) => { timer = setTimeout(() => { reject(new PoserModelError("stalled", `poser model download stalled: no data for ${ms / 1000} s`)); abort(); }, ms); });
	return Promise.race([step, stalled]).finally(() => clearTimeout(timer));
}

async function readBody(response, expected, onProgress, stall) {
	if (!response.body?.getReader) return new Uint8Array(await stall(response.arrayBuffer()));
	const reader = response.body.getReader();
	let buffer = new Uint8Array(expected || 1 << 20), size = 0;
	for (;;) {
		const { done, value } = await stall(reader.read(), () => reader.cancel().catch(() => {}));
		if (done) break;
		if (size + value.length > buffer.length) { const grown = new Uint8Array(Math.max(buffer.length * 2, size + value.length)); grown.set(buffer.subarray(0, size)); buffer = grown; }
		buffer.set(value, size);
		size += value.length;
		onProgress?.(size, expected);
	}
	return size === buffer.length ? buffer : buffer.slice(0, size);
}

/**
 * Model bytes for `model` (`{ url, sha256, bytes, cacheName }`). Returns `{ bytes: Uint8Array, source: "cache" |
 * "network", cached }`; `cached` is false when Cache Storage refused the copy (quota, private mode).
 */
export async function loadModelBytes(model = POSER_MODEL, { fetch: fetchFn = globalThis.fetch, caches: cacheStorage = globalThis.caches, subtle = globalThis.crypto?.subtle, onProgress, stallMs = STALL_MS } = {}) {
	if (!subtle) throw new PoserModelError("no-crypto", "SHA-256 is unavailable (needs a secure context)");
	const cache = cacheStorage ? await Promise.resolve().then(() => cacheStorage.open(model.cacheName)).catch(() => null) : null;
	if (cache) {
		const hit = await cache.match(model.url).catch(() => null);
		if (hit) {
			const bytes = new Uint8Array(await hit.arrayBuffer());
			if ((await sha256Hex(subtle, bytes)) === model.sha256) return { bytes, source: "cache", cached: true };
			await cache.delete(model.url).catch(() => {});
		}
	}
	const abort = new AbortController(), stall = (step, cancel) => beforeStall(step, stallMs, () => { cancel?.(); abort.abort(); });
	const offline = (error) => (error instanceof PoserModelError ? error : new PoserModelError("offline", `poser model download failed: ${error?.message ?? error}`));
	let response, bytes;
	try { response = await stall(fetchFn(model.url, { signal: abort.signal })); } catch (error) { throw offline(error); }
	if (!response.ok) throw new PoserModelError("http", `poser model download failed: HTTP ${response.status}`);
	try { bytes = await readBody(response, model.bytes, onProgress, stall); } catch (error) { throw offline(error); }
	const got = await sha256Hex(subtle, bytes);
	if (got !== model.sha256) throw new PoserModelError("checksum", `poser model checksum mismatch (got ${got.slice(0, 12)}…)`);
	let cached = false;
	if (cache) {
		try { await cache.put(model.url, new Response(bytes.slice(), { headers: { "content-type": "application/octet-stream" } })); cached = true; } catch { cached = false; }
	}
	return { bytes, source: "network", cached };
}
