# CozyClay — Runtime Architecture

Status: conversational controller, Blender bridge, transactional mutation, recovery, TUI, and panel surfaces implemented

Pi baseline: `earendil-works/pi@f7e060374541be0097ee015aaddb097a4f760984`

Reference: `can1357/oh-my-pi@c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4`

## Current executable system

The repository now implements the authenticated local directing loop end to end:

```text
Pi TUI owner (pi-test.sh + apps/cclay-extension) / Blender peer controller
  ⇅ closed controller protocol, ordered stream, watermark transcript
cclay-extension + Pi AgentSession (no standalone daemon)
  ⇅ correlated transaction protocol
Blender bridge
  ⇅ main-thread scene inspection, transactional save, QA display
DirectorProject journal + exact recovery marker + .blend evidence
```

The model-facing tool allowlist is `inspect_project`, `stage_scene`, `apply_camera_plan`, and `render_qa_frames`. Product state remains revision-bound and mutations commit only through the durable transaction protocol below.

## 1. Decision

CozyClay is a private Pi fork that becomes a Blender-specific directing harness.

We will preserve Pi's model, agent, session, extension, and cancellation machinery. We will add a product-owned Director state machine, a small Blender tool surface, a local Blender add-on, and an observation/revision loop.

We will not fork Blender. We will not begin by rewriting Pi core. The first implementation stays in new packages and uses Pi's stable `createAgentSession()` embedding API. A Pi-core patch is allowed only after a failing vertical-slice test proves that the public SDK cannot support a required lifecycle.

Real-world analogy: Pi is the engine and transmission, Blender is the film set, and CozyClay is the director's control room. `oh-my-pi` is useful as a reference for turning an engine into a product, but copying its entire workshop would bring in tools we do not need.

## 2. Why fork Pi but keep the product thin

Pi already separates its responsibilities:

- `packages/ai`: model and provider access;
- `packages/agent`: tool-calling runtime;
- `packages/coding-agent`: sessions, extensions, CLI, SDK, and RPC;
- `packages/tui`: terminal presentation.

The coding-agent SDK accepts custom tools, a product-supplied resource loader, explicit session storage, and a tool allowlist. `AgentSession` exposes event subscription, abort, and disposal, while the separate runtime layer owns session replacement. Extensions can intercept tool calls/results and append custom persistence entries. These are the seams required for a Blender harness. [Pi packages](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/README.md#L26-L34), [Pi session options](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/coding-agent/src/core/sdk.ts#L33-L80), [Pi session lifecycle and replacement](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/coding-agent/docs/sdk.md#L66-L178), [Pi tool interception](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/coding-agent/src/core/extensions/types.ts#L1204-L1210), [Pi custom entries](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/coding-agent/src/core/extensions/types.ts#L1281-L1282)

Pi's lower-level `AgentHarness` is promising, but current coding-agent sessions still run through `AgentSession`. Therefore v1 uses the stable coding-agent SDK rather than depending on an unfinished migration path. [AgentHarness options](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/agent/src/harness/types.ts#L800-L836), [current migration note](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/agent/docs/models.md#L763-L795)

## 3. What to learn from oh-my-pi

`oh-my-pi` is a deep product fork, not a small extension. Its useful lesson is architectural discipline, not feature count.

Adopt these patterns:

1. **Capability provenance.** Every capability records where it came from and uses deterministic collision rules. [Capability registry](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/packages/coding-agent/src/capability/index.ts#L52-L204)
2. **One tool middleware.** Approval, pre-call interception, execution, post-result rewriting, and normalized error propagation wrap every tool in one place. [Tool wrapper](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/packages/coding-agent/src/extensibility/extensions/wrapper.ts#L115-L287)
3. **Config precedence.** Defaults, user config, project config, CLI overlay, then runtime override. [Config precedence](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/docs/config-usage.md#L146-L171)
4. **Discovery and binding are separate.** Discover source paths once, then load their factories against each session's own API and state. [Custom tool discovery and binding](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/packages/coding-agent/src/extensibility/custom-tools/loader.ts#L225-L300)
5. **Append-only operational history.** Session entries append to JSONL while binary blobs live in a separate content-addressed store. [Session storage](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/docs/session.md#L33-L69)
6. **Versioned onboarding and migration.** Setup scenes are selected by comparing their minimum version with the stored setup version, then completion persists the new version. [Setup wizard](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/packages/coding-agent/src/modes/setup-wizard/index.ts#L35-L97)

Do not copy these in v1:

- its marketplace, multi-ecosystem discovery, native Rust acceleration, browser, debugger, LSP, collaboration, memory, or dozens of coding tools;
- its package-wide scope rename and large upstream divergence;
- multiple overlapping extension, hook, and custom-tool systems;
- third-party code running with unrestricted Blender scene mutation.

CozyClay begins with one bundled domain plugin and one local Blender add-on.

## 4. Runtime architecture

```text
Blender UI
  CozyClay Python Add-on
    viewport/timeline context · user selection · undo checkpoint
                         ⇅ local authenticated WebSocket
CozyClay daemon (Node/TypeScript)
  Director Runtime
    Pi AgentSession · domain prompt · Blender tools only
  Director Core
    project state · revisions · beats · shots · approvals
  Blender Bridge
    protocol · transactions · observers · artifact transfer
                         ⇅ optional adapters
  ARDY body motion · ffmpeg · headless Blender QA/render
```

### Process, principal, and credential boundary

- Production boot creates `ProjectStore`, reads and validates `.cclay/project.json`, and binds its lowercase UUIDv4 `project_id` into every credential and principal before opening the listener. Missing, corrupt, or invalid project state fails with `PROJECT_CONFIGURATION_ERROR: project is unavailable` and produces no startup record or listener. A `hello` confirms the pre-bound project; it never establishes identity or writes project state.
- A terminal-first controller may spawn `cclay daemon --port 0`. The daemon emits exactly one bounded `StartupRecordSchema` record: `{type:"cclay_daemon_ready",protocol:1,port,pid,launch_id,bearer_token,expires_in_ms:10000}`. The boot bearer is a one-use 32-byte credential, is never persisted, and authenticates the owner upgrade with `Authorization: Bearer <token>` plus `X-CCLAY-Role: controller`.
- The daemon binds only IPv4 `127.0.0.1`. Runtime discovery lives outside `.cclay`, beneath an owned mode-`0700` `cclay-<uid>/<launch_id>/` directory. `endpoint.json`, `bridge-slot.json`, and `controller-peer-slot.json` are atomic, owned, nonsymlink mode-`0600` files. `endpoint.json` is `{schema_version:1,launch_id,host:"127.0.0.1",port}`. A bridge slot is `{schema_version:1,project_id,ticket,expires_at_ms,generation}`; a peer slot adds `lineage_id`.
- Every upgraded connection receives an immutable `AuthenticatedPrincipal`: `projectId`, `role`, `authority`, optional `lineageId`, and `generation`. Authorities are `owner`, `peer`, `bridge`, or the isolated legacy bridge path. A peer never upgrades to owner authority. Controller disconnect does not stop the daemon or cancel an active turn; bridge disconnect starts transaction recovery and republishes bridge discovery.
- Owner resume uses the 43-character resume token as the bearer and requires exactly `X-CCLAY-Role: controller` and `X-CCLAY-Launch-ID: <launch UUID>`. Boot bearer omits the launch header. Duplicate/comma-joined headers, malformed or mismatched launch values, revoked credentials, and non-loopback upgrades fail with an empty HTTP `403`.
- Peer resume additionally requires `X-CCLAY-Peer-Lineage-ID` and canonical base-10 `X-CCLAY-Peer-Generation`. Generation N is burned on success and `ControllerPeerAuthSchema` delivers N+1, with exact 300,000 ms expiry. Replay, expiry, or revocation fails `403`. `ControllerAuthSchema` is delivered only to the owner; neither credential frame is broadcast or persisted.
- The Pi boundary remains deny-by-default: one product-owned `AgentSession`, `noTools:"all"`, the compiled Blender tool allowlist, isolated session storage, and `BundledDirectorResourceLoader`. User/project Pi extensions, skills, prompts, packages, themes, context, and MCP configuration are never discovered. Blender operations execute on Blender's main thread; the daemon never injects arbitrary Python.

### Closed controller protocol and capabilities

`packages/blender-protocol/src/messages.ts` is normative. Every schema below is an exact-key TypeBox object with `additionalProperties:false`; UUIDs are lowercase v4 and hashes are 64-character lowercase SHA-256 unless stated otherwise.

The delivered capability names are:

- `director_turn_v1` (`DIRECTOR_TURN_CAPABILITY`);
- `director_transcript_v1` (`DIRECTOR_TRANSCRIPT_CAPABILITY`);
- `director_stream_v1` (`DIRECTOR_STREAM_CAPABILITY`);
- `controller_peers_v1` (`CONTROLLER_PEERS_CAPABILITY`);
- `mutation_bridge_v2` (`MUTATION_BRIDGE_CAPABILITY`);
- `scene_manifest_v3` (`SCENE_MANIFEST_V3_CAPABILITY`);
- `transaction_commit_v2` (`TRANSACTION_COMMIT_CAPABILITY`).

Controller transcript v2 is a protocol feature, not a capability: `HelloAckControllerV1Schema` carries `protocol_features:["snapshot_cursor_v2"]` (`SNAPSHOT_CURSOR_V2_FEATURE`). Protocol-2 bridge capability tuples always begin with `mutation_bridge_v2` and may add `scene_manifest_v3`, `transaction_commit_v2`, or both. Controllers send stream/peer/v2 requests only after negotiation.

`ClientMessageSchema` and `ServerMessageSchema` fix controller direction. `DaemonBridgeMessageSchema` and `AddonBridgeMessageSchema` separately fix transaction direction. A new daemon returns targeted `MALFORMED_MESSAGE` for one unknown client type and closes repeated unknown traffic with `1008`; unknown bridge transaction traffic closes `1008` immediately. A new controller closes `1008`, reconnects, and replays the transcript on any unknown server frame. A daemon must never send stream frames to a controller lacking `director_stream_v1`.

### Turns, ordered streaming, and transcript replay

- `DirectorTurnSchema` is `{type:"director_turn",id,prompt,expected_revision_id,deadline_ms}`. Prompt length is 1..8,192 characters; deadline is 100..300,000 ms. One turn is active globally. Owner and peer may submit/cancel; authority errors, rate errors, and request replay responses are requester-targeted, while durable semantic turn events are broadcast to negotiated controllers.
- `DirectorTurnDeltaSchema` is the ephemeral frame `{type:"director_turn_delta",id,segment_id,content_index,delta_sequence,delta}`. `content_index` is 0..31, `delta_sequence` is 0..1,000,000, and `delta` is 1..4,096 UTF-8 bytes.
- `DirectorAssistantUtteranceSchema` is the durable segment seal `{type:"director_assistant_utterance",id,sequence,at,segment_id,content_index,through_delta_sequence,content}`. `through_delta_sequence` is -1..1,000,000 and content is 1..16,384 UTF-8 bytes. The matching `segment_id`/`content_index` and watermark replace the ephemeral text with one persisted utterance.
- `DirectorTurnEventSchema` is the durable union of `DirectorTurnStartedSchema`, `DirectorAssistantUtteranceSchema`, `DirectorToolCallStartedSchema`, `DirectorToolCallFinishedSchema`, `DirectorTurnCompletedSchema`, `DirectorTurnFailedSchema`, and `DirectorTurnCancelledSchema`. Tool events contain only the closed tool name, structural parameter summary, result SHA-256, and error bit.
- The runtime copies only discriminated string fields from Pi `text_delta.delta` and `text_end.content/contentIndex`; it never copies the partial assistant object, thinking, usage, metadata, or raw provider response. One promise-chained publication queue orders deltas, utterance append+broadcast, tool events, and terminal state. Tool start is illegal until all text is sealed. The first transcript append failure stops every later delta/durable emission, aborts Pi, burns credentials, closes controller sockets `1011`, and drains the daemon.
- `DirectorTranscriptRequestV1Schema`/`DirectorTranscriptV1Schema` preserve legacy cursor paging. When `snapshot_cursor_v2` is advertised, `DirectorTranscriptRequestV2Schema` sends `snapshot_cursor:null` at `cursor:0`; `DirectorTranscriptV2Schema` freezes and returns the global event watermark. Every subsequent page repeats that watermark. Cursors are 0..10,000, pages are 1..64 events, the session ID is stable, appends after the watermark wait for the next snapshot, and cursor/watermark regression is rejected.
- `.cclay/director-transcript.json` is mode `0600`, atomically replaced, closed, bounded to 10,000 durable events, and migrates valid v1 data atomically. Deltas are never persisted. The G013 sink amendment authorizes bounded `DirectorAssistantUtteranceSchema.content` as intermediate transcript content; raw provider/reasoning fields and arbitrary failures remain forbidden.

### Controller discovery, fanout, and interaction surfaces

- `PublishBridgeDiscoverySlotSchema`/`BridgeDiscoverySlotAckSchema` publish or supersede the bridge generation with exact 15,000 ms expiry. `IssueAttachTicketV2Schema`/`AttachTicketSchema` provide the equivalent owner-targeted bridge credential response. Legacy `IssueAttachTicketV1Schema` remains only for clients that did not negotiate peers.
- `PublishControllerPeerDiscoverySlotSchema`/`ControllerPeerDiscoverySlotAckSchema` publish a specific lineage and generation. `RevokeControllerPeerSchema`/`RevokeControllerPeerAckSchema` burn the slot/resume chain and close only that lineage. Request replay uses a per-principal 300,000 ms/1,024-entry cache: same ID and canonical body repeats the response without side effects; different content returns `IDEMPOTENCY_CONFLICT`.
- Detached bridge discovery refreshes at 10,000 ms. Reconnect backoff is 250/500/1,000/2,000/4,000 ms, then 5,000 ms through 60 seconds, with ±20% production jitter and none in tests.
- Each controller socket has an isolated queue capped at 256 frames or 1 MiB and a 2,000 ms drain timeout. Only the slow socket closes `1013`; durable delivery to other controllers and persistence continue. Delta batching flushes at 50 ms or 2,048 bytes, never exceeds 4,096 bytes, and the first adapter-to-wire delta is due within 250 ms.
- `apps/cclay-tui` is gone; Pi's own TUI is the controller surface. `apps/cclay-extension` is a Pi extension that hosts the Blender bridge WebSocket server, registers the model-facing tools, publishes `.cclay/pi-bridge.json` for add-on discovery, and appends the director prompt. Its CCLAY-owned viewport retains at most 10,000 durable entries plus one active Markdown segment, reparses only that active Markdown on delta, preserves a scrolled-up entry/line anchor through output and resize, and shows `New output below`.
- The Blender panel drains at most 32 controller events or 4 ms per timer tick. Real-Blender targets are p95 <=4 ms and max <=8 ms, with zero durable drops. QA frames are digest-addressed and displayed only after the matching closed result; transcript bytes never become image payloads.

### Durable transaction and recovery protocol

Mutation requires `transaction_commit_v2`. The UUID `transaction_id` is the idempotency key across Blender, daemon, runtime, and core; the separate `commit_hash` authenticates the canonical commit payload.

Wire types and direction are exact:

- `BridgeTransactionPreparedSchema`: add-on→daemon, 11 required keys binding operation, project, base/candidate revisions and scene hashes, base backup hash, and canonical blend hash;
- `BridgeTransactionAckSchema`: daemon→bridge committed acknowledgement;
- `BridgeTransactionAcknowledgedSchema`: bridge→daemon confirmation after its durable marker advances;
- `BridgeTransactionReconcileSchema`: bridge→daemon with marker phase `prepared|candidate_saved|manifest_committed|acknowledged|rollback_saved`;
- `BridgeTransactionStatusSchema`: daemon→requesting bridge with `base_authoritative|candidate_authoritative|unknown`;
- `BridgeTransactionErrorSchema`: the closed errors `TRANSACTION_CONFLICT`, `TRANSACTION_NOT_FOUND`, `TRANSACTION_EVIDENCE_INVALID`, and `TRANSACTION_STATE_INVALID`, always non-retryable and never controller-broadcast.

`ProjectStore.commitRevision()` accepts `DirectorProjectRecoveryV2` plus `RevisionOperationEntryV2`. The recovery project has exactly `project_id,schema_version,current_revision_id,manifest`; the manifest is the complete exact `SceneManifestV2` or `SceneManifestV3`, bound to the same project and revision. The operation entry has exactly `schema_version,operation,request_id,plan_sha256,base_scene_hash,candidate_scene_hash`. The canonical `revision_commit_v2` hash covers `kind,idempotency_key,expected_revision_id,target_revision_id`, the entire project/manifest, and that operation entry. Same key and byte-identical canonical payload is a no-op; any changed project, manifest, hash, pointer, or operation returns `TRANSACTION_CONFLICT` before journal or project mutation. A valid journal record can reconstruct the complete target project from only the base project and journal.

Before mutation, Blender creates `.cclay/transactions/<transaction_id>/base.blend` as owned mode `0600`, fsyncs file and directory, hashes it, and verifies its project ID. It then atomically writes `.cclay/prepared-transaction.json` as the exact 17-field `PreparedTransactionMarker`: `schema_version`, `transaction_id`, `project_id`, `operation`, `request_id`, `base_revision_id`, `base_scene_hash`, `candidate_revision_id`, `candidate_scene_hash`, `canonical_blend_path`, `canonical_blend_sha256`, `base_backup_path`, `base_backup_sha256`, `base_backup_project_id`, `created_at`, `updated_at`, and `phase`. `canonical_blend_sha256` is null only in `prepared`; every later phase requires a hash, and `rollback_saved` requires it to equal `base_backup_sha256`. All paths are normalized, project-contained, owned, and checked without following symlinks.

Reconciliation uses four evidence classes after phase consistency: C conflict, T manifest target plus matching commit, J valid matching journal while manifest remains base, and B manifest base without a matching commit. The controlling matrix is:

| Marker | C | T | J | B |
| --- | --- | --- | --- | --- |
| `prepared` | unknown; no writes | candidate; verify and mark committed | journal-forward, then candidate | restore base |
| `candidate_saved` | unknown; no writes | candidate; verify and mark committed | journal-forward, then candidate | restore base |
| `manifest_committed` | unknown; no writes | candidate; request/resume ack | unknown; no journal-forward or Blender mutation | unknown; no writes |
| `acknowledged` | unknown; no writes | candidate; confirm and clean | unknown; no journal-forward or Blender mutation | unknown; no writes |
| `rollback_saved` | unknown; no writes | unknown; no writes | **unknown; no journal-forward and no Blender mutation** | verify base and clean |

Every `unknown` enters `RECOVERY_REQUIRED`, retains all evidence, and performs zero store writes and zero Blender mutation. Only `prepared` or `candidate_saved` may journal-forward. Base restore is an atomic temp-copy/fsync/replace/directory-fsync operation followed by project/revision/hash verification and a durable `rollback_saved` marker. Candidate authority verifies the canonical candidate before advancing. Cleanup is idempotent and occurs only after acknowledged or verified rollback authority.

### Control and shutdown invariants

Cancel is requester-targeted and `CancelAckSchema.status` is `accepted|already_terminal|unknown`; accepted acknowledgement is due within 100 ms and exactly one `DirectorTurnCancelledSchema` follows cleanup. Request replay is checked before rate charging. The token bucket has capacity 4 and refills one token per second; new turns, discovery/revoke, transcript, malformed parseable IDs, and BUSY submissions are counted, while exact replays, cancel, ping, shutdown, and transaction control are not.

Maximum JSON size is 1 MiB and bridge binary artifact frames are at most 16 MiB. Idle sockets close after 60 seconds. Owner shutdown burns every credential, drains the active turn and transaction, disposes Pi exactly once, removes runtime advertisements, closes cleanly, and exits; peers cannot shut down the daemon. Pi's JSONL RPC remains diagnostic only—the product daemon embeds `createAgentSession()` because bridge tools and durable state are app-owned.

## 5. Repository boundaries

New code should enter through these product-owned areas:

```text
apps/cclay-extension/          Pi extension: bridge WS host, tool registration, endpoint discovery
packages/director-core/      canonical state and revision rules
packages/director-runtime/   Pi adapter, prompts, tool middleware
packages/blender-protocol/   versioned JSON schemas and messages
packages/blender-tools/      model-facing domain operations
blender-addon/cclay/ Blender panels, operators, observers
docs/                        architecture and upstream-sync notes
```

Ownership is behavioral, not merely directory naming:

| Area | Owns | Must not own |
| --- | --- | --- |
| `apps/cclay-extension` | bridge WebSocket server lifecycle, endpoint discovery file, tool registration, director prompt injection | scene schemas, revision/hash rules, model-facing tool definitions |
| Pi TUI (via `pi-test.sh`) | owner spawn/reattach, transcript replay, streaming viewport, prompt/cancel UX | daemon lifecycle internals, scene mutation, or protocol schema definitions |
| `packages/director-core` | project/revision persistence, stable identity, canonical serialization, scene/artifact hashes, artifact store | Pi APIs or WebSocket transport |
| `packages/director-runtime` | the sole `createAgentSession()` adapter, `BundledDirectorResourceLoader`, bundled prompt, Pi event/cancel/dispose wiring | Blender extraction or canonical state rules |
| `packages/blender-protocol` | protocol/message schemas and generated TypeScript/Python fixtures | daemon lifecycle or tool execution |
| `packages/blender-tools` | `inspect_project` and later model-facing tool definitions; typed calls into the bridge | WebSocket authentication or Pi session construction |
| `blender-addon/cclay` | project initialization, Blender main-thread extraction/mutation, durable transaction evidence, recovery, peer controller, panel/QA display | model/provider logic or owner authority |

Canonical serialization, hashing, and manifest construction live in `packages/director-core`; `packages/blender-protocol` is schema-only and must not implement those behaviors.

Product workspaces and the Blender add-on are covered by their scoped TypeScript and Python suites; upstream Pi packages remain dependency-only.

Pinned bootstrap support matrix:

- Node.js `>=22.19.0`, matching Pi's current engine requirement;
- Blender `5.1.2` for the first vertical slice;
- the Python runtime bundled with that Blender build for production add-on execution;
- macOS arm64 first, followed by Linux after the local round trip is stable.

Upstream-owned Pi areas remain unchanged unless a proven SDK blocker exists:

```text
packages/ai/
packages/agent/
packages/coding-agent/
packages/tui/
```

If an upstream-owned file must change, the commit must contain:

- the failing integration test demonstrating the blocker;
- the smallest patch;
- a note describing whether the fix should be proposed upstream;
- a compatibility test against the next fetched Pi version.

## 6. Canonical state

The Pi transcript and the `.blend` file are evidence and realization, not the product's canonical truth.

```text
DirectorProject
  project_id · schema_version · rational_timebase
  current_revision_id · branch_heads
  entities · revisions · approvals · annotations

ProjectRevision
  revision_id · parent_revision_id · created_at
  directing_spec_ref · scene_manifest_ref
  artifact_refs · dependency_hashes

ArtifactRef
  kind · schema_version · uri · sha256 · producer
```

Durable product storage:

- `.cclay/project.json`: atomically replaced current index;
- `.cclay/journal.jsonl`: append-only operations and decisions;
- `.cclay/artifacts/<sha256>/`: previews, manifests, motion, and render outputs;
- `.cclay/director-transcript.json`: bounded semantic controller transcript, never raw provider traffic;
- `.cclay/prepared-transaction.json`: singleton exact recovery marker while a mutation is unresolved;
- `.cclay/transactions/<transaction_id>/base.blend`: verified private base evidence retained through acknowledgement or rollback cleanup;
- the Pi session stores reasoning provenance plus project/revision IDs only.

### Stable identity and hashing

- Before the first connection, the user runs the add-on's explicit `Initialize Project` operator. In one Blender undo transaction it creates a lowercase UUIDv4 `project_id`, stores it both as the scene custom property `cclay.project_id` and in `.cclay/project.json`, and assigns lowercase UUIDv4 `cclay.entity_id` properties to every local object and every bone. The two persisted project IDs must match on every connection. Camera, light, and armature identities use their owning object ID; bones use their own bone property.
- Initialization is the only identity-bootstrap write and is never model-triggered. It marks the `.blend` dirty and connection is refused until the user saves it. Later inspection refuses missing, malformed, or duplicate IDs rather than generating them lazily. Delivered model mutations use only the typed, revision-bound transaction protocol; linked/library data without writable persistent IDs remains `UNSUPPORTED_LINKED_DATABLOCK`.
- Blender duplication can copy custom properties. The add-on observer records IDs known before the dependency-graph update; an existing entity keeps its ID and every newly observed duplicate receives a new UUIDv4 in one undoable metadata transaction. On file-open ambiguity, `Repair IDs` keeps the first entity in Blender's serialized data-block order and reassigns later duplicates, writes one journal entry, marks the file dirty, and requires an explicit save before reconnect.
- `project_id` never derives from a path or filename. Entity IDs never derive from display names, Blender paths, array positions, or memory addresses. Once persisted they do not change on rename, reparent, reorder, save-as, or daemon restart.
- `SceneManifestV1` is normalized before hashing. Object and bone arrays sort by stable ID; selected-ID sets sort by stable ID for validation and reporting; maps sort keys by Unicode code-point order; semantically ordered arrays such as keyframes sort by rational frame time then stable ID. Strings are Unicode NFC. Integers use base-10 without leading zeros. Booleans and null use JSON literals.
- Selection is viewport interaction state, not durable scene substrate: `selectedEntityIds` is validated (sorted, unique, entity-bound) and reported in every manifest payload, but it is **excluded from the V1/V2/V3 `scene_hash` preimages** in both canonicalizers (`blender-addon/cclay/scene_manifest.py` `_scene_hash_preimage` and `packages/director-core/src/manifest.ts`). A user clicking objects in the viewport must never drift the substrate hash or produce `STALE_BASE`. This is a hash-scheme change relative to earlier revisions: any artifact that embeds `scene_hash`/`revision_id` values (parity fixtures, authorized directing evidence, the fixture registry digest) must be regenerated through its production builder (`scripts/generate_directing_evidence.py` for directing evidence), never hand-edited.
- Every finite binary64 scene number is interpreted from its exact IEEE-754 bits, then converted for the hash preimage to a decimal string rounded half-even to `1e-9`; trailing fractional zeros are removed and `-0` becomes `"0"`. Language-native `round()` is not the contract. NaN and infinities are schema errors. Frame rate and time remain reduced integer rationals and are never converted to floats.
- Canonical JSON uses UTF-8, no insignificant whitespace, and the normalization rules above. `scene_hash` is lowercase hex SHA-256 of those bytes, excluding volatile transport fields (`request id`, nonces, progress, wall-clock timestamps) and volatile viewport state (`selectedEntityIds`), but including stable IDs, hierarchy, transforms, frame/timebase, camera/light/render state, and display names.
- The initial `revision_id` is lowercase hex SHA-256 of `cclay-revision-v1\0 + project_id + "\0" + scene_hash`. A child revision hashes `cclay-revision-v1\0 + project_id + "\0" + parent_revision_id + "\0" + canonical_operation_json + "\0" + resulting_scene_hash + "\0" + canonical_dependency_hashes`. Creation timestamps are persisted but excluded from IDs. `.cclay/project.json` and `.cclay/journal.jsonl` persist every accepted revision before it is exposed as current.

### Artifact boundary

- The only allowed `ArtifactRef.uri` form is `cclay-artifact://sha256/<digest>`, where `<digest>` is exactly 64 lowercase hexadecimal characters and must equal `ArtifactRef.sha256`. `file:`, `http:`, `https:`, `data:`, `blob:`, UNC paths, absolute/relative paths, percent encoding, query strings, fragments, extra path segments, and dot segments are rejected.
- Each upload declares byte length and expected digest before its first chunk. One artifact payload may be at most 512 MiB; committed artifact storage plus active reservations may be at most 20 GiB per project; at most two uploads and 1 GiB of reservations may be active. Accounting counts every committed regular-file byte below `.cclay/artifacts` plus declared bytes reserved by active uploads under one project lock. A digest already verified in the store consumes no new reservation.
- Binary frames are at most 16 MiB. The daemon streams them directly to an exclusive temporary file while incrementally counting bytes and computing SHA-256; it never buffers the payload as one allocation. Exceeding the declared length, any quota, or the exact declared byte count aborts the upload and removes the temporary file. Commit requires the streamed digest to equal the URI digest.
- The artifact store is directory-descriptor anchored. It opens the project directory, `.cclay`, `.cclay/artifacts`, and `.tmp` using `openat` with `O_DIRECTORY|O_NOFOLLOW`; each component must be a non-symlink directory on the same filesystem and owned by the current user. It creates a `0600` temporary file with 128 random bits, `openat(O_CREAT|O_EXCL|O_NOFOLLOW)`, then verifies with `fstat` that it is regular and has link count 1.
- After streaming, the store `fsync`s the temporary file, creates/opens the digest directory with `mkdirat`/`openat(O_DIRECTORY|O_NOFOLLOW)`, and publishes the fixed leaf name `payload` with no-replace semantics (`renameatx_np(RENAME_EXCL)` on macOS or `renameat2(RENAME_NOREPLACE)` on Linux). A platform without equivalent directory-relative no-replace operations fails closed; path-string canonicalize-then-write is not an accepted fallback.
- Before updating `.cclay/project.json`, the store reopens `payload` with `openat(O_NOFOLLOW)`, compares its device/inode to the temporary file's final `fstat`, and verifies that each directory descriptor still matches its parent entry using `fstatat(AT_SYMLINK_NOFOLLOW)`. Any symlink, non-regular file, owner/device/inode change, extra hard link, or replaced directory aborts the commit and leaves the revision unchanged.
- If `payload` already exists, the store never overwrites it. It opens no-follow, verifies regular-file metadata, length, and streamed SHA-256; an exact match is idempotent success and releases the reservation, while any mismatch is `ARTIFACT_COLLISION`. Temporary names are never addressable by URI and are removed during startup recovery after the same no-follow checks.
- Imported `.blend` files are first stored and verified as artifacts, then opened with automatic Python execution disabled.

Rules:

- names and Blender object paths are not stable identity;
- each mutation requires `expected_revision_id`;
- each accepted mutation creates a child revision;
- stale-base writes are rejected;
- approvals bind revision, scope, and artifact hashes;
- changing motion invalidates dependent camera/final approval;
- changing camera invalidates camera/final approval only;
- failure or cancellation rolls Blender back to the transaction checkpoint.

## 7. Public directing operations

The model sees a small domain surface rather than raw Blender primitives:

1. `inspect_project(scope, frame_range)`
2. `propose_scene_plan(brief)`
3. `generate_or_import_motion(beat_ids, constraints)`
4. `assemble_preview(revision_id, changed_scopes)`
5. `revise_range(target, instruction, locks)`
6. `approve_and_render(revision_id, scopes)`

Internal bridge operations are not directly exposed to the model:

- query evaluated objects, bones, cameras, lights, and render settings;
- apply a typed scene patch;
- create/restore an undo checkpoint;
- capture viewport, depth, normal, vector, and object-ID passes;
- render selected frames or a proxy video;
- hash and export artifacts.

Every mutation follows:

```text
validate schema
→ verify expected revision
→ create Blender undo checkpoint
→ apply typed patch
→ inspect evaluated state
→ commit child revision or rollback
→ emit evidence packet
```

## 8. Directing loop

```text
brief
→ beat and shot plan
→ body/hand/camera proposals
→ rough preview
→ coordinate and image inspection
→ bounded revision
→ human approval
→ final render
```

Body motion, hand pose, camera, light, and render settings are separate tracks. A request to fix a fist must not regenerate body motion. A camera-only change must preserve the motion artifact hash.

The first validation scene is the existing 16-second boxing sequence because it exercises timing, dominant-hand correctness, foot contact, separate fist poses, camera continuity, lighting, 24 fps output, and bounded revisions.

## 9. Observation and safety

Pi does not include a built-in process permission system, so the runtime starts without `bash`, `edit`, `write`, or arbitrary filesystem tools. [Pi permissions](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/README.md#L37-L45)

The deny-by-default resource loader is part of the security boundary, not an optimization. One regression fixture places a hostile project extension, skill, prompt, context file, theme, package declaration, and MCP config in both the isolated `agentDir` and project directory. The suite records the bundled prompt digest and tool list, then proves all lifecycle paths:

1. startup exposes exactly `inspect_project` and the bundled prompt;
2. hostile files added after startup remain ignored after `session.reload()`;
3. a direct non-empty `BundledDirectorResourceLoader.extendResources()` call throws `RESOURCE_EXTENSION_DENIED` without changing any resource snapshot;
4. protocol attempts to new/resume/fork/import/switch a session return `METHOD_NOT_ALLOWED`;
5. a test-only second call to the sole `createDirectorSession()` factory creates a fresh bundle-only loader and the same allowlist, proving a future replacement cannot reuse or widen the old loader;
6. teardown invalidates the old session and resource-loader references, so a stale captured context cannot change the replacement.

Hard gates:

- schema/version compatibility;
- finite transforms and valid rotations;
- expected duration and fps;
- known rig mapping;
- subject visibility and camera safe frame;
- contact drift and floor penetration;
- artifact and dependency hashes;
- live-scene revision matches the requested base.

Visual critique may rank or explain candidates, but it never replaces deterministic geometry checks. The user remains the final aesthetic approver.

## 10. Delivery record and remaining roadmap

### Phase 1 — Connection skeleton (delivered)

- add `packages/blender-protocol`, `packages/director-core`, `packages/director-runtime`, `packages/blender-tools`, `apps/cclay-extension`, and `blender-addon/cclay` plus root workspace/build/check/test references without editing Pi core;
- initialize and save stable project/object/bone IDs, then persist the initial canonical revision/hash;
- run `cclay` (Pi + `apps/cclay-extension`) and connect the Blender add-on;
- return a versioned scene manifest;
- prove malformed/expired/consumed authentication, protocol mismatch, second-client rejection, add-on-owned disconnect rollback, both outcomes of the cancel-vs-response race, cancel acknowledgement, deadline expiry, rate/in-flight limits, teardown order, and restart-based reconnect;
- prove hostile local Pi resources are ignored at startup, extension attempt, reload, and session-factory replacement.

Exit: after explicit local identity initialization, Blender can ask the daemon through a real Pi tool turn to inspect a scene, and the model has no scene-mutation operation.

The read-only `SceneManifestV1` contains `project_id`, `revision_id`, Blender version, scene name, rational frame range/fps, active camera ID, render resolution/aspect, object IDs/names/types/parent IDs/transforms, armature and bone IDs/names/parents/transforms, cameras, lights, selected IDs, and the deterministic `scene_hash` defined above. It contains no arbitrary file contents or path-derived identities.

### Phase 2 — Transactional scene tools (delivered)

- implement typed inspection and camera/light/render patches;
- implement undo checkpoint, stale revision rejection, and rollback;
- store journal entries and content-addressed artifacts.

Exit: a failed or cancelled operation leaves the scene byte-for-byte or state-hash equivalent to its checkpoint.

### Phase 3 — Directing vertical slice (remaining roadmap)

- compile one natural-language brief into beats and three camera shots;
- import the existing ARDY boxing motion;
- apply the reusable fist pose as a separate hand track;
- create a 24 fps proxy preview.

Exit: the user provides no bone names, coordinates, or `bpy` code.

### Phase 4 — Inspect and revise (remaining roadmap)

- show final aspect mask in Blender during editing;
- inspect coordinates plus RGB/depth/ID evidence;
- revise one frame range or track while locked hashes remain unchanged;
- attach plan and shot approval to exact revisions.

Exit: "second punch only" and "camera only" revisions preserve all unrelated approved artifacts.

### Phase 5 — Product shell (controller TUI/panel foundation delivered; workflow shell remains)

- add one director panel, beat cards, review state, and render command;
- add versioned onboarding and explicit local plugin loading;
- package only after the vertical slice passes repeatedly.

Exit: the full brief → preview → inspect → revise → approve → render loop works without opening a coding agent.

## 11. Risks and controls

| Risk | Control |
| --- | --- |
| Pi upstream changes break the product | Keep product code in new workspaces, pin the tested Pi commit, and sync through a dedicated branch with integration QA. |
| Blender's main thread freezes | Execute add-on work through operators/timers, stream progress, enforce deadlines, and support cancellation. |
| Model-generated code corrupts a scene | Expose typed domain operations only; require an undo checkpoint and post-mutation inspection. |
| Pi transcript disagrees with the scene | Treat `DirectorProject` and artifact hashes as canonical; the transcript stores pointers and reasoning only. |
| A good-looking frame hides geometric failure | Gate deterministic transform, contact, penetration, visibility, duration, and hash checks before visual review. |
| Add-on and daemon versions drift | Reject incompatible protocol versions during the authenticated handshake before any scene operation. |
| A partial revision changes approved work | Require locks and dependency hashes, then reject a result whose unrelated hashes changed. |
| Inherited Pi automation publishes or mutates the wrong repository | Keep only generic CI active; preserve all release, catalog, contributor, and issue workflows under `.github/upstream-workflows-disabled/` until product-owned policies exist. |

## 12. Upstream strategy

- `origin`: `HaD0Yun/CozyClay`;
- `upstream`: public `earendil-works/pi`, with push disabled locally;
- every fresh clone runs `./scripts/setup-upstream.sh`; remote configuration is never assumed to travel through Git;
- product work: `codex/*` branches, later normal feature branches;
- sync: fetch upstream, create `sync/pi-YYYYMMDD`, run Pi checks plus Blender bridge integration, then merge;
- never force-push upstream-derived shared branches;
- keep product code outside upstream packages so conflicts remain structural rather than line-by-line.

## 13. Explicit non-goals for v1

- forking or rebuilding Blender;
- general natural-language access to every `bpy` API;
- arbitrary Python or shell execution generated by the model;
- an `oh-my-pi`-sized coding-agent distribution;
- marketplace, multi-user collaboration, memory system, debugger, or browser;
- modeling, texturing, full facial animation, crowds, or physics simulation;
- a complete replacement for Blender's timeline, graph editor, or compositor;
- supporting arbitrary rigs before the validated Mixamo/Core27 path works.

## 14. Bootstrap implementation record

The bootstrap work unit established:

1. `packages/blender-protocol`: exact startup/handshake/request/cancel/manifest schemas and shared fixtures;
2. `packages/director-core`: identity validation, canonical manifest serialization, `scene_hash`/initial `revision_id`, and atomic `.cclay/project.json`/journal persistence;
3. `packages/blender-tools`: the only model-facing tool, `inspect_project`, as a session-bound factory that calls the typed Blender bridge;
4. `packages/director-runtime`: `createDirectorSession()`, `BundledDirectorResourceLoader`, bundled prompt, Pi event/cancel/dispose wiring, and the exact `inspect_project` allowlist;
5. `apps/cclay-extension`: bridge WebSocket server lifecycle, tool registration, and endpoint discovery only;
6. `blender-addon/cclay`: explicit identity initialization, child ownership, connect/disconnect, main-thread manifest extraction, and checkpoint verification;
7. one integration scenario proving Blender → daemon → real Pi `AgentSession` → `inspect_project` → Blender → Pi → daemon round-trip;
8. teardown proof showing no daemon, socket, Pi session, or Blender timer remains.

The acceptance test injects a deterministic fake **model** into `createDirectorSession()` and uses Pi's real `createAgentSession()` and `AgentSession` loop. The fake model emits one assistant `inspect_project` tool call, consumes the returned tool result, then emits one final assistant response. The test must not inject a fake `AgentSession`, call `inspect_project` directly, or bypass Pi tool dispatch; those shortcuts are permitted only in lower-level unit tests. No provider key or network call is required.

### Protocol v1 request-bound snapshot bridge

**PROTOCOL V1 REQUEST-BOUND SNAPSHOT BRIDGE:** Protocol v1 has no server-initiated request. The add-on extracts the scene snapshot on the Blender main thread **before** issuing the request, and the request carries that immutable snapshot in `params` plus `expected_revision_id`. The daemon validates the snapshot, computes its revision, verifies `expected_revision_id` against that computed revision, and then runs one Pi `inspect_project` turn whose bridge resolves to the request-bound in-memory manifest. The model never accesses raw `params` directly. Server-initiated Blender bridge requests are reserved for a versioned future protocol. This satisfies the §14 Blender → daemon → Pi → `inspect_project` → Pi → daemon chain for the read-only v1 slice.

The integration test initializes and saves a fixture project, launches the daemon on an OS-assigned port, validates the exact startup record, performs authenticated `hello`, requests the manifest, cancels one delayed request, exercises one deadline and one `BUSY` response, disconnects, restarts once with a new launch/token/session, and unloads the add-on. To make disconnect rollback observable without adding a product mutation, a test-only bridge fault injector changes one harmless fixture property after checkpoint creation and severs the socket; it is not registered as a protocol method or Pi tool. The test asserts:

- child process exited;
- TCP connection to the assigned port is refused;
- no Blender timer or handler remains registered;
- Pi `abort()` completed or reached its five-second bound before `dispose()` ran exactly once;
- accepted cancellation emitted one `cancel_ack`, one `CANCELLED` terminal error after rollback, and no success response;
- barrier-controlled race cases prove cancel-win suppresses success and response-win returns `already_terminal`, with one terminal message in either case;
- the dropped connection triggered add-on-local checkpoint restore without a daemon command, and the restarted launch verified the canonical scene hash before exposing `inspect_project`;
- the replacement launch used different launch, token, nonce, session, and request IDs;
- no token, nonce, or startup record remains on disk;
- temporary project/session/artifact directories are absent;
- startup, reload, direct extension, and replacement-factory resource tests retain exactly the bundled prompt digest and `inspect_project` tool;
- manifest bytes, `scene_hash`, and initial `revision_id` are identical across Python and TypeScript fixtures and across the restart;
- `git status --porcelain` is unchanged.

Initial verification commands:

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
python3 -m unittest discover -s blender-addon/tests
```

The `blender-addon` suite includes the real-daemon §14 integration scenario
(`test_integration_daemon.py`), which launches `apps/cclay-extension` and drives the
authenticated inspect round trip against a live Pi session.

Legacy note: an aggregated `npm run test:cclay-roundtrip` script is not defined;
run the workspace `npm test` plus the add-on integration suite above.


Do not add motion generation, camera authoring, rendering, marketplace support, or a custom GUI in the first commit.

## 15. Base gaps resolved before Phase 2

The read-only slice exposed four base-level questions the sections above do not answer. These
decisions are normative; mutation work must not start while any of them is unimplemented.

### 15.1 Coordinate convention

- **Blender scene space (Z-up, right-handed) is the only ground truth.** Snapshots, revisions,
  hashes, patches, and hard gates all operate in Blender space exclusively.
- **ARDY camera plan v1 is declared a Y-up document** and is converted exactly once, at plan
  ingestion, by `(x, y, z)_ardy → (x, −z, y)_blender` applied to `position` and `look_at`, with
  plan `up = [0, 1, 0]` mapping to Blender `[0, 0, 1]`. No other component may convert axes;
  motion import (FBX/BVH) must land in Blender space at its own ingestion boundary.
- The current fixture builder interprets plan coordinates literally (Y-up basis inside a Z-up
  world). That is acceptable only for the hash round-trip proof; `apply_camera_plan` must ship
  the ingestion conversion, and the fixture builder and SCENE-SNAPSHOT-V2 §5 must be amended in
  the same change so both construct scenically coherent Z-up scenes.

### 15.2 Snapshot tiering for real characters

- The 1 MiB inline snapshot serves the structure/camera tier only. A rigged character
  (hundreds of bones × hundreds of frames × 4+ channels) exceeds it by design, not by accident.
- `inspect_project(scope, frame_range)` resolves this with tiers, not a bigger cap:
  `structure` (objects/cameras/markers, no f-curves), `camera` (current v2 content), and
  `animation(target, frame_range)` (windowed channels). Heavy channel data is persisted as
  `cclay-artifact://sha256/<digest>` motion artifacts per §6; the manifest stores per-entity
  channel hashes so revisions stay cheap while motion bytes stay out of line.
- The v2 whole-document hash remains the revision identity; per-entity hashes are a Merkle
  refinement inside `SceneManifestV1`, not a second identity scheme.

### 15.3 Concurrent user edits and undo

- **The agent never locks the user out of their own scene.** Correctness comes from
  invalidation, not exclusion: the add-on's depsgraph observer marks the live revision dirty on
  any change not produced by the active agent patch, and every mutation re-verifies the live
  scene hash against `expected_revision_id` on the main thread immediately before applying.
  Dirty state fails the request with `STALE_BASE`; recovery is re-inspect, never force-apply.
- **Agent checkpoints are scoped value snapshots, not global undo steps.** The add-on serializes
  the pre-state of exactly the entities a typed patch will touch and restores by rewriting those
  values. Blender's global undo stack is user territory: a user Ctrl+Z that alters agent-touched
  state is simply another external edit caught by the observer/stale-base path. The add-on never
  calls `ed.undo`/`ed.undo_push` on the model's behalf.
- Long mutations run in timer-budgeted slices on the main thread (target ≤ 33 ms per tick) with
  `progress` frames per §4; a patch that cannot be sliced must declare it and hold the UI for a
  bounded, validated duration.

### 15.4 Deferred to the motion track (owners assigned)

- `analyze_motion(target, frame_range)` joins the internal bridge operations (§7): joint
  velocity/acceleration extrema, contact events, and quiet valleys computed with Blender's
  bundled NumPy; cut-placement preconditions consume its output.
- `docs/DIRECTING-RULES.md` becomes the normative rulebook that turns the research corpus into
  typed tool preconditions: cut placement at measured motion valleys, action peaks never split,
  reciprocal scale change per cut ≤ 1.35×, 45–52 mm framing band, axis/line state transitions.
- The evidence packet for visual observation (which render passes, proxy resolution, color
  management, and how images enter Pi tool results) is specified together with
  `assemble_preview`.
- The rig-mapping contract (HumanML3D/Mixamo skeleton → armature bone names) is specified with
  `generate_or_import_motion`, before any motion artifact is accepted.
