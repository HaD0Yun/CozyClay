import { environmentFor, siteOriginFor, POLICY } from "./policy.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const OAUTH_COOKIE = "__Host-cc_oauth";
const SESSION_COOKIE = "__Host-cc_sess";
const PROVIDERS = Object.freeze({
  google: {
    authorization: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    userInfo: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid profile",
  },
});
const REDIRECT_BASE = Object.freeze({
  production: "https://api.cozyclay.org",
  development: "http://127.0.0.1:8787",
});

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
  const text = String(value).replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(text.padEnd(Math.ceil(text.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacBytes(secret, value) {
  if (!secret) throw new Error("signing secret is not configured");
  const key = await crypto.subtle.importKey("raw", encoder.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function hmacVerify(secret, value, signature) {
  if (!secret) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(value));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  const left = encoder.encode(String(a));
  const right = encoder.encode(String(b));
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) diff |= (left[index % (left.length || 1)] ?? 0) ^ (right[index % (right.length || 1)] ?? 0);
  return diff === 0;
}

function randomHex(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookieValue(request, name) {
  const raw = request?.headers?.get?.("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function safeNextPath(value) {
  const candidate = typeof value === "string" && value.startsWith("/") ? value : "/demo/";
  if (!/^\/(?:demo|d)(?:[/?#]|$)/u.test(candidate) || candidate.startsWith("//")) return "/demo/";
  return candidate;
}

function environmentName(env, request) {
  return environmentFor(env, request);
}

async function issueSession(accountId, env, options = {}) {
  const now = Math.floor(Number(options.now ?? Date.now()) / 1000);
  const exp = now + POLICY.SESSION_TTL_DAYS * 86_400;
  const environment = options.environment ?? environmentName(env);
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = bytesToBase64Url(encoder.encode(JSON.stringify({ sub: accountId, iat: now, exp, env: environment })));
  const signingInput = `${header}.${body}`;
  const signature = bytesToBase64Url(await hmacBytes(env?.SESSION_SIGNING_KEY, signingInput));
  return `${signingInput}.${signature}`;
}

function sessionCookie(token, maxAge = POLICY.SESSION_TTL_DAYS * 86_400) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function oauthStateCookie(state, maxAge = Math.floor(POLICY.OAUTH_STATE_TTL_MS / 1000)) {
  return `${OAUTH_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearOAuthStateCookie() {
  return `${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function readSession(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  try {
    const [header, body, signature] = token.split(".");
    if (!header || !body || !signature) return null;
    const valid = await hmacVerify(env?.SESSION_SIGNING_KEY, `${header}.${body}`, base64UrlToBytes(signature));
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(base64UrlToBytes(body)));
    const now = Math.floor(Date.now() / 1000);
    if (!payload?.sub || !Number.isFinite(payload.exp) || payload.exp <= now) return null;
    if (payload.env && payload.env !== environmentName(env, request)) return null;
    return payload;
  } catch {
    return null;
  }
}

function redirectUri(provider, env, request = null) {
  if (provider !== "google") throw new Error("unsupported_provider");
  const environment = environmentName(env, request);
  const base = REDIRECT_BASE[environment] ?? REDIRECT_BASE.production;
  const expected = `${base.replace(/\/$/u, "")}/auth/google/callback`;
  return env?.GOOGLE_REDIRECT_URI === expected ? env.GOOGLE_REDIRECT_URI : expected;
}

export async function startOAuth(request, provider, env, options = {}) {
  if (provider !== "google") return new Response(JSON.stringify({ error: "unsupported_provider" }), { status: 404, headers: { "content-type": "application/json" } });
  const url = new URL(request.url);
  const nextPath = safeNextPath(options.nextPath ?? url.searchParams.get("next") ?? "/demo/");
  const state = randomHex(32);
  const stateHash = await sha256Hex(state);
  const now = Date.now();
  const db = env.DB;
  if (!db) throw new Error("D1 binding DB is required");
  await db.prepare(
    `INSERT INTO oauth_state(state_hash, provider, next_path, created_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(stateHash, "google", nextPath, now).run();

  const providerConfig = PROVIDERS.google;
  const auth = new URL(providerConfig.authorization);
  auth.searchParams.set("client_id", env?.GOOGLE_CLIENT_ID ?? "");
  auth.searchParams.set("redirect_uri", redirectUri("google", env, request));
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("state", state);
  auth.searchParams.set("scope", providerConfig.scope);
  const response = new Response(null, { status: 302, headers: { Location: auth.href } });
  response.headers.append("Set-Cookie", oauthStateCookie(state));
  return response;
}

async function consumeState(db, state, now) {
  const stateHash = await sha256Hex(state);
  const row = await db.prepare(
    "DELETE FROM oauth_state WHERE state_hash=? AND created_at>? RETURNING state_hash, provider, next_path, created_at",
  ).bind(stateHash, now - POLICY.OAUTH_STATE_TTL_MS).first();
  return row ?? null;
}

async function exchangeCode(code, env, request) {
  const body = new URLSearchParams({
    client_id: env?.GOOGLE_CLIENT_ID ?? "",
    client_secret: env?.GOOGLE_CLIENT_SECRET ?? "",
    code,
    redirect_uri: redirectUri("google", env, request),
    grant_type: "authorization_code",
  });
  const response = await fetch(PROVIDERS.google.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!response.ok) throw new Error("oauth_token_exchange_failed");
  const data = await response.json();
  if (!data.access_token) throw new Error("oauth_token_missing");
  return data.access_token;
}

async function providerProfile(token) {
  const response = await fetch(PROVIDERS.google.userInfo, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "CozyClay-demo-api" },
  });
  if (!response.ok) throw new Error("oauth_profile_failed");
  const profile = await response.json();
  const uid = String(profile.sub ?? profile.id ?? "");
  if (!uid) throw new Error("oauth_profile_invalid");
  return { uid };
}

async function accountById(db, accountId) {
  return db.prepare("SELECT * FROM accounts WHERE id=?").bind(accountId).first();
}

async function signInIdentity(env, profile, now) {
  const db = env.DB;
  const existing = await db.prepare("SELECT account_id FROM identities WHERE provider=? AND provider_uid=?").bind("google", profile.uid).first();
  if (existing) return accountById(db, existing.account_id);
  const accountId = randomHex(16);
  try {
    await db.batch([
      db.prepare("INSERT INTO accounts(id, created_at) VALUES (?, ?)").bind(accountId, now),
      db.prepare("INSERT INTO identities(id, account_id, provider, provider_uid, created_at) VALUES (?, ?, ?, ?, ?)").bind(randomHex(16), accountId, "google", profile.uid, now),
    ]);
  } catch (error) {
    if (!String(error?.message ?? error).toLowerCase().includes("unique")) throw error;
    const raced = await db.prepare("SELECT account_id FROM identities WHERE provider=? AND provider_uid=?").bind("google", profile.uid).first();
    if (!raced) throw error;
    return accountById(db, raced.account_id);
  }
  return accountById(db, accountId);
}

function callbackError(status, error) {
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
}

export async function handleCallback(request, provider, env) {
  if (provider !== "google") return callbackError(404, "unsupported_provider");
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const cookieState = cookieValue(request, OAUTH_COOKIE);
  if (!cookieState) return callbackError(400, "state_missing");
  if (!state || !constantTimeEqual(await sha256Hex(cookieState), await sha256Hex(state))) return callbackError(400, "state_mismatch");
  if (!code) return callbackError(400, "oauth_code_missing");
  const consumed = await consumeState(env.DB, state, Date.now());
  if (!consumed) return callbackError(400, "state_used");
  if (consumed.provider !== "google") return callbackError(400, "state_provider_mismatch");

  try {
    const accessToken = await exchangeCode(code, env, request);
    const profile = await providerProfile(accessToken);
    const account = await signInIdentity(env, profile, Date.now());
    if (!account) return callbackError(500, "account_missing");
    const token = await issueSession(account.id, env);
    const destination = new URL(safeNextPath(consumed.next_path), siteOriginFor(env, request));
    const response = new Response(null, { status: 302, headers: { Location: destination.href } });
    response.headers.append("Set-Cookie", sessionCookie(token));
    response.headers.append("Set-Cookie", clearOAuthStateCookie());
    return response;
  } catch (error) {
    const codeValue = error?.code ?? (String(error?.message ?? "").includes("identity_taken") ? "identity_taken" : "oauth_failed");
    return callbackError(codeValue === "identity_taken" ? 409 : 502, codeValue);
  }
}
