import { AsyncLocalStorage } from "node:async_hooks";
import * as defaultAuth from "../codex-auth.mjs";
import * as defaultKeys from "./provider-keys.mjs";
import { createCredentialStore } from "./credential-store.mjs";
import { readCredentials } from "./provider-keys.mjs";
import { cliproxyBase, cliproxyProvider, extendCliproxyProvider, registryLiveCliproxy } from "./cliproxy-provider.mjs";
export { cliproxyLiveModel } from "./cliproxy-provider.mjs";
import { OPENAI_COMPATIBLE_ID, endpointClass, openaiCompatibleProvider, refreshOpenAICompatible } from "./openai-compatible-provider.mjs";
import { rolesByMain } from "./model-roles.mjs";
export { MODEL_ROLES, fallbackChain, resolveRoleModels } from "./model-roles.mjs";

// #379 (F2 pass 5 finding 4): pi never forwards a per-request `fetch` to the
// codex API module — `pi-agent-core`'s `createRequestOptions` (the options
// object every harness call actually sends) whitelists a fixed field list
// that does not include `fetch`, and `pi-ai`'s `Models#applyAuth` only adds
// `apiKey`/`headers`/`env` on top of it — so `openai-codex-responses.js`'s
// `options?.fetch ?? globalThis.fetch` always falls through to the global
// fetch for every codex call the harness makes. Wrapping `globalThis.fetch`
// once, scoped to codex's own `/codex/responses` endpoint, is therefore the
// only seam that sees the Response the instant its headers exist (fetch's
// promise resolves on the response line/headers, well before the SSE body is
// read) — proved against the real codex API module with a stub HTTP server
// (task-16k evidence). `AsyncLocalStorage` correlates each response back to
// the ONE runner call that triggered it: Node's async context propagates
// through the promise chain pi awaits internally, with no extra plumbing.
export const codexResponseObserver = new AsyncLocalStorage();
let codexFetchPatched = false;
function ensureCodexFetchPatched() {
	if (codexFetchPatched) return;
	codexFetchPatched = true;
	const realFetch = globalThis.fetch;
	// #379 (F2 pass 6 finding 3): the URL used for observation-scoping must be
	// derived defensively and entirely inside an isolated try — reading an
	// unrelated `url` property (or anything else about `input`) must never be
	// able to turn a successful fetch into a rejection, and only the codex
	// responses endpoint's exact pathname (`/codex/responses`, per pi-ai's own
	// `resolveCodexUrl`) is observed, never a substring match anywhere in the
	// URL (e.g. a query string or a sibling path with a shared prefix).
	globalThis.fetch = async (input, init) => {
		const response = await realFetch(input, init);
		try {
			const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : typeof input === "string" ? input : "";
			const { pathname } = new URL(raw, "http://local");
			// pi-ai's `resolveCodexUrl` (openai-codex-responses.js) always produces a
			// URL whose path ends in exactly "/codex/responses", regardless of the
			// configured base URL (e.g. the default base's "/backend-api" prefix, or
			// none at all in tests) — so matching that literal path segment suffix
			// is exact for the codex endpoint and cannot match a sibling path like
			// "/codex/responses-backup" (whose trailing characters differ).
			if (pathname.endsWith("/codex/responses")) {
				const onResponse = codexResponseObserver.getStore();
				// The runner's own listener must never affect the real request/response
				// it is only observing.
				if (onResponse) onResponse({ status: response.status, headers: Object.fromEntries(response.headers.entries()) });
			}
		} catch { /* URL derivation or observer errors never affect the returned Response */ }
		return response;
	};
}

export const PROVIDERS = [
	{ id: "openai-codex", label: "ChatGPT (OpenAI Codex)", auth: "chatgpt-oauth", env: [] },
	{ id: "anthropic", label: "Anthropic", auth: "api_key", env: ["ANTHROPIC_API_KEY"] },
	// #claude-subscription: Claude Pro/Max OAuth sign-in; requests run through the official
	// Claude Code binary (anthropic-subscription.mjs), never against the API with a raw token.
	{ id: "anthropic-subscription", label: "Claude (Anthropic)", auth: "oauth", env: [] },
	{ id: "openai", label: "OpenAI", auth: "api_key", env: ["OPENAI_API_KEY"] },
	{ id: "google", label: "Google Gemini", auth: "api_key", env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
	{ id: "minimax", label: "MiniMax", auth: "api_key", env: ["MINIMAX_API_KEY"] }, { id: "minimax-cn", label: "MiniMax (China)", auth: "api_key", env: ["MINIMAX_CN_API_KEY"] },
	{ id: "openrouter", label: "OpenRouter", auth: "api_key", env: ["OPENROUTER_API_KEY"] },
	{ id: "cliproxy", label: "CLIProxyAPI", auth: "api_key", env: ["CLIPROXY_API_KEY"] },
	// #885: LM Studio, Ollama or any OpenAI-compatible server; its address rides the stored credential
	{ id: OPENAI_COMPATIBLE_ID, label: "OpenAI-compatible server", auth: "api_key", env: [] },
];

const factories = {
	"openai-codex": "openaiCodexProvider", openai: "openaiProvider", google: "googleProvider", minimax: "minimaxProvider", "minimax-cn": "minimaxCnProvider",
	openrouter: "openrouterProvider",
};

const providerConfig = (id) => PROVIDERS.find((provider) => provider.id === id);

export async function loadProvider(id, { baseUrl, env = process.env } = {}) {
	if (!providerConfig(id)) throw Object.assign(new Error(`Unknown provider: ${id}`), { code: "UNKNOWN_PROVIDER" });
	if (id === "openai-codex") ensureCodexFetchPatched();
	// Both Anthropic lanes come from CozyClay's own module: the subscription lane, and pi-ai's
	// API-key lane minus the OAuth login it also advertises (see anthropicLaneProvider).
	const provider = id === "cliproxy"
		? await cliproxyProvider({ baseUrl, env })
		: id === OPENAI_COMPATIBLE_ID ? await openaiCompatibleProvider() : id === "anthropic" || id === "anthropic-subscription"
			? await import("./anthropic-subscription.mjs").then((module) => module.anthropicLaneProvider(id))
			: await import(`@earendil-works/pi-ai/providers/${id}`).then((module) => module[factories[id]]());
	// pi 0.99 gave the API-key OpenAI lane a ChatGPT sign-in too; CozyClay's ChatGPT sign-in is the
	// openai-codex lane, so the panel keeps showing one ChatGPT button.
	if (id === "openai") provider.auth = { ...provider.auth, oauth: undefined };
	if (baseUrl && id !== "cliproxy") {
		provider.baseUrl = baseUrl;
		const getModels = provider.getModels.bind(provider);
		provider.getModels = () => getModels().map((model) => ({ ...model, baseUrl }));
	}
	return provider;
}

const PI_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const piEffort = (level) => level === "none" ? "off" : level === "ultra" ? "max" : level;
const wireEffort = (level) => (level === "off" ? "none" : level);

const registryCatalogueState = new WeakMap();
function catalogueState(models) {
	let state = registryCatalogueState.get(models);
	if (!state) {
		state = { fetch: null, models: [], extendedProviders: new WeakSet(), cliproxyFetch: null, cliproxyFetchError: null };
		registryCatalogueState.set(models, state);
	}
	return state;
}
function livePiModel(model, template) {
	const supported = new Set(model.efforts.map(piEffort));
	// map values are what goes on the wire: pi sends a model's off mapping, and Codex calls it "none"
	const thinkingLevelMap = Object.fromEntries(PI_EFFORT_LEVELS.map((level) => [level, supported.has(level) ? wireEffort(level) : null]));
	return { ...template, id: model.id, name: model.label, thinkingLevelMap };
}

function extendCodexProvider(provider, liveModels, state) {
	if (!liveModels.length || state.extendedProviders.has(provider)) return false;
	const getModels = provider.getModels.bind(provider);
	const knownModels = getModels();
	const known = new Set(knownModels.map((model) => model.id));
	const template = knownModels.find((model) => Array.isArray(model.input) && model.input.includes("text") && model.input.includes("image")) || knownModels[0];
	if (!template) return false;
	const additions = liveModels.filter((model) => !known.has(model.id)).map((model) => livePiModel(model, template));
	if (!additions.length) return false;
	provider.getModels = () => [...getModels(), ...additions];
	state.extendedProviders.add(provider);
	return true;
}

async function registryLiveCatalogue(models, codex) {
	const state = catalogueState(models);
	if (!state.fetch) {
		state.fetch = Promise.resolve().then(() => codex.listModels()).then((result) => {
			state.models = liveModelsCodex(result);
			return state.models;
		}).catch(() => { state.fetch = null; return []; });
	}
	return state.fetch;
}

async function registerLiveCodexModels(models, codex) {
	if (!codex?.listModels) return [];
	const state = catalogueState(models);
	const live = await registryLiveCatalogue(models, codex);
	const provider = models?.getProvider?.("openai-codex");
	if (provider && typeof models.setProvider === "function") {
		if (extendCodexProvider(provider, live, state)) models.setProvider(provider);
		return [];
	}
	return live;
}

export async function createModels({ credentials, auth = defaultAuth, keys = defaultKeys, env = process.env, codexBaseUrl, cliproxyBaseUrl } = {}) {
	const { createModels: createPiModels } = await import("@earendil-works/pi-ai");
	const store = credentials ?? createCredentialStore({ auth, keys, env });
	const models = createPiModels({ credentials: store });
	for (const provider of PROVIDERS) {
		const baseUrl = provider.id === "openai-codex" ? codexBaseUrl : provider.id === "cliproxy" ? cliproxyBaseUrl ?? cliproxyBase({ env, credential: await store.read("cliproxy").catch(() => undefined) }) : undefined;
		models.setProvider(await loadProvider(provider.id, { baseUrl, env }));
	}
	// every other provider pi ships, so each of pi's logins (subscriptions and api keys) has a provider to land on (#pi-login)
	const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
	for (const provider of builtinProviders()) if (!models.getProvider(provider.id)) models.setProvider(provider);
	return models;
}

export async function resolveModel(requested, options = {}) {
	if (typeof requested !== "string" || !requested.trim()) throw unknownModel(requested);
	const value = requested.trim();
	const slash = value.indexOf("/");
	const provider = slash === -1 ? "openai-codex" : value.slice(0, slash);
	const modelId = slash === -1 ? value : value.slice(slash + 1);
	if (!modelId) throw unknownModel(requested);
	const models = options.models ?? await createModels(options);
	if (!providerConfig(provider) && !models.getProvider?.(provider)) throw unknownModel(requested);
	// a custom server's models are its live /v1/models list, read again when a turn names one not listed yet (#885)
	if (provider === OPENAI_COMPATIBLE_ID && !models.getModel(provider, modelId)) await refreshOpenAICompatible(models);
	const model = models.getModel(provider, modelId);
	if (!model) throw unknownModel(requested);
	return { provider, modelId, model };
}

/** Wire effort (frozen vocabulary) → pi `ModelThinkingLevel`, clamped to what
 * this model actually supports: "none"→"off" (pi's own "no reasoning" level,
 * never clamped up — a model that lacks "off" in its `thinkingLevelMap` still
 * gets "off"; clamping it to the lowest *supported* level would silently turn
 * "no reasoning requested" into "some reasoning requested"), "ultra"→"max"
 * (pi has no "ultra" level) then clamped down like any other level. */
export async function resolveEffort(model, effort) {
	const { clampThinkingLevel } = await import("@earendil-works/pi-ai");
	const level = piEffort(effort);
	return level === "off" ? "off" : clampThinkingLevel(model, level);
}

function unknownModel(requested) {
	return Object.assign(new Error(`Unknown model: ${requested}`), { code: "UNKNOWN_MODEL" });
}

// Shared between the legacy provider-status route and the models registry
// below: the label a signed-in provider surfaces ("env", "file", "chatgpt")
// comes from CozyClay's own stored credentials, never from pi's free-form
// `AuthResult.source` string.
function resolveAuthSource(provider, { auth, saved, env }) {
	if (provider.id === "openai-codex") {
		const raw = typeof auth.readStored === "function" ? auth.readStored() : undefined;
		const signedIn = auth.status ? !!auth.status().signedIn : !!raw?.refresh_token;
		return signedIn ? "chatgpt" : null;
	}
	const envName = provider.env.find((name) => typeof env[name] === "string" && env[name].trim());
	return envName ? "env" : saved[provider.id] ? "file" : null;
}

export function providerStatus({ auth = defaultAuth, keys = defaultKeys, env = process.env } = {}) {
	// a stored API key (keys file) and an OAuth sign-in such as a subscription (auth.json) both count
	const saved = { ...keys.readKeys(), ...readCredentials() };
	return PROVIDERS.map((provider) => {
		const authSource = resolveAuthSource(provider, { auth, saved, env });
		return { id: provider.id, label: provider.label, authSource, signedIn: !!authSource };
	});
}

// The wire vocabulary the panel and turn route speak (frozen, #379): pi's
// ModelThinkingLevel ("off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max")
// plus "none" (off's wire name) and "ultra" (accepted on input only, clamped
// to "max" — no model ever advertises it as a supported effort).
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function effortsFor(levels) {
	const efforts = levels.map(wireEffort);
	const defaultEffort = efforts.includes("medium") ? "medium" : (efforts[0] ?? "none");
	return { efforts, defaultEffort };
}

/** One provider's pi catalog, filtered to chat models that take both text and
 * image input and shaped for the panel: key-addressed, effort levels in the
 * frozen wire vocabulary. */
function catalogModels(models, providerId, getSupportedThinkingLevels) {
	return models.getModels(providerId)
		.filter((model) => Array.isArray(model.input) && model.input.includes("text") && model.input.includes("image"))
		.map((model) => {
			const { efforts, defaultEffort } = effortsFor(getSupportedThinkingLevels(model));
			return { id: model.id, key: `${providerId}/${model.id}`, label: model.name ?? model.id, efforts, defaultEffort, input: ["text", "image"] };
		});
}

/** Codex's live `/models` list, in the same shape as `catalogModels`. Used
 * only to add models the pi catalogue does not (yet) know about. */
function liveModelsCodex(result) {
	const list = Array.isArray(result) ? result : result?.models ?? [];
	return list.map((model) => {
		const id = typeof model === "string" ? model : model.slug || model.id;
		const levels = (Array.isArray(model.supported_reasoning_levels)
			? model.supported_reasoning_levels.map((level) => (typeof level === "string" ? level : level.effort)).filter(Boolean).filter((level) => level !== "ultra").map(wireEffort)
			: []);
		const efforts = levels.length ? levels : ["none"];
		const requestedDefault = typeof model.default_reasoning_level === "string" ? wireEffort(model.default_reasoning_level) : undefined;
		const defaultEffort = efforts.includes("medium") ? "medium" : (efforts.includes(requestedDefault) ? requestedDefault : efforts[0]);
		return { id, key: `openai-codex/${id}`, label: id, efforts, defaultEffort, input: ["text", "image"] };
	}).filter((model) => model.id);
}

const astraFirst = (a, b) => Number(b.id === "gpt-6-astra") - Number(a.id === "gpt-6-astra");
const cliproxyFirst = (a, b) => astraFirst(a, b) || Number(b.id === "claude-fable-5-1") - Number(a.id === "claude-fable-5-1");

/**
 * `/agent/models`, built on the pi provider registry (#379): every provider
 * signed in or not, each with its sign-in state and its chat models shaped
 * for the panel. `models` may be injected (already-built pi `Models`, or a
 * test double exposing `getModels`/`getAuth`) — the route builds a real one.
 */
export async function listAgentModels({ models, codex, auth = defaultAuth, keys = defaultKeys, env = process.env } = {}) {
	const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
	const resolvedModels = models ?? await createModels({ auth, keys, env });
	// a stored API key (keys file) and an OAuth sign-in such as a subscription (auth.json) both count
	const saved = { ...keys.readKeys(), ...readCredentials() };
	const providers = [];
	for (const provider of PROVIDERS) {
		const authResult = await resolvedModels.getAuth(provider.id).catch(() => undefined);
		const signedIn = authResult !== undefined;
		const authSource = resolveAuthSource(provider, { auth, saved, env });
		let list = catalogModels(resolvedModels, provider.id, getSupportedThinkingLevels);
		if (provider.id === "openai-codex") {
			if (signedIn && codex?.listModels) {
				try {
					const fallbackLive = await registerLiveCodexModels(resolvedModels, codex);
					list = catalogModels(resolvedModels, provider.id, getSupportedThinkingLevels);
					const known = new Set(list.map((model) => model.id));
					list = [...list, ...fallbackLive.filter((model) => !known.has(model.id))];
				} catch { /* the live catalog is a bonus; the static catalog still lists astra */ }
			}
			list = [...list].sort(astraFirst);
		} else if (provider.id === "cliproxy") {
			if (signedIn) {
				const live = await registryLiveCliproxy(resolvedModels, authResult?.auth?.apiKey, catalogueState(resolvedModels));
				if (live) {
					// The proxy's own /v1/models is the lineup: register what pi's catalogue has not caught up
					// with on the shared registry, so the turn route resolves the same ids the dropdown shows.
					const cliproxy = resolvedModels.getProvider?.("cliproxy");
					if (cliproxy && typeof resolvedModels.setProvider === "function" && extendCliproxyProvider(cliproxy, live, catalogueState(resolvedModels))) resolvedModels.setProvider(cliproxy);
					list = catalogModels(resolvedModels, provider.id, getSupportedThinkingLevels).filter((model) => live.has(model.id));
				}
			}
			list = [...list].sort(cliproxyFirst);
			const error = catalogueState(resolvedModels).cliproxyFetchError; providers.push({ id: provider.id, label: provider.label, signedIn, authSource, models: list, ...(error ? { error } : {}) }); continue;
		} else if (provider.id === OPENAI_COMPATIBLE_ID && signedIn) {
			// the server's own /v1/models is the lineup, read on every listing so a model loaded since then shows up
			const error = await refreshOpenAICompatible(resolvedModels);
			// the address's class (local, lan, hosted), never the address: agent:prompt_sent splits this lane by it (#1043)
			providers.push({ id: provider.id, label: provider.label, signedIn, authSource, endpoint: endpointClass(resolvedModels.getModels(provider.id)[0]?.baseUrl), models: catalogModels(resolvedModels, provider.id, getSupportedThinkingLevels), ...(error ? { error } : {}) }); continue;
		}
		providers.push({ id: provider.id, label: provider.label, signedIn, authSource, models: list });
	}
	// a provider outside the curated list joins the picker once a pi login stored its credential here (#pi-login); ambient
	// credentials (an AWS profile, cloud ADC files) alone do not list it, so the picker shows what the author connected
	for (const provider of resolvedModels.getProviders?.() ?? []) {
		const check = providerConfig(provider.id) || !(provider.id in saved) ? undefined : await resolvedModels.checkAuth?.(provider.id).catch(() => undefined);
		if (check) providers.push({ id: provider.id, label: provider.name ?? provider.id, signedIn: true, authSource: check.type === "oauth" || /stored/i.test(check.source ?? "") ? "file" : "env", models: catalogModels(resolvedModels, provider.id, getSupportedThinkingLevels) });
	}
	// The flat union is what the panel's dropdown reads today (`models[].id`);
	// with several providers in play the id has to be the provider/id key so two
	// providers' same-named model never collide there, while each provider's
	// own `models[]` keeps the bare id.
	return {
		providers,
		models: providers.flatMap((provider) => provider.models.map((model) => ({ ...model, id: model.key }))),
		roles: rolesByMain({ providers }),
	};
}
