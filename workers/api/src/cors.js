import { siteOriginFor } from "./policy.js";

/**
 * Attach the API CORS contract to every response, including errors and
 * preflight responses.
 */
export function withCors(response, request, env) {
  const result = new Response(response.body, response);
  result.headers.set("Access-Control-Allow-Origin", siteOriginFor(env, request));
  result.headers.set("Vary", "Origin");
  result.headers.set("Access-Control-Allow-Credentials", "true");
  return result;
}
