# Standalone QA programs

Run standalone QA programs as separate processes, not as modules in a shared
test-runner process. A successful program must never terminate another
program's checks or reset its failure status.

With the editor development server already running, set `QA_URL`, `CDP_PORT`
and any browser flags required by the machine, then run:

```sh
node tools/run-qa.mjs test/qa-camera-follow-carry-browser.mjs test/qa-coplanar-flicker-browser.mjs
```

Each program runs through `tools/qa-browser.mjs` with its own browser process,
temporary profile and page lifetime. Browser startup, scene seeding and cleanup
remain owned by that wrapper. Programs run serially, so the same CDP port can
be reused. Each `RUNNING` line is followed by a named `PASS` or `FAIL` result
with the program's exit code or signal. Later programs still run after a
failure; the aggregate exits nonzero if any program failed.

For standalone programs that do not need a browser:

```sh
node tools/run-qa.mjs --node test/verify-camera-follow.mjs test/verify-camera-block.mjs
```

Use `--node` for the self-owned cast browser gate too, with its normal
`CHROME_PATH` and browser-flag configuration:

```sh
node tools/run-qa.mjs --node test/bus/cast-browser-smoke.mjs
```

The command accepts existing standalone files named `qa-*-browser.mjs`,
`verify.mjs` / `verify-*.mjs` or `cast-browser-smoke.mjs`.
Helpers such as `camera-browser-harness.mjs`,
`cast-identity-scenario.mjs`, `qa-stage-hdr-harness.mjs` and `browser-*.mjs`
are imported by programs; passing one directly is an error, detected before
any program starts. An empty list or missing file is also an error.

To repeat a stability run, repeat this command and preserve its status:

```sh
i=0
while [ "$i" -lt 20 ]; do
  node tools/run-qa.mjs test/qa-camera-follow-carry-browser.mjs test/qa-coplanar-flicker-browser.mjs || exit $?
  i=$((i + 1))
done
```

Inspect every named program result, not just the shell loop's final status.
Standalone success closes its resources and returns normally; it must not
call `process.exit(0)` or assign a zero exit status over earlier failures.
