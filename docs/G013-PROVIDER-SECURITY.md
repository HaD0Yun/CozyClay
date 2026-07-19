# G013 Provider Credential Threat Contract

A real provider credential is accepted only through the provider-standard environment variable selected by explicit `--provider <id> --model <id>` arguments. `--faux` is a separate explicit test mode. Credentials are never accepted on argv, serialized, or persisted.

## Sink contract

| Sink | Threat | Required behavior |
| --- | --- | --- |
| Child argv and process listings | A key passed as an argument is visible to other local processes and crash collectors. | Arguments contain provider/model identifiers only. Supplying a credential-like argument is unsupported. The Node executable is an absolute, verified, owned regular nonsymlink file. |
| Inherited environment | Blender may contain unrelated API keys, tokens, cloud credentials, and injected runtime variables. | Spawn with a new minimal allowlist containing required platform variables and only the selected provider credential variable. Reject missing/empty credentials before spawn. Never inherit the parent environment wholesale. |
| Startup stdout record | A diagnostic or configuration dump could expose the key. | Stdout remains the single bounded protocol startup record; provider/model and credentials are absent. Malformed/trailing stdout fails closed. |
| Child stderr | Provider libraries may include request headers, environment values, or exception text; an undrained pipe can deadlock. | Drain continuously from process start. Redact every configured secret across read chunk boundaries before retaining data. Keep only a bounded ring buffer and expose only redacted diagnostics. |
| Thrown exceptions and user-facing errors | Provider/auth errors may echo credentials or unbounded upstream text. | Configuration failures use bounded fixed messages containing only nonsecret provider/model identifiers. Child diagnostics are redacted and bounded before surfacing. |
| WebSocket traffic | Credentials included in prompts, tool payloads, or errors become observable and persistable. | Credential material is used only by the in-memory credential store/provider request path and is never placed in daemon handlers or protocol messages. |
| `.omb` project/session files and artifact files | Persisted configuration, errors, or request material could retain keys. | Provider boot does not write credentials or auth diagnostics. Project/session/artifact stores receive no credential value. |
| Crash reports and logs | argv, inherited environment, stdout/stderr, or exception objects may be captured. | Minimize argv/environment, copy the selected key into the in-memory credential store, immediately remove its environment entry, use fixed redacted errors, and dispose the stored credential on shutdown. Never log raw caught provider errors at the boot boundary. |
| Test snapshots and fixtures | Sentinel keys can accidentally become committed expected output. | Tests use dummy sentinels only in process environment/input and assert sentinel absence from argv, diagnostics, stdout, WebSocket messages, and files. No fixture or snapshot contains a usable key. |

The boundary fails closed for absent/empty credentials, unknown providers/models, unsafe executables, malformed startup output, or unredactable startup failures. Diagnostics are bounded; raw stderr is never exposed.

The platform allowlist is `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TEMP`, `TMP`, and `SYSTEMROOT`; empty entries are omitted. The sole additional entry in real-provider mode is that provider's credential variable. `OMB_NODE_EXECUTABLE` and `OMB_DAEMON_ARGS` configure the parent launcher and are not forwarded.

## Manual opt-in real-provider smoke test

This path is deliberately excluded from automated tests and must be run only in a disposable project with a low-privilege key:

1. Export the provider-standard credential variable, set `OMB_NODE_EXECUTABLE` to an absolute current-user-owned regular nonsymlink Node executable, and set `OMB_DAEMON_ARGS='--provider <provider> --model <model>'`.
2. Record a unique nonsecret marker associated with the disposable key; do not print the key itself.
3. Start Blender/add-on, perform exactly one inspect-only turn, then disconnect normally.
4. Scan the daemon process listing while active and, after shutdown, scan captured stdout, redacted diagnostics, the disposable project's `.omb` tree, generated artifacts, and local crash-report locations for the exact credential bytes. Any match is a security failure; delete the disposable key immediately.
5. Verify the child environment contains only the documented allowlist plus the selected provider credential name, and delete the key after the smoke test.

Never add this smoke path to CI and never use a paid credential in automated tests.
