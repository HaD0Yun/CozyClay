/**
 * All API policy values live here. Runtime code and verification scripts import
 * this object rather than carrying copies of limits around.
 */
export const POLICY = Object.freeze({
  OAUTH_STATE_TTL_MS: 10 * 60_000,
  SESSION_TTL_DAYS: 30,
});
const SITE_ORIGIN = Object.freeze({
  production: "https://cozyclay.org",
  development: "http://127.0.0.1:5180",
});



export function environmentFor(env = {}, request = null) {
  if (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "production") {
    return env.ENVIRONMENT;
  }
  const origin = request?.headers?.get?.("origin") ?? "";
  if (origin.startsWith("http://127.0.0.1") || origin.startsWith("http://localhost")) return "development";
  try {
    const hostname = new URL(request?.url ?? "").hostname;
    if (hostname === "127.0.0.1" || hostname === "localhost") return "development";
  } catch {
    // A Worker request always has an absolute URL; this keeps helpers total.
  }
  return "production";
}

export function siteOriginFor(env = {}, request = null) {
  const configured = env.SITE_ORIGIN;
  if (configured) return configured;
  return SITE_ORIGIN[environmentFor(env, request)] ?? SITE_ORIGIN.production;
}
