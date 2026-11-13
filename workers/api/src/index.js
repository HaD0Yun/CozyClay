import { handleCallback, readSession, startOAuth } from "./auth.js";
import { withCors } from "./cors.js";
import { POLICY } from "./policy.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function json(data, status = 200, headers = {}) {
  const result = new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE, ...headers },
  });
  return result;
}

function errorResponse(error, status, request, env, extra = {}) {
  return withCors(json({ error, ...extra }, status), request, env);
}

async function accountFor(env, accountId) {
  if (!accountId) return null;
  return env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(accountId).first();
}

async function meHandler(request, env) {
  const session = await readSession(request, env);
  if (!session) return withCors(json({ signedIn: false }), request, env);
  const account = await accountFor(env, session.sub);
  if (!account) return withCors(json({ signedIn: false }), request, env);
  return withCors(json({
    signedIn: true,
    provider: (await env.DB.prepare("SELECT provider FROM identities WHERE account_id=? ORDER BY created_at LIMIT 1").bind(account.id).first())?.provider ?? null,
  }), request, env);
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "content-type, authorization",
        "Access-Control-Max-Age": "600",
      },
    }), request, env);
  }
  if (pathname.startsWith("/auth/") && request.method === "GET") {
    const match = pathname.match(/^\/auth\/google\/(start|callback)$/u);
    if (!match) return errorResponse("not_found", 404, request, env);
    const response = match[1] === "start"
      ? await startOAuth(request, "google", env, { nextPath: url.searchParams.get("next") ?? "/demo/" })
      : await handleCallback(request, "google", env);
    return withCors(response, request, env);
  }
  if (pathname === "/me" && request.method === "GET") return meHandler(request, env);
  return errorResponse("not_found", 404, request, env);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error("cozyclay api error", error?.message ?? error);
      return errorResponse("internal_error", 500, request, env);
    }
  },
  async scheduled(_event, env, ctx) {
    const work = (async () => {
      await env.DB.prepare("DELETE FROM oauth_state WHERE created_at <= ?").bind(Date.now() - POLICY.OAUTH_STATE_TTL_MS).run();
    })();
    if (ctx?.waitUntil) ctx.waitUntil(work);
    // Await as well as registering waitUntil so local adapters and operational
    // smoke tests observe completed cleanup before the handler resolves.
    await work;
  },
};
