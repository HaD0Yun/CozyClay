#!/usr/bin/env node
// pi's provider login in the agent panel (#pi-login):
// 1. /agent/logins lists pi's login methods (ChatGPT as CozyClay's own sign-in), connected providers first;
// 2. a login runs pi's flow in the sidecar: prompts and events come out in order, answers go back, the
//    credential lands through the registry's CredentialStore (auth.json for credentials with env or OAuth),
//    and pi's logout removes it; a cancelled flow ends as cancelled;
// 3. CLIProxyAPI's login asks for the server address and the key, the address rides the credential's env,
//    and the registry builds its models on it (the environment still wins);
// 4. a provider outside the curated list joins the model picker once a login stored its credential;
// 5. a provider's 401 in a turn reads as "log in again".
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootDir = mkdtempSync(join(tmpdir(), "cozyclay-pi-login-"));
process.env.COZYCLAY_CONFIG_DIR = join(rootDir, "config");
process.env.COZYCLAY_CODEX_AUTH_FILE = join(rootDir, "config", "codex-auth.json");
process.env.COZYCLAY_AGENT_SESSIONS_DIR = join(rootDir, "sessions");
for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "CLIPROXY_API_KEY", "CLIPROXY_BASE_URL", "GROQ_API_KEY"]) delete process.env[name];

const [{ createAgentHandler }, keys, providers, { createCredentialStore }, { createProvider }, { cliproxyProvider }, { keyRefusedMessage }] = await Promise.all([
	import("../bin/agent/agent-routes.mjs"),
	import("../bin/agent/provider-keys.mjs"),
	import("../bin/agent/providers.mjs"),
	import("../bin/agent/credential-store.mjs"),
	import("@earendil-works/pi-ai"),
	import("../bin/agent/cliproxy-provider.mjs"),
	import("../src/workflow/agent-client.js"),
]);

let failures = 0;
const check = async (name, fn) => {
	try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name} — ${error.stack || error.message}`); }
};
const auth = { readStored() {}, writeStored() {}, logout() {}, status() { return { signedIn: false }; }, getAccessToken: async () => null };
const authFile = join(process.env.COZYCLAY_CONFIG_DIR, "auth.json");
const readAuthFile = () => { try { return JSON.parse(readFileSync(authFile, "utf8")); } catch { return {}; } };

// A provider shaped like pi's: an api-key login that asks for a server and a key, and an OAuth login that
// sends the author to a page and takes a pasted code.
const fake = createProvider({
	id: "fake-cloud",
	name: "Fake Cloud",
	auth: {
		apiKey: {
			name: "Fake Cloud key",
			login: async (interaction) => {
				const server = await interaction.prompt({ type: "text", message: "Server", placeholder: "http://fake" });
				const key = await interaction.prompt({ type: "secret", message: "Key" });
				return { type: "api_key", key, env: { FAKE_SERVER: server } };
			},
			resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined),
		},
		oauth: {
			name: "Fake Cloud (Pro)",
			isSubscription: true,
			login: async (interaction) => {
				interaction.notify({ type: "auth_url", url: "https://fake.example/authorize", instructions: "Sign in, then paste the code." });
				const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
				return { type: "oauth", access: `access-${code}`, refresh: "refresh", expires: Date.now() + 3600_000 };
			},
			refresh: async (credential) => credential,
			toAuth: async (credential) => ({ apiKey: credential.access }),
		},
	},
	models: [],
	api: { stream() { throw new Error("no streaming in this test"); } },
});

const models = await providers.createModels({ auth, keys, env: {} });
models.setProvider(fake);
const handler = createAgentHandler({ auth, models, liveHub: {}, port: () => server.address().port, env: {} });
const server = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const request = async (path, init = {}) => {
	const response = await fetch(`${origin}${path}`, { ...init, headers: { origin, ...(init.body ? { "content-type": "application/json" } : {}) } });
	return { status: response.status, body: await response.json().catch(() => null) };
};
/** Reads a flow until `want(entry)` matches; returns that entry and the cursor after it. */
const until = async (flowId, after, want) => {
	for (let round = 0; round < 20; round += 1) {
		const { body } = await request(`/agent/logins/${flowId}?after=${after}`);
		for (const [index, entry] of body.events.entries()) if (want(entry)) return { entry, after: after + index + 1 };
		after = body.next;
		if (body.done) break;
	}
	throw new Error("the flow never produced the expected entry");
};

await check("/agent/logins lists pi's methods; ChatGPT stays CozyClay's sign-in; subscriptions before api keys", async () => {
	const { status, body } = await request("/agent/logins");
	assert.equal(status, 200);
	const byId = Object.fromEntries(body.providers.map((entry) => [entry.id, entry]));
	assert.deepEqual(byId["openai-codex"].methods.map((method) => method.type), ["chatgpt"]);
	// the API-key lane hides pi's anthropic OAuth: spending a subscription token against the API
	// directly is the refused path; the subscription sign-in lives on anthropic-subscription.
	assert.deepEqual(byId.anthropic.methods.map((method) => method.type), ["api_key"]);
	assert.deepEqual(byId["anthropic-subscription"].methods.map((method) => method.type), ["oauth"]);
	assert.equal(byId["anthropic-subscription"].methods[0].subscription, true);
	// pi's OpenAI API lane also offers a ChatGPT sign-in; CozyClay's ChatGPT sign-in is openai-codex.
	assert.deepEqual(byId.openai.methods.map((method) => method.type), ["api_key"]);
	assert.deepEqual(byId["fake-cloud"].methods.map((method) => method.type), ["oauth", "api_key"]);
	assert.ok(byId.cliproxy.methods.some((method) => method.type === "api_key"));
	// connected providers come first (ambient ones too, e.g. an AWS profile on this machine), then subscriptions, then api keys
	const rest = body.providers.filter((entry) => !entry.connected);
	const firstApiKeyOnly = rest.findIndex((entry) => !entry.methods.some((method) => method.subscription));
	assert.ok(rest.slice(firstApiKeyOnly).every((entry) => !entry.methods.some((method) => method.subscription)), "subscriptions come before api keys");
	assert.ok(body.providers.findIndex((entry) => !entry.connected) >= body.providers.filter((entry) => entry.connected).length, "connected first");
	assert.ok(body.providers.length > 20, `pi's providers are listed (${body.providers.length})`);
});

await check("an api-key login asks in order, stores the credential with its env in auth.json, and connects", async () => {
	const { body: started } = await request("/agent/logins", { method: "POST", body: JSON.stringify({ providerId: "fake-cloud", type: "api_key" }) });
	let step = await until(started.flowId, 0, (entry) => entry.type === "prompt");
	assert.deepEqual(step.entry.prompt, { type: "text", message: "Server", placeholder: "http://fake" });
	assert.equal((await request(`/agent/logins/${started.flowId}/answer`, { method: "POST", body: JSON.stringify({ promptId: step.entry.promptId, value: "http://fake.example" }) })).status, 200);
	step = await until(started.flowId, step.after, (entry) => entry.type === "prompt");
	assert.equal(step.entry.prompt.type, "secret");
	await request(`/agent/logins/${started.flowId}/answer`, { method: "POST", body: JSON.stringify({ promptId: step.entry.promptId, value: "fake-secret-1" }) });
	const done = await until(started.flowId, step.after, (entry) => entry.type === "done");
	assert.equal(done.entry.ok, true, done.entry.message);
	assert.deepEqual(readAuthFile()["fake-cloud"], { type: "api_key", key: "fake-secret-1", env: { FAKE_SERVER: "http://fake.example" } });
	const listed = (await request("/agent/logins")).body.providers;
	assert.equal(listed[0].id, "fake-cloud", "a connected provider is listed first");
	assert.equal(listed[0].connected, true);
	const { body: page } = await request(`/agent/logins/${started.flowId}?after=0`);
	assert.ok(!JSON.stringify(page).includes("fake-secret-1"), "an answer is never put in the flow");
	assert.equal((await request(`/agent/logins/${started.flowId}/answer`, { method: "POST", body: JSON.stringify({ promptId: step.entry.promptId, value: "late" }) })).status, 409);
});

await check("an OAuth login passes pi's sign-in page out and the pasted code back, then pi's logout removes it", async () => {
	const { body: started } = await request("/agent/logins", { method: "POST", body: JSON.stringify({ providerId: "fake-cloud", type: "oauth" }) });
	const page = await until(started.flowId, 0, (entry) => entry.type === "event");
	assert.deepEqual(page.entry.event, { type: "auth_url", url: "https://fake.example/authorize", instructions: "Sign in, then paste the code." });
	const prompt = await until(started.flowId, page.after, (entry) => entry.type === "prompt");
	assert.equal(prompt.entry.prompt.type, "manual_code");
	await request(`/agent/logins/${started.flowId}/answer`, { method: "POST", body: JSON.stringify({ promptId: prompt.entry.promptId, value: "c0de" }) });
	assert.equal((await until(started.flowId, prompt.after, (entry) => entry.type === "done")).entry.ok, true);
	assert.equal(readAuthFile()["fake-cloud"].access, "access-c0de");
	assert.equal(readAuthFile()["fake-cloud"].type, "oauth");
	assert.equal((await request("/agent/logout/fake-cloud", { method: "POST" })).status, 200);
	assert.equal(readAuthFile()["fake-cloud"], undefined);
	assert.equal((await request("/agent/logins")).body.providers.find((entry) => entry.id === "fake-cloud").connected, false);
});

await check("a cancelled login ends as cancelled; ChatGPT and unknown logins are refused", async () => {
	const { body: started } = await request("/agent/logins", { method: "POST", body: JSON.stringify({ providerId: "fake-cloud", type: "api_key" }) });
	await until(started.flowId, 0, (entry) => entry.type === "prompt");
	assert.equal((await request(`/agent/logins/${started.flowId}`, { method: "DELETE" })).body.ok, true);
	const done = await until(started.flowId, 0, (entry) => entry.type === "done");
	assert.equal(done.entry.ok, false);
	assert.match(done.entry.message, /cancelled/);
	assert.equal((await request("/agent/logins", { method: "POST", body: JSON.stringify({ providerId: "openai-codex", type: "oauth" }) })).status, 400);
	assert.equal((await request("/agent/logins", { method: "POST", body: JSON.stringify({ providerId: "nope", type: "api_key" }) })).status, 400);
});
server.close();

await check("CLIProxyAPI's login asks for the address then the key; the registry builds on the stored address", async () => {
	const provider = await cliproxyProvider({ env: {} });
	const asked = [];
	const credential = await provider.auth.apiKey.login({ signal: new AbortController().signal, notify() {}, prompt: async (prompt) => { asked.push(prompt.type); return prompt.type === "text" ? "https://proxy.example.org/v1/" : "proxy-key"; } });
	assert.deepEqual(asked, ["text", "secret"]);
	assert.deepEqual(credential, { type: "api_key", key: "proxy-key", env: { CLIPROXY_BASE_URL: "https://proxy.example.org" } });
	const store = createCredentialStore({ auth, keys, env: {} });
	await store.modify("cliproxy", async () => credential);
	const codexAuth = await import("../bin/codex-auth.mjs");
	assert.ok(codexAuth.status().providersConfigured >= 1, "a pi-stored credential makes the panel ready (providersConfigured)");
	const built = await providers.createModels({ auth, keys, env: {} });
	assert.ok(built.getModels("cliproxy")[0].baseUrl.startsWith("https://proxy.example.org"));
	const fromEnv = await providers.createModels({ auth, keys, env: { CLIPROXY_BASE_URL: "http://env.example:1" } });
	assert.ok(fromEnv.getModels("cliproxy")[0].baseUrl.startsWith("http://env.example:1"), "the environment still wins");
	await store.delete("cliproxy");
	assert.equal(readAuthFile().cliproxy, undefined);
});

await check("a bare key stays in providers.json, OAuth goes to auth.json, and one provider never has both", async () => {
	const store = createCredentialStore({ auth, keys, env: {} });
	await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-1" }));
	assert.equal(keys.readKeys().anthropic, "sk-ant-1");
	await store.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }));
	assert.equal(keys.readKeys().anthropic, undefined);
	assert.equal(readAuthFile().anthropic.type, "oauth");
	assert.equal((await store.read("anthropic")).type, "oauth");
	await store.delete("anthropic");
	assert.equal(readAuthFile().anthropic, undefined);
});

await check("a provider outside the curated list joins the model picker once a login stored its credential", async () => {
	const before = await providers.listAgentModels({ auth, keys, env: {} });
	assert.ok(!before.providers.some((entry) => entry.id === "groq"));
	await createCredentialStore({ auth, keys, env: {} }).modify("groq", async () => ({ type: "api_key", key: "gsk-1" }));
	const after = await providers.listAgentModels({ auth, keys, env: {} });
	const groq = after.providers.find((entry) => entry.id === "groq");
	assert.equal(groq?.signedIn, true);
	assert.ok(groq.models.length > 0);
	assert.ok(after.models.some((model) => model.id.startsWith("groq/")));
});

await check("a provider's 401 in a turn reads as logging in again", () => {
	assert.equal(keyRefusedMessage('401 {"error":{"message":"invalid x-api-key"}}'), "The model provider refused the credentials (401: invalid x-api-key).");
});

// #1044: a login nobody finishes stops, and a failed one names its class; #1043: the endpoint class.
await check("a pi login that waits too long stops as timeout, a cancelled one as user_closed, a refused one as callback_error", async () => {
	const { createLoginFlows, loginFailureReason } = await import("../bin/agent/provider-login.mjs");
	const waitForCallback = (interaction) => new Promise((resolve, reject) => {
		if (interaction.signal.aborted) { reject(new Error("Login cancelled")); return; }
		interaction.signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
	});
	const flows = createLoginFlows({ getModels: async () => ({ login: (_id, type, interaction) => type === "refused" ? Promise.reject(new Error("Anthropic authorization failed: access_denied")) : waitForCallback(interaction) }) });
	const settle = async (id) => { let page; for (let i = 0; i < 50 && !page?.done; i += 1) page = await flows.read(id, 0); return page; };
	const slow = flows.start("anthropic-subscription", "oauth", { timeoutMs: 30 });
	const first = await flows.read(slow, 0);
	assert.ok(Date.parse(first.waitUntil) > 0, "the waiting step knows when it gives up");
	const timedOut = (await settle(slow)).events.at(-1);
	assert.deepEqual([timedOut.ok, timedOut.reason], [false, "timeout"]);
	assert.match(timedOut.message, /stopped\. Press Try again/);
	const cancelled = flows.start("anthropic-subscription", "oauth");
	flows.cancel(cancelled);
	assert.equal((await settle(cancelled)).events.at(-1).reason, "user_closed");
	const refused = flows.start("anthropic-subscription", "refused");
	assert.equal((await settle(refused)).events.at(-1).reason, "callback_error");
	assert.equal(loginFailureReason(Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:53692"), { code: "EADDRINUSE" })), "port_busy");
	assert.equal(loginFailureReason(new Error("Anthropic sign-in timed out")), "timeout");
	assert.equal(loginFailureReason(new Error("something else")), "other");
});

await check("an OpenAI-compatible server's address reads as a class, never the address", async () => {
	const { endpointClass } = await import("../bin/agent/openai-compatible-provider.mjs");
	const cases = [["http://127.0.0.1:11434/v1", "local"], ["http://localhost:1234/v1", "local"], ["http://[::1]:8080/v1", "local"], ["http://0.0.0.0:8000/v1", "local"],
		["http://192.168.1.20:1234/v1", "lan"], ["http://10.0.0.5:8000/v1", "lan"], ["http://172.20.0.2:8000/v1", "lan"], ["http://gpu-box.local:8000/v1", "lan"],
		["https://api.example.com/v1", "hosted"], ["http://172.32.0.1/v1", "hosted"], ["not a url", "unknown"], [undefined, "unknown"]];
	for (const [base, expected] of cases) assert.equal(endpointClass(base), expected, String(base));
});

rmSync(rootDir, { recursive: true, force: true });
if (failures) { console.error(`${failures} pi login check(s) failed`); process.exit(1); }
console.log("verify-agent-login: all checks passed");
