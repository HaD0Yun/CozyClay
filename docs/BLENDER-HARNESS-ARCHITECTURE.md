# Oh My Blender — Bootstrap Architecture

Status: Phase 1 read-only vertical slice implemented

Pi baseline: `earendil-works/pi@f7e060374541be0097ee015aaddb097a4f760984`

Reference: `can1357/oh-my-pi@c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4`

## Current executable slice

The repository now proves one real boundary end to end:

```text
Blender 5.1 scene → typed scene snapshot → stable revision → Pi AgentSession → inspect_project
```

Run it with a temporary manifest:

```bash
blender --background --factory-startup \
  --python scripts/export_blender_fixture.py -- --output /tmp/omb-scene.json
npm --prefix packages/director-runtime run demo -- --manifest /tmp/omb-scene.json
```

This slice is intentionally read-only. It proves Blender extraction, boundary validation, deterministic revisioning, Pi embedding, and a deny-by-default tool surface before mutation, daemon, or UI work begins.

## 1. Decision

Oh My Blender is a private Pi fork that becomes a Blender-specific directing harness.

We will preserve Pi's model, agent, session, extension, and cancellation machinery. We will add a product-owned Director state machine, a small Blender tool surface, a local Blender add-on, and an observation/revision loop.

We will not fork Blender. We will not begin by rewriting Pi core. The first implementation stays in new packages and uses Pi's stable `createAgentSession()` embedding API. A Pi-core patch is allowed only after a failing vertical-slice test proves that the public SDK cannot support a required lifecycle.

Real-world analogy: Pi is the engine and transmission, Blender is the film set, and Oh My Blender is the director's control room. `oh-my-pi` is useful as a reference for turning an engine into a product, but copying its entire workshop would bring in tools we do not need.

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

Oh My Blender begins with one bundled domain plugin and one local Blender add-on.

## 4. Runtime architecture

```text
Blender UI
  Oh My Blender Python Add-on
    viewport/timeline context · user selection · undo checkpoint
                         ⇅ local authenticated WebSocket
Oh My Blender daemon (Node/TypeScript)
  Director Runtime
    Pi AgentSession · domain prompt · Blender tools only
  Director Core
    project state · revisions · beats · shots · approvals
  Blender Bridge
    protocol · transactions · observers · artifact transfer
                         ⇅ optional adapters
  ARDY body motion · ffmpeg · headless Blender QA/render
```

### Process boundary

- The Blender add-on owns exactly one daemon child. It starts `omb daemon --port 0`, reads exactly one UTF-8 JSON line of at most 4 KiB from stdout within 10 seconds, and treats any preceding bytes, extra fields, duplicate record, malformed value, timeout, or early exit as startup failure. Stdout is reserved for this record; all diagnostics go to stderr.
- The startup record is exactly `{type:"omb_daemon_ready", protocol:1, port, pid, launch_id, bearer_token, expires_in_ms:10000}`. `port` is the OS-assigned loopback port; `pid` must match the child; `launch_id` is a lowercase UUIDv4; `bearer_token` is unpadded base64url for 32 random bytes. Unknown fields are rejected so protocol additions require a version change.
- The daemon binds IPv4 `127.0.0.1` only. It does not bind wildcard or IPv6 addresses in v1.
- After a valid `hello`, the daemon creates Pi with `noTools: "all"`, an explicit Blender-domain tool list, an isolated `cwd`/`agentDir`/`SessionManager`, and a product-owned `BundledDirectorResourceLoader`.
- `BundledDirectorResourceLoader` returns only audited Oh My Blender prompts and factories. It never constructs or delegates to `DefaultResourceLoader`, `SettingsManager`, or a package manager and never scans user/project extensions, skills, themes, prompt templates, context files, packages, or MCP configuration.
- `BundledDirectorResourceLoader.extendResources()` accepts only an empty request and otherwise throws `RESOURCE_EXTENSION_DENIED`. `reload()` discards its current snapshot and rebuilds the same compiled-in bundle without filesystem discovery. Startup and every reload assert that the effective prompt digest and tool names exactly match the compiled allowlist.
- V1 creates one `AgentSession` directly and does not instantiate `AgentSessionRuntime`. New-session, resume, fork, import, and switch operations are not registered as product commands. Any attempted protocol call returns `METHOD_NOT_ALLOWED`; a future replacement path must call the same product-owned session factory, create a fresh `BundledDirectorResourceLoader`, and re-run the allowlist assertion before publishing the replacement.
- The 32-byte bearer token authenticates one daemon launch and one WebSocket only. It is transferred only in the startup record, retained in mutable memory, never written to project/session files or logs, expires 10 seconds after record emission, and is consumed and zeroed immediately after the first successful upgrade. Failed authentication does not extend the expiry. No second client or second socket is accepted.
- The add-on executes `bpy` operations on Blender's main thread through registered operators/timers.
- The daemon never injects arbitrary Python into Blender.
- Headless render workers consume immutable revision artifacts; they do not edit the live scene.
- Daemon states are `starting → awaiting_client → active → draining → stopped`. Failure to authenticate before token expiry exits. Normal add-on unload sends `shutdown`, enters `draining`, and waits up to 8 seconds before force-killing the child. Unexpected socket loss also enters `draining`; v1 never resumes a dropped connection in place.

### Protocol v1

- The HTTP WebSocket upgrade must carry `Authorization: Bearer <token>`, exact `Host: 127.0.0.1:<port>`, and either no `Origin` or `Origin: http://127.0.0.1:<port>`; otherwise the daemon returns HTTP `403` without upgrading and closes the TCP connection. An upgraded socket that violates application handshake policy closes with WebSocket code `1008`.
- The first application message must be `hello` within 3 seconds: `{type:"hello", protocol:1, addon_version, blender_version, project_id, client_nonce}`. `client_nonce` is unpadded base64url for 16 random bytes, is scoped to `launch_id`, and is valid only for that launch's lifetime; reuse within that launch closes with `1008`.
- The daemon replies once with `{type:"hello_ack", protocol:1, daemon_version, launch_id, session_id, server_nonce, capabilities}`. `session_id` is a fresh lowercase UUIDv4 for this Pi session and `server_nonce` is a fresh 16-byte base64url value valid only for the launch. A protocol, project, or supported-version mismatch closes before creating Pi or inspecting the scene.
- Requests are `{type:"request", id, method, params, expected_revision_id, deadline_ms}`. `id` is a lowercase UUIDv4 unique for the launch. `deadline_ms` is a required relative work budget measured with a monotonic clock from validated receipt until success becomes eligible to commit; allowed values are integer `100..30000`, with larger or smaller values rejected as `INVALID_DEADLINE`. Expiry prevents commit and begins cancellation. Safety rollback and terminal error delivery may exceed the request budget but must finish inside the daemon's separate 8-second drain budget.
- Progress is `{type:"progress", id, phase, completed, total}`. A terminal success is `{type:"response", id, result, resulting_revision_id}`. A terminal failure is `{type:"error", id, code, message, retryable}`.
- Cancellation is `{type:"cancel", id}` and receives exactly one `{type:"cancel_ack", id, status}` where status is `accepted`, `already_terminal`, or `unknown`. The acknowledgement is emitted before awaiting Pi or Blender cleanup and within 100 ms of receipt. `accepted` means the request won the terminal-state compare-and-swap, its abort signal was raised, any Blender checkpoint is being restored, and no success response may follow; after rollback it ends with `error.code="CANCELLED"`.
- Successful live-socket rollback reports `{type:"rollback_ack", id, status:"restored", state_hash}`; failure reports `status:"failed"` and no revision commits. Add-on unload sends `{type:"shutdown", reason:"addon_unload"}`; after request cancellation, rollback, and Pi disposal the daemon sends `{type:"shutdown_ack"}` and closes with `1000`. `{type:"ping", nonce}` receives `{type:"pong", nonce}` but does not affect deadlines.
- Each request owns one atomic state `running | completing | cancelling | terminal`. Response completion, deadline expiry, explicit cancel, disconnect, and shutdown race through one compare-and-swap. The first transition out of `running` wins; losers observe `already_terminal` and cannot emit another terminal message. Timeout follows the same path as cancellation but ends with `TIMEOUT`.
- The daemon permits one active request and no server-side request queue. A second request receives `BUSY`. A token-bucket rate limit allows a burst of 4 accepted requests and refills at 1 request per second; rejected, malformed, and `BUSY` requests still consume a token, while `cancel`, `ping`, and `shutdown` do not. Exhaustion returns `RATE_LIMITED`.
- Maximum JSON message size is 1 MiB. Binary artifact frames are at most 16 MiB and are accepted only inside an already-authorized artifact upload. Idle sockets close after 60 seconds; ping/pong does not extend request deadlines.
- The add-on, not the socket, owns the Blender checkpoint. For every mutation it retains the checkpoint handle and pre-state hash in local memory until terminal commit. On explicit cancel or normal shutdown, the daemon raises bridge/Pi abort signals and the add-on restores and verifies before sending `rollback_ack`. On unexpected socket loss, the add-on's registered main-thread timer independently restores and verifies without waiting for the daemon. A failed verification leaves the add-on disconnected, exposes no model tools, commits no revision, and requires user recovery from the saved `.blend` or Blender undo history.
- Daemon cleanup order is: stop accepting messages, win cancellation for the active request, start bridge abort, `await session.abort()` for at most 5 seconds, await `rollback_ack` only while the socket remains usable, unsubscribe listeners, call `session.dispose()` exactly once even if abort failed, close the socket/server, delete temporary session/artifact directories, zero remaining nonce/token buffers, and exit. The add-on force-kills only after the daemon's 8-second drain budget expires; its own checkpoint restoration remains independent of child exit.
- “Reconnect” in v1 means a full child restart after the add-on's local rollback completes: wait for the old child to exit, start a new daemon, read a new startup record/token, create a new socket and Pi session, then re-inspect and require the live scene hash to equal the canonical current revision. Pending IDs are terminal locally and are never replayed.

Pi's JSONL RPC remains a useful diagnostic/fallback interface, but the product daemon embeds `createAgentSession()` directly because the Blender bridge requires bidirectional tool calls and app-owned state. [Pi embedding guide](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/coding-agent/docs/sdk.md#L44-L178), [Pi RPC](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/coding-agent/docs/rpc.md#L1-L37)

## 5. Repository boundaries

New code should enter through these product-owned areas:

```text
apps/omb-daemon/             process lifecycle and protocol host
packages/director-core/      canonical state and revision rules
packages/director-runtime/   Pi adapter, prompts, tool middleware
packages/blender-protocol/   versioned JSON schemas and messages
packages/blender-tools/      model-facing domain operations
blender-addon/oh_my_blender/ Blender panels, operators, observers
docs/                        architecture and upstream-sync notes
```

Ownership is behavioral, not merely directory naming:

| Area | Owns | Must not own |
| --- | --- | --- |
| `apps/omb-daemon` | child lifecycle, startup record, WebSocket state machine, request arbitration | scene schemas, revision/hash rules, model-facing tool definitions |
| `packages/director-core` | project/revision persistence, stable identity, canonical serialization, scene/artifact hashes, artifact store | Pi APIs or WebSocket transport |
| `packages/director-runtime` | the sole `createAgentSession()` adapter, `BundledDirectorResourceLoader`, bundled prompt, Pi event/cancel/dispose wiring | Blender extraction or canonical state rules |
| `packages/blender-protocol` | protocol/message schemas and generated TypeScript/Python fixtures | daemon lifecycle or tool execution |
| `packages/blender-tools` | `inspect_project` and later model-facing tool definitions; typed calls into the bridge | WebSocket authentication or Pi session construction |
| `blender-addon/oh_my_blender` | explicit project initialization, Blender main-thread extraction, undo/checkpoint/rollback, daemon child ownership | model/provider logic |

Canonical serialization, hashing, and manifest construction live in `packages/director-core`; `packages/blender-protocol` is schema-only and must not implement those behaviors.

The first implementation updates the root `workspaces` list, root build/check/test scripts, and TypeScript project references so every new TypeScript package is covered by the existing toolchain. `blender-addon/` is checked independently by Blender's bundled Python and a small host-side test environment.

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

Storage for v1:

- `.omb/project.json`: atomically replaced current index;
- `.omb/journal.jsonl`: append-only operations and decisions;
- `.omb/artifacts/<sha256>/`: previews, manifests, motion, and render outputs;
- the Pi session stores reasoning provenance plus project/revision IDs only.

### Stable identity and hashing

- Before the first connection, the user runs the add-on's explicit `Initialize Project` operator. In one Blender undo transaction it creates a lowercase UUIDv4 `project_id`, stores it both as the scene custom property `omb.project_id` and in `.omb/project.json`, and assigns lowercase UUIDv4 `omb.entity_id` properties to every local object and every bone. The two persisted project IDs must match on every connection. Camera, light, and armature identities use their owning object ID; bones use their own bone property.
- Initialization is the only write in Phase 1 and is never model-triggered. It marks the `.blend` dirty and connection is refused until the user saves it. Later inspection is read-only and refuses missing, malformed, or duplicate IDs rather than generating them lazily. Linked/library data without writable persistent IDs is `UNSUPPORTED_LINKED_DATABLOCK` in v1.
- Blender duplication can copy custom properties. The add-on observer records IDs known before the dependency-graph update; an existing entity keeps its ID and every newly observed duplicate receives a new UUIDv4 in one undoable metadata transaction. On file-open ambiguity, `Repair IDs` keeps the first entity in Blender's serialized data-block order and reassigns later duplicates, writes one journal entry, marks the file dirty, and requires an explicit save before reconnect.
- `project_id` never derives from a path or filename. Entity IDs never derive from display names, Blender paths, array positions, or memory addresses. Once persisted they do not change on rename, reparent, reorder, save-as, or daemon restart.
- `SceneManifestV1` is normalized before hashing. Object and bone arrays sort by stable ID; selected-ID sets sort by stable ID; maps sort keys by Unicode code-point order; semantically ordered arrays such as keyframes sort by rational frame time then stable ID. Strings are Unicode NFC. Integers use base-10 without leading zeros. Booleans and null use JSON literals.
- Every finite binary64 scene number is interpreted from its exact IEEE-754 bits, then converted for the hash preimage to a decimal string rounded half-even to `1e-9`; trailing fractional zeros are removed and `-0` becomes `"0"`. Language-native `round()` is not the contract. NaN and infinities are schema errors. Frame rate and time remain reduced integer rationals and are never converted to floats.
- Canonical JSON uses UTF-8, no insignificant whitespace, and the normalization rules above. `scene_hash` is lowercase hex SHA-256 of those bytes, excluding volatile transport fields (`request id`, nonces, progress, wall-clock timestamps) but including stable IDs, hierarchy, transforms, frame/timebase, camera/light/render state, and display names.
- The initial `revision_id` is lowercase hex SHA-256 of `omb-revision-v1\0 + project_id + "\0" + scene_hash`. A child revision hashes `omb-revision-v1\0 + project_id + "\0" + parent_revision_id + "\0" + canonical_operation_json + "\0" + resulting_scene_hash + "\0" + canonical_dependency_hashes`. Creation timestamps are persisted but excluded from IDs. `.omb/project.json` and `.omb/journal.jsonl` persist every accepted revision before it is exposed as current.

### Artifact boundary

- The only allowed `ArtifactRef.uri` form is `omb-artifact://sha256/<digest>`, where `<digest>` is exactly 64 lowercase hexadecimal characters and must equal `ArtifactRef.sha256`. `file:`, `http:`, `https:`, `data:`, `blob:`, UNC paths, absolute/relative paths, percent encoding, query strings, fragments, extra path segments, and dot segments are rejected.
- Each upload declares byte length and expected digest before its first chunk. One artifact payload may be at most 512 MiB; committed artifact storage plus active reservations may be at most 20 GiB per project; at most two uploads and 1 GiB of reservations may be active. Accounting counts every committed regular-file byte below `.omb/artifacts` plus declared bytes reserved by active uploads under one project lock. A digest already verified in the store consumes no new reservation.
- Binary frames are at most 16 MiB. The daemon streams them directly to an exclusive temporary file while incrementally counting bytes and computing SHA-256; it never buffers the payload as one allocation. Exceeding the declared length, any quota, or the exact declared byte count aborts the upload and removes the temporary file. Commit requires the streamed digest to equal the URI digest.
- The artifact store is directory-descriptor anchored. It opens the project directory, `.omb`, `.omb/artifacts`, and `.tmp` using `openat` with `O_DIRECTORY|O_NOFOLLOW`; each component must be a non-symlink directory on the same filesystem and owned by the current user. It creates a `0600` temporary file with 128 random bits, `openat(O_CREAT|O_EXCL|O_NOFOLLOW)`, then verifies with `fstat` that it is regular and has link count 1.
- After streaming, the store `fsync`s the temporary file, creates/opens the digest directory with `mkdirat`/`openat(O_DIRECTORY|O_NOFOLLOW)`, and publishes the fixed leaf name `payload` with no-replace semantics (`renameatx_np(RENAME_EXCL)` on macOS or `renameat2(RENAME_NOREPLACE)` on Linux). A platform without equivalent directory-relative no-replace operations fails closed; path-string canonicalize-then-write is not an accepted fallback.
- Before updating `.omb/project.json`, the store reopens `payload` with `openat(O_NOFOLLOW)`, compares its device/inode to the temporary file's final `fstat`, and verifies that each directory descriptor still matches its parent entry using `fstatat(AT_SYMLINK_NOFOLLOW)`. Any symlink, non-regular file, owner/device/inode change, extra hard link, or replaced directory aborts the commit and leaves the revision unchanged.
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

## 10. MVP delivery sequence

### Phase 1 — Connection skeleton

- add `packages/blender-protocol`, `packages/director-core`, `packages/director-runtime`, `packages/blender-tools`, `apps/omb-daemon`, and `blender-addon/oh_my_blender` plus root workspace/build/check/test references without editing Pi core;
- initialize and save stable project/object/bone IDs, then persist the initial canonical revision/hash;
- run `omb daemon` and connect the Blender add-on;
- return a versioned scene manifest;
- prove malformed/expired/consumed authentication, protocol mismatch, second-client rejection, add-on-owned disconnect rollback, both outcomes of the cancel-vs-response race, cancel acknowledgement, deadline expiry, rate/in-flight limits, teardown order, and restart-based reconnect;
- prove hostile local Pi resources are ignored at startup, extension attempt, reload, and session-factory replacement.

Exit: after explicit local identity initialization, Blender can ask the daemon through a real Pi tool turn to inspect a scene, and the model has no scene-mutation operation.

The read-only `SceneManifestV1` contains `project_id`, `revision_id`, Blender version, scene name, rational frame range/fps, active camera ID, render resolution/aspect, object IDs/names/types/parent IDs/transforms, armature and bone IDs/names/parents/transforms, cameras, lights, selected IDs, and the deterministic `scene_hash` defined above. It contains no arbitrary file contents or path-derived identities.

### Phase 2 — Transactional scene tools

- implement typed inspection and camera/light/render patches;
- implement undo checkpoint, stale revision rejection, and rollback;
- store journal entries and content-addressed artifacts.

Exit: a failed or cancelled operation leaves the scene byte-for-byte or state-hash equivalent to its checkpoint.

### Phase 3 — Directing vertical slice

- compile one natural-language brief into beats and three camera shots;
- import the existing ARDY boxing motion;
- apply the reusable fist pose as a separate hand track;
- create a 24 fps proxy preview.

Exit: the user provides no bone names, coordinates, or `bpy` code.

### Phase 4 — Inspect and revise

- show final aspect mask in Blender during editing;
- inspect coordinates plus RGB/depth/ID evidence;
- revise one frame range or track while locked hashes remain unchanged;
- attach plan and shot approval to exact revisions.

Exit: "second punch only" and "camera only" revisions preserve all unrelated approved artifacts.

### Phase 5 — Product shell

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

- `origin`: private `HaD0Yun/oh-my-blender`;
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

## 14. First implementation commit

The next approved work unit should add only:

1. `packages/blender-protocol`: exact startup/handshake/request/cancel/manifest schemas and shared fixtures;
2. `packages/director-core`: identity validation, canonical manifest serialization, `scene_hash`/initial `revision_id`, and atomic `.omb/project.json`/journal persistence;
3. `packages/blender-tools`: the only model-facing tool, `inspect_project`, as a session-bound factory that calls the typed Blender bridge;
4. `packages/director-runtime`: `createDirectorSession()`, `BundledDirectorResourceLoader`, bundled prompt, Pi event/cancel/dispose wiring, and the exact `inspect_project` allowlist;
5. `apps/omb-daemon`: child/startup/WebSocket lifecycle and routing only;
6. `blender-addon/oh_my_blender`: explicit identity initialization, child ownership, connect/disconnect, main-thread manifest extraction, and checkpoint verification;
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
npm run test:omb-roundtrip
```

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
  `omb-artifact://sha256/<digest>` motion artifacts per §6; the manifest stores per-entity
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
