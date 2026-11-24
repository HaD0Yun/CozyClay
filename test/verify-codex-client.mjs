#!/usr/bin/env node
// Verifies the trimmed Codex image/model client against mocked fetches.
import assert from "node:assert/strict";
import { createCodexClient } from "../bin/agent/codex-client.mjs";

function pass(label) { console.log(`PASS ${label}`); }

const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function mockFetch(script) {
	const calls = [];
	const queue = [...script];
	async function fakeFetch(url, init = {}) {
		const entry = {
			url,
			method: init.method ?? "GET",
			headers: init.headers ?? {},
			body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
		};
		calls.push(entry);
		const next = queue.shift();
		if (!next) throw new Error(`unexpected request #${calls.length}: ${entry.method} ${url}`);
		return next(entry);
	}
	fakeFetch.calls = calls;
	return fakeFetch;
}

function jsonResponse(body, headers = {}) {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

function client(fetch, sleep) {
	return createCodexClient({ getAccessToken: async () => "tok-123", getAccountId: async () => "acct-9", fetch, sleep });
}

// A requested size (the Sculpt blueprint's landscape sheet) reaches the backend; none is sent otherwise.
{
	const fetch = mockFetch([() => jsonResponse({ data: [{ b64_json: PNG_1X1_BASE64 }] })]);
	await client(fetch).editImage({ prompt: "sheet", imageDataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`, quality: "high", size: "1536x1024" });
	assert.equal(fetch.calls[0].body.size, "1536x1024");
	pass("editImage forwards a requested size");
}

// Image editing keeps the frame first, followed by the optional reference images.
{
	const fetch = mockFetch([() => jsonResponse({ data: [{ b64_json: PNG_1X1_BASE64 }] }, { "x-codex-plan-type": "plus" })]);
	const frame = `data:image/png;base64,${PNG_1X1_BASE64}`;
	const reference = "data:image/jpeg;base64,/9j/4AAQ";
	const result = await client(fetch).editImage({ prompt: "make it cozy", imageDataUrl: frame, referenceDataUrl: reference, extraImages: [frame], quality: "low" });
	const call = fetch.calls[0];
	assert.equal(call.url, "https://chatgpt.com/backend-api/codex/images/edits");
	assert.equal(call.method, "POST");
	assert.deepEqual(call.headers, { authorization: "Bearer tok-123", "chatgpt-account-id": "acct-9", originator: "cozyclay", "openai-beta": "responses=experimental", "content-type": "application/json" });
	assert.deepEqual(call.body, { model: "gpt-image-2", prompt: "make it cozy", images: [{ image_url: frame }, { image_url: reference }, { image_url: frame }], quality: "low" });
	assert.equal(result.pngBase64, PNG_1X1_BASE64);
	assert.equal(result.width, 1);
	assert.equal(result.height, 1);
	assert.equal(result.headers.get("x-codex-plan-type"), "plus");
	pass("editImage sends the image endpoint shape, headers and PNG dimensions");
}

// Image generation uses the same shared request/auth path.
{
	const fetch = mockFetch([() => jsonResponse({ data: [{ b64_json: PNG_1X1_BASE64 }] })]);
	const result = await client(fetch).generateImage({ prompt: "a clay cat", quality: "high" });
	assert.equal(fetch.calls[0].url, "https://chatgpt.com/backend-api/codex/images/generations");
	assert.deepEqual(fetch.calls[0].body, { model: "gpt-image-2", prompt: "a clay cat", quality: "high" });
	assert.equal(result.width, 1);
	assert.equal(result.height, 1);
	pass("generateImage sends the generation endpoint shape and dimensions");
}

// Models remain available for the provider catalog.
{
	const fetch = mockFetch([() => jsonResponse({ data: [{ slug: "gpt-5.1-codex", input_modalities: ["text", "image"] }] })]);
	const models = await client(fetch).listModels();
	assert.equal(fetch.calls[0].url, "https://chatgpt.com/backend-api/codex/models?client_version=0.172.0");
	assert.equal(fetch.calls[0].method, "GET");
	assert.equal(fetch.calls[0].headers.authorization, "Bearer tok-123");
	assert.equal(models.data[0].slug, "gpt-5.1-codex");
	pass("listModels sends the catalog request");
}

// Quota parsing is a pure shared helper and accepts both Headers and plain objects.
{
	const quota = client(async () => { throw new Error("no network"); }).parseQuotaHeaders({
		"x-codex-plan-type": "pro",
		"x-codex-primary-used-percent": "42.5",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-after-seconds": "1234",
		"x-codex-primary-reset-at": "2026-09-06T18:00:00Z",
		"x-codex-secondary-used-percent": "7",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-after-seconds": "600000",
		"x-codex-secondary-reset-at": "2026-09-13T00:00:00Z",
		"x-codex-credits-balance": "12.5",
		"x-codex-credits-has-credits": "True",
		"x-codex-credits-unlimited": "False",
	});
	assert.equal(quota.planType, "pro");
	assert.deepEqual(quota.primary, { usedPercent: 42.5, windowMinutes: 300, resetAfterSeconds: 1234, resetAt: "2026-09-06T18:00:00Z" });
	assert.deepEqual(quota.secondary, { usedPercent: 7, windowMinutes: 10080, resetAfterSeconds: 600000, resetAt: "2026-09-13T00:00:00Z" });
	assert.deepEqual(quota.credits, { balance: 12.5, hasCredits: true, unlimited: false });
	const empty = client(async () => { throw new Error("no network"); }).parseQuotaHeaders({});
	assert.equal(empty.planType, undefined);
	assert.equal(empty.primary.usedPercent, undefined);
	assert.equal(empty.credits.hasCredits, false);
	pass("parseQuotaHeaders converts quota numbers and booleans");
}

// Retry-After remains bounded at the client boundary, and requests stay serialized.
{
	const sleeps = [];
	const fetch = mockFetch([
		() => new Response(JSON.stringify({ detail: "rate limited" }), { status: 429, headers: { "retry-after": "6" } }),
		() => jsonResponse({ data: [{ b64_json: PNG_1X1_BASE64 }] }),
	]);
	const result = await client(fetch, async (ms) => sleeps.push(ms)).generateImage({ prompt: "retry" });
	assert.equal(result.width, 1);
	assert.deepEqual(sleeps, [6000]);
	assert.equal(fetch.calls.length, 2);
	pass("429 Retry-After is honored");
}

{
	let inFlight = 0;
	let maxInFlight = 0;
	const fetch = mockFetch([
		() => jsonResponse({ data: [{ b64_json: PNG_1X1_BASE64 }] }),
		() => jsonResponse({ data: [{ b64_json: PNG_1X1_BASE64 }] }),
	]);
	const wrappedFetch = async (url, init) => {
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return await fetch(url, init);
		} finally {
			inFlight -= 1;
		}
	};
	const codex = client(wrappedFetch);
	await Promise.all([codex.generateImage({ prompt: "one" }), codex.generateImage({ prompt: "two" })]);
	assert.equal(maxInFlight, 1);
	pass("overlapping image requests are serialized");
}

console.log("PASS test/verify-codex-client.mjs");
