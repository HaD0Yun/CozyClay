// Codex image/model client: a zero-dependency Node 20+ module that talks to
// the ChatGPT Codex backend with a ChatGPT OAuth bearer.

const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
// The client version the model list is asked for: the backend leaves out a model whose minimal client version is newer.
const CLIENT_VERSION = "0.172.0";

function defaultSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalizes missing/absent header values. */
function readHeader(headersLike, name) {
	if (!headersLike) return undefined;
	if (typeof headersLike.get === "function") {
		const value = headersLike.get(name);
		return value === null ? undefined : value;
	}
	return headersLike[name];
}

function toNumber(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function toFlag(value) {
	if (value === undefined) return false;
	return String(value).trim().toLowerCase() === "true";
}

/** Width/height from a PNG IHDR chunk: bytes 16..24, big-endian. */
function pngDimensions(base64) {
	const buffer = Buffer.from(base64, "base64");
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function createCodexClient({
	getAccessToken,
	getAccountId,
	fetch = globalThis.fetch,
	originator = "cozyclay",
	sleep = defaultSleep,
}) {
	// The account allows ~1 concurrent request: chain every backend request so
	// at most one is in flight, regardless of how callers interleave calls.
	let chain = Promise.resolve();
	function enqueue(task) {
		const run = chain.then(task);
		chain = run.then(() => {}, () => {});
		return run;
	}

	async function requestHeaders(extra = {}) {
		const [accessToken, accountId] = await Promise.all([getAccessToken(), getAccountId()]);
		return {
			authorization: `Bearer ${accessToken}`,
			"chatgpt-account-id": accountId,
			originator,
			"openai-beta": "responses=experimental",
			...extra,
		};
	}

	/** POST/GET with 429 Retry-After backoff; returns the final Response. */
	async function fetchWithRetry(url, init) {
		while (true) {
			const response = await fetch(url, init);
			if (response.status === 429) {
				const retryAfter = toNumber(response.headers.get("retry-after")) ?? 5;
				await sleep(retryAfter * 1000);
				continue;
			}
			if (!response.ok) {
				const detail = await response.text();
				const error = new Error(`codex request failed (${response.status}): ${detail}`);
				error.status = response.status;
				if (response.status === 401) error.code = "unauthorized";
				throw error;
			}
			return response;
		}
	}

	function postJson(path, body, signal) {
		return enqueue(async () =>
			fetchWithRetry(`${CODEX_BASE}${path}`, {
				method: "POST",
				headers: await requestHeaders({ "content-type": "application/json" }),
				body: JSON.stringify(body),
				signal,
			}));
	}

	async function editImage({ prompt, imageDataUrl, referenceDataUrl, extraImages = [], quality = "auto", size, signal }) {
		const images = [imageDataUrl, referenceDataUrl, ...(Array.isArray(extraImages) ? extraImages : [])]
			.filter((value) => typeof value === "string" && value);
		const response = await postJson("/images/edits", {
			model: "gpt-image-2",
			prompt,
			images: images.map((image_url) => ({ image_url })),
			quality,
			...(size ? { size } : {}),
		}, signal);
		const payload = await response.json();
		const pngBase64 = payload.data[0].b64_json;
		return { pngBase64, ...pngDimensions(pngBase64), headers: response.headers };
	}

	async function generateImage({ prompt, quality = "auto", signal }) {
		const response = await postJson("/images/generations", {
			model: "gpt-image-2",
			prompt,
			quality,
		}, signal);
		const payload = await response.json();
		const pngBase64 = payload.data[0].b64_json;
		return { pngBase64, ...pngDimensions(pngBase64), headers: response.headers };
	}

	async function listModels() {
		const response = await enqueue(async () => fetchWithRetry(`${CODEX_BASE}/models?client_version=${CLIENT_VERSION}`, {
			headers: await requestHeaders(),
		}));
		return response.json();
	}

	function parseQuotaHeaders(headersLike) {
		return {
			planType: readHeader(headersLike, "x-codex-plan-type"),
			primary: {
				usedPercent: toNumber(readHeader(headersLike, "x-codex-primary-used-percent")),
				windowMinutes: toNumber(readHeader(headersLike, "x-codex-primary-window-minutes")),
				resetAfterSeconds: toNumber(readHeader(headersLike, "x-codex-primary-reset-after-seconds")),
				resetAt: readHeader(headersLike, "x-codex-primary-reset-at"),
			},
			secondary: {
				usedPercent: toNumber(readHeader(headersLike, "x-codex-secondary-used-percent")),
				windowMinutes: toNumber(readHeader(headersLike, "x-codex-secondary-window-minutes")),
				resetAfterSeconds: toNumber(readHeader(headersLike, "x-codex-secondary-reset-after-seconds")),
				resetAt: readHeader(headersLike, "x-codex-secondary-reset-at"),
			},
			credits: {
				balance: toNumber(readHeader(headersLike, "x-codex-credits-balance")),
				hasCredits: toFlag(readHeader(headersLike, "x-codex-credits-has-credits")),
				unlimited: toFlag(readHeader(headersLike, "x-codex-credits-unlimited")),
			},
		};
	}

	return { editImage, generateImage, listModels, parseQuotaHeaders };
}
