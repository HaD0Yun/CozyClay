# Releasing CozyClay

## npm package signing

The official npm package is telemetry-enabled only when its signed marker
matches the package contents. The Ed25519 private key is never stored in the
repository or npm. On macOS, the release scripts read it from the login
Keychain item:

```text
service: cozyclay-package-signing-key
account:  current macOS user
format:   base64 PKCS#8 private key
```

The one-off environment alternative is `COZYCLAY_PACKAGE_SIGNING_KEY`. Do not
put that value in shell history, CI logs, `.env` files, or the repository.
Keep an offline backup in the team's approved secret manager. If the key is
lost or compromised, generate a new Ed25519 pair, replace
`PACKAGE_SIGNATURE_PUBLIC_KEY` in `bin/package-signature.mjs`, and publish the
next package version with the new key.

## Publish

From a clean release worktree:

```bash
npm test
npm publish --access public
```

`prepublishOnly` refuses to publish without the signing key. `prepack` builds
the app and writes the signed marker; `postpack` removes the marker from the
working tree. If a pack is interrupted before `postpack`, remove
`dist/cozyclay-package.json` and rerun the tests before releasing.

## Telemetry smoke check

After publishing, use a clean config directory and a disposable port:

```bash
XDG_CONFIG_HOME="$(mktemp -d)" npx --yes cozyclay@VERSION \
  --port 5212 --no-open --no-star --no-update-check
```

Verify the first launch creates the anonymous state and that PostHog receives
`install:first_launch`, `app:session_started`, and `$pageview` with
`distribution: npm`. A first launch also sends `studio:ready`, and
`app:friction_summary` after the tab closes; `track()` drops any event that
is not on its list, so a missing event (not an empty one) is the failure
sign. Then run `cclay telemetry off` and verify a reload sends nothing
further.

Then check the update notice on an older global install (`npm install -g
cozyclay@<previous>`, then `cclay`): the top bar shows **Update VERSION**,
**Update now** ends with the restart text, and `cclay --version` prints
VERSION afterwards.
