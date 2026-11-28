import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPkceVerifier, pkceChallenge } from "../bin/codex-auth.mjs";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
assert.equal(pkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "RFC 7636 S256 vector");
assert.match(createPkceVerifier(), /^[A-Za-z0-9_-]{43}$/);
// Notification identity is independent of both rotating token values. A fresh
// module instance captures a scratch token path without touching owner auth.
const scratch = mkdtempSync(join(tmpdir(), "cozyclay-codex-auth-"));
const previousAuthFile = process.env.COZYCLAY_CODEX_AUTH_FILE;
const authFile = join(scratch, "codex-auth.json");
process.env.COZYCLAY_CODEX_AUTH_FILE = authFile;
let auth;
try {
	auth = await import("../bin/codex-auth.mjs?identity-test");
} finally {
	if (previousAuthFile === undefined) delete process.env.COZYCLAY_CODEX_AUTH_FILE;
	else process.env.COZYCLAY_CODEX_AUTH_FILE = previousAuthFile;
}
const changes = [];
const off = auth.onAuthChange(change => changes.push(change));
const tokenFor = accountId => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.e30`;
const expectChange = (kind, signedIn, accountId) => {
	const change = changes.at(-1);
	assert.equal(change.kind, kind);
	assert.deepEqual(change.status, auth.status());
	assert.equal(change.status.signedIn, signedIn);
	assert.equal(change.status.accountId, accountId);
	assert.deepEqual(Object.keys(change).sort(), ["kind", "status"]);
	assert.equal(JSON.stringify(change).includes("secret"), false, "notifications never expose credentials");
};
try {
	auth.writeStored({ access_token: "secret-access-a", refresh_token: "secret-refresh-a", expires_at: Date.now() + 3600000, id_token: tokenFor("account-a") });
	expectChange("replaced", true, "account-a");
	auth.writeStored({ access_token: "secret-access-b", refresh_token: "secret-refresh-b" });
	expectChange("rotated", true, "account-a");
	assert.equal(JSON.parse(readFileSync(authFile, "utf8")).access_token, "secret-access-b");
	auth.writeStored({ id_token: tokenFor("account-b") });
	expectChange("replaced", true, "account-b");
	// Removing the refresh token signs out even if stale id_token claims remain.
	auth.writeStored({ refresh_token: null });
	expectChange("signed_out", false, "account-b");
	auth.logout();
	expectChange("signed_out", false, null);
	assert.equal(auth.readStored(), undefined);
	// Legacy credentials may have no decodable id_token: compare presence,
	// not the refresh token value, since OAuth can rotate that token as well.
	auth.writeStored({ access_token: "secret-legacy-access", refresh_token: "secret-legacy-refresh", id_token: "invalid" });
	expectChange("replaced", true, null);
	auth.writeStored({ access_token: "secret-legacy-access-2", refresh_token: "secret-legacy-refresh-2" });
	expectChange("rotated", true, null);
	let response;
	await auth.handleOAuthRequest({ method: "POST", url: "/oauth/logout" }, {
		writeHead(code) { assert.equal(code, 200); },
		end(body) { response = JSON.parse(body); },
	});
	assert.deepEqual(response, { ok: true });
	expectChange("signed_out", false, null);
	assert.equal(changes.length, 8, "exactly one notification per write or clear");
	off();
	auth.logout();
	assert.equal(changes.length, 8, "unsubscribe removes the listener");
	// Readiness counts every key-authenticated provider the sidecar knows,
	// from the environment or the keys file — a CLIProxy-only author must not
	// land on the ChatGPT sign-in wall.
	const previousConfigDir = process.env.COZYCLAY_CONFIG_DIR;
	const previousCliproxyKey = process.env.CLIPROXY_API_KEY;
	process.env.COZYCLAY_CONFIG_DIR = join(scratch, "config");
	try {
		delete process.env.CLIPROXY_API_KEY;
		const configuredWithout = auth.status().providersConfigured;
		process.env.CLIPROXY_API_KEY = "test-cliproxy-key";
		assert.equal(auth.status().providersConfigured, configuredWithout + 1, "CLIPROXY_API_KEY counts as a configured provider");
	} finally {
		if (previousConfigDir === undefined) delete process.env.COZYCLAY_CONFIG_DIR;
		else process.env.COZYCLAY_CONFIG_DIR = previousConfigDir;
		if (previousCliproxyKey === undefined) delete process.env.CLIPROXY_API_KEY;
		else process.env.CLIPROXY_API_KEY = previousCliproxyKey;
	}
// #1044: the ChatGPT sign-in's waiting step knows when it gives up, and says why it ended.
{
	const { createServer } = await import("node:http");
	const free = async () => { const probe = createServer(); await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve)); const { port } = probe.address(); await new Promise((resolve) => probe.close(resolve)); return port; };
	const opened = [];
	const port = await free();
	let restore = auth.oauthSeam({ waitMs: 60, ports: [port], openUrl: (url) => opened.push(url) });
	try {
		auth.logout();
		const started = await auth.startOAuth();
		assert.equal(opened.length, 1, "the sign-in page opens once");
		assert.ok(Date.parse(started.waitUntil) > Date.now() - 1000, "the start says when the wait ends");
		assert.equal(auth.status().pending, true);
		assert.equal(auth.status().waitUntil, started.waitUntil, "status carries the end of the wait");
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.deepEqual([auth.status().pending, auth.status().failure], [undefined, "timeout"], "a wait that runs out reads as timeout");
		// A refused page: the callback carries error=, the attempt ends as callback_error, the page says so.
		const again = await auth.startOAuth();
		assert.equal(auth.status().failure, undefined, "a new start clears the old reason");
		const state = new URL(again.authorizeUrl).searchParams.get("state");
		const refused = await fetch(`http://127.0.0.1:${port}/auth/callback?state=${state}&error=access_denied`);
		assert.equal(refused.status, 400);
		assert.match(await refused.text(), /did not finish/);
		assert.equal(auth.status().failure, "callback_error");
		// A code the token endpoint refuses: no "signed in" page, no unhandled rejection, callback_error.
		const realFetch = globalThis.fetch;
		const third = await auth.startOAuth();
		globalThis.fetch = async (url, init) => String(url).startsWith("https://auth.openai.com/") ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) : realFetch(url, init);
		try {
			const exchanged = await realFetch(`http://127.0.0.1:${port}/auth/callback?state=${new URL(third.authorizeUrl).searchParams.get("state")}&code=bad`);
			assert.equal(exchanged.status, 502);
			assert.doesNotMatch(await exchanged.text(), /You are signed in/);
		} finally { globalThis.fetch = realFetch; }
		assert.equal(auth.status().failure, "callback_error");
		// Cancel on the waiting card.
		await auth.startOAuth();
		let cancelled;
		await auth.handleOAuthRequest({ method: "POST", url: "/oauth/cancel" }, { writeHead(code) { assert.equal(code, 200); }, end(body) { cancelled = JSON.parse(body); } });
		assert.deepEqual(cancelled, { ok: true });
		assert.equal(auth.status().failure, "user_closed");
		// Cancel pressed while the browser's callback is already exchanging the code: the tokens are not kept.
		const fourth = await auth.startOAuth();
		globalThis.fetch = async (url, init) => { if (!String(url).startsWith("https://auth.openai.com/")) return realFetch(url, init); auth.cancelOAuth(); return new Response(JSON.stringify({ access_token: "a.b.c", refresh_token: "late-refresh", expires_in: 3600 }), { status: 200 }); };
		try {
			// A fresh socket (agent: false): the browser's callback is a new connection to the new sign-in.
			const { get } = await import("node:http");
			const late = await new Promise((resolve, reject) => get(`http://127.0.0.1:${port}/auth/callback?state=${new URL(fourth.authorizeUrl).searchParams.get("state")}&code=late`, { agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject));
			assert.equal(late, 409);
		} finally { globalThis.fetch = realFetch; }
		assert.equal(auth.status().signedIn, false, "a sign-in cancelled mid-exchange stores no tokens");
		assert.equal(auth.status().failure, "user_closed");
		// Every callback port busy: 409 port_busy, and status says so.
		restore();
		const blocker = createServer();
		await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
		restore = auth.oauthSeam({ waitMs: 60, ports: [port], openUrl: (url) => opened.push(url) });
		try {
			let code, body;
			await auth.handleOAuthRequest({ method: "POST", url: "/oauth/start" }, { writeHead(value) { code = value; }, end(value) { body = JSON.parse(value); } });
			assert.equal(code, 409);
			assert.equal(body.error.code, "port_busy");
			assert.equal(auth.status().failure, "port_busy");
		} finally { await new Promise((resolve) => blocker.close(resolve)); }
	} finally { restore(); }
	console.log("PASS ChatGPT sign-in wait: waitUntil, timeout, callback_error (refused page and failed exchange), user_closed, port_busy");
}
// #1374: a stored sign-in whose refresh fails is "sign in again" (auth), not a request sent without a token.
{
	const realFetch = globalThis.fetch;
	const answer = (status, body) => async (url, init) => String(url).startsWith("https://auth.openai.com/") ? new Response(JSON.stringify(body), { status }) : realFetch(url, init);
	try {
		// The provider refuses the refresh with a status other than 401/invalid_grant, so the tokens stay on disk.
		auth.writeStored({ access_token: "secret-stale-access", refresh_token: "secret-stale-refresh", expires_at: Date.now() - 1000, id_token: tokenFor("account-r") });
		globalThis.fetch = answer(500, { error: "server_error" });
		const refused = await auth.getAccessToken().then(() => null, (error) => error);
		assert.equal(refused?.code, "auth", "a refused refresh fails as auth, not null");
		assert.equal(refused.status, 401);
		assert.equal(/secret/.test(`${refused.message} ${JSON.stringify(refused)}`), false, "the error never carries a token");
		assert.equal(auth.status().signedIn, false, "the panel sees the sign-in as gone until it is renewed");
		assert.equal(auth.status().failure, "expired");
		// A refresh with no answer at all (offline) is network: a retry can work, and the sign-in is not marked expired.
		auth.writeStored({ access_token: "secret-stale-access-2", refresh_token: "secret-stale-refresh-2", expires_at: Date.now() - 1000 });
		assert.equal(auth.status().signedIn, true, "new tokens clear expired");
		globalThis.fetch = async (url, init) => { if (String(url).startsWith("https://auth.openai.com/")) throw new TypeError("fetch failed"); return realFetch(url, init); };
		const offline = await auth.getAccessToken().then(() => null, (error) => error);
		assert.equal(offline?.code, "network");
		assert.equal(auth.status().signedIn, true);
		// A refresh token with no access token refreshes instead of answering null.
		auth.writeStored({ access_token: null, refresh_token: "secret-only-refresh", expires_at: null });
		globalThis.fetch = answer(200, { access_token: "e30.e30.e30", refresh_token: "secret-rotated", expires_in: 3600 });
		assert.equal(await auth.getAccessToken(), "e30.e30.e30");
		// invalid_grant clears the sign-in (as before) and still fails as auth.
		auth.writeStored({ access_token: "secret-stale-access-3", refresh_token: "secret-stale-refresh-3", expires_at: Date.now() - 1000 });
		globalThis.fetch = answer(400, { error: "invalid_grant" });
		assert.equal((await auth.getAccessToken().then(() => null, (error) => error))?.code, "auth");
		assert.equal(auth.readStored(), undefined, "invalid_grant removes the stored sign-in");
		assert.equal(await auth.getAccessToken(), null, "no sign-in at all is still null");
	} finally { globalThis.fetch = realFetch; auth.logout(); }
	console.log("PASS a failed ChatGPT refresh: auth with a sticky expired status, network when unreachable, no token in the error");
}
} finally {
	off();
	rmSync(scratch, { recursive: true, force: true });
}
console.log("codex auth verification passed");
