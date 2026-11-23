// Which model, and through which sign-in, the lowvis motion writer (src/lowvis/pi/harness.mjs) runs for one Studio turn.
// The motion model is motion-engine.mjs motionWriter's (COZYCLAY_MOTION_MODEL, default claude-opus-5-5, at
// COZYCLAY_MOTION_EFFORT, default medium). In this order:
//   1. environment: CLIPROXY_BASE_URL and CLIPROXY_API_KEY are set and that proxy lists the motion model. The harness
//      then reads them itself, as it always did (the try-out launcher and the bench set them): an override.
//   2. sign-in: the Studio's own sign-ins, on the registry the Studio agent's turns use (providers.mjs createModels:
//      its credential store, its transport). The motion model on the turn's provider first, then on any other provider
//      signed in that offers it (a CLIProxyAPI sign-in: when its proxy lists the model).
//   3. session model: none offers the motion model, so the model the turn runs on writes the motion, at the motion
//      effort clamped to the levels that model takes. Nothing here is written for one model.
// null: no sign-in can run a writer (the session then has no motion tool; studio-prompt-lowvis.mjs says what to do).
// A sign-in whose catalogue lists the motion model may still refuse it for the account (not found, not permitted, not
// on the plan). A route of step 2 therefore carries the step after it: refuse() remembers the refusal for the
// conversation and answers the route of step 3, which says who refused what; instead() answers that route once a
// refusal is remembered, so a later motion of the conversation does not ask the refused model again (motion-run.mjs).
import { cleanBase, cliproxyBase, fetchModelList } from "./cliproxy-provider.mjs";
import { motionWriter } from "./motion-engine.mjs";

// agent-runner.mjs classifyError sorts a failed request into codes. No code of that vocabulary says "this account may not use this model": a 404 reads there as upstream, a 403 as
// unauthorized beside an expired sign-in's 401. modelRefused is that one class, for a caller that has another model to go
// on with (motion-run.mjs): the provider answered for the model, not for the credential, the rate, itself or the network.
// A 404; or, with a 403, another 4xx or no status, an error type or words that say the model is not there, not
// supported or not allowed for the account; or a 403 that does not speak of the credential.
const CREDENTIAL_WORDS = /authenticat|api.?key|token|expired|sign.?in|log.?in/i;
const MODEL_REFUSED_WORDS = /model_not_found|not_found_error|permission_error|permission_denied|model\b[\s\S]{0,120}?\b(?:not exist|not found|not supported|not available|not allowed|no access|not have access)/i;
/** Whether a failed request's error ({ message, status? }) says the account may not use the model the request named. */
export async function modelRefused(error) {
	const message = typeof error?.message === "string" ? error.message : "", { code, status } = (await import("./agent-runner.mjs")).classifyError(error);
	if (code === "rate_limit" || code === "overloaded" || code === "network" || status === 401 || status >= 500) return false;
	return status === 404 || MODEL_REFUSED_WORDS.test(message) || (status === 403 && !CREDENTIAL_WORDS.test(message));
}

const LISTED_MS = 60_000;
const DEFAULT_MODEL = "gpt-6-astra"; // the model a turn that names none runs on (agent-runner.mjs DEFAULT_MODEL)
const listed = new Map(); // "<v1 base> <model id>" -> { at, ok }: a proxy's model list, asked once a minute
const refusals = new Set(); // "<conversation> <provider>/<model>": the sign-in refused the model for the account

/** Whether the proxy at v1Base with apiKey lists the model id; the answer is kept for a minute. */
async function proxyLists(v1Base, apiKey, id) {
	const key = `${v1Base} ${id}`, known = listed.get(key);
	if (known && Date.now() - known.at < LISTED_MS) return known.ok;
	let ok;
	try { ok = (await fetchModelList(v1Base, apiKey, "CLIProxyAPI")).some(entry => (typeof entry === "string" ? entry : entry?.id) === id); } catch { ok = false; }
	listed.set(key, { at: Date.now(), ok });
	return ok;
}

/** Whether the environment's CLIProxyAPI (CLIPROXY_BASE_URL and CLIPROXY_API_KEY, which the harness reads) lists the motion model; a value that is no address: false. */
async function environmentServes(env) {
	if (!env?.CLIPROXY_BASE_URL || !env?.CLIPROXY_API_KEY) return false;
	try { return await proxyLists(`${cliproxyBase({ env })}/v1`, env.CLIPROXY_API_KEY, motionWriter(env).model); } catch { return false; }
}

/** "<provider>/<model> at <effort>, <how>": how the answer and the direct key name the writer of a motion. */
const labelOf = route => `${route.provider}/${route.model} at ${route.effort}, ${route.via === "environment" ? "through CLIPROXY_BASE_URL" : route.via === "sign-in" ? "through the Studio's sign-in" : `the model of this session (${route.refused ? `the ${route.refused.provider} sign-in refused ${route.refused.model}` : `the sign-ins offer no ${route.motionModel}`})`}`;

/**
 * writerRoute({ env, models, picked, session }) -> the motion writer's route, or null.
 * models: the Studio's provider registry (or an async function answering it). picked: the turn's model key
 * ("<provider>/<id>", a bare id is ChatGPT's). session false: no fallback to the turn's model (the direct key).
 * conversation: the key refusals are remembered under (none: not remembered).
 * A route: { via, provider, model, effort, label }; via "sign-in" and "session model" add { models, piModel, secrets }
 * (the registry, the pi model and the values the run record scrubs). A "sign-in" route with a session to fall back to
 * adds refuse() and instead() (file header); the "session model" route they answer adds refused: { provider, model }.
 */
export async function writerRoute({ env = process.env, models = null, picked = null, session = true, conversation = null } = {}) {
	const { model: motionModel, effort } = motionWriter(env);
	const route = extra => { const r = { motionModel, effort, ...extra }; return { ...r, label: labelOf(r) }; };
	if (await environmentServes(env)) return route({ via: "environment", provider: "cliproxy", model: motionModel });
	if (!models) return null;
	const registry = typeof models === "function" ? await models() : models;
	const [{ PROVIDERS, resolveModel }, { readKeys, readCredentials }, { clampThinkingLevel }] = await Promise.all([import("./providers.mjs"), import("./provider-keys.mjs"), import("@earendil-works/pi-ai")]);
	// the providers a sign-in can stand for: the curated list and any other one a pi login stored (as listAgentModels lists them)
	const signable = new Set([...PROVIDERS.map(provider => provider.id), ...Object.keys(readKeys()), ...Object.keys(readCredentials())]);
	const key = picked || DEFAULT_MODEL, slash = key.indexOf("/"), turnProvider = slash === -1 ? "openai-codex" : key.slice(0, slash);
	const authOf = async provider => (signable.has(provider) ? registry.getAuth(provider).catch(() => undefined) : undefined);
	// what the run record and the messages of a failed run scrub, for any provider: the credential (key, headers), the
	// values its sign-in stored with it (a server's address), the address the model is asked at and that address's host
	const secretsOf = (auth, piModel) => {
		let host = null;
		try { host = new URL(piModel?.baseUrl).host; } catch { /* a model without an address */ }
		return [...new Set([auth?.auth?.apiKey, ...Object.values(auth?.auth?.headers ?? {}), ...Object.values(auth?.env ?? {}), piModel?.baseUrl, host])].filter(value => typeof value === "string" && value.length >= 8).sort((a, b) => b.length - a.length);
	};
	// step 3, the model the turn runs on; refused: the sign-in of step 2 that refused the motion model, when one did
	const sessionRoute = async (refused = null) => {
		if (!session || !signable.has(turnProvider)) return null;
		const auth = await authOf(turnProvider);
		const chosen = auth ? await resolveModel(key, { models: registry }).catch(() => null) : null;
		if (!chosen || (refused && chosen.provider === refused.provider && chosen.modelId === refused.model)) return null; // the refused model itself is no other one to write on
		return route({ via: "session model", provider: chosen.provider, model: chosen.modelId, effort: clampThinkingLevel(chosen.model, effort), models: registry, piModel: chosen.model, secrets: secretsOf(auth, chosen.model), ...(refused ? { refused } : {}) });
	};
	for (const provider of new Set([turnProvider, ...signable])) {
		const piModel = registry.getModel?.(provider, motionModel);
		if (!piModel || clampThinkingLevel(piModel, effort) !== effort) continue;
		const auth = await authOf(provider);
		if (!auth) continue;
		if (provider === "cliproxy" && !await proxyLists(`${cleanBase(piModel.baseUrl)}/v1`, auth.auth?.apiKey, motionModel)) continue;
		const noted = `${conversation} ${provider}/${motionModel}`, refused = { provider, model: motionModel };
		const instead = () => (refusals.has(noted) ? sessionRoute(refused) : null);
		const found = route({ via: "sign-in", provider, model: motionModel, models: registry, piModel, secrets: secretsOf(auth, piModel), ...(session ? { instead, refuse: () => { if (conversation != null) refusals.add(noted); return sessionRoute(refused); } } : {}) });
		return (session && await instead()) || found;
	}
	return sessionRoute();
}
