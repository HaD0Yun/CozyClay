// A custom OpenAI-compatible endpoint (#885): LM Studio, Ollama, vLLM, llama.cpp's server or any server that
// answers GET /v1/models and POST /v1/chat/completions, connected without CLIProxyAPI. Like CLIProxyAPI's lane,
// its login is pi's api-key login: it asks for the server address and an optional key, checks that
// <address>/v1/models answers, and returns one api-key credential carrying the address as provider env, which the
// credential store keeps in auth.json. The models are the server's own /v1/models list (pi's fetchModels, run by
// refreshOpenAICompatible), and turns stream through pi-ai's openai-completions API.
import { cleanBase, fetchModelList } from "./cliproxy-provider.mjs";

export const OPENAI_COMPATIBLE_ID = "openai-compatible";
const BASE_ENV = "OPENAI_COMPATIBLE_BASE_URL";
const DEFAULT_BASE = "http://127.0.0.1:11434";
// openai-completions needs some key; a keyless local server ignores the Authorization header it carries.
const NO_KEY = "no-key";

const v1 = (base) => `${base}/v1`;

/** One chat model the server listed. The server does not say which of its models read images, so every model is
 * offered with image input (the panel only lists those); a text-only model refuses an image turn with its own error. */
function endpointModel(id, base) {
	return {
		id,
		name: id,
		type: "chat",
		api: "openai-completions",
		provider: OPENAI_COMPATIBLE_ID,
		baseUrl: v1(base),
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 8192,
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: "max_tokens" },
	};
}

/** The kind of address a server answers on, for telemetry (#1043): "local" (this machine: loopback, localhost),
 * "lan" (a private network address or a .local name), "hosted" (anything else), "unknown" (no parseable address).
 * Only this class leaves the sidecar, never the address. */
export function endpointClass(base) {
	let host;
	try { host = new URL(base).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return "unknown"; }
	if (!host) return "unknown";
	if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^0(?:\.0){3}$/.test(host) || /^127\./.test(host) || /^::ffff:127\./.test(host)) return "local";
	if (host.endsWith(".local") || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return "lan";
	return "hosted";
}

/** Moonshot's own API (#947): a host check on the address, nothing else. */
export const isMoonshotBase = (base) => { try { return /^api\.moonshot\.(ai|cn)$/.test(new URL(base).hostname); } catch { return false; } };
// The documented default output limit for Kimi K3 models; the catalog's 1048576 is the context window.
const KIMI_K3_MAX_TOKENS = 131072;

/** A Kimi K3 model on Moonshot's API (#947), or null. It always reasons (low/high/max, never off) and needs its
 * reasoning_content sent back, so it takes pi-ai's catalog kimi-k3 as its template, with a larger output limit than
 * the generic 8192 that its reasoning alone can use up. Null when the catalog has no template: the generic shape. */
export async function moonshotModel(id, base, moonshot = isMoonshotBase(base)) {
	if (!moonshot || !/^kimi-k3/.test(id)) return null;
	try {
		const cn = new URL(base).hostname.endsWith(".cn");
		const catalog = cn
			? (await import("@earendil-works/pi-ai/providers/moonshotai-cn.models")).MOONSHOTAI_CN_MODELS
			: (await import("@earendil-works/pi-ai/providers/moonshotai.models")).MOONSHOTAI_MODELS;
		const template = catalog?.["kimi-k3"];
		if (!template?.compat) return null;
		return { ...structuredClone(template), id, name: id, provider: OPENAI_COMPATIBLE_ID, baseUrl: v1(base), maxTokens: KIMI_K3_MAX_TOKENS };
	} catch { return null; }
}

const serverModel = async (id, base) => (await moonshotModel(id, base)) ?? endpointModel(id, base);

/** The server's model ids, or an error that says what went wrong in words the login and the picker can show. */
async function listEndpoint(base, key, signal) {
	let data;
	try {
		data = await fetchModelList(v1(base), key, "The OpenAI-compatible server", signal);
	} catch (error) {
		if (error?.status === 401 || error?.status === 403) throw new Error(`The server at ${base} refused ${key ? "the key" : "a request without a key"} (${error.status}).`, { cause: error });
		if (error?.status) throw new Error(`The server at ${base} answered GET /v1/models with ${error.status}.`, { cause: error });
		throw new Error(`Could not reach ${v1(base)}/models (${error?.cause?.code || error?.name || error?.message || error}).`, { cause: error });
	}
	return data.map((entry) => (typeof entry === "string" ? entry : entry?.id)).filter((id) => typeof id === "string" && id);
}

/** pi ApiKeyAuth: the address, then an optional key; the login only succeeds once the server lists its models. */
function endpointAuth() {
	return {
		name: "Server address and optional key",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const address = await interaction.prompt({ type: "text", message: "Server address (LM Studio, Ollama, or another OpenAI-compatible server)", placeholder: v1(DEFAULT_BASE) });
			const base = cleanBase(address.trim() || DEFAULT_BASE);
			interaction.signal.throwIfAborted();
			const key = String(await interaction.prompt({ type: "secret", optional: true, message: "API key (leave empty when the server needs none)" })).trim();
			interaction.signal.throwIfAborted();
			const ids = await listEndpoint(base, key, interaction.signal);
			interaction.notify?.({ type: "info", message: `${base} lists ${ids.length} model${ids.length === 1 ? "" : "s"}.` });
			return { type: "api_key", key, env: { [BASE_ENV]: base } };
		},
		resolve: async ({ credential, signal }) => {
			signal.throwIfAborted();
			if (!credential?.env?.[BASE_ENV]) return undefined;
			return { auth: { apiKey: credential.key || NO_KEY }, env: credential.env, source: "stored credential" };
		},
	};
}

export async function openaiCompatibleProvider() {
	const [{ createProvider }, completionsApi] = await Promise.all([
		import("@earendil-works/pi-ai"),
		import("@earendil-works/pi-ai/api/openai-completions"),
	]);
	return createProvider({
		id: OPENAI_COMPATIBLE_ID,
		name: "OpenAI-compatible server (LM Studio, Ollama)",
		auth: { apiKey: endpointAuth() },
		models: [],
		api: { "openai-completions": completionsApi },
		fetchModels: async ({ credential, signal }) => {
			const base = credential?.env?.[BASE_ENV];
			return base ? Promise.all((await listEndpoint(base, credential.key, signal)).map((id) => serverModel(id, base))) : [];
		},
	});
}

/** Re-reads the server's /v1/models into the registry; the reason it failed, or null. */
export async function refreshOpenAICompatible(models) {
	if (typeof models?.refresh !== "function") return null;
	const { errors } = await models.refresh({ providers: [OPENAI_COMPATIBLE_ID] });
	return errors.get(OPENAI_COMPATIBLE_ID)?.message ?? null;
}
