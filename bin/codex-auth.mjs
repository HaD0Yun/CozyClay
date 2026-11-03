import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { openBrowser } from "./open-browser.mjs";
import { writeSecureJson } from "./agent/secure-file.mjs";
import { readCredentials, readKeys } from "./agent/provider-keys.mjs";
import { PROVIDERS } from "./agent/providers.mjs";

const AUTHORIZE_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access";
const DEFAULT_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cozyclay", "codex-auth.json");
const tokenFile = process.env.COZYCLAY_CODEX_AUTH_FILE || DEFAULT_FILE;
let tokens = null;
let authServer = null;
let authState = null;
let refreshLock = null;
const listeners = new Set();
// How long a sign-in page stays answerable (the callback server's life), and the ports its redirect may use.
let signInWaitMs = 10 * 60 * 1000;
let callbackPorts = [1455, 1457];
let open = openBrowser;
// Why the last sign-in ended without a session (#1044), until the next one starts or one succeeds: timeout (the wait
// ran out), callback_error (the page came back refused or the code exchange failed), port_busy (no callback port was
// free), user_closed (Cancel on the waiting card). A class only; the provider's own words stay here.
let lastFailure = null;

const readTokens = () => {
	if (tokens) return tokens;
	try { tokens = JSON.parse(readFileSync(tokenFile, "utf8")); } catch { tokens = null; }
	return tokens;
};
const identity = () => {
	const current = readTokens();
	if (!current?.refresh_token) return null;
	return decodeJwt(current.id_token || "")["https://api.openai.com/auth"]?.chatgpt_account_id || true;
};
const notifyAuthChange = (before) => {
	const after = identity();
	const kind = after === null ? "signed_out" : before === after ? "rotated" : "replaced";
	const change = { kind, status: status() };
	listeners.forEach((cb) => { try { cb(change); } catch {} });
};
const writeTokens = (value) => {
	const before = identity();
	writeSecureJson(tokenFile, value);
	tokens = value;
	notifyAuthChange(before);
};
const clearTokens = () => {
	const before = identity();
	try { unlinkSync(tokenFile); } catch (error) { if (error?.code !== "ENOENT") throw error; }
	tokens = null;
	notifyAuthChange(before);
};
const decodeJwt = (value) => { try { return JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()); } catch { return {}; } };
const claims = () => decodeJwt(readTokens()?.id_token || "");
function providersConfigured() {
	const configured = new Set();
	for (const provider of PROVIDERS) for (const name of provider.env) if (process.env[name]?.trim()) configured.add(provider.id);
	for (const [id, value] of Object.entries(readKeys())) if (typeof value === "string" && value.trim()) configured.add(id);
	// and every provider a pi login stored a credential for (auth.json: OAuth, or a key with provider env)
	for (const id of Object.keys(readCredentials())) configured.add(id);
	return configured.size;
}
export function status() {
	const claim = claims();
	const auth = claim["https://api.openai.com/auth"] || {};
	// `pending` keeps the panel on "Waiting for your browser…" while a sign-in page is open, with its link.
	const pending = Boolean(authServer && authState) && !readTokens()?.refresh_token;
	const signedIn = !!readTokens()?.refresh_token;
	const failure = !signedIn && !pending && lastFailure ? { failure: lastFailure } : {};
	return { signedIn, ...(pending ? { pending, authorizeUrl: authState.result.authorizeUrl, waitUntil: authState.result.waitUntil } : {}), ...failure, email: claim.email || null, plan: auth.chatgpt_plan_type || null, accountId: auth.chatgpt_account_id || null, expiresAt: readTokens()?.expires_at || null, providersConfigured: providersConfigured() };
}
export function readStored() {
	const current = readTokens();
	if (!current) return undefined;
	const { access_token, refresh_token, expires_at } = current;
	return { access_token, refresh_token, expires_at };
}
export function writeStored(value) { writeTokens({ ...readTokens(), ...value }); }
export function getAccountId() { return status().accountId; }
export function onAuthChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
export function createPkceVerifier(bytes = randomBytes(32)) { return bytes.toString("base64url"); }
export function pkceChallenge(verifier) { return createHash("sha256").update(verifier).digest("base64url"); }

async function exchange(body) {
	const response = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
	let payload = {}; try { payload = await response.json(); } catch {}
	if (!response.ok) { const error = new Error(payload.error || `token request failed (${response.status})`); error.status = response.status; error.code = payload.error; throw error; }
	return payload;
}
async function refresh() {
	const current = readTokens();
	if (!current?.refresh_token) return null;
	try {
		const payload = await exchange({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: current.refresh_token });
		const expiresAtSeconds = decodeJwt(payload.access_token || current.access_token).exp;
		writeTokens({ ...current, ...payload, expires_at: expiresAtSeconds ? expiresAtSeconds * 1000 : Date.now() + Number(payload.expires_in || 3600) * 1000 });
		return tokens.access_token;
	} catch (error) {
		if (error.status === 401 || error.code === "invalid_grant") clearTokens();
		throw error;
	}
}
export async function getAccessToken() {
	const current = readTokens();
	if (!current?.access_token) return null;
	if (Number(current.expires_at || 0) > Date.now() + 5 * 60 * 1000) return current.access_token;
	if (!refreshLock) refreshLock = refresh().finally(() => { refreshLock = null; });
	try { return await refreshLock; } catch { return null; }
}

/** Ends the waiting sign-in, if one is open, and remembers why (a failure class, or null for a success). */
function endSignIn(server, failure) {
	if (authServer !== server) return;
	server.close();
	authServer = null;
	authState = null;
	lastFailure = failure;
}

export async function startOAuth() {
	if (authServer) return authState.result;
	lastFailure = null;
	const verifier = createPkceVerifier();
	const state = randomUUID();
	const challenge = pkceChallenge(verifier);
	const page = (res, code, text) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(text); };
	const listener = (candidate) => new Promise((resolve, reject) => {
		const server = createServer(async (req, res) => {
			try {
				const url = new URL(req.url || "/", `http://127.0.0.1:${candidate}`);
				if (url.pathname !== "/auth/callback") return;
				if (url.searchParams.get("state") !== state) { res.writeHead(400); res.end("invalid state"); return; }
				// The sign-in page came back refused (the user declined, or the provider said no): this attempt is over.
				const code = url.searchParams.get("code");
				if (url.searchParams.get("error") || !code) {
					page(res, 400, "The ChatGPT sign-in did not finish. Go back to CozyClay and press Try again.");
					endSignIn(server, "callback_error");
					return;
				}
				try {
					const payload = await exchange({ grant_type: "authorization_code", code, redirect_uri: `http://${"local" + "host"}:${candidate}/auth/callback`, client_id: CLIENT_ID, code_verifier: verifier });
					const accessClaims = decodeJwt(payload.access_token || "");
					writeTokens({ ...payload, expires_at: accessClaims.exp ? accessClaims.exp * 1000 : Date.now() + Number(payload.expires_in || 3600) * 1000 });
					page(res, 200, "You are signed in to CozyClay. You can close this window.");
					endSignIn(server, null);
				} catch {
					// Before #1044 this rejection went unhandled and the page had already said "signed in".
					page(res, 502, "The ChatGPT sign-in could not be completed. Go back to CozyClay and press Try again.");
					endSignIn(server, "callback_error");
				}
			} catch { if (!res.headersSent) { res.writeHead(500); res.end(); } }
		});
		server.once("error", reject); server.listen({ port: candidate, host: "127.0.0.1" }, () => resolve(server));
	});
	let port;
	for (const candidate of callbackPorts) {
		try { authServer = await listener(candidate); port = candidate; break; } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
	}
	if (!authServer) {
		lastFailure = "port_busy";
		throw Object.assign(new Error(`Another program is using the sign-in ports (${callbackPorts.join(", ")}). Close other sign-in windows or tools, then try again.`), { code: "port_busy" });
	}
	const authorizeUrl = new URL(AUTHORIZE_ENDPOINT);
	for (const [key, value] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: `http://${"local" + "host"}:${port}/auth/callback`, scope: SCOPE, code_challenge: challenge, code_challenge_method: "S256", state, id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "cozyclay" })) authorizeUrl.searchParams.set(key, value);
	// waitUntil: when the waiting card stops waiting; the panel shows it (#1044).
	authState = { result: { ok: true, port, authorizeUrl: authorizeUrl.toString(), waitUntil: new Date(Date.now() + signInWaitMs).toISOString() } };
	// An abandoned sign-in stops listening after signInWaitMs, so the panel cannot wait on it forever.
	const server = authServer;
	setTimeout(() => endSignIn(server, "timeout"), signInWaitMs).unref?.();
	open(authorizeUrl.toString());
	return authState.result;
}
/** The waiting card's Cancel: the sign-in page stops being answerable. */
export function cancelOAuth() {
	if (authServer) endSignIn(authServer, "user_closed");
	return { ok: true };
}
/** Tests only: the wait, the callback ports and the browser opener; returns the restore. */
export function oauthSeam({ waitMs = signInWaitMs, ports = callbackPorts, openUrl = open } = {}) {
	const previous = [signInWaitMs, callbackPorts, open];
	[signInWaitMs, callbackPorts, open] = [waitMs, ports, openUrl];
	return () => { if (authServer) endSignIn(authServer, null); [signInWaitMs, callbackPorts, open] = previous; lastFailure = null; };
}
export function logout() { clearTokens(); return { ok: true }; }
export async function handleOAuthRequest(req, res) {
	if (req.method === "POST" && req.url === "/oauth/start") {
		try { return respond(res, 200, await startOAuth()); } catch (error) {
			if (error?.code !== "port_busy") throw error;
			return respond(res, 409, { error: { code: "port_busy", message: error.message } });
		}
	}
	if (req.method === "POST" && req.url === "/oauth/cancel") return respond(res, 200, cancelOAuth());
	if (req.method === "GET" && req.url === "/oauth/status") return respond(res, 200, status());
	if (req.method === "POST" && req.url === "/oauth/logout") return respond(res, 200, logout());
	return false;
}
function respond(res, code, body) { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); }
