# Oh My Blender — Bootstrap Architecture

Status: implementation-ready plan, no product code yet

Pi baseline: `earendil-works/pi@f7e060374541be0097ee015aaddb097a4f760984`

Reference: `can1357/oh-my-pi@c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4`

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

The coding-agent SDK supports custom tools, custom resource loading, explicit session storage, tool allowlists, event subscriptions, cancellation, steering, and session replacement. Extensions can intercept tool calls and persist custom entries. These are the seams required for a Blender harness. [Pi packages](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/README.md#L13-L34), [Pi SDK](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/coding-agent/src/core/sdk.ts#L33-L90), [Pi Extension API](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/coding-agent/src/core/extensions/types.ts#L1166-L1260)

Pi's lower-level `AgentHarness` is promising, but current coding-agent sessions still run through `AgentSession`. Therefore v1 uses the stable coding-agent SDK rather than depending on an unfinished migration path. [AgentHarness options](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/agent/src/harness/types.ts#L800-L836), [current migration note](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/agent/docs/models.md#L763-L795)

## 3. What to learn from oh-my-pi

`oh-my-pi` is a deep product fork, not a small extension. Its useful lesson is architectural discipline, not feature count.

Adopt these patterns:

1. **Capability provenance.** Every capability records where it came from and uses deterministic collision rules. [Capability registry](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/packages/coding-agent/src/capability/index.ts#L52-L204)
2. **One tool middleware.** Approval, pre-hook, execution, post-hook, logging, timeout, and error normalization wrap every tool in one place. [Tool wrapper](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/packages/coding-agent/src/extensibility/extensions/wrapper.ts#L122-L220)
3. **Config precedence.** Defaults, user config, project config, CLI overlay, then runtime override. [Config precedence](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/docs/config-usage.md#L146-L171)
4. **Discovery and binding are separate.** Discover a tool once, then bind it to each session so state cannot leak between sessions. [Custom tool binding](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/packages/coding-agent/src/extensibility/custom-tools/loader.ts#L238-L271)
5. **Append-only operational history.** Conversation, decisions, tool results, and binary artifacts do not share one mutable file. [Session storage](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/docs/session.md#L33-L70)
6. **Versioned onboarding and migration.** Setup steps run only when the stored product schema requires them. [Setup wizard](https://github.com/can1357/oh-my-pi/blob/c0d0ad7629ebc895237e9ccc1f45008bd23bdaa4/packages/coding-agent/src/modes/setup-wizard/index.ts#L61-L97)

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

- The Blender add-on owns the daemon process. It starts `omb daemon --port 0`, reads one startup record from stdout, and terminates the child when the add-on unloads.
- The daemon binds IPv4 `127.0.0.1` only. It does not bind wildcard or IPv6 addresses in v1.
- The daemon creates Pi with `noTools: "all"`, an explicit Blender-domain tool list, an isolated `cwd`/`agentDir`/`SessionManager`, and a product-owned `BundledDirectorResourceLoader`.
- `BundledDirectorResourceLoader` returns only audited Oh My Blender prompts and factories. It does not scan user or project extensions, skills, themes, prompt templates, context files, packages, or MCP configuration.
- Startup asserts that the effective tool set exactly matches the bundled allowlist; a hostile `.pi` directory must not change it.
- A 32-byte `crypto.randomBytes()` token authenticates one daemon launch. It is transferred only in the parent-owned startup pipe, retained in memory, never written to project files or logs, and zeroed on shutdown.
- The add-on executes `bpy` operations on Blender's main thread through registered operators/timers.
- The daemon never injects arbitrary Python into Blender.
- Headless render workers consume immutable revision artifacts; they do not edit the live scene.

### Protocol v1

- The first WebSocket request must include the bearer token, `Host: 127.0.0.1:<port>`, and an absent or explicitly allowlisted local `Origin`; otherwise the socket closes with policy error `1008`.
- `hello`: `{protocol, addon_version, blender_version, project_id, client_nonce}`.
- `hello_ack`: `{protocol, daemon_version, session_id, server_nonce, capabilities}`.
- `request`: `{id, method, params, expected_revision_id, deadline_ms}`.
- `progress`: `{id, phase, completed, total}`.
- `response`: `{id, result, resulting_revision_id}`.
- `error`: `{id, code, message, retryable}`.
- `cancel`: `{id}`; acknowledgement is required before the deadline.
- IDs and nonces are unique per connection; replayed IDs are rejected. Maximum JSON message size is 1 MiB, maximum binary artifact frame is 16 MiB, and idle sockets close after 60 seconds.
- Protocol mismatch closes before scene inspection. Reconnect creates a new token, socket, and session; pending requests fail rather than replay automatically.

Pi's JSONL RPC remains a useful diagnostic/fallback interface, but the product daemon embeds `createAgentSession()` directly because the Blender bridge requires bidirectional tool calls and app-owned state. [Pi embedding guide](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/coding-agent/docs/sdk.md#L44-L178), [Pi RPC](https://github.com/earendil-works/pi/blob/f7e060374541be0097ee015aaddb097a4f760984/packages/coding-agent/docs/rpc.md#L1-L37)

## 5. Repository boundaries

New code should enter through these product-owned areas:

```text
apps/omb-daemon/             process lifecycle and Pi embedding
packages/director-core/      canonical state and revision rules
packages/director-runtime/   Pi adapter, prompts, tool middleware
packages/blender-protocol/   versioned JSON schemas and messages
packages/blender-tools/      model-facing domain operations
blender-addon/oh_my_blender/ Blender panels, operators, observers
docs/                        architecture and upstream-sync notes
```

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

Artifact paths are resolved beneath the project-owned `.omb/artifacts` root after canonicalization. Symlinks and traversal are rejected, writes use a temporary file plus atomic rename, the computed SHA-256 must match the requested artifact ID, and per-file/project quotas are enforced before commit. Imported `.blend` files open with automatic Python execution disabled.

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

The deny-by-default resource loader is part of the security boundary, not an optimization. A regression fixture places a hostile project extension, skill, prompt, context file, package declaration, and MCP config beside the test scene; startup must still expose only `inspect_project` and the bundled system prompt.

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

- add the new workspaces plus root workspace/build/check/test references without editing Pi core;
- run `omb daemon` and connect the Blender add-on;
- return a versioned scene manifest;
- prove authentication failure, protocol mismatch, disconnect, cancel, timeout, and reconnect behavior;
- prove hostile local Pi resources are ignored.

Exit: Blender can ask the daemon to inspect a scene, and no scene mutation is possible yet.

The read-only `SceneManifestV1` contains `project_id`, `revision_id`, Blender version, scene name, frame range/fps, active camera ID, render resolution/aspect, object IDs/types/parent IDs, armature and bone IDs, cameras, lights, selected IDs, and deterministic scene hash. It contains no arbitrary file contents.

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

1. `packages/blender-protocol` with handshake and scene-manifest schemas;
2. `apps/omb-daemon` with a Pi session that exposes `inspect_project` only;
3. `blender-addon/oh_my_blender` with connect/disconnect and read-only scene inspection;
4. one integration scenario proving Blender → daemon → Pi tool → Blender round-trip;
5. teardown proof showing no daemon, socket, or Blender timer remains.

The round-trip test injects a deterministic fake model/session factory, so it needs no provider key and always emits one `inspect_project` tool call. The test launches the daemon on an OS-assigned port, performs authenticated `hello`, requests the manifest, cancels one delayed request, disconnects, unloads the add-on, and asserts:

- child process exited;
- TCP connection to the assigned port is refused;
- no Blender timer or handler remains registered;
- no token or startup record remains on disk;
- temporary project/session/artifact directories are absent;
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
