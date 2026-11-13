// Auto Pose model loading with injected fetch and Cache Storage: hash check, cache reuse, typed refusals.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadModelBytes, PoserModelError } from "../../src/poser/model-source.js";

const bytes = new TextEncoder().encode("poser model stand-in ".repeat(1000));
const model = { url: "/models/test.onnx", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, cacheName: "poser-test" };

function fakeCaches({ putFails = false } = {}) {
	const store = new Map();
	return {
		store,
		open: async () => ({
			match: async (url) => (store.has(url) ? new Response(store.get(url)) : undefined),
			put: async (url, response) => { if (putFails) throw new DOMException("quota", "QuotaExceededError"); store.set(url, new Uint8Array(await response.arrayBuffer())); },
			delete: async (url) => store.delete(url),
		}),
	};
}
const serving = (body, counter = { n: 0 }) => Object.assign(async () => { counter.n += 1; return new Response(body); }, { counter });

test("downloads, checks the hash, stores in Cache Storage, then reuses the cached copy", async () => {
	const caches = fakeCaches(), fetch = serving(bytes);
	const progress = [];
	const first = await loadModelBytes(model, { fetch, caches, onProgress: (n) => progress.push(n) });
	assert.equal(first.source, "network");
	assert.equal(first.cached, true);
	assert.deepEqual(first.bytes, bytes);
	assert.equal(progress.at(-1), bytes.length);
	const second = await loadModelBytes(model, { fetch, caches });
	assert.equal(second.source, "cache");
	assert.equal(fetch.counter.n, 1, "a cache hit skips the network");
});

test("a corrupted cached copy is dropped and fetched again", async () => {
	const caches = fakeCaches(), fetch = serving(bytes);
	caches.store.set(model.url, new Uint8Array([1, 2, 3]));
	const out = await loadModelBytes(model, { fetch, caches });
	assert.equal(out.source, "network");
	assert.deepEqual(caches.store.get(model.url), bytes);
});

test("typed refusals: checksum, HTTP status, offline; nothing bad is cached", async () => {
	const caches = fakeCaches();
	await assert.rejects(loadModelBytes(model, { fetch: serving(new Uint8Array([9, 9])), caches }), (e) => e instanceof PoserModelError && e.code === "checksum");
	assert.equal(caches.store.size, 0);
	await assert.rejects(loadModelBytes(model, { fetch: async () => new Response("no", { status: 404 }), caches }), (e) => e.code === "http");
	await assert.rejects(loadModelBytes(model, { fetch: async () => { throw new TypeError("Failed to fetch"); }, caches }), (e) => e.code === "offline");
	await assert.rejects(loadModelBytes(model, { fetch: serving(bytes), caches, subtle: null }), (e) => e.code === "no-crypto");
});

test("a refused cache write (quota) still returns the verified model", async () => {
	const out = await loadModelBytes(model, { fetch: serving(bytes), caches: fakeCaches({ putFails: true }) });
	assert.equal(out.cached, false);
	assert.deepEqual(out.bytes, bytes);
	const noCaches = await loadModelBytes(model, { fetch: serving(bytes), caches: null });
	assert.equal(noCaches.source, "network");
});

test("a connection that drops mid-body is offline; one that goes silent is aborted as stalled", async () => {
	const dropping = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1000)); }, pull(c) { c.error(new TypeError("network error")); } }));
	await assert.rejects(loadModelBytes(model, { fetch: dropping, caches: null }), (e) => e instanceof PoserModelError && e.code === "offline");
	let signal = null;
	const silent = async (_url, init) => { signal = init.signal; return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1000)); }, pull: () => new Promise(() => {}) })); };
	const started = Date.now();
	await assert.rejects(loadModelBytes(model, { fetch: silent, caches: null, stallMs: 200 }), (e) => e instanceof PoserModelError && e.code === "stalled");
	assert.ok(Date.now() - started < 2000, "gives up soon after the stall limit");
	assert.equal(signal.aborted, true, "the request is aborted");
	const noHeaders = async (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
	await assert.rejects(loadModelBytes(model, { fetch: noHeaders, caches: null, stallMs: 200 }), (e) => e instanceof PoserModelError && e.code === "stalled");
});
