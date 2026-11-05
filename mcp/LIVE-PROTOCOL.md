# CozyClay live-control protocol v1

The MCP JSON-RPC endpoint deliberately negotiates only protocol version
`2025-11-25`. Older and draft tracks are rejected during `initialize`.

One WebSocket, JSON text frames. The **MCP server hosts** the socket
(`ws://127.0.0.1:5184/live`); the **editor is the client** and retries a lost
connection on capped exponential backoff while the page is open (1 s doubling
to a 15 s cap, +/-25 % jitter, reset by the `workspace` frame), and connects
immediately instead of waiting out that backoff when its tab or its network
comes back. Either side may be absent: the editor works exactly as before when
nothing is listening, and the MCP server falls back to its in-memory scene when
no editor is connected.

## Frames

editor -> server, once after connect:

    { "type": "hello", "role": "editor", "version": 1 }

server -> editor, once after `hello`:

    { "type": "workspace", "handle": "<workspace handle>", "heartbeatMs": 15000 }

The editor sends its stable per-tab `workspaceId` in `hello`, and that id **is**
the handle the hub issues: the same tab resumes the same handle after any
reconnect, which is what lets retained terminal motion outcomes and a terminal
controller's `--workspace` argument survive a reload or a hub restart. A hello
without an id still gets a random handle for that socket only. The handle is
valid exactly while its editor is connected: during the gap every command for it
fails `STALE_HANDLE`, and a second live socket claiming an id that is already
connected is closed 1008. The editor surfaces the handle to its operator.

`heartbeatMs` is the hub's ping interval (additive to v1; an older editor
ignores it). The hub pings every socket on that interval and drops any socket
that did not answer the previous ping, so a dead page never holds a workspace
id. An editor may also probe the hub at the application level:

    editor -> server:  { "type": "ping" }
    server -> editor:  { "type": "pong" }

server -> editor, one per command:

    { "type": "cmd", "id": "<opaque string>", "name": "<command>", "args": { ... } }

editor -> server, one per command, echoing `id`:

    { "type": "result", "id": "<same id>", "ok": true,  "value": { ... } }
    { "type": "result", "id": "<same id>", "ok": false, "error": "<human message>" }

Unknown `name` MUST answer `ok:false`, never silence. The server times a
command out after 5 s and treats it as failed, except `import_asset` and the
Studio commands (`inspect_studio`, `run_action`, `capture_framing_png`, ...),
which retain a dedicated 30 s editor bound. A timeout or disconnect during
a mutation is ambiguous: it may already have applied, so callers MUST NOT retry
blindly and should `describe` before recovering.

## Controller role

A controller is a local process (a terminal client), not a page. It connects to
the same socket and greets:

    { "type": "hello", "role": "controller", "version": 1, "token": "<hub token>" }

The token is the one in the hub's endpoint file,
`$XDG_CONFIG_HOME/cozyclay/live/<port>.json` (mode 0600, written by whichever
owner started the hub and removed when it closes). A hello without the right
token is closed 1008, and so is one that arrives with **any** `Origin` header:
a browser page can hold a loopback origin but can never read that file, so the
controller role stays with local processes. The hub answers an accepted hello:

    { "type": "ready", "role": "controller", "heartbeatMs": 15000, "server": { "port", "owner", "pid" } }

controller -> server:

    { "type": "cmd",    "id", "name", "args", "workspaceHandle"?, "timeoutMs"? }
    { "type": "tool",   "id", "name", "args", "workspaceHandle"? }
    { "type": "status", "id" }

`cmd` runs one protocol command through the same workspace resolution every
other transport uses (below). `timeoutMs` overrides that command's editor
timeout and is capped at 300 s. `tool` runs one registry tool — the same tool an
MCP client would call, with the same argument validation and the same
per-workspace exclusion — and is available only from an owner that has a tool
registry. `status` reports the hub itself:

    { "server": { "port", "owner", "pid" },
      "editors": [ { "handle", "workspaceId", "meta", "connectedAt", "lastSeenMs", "inFlight" } ] }

server -> controller, one per request, echoing `id`:

    { "type": "result", "id", "ok": true,  "value": { ... } }
    { "type": "result", "id", "ok": false, "error": { "code", "message", "recovery"?, "details"? } }

Every failure carries a stable `code`, so a client branches on the code and
never on the wording of the message: `TIMEOUT`, `UNCERTAIN_APPLY`, `NO_EDITOR`,
`AMBIGUOUS_WORKSPACE` (with `details.candidates`), `STALE_HANDLE`,
`EDITOR_ERROR`. Controllers also receive editor lifecycle events, so a client
can wait for an editor instead of polling:

    { "type": "event", "name": "editor_connected" | "editor_disconnected", "payload": { "handle", "workspaceId", "meta" } }

## Commands (v1)

All coordinates are metres, rotations are degrees of yaw, ids are the ids the
scene document already uses.

| name | args | value | notes |
| --- | --- | --- | --- |
| `ping` | `{}` | `{ "pong": true }` | liveness |
| `describe` | `{}` | `{ document, sceneName, previsMode, camera, stage, timeline, activeCharacterId, characters, objects }` | read the full live scene document plus active-scene convenience fields; the full `document` prevents one workspace's inactive scenes from leaking into another workspace's scene operations; `activeCharacterId` pins asynchronous work to the character selected when it started; `previsMode` (`"storyboard"` or `"animation"`, optional for older editors) is the project's previs mode, and a cast entry whose `model` is `proxy-figure` is a capsule figure that `describe_scene` reports as `kind: proxy` (otherwise `kind: rig`) |
| `capture_frame` | `{}` | `{ width: 640, height: 360, mimeType: "image/png", encoding: "base64", byteSize, data, assertions: { renderable, blackFrame, nonBlackPixels, behindCameraPlane, fartherAlongCameraForward, distanceToFloor, occludedBy, visiblePixelCount, characters } }` | leaves the authored document untouched, but is classified open-world/non-idempotent because an oversized PNG creates a mode-0600 managed temporary artifact. Character visibility and occlusion are computed from mounted engine geometry with bounded ray samples. Missing camera, black frame and compressed payloads above 1 MB fail explicitly. Inline responses honor `max_inline_bytes`; managed artifacts are capped at 20 and expire after 10 minutes. |
| `capture_framing_png` | `{ frame? }` | `{ dataUrl, width: 1920, height: 1080, frame, shotId }` | full-resolution PNG (data URL) of the CURRENT shot camera framing at the current timeline frame (with `frame`, that timeline frame as the video export renders it: cast posed and shot camera sampled there, then restored, so the playhead does not move; a frame outside the timeline fails), rendered through the same park-and-restore shot pipeline the editor's own exports use; `width`/`height` follow the shot aspect preset (1920x1080 at 16:9) and `shotId` names the shot under the playhead. The viewport and the authored document are untouched (idempotent read), and the editor's 640x360 `capture_frame` contract is unchanged. Fails while no shot camera is mounted (e.g. a cast model is still downloading). |
| `set_camera` | `{ x?, y?, z?, focalMm?, lookAtX?, lookAtY?, lookAtZ? }` | `{ camera }` | omitted fields keep their value; the **viewport must visibly move**. The `lookAt*` triple is additive to v1 and must arrive complete or not at all: given it, the editor aims the shot camera at that world point and records the resulting orientation as the camera's own (so the framing it commits is the one it just applied); without it the orientation is untouched, so an editor that ignores the fields degrades to the pre-aim behaviour instead of failing. `frame_shot` always sends the framing pivot, because the shot vocabulary (`deriveShot`, `captureFraming`) measures the shot as if the lens points at that pivot — a placed-but-unaimed camera reports a framing it is not holding. |
| `add_character` | `{ subject, x?, z?, rot?, model?, posture? }` | `{ id }` | `model` is one of the stable character model ids, or `proxy-figure` for a rigless capsule figure; `posture` (`stand`, `sit`, `lie`; `stand` when omitted) applies to a capsule figure |
| `update_character` | `{ ref, x?, y?, z?, rot?, subject?, hidden? }` | `{ id }` | `ref` = id, letter (`"A"`) or 1-based slot |
| `remove_character` | `{ ref }` | `{ id }` | must refuse to empty the cast |
| `place_object` | `{ kind, x?, z?, y?, rot?, name?, parent? }` | `{ id }` | `kind` from OBJECT_LIBRARY; optional `name` labels the object and optional `parent` attaches it under another object |
| `import_asset` | `{ name, mimeType, dataUrl, placeAs, clay?, x?, y?, z?, rot?, height? }` | `{ assetId, objectId }` | decode `dataUrl` and store the bytes in the content-addressed asset store under `assetId`, then stand the result up through the Studio's own import pipeline. `placeAs: "cutout"` is a 1.8 m standee 2.6 m in front of the shot camera; `placeAs: "backdrop"` is the same card as a 5 m background plate 12 m down the shot camera's view ray, turned to face the lens (PNG, WebP, JPEG or GIF; `dataUrl` must be `data:image/…`; `mimeType` optional when the data URL carries it). `placeAs: "mesh"` imports a GLB, a Wavefront OBJ or an FBX (`data:model/gltf-binary`, `data:model/obj`, `data:model/fbx`, `data:text/plain` when `name` ends in `.obj` or `.fbx`, or `data:application/octet-stream`, and those same types as `mimeType`), fits height/footprint once, and stands the model on the floor. Omit both `x` and `z` to place it in front of the shot camera; if either is present, those are world metres and the missing axis is 0. Optional `rot` is yaw in degrees (omitted is 0, like the Import button). Optional `height` overrides the fitted standing size. Optional `y` is lift off the floor, applied after mint (`createMeshObject` always writes `y: 0`). Optional `clay: true` replaces file materials with matte clay. Bytes decide the format (glTF magic first, then FBX magic/`FBXVersion:`, then OBJ vertices). Exactly ONE undo entry: a single Ctrl+Z removes the placed object (the asset bytes stay, being content-addressed). This deliberately does NOT reuse the Workflow-tab scene sync, which writes the document without touching undo. |
| `update_object` | `{ id, x?, y?, z?, rot?, rotX?, rotZ?, scale?, scaleX?, scaleY?, scaleZ?, color?, name?, height?, clay?, hidden? }` | `{ id }` | `scale` sets all three axes; per-axis values override it; `name` renames the object. `height` is metres (cutout card height, or a mesh's fitted box height). `clay` is a boolean on mesh objects (file materials when false, matte clay when true). `hidden` shows or hides the prop without deleting it. |
| `remove_object` | `{ id }` | `{ id }` | |
| `group_objects` | `{ parent, children }` | `{ parent, children }` | attach every child under parent |
| `ungroup_objects` | `{ children }` | `{ children }` | detach every child |
| `apply_batch` | `{ ops, atomic?: false, stopOnError?: true, label?: "MCP batch" }` | `{ label, applied: number[], failed: [{ index, error }], rolledBack }` | executes at most 100 object mutations as one undo entry. `atomic` and `stopOnError` are independent; atomic failure restores the pre-batch objects and creates no undo entry. Nested batches are rejected. v1 rejects character mutations because cast history is a separate store. |
| `load_scenes` | `{ document }` | `{ sceneName, activeSceneId, scenes: [{ id, name }] }` | replace the whole scene document (same shape `serializeSceneDocument` emits); the response attests the full scene list and active scene for `add_scene` and `switch_scene` parity |

### Previs mode and character kind in the Studio context

`inspect_studio` returns the `studio-context-v1` context that every `run_action`
is admitted against. Two parts of it describe what a project and its cast can do:

| field | value | meaning |
| --- | --- | --- |
| `scene.previsMode` | `"storyboard"` \| `"animation"` | the project's previs mode; optional for older editors |
| `capabilities.storyboard` | boolean | `true` exactly when `scene.previsMode` is `storyboard` |
| `entities[].characterKind` | `"rig"` \| `"proxy"` | a rigged model, or a rigless capsule figure (`model: "proxy-figure"`) |
| `entities[].posture` | `"stand"` \| `"sit"` \| `"lie"` | a capsule figure's posture; absent for a rig |

Before an animation-only tool runs, the server reads these fields from the
context it admits the command against (`mark_camera_move`, which sends no
command, reads `previsMode` from `describe`). In a storyboard project
`mark_camera_move` answers `{ ok: false, code: "NOT_IN_MODE", reason }` and sends
no command. The editor's own motion, take, IK and pose commands refuse a capsule
figure with `TARGET_NOT_READY`, so `studio_run` reaches that answer.

## Hard rules for the editor side

- Every mutation MUST go through the same React state paths the UI itself
  uses (the setters/reducers the gizmo, inspector and panels call). Mutating
  three.js objects directly is forbidden: anything outside React state is
  overwritten on the next render.
- Every mutation MUST land in undo history exactly like the equivalent UI
  action would, or be explicitly documented as not undoable.
- The socket client MUST be a no-op in production builds unless explicitly
  enabled; in dev it may always try. A failed connection must never surface
  an error to the user - silence and retry.
- An editor that sees `heartbeatMs` in its `workspace` frame sends `ping` every
  20 s and drops the socket when no `pong` arrives within 10 s; it decides on
  elapsed time, never on timer order, so a stalled main thread (a 30 s
  `capture_frame`) is not mistaken for a dead hub. A hub that advertises no
  `heartbeatMs` gets no application-level pings.

## Workspace routing

The hub allows multiple editor instances at once; it never displaces an existing
editor for a newer connection. `live_status` lists every current workspace
handle. Every MCP tool that reads or mutates a live editor accepts `workspace_handle`.
When exactly one editor is connected, omitting it selects that editor. With two
or more editors, omitting it fails before dispatch and enumerates every candidate
handle. An unknown or disconnected handle fails as unknown or stale and is never
routed to another editor. The hub owns this resolution rule for every transport —
MCP tools, agent commands and terminal controllers alike; there is no
last-active, heartbeat, focus, or recency fallback. The heartbeat only decides
whether a socket is still alive; it never decides which workspace a command
reaches.

A handle is the editor's own stable workspace id, so a handle a client learned
before a reload still names the same tab afterwards. That is a naming contract,
not a routing one: while the tab is away its handle resolves to nothing and
fails `STALE_HANDLE`, and the id is never reassigned to a different editor.

## Hard rules for the server side

- When an editor is connected, live-capable tools forward to the workspace
  selected by the rules above and answer from that workspace's `describe`; when
  none is connected they fall back to the in-memory scene exactly as today.
- `add_scene` and `switch_scene` forward the complete scene document through
  `load_scenes` and verify it through `describe` before reporting success. They
  never succeed while the MCP server and selected editor have different scene
  lists. Without an editor they retain the in-memory fallback.
- A live mutation may only target the explicitly selected workspace, except for
  the exactly-one-editor auto-selection case. Ambiguity is an error, never a
guess.

Browser editor connections are accepted only from loopback HTTP origins, and a
stable workspace id may have only one live socket. Native loopback clients have
no Origin header and remain part of the trusted-local MCP boundary.
- Any bounded MCP read reports `total`, `returned`, `truncated`, and a
  `revision`. Omitted entries must be reachable by an explicit selector or
  cursor; `describe_scene` uses `character_cursor` and `object_cursor`.
