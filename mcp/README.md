# CozyClay MCP server

Lets an AI assistant (Claude Desktop, Cursor, any MCP client) block a scene, place the camera,
compile character motion and read the shot back as film vocabulary — then turn it into an AI
image/video prompt.

Works two ways, with one tool catalog:

- **Editor open** — tool calls drive the visible viewport live: camera, cast, set and the
  compiled motion on the timeline (`studio_run` with `motion.compile`).
- **No editor** — scene, camera, prompt and project-file tools run in memory with no browser,
  GPU or build step. `capture_frame`, `apply_batch`, `import_mesh`, `studio_commands` and
  `studio_run` explicitly require a live editor.

## Run it locally

```sh
cd mcp
npm install
npm start          # speaks MCP over stdio and hosts ws://127.0.0.1:5184/live
npm run verify     # drives the no-editor fallback as a client and checks results
npm run verify:live # drives a fake editor over the live WebSocket protocol
```

Then point a client at it. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cozyclay": {
      "command": "node",
      "args": ["/absolute/path/to/CozyClay/mcp/server.mjs"]
    }
  }
}
```

Restart the client; 27 tools appear.

Prefer a long-lived endpoint? `node server.mjs --http 5183` serves Streamable HTTP at
`http://127.0.0.1:5183/mcp` (one isolated session per client), with a plain status page at `/`.

## What it does

Describe the shot you want. The server does the trigonometry and answers the way a crew would.

> "Put a detective and a courier in an alley, then give me a low wide profile shot of the courier."

```
WIDE SHOT · RIGHT PROFILE · KNEE LEVEL · 24MM

size      wide shot — the subject fills 40% of frame height
view      a right-side profile view
level     a low knee-level angle looking up at the subject
distance  4.39m
...
```

(Abbreviated: the full answer also carries `lens` and `elevation` lines and a closing
`texture guidance` line.)

`render_prompt` turns that same geometry into a prompt that carries the real framing, so the
generated frame matches the blocking instead of drifting off into a generic shot.

## Tools

| tool | what it does |
| --- | --- |
| `describe_scene` | the whole state: camera, framing, cast, set |
| `live_status` | whether an editor tab is connected for live control |
| `describe_shot` | current camera geometry as film vocabulary |
| `capture_frame` | a compressed live render with camera-plane, visibility and occlusion assertions |
| `set_camera` | move the lens / change focal length directly |
| `frame_shot` | frame by intent — size, view, level, side |
| `add_character` / `place_character` / `remove_character` | the cast (`add_character { model: "proxy-figure", posture: "stand" \| "sit" \| "lie" }` adds a rigless capsule figure) |
| `focus_character` | choose who the camera frames |
| `place_object` / `update_object` / `remove_object` | the set — `place_object` also accepts `name` and `parent`, so multi-part assets like "Building A" land as one named assembly |
| `import_mesh` | load a local GLB, OBJ or FBX from a filesystem path as a mesh prop (live editor required); optional floor position, yaw, standing height, clay |
| `sculpt_object` | build a clay prop from a recipe of soft parts (blob, box, cylinder, torus, frame), usually from a reference image; pass `id` with `recipe` to re-sculpt or with `edits` to patch parts; `capture: true` returns the frame too. Works without an editor. Contract: `docs/sculpt-from-image.md` |
| `compare_sculpt` | score a sculpt's silhouette against its reference image (PNG/JPEG path): IoU, proportion delta, missing area by height band, parts that stick out, and a reference \| overlay sheet; `views` [{ yaw, reference, weight? }] scores several views (front 0.6, side 0.25, back 0.15 by default) in place of `reference`; `candidates` ranks up to 12 edit sets without applying any. Works without an editor |
| `group_objects` | attach children to a parent so they move as one; pass `parent: null` to detach |
| `apply_batch` | execute up to 100 object mutations as one user-visible undo transaction |
| `render_prompt` | the shot as an AI image or video prompt |
| `mark_camera_move` / `describe_camera_move` | name a move between two camera positions |
| `add_scene` / `switch_scene` | multiple scenes per project |
| `open_project` / `save_project` | read and write `.cclayproject` files |

Project file tools are restricted to `COZYCLAY_PROJECT_ROOT` (the server
working directory by default), accept direct child `.cclayproject` files only,
anchor relative opens to the retained project-root working-directory inode, reject symlink escapes,
open the final name with `O_NOFOLLOW`, and require
`overwrite: true` before replacing an existing regular file.

Coordinates are metres (`x` right, `z` toward the default camera, `y` height above the floor).
Rotations are degrees of yaw. Characters are addressed by letter (`"A"`), slot (`"2"`) or id
(`"char-a"`).

## Live editor control

The server hosts `ws://127.0.0.1:5184/live` by default (`COZYCLAY_LIVE_PORT` or
`--live-port <port>` to change it). Start the editor with that same `COZYCLAY_LIVE_PORT` so its
Vite build connects to the selected loopback endpoint; `npm run dev` preserves the environment
variable for the browser. A CozyClay editor tab then connects on its own; `live_status` tells you whether one is attached. With an editor connected, mutations
forward to it and reads report its real state — the screen you are looking at is the source of
truth. Without one, headless-capable tools keep their in-memory behaviour while `capture_frame`
returns an explicit connected-editor error, and so do `import_mesh`, `studio_commands` and
`studio_run` (an `isError` result). `apply_batch` returns a readable ordinary response
explaining that an editor is required. In `--http` mode each session
child attempts to bind the live port, so one session owns the editor and the others
intentionally run memory-only.

The wire protocol — one WebSocket, sixteen commands, editor-side rules — is specified in
[`LIVE-PROTOCOL.md`](LIVE-PROTOCOL.md).

The same socket also admits a second role: a **controller** is a local terminal process
(`cclay live`) that authenticates with the token from the hub's endpoint file — a browser page
can never read it, so the role stays with local processes. Controllers drive the very same
commands and tools through the very same workspace routing as an MCP client does; the CLI is a
thin terminal front end over this hub, not a parallel surface, so anything true of the tools
above (admission envelopes, receipts, per-workspace exclusion) is true of it too. The
terminal-agent guide for it is [`../docs/agent-cli.md`](../docs/agent-cli.md).

## Motion

Motion is compiled, not generated: run `motion.compile` through `studio_run` with a motion
spec (key poses, anchors, props, walks, hinged objects, task checks). The Studio bakes every
frame on the rig, answers the QA groups, and installs the take; `motion.sample` and
`motion.qa` read it back. The spec format and the loop are in
[`../docs/motion3-agent-guide.md`](../docs/motion3-agent-guide.md).

## Storyboard projects and capsule figures

The tool list is fixed when the server starts, so it is the same 27 tools in every project. A
tool that does not apply to the project or to its target answers a structured refusal instead
of acting; nothing is sent to the editor and nothing changes. The refusal is the tool's only
text content, with `isError: true`:

```json
{ "ok": false, "code": "NOT_IN_MODE", "reason": "This project is a Storyboard - mark_camera_move is available in Animation projects." }
```

| code | when | tools |
| --- | --- | --- |
| `NOT_IN_MODE` | the project's `previsMode` is `storyboard` | `mark_camera_move` |
| `TARGET_NOT_READY` | the target character is a capsule figure (`model: "proxy-figure"`) | `studio_run` motion, take, IK and pose actions |

`describe_scene` reports `previsMode: storyboard` or `previsMode: animation` (the connected
editor's project; `open_project` sets it without one) and marks each cast member
`kind: rig` or `kind: proxy`, with a capsule figure's `posture`.

A **storyboard project** is a sequence of still shots: one picture per panel, held for a
number of frames, with a caption. Block it with the camera, cast and set tools, and run the
still-shot commands (`shot.createStill`, `shot.setCaption`, `shot.setHold`, ...) through
`studio_run`. Motion and named camera moves belong to Animation projects.

A **capsule figure** is a rigless stand-in for blocking: `add_character { subject, model:
"proxy-figure", posture: "sit" }`. It places, turns and frames like any cast member and holds a
posture (`stand`, `sit` or `lie`), but it has no skeleton, so motion and takes are refused with
`TARGET_NOT_READY` and the reason, for example `<name> is a proxy-figure body, which motion
compile cannot drive; use an X Bot or Y Bot character.` for `motion.compile`. The editor refuses its own IK, pose, physics,
collision and line-edit commands on a capsule figure with the same code when they arrive
through `studio_run`. Use a rigged model for anything that moves a body.

## Round-trips with the studio

`save_project` writes a real `.cclayproject` file, so a scene blocked here opens in the studio to
be posed, timed and generated — and a scene built in the studio opens here with `open_project`.
The configured project-root directory must only be writable by the trusted user running the MCP
server; project I/O rejects symlinks and hard-linked project files but relies on that directory
permission boundary to prevent an untrusted local process from adding links during an operation.

## Design

This server owns no geometry, no film vocabulary and no prompt text. Every answer is computed by
the same modules the studio renders with, imported straight from the working tree:

| module | responsibility |
| --- | --- |
| `../src/shot.js` | geometry → film vocabulary → prompt |
| `../src/scenes.js` | the scene document and its stage envelope |
| `../src/scene-objects.js` | the set: create / update / remove, clamped and snapped |
| `../src/camera-move.js` | two framings → a named camera move |
| `../src/project.js` | the `.cclayproject` envelope |

That is the whole design. Because the imports are relative, the server always speaks the working
tree's vocabulary: retune a band in `shot.js` and this server reports the new answer on its next
start, with nothing to publish or reinstall. The studio and the MCP server cannot disagree about
what a 35mm medium shot is, because there is only one implementation of it.

`frame_shot` is the one place that inverts `shot.js` rather than calling it — it solves for the
camera position that produces a requested size. `npm run verify` checks all 420 combinations the
schema accepts, so a retune in `shot.js` fails loudly here instead of quietly mis-framing.

### Framing conflicts

Shot size is treated as the stronger request. An extreme close-up from an overhead lens is
geometrically impossible on a wide lens — the camera would sit inside the subject — so the server
lengthens the lens until the requested angle fits and says so, the way a crew swaps glass rather
than abandoning the close-up.
