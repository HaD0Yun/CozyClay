# G013 Provider Credential Threat Contract

A real provider credential is accepted only through the provider-standard environment variable selected by explicit `--provider <id> --model <id>` arguments. `--faux` is a separate explicit test mode. Credentials are never accepted on argv, serialized, or persisted.

## Sink contract

| Sink | Threat | Required behavior |
| --- | --- | --- |
| Child argv and process listings | A key passed as an argument is visible to other local processes and crash collectors. | Arguments contain provider/model identifiers only. Supplying a credential-like argument is unsupported. The Node executable is an absolute, verified, owned regular nonsymlink file. |
| Inherited environment | Blender may contain unrelated API keys, tokens, cloud credentials, and injected runtime variables. | Spawn with a new minimal allowlist containing required platform variables and only the selected provider credential variable. One optional nonsecret operations knob is also permitted: `CCLAY_IDLE_TIMEOUT_MS`, an integer bounded to 500..60000 ms parsed fail-closed by the daemon (it can shorten but never lengthen the 60s production idle ceiling; used by shortened-window integration tests). Reject missing/empty credentials before spawn. Never inherit the parent environment wholesale. |
| Startup stdout record | A diagnostic or configuration dump could expose the key. | Stdout remains the single bounded protocol startup record; provider/model and credentials are absent. Malformed/trailing stdout fails closed. |
| Child stderr | Provider libraries may include request headers, environment values, or exception text; an undrained pipe can deadlock. | Drain continuously from process start. Redact every configured secret across read chunk boundaries before retaining data. Keep only a bounded ring buffer and expose only redacted diagnostics. |
| Thrown exceptions and user-facing errors | Provider/auth errors may echo credentials or unbounded upstream text. | Configuration failures use bounded fixed messages containing only nonsecret provider/model identifiers. At the director-turn boundary, only typed daemon failures whose codes are in the closed allowlist and match `^[A-Z][A-Z0-9_]+:` are emitted with their code-specific fixed message. Every other provider, tool, SDK, non-`Error`, or plain `Error` failure maps to exactly `MODEL_PROVIDER_ERROR: provider request failed`; an uppercase prefix alone never establishes trust. Child diagnostics are redacted and bounded before surfacing. |
| WebSocket traffic | Credentials included in prompts, tool payloads, deltas, utterances, or errors become observable and potentially persistable. | Provider credential material is used only by the in-memory credential store/provider request path and is never placed in daemon handlers or protocol messages. Local boot/attach/resume credentials may cross only in the exact targeted startup, HTTP-header, `ControllerAuthSchema`, `ControllerPeerAuthSchema`, `AttachTicketSchema`, and discovery-slot forms below; they are never broadcast or transcript content. Normal assistant text may cross only through `DirectorTurnDeltaSchema` and `DirectorAssistantUtteranceSchema`; failure text passes through the typed fixed-error boundary before either WebSocket or persistence delivery. |
| `.cclay` project/session, director transcript, and artifact files | Persisted configuration, errors, prompts, model output, or request material could retain keys. | Provider boot does not write credentials or auth diagnostics. Project/session/artifact stores receive no credential value. The director transcript admits only its closed event schema described below. |
| Crash reports and logs | argv, inherited environment, stdout/stderr, or exception objects may be captured. | Minimize argv/environment, copy the selected key into the in-memory credential store, immediately remove its environment entry, use fixed redacted errors, and dispose the stored credential on shutdown. Never log raw caught provider errors at the boot boundary. |
| Test snapshots and fixtures | Sentinel keys can accidentally become committed expected output. | Tests use dummy sentinels only in process environment/input and assert sentinel absence from argv, diagnostics, stdout, WebSocket messages, and files. No fixture or snapshot contains a usable key. |

The boundary fails closed for absent/empty credentials, unknown providers/models, unsafe executables, malformed startup output, or unredactable startup failures. Diagnostics are bounded; raw stderr is never exposed.

The platform allowlist is `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TEMP`, `TMP`, and `SYSTEMROOT`; empty entries are omitted. The sole additional entry in real-provider mode is that provider's credential variable. `CCLAY_NODE_EXECUTABLE` and `CCLAY_DAEMON_ARGS` configure the parent launcher and are not forwarded.

### Director streaming and transcript sink

The G013 authorized-content boundary now includes bounded intermediate assistant utterances. This is a narrow amendment for conversational turns, not permission to persist raw provider traffic.

The runtime copies only the discriminated string fields `text_delta.delta` and `text_end.content/contentIndex`. It never copies or serializes a partial assistant object, thinking/reasoning blocks, provider request/response objects, usage, metadata, headers, or exception values. `DirectorTurnDeltaSchema` authorizes ephemeral WebSocket text only: `segment_id`, `content_index` 0..31, `delta_sequence` 0..1,000,000, and a 1..4,096-byte `delta`. Deltas are never transcript records.

`DirectorAssistantUtteranceSchema` is the only durable intermediate model-text form. It seals one segment with the same `segment_id`/`content_index`, a `through_delta_sequence` watermark, per-turn `sequence`, UTC timestamp, and 1..16,384-byte `content`. Once the utterance has passed the exact closed parser, its content is authorized transcript content even when it precedes a tool call or final summary. Tool start is not published until every preceding text segment is sealed. The fixed-error boundary is unchanged: provider, SDK, tool, non-`Error`, and untrusted plain `Error` failures still become exactly `MODEL_PROVIDER_ERROR: provider request failed`; an intermediate utterance cannot authorize caught exception text.

The daemon persists `.cclay/director-transcript.json` as a mode-`0600`, atomically replaced, closed-schema file bounded to 10,000 events. Authorized content is the random session ID and `DirectorTurnEventSchema`: user prompt, bounded `DirectorAssistantUtteranceSchema.content`, bounded final summary or fixed daemon failure, tool name, structural parameter-key summary, result SHA-256, error bit, cancellation, ordering fields, and revision pointer. Raw provider requests/responses, credential-store values, environment entries, caught errors, raw tool parameters/results, deltas, QA image bytes, and credential/control frames remain unauthorized. Tool-result digests preserve correlation without making results a persistence sink.

Persistence precedes durable broadcast on one ordered publication queue. If any append fails, no later delta, utterance, tool, or terminal event may be emitted; Pi is aborted and controller sockets close. Fixed-error conversion occurs before this shared append-and-send operation, so WebSocket and transcript failure sinks cannot diverge.

Only an authenticated owner or peer controller with `director_transcript_v1` may fetch the transcript. `DirectorTranscriptRequestV1Schema`/`DirectorTranscriptV1Schema` retain legacy cursor paging. With `HelloAckControllerV1Schema.protocol_features:["snapshot_cursor_v2"]`, the first `DirectorTranscriptRequestV2Schema` page uses `cursor:0,snapshot_cursor:null`; `DirectorTranscriptV2Schema` freezes and returns `snapshot_cursor`, which every later page must repeat. Pages contain at most 64 events, appends beyond the watermark are excluded until the next snapshot, and reconnect preserves the session ID and gap-free ordering.

Bridge tickets, owner/peer resume tokens, boot bearers, provider credentials, `ControllerAuthSchema`, and `ControllerPeerAuthSchema` are excluded from transcript records. Automated coverage injects credential sentinels into adversarial provider failures and asserts absence from every delta, utterance, durable event, transcript byte, diagnostic, and file sink.

### Transaction and recovery sinks

Provider text and credential material are forbidden from the mutation transaction boundary. `BridgeTransactionPreparedSchema`, `BridgeTransactionAckSchema`, `BridgeTransactionAcknowledgedSchema`, `BridgeTransactionReconcileSchema`, `BridgeTransactionStatusSchema`, and `BridgeTransactionErrorSchema` contain only closed UUID, operation, revision/hash, status, and fixed-error fields. They never contain prompts, assistant output, raw tool data, provider diagnostics, or credentials.

The exact `PreparedTransactionMarker` persists only its 17 recovery fields: transaction/project/operation/request IDs, base/candidate revision and scene hashes, canonical and backup paths/hashes, backup project ID, timestamps, schema version, and phase. `revision_commit_v2` persists the complete validated `DirectorProjectRecoveryV2` manifest and exact `RevisionOperationEntryV2`; it never serializes provider/session objects. Provider sentinel scans include `.cclay/prepared-transaction.json`, `.cclay/transactions`, `.cclay/journal.jsonl`, `.cclay/project.json`, and the canonical/backup `.blend` evidence.

Recovery cannot widen the sink. Every C/`unknown` reconcile row retains existing evidence with zero store writes and zero Blender mutation. In particular, `rollback_saved` plus journal-forward evidence is `unknown`: it does not journal-forward, restore, save, or clean. Recovery errors use only the four fixed `BridgeTransactionErrorSchema` variants and cannot include caught exception text.

## Manual opt-in real-provider smoke test

This path is deliberately excluded from automated tests and must be run only in a disposable project with a low-privilege key:

1. Export the provider-standard credential variable, set `CCLAY_NODE_EXECUTABLE` to an absolute current-user-owned regular nonsymlink Node executable, and set `CCLAY_DAEMON_ARGS='--provider <provider> --model <model>'`.
2. Record a unique nonsecret marker associated with the disposable key; do not print the key itself.
3. Start Blender/add-on, perform exactly one inspect-only turn, then disconnect normally.
4. Scan the daemon process listing while active and, after shutdown, scan captured stdout, redacted diagnostics, the disposable project's `.cclay` tree, generated artifacts, and local crash-report locations for the exact credential bytes. Any match is a security failure; delete the disposable key immediately.
5. Verify the child environment contains only the documented allowlist plus the selected provider credential name, and delete the key after the smoke test.

Never add this smoke path to CI and never use a paid credential in automated tests.

## T2 owner, peer-controller, and bridge boundary

Production boot loads and validates the durable project UUID before listening. Every credential record and immutable `AuthenticatedPrincipal` is already bound to `{projectId,role,authority,lineageId,generation}`; `hello` only confirms the binding and a mismatch closes `1008` before capabilities or session traffic. The authority classes are owner controller, peer controller, bridge, and isolated legacy bridge. Peers may submit and cancel turns but cannot issue bridge credentials, publish/revoke peer lineages, or shut down the daemon. A controller disconnect does not terminate the daemon or cancel active work.

The one-use boot bearer arrives only in `StartupRecordSchema` and authenticates with `Authorization: Bearer <43>` plus `X-CCLAY-Role: controller`; it omits a launch header. Owner resume uses the targeted `ControllerAuthSchema.resume_token` and additionally requires `X-CCLAY-Launch-ID`. It does not rotate on success. Peer resume additionally requires `X-CCLAY-Peer-Lineage-ID` and canonical `X-CCLAY-Peer-Generation`; generation N is burned and `ControllerPeerAuthSchema` targeted-delivers N+1 with exact 300,000 ms expiry. Duplicate/comma-joined headers, whitespace/sign/leading-zero generation, project/launch/lineage mismatch, expiry, replay, or revocation returns an empty HTTP `403`. Auth frames are never broadcast.

Discovery is outside `.cclay`. Each daemon creates owned nonsymlink mode-`0700` `cclay-<uid>/<launch_id>/` directories beneath absolute `$XDG_RUNTIME_DIR` or the platform temporary directory. The mode-`0600` exact files are:

- `endpoint.json`: `{schema_version:1,launch_id,host:"127.0.0.1",port}`;
- `bridge-slot.json`: `{schema_version:1,project_id,ticket,expires_at_ms,generation}`;
- `controller-peer-slot.json`: the bridge-slot fields plus `lineage_id`.

Writers use atomic temporary-file replacement and readers verify ownership, type, permissions, launch-directory correlation, project binding, exact keys, and no-follow paths. Runtime-slot confidentiality uses the documented same-UID trust boundary; slots and their ticket bytes are forbidden from `.cclay`, logs, transcripts, test snapshots, user-facing diagnostics, and provider traffic.

`PublishBridgeDiscoverySlotSchema`/`BridgeDiscoverySlotAckSchema` and `IssueAttachTicketV2Schema`/`AttachTicketSchema` are owner-only and create exact 15,000 ms generation-scoped bridge credentials. Publishing N+1 supersedes N; tickets burn on successful upgrade and replay/expiry/supersession fails. Detached bridge lease refresh is 10,000 ms. `PublishControllerPeerDiscoverySlotSchema`/`ControllerPeerDiscoverySlotAckSchema` publish one lineage; `RevokeControllerPeerSchema`/`RevokeControllerPeerAckSchema` burn that lineage's slot/resume chain and close only its sockets. The legacy id-less attach request is accepted only on the non-peer compatibility path.

Credential frames and slot acks are requester-targeted. Durable semantic events fan out only to negotiated controllers, while bridge transaction frames are correlated only to the requesting bridge. Each socket has an isolated bounded queue; a slow consumer closes `1013` without exposing or dropping another principal's durable traffic. Unknown server frames cause a new controller to close `1008` and reconnect/replay; unknown bridge transaction frames close `1008` immediately.

The exact negotiated names are `director_turn_v1`, `director_transcript_v1`, `director_stream_v1`, `controller_peers_v1`, `mutation_bridge_v2`, `scene_manifest_v3`, and `transaction_commit_v2`; transcript watermark paging is feature `snapshot_cursor_v2`. New clients never send a feature frame without advertisement, and new daemons never send deltas/utterances without `director_stream_v1`.

Owner shutdown burns and zeroes boot, owner, peer, and bridge credentials; removes endpoint and discovery files; drains active work; and disposes provider/session state. Process-signal cleanup applies the same credential and advertisement cleanup.
