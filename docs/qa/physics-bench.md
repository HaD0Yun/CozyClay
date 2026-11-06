# Physical motion bench

`test/bench/physics/` compares CozyClay and Blender on ten hard physical motions built from scratch in an empty scene: muscle-up, handstand, two forward rolls, army crawl, wall climb, a trip while running, a backward fall off a roof, a barbell overhead, a rooftop gap jump and pushing a heavy crate. The same model and effort run on both sides. CozyClay runs through its Studio Agent panel. Blender runs through Claude Code (`claude -p`) with the official Blender Lab MCP server 1.0.3. Each run is measured on completion, time, cost, wasted effort and stability, and a human judges the results blind.

It uses a real model, a live Studio and a local Blender, so it is not part of the default `node tools/run-tests.mjs` manifest. This page covers the parts that exist so far: the sets, the two scene builders, the shared result file, and the run harness.

## Sets

`sets/NN-<motion>.json` holds one task each: the request sentence (Korean and English), 24 fps, a 20 s maximum, one Y Bot (`char-a`), and the objects.

| Field | Meaning |
| --- | --- |
| `character.position` | Feet origin. Every set faces the character toward +Z. |
| `objects[].shape` | `box`, `cylinder` (with `axis` x, y or z) or `group` (an empty parent) |
| `objects[].center`, `size` | Geometric centre and world extent along X, Y, Z, in metres. For a cylinder along X, `size` is [length, diameter, diameter]. |
| `objects[].fixed` | It never moves (walls, roofs, the bar, the net) |
| `objects[].mass` | kg, for an object that can move (the barbell group, the crate) |
| `objects[].parent` | The group this body belongs to |

Set coordinates use CozyClay axes: metres, +Y up, the floor at y = 0, the character faces +Z, and +X is the character's left. Blender is +Z up and the imported Y Bot faces -Y, so a set point (x, y, z) is Blender (x, -z, y).

Mass is never a CozyClay scene field. The motion spec sets it (`spec.objects[id].mass`, `src/motion3/mass.js`), so both agents get it in the request text.

## Request

`sets.mjs` `requestText(set, tool)` writes the one message a run sends: the Korean task sentence, a scene description in that tool's own axes (object ids, centres, sizes, masses; for Blender also the armature name and its 65 `mixamorig:` bone names), and the rules (no pre-made motions, the allowed tools, and where the result must stay).

## Scene builders

| Tool | Builder | Output |
| --- | --- | --- |
| CozyClay | `node test/bench/physics/build-cozyclay.mjs <set> [--out f]` | A project document (Animation, rigged cast), opened with `window.__cozyclayProject.open` |
| Blender | `blender -b --factory-startup --python test/bench/physics/blender/build_scene.py -- <set.json> <y-bot-tpose.fbx> <out.blend> [bounds.json]` | A .blend at 24 fps, frames 0 to 239, with the Y Bot armature `char-a`, a floor, a camera and a sun |

CozyClay records sit on their base pivot (bottom centre) and turn by Euler XYZ in degrees. A cylinder along X is therefore a Y cylinder turned `rotZ` -90 with its pivot at the -X end. Blender objects are built with their transforms applied (identity rotation, unit scale), are named by their set id, and carry `mass` and `fixed` custom properties.

The Y Bot is a Mixamo file, so the builder loads `public/models/y-bot-tpose.fbx` at build time and no .blend is committed. Blender's FBX import gives the armature scale 0.01 and a 90° X rotation, with the hips at 0.998 m. The builder sets the scene back to 24 fps (the import sets 30).

## Check: both tools open a set at the same coordinates

```sh
node test/bench/physics/check-sets.mjs [--sets 1,5] [--out dir] [--blender /opt/blender-5.2.0-linux-x64/blender] [--port 6300]
```

The check builds every set in both tools. It opens the documents in a headless Studio (dev server on `--port`, live hub on +1, CDP on +2, a fresh config home) and reads each object's world bounds with `cclay live inspect --scope entities --limit 32` (the editor caps a page at 32). It reads the .blend bounds that `build_scene.py` writes. Both are compared with the bounds the set itself implies: a body is its centre ± size / 2, and a group is the union of its children. The check passes when every object and the character root are within 1 mm in both tools.

## take.json: one result format for both tools

After a run the harness exports the result; the agent never does. `take.mjs` holds the format and the landmarks.

| Field | Meaning |
| --- | --- |
| `frames`, `fps` | Frame count from the first exported frame, 24 fps |
| `rig.bones` | The 65 Y Bot bones (`mixamorig:Hips`, ...), CozyClay rig order |
| `characters["char-a"].bones` | `[frame][bone]` row-major 4x4 world matrices in set axes, with the CozyClay rig's bone frames |
| `objects[id].matrix` | `[frame]` matrices of each set object at its centre (a group: its root). One entry: it never moved. Empty: the agent deleted it. |
| `source` | Tool, set, run, model, effort, and what the exporter saw |

`landmarksAt(take, id, f)` gives 29 points as fixed offsets on bones, measured once on the rig at rest: 2 palms (midway from the wrist to the middle knuckle), 10 fingertips, 6 sole points (the QA heel, ball and toe tip), 2 knees, 2 elbows, the hips, the buttocks (8 cm below and 11 cm behind the hips joint), 3 spine points, the chest (5 cm above and 11 cm ahead of Spine2) and the head top. The scorer uses the same code for both tools.

| Tool | Exporter |
| --- | --- |
| CozyClay | `node test/bench/physics/export-cozyclay.mjs <doc> <set> --out take.json`. It compiles char-a's installed spec again in Node with the Studio's `compileSpec` and `motionScene` (as `test/bench/motion-track.mjs` does) and writes the compile's world bone frames. |
| Blender | `blender -b <run.blend> --python test/bench/physics/blender/export_take.py -- <set.json> <take.json>` over the scene's frame range |

Blender bones have their own frames (+Y along the bone) under an armature turned 90° about X and scaled 0.01. `blender/take_io.py` therefore maps each bone through one constant correction measured at rest, `C_b = (A · BASIS · L_b)⁻¹ · M_rest_b`. It uses the bone rests that `build_scene.py` stored at build time, so an agent that edits the rest pose still exports through the bind it was given. `blender/import_take.py` keys a take onto a set's .blend: it is used for this check and to render either tool's result with the same renderer.

### Check: round trip through Blender

```sh
node test/bench/physics/check-take.mjs [--out dir] [--blender path]
```

The check installs a test-only spec (standIdle, a back tuck, a cartwheel) on set 10 and exports it from CozyClay. It gives the crate a made-up slide, yaw and tilt. Then it keys the take onto the .blend, exports it again, and compares every frame. Keyed in Blender, no bone below the hips may need a translation or a scale. A round trip alone would not catch a wrong bone map, but a wrong map shows up as stretch. Measured on the bench box (Blender 5.2.0): landmarks within 0.0032 mm, bone origins 0.0035 mm, crate 0.0002 mm, largest stretch below the hips 0.0020 mm, Blender rest heads vs the rig 0.0011 mm. Tolerance is 1 mm. It takes 6 s.

## Setup (the bench machine)

The harness expects one Linux machine with an X display and a GPU (the bench box: Ubuntu 24.04, RTX 3070). The paths below are its defaults, and the environment variables in parentheses override them.

| Piece | Where |
| --- | --- |
| Blender 5.2.0 LTS | `/opt/blender-5.2.0-linux-x64/blender` (`BLENDER`) |
| Claude Code (same version as the authoring machine) | `/opt/claude-code/bin/claude` (`BENCH_CLAUDE`) |
| Blender Lab MCP server 1.0.3 (from the release's .mcpb) | `/opt/blender-mcp-1.0.3/venv/bin/blender-mcp` (`BENCH_BLENDER_MCP`); the bridge port comes from `BLENDER_MCP_PORT` |
| Blender Lab MCP add-on 1.0.3 | Installed for the `bench` user: `blender -b --online-mode --command extension install-file -r user_default -e mcp-1.0.3.zip` |
| Run user | `bench`, in the `video` and `render` groups, with `~/.cliproxy.env` (0600: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`). The harness user needs passwordless sudo to run as `bench`. |
| Model access | CLIProxyAPI on `127.0.0.1:8317`. The Studio gets `CLIPROXY_API_KEY` from `~/.config/cliproxy/env`. The usage log `~/cliproxy-usage/YYYY-MM.jsonl` gives tokens and latency. |
| X display | `:0`. The harness grants `bench` access with `xhost +SI:localuser:bench` (`BENCH_XAUTHORITY`, default `/run/user/1000/gdm/Xauthority`). |

The Blender side runs as `bench` because the MCP server runs model-written Python with no guard. That user cannot read the harness user's home, so the harness builds the .blend itself and copies files in and out with sudo.

Headless Chrome falls back to SwiftShader (software WebGL) unless it is told otherwise. `studio.mjs` passes `--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist` (`QA_CHROME_FLAGS` overrides it), so the Studio renders on the GPU as Blender does.

## Run harness

```sh
node test/bench/physics/run.mjs --sets 10 [--runs 3] [--tools cozyclay,blender] [--timeout-min 60] [--out ~/physics-bench/runs]
```

There is one queue per tool. The two queues run side by side, and each runs one run at a time. A run sends one request and gets no human input. The harness exports the result, appends one row to `<out>/physics-bench.jsonl`, and writes `<run>/row.json`. A run whose `row.json` exists is skipped, so the command resumes after a stop.

| Tool | One run |
| --- | --- |
| CozyClay | A dev server with a fresh config home and live port, and headless Chrome with a fresh profile (`drive-cozyclay.mjs` under `tools/qa-browser.mjs`). It opens the set's document, opens the Agent panel, selects `cliproxy/<model>` and the effort, and sends the request. It waits until the agent and every task it dispatched are idle and no session file has been written for 20 s. Past the limit it presses Stop. The end time is the newest session write. Then it saves the document and the session files, and `export-cozyclay.mjs` writes take.json. |
| Blender | `blender-run.mjs`: it builds the start .blend and opens it in a Blender window on `:0` as `bench`. The MCP add-on serves on port 19900 + lane. Then it runs `claude -p --model <model> --effort <effort> --mcp-config ... --strict-mcp-config --tools Read --allowedTools 'mcp__blender__*' Read --permission-mode bypassPermissions --setting-sources '' --output-format stream-json`, with an empty `CLAUDE_CONFIG_DIR` and a `timeout` at the limit. When it returns, the harness saves the live scene through the add-on's socket, closes Blender, and runs `export_take.py`. |

Tokens, price and model time come from the CLIProxyAPI usage log for both tools (`usage.mjs`). A run's requests are the ones from 127.0.0.1 with that tool's user agent (`pi/` for the Studio Agent, `claude-cli/` for Claude Code) that ended inside its window. That is why each tool runs one run at a time. Price is the claude-opus-5-5 list price checked on 2026-11-07: $4 input, $20 output, $0.20 cache read, $5 / $8 for 5-minute / 1-hour cache writes per million tokens, and KRW at 1,500 per USD. These prices reproduce Claude Code's `total_cost_usd` and the Studio session's own cost. `modelBusyMs` is the union of request intervals, and `toolMs = wallMs - modelBusyMs`.

`agent-logs.mjs` counts tool calls, failed calls, retries (CozyClay: compiles after the first; Blender: script runs right after a failed one), result checks, and banned-tool use (plan 1.2):

| Tool | Banned (the run is disqualified) |
| --- | --- |
| CozyClay | A skill `flip`, `hitReaction`, `throwObject`, `catchObject`, `sitInSeat`, `exitCar` or `smokeCigarette`, `motion.fill`, `motion.primitive`, or `fill: true`. It is checked in every tool call of the main session and the task sessions, and in the installed take. |
| Blender | `import_anim.bvh`, `import_scene.fbx`, `wm.append(`/`wm.link(`/`libraries.load(`/`bpy.ops.asset.`, or network calls (`urllib.request`, `urlopen(`, `requests.get/post(`, `http.client`, `socket.create_connection(`), in the code of any script run. |

`ending` is one of the following, checked in this order:

| Ending | When |
| --- | --- |
| `crash` | The request was never sent |
| `disqualified` | A banned tool was used |
| `timeout` | The run reached the limit; `wallMs` counts as the limit |
| `finished` | The take moves: a landmark travels 1 cm or more from frame 0 |
| `crash` | The harness failed to save or export the result |
| `gave_up` | Otherwise: no take, or no motion |

`--probe banned` sends a short request that uses a banned tool instead of the task: a flip skill take, and `bpy.ops.import_anim.bvh`. Its rows carry `probe` and are not counted. Measured on 2026-11-07: both probes ended `disqualified` (CozyClay `skill flip` in a run_action call and in the installed take, 54 s, $0.69; Blender `bvh import`, 6 s, $0.07).
