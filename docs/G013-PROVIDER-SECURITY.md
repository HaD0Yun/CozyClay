# G013 Provider Credential Threat Contract

A real provider credential is accepted only through the provider-standard environment variable selected by explicit `--provider <id> --model <id>` arguments. `--faux` is a separate explicit test mode. Credentials are never accepted on argv, serialized, or persisted.

## Sink contract

| Sink | Threat | Required behavior |
| --- | --- | --- |
| Child argv and process listings | A key passed as an argument is visible to other local processes and crash collectors. | Arguments contain provider/model identifiers only. Supplying a credential-like argument is unsupported. The Node executable is an absolute, verified, owned regular nonsymlink file. |
| Inherited environment | Blender may contain unrelated API keys, tokens, cloud credentials, and injected runtime variables. | Spawn with a new minimal allowlist containing required platform variables and only the selected provider credential variable. Reject missing/empty credentials before spawn. Never inherit the parent environment wholesale. |
| Startup stdout record | A diagnostic or configuration dump could expose the key. | Stdout remains the single bounded protocol startup record; provider/model and credentials are absent. Malformed/trailing stdout fails closed. |
| Child stderr | Provider libraries may include request headers, environment values, or exception text; an undrained pipe can deadlock. | Drain continuously from process start. Redact every configured secret across read chunk boundaries before retaining data. Keep only a bounded ring buffer and expose only redacted diagnostics. |
| Thrown exceptions and user-facing errors | Provider/auth errors may echo credentials or unbounded upstream text. | Configuration failures use bounded fixed messages containing only nonsecret provider/model identifiers. At the director-turn boundary, only typed daemon failures whose codes are in the closed allowlist and match `^[A-Z][A-Z0-9_]+:` are emitted with their code-specific fixed message. Every other provider, tool, SDK, non-`Error`, or plain `Error` failure maps to exactly `MODEL_PROVIDER_ERROR: provider request failed`; an uppercase prefix alone never establishes trust. Child diagnostics are redacted and bounded before surfacing. |
| WebSocket traffic | Credentials included in prompts, tool payloads, or errors become observable and persistable. | Credential material is used only by the in-memory credential store/provider request path and is never placed in daemon handlers or protocol messages. Director failure events pass through the same typed fixed-error boundary before either WebSocket or persistence delivery. |
| `.omb` project/session, director transcript, and artifact files | Persisted configuration, errors, prompts, model output, or request material could retain keys. | Provider boot does not write credentials or auth diagnostics. Project/session/artifact stores receive no credential value. The director transcript admits only its closed event schema described below. |
| Crash reports and logs | argv, inherited environment, stdout/stderr, or exception objects may be captured. | Minimize argv/environment, copy the selected key into the in-memory credential store, immediately remove its environment entry, use fixed redacted errors, and dispose the stored credential on shutdown. Never log raw caught provider errors at the boot boundary. |
| Test snapshots and fixtures | Sentinel keys can accidentally become committed expected output. | Tests use dummy sentinels only in process environment/input and assert sentinel absence from argv, diagnostics, stdout, WebSocket messages, and files. No fixture or snapshot contains a usable key. |

The boundary fails closed for absent/empty credentials, unknown providers/models, unsafe executables, malformed startup output, or unredactable startup failures. Diagnostics are bounded; raw stderr is never exposed.

The platform allowlist is `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TEMP`, `TMP`, and `SYSTEMROOT`; empty entries are omitted. The sole additional entry in real-provider mode is that provider's credential variable. `OMB_NODE_EXECUTABLE` and `OMB_DAEMON_ARGS` configure the parent launcher and are not forwarded.

### Director transcript sink

The daemon persists `.omb/director-transcript.json` as a mode-`0600`, atomically replaced, closed-schema file. Its authorized content is a random session ID plus bounded turn events: the user's prompt, bounded final summary or fixed daemon error, tool name, structural parameter-key summary, and a SHA-256 digest of the tool result. Raw provider requests or responses, credential-store values, environment entries, caught provider errors, raw tool parameters/results, and QA image bytes are not authorized transcript content. Tool-result digests preserve correlation without making the result itself a persistence sink. The fixed-error conversion occurs before the shared append-and-send operation, so WebSocket and transcript sinks cannot diverge.

Only an authenticated controller can fetch this transcript. Replay is cursor-paged: a request supplies a next-unread global event cursor and a page size capped at 64 events; the response supplies at most 64 events and either the next cursor or `null`. A reconnect receives the same persisted session ID and ordered events without requiring a whole-transcript frame. Bridge attach credentials, controller resume credentials, bearer tokens, and provider credentials are excluded from both the file and transcript protocol messages. Automated coverage injects an adversarial director service failure whose plain `Error` message contains both an uppercase code-like prefix and a credential sentinel, then asserts exact sentinel absence from every observed WebSocket frame and from the transcript file bytes.

## Manual opt-in real-provider smoke test

This path is deliberately excluded from automated tests and must be run only in a disposable project with a low-privilege key:

1. Export the provider-standard credential variable, set `OMB_NODE_EXECUTABLE` to an absolute current-user-owned regular nonsymlink Node executable, and set `OMB_DAEMON_ARGS='--provider <provider> --model <model>'`.
2. Record a unique nonsecret marker associated with the disposable key; do not print the key itself.
3. Start Blender/add-on, perform exactly one inspect-only turn, then disconnect normally.
4. Scan the daemon process listing while active and, after shutdown, scan captured stdout, redacted diagnostics, the disposable project's `.omb` tree, generated artifacts, and local crash-report locations for the exact credential bytes. Any match is a security failure; delete the disposable key immediately.
5. Verify the child environment contains only the documented allowlist plus the selected provider credential name, and delete the key after the smoke test.

Never add this smoke path to CI and never use a paid credential in automated tests.

## T2 controller/bridge attach boundary

Terminal-first launches separate authenticated roles. The spawning terminal client is the `controller`; it alone may submit requests, cancel work, issue bridge tickets, and explicitly shut down the daemon. The Blender add-on is the `bridge`; it may execute correlated mutation traffic and detach, but cannot exercise controller authority. Closing the controller socket does not terminate the daemon or cancel active work. A daemon-scoped controller resume credential re-authenticates a replacement controller and is never advertised through the project store.

Attach discovery is outside `.omb`. Each daemon creates `omb-<uid>/<launch_id>/` beneath `$XDG_RUNTIME_DIR` when it is an absolute path, or the platform temporary directory otherwise. The per-user and launch directories are current-user-owned, nonsymlink directories with mode `0700`. The endpoint advertisement is a current-user-owned, nonsymlink regular file with mode `0600`; it contains only the fixed loopback host, port, launch ID, and schema version. The add-on verifies ownership, type, permissions, launch-directory correlation, and a no-follow open before trusting the endpoint. These checks mirror the owned regular nonsymlink boundary used by `verify_executable`.

The controller brokers a cryptographically random, role-scoped bridge attach ticket over its authenticated channel. Tickets exist only in daemon memory, expire after a short bounded lifetime, and are burned by the first successful bridge authentication; replay and expired tickets fail the HTTP upgrade. Tickets, controller resume credentials, and bearer values must not be written to `.omb`, the runtime endpoint, logs, transcripts, fixtures, or diagnostics. Runtime-directory confidentiality assumes a same-UID trust boundary: another process already running as the same user is trusted to access user-owned runtime state, while other users are excluded by ownership and mode checks. Daemon shutdown or process-signal cleanup zeroes in-memory credentials and removes the launch advertisement.
