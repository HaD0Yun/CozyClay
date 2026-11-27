// Provider routes (moved out of agent-routes.mjs):
//   GET    /agent/providers                 the curated providers' sign-in state (MCP and older panels)
//   PUT    /agent/providers/:id             { key }: store a bare api key for a curated provider
//   DELETE /agent/providers/:id             forget a curated provider's key
// and pi's own login (#pi-login), which the panel uses for every provider pi ships:
//   GET    /agent/logins                    each provider's login methods and whether it is connected
//   POST   /agent/logins                    { providerId, type: "oauth" | "api_key" } -> { flowId }
//   GET    /agent/logins/:flowId?after=n    the flow's prompts and events after n (long poll, provider-login.mjs)
//   POST   /agent/logins/:flowId/answer     { promptId, value }
//   DELETE /agent/logins/:flowId            cancel the flow
//   POST   /agent/logout/:providerId        pi's logout for that provider
// Every credential change calls onChange, so the model registry is rebuilt with what was just stored.
import { createLoginFlows, loginOptions } from "./provider-login.mjs";

const KEY_PATH = /^\/agent\/providers\/([^/]+)$/;
const FLOW_PATH = /^\/agent\/logins\/([^/]+)(\/answer)?$/;
const LOGOUT_PATH = /^\/agent\/logout\/([^/]+)$/;

/** Returns the route handler for one sidecar; `getModels` is its registry, `onChange` rebuilds it. */
export function createProviderRoutes({ auth, getModels, onChange, json, readBody }) {
	const flows = createLoginFlows({ getModels, onSignedIn: () => onChange?.() });
	return async function handleProviderRoute(req, res, path) {
		if (path === "/agent/providers" && req.method === "GET") {
			const { providerStatus } = await import("./providers.mjs");
			try { json(res, 200, { providers: providerStatus({ auth }) }); }
			catch { json(res, 500, { error: "provider credentials unavailable" }); }
			return true;
		}
		const keyMatch = KEY_PATH.exec(path);
		if (keyMatch && ["PUT", "DELETE"].includes(req.method)) return keyRoute(req, res, keyMatch[1]);
		if (path === "/agent/logins" && req.method === "GET") {
			try { json(res, 200, { providers: await loginOptions(await getModels(), { chatgpt: () => !!auth.status?.().signedIn }) }); }
			catch (error) { json(res, 502, { error: String(error?.message || error) }); }
			return true;
		}
		if (path === "/agent/logins" && req.method === "POST") {
			let value;
			try { value = await readBody(req); } catch { json(res, 400, { error: "invalid request" }); return true; }
			const models = await getModels();
			const provider = models.getProvider(String(value?.providerId ?? ""));
			const method = value?.type === "oauth" ? provider?.auth?.oauth : value?.type === "api_key" ? provider?.auth?.apiKey : null;
			if (!provider || !method?.login || provider.id === "openai-codex") { json(res, 400, { error: "That provider has no such login." }); return true; }
			json(res, 200, { flowId: flows.start(provider.id, value.type) });
			return true;
		}
		const flowMatch = FLOW_PATH.exec(path);
		if (flowMatch && !flowMatch[2] && req.method === "GET") {
			const after = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("after")) || 0;
			const page = await flows.read(flowMatch[1], after);
			if (!page) json(res, 404, { error: "login not found" }); else json(res, 200, page);
			return true;
		}
		if (flowMatch && flowMatch[2] && req.method === "POST") {
			let value;
			try { value = await readBody(req); } catch { json(res, 400, { error: "invalid request" }); return true; }
			if (!flows.answer(flowMatch[1], String(value?.promptId ?? ""), value?.value)) { json(res, 409, { error: "That prompt is no longer open." }); return true; }
			json(res, 200, { ok: true });
			return true;
		}
		if (flowMatch && !flowMatch[2] && req.method === "DELETE") {
			json(res, 200, { ok: flows.cancel(flowMatch[1]) });
			return true;
		}
		const logoutMatch = LOGOUT_PATH.exec(path);
		if (logoutMatch && req.method === "POST") {
			if (logoutMatch[1] === "openai-codex") { json(res, 400, { error: "Use Sign out for ChatGPT." }); return true; }
			try { await (await getModels()).logout(logoutMatch[1]); }
			catch (error) { json(res, 500, { error: String(error?.message || error) }); return true; }
			await onChange?.();
			json(res, 200, { ok: true });
			return true;
		}
		return false;
	};

	async function keyRoute(req, res, id) {
		const { PROVIDERS } = await import("./providers.mjs");
		const keys = await import("./provider-keys.mjs");
		const { createCredentialStore } = await import("./credential-store.mjs");
		if (!PROVIDERS.some((provider) => provider.id === id)) { json(res, 404, { error: "provider not found" }); return true; }
		const credentials = createCredentialStore({ auth, keys });
		let key;
		if (req.method === "PUT") {
			if (id === "openai-codex") { json(res, 400, { error: "Use ChatGPT sign-in for OpenAI Codex." }); return true; }
			if (id === "anthropic-subscription") { json(res, 400, { error: "Use the Claude sign-in; this provider takes no API key." }); return true; }
			if (id === "google-antigravity") { json(res, 400, { error: "Use the Google sign-in; this provider takes no API key." }); return true; }
			if (id === "openai-compatible") { json(res, 400, { error: "Connect the server under Connect a model; it needs its address." }); return true; }
			try {
				const value = await readBody(req);
				if (typeof value?.key !== "string" || !value.key.trim()) throw new Error("Invalid key.");
				key = value.key.trim();
			} catch { json(res, 400, { error: "a non-empty API key is required" }); return true; }
		}
		try {
			if (req.method === "PUT") await credentials.modify(id, async () => ({ type: "api_key", key }));
			else await credentials.delete(id);
		} catch { json(res, 500, { error: "provider credentials could not be saved" }); return true; }
		await onChange?.();
		json(res, 200, { ok: true });
		return true;
	}
}
