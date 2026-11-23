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
import { cleanBase, cliproxyBase, fetchModelList } from "./cliproxy-provider.mjs";
import { motionWriter } from "./motion-engine.mjs";

const LISTED_MS = 60_000;
const DEFAULT_MODEL = "gpt-6-astra"; // the model a turn that names none runs on (agent-runner.mjs DEFAULT_MODEL)
const listed = new Map(); // "<v1 base> <model id>" -> { at, ok }: a proxy's model list, asked once a minute

/** Whether the proxy at v1Base with apiKey lists the model id; the answer is kept for a minute. */
async function proxyLists(v1Base, apiKey, id) {
	const key = `${v1Base} ${id}`, known = listed.get(key);
	if (known && Date.now() - known.at < LISTED_MS) return known.ok;
	let ok;
	try { ok = (await fetchModelList(v1Base, apiKey, "CLIProxyAPI")).some(entry => (typeof entry === "string" ? entry : entry?.id) === id); } catch { ok = false; }
	listed.set(key, { at: Date.now(), ok });
	return ok;
}

/** Whether the environment's CLIProxyAPI (CLIPROXY_BASE_URL and CLIPROXY_API_KEY, which the harness reads) lists the motion model. */
function environmentServes(env) {
	return env?.CLIPROXY_BASE_URL && env?.CLIPROXY_API_KEY ? proxyLists(`${cliproxyBase({ env })}/v1`, env.CLIPROXY_API_KEY, motionWriter(env).model) : Promise.resolve(false);
}

/** "<provider>/<model> at <effort>, <how>": how the answer and the direct key name the writer of a motion. */
const labelOf = route => `${route.provider}/${route.model} at ${route.effort}, ${route.via === "environment" ? "through CLIPROXY_BASE_URL" : route.via === "sign-in" ? "through the Studio's sign-in" : "the model of this session (the sign-ins offer no " + route.motionModel + ")"}`;

/**
 * writerRoute({ env, models, picked, session }) -> the motion writer's route, or null.
 * models: the Studio's provider registry (or an async function answering it). picked: the turn's model key
 * ("<provider>/<id>", a bare id is ChatGPT's). session false: no fallback to the turn's model (the direct key).
 * A route: { via, provider, model, effort, label }; via "sign-in" and "session model" add { models, piModel, secrets }
 * (the registry, the pi model and the values the run record scrubs).
 */
export async function writerRoute({ env = process.env, models = null, picked = null, session = true } = {}) {
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
	const secretsOf = auth => [auth?.auth?.apiKey, auth?.env?.CLIPROXY_BASE_URL].filter(Boolean);
	for (const provider of new Set([turnProvider, ...signable])) {
		const piModel = registry.getModel?.(provider, motionModel);
		if (!piModel || clampThinkingLevel(piModel, effort) !== effort) continue;
		const auth = await authOf(provider);
		if (!auth) continue;
		if (provider === "cliproxy" && !await proxyLists(`${cleanBase(piModel.baseUrl)}/v1`, auth.auth?.apiKey, motionModel)) continue;
		return route({ via: "sign-in", provider, model: motionModel, models: registry, piModel, secrets: secretsOf(auth) });
	}
	if (!session || !signable.has(turnProvider)) return null;
	const auth = await authOf(turnProvider);
	const chosen = auth ? await resolveModel(key, { models: registry }).catch(() => null) : null;
	if (!chosen) return null;
	return route({ via: "session model", provider: chosen.provider, model: chosen.modelId, effort: clampThinkingLevel(chosen.model, effort), models: registry, piModel: chosen.model, secrets: secretsOf(auth) });
}
