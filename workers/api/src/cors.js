import { siteOriginFor } from "./policy.js";

/**
 * Attach the API CORS contract to every response, including errors and
 * preflight responses. Result downloads pass `credentials:false` because the
 * opaque ticket is their capability.
 */
export function withCors(response, request, env, { credentials = true } = {}) {
  const result = new Response(response.body, response);
  result.headers.set("Access-Control-Allow-Origin", siteOriginFor(env, request));
  result.headers.set("Vary", "Origin");
  if (credentials) result.headers.set("Access-Control-Allow-Credentials", "true");
  else result.headers.delete("Access-Control-Allow-Credentials");
  return result;
}

/** Exact origin check used by every browser mutation. */
export function requireOrigin(request, env) {
  return request?.headers?.get?.("origin") === siteOriginFor(env, request);
}

/** Return a CORS-bearing 403 response for a mutation with a bad Origin. */
export function mutationGuard(request, env) {
  if (requireOrigin(request, env)) return null;
  return withCors(new Response(JSON.stringify({ error: "bad_origin" }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  }), request, env);
}
