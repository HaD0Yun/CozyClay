# CozyClay API Worker

The Cloudflare Worker behind `api.cozyclay.org`: Google sign-in. It lives in this repository under
`AGPL-3.0-or-later` like everything else.

CozyClay 3 removed the hosted Kimodo motion queue (`/jobs`, `/r/:token.npz`,
`/worker/*`), its composer and ticket pages (`demo/`, `d/`) and the GPU-box
poller (`tools/demo-worker/`), and the hosted video-model route (`/v1/motion/*`)
whose Studio client went with AI video. Motion is compiled in the Studio now.
`wrangler.toml` no longer binds the R2 results bucket. The queue's D1 tables stay
in `migrations/` (applied migrations are history); drop them and delete the
bucket on the deployed account when convenient.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /auth/google/start`, `GET /auth/google/callback` | Google OAuth; sets the `__Host-cc_sess` session cookie |
| `GET /me` | `{ signedIn, provider }` for the current session |

The scheduled handler (every five minutes) removes expired OAuth state.

## Local setup

```sh
cd workers/api
cp .dev.vars.example .dev.vars
npm ci
npm run migrate:local
wrangler dev --config wrangler.toml --env development
```

The same steps through the root package scripts:

```bash
npm run demo:api:install   # npm --prefix workers/api ci
npm --prefix workers/api exec -- wrangler d1 migrations apply cozyclay-demo --local
npm run demo:api           # wrangler dev on 127.0.0.1:8787
```

Create a signed development session without OAuth:

```sh
DEV_SESSION=$(node scripts/dev-session.mjs --account dev-account-1)
# The command prints seed SQL on stderr; apply it to local D1:
node scripts/dev-session.mjs --account dev-account-1 --sql \
  | tail -n 1 \
  | npx wrangler d1 execute cozyclay-demo --local --command
```

## Configuration and secrets

Only non-secret identifiers and origins belong in `wrangler.toml`. Set these with
`wrangler secret put` against `wrangler.toml` (never commit values):

- `GOOGLE_CLIENT_SECRET` — Google OAuth client secret.
- `SESSION_SIGNING_KEY` — HMAC key for `__Host-cc_sess` session tokens.

Public variables are `SITE_ORIGIN`, `API_ORIGIN`, `ENVIRONMENT` and `GOOGLE_CLIENT_ID`. The redirect URI is fixed by
environment and is not assembled from the request host:

- production: `https://api.cozyclay.org/auth/google/callback`
- development: `http://127.0.0.1:8787/auth/google/callback`

Every response carries exact ACAO, `Vary: Origin`, and credential CORS headers.
