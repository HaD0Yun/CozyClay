# Changelog

## Unreleased

Motion

- Sample motions in the Motion tab: one click installs a walk or a flip on the
  selected character and plays it, with no agent. On the hosted Studio, where
  no agent server runs, the Agent panel shows four ready-made requests to
  press (a walk, a street of buildings around the character, a chair to sit
  on, a back flip) and an Install button, instead of a server error.

## 3.2.2 - 2026-11-07

A patch for the motion compiler and the agent: faster compiles, holds and automatic legs, arms, gaze and tempo, steadier agent turns, and depth exports that read right.

Export

- A depth video whose frames show no empty background (a backdrop that fills
  the frame, a closed corridor) keeps a readable range instead of going all
  black. (#1090)
- Rigged characters render in their current pose in depth frames and
  `blocking-depth.mp4`, not in the T-pose. (#1094)
- `export.shotVideo` takes `passKind: "depth"` and `depthCurve: "inverse"` for
  an inverse-distance depth curve that keeps close-up relief. (#1096)

Camera

- A rail camera aimed at a rising or falling object follows its height each
  frame instead of one shot-average height. (#1095)
- Agents can hold camera framing. (#1027)

Motion

- Compiles run about 1.5x faster: `pose()`'s bone edits run in WebAssembly,
  with takes the same bit for bit. (#1088)
- Holds, and automatic tempo, knee poles, foot heading, free-arm swing and
  gaze (`set.look`) where the keys leave them out. (#1080, #1081, #1082)
- Two-hand carries hold a box from below at its sides; letting go and
  throwing no longer jump.
- Repair and retime run by default, with QA-guarded key thinning. (#1006)
- MotionBricks transition fills (opt-in), a native mode and the Smart
  Primitive runner, with named poses and fills that hold up in scenes with
  objects. (#1008, #1017, #1023)
- A grasp out of reach says so, instead of blaming the grip. (#1066)

Agent

- Provider failures retry gateway 5xx and honour Retry-After; usage limits
  read as quota; sign-in waits say why they stopped. (#1043, #1044)
- Refusals name the failing field. (#1042)
- Tasks: a main turn that makes no progress ends, the watchdog waits on
  running tools and names a model that did not answer, finished tasks undo
  after a scene round trip, and paused tasks resume instead of refusing.
  (#1002, #1004, #1010, #1051, #1056, #1058)
- Every edited turn is checked, with pictures and relations given to the
  model, and the panel shows the review and the context used. (#1000, #1030)
- A handled prop is staged within reach. (#1066)
- Camera, blocking and review previs workflow. (#1014)

Studio

- Contact sheets show a character behind scene bodies. (#1024)
- An empty cast is allowed; cancelling the file picker no longer counts as a
  refusal. (#1041)
- Pose mode picks the one rigged character; the first-success guide starts
  with Add a character. (#1047, #1048)
- Fixed a playback update-depth loop (React #185) and crashes under page
  translation. (#1045, #1046)
- A slab resting on the deck no longer z-fights with it. (#1075)

CLI

- `cclay live save --out file.cclayproject [--force]` saves the open project
  from the terminal. (#1072)
- `cclay live capture --frames A-B --out-dir DIR` renders a run of frames in
  one session. (#1074)
- `live run`, `cmd` and `tool` take `--args-file <path>` or `--args -`
  (stdin), so large payloads such as GLB data URLs fit. (#1092)
- `asset.import` decodes meshopt and Draco compressed GLB. (#1092)
- `inspect` pages entities with `--limit` and `--cursor`; live captures from
  a hidden Studio tab are refused. (#1070, #1071)
- `shot.set` camera keys document `framing.yaw` and `pitch` as radians.
  (#1093)

Other

- three.js 0.187; MCP SDK 1.32.2.
- Landing page: the shot and the way in on the first screen, a sharper hero
  take, and a daily GitHub star count.

## 3.2.1 - 2026-10-28

A patch that makes the numbers readable: hosted builds report their version, and the export funnel and agent failures can be split by cause; plus a script-driven tutorial recorder.

Studio

- The **Update** chip now agrees across open Studio tabs at once: closing it,
  pressing **Update now** or an install finishing in one tab shows in the
  others without waiting for their next check.
- **Help › About** shows the version you are running.
- In Sculpt mode, click a part of the sculpt to select it: the part gets an
  outline, and its row lights up in the new **Parts** tree in the Sculpt
  panel. A click on a mirrored copy selects the part it mirrors. A click on
  empty space, or Esc, clears it.
- **Sculpt shelf.** **Save to shelf** in Sculpt mode keeps a sculpt as a card
  in **Content › Sculpts**, with a thumbnail. Drag a card into any scene of
  any project to place a copy. Export a card as `.cozysculpt.json` and import
  it on another machine.
- After a one-click update, **Restart now** starts the new version on the same
  port in the same terminal (macOS and Linux), and the Studio reloads when it
  answers. A project with unsaved changes asks you to save, then reload.
  Windows keeps the copy command by design.
- A selected sculpt part gets a gizmo: W moves it, E rotates it and R scales
  it (Shift scales evenly), and W/E/R go back to the turntable views once the
  part is cleared. One drag is one undo, a mirrored pair moves together, and
  an edit the recipe refuses snaps back with the reason. Delete with a part
  selected no longer deletes the whole sculpt.
- A capsule figure set to **Sit** now sits on the floor in an L, with its legs
  reaching forward the way it faces, instead of only getting shorter. Its
  bounds, and so framing, follow the new shape. (#999)

CLI

- `cclay update --off` turns the update line and the Studio's **Update** chip
  off for good; `cclay update --on` turns them back on. `cclay update --check`
  still answers either way.

Agent

- A task that read a whole character is told when another task edits one of
  that character's layers, so a placement built on an old position is
  flagged on its next step. (#981, #982)
- Task mode in the agent panel is on by default. Turning it off is
  remembered in this browser. (#998)

Sculpt

- **Multi-view compare.** The blueprint sheet is cropped into front, side,
  back and top views, each with its own mask; a view whose mask fails is
  dropped with a notice. `sculpt.compare` takes `views: [{ yaw, reference,
  weight }]` and weighs front, side and back 0.6, 0.25 and 0.15, giving 0 to
  a view whose proportions differ from the front by more than 35%. Start
  compares against the cropped side and back next to the front reference.
  **Generate blueprint** shows only with a ChatGPT sign-in. (#970, #995)

Analytics

- Hosted builds report the version they run. (#989)
- Opening the Export menu is counted, with whether the browser can encode
  MP4, so the export funnel can be read. The privacy page lists the new
  `export:menu_opened` event. (#990)
- Agent failures say whether the provider failed, the request got no network
  answer, or the cause is unknown, instead of one catch-all. (#991)
- MCP tool events carry the tool name, and `studio_commands` counts as a
  read. The privacy page lists the `tool_name` property. (#994)
- Reference exports made by QA scripts no longer count as user export
  attempts. (#993)
- Usage analytics no longer switch themselves off in source checkouts, forks
  or CI (a `CI` variable alone does not disable them), and the browser's
  Do-Not-Track setting is no longer read. Turn them off with `cclay telemetry
  off`, `COZYCLAY_TELEMETRY=0` or `DO_NOT_TRACK=1`; the analytics toggle in
  Preferences and the launch notice are gone. An unreadable state file now
  reads as the defaults, with analytics on, and a Studio served on a local
  network address counts as local. The star question is asked once per
  version when the Studio starts, instead of on exit. (#988)

Tutorials

- **Tutorial recorder.** `npm run tutorial:record -- first-video` renders the
  episode "First video in 5 minutes" from a script, in Korean or English,
  with `.srt` captions, so the video can be re-rendered when the UI changes.
  (#983)
- The recorder adds voice narration and burned-in captions in the chosen
  language. (#984)
- Episodes can point at a feature before using it: a spotlight with a label
  and note, chapter cards and an install terminal scene. (#985)

## 3.2.0 - 2026-10-26

Motion gets physics you can see and trust: props swing and settle after the hand stops, balance and jumps are judged by real mass and gravity and the Studio draws why, and characters no longer pass through each other when you drag or compile.

Studio

- **Physics overlay.** Tick **Physics** in the motion controls, or call
  `motion.physicsOverlay`, to draw the centre of mass (green inside the feet,
  red outside, grey in the air), the support polygon under the feet, each
  jump's actual hips path next to its gravity arc, and a short trail behind
  swinging props. It shows in scrub, playback and video export, and red
  frames are exactly the ones QA calls BALANCE. (#950)
- Dragging a hand or foot IK handle into another character now stops at that
  character's body instead of passing through, even on a fast drag across a
  thin forearm. Hold **Alt** while dragging to pass through on purpose; a
  one-time notice says so. The other character never moves. (#949)

Motion3

- **Prop spring.** `objects.<id>.spring = { length, stiffness, damping }`
  makes a carried or free prop (a bag, a lantern, a club) swing a beat behind
  the hand and settle. `length` is the string or rod length; stiffness
  defaults to gravity over length and damping to 0.5, so `spring: { length: 0.5 }`
  already swings naturally. Put the prop's base at the hand with `at`/`along`,
  because the swing pivots at the base; QA notes a base that sits far from the
  hand. The swing is computed once at compile time, stops when a dropped prop
  lands, and never pushes the prop into the floor. (#945)
- **BALANCE** now uses a mass-weighted centre of mass against the support
  polygon of the grounded feet, instead of a four-point average and a box. Its
  hint gives the distance and direction (for example 0.10 m ahead of the feet),
  and a lean that changes direction stays one issue. A hint that moves the
  root now moves every key that holds the pose, so the body does not slide
  between them. (#944, #937)
- **FLOAT** issues come with a fix: the root keyed onto the gravity arc between
  takeoff and landing, returning to the original motion at both ends. When the
  correction would be too large, the hint gives the apex height or the air time
  that would fit instead. (#943)
- **`fix.person`** (on by default) moves a character's arms out of another
  character's body at compile time, keeps contact you allowed in
  `checks.allow`, and gives the same take after saving and reopening. (#948)

Agent

- Kimi K3 models (`kimi-k3*` on the Moonshot hosts) work on the
  OpenAI-compatible provider with their reasoning efforts and full output
  limit. A turn that spends every output token before answering now says so
  and suggests a lower reasoning effort, instead of failing with no output.
  (#951, #947)

Package and tests

- `jpeg-js`, which the MCP image tools import, is a root dev dependency, so a
  development checkout runs the MCP tests without a separate install. The test
  runner now skips the MCP suites with a clear message when `mcp/node_modules`
  is missing. (#946, #936)
- The Studio camera QA enters look-through from the dock's Shot Camera card,
  where the Studio shows it. (#952, #925)

## 3.1.6 - 2026-10-25

The npm package ships the MCP module the live tools need, so the Studio's live tools and `cozyclay mcp` work on a fresh install.

Studio

- A 3.1.5 global install shows the **Update** chip in the top bar for the
  first time, since this is the first release after the chip shipped.
  **Update now**, or the command it offers to copy, installs 3.1.6; then
  restart `cclay`.

MCP

- The npm package now ships `mcp/project-camera.mjs`, so the Studio's live
  tools and `cozyclay mcp` start on an npm install instead of failing with
  "Cannot find module" (broken since 3.1.2). The package check now fails a
  release whose `bin/` or `mcp/` code imports a file the package leaves out.

## 3.1.5 - 2026-10-25

The Studio tells you when a new release is out and installs it in one click, Claude models work in the agent panel again, IK edits stay on their own character, turns and walks look more natural, and anonymous analytics show where the Studio gets in the way.

Agent

- Agent turns on Claude models no longer fail with a 400 error about a
  deferred placeholder tool.
- When a turn is already running, the failure chip reads `busy` instead of
  `upstream`. The message text is unchanged.

Motion

- The head turns first and leads the body into a turn, by about 5 frames at
  24 fps, the way a person's does. `flow.headLead` sets the frames (0 to
  12), and `false` turns it off. A keyed head look still wins.
- Takes that walk report `observations.gait`: cadence, step length, speed,
  stance and pelvis motion, with warnings outside a person's range. It is a
  reading only and never changes the QA result.
- Grasp QA reads each finger: `FINGER_ROM` (a joint past its range),
  `FINGER_SELF` (two fingers inside each other) and `THUMB_OFF` (a held
  object without the thumb on it).
- A carried ball keeps the thumb on it. A finger that misses a held object
  turns toward it at the knuckle, and the ring and little fingers curl
  together. Stacked hand presets no longer over-curl.

Studio

- An npm studio shows a small **Update** chip in the top bar when a newer
  release is out, once per version. A global install whose folder npm can
  write gets **Update now**, which installs the release and then asks you
  to restart `cclay`. Other installs get the command to copy, and npx gets
  "run `npx cozyclay` again". **Update now** waits while an agent turn,
  an export or a recording runs. A failed install names the cause
  (permissions, network, Node version, npm missing) and keeps the command.
- An IK edit stays with its own character. Selecting another character
  mid-drag no longer poses it, and undo no longer reverts or deletes the
  other character. Switching characters applies a pending IK edit and shows
  a notice.
- Ctrl+Z after an IK drag puts the pose back, with or without a take
  loaded.
- On a browser without WebGL, the unavailable notice appears one frame
  after the Studio first draws instead of during it.

CLI

- `cclay update --check` prints the current and latest version without
  installing, and exits 0 (up to date), 10 (update available) or 11
  (unknown). `cclay update` now refuses a release your Node.js cannot run.
- A source checkout reports itself as `clone`, and a Windows global install
  is no longer mistaken for npx.

Site

- A redesigned cozyclay.org: a black first screen with a greybox-to-video
  reel, how-it-works clips from the tutorial, and Try it opens the Studio.

Analytics

- The anonymous usage analytics now cover where the Studio gets in the way:
  - the agent loop: refused commands, a summary per agent turn, each motion
    draft and its QA result, and each prompt sent, so retry loops and
    hesitation show
  - model connect: the sign-in steps and where they stop, and model changes
  - exports: retries, the stage a failed or stopped export reached, and
    saved files. Storyboard PNG, render pass and OTIO exports are now
    counted.
  - clicks, shortcuts and search: repeated or dead clicks on the main
    controls, shortcuts that did nothing, searches with no result, and
    switching panels or orbiting the camera back and forth
  - playback, boot and crashes: time to the first frame, playback runs and
    late frames, the first-success guide, render crashes and lost WebGL
  - the update notice: when it shows, which button was pressed, and whether
    the install worked
  - one friction summary per session
- Every value is a closed bucket or a fixed id. No text, names, paths,
  object ids, click coordinates or npm output are sent. Prompt text never
  leaves the browser; only a length bucket and a similarity grade to the
  last prompt do.
- First-edit events count only your own edits, not the agent's, and report
  `definition_version` 2.
- Events that nothing sent any more are removed: the old motion-generation
  events and `sample:played`.
- The privacy page lists every event and property. `cclay telemetry off`
  still turns it all off.

## 3.1.4 - 2026-10-24

Starring CozyClay from the terminal takes one key when the GitHub CLI is signed in.

CLI

- The one-time star question on exit stars NomaDamas/CozyClay through `gh`
  when `gh` is installed and signed in: answer `y` and it is done, with no
  browser. An account that already starred the repo is not asked. Without
  `gh` the question opens the repo page as before, and `--no-star`,
  `COZYCLAY_NO_STAR` and CI still turn it off.

## 3.1.3 - 2026-10-24

More ways to connect a model (Claude Pro/Max, OpenAI-compatible servers, MiniMax M3.1 Flash), a Simplified Chinese UI, and easier project opening.

Agent

- Sign in with a Claude Pro/Max subscription and run Claude models in the
  agent panel without an API key. Turns go through the official Claude Code
  binary.
- Connect an OpenAI-compatible server (LM Studio, Ollama) with its address
  and an optional key. The model list comes from the server.
- MiniMax M3 and M3.1 Flash, on both the global and the China endpoint.
- The agent runs on pi 1.4.0, which adds the newer Claude, GPT and Gemini
  models to the picker. A turn stopped mid-tool keeps its prompt after a
  reload.

Studio

- Simplified Chinese (简体中文) as an opt-in UI language in Settings.
- An Open project card on the start screen. A browser that refuses to read
  the picked file falls back to a file input, a slow pick no longer times
  out, and a failed open shows its message above the start screen.
- IK handles answer a press on their drawn sphere, and rotation rings win
  over an arrow's invisible hit volume.

## 3.1.2 - 2026-10-23

The Studio agent repairs motion faster and ends with a take, exports can go to a folder you choose, and a round of fixes for the live hub, MCP, prompts and docs.

Agent

- Motion repair loop: task scheduling with verify/accept/reject steps,
  character key scopes, a life critic, patch selectors and a repair watch
  that keeps the best compile and never ends a turn without a take.
- walkTo fits a walk a natural gait can reach instead of refusing it, and
  stops short of a body at its target.
- The repair cap and stuck streak count agent calls, not compiles inside one
  script; hint patches are pre-checked only on repair compiles.

Export

- Optional export folder (Settings > Export): downloads go straight to a
  chosen folder and fall back to the browser download if it is unavailable.
- The keyframe-pack README lists only the files in the pack; the depth video
  is a separate export.
- The prompt's LENS word follows the editor's lens calibration (24 mm is a
  wide shot, not a long shot).

Live and MCP

- The packaged Studio dials the live hub port the launcher chose
  (`COZYCLAY_LIVE_PORT`).
- `shot.frame` receipts report a retained camera key as present, not removed.
- Motion verification measures objects where the take animates them.
- `cclay live status` and `--workspace <project>` follow the project that is
  open, not the label at connect time.
- Without an editor, MCP `save_project` / `open_project` keep the camera.
- `npm run verify:live` works from `mcp/`.

Docs

- Node 22.19+ on the homepage, 27 MCP tools, and the CLI guide's framing
  walkthrough and motion limits match the current behaviour.

## 3.1.1 - 2026-10-23

Sculpt gets new shapes, cutters, detail and materials, and the Studio agent shows its plan and a live sketch.

Sculpt

- New sculpt shapes: loft, convex hull, lathe, tube and extrude, plus an
  instanced scatter (blade, tuft, flower, leaf, pebble, twig) that fills a
  part with up to 12000 items. Bad points are refused with their path.
- Boolean cutters: a part with `op: subtract | intersect` cuts its parent for
  windows, doors, arches, hollow bowls and cups, notches, half-domes and
  slices.
- Surface `detail` (seeded displacement) and colour `gradient` on any shape.
- Material presets for sculpt parts and primitives: clay, wood, straw, stone,
  brick, concrete, metal, glass, ceramic, plastic, rubber, fabric, paper and
  foliage, each with a matte, satin or gloss finish.

Agent

- A step checklist for long Studio turns, pinned under the prompt while the
  turn runs and restored with the session.
- A live ghost sketch of the sculpt in the viewport while the agent is still
  writing the script. It is never picked, saved or exported.
- The Studio prompt, MCP and Sculpt mode know the new shapes, materials and
  fields.

## 3.1.0 - 2026-10-23

Hands that hold, throw and catch with weight, Studio tasks in the chat, faster playback, and a leaner first run.

Motion

- Hands hold what they carry. Fingers close until they touch the held
  surface, a ball rests in the palm and fingers, and spheres and cylinders
  are round to the compiler. QA flags a finger through the object
  (`FINGER_PEN`), a finger short of it (`FINGER_GAP`) and a hand that does
  not hold it (`SUPPORT`).
- A held thing has weight: `objects.<id>.mass` sags the arm, and a load past
  one hand asks for two (`LOAD`, `observations.load`).
- New skills `throwObject` and `catchObject`. A thrown thing leaves with the
  hand's speed and lands on the first surface its path comes down onto; a
  hand meets a flying ball where it can reach and gives with it.
- Grasp issues say why and carry the fix that repair applies.

Studio and agent

- Tasks: a **Tasks** switch in the agent composer. With it on, the main
  agent answers at once while Studio tasks edit the scene in their own
  scopes, on a pool of two compile workers. Running tasks show as one line
  in the chat. Off by default.
- A video can be attached to the agent; it travels as a contact sheet.
- A fresh install opens the project chooser with one "+ New project" card.
- The Shot Camera card draws the live shot in every mode, and a focal-length
  scrub replaces the read-only lens label.
- The project menu, scene dropdown and Outliner menu no longer open behind
  the panels and close each other.
- + Add shot on a full take grows the take; dock tabs are clickable; Pose
  enters from the editor view and releases IK focus on exit.

Performance

- Timeline playback no longer re-renders the whole app every frame.
- The motion body fits (~0.5 MB) load after first paint instead of in the
  first bundle.

Fixes

- `npm test` and `npm run lint` run on a Windows checkout, and the MCP server
  removes its live endpoint file when it exits on Windows.
- `npm run dev` exits within about 1.5 s on Ctrl+C instead of hanging.
- mcp: `proxy-addr` 2.0.8 (CVE-2026-90711).

Removed

- The built-in set pieces: Chair, Car and Plane (aircraft), with their Set
  pieces group, Content › Sets folder and renderers. An old project that has
  one opens it as a plain cube with the same transform and size.
- The City Block starter scene and its thumbnails. The chooser's "+ New
  project" card is now the one blank entry; the Blank Stage card, the Samples
  page and the category tabs are gone. `--scene <id>` and `?scene=` stay; an
  unknown id is ignored with a console warning.
- The camera tutorial: the Studio overlay, Help › Tutorial, the Settings and
  Learn entries, `?tutorial=camera`, the first-shot handoff, the `tutorial:*`
  analytics events, and the seven-step tutorial and project download on the
  home-page playground (which now opens a blank stage).

Docs

- The README is short again: install, what it does, the three AI surfaces, docs.
- `INSTALL_FOR_AGENTS.md` is the install, run and connect guide for an AI agent given the
  repository link. It ships in the npm package.
- The README links the CozyClay Discord server and GitHub Sponsors.

## 3.0.3 - 2026-10-20

Grasp round 2, from a user's own cup, ball and steering-wheel sessions on 3.0.2.

Motion

- A grasp's IK target, QA REACH, the reachGrip contact and a goal's `near`
  read one measure: the held part's surface. A cup reach that read 0.845 m
  short while its goal passed now reports the real miss.
- A steering wheel (a thin disc) is a rim socket: each hand keeps its spot
  on the rim while the wheel moves.
- A stance inside what it stands in slides out of it; standIdle with no `at`
  before a reachGrip steps up within reach (`observations.placed`).
- An upright cup or can is wrapped from the side, not covered from the top.
- A reach to grasp moves like a person's: the wrist peaks at about a third
  of the reach and approaches slowly, the hand stays open wider than the
  object and closes on the approach, and the head turns to the object first.
- reachGrip names its fingers' prop apart from an existing one, cuts a hold
  past the take's end instead of refusing it, and `motion.report` accepts
  `characterId`. Contact sheets with a focus follow it when it moves.

Studio

- The command bus can run several agent tasks at once, each inside its own
  scope (objects, characters, shots, stage, timeline, scene), with scoped
  cancel and undo. The agent still runs one turn at a time until the task
  mode ships.

## 3.0.2 - 2026-10-19

Fixes from an audit of the latest Studio agent sessions, and a grasp round.

Agent

- A scene-document read answers each take's specId instead of its whole
  source (460k → 4k characters on a large scene); a character named in
  `ids` gets its spec once. A read of several kinds stays under 90,000
  characters and lists what it left out in `omitted`; one tool result is
  cut at 100,000 characters.
- `undo_edit` reverts the agent's own newest edit inside its message; the
  message still lands as one undo step.
- A job that answered keeps its answer when a toast appears meanwhile
  (a compile no longer fails because the user entered Pose mode).
- The reply-language reminder repeats during long messages.

Objects and motion

- New `text` object: words in one action, flat (any script) or extruded
  (Latin), with a bundled font loaded only when needed.
- A prop let go on a moving body (a truck seat, a hinged lid) rides it.
- An object anchor takes `grasp` (power, pinch, hook, palm) and an optional
  socket: the compiler turns the hand by the object's part (a bar, a grip,
  a magazine) or a stored `object.grasp` socket; two hands put a grasp
  anchor on each part, and a group can be an anchor.
- No pop when a carry's keys take the hand at the grab, and a prop point on
  the carrying hand stays on the object outside the carry.

## 3.0.1 - 2026-10-19

Fixes from an audit of recent Studio agent sessions.

Motion

- Whole-body pitch and roll take full turns; new skill `flip` (back, front,
  cartwheel).
- New skill `hitReaction`: a body hit by an object or a person is thrown,
  lands and comes to rest.
- Other characters' installed takes are bodies for QA and anchor targets
  (`{kind: "person", person, bone}`, refs `person:<id>.<Bone>`).
- A dropped object tumbles and rests on a stable face.
- The `fist` and `grip` thumbs wrap the fingers instead of standing up.

Studio and agent

- QA reads as problems (`qa.problems`), not frame-level issues, on the draft
  card, the timeline beats and the receipt summary.
- The agent's requests carry less old bulk (older images and receipts are
  shortened at call time), replies follow the user's language, and the plan
  image comes only when staging or the scene asks for it.
- The agent can place a character within ±240 m, rename a shot and set a
  shot's camera mode (`shot.setCameraMode`). `object.attach` no longer
  crashes, and an editor fault answers `INTERNAL_ERROR`.
- Playback no longer stutters in large scenes: panels stop serializing the
  scene on every render.

## 3.0.0 - 2026-10-19

Motion is computed, not generated. The Studio agent writes a motion spec (key
poses, skills, walks, contacts and goals) and a deterministic compiler in the
browser bakes it frame by frame and measures it with QA. The agent compiles,
reads the numbers and fixes the spec in seconds, with no GPU host.

Breaking

- The motion-generation backend (ARDY with Kimodo) is removed, and with it
  text-to-motion generation, AI video, video motion capture, line edit,
  AutoPhysics, platform fit and the collision fixer. `npm run dev` starts no
  motion bridge and `CCLAY_KIMODO_HOST` is no longer read.
- Motion is stored as a new take, `cozyclay.take.v3`: per-bone rotations on
  the X Bot and Y Bot rigs, the hips' path, object tracks and the spec that
  made it. A 2.x project still opens, but its generated (npz) motion is
  dropped when the project is read; compile new motion for its characters.

Motion compiler

- `motion.compile`, `motion.qa`, `motion.sample`, `motion.describe` and
  `motion.keyObject`. Specs combine keys, generators and skills (`standIdle`,
  `walkTo`, `sitInSeat`, `exitCar`, `reachGrip`, `smokeCigarette`), with
  two-bone IK limbs, finger presets and hand anchors on the world, the body,
  bones, moving objects or the mouth.
- QA measures collisions with scene objects and the body's own skin, foot
  slides, floating, reach, balance, elbow, knee and wrist limits and pops, and
  names each issue's cause with a hint. Hints become patches that
  `repair` rounds apply; `goals` (near, above, moved, still, speed, ordering)
  state what the motion must do.
- Held props: grab and release, carried groups, keyed and falling objects,
  prop kits and aim keys; the arm follows what the hand holds.
- The walk rolls heel to toe, sets its hips from the legs, keeps an uneven
  natural rhythm, and scales its knees, ankles, arm swing and trunk with its
  pace. A held pose breathes and shifts its weight.
- Compiles run in a Web Worker, off the editor's main thread. The Sequencer
  cuts, retimes and trims an installed take.

Look

- Practical point and spot lights, glow, lighting looks
  (`stage.applyLighting`), sky light with ambient occlusion and HDR
  environment maps.
- Deterministic effects: smoke, exhale, steam, fire, sparks, dust, rain, snow
  and a motion trail.
- Characters default to white clay; the outline ink is at half strength.

Agent and Studio

- The agent's motion drafts show while it works: as beats on the timeline,
  as a ghost on the character and in the panel, which also shows the running
  turn's reasoning and steps. Replies render their Markdown.
- Contact sheets pick beat frames, add views that show depth, and draw
  trails and onion-skin ghosts; the viewport has ghosts too.
- The agent cuts for a new view and lays a camera move as one rail.
- Connect a model runs the agent runtime's own provider login; keys are
  checked before they are kept. Supervisor review is off by default.
- Objects scale down to 1 cm, inspect reports each object's world box,
  verify reports support gaps, and a follow dolly goes up to 40 m/s.

## 2.1.1 - 2026-10-13

- Include the sampled framing fix, embedded composition-guide controls, and
  playground guide coverage merged after the 2.1.0 package was published.

## 2.1.0 - 2026-10-12

Storyboard and Animation modes. A project is now either a storyboard (a row of
still panels) or an animation (moving shots); both are on in a normal launch.

Modes

- The start screen has a Storyboard / Animation control, the project keeps its
  mode through save and reopen, and the top bar shows it as a badge. A
  storyboard project hides the Generate group and Motion mode (`4`); motion
  commands are refused with a reason instead of failing quietly. (#649, #650)
- The bottom dock has a **Board** tab in storyboard projects: one card per
  panel with a greybox thumbnail, caption, hold, duplicate, delete and
  drag-to-reorder. Each panel can keep its own cast placement. (#640, #641)
- **Stylize** turns a panel into a finished picture through the image route
  and keeps it in the project beside the greybox; **Send to Workflow** puts
  the stylized image or the greybox on a Workflow canvas with a connected
  Video node. (#643, #645)

Capsule figures

- A rigless **Capsule figure** joins the Assets tile list for blocking: stand,
  sit or lie, set in Details. It follows root paths in the viewport and in
  exports. Rig-only tools (Pose, IK, motion, take import, physics) refuse it
  and say why. (#634, #635)

Storyboard exports

- The Export menu of a storyboard lists **Contact sheet (PNG)**, **Panel pack
  (zip)**, **All panels (zip)**, **Animatic (mp4)**, **Cut list (OTIO)** and
  **Depth + normal (PNG)**. File ▸ **Export as Animation project…** turns the
  panels into an Animation project. Keyframe pack and shot video stay
  Animation-only.

Agent and MCP

- In a storyboard project the Studio Agent adds one panel per request, frames
  it and never generates motion; the Studio context and `describe_scene` now
  report the project mode and each character's kind. (#637, #642)
- MCP motion tools answer `NOT_IN_MODE` in a storyboard and
  `TARGET_NOT_READY` on a capsule figure; `add_character` takes a model and
  posture. (#652)

Analytics and docs

- Three counts-only events: `storyboard:panel_created` (`source`),
  `storyboard:panel_stylized` (`outcome`) and `cast:proxy_added`
  (`surface`); `scene:created` carries `previs_mode`, and the export
  `export_kind` vocabulary gains `contact_sheet`, `panel_pack`, `animatic`
  and `animation_project`. Captions, names and prompts are never properties.
  Disclosed in `docs/privacy.md` and `docs/analytics-queries.md`. (#653)
- README has a **Modes** section; the Agent rules, the Studio IA and the
  capsule-figure notes are updated. (#653)

## 2.0.2

The first-run audit release: `npx cozyclay` is exercised end to end as a new
user, and the things that broke on that path are fixed. 2.0.1 (the camera
tutorial refresh and light-mode default, #586) was tagged but never reached
npm; this release carries it.

Agent and package

- The Studio Agent panel in the npm package answered every turn with
  "502 — agent unavailable": the sidecar's Studio tools imported `three`
  (a devDependency the package does not ship) through `src/scenes.js`. The
  timeline clock moved to its own module and a test now walks every import
  reachable from `bin/` and fails on any chain to `three`. (#591)
- A CLIProxy key in the environment no longer leaves the panel on the ChatGPT
  sign-in wall; readiness counts every key-authenticated provider. (#591)
- `CCLAY_KIMODO_HOST=… npx cozyclay` died at start with
  `Cannot find package 'three'`: the motion bridge now runs from the staged
  MCP runtime (which carries `three`, `tools/` and `dist/models`), and the
  package isolation test keeps it that way. (#591)
- A live-hub port already taken by another CozyClay is reported on the
  launcher's terminal and named in the pane's error instead of
  "Studio execution is not installed"; agent handler failures are logged
  before the 502; a session id with no record no longer shows
  "Previous conversation could not be restored". (#591)

Studio

- Create on the start screen opens the selected sample scene under the typed
  name instead of an empty stage named after it; starting over with unsaved
  work asks first. (#591)
- Reloading a project created from the start screen brought the previous
  session's walking take back onto the character, with "Unsaved changes":
  the hosted-demo seed re-fired on every mount while the bridge probe was
  down. It now skips a saved project (a `?scene=` launch still seeds), and a
  reload opens on the clean checkpoint. (#591)
- With a take installed, the gizmo and the Transform panel's Position and
  Rotation move the character again; the take keeps animating relative to
  the new placement. (#591)
- The shot card's hover actions sit above the card, so clicking a short
  shot's name selects it instead of hitting Delete. Draw rail is disabled
  with a reason when no shot is selected. (#591)

Tests

- The start-screen and project-menu browser suites run against the v2
  shell again, gain the sample-card Create regression, and join the CI
  browser matrix as observation suites; new regressions cover the package
  import graph, CLIProxy readiness, the stage transform and the reload
  session. (#591)

## 2.0.1

- The camera tutorial follows the v2 shell and new installs default to the
  light theme. (#586)

## 2.0.0

CozyClay 2.0 is the v2 editor: a floating-glass shell with light and dark
themes, one four-mode Studio (Stage, Pose, Camera, Motion on keys 1-4), and
the v2 Outliner, Sequencer, start screen, Details panels and Preferences.
Under it, every document edit, whether it comes from the UI, the Agent panel,
MCP or the CLI, now runs through one command bus on a document store with one
undo history, so anything the editor can do is callable by an agent without
separate wiring. The Studio Agent panel in the npm package works again
(#576). **No MCP tool or CLI command was removed**: legacy MCP tools are
aliases of bus commands and answer the editor's receipts.

Studio

- Floating-glass shell: the viewport fills the window and the top bar, both
  columns, the dock and the status strip float over it. Light and dark
  themes, and the stage follows the theme live. The dock runs Animation |
  Assets tabs sized to the Sequencer's lanes, with the shot preview docked at
  its right end; the standing status row is gone and live export status
  floats in the viewport. (#570, #572, #519)
- One four-mode switch, Stage, Pose, Camera and Motion, on keys 1-4. Pose
  mode is the single way into IK (W/E/R pick ik, trail and pin there); the
  timeline IK toggle and the Rig Control IK buttons are gone, and leaving
  Pose ends IK. (#521)
- v2 Outliner: 36 px header with the item count, search, typed rows, amber
  selection; right-click Create replaces the toolbar's + Add object. (#525)
- v2 Sequencer: header, readout and actions, a 190 px track tree, clip
  fills, amber playhead, keys and pin bands, scrollable camera, rail and
  crane rows. (#528)
- v2 start screen: project nav, template categories, recent rows, the
  browser project store and a project preview; File › New opens the same
  screen. (#531, #551)
- v2 Details panels and primitives: pose tools with an auto-fix preview,
  motion details with takes, the viewport toolbar and overlays, the top bar,
  menus and status bar, the content browser and log, and the Preferences
  dialog. (#522, #523, #524, #526, #527, #529, #530, #532)
- Generate actions have one home: the top-bar Generate Motion button runs
  every prompt block when any block has text. Copy follows v2: "ARDY" leaves
  the user-facing text, pose toasts say "Pose mode", path endpoints read
  PATH START / PATH END, the first-run guide says Outliner. (#550, #551)
- Top-View props recede so the camera, cast and rail read first. (#566)
- When WebGL is unavailable the stage says so instead of staying blank. (#518)
- 194 dead CSS rules are gone and the v2 information architecture is
  recorded in `docs/studio-ui-ia.md`; Details, Outliner and top-bar props
  that were never read are dropped. (#533, #552, #556, #558, #560, #562)
- Korean UI: 56 reversed `ko()` argument pairs in the motion card are fixed
  (#505, by @romanr), as are the VideoCapturePanel quality-gate messages
  (#565).

IK and motion

- IK and motion trails on the split architecture: delta IK drag baking over
  the raw clip, per-key blend persistence, a remembered IK camera entry,
  trail picking against the rendered rig, limb, head and root trail edits
  with conflict warnings. (#511)
- Range pin with an exact hinge solve and body reach compensation, carried
  through persistence, undo/redo, timeline bands and preview markers. (#515)
- Fit to platforms with Fit / Remove controls and a stable knee bend side,
  verified over 784 cases with no reverse bends. (#517)
- One motion generation pipeline on the job contract: `motion.generate`
  serves the UI, the Agent and MCP alike, with concurrent-edit parity (a
  stale job publishes nothing, an unrelated object edit still installs),
  Stop and cancel, reconnect, and receipt undo. The agent-only motion
  pipeline is deleted. (#444, #452)
- Image-to-video motion is named `i2v` in code and "AI motion" in the UI;
  "fal" names only the provider adapter. Command ids, analytics values and
  persisted values are unchanged. (#509)

Command bus and document store

- Every document mutation runs through one command bus: wire transactions,
  a scoped job fence, receipts, refusals and exposure. Action registrations,
  the agent binding and the domain writers moved out of App.jsx. (#435,
  #437, #459, #460, #477)
- A document store owns stage, objects, shots, cast, motion and IK, and
  project and scenes, each routed through the bus, with collection element
  kinds and cross-domain undo order. (#449, #447, #445, #441, #442, #448,
  #461, #480)
- One store-owned undo history; the per-domain history owners are gone.
  (#494) Duplicate agent paths are removed: `inspect_studio`, `run_action`
  and `verify_result` are the three tool families, `operate_studio` is an
  alias, and selection, playhead and view changes add no undo entries.
  (#495) The writer baseline is zero and parity is complete: all 62
  document-mutating UI handlers reach `run`, enforced by ratchet tests and
  a generated parity matrix. (#436, #496)

Agent

- The Studio agent pane reaches the whole Studio through the action
  registry the UI dispatches through, and every bus command is discoverable
  and callable through agent `run_action`, MCP `studio_commands` /
  `studio_run` and `cclay live commands` / `cclay live run` with no
  agent-specific wiring. (#423, #438)
- Motion failures are visible and routable, `verify_result` reports
  honestly, and a failed attempt no longer uses up the message's one
  generation. (#426)
- Minimal Studio Agent panel: an icon-only head, the account under the ⋯
  menu, one-line notices, an empty state with suggestion chips; it sits
  under Details in the right column instead of replacing it. (#574, #570)
- In the npm package the Studio Agent panel loads its live tools from the
  staged MCP runtime that `cclay mcp` installs once per version, so the live
  hub starts and the pane works; `mcp/mesh-file.mjs` ships with the package
  and `cclay mcp` starts again. A runtime that cannot be installed is
  reported on the launcher's terminal. (#576)

MCP

- Legacy tools are thin aliases of bus commands and return the editor's JSON
  receipts: revision before and after, retained undo and refusal codes.
  `apply_batch` maps to `objects.batch` and keeps `atomic`, `stopOnError`
  and one undo entry; replacing scene ids needs a Studio-issued confirmation
  token. (#446)
- `initialize` waits the SDK's default 60 s. (#502)

Analytics

- Builder telemetry: pose edits, i2v motion A→B, `$exception`, a device
  profile (GPU and frame rate), the install source from
  `npx cozyclay --via`, use case and update status. (#466)

Tools

- A mocap research bench under `tools/bench/` and `tools/gt-render/`:
  ground-truth part-colour renders with camera truths (#428), a GVHMR
  extraction bench (#430), a scorer for pose, trajectory, endpoints, overlap
  and contact (#431), 3D fit stages F0-F5 (#432), a cube-contact scenario
  (#454), the observation-driven GVHMR tuning ladder G0-G5 (#462, #488,
  #492) and the known-character tracker T1 (#500).

Housekeeping

- The camera-rail browser test waits for the delete toast, which exposed and
  fixed a stale-toast dismissal bug (#470, #483); the lifecycle test waits
  for the grandchild to disappear (#479).
- The owner's v2 editor design contract is adopted in the docs (#512).
- Repository traffic is archived to the `metrics` branch twice a week.

## 1.10.0

Props and characters can now be hidden without being deleted, the Studio top
bar no longer collapses at 1100px when a live workspace handle is shown, and
the MorphGS mocap experiment gets its conversion scripts, a playback
regression test and a cluster setup script under `tools/morphgs/`.

Studio

- Hide or show a prop or a character from the hierarchy eye and the row
  context menu. The row, selection and inspector stay; move handles appear
  only while the object is on stage. A hidden parent or a hidden character
  takes its children and carried props off the stage, out of collision and
  off the ground while their own eye stays on. Hidden state survives
  save/reload and Ctrl+Z. (#416, by @bjoernfal)
- MCP `update_object` and the Studio agent's object `update` op accept
  `hidden`; `describe_scene` marks hidden props. The OTIO cut-list export
  leaves hidden props out of the blocking metadata. (#416)
- The Inspector Parent select writes through the history store, so a
  reparent no longer disappears on the next object edit. (#416)
- The `Live workspace <uuid>` handle in the top bar stays on one line and
  truncates with an ellipsis instead of wrapping over Settings and Export at
  1100px; the responsive browser QA now asserts that top-bar chrome does
  not overlap. (#321)

Tools

- `tools/morphgs/`: `fbx2morphgs.mjs` (x-bot FBX → MorphGS mesh + compressed
  rig, drops the zero-length duplicate bones FBXLoader creates and appends the
  required `fixed_joint` line), `morphgs-to-cskel27.mjs` (rot_params +
  pred_joints → playback NPZ), `setup-on-cluster.sh`, `demo-gate.sh` and the
  `--mode none` preprocess patch, with `test/verify-morphgs-exporter.mjs`
  checking the exporter against MorphGS's own Animation.step. (#415)

## 1.9.0

The Agent panel moves onto the open-source pi harness with six model
providers, the Studio gains a gated Fal H3 motion workflow with a
mocap-readable mannequin, and the codebase sheds its dead exports and
committed research artifacts. **Node 22.19 is the new floor**, and Agent
sessions saved by earlier versions are skipped, not migrated.

Agent

- The Agent panel runs on the open-source pi agent harness
  (`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`, MIT), which
  the sidecar loads only when a turn starts.
- Six model providers instead of one: ChatGPT (the same Codex sign-in),
  Anthropic, OpenAI, Google Gemini, OpenRouter and a self-hosted CLIProxyAPI.
  Model ids read `provider/model`, and a bare id still resolves to the ChatGPT
  provider. API keys come from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY` or `GOOGLE_API_KEY`, `OPENROUTER_API_KEY` and
  `CLIPROXY_API_KEY`, or from `~/.config/cozyclay/providers.json` (mode 0600),
  managed through `GET/PUT/DELETE /agent/providers`, which never return key
  material. Saved keys are validated before they are advertised as usable.
- A running Workflow turn can be steered: `POST /agent/turn/<turnId>/steer`
  hands the text to the model at the next step of the same turn instead of
  stopping it. Studio turns keep their frozen envelopes and refuse with
  `STEER_UNSUPPORTED`.
- Conversations are stored in a new v2 transcript format that keeps each
  provider's own message fields. Sessions saved before this version are
  ignored, not migrated: the files stay on disk and are skipped by History.
- Images can be pasted or dropped into the Agent composer and travel with the
  turn; pasted attachments come back as thumbnails in a resumed session.
- Studio Agent sessions persist across reloads, and the shared panel is split
  into a surface-neutral core plus a Studio adapter whose receipts land as
  Inspector rows.
- Studio commands: `patch_elements` is one thin family derived from the
  element declaration table (environment description, style and sheet flag
  included); element ranges are the single source of truth, partial receipts
  are reported, revisions are read-safe, and a session re-admits within a turn.
- Stop handling: a Studio stop that names a motion job this session never
  admitted is refused; retired jobs no longer accept stale stops; the model
  registry is built single-flight and refreshed on sign-in.

Studio

- Gated Fal H3 motion generation: the capture card and a wide authoring modal
  with duration, motion description and an editable prompt. References are
  accepted only from a fixed camera with the palette mannequin, clipped or
  unshaded references are rejected, and Fal video routes through H3 Max Turbo.
- The mannequin is readable for mocap input: separated palette hues per limb
  and two eye marks on the face; a warning fires before cropped mocap framing.
- Motion extraction: hybrid 2D keypoints use palette-derived joints where the
  render lost a part (face from ViTPose); GVHMR takes get a sigma-3 smoother and
  a foot-anchored root. Clearing a motion take also drops its persisted
  `motionRef`.
- Look through has one entry in the Shot monitor; the on-screen Shot camera
  indicator and Esc return to the free camera without a duplicate toolbar
  toggle.
- Camera fly, pan and orbit lock the pointer for the hold: the cursor hides,
  the view can turn past the window edge, and release puts the cursor back
  where the press started.
- One undo entry per key light, environment and character transform gesture;
  agent camera history stays reachable after an object undo; persistence
  elements are declared and verified.

Housekeeping

- Dead exports, duplicate 500 handlers and the committed `.omo/` research
  artifacts are gone (#411). The README is restructured around the user path.
- `cclay live` and the agent sidecar share one workspace-selection rule.
- Agent tests keep their sessions out of the author's config directory.

## 1.8.1

The Studio camera tutorial now starts where the landing page does and shows
where to click. Look-through flies the shot camera instead of opening the player.

- Opening the tutorial (Settings ▾ → Camera tutorial or `/app/?tutorial=camera`)
  loads the City Block starter scene with the walk take on its character, at
  frame 0 in the free camera, so Shot / Rail / Play have something to frame.
  A scene with unsaved changes is replaced only after a confirm.
- Each step points at its control: a pulsing spotlight plus a numbered beacon
  and caption pinned to `+ Add shot`, the shot block and `Draw rail`, the
  top view, and the look-through button; the Look / Walk / Dolly / Orbit steps
  show an animated mouse-and-keys cue in the viewport, with the walk keycaps
  turning green as they are pressed. The hint card names the region ("↓
  Timeline, Shots lane", "→ Viewport"). Overlays never take the pointer and go
  static under `prefers-reduced-motion`.
- **Look through** on the Camera bar (and the Shot monitor's expand icon) hands
  the viewport to the shot camera with the same fly bindings as the free camera.
  Esc returns. The chrome-free player remains the Workflow embed.

## 1.8.0

The Studio's chrome gets a research-backed cut: the same capabilities, a third
fewer controls on screen at once, and one place for each of them. A first-time
creator can now learn the camera inside the Studio itself, or on cozyclay.org
before installing, and keep the scene they made. Video mocap gets a quality
gate, and AI video takes are checked against the scene they were supposed to
preserve.

### Studio UI simplification

- Simultaneously visible controls drop from 49 / 54 / 65 (Scene / Camera /
  Motion mode) to 35 / 38 / 51, measured by `tools/qa/studio-control-count.mjs`
  and recorded with the per-control rationale in `docs/studio-ui-ia.md`.
- The top bar keeps five actions. One **Export ▾** menu leads with the keyframe
  pack and folds the mp4, depth/normal passes, storyboard and blocking frame
  under it; the three Record buttons and the inspector's duplicate FOV/Recenter
  are gone. **Settings ▾** holds language and analytics.
- **View ▾** on the viewport bar owns the reference grid, Auto Color and body
  part colours; Move/Rotate/Scale stay on the transform strip only.
- The scene switcher sits on the hierarchy's root row; the Projects… button,
  the root fold caret and the Characters group row are removed and characters
  sit directly under the scene.
- Timeline motion tools (IK, Foot, Body, speed, Clear, take bar) render only in
  Motion mode; Foot snap and Body contact appear only while IK is on.
- The Scene/PlayView tabs are replaced by the viewport's look-through button:
  it enters an explicit preview of the shot camera and Esc returns.
- Selecting the camera switches to Camera mode; the Placement row appears in
  Motion mode; Generate all waits for at least one prompt block.
- The `advancedMode` / `beginnerMode` gates that had been hardcoded on are
  removed.

### Learn the camera

- A seven-step camera tutorial runs inside the Studio: Look, Walk (W A S D
  Q E), Dolly, Orbit, Shot, Rail, Play. Open it from Settings ▾ → Camera
  tutorial or `/app/?tutorial=camera`; each step completes only when the
  gesture actually happens, and the strip never takes the pointer.
- cozyclay.org embeds a live Studio playground on a preset city block with the
  same seven steps, a second demo reel, and leaner copy. The tutorial ends by
  handing over `npx cozyclay --scene city-block`, which opens the local Studio
  on that starter scene; starter scenes are also offered from the project
  browser, and the visitor can download the scene they made.

### Agent panel in the Studio

- The Workflow page's Agent chat column is available in the Studio, toggled
  from View ▾ → Panels → Agent panel or Cmd/Ctrl+B. It boots collapsed so the
  mode budgets above are unchanged.

### Video mocap and AI video takes

- GVHMR is the only extraction backend; the bridge and the Studio return a
  named error instead of silently falling back to browser MediaPipe.
- GVHMR output goes through adaptive position/rotation stabilisation, explicit
  contact correction, support-surface height (a chair lifts the motion), a
  mocap quality gate, and scene calibration that survives restore. Palette
  segmentation diagnostics are exposed for AI-rendered mannequin clips.
- H3 video takes are checked against the requested scene and camera: the
  Workflow shows a lock receipt on success and rejects a take whose background
  or camera drifted, keeping no stale preview.

### Site

- Four search-facing pages (greybox to video, previs software, Seedance camera
  control, privacy), `robots.txt` with an explicit AI-crawler policy,
  `llms.txt`, a generated sitemap with real last-modified dates, and IndexNow
  pings on deploy.

## 1.7.1

- Open the complete Studio at the development server root; the unfinished
  Workflow canvas remains available at `/workflow/`.

## 1.7.0

Kimodo becomes the default motion-generation backend, and a full edit-and-refine
loop lands on top of it: draw over a trail to reshape it, keep most of a take
and regenerate only a window, and step back through 20 checkpoints of a
take's history. Multi-character rigs, prop motion, and camera work all get
real editing surfaces, and three failure modes that used to blank the whole
studio now degrade with a way back instead.

### Kimodo motion backend, now default

- Kimodo, introduced behind `CCLAY_MOTION_BACKEND=kimodo`, is now the default
  motion-generation backend.
- Root 2D path constraints, pose pinning (via Kimodo's fullbody constraints),
  and motion-edit-by-regeneration (IK-adjust a span, then regenerate) now all
  work on Kimodo — base clips still refuse, since Kimodo has no autoregressive
  history input for them.
- The prompt-block cap is raised from 4s to 5s after measuring seam quality
  across block lengths — 5s scored best short of a single seamless take, while
  8s blocks collapsed and sub-2s blocks lost a third of their frames to the
  transition window.

### Draw to edit a take (line editing)

- A new line-edit mode: drag a joint's motion trail to reshape it, or draw a
  fresh stroke across empty space when the trail doesn't reach where you want.
  Stroke endpoints snap to the take's own nearby frames so edits land where
  you meant, and a smoothstep seam keeps the join from popping.
- Pin exact moments in 3D: scrub the playhead, drag a joint into place, and
  pin up to 8 moments across a take.
- Runs on a new ProjFlow-based backend on the Kimodo box; edits are
  seed-deterministic, so a release-quality regenerate reproduces the preview
  bit for bit.
- Ctrl/Cmd+Z undoes the last pull; releasing a drag previews at reduced
  quality first (~1s), then a full-quality generate confirms with the same
  seed.

### Keep most of a take (preserve mode)

- A preserve slider and grouped per-limb masks let you regenerate only part of
  a take — free one limb, or a masked region — instead of the whole clip.
- Effector constraints keep specific joints anchored through a regeneration.

### Take recipes and version history

- Every generate or edit now records its own recipe (seed, prompt blocks, and
  edits in order), and extending a take re-sends its edits so refining before
  extending no longer throws work away.
- A version strip above the timeline checkpoints every generate/edit up to 20
  deep — click any entry to restore that take and its recipe.
- The edit surface collapses to two modes: 장면 (Kimodo blocking — new, again,
  add-block) and 다듬기 (line-edit refinement, one click from a loaded take).

### Multi-character rigs and IK

- Every cast member now gets its own namespaced rig subtree in the Hierarchy
  panel, not just the first — bones, IK badges, and focus all follow the
  active character correctly (#76, #77, #78).
- IK corrections on an inactive character now survive a focus switch instead
  of silently reverting to the uncorrected take (#77).
- Timeline pins (IK correction keys, prompt-clip ranges) migrate through
  segment retimes instead of firing on the wrong frame after a slow-mo (#79).
- Body Contact: dragging a character down during IK editing now stops the
  pelvis at the floor and holds any planted foot or reaching hand there,
  measured per character from the actual skinned mesh — no more clay figures
  hovering above the ground.
- Motion trails now render per body part in IK handle colors, with trail
  editing and IK editing split into separate tools instead of one ambiguous
  shared gizmo.
- A One-Euro filter now smooths SAM-extracted wrist tremor by speed —
  quieting rest-state jitter while leaving fast strikes untouched (#84).

### Prop motion: travel paths and speed

- Scene objects (props) can now be given a travel path, authored the same way
  as a camera rail: draw it in Top-View, refine it in the 3D scene, with a
  mid-route point insertable by double-click.
- A speed graph — shared by props and the camera dolly — lets you drag a
  stretch of the timeline faster or slower; the area under the curve is the
  distance, so the rest of the segment compensates automatically, and a cut
  pins the take at an exact time/distance point.
- Drag a prop onto a character or a specific rig bone in the Hierarchy to
  attach it — it now rides that character's motion (a carried bat stays in a
  walking character's hand instead of staying world-anchored).

### Viewport and lighting

- Auto Color mode: a topbar toggle stamps a stable, automatically derived
  color onto every set object, the way Blender's random viewport shading
  colors objects — display-only, so authored colors, saved projects, undo
  history, and the MCP scene view are untouched.
- A new Grid view swaps the clay stage for a dark, Blender-style reference
  grid for blocking work — overlay-only, so exports and the plan board never
  see it.
- The key light is now a grabbable sun: move it like any other object, and
  dial its warmth between cool daylight and warm sunset amber.
- Blender-style composition guides (thirds, golden ratio, center+diagonals,
  safe areas) on the shot preview, and exported frames can burn in a slate +
  zero-padded frame counter.

### Camera

- Crane marks get a 3-axis gizmo; a rail now always carries a crane profile,
  and the old on/off toggle is gone (a flat profile at the follow height reads
  as "off").

### Project workflow

- A startup chooser and local project session replace the always-on implicit
  scene.
- New workflow-focused camera motion modes, plus several passes cleaning up
  timeline control grouping, control visibility, and removing legacy
  console/generation panels.

### AI control (MCP)

- `describe_scene` now reports the key light and the shot list; `update_object`
  can set a prop's travel path; `load_motion` can target a specific character
  by letter/slot/id and re-install an assembled take without a full
  regeneration.
- Editors now identify themselves (project, scene, cast size) in
  `live_status`, so multi-tab routing no longer depends on an opaque UUID.

### Hosted demo v1

- cozyclay.org's install-free demo got a real backend: a Cloudflare Worker
  queue (Google OAuth + Turnstile, single-FIFO D1 queue, private R2 result
  proxy) and an outbound-polling GPU box worker with zero inbound sockets.

### Reliability

- Three failure modes that used to blank the whole studio now degrade
  instead: a render error anywhere in the app shows a message with a
  reload-and-resume, a lost WebGL context (sleep/wake, driver restart) shows
  an overlay and repaints on restore, and layout-save writes are guarded like
  every other write in the app (#64).
- A selected object's own gizmo cage no longer blocks clicks meant for a
  different object (#81).
- Recording no longer exports frozen tail frames after a cast member or
  motion segment shrinks (#80).

### Also in this release

- Onboarding: a hosted-demo visitor now gets a "watch the sample" path instead
  of landing on an empty stage, and three funnel-measurement gaps (startup
  scene creation, video export, cutout import) are closed.
- The studio's PWA update banner finally has a listener, so a waiting version
  reloads on request instead of running stale indefinitely.
- Objects can now be parented from the Inspector's own Parent picker, not
  only through MCP.

## 1.6.0

The official npm package now records anonymous product usage so downloads can
be distinguished from real launches and returning use.

- `npx cozyclay`, `bunx cozyclay`, and global `cclay` launches get a
  signed-package-verified anonymous installation ID.
- The existing scene, edit, motion, export, and activation funnel is available
  for npm sessions with `distribution: npm` and `app_version` properties.
- Source checkouts, forks, CI, tests, malformed or unsigned packages, and
  opted-out launches remain untracked.
- `cclay telemetry status|on|off` controls the package-wide setting; the
  in-app toggle stays synchronized with it.
- URL/referrer/campaign-derived values are scrubbed before any event leaves the
  browser, and corrupted telemetry state fails closed.

## 1.5.0

The release where the camera can climb a shaped path, recordings leave the studio as
standard MP4 files, and generated falls finally reach the ground.

### Shape a crane move

Rail Follow now carries a persisted crane-height profile with two to eight points instead
of only a start and end height. The camera evaluates the profile with a monotone cubic
curve, so it passes through every authored height without overshooting. Purple handles in
the scene and matching markers in each Shot card stay synchronized: drag vertically to set
height, Shift-drag along the rail, double-click to add a point, and delete an interior point.
One undo reverses one complete gesture, and older `{start,end}` projects migrate to pinned
endpoints automatically.

### Record a real MP4

Record now downloads a fast-start H.264 MP4 at 24 fps instead of WebM. The exporter tries
High, Main, then Baseline AVC profiles, keeps frame-addressed deterministic rendering, and
fails by name when the browser has no compatible H.264 WebCodecs encoder rather than
producing a misleading MP4 that desktop editors cannot open. Mediabunny performs the
in-browser muxing and is documented in the third-party notices.

### Falls that read in previs

When generated motion walks off its support, CozyClay can stage a ballistic root drop with
horizontal drift, a readable fall clock, and an impact hold instead of leaving the character
suspended at the roof edge. Motion completion now means the editor acknowledged and
installed the take: explicit rejection fails visibly, reconnects do not duplicate the
installation, and an uncertain lost acknowledgement is never retried as though nothing
happened.

### ARDY bridge fixes

- Local runner options now reach the bridge instead of disappearing between processes.
- Camera-clause cleanup no longer mistakes ordinary object nouns for camera instructions.
- The prompt guide distinguishes measured upstream behavior from local authoring heuristics.
- Demo and operations documentation now use supported options and cite the four-second
  waypoint-history evidence honestly.

## 1.4.1

Gizmo drags survive past their first tick again. The split-camera work in 1.4.0 wrapped the
gizmo's change callback in a shot-camera dispatcher that dropped the drag-transaction token,
so every arrow, plane, knob, and ring drag was closed by its own first move — objects moved
one snap step and stopped. The token now round-trips, and the gizmo suite drives the ring
with a real arc and the plan puck in the Top-View inset, matching how the studio actually
works today.

## 1.4.0

The release where every edit can be taken back.

### Undo, everywhere

One Ctrl+Z history now covers the whole editor, not just character moves. Newly undoable:

- **Prompt blocks** — add, remove, drag, edge-resize, and text edits (one entry per editing
  session, not per keystroke).
- **Root waypoints** — floor-click placement, timeline removal, and Top-View drags.
- **Camera authoring** — camera keys (add / re-time / remove / clear), camera-block settings,
  rail schedule moves and resizes, rail removal, and viewport or plan framing commits.
- **Shots** — delete, add, split, duplicate, reorder, boundary resize, and rename.
- **The Full-Body take** — segment cuts, retimes, deletions, trims, and clearing the take
  (the cleared clip, IK keys, and stature all come back).
- **Poses and the cast** — pose apply / reset / save, model swap, tint, subject text, and
  inspector position scrubs.
- **IK keys** — add, remove, and drag-bake; undo snapshots now carry the key map itself.

Every continuous drag records exactly once at gesture start, so a long drag is one Ctrl+Z,
never a hundred.

### Cut the take like film

The Full-Body strip is now a cutting room: cut at the playhead, then grab a segment's amber
right-edge grip and stretch it — the width IS the playback rate (wider is slower, 0.1×–4× on
the same grid as the numeric editor). Right-click a segment to delete it outright. All of it
is non-destructive: the source frames stay whole, and a right-click on a trim handle still
restores the full take.

### Two cameras, one stage

The editing view and the recording camera are no longer the same eye. The main pane belongs
to a free editor camera — fly it, inspect the set, scrub playback — while the shot camera
records through a chrome-free 16:9 preview and stands in the scene as a selectable ghost you
block like any other body. Look-through hands you the old framing-by-flying when you want it,
and leaves your view alone when you don't.

### A hardened MCP

The server now enforces loopback-only hosting, rejects forged HTTP origins, refuses project
files with hard links, isolates live scene documents and generation artifacts per session,
and preserves motion-job ownership across reconnects. HTTP session children inherit the
parent's configuration (a configured bridge URL no longer silently vanishes), and a session
that cannot own the live editor port now says exactly why instead of pretending no editor
exists.

### Everything else

- **Selection** — clicking empty floor or sky reliably clears the selection; the selection
  cage's generous line hitbox no longer swallows the press.
- **Timeline** — the camera block's preview button plays its shot instead of throwing.
- **CI** — pull requests are gated on the node and browser suites.
- CozyClay now ships as an `AGPL-3.0-or-later` combined work. Modified versions offered over
  a network must offer their users the corresponding source, and the Studio footer carries
  that source offer.

## 1.3.0

The release where the studio stops being something only a person can drive.

### Direct it with an AI

CozyClay now ships an [MCP](https://modelcontextprotocol.io) server. Point Claude, Cursor, or any
MCP client at it and ask for a shot in plain language — it places the cast, frames "a low wide
profile", generates multi-phase motion, and **the viewport moves while you watch**.

```json
{ "mcpServers": { "cozyclay": { "command": "npx", "args": ["-y", "cozyclay", "mcp"] } } }
```

It computes nothing of its own. Every answer comes from the modules the studio already renders
with — `shot.js` for film vocabulary, `scenes.js` for the stage, `camera-move.js` for moves — so
the server and the UI cannot disagree about what a 35 mm medium shot is.

- **Live or headless.** With a studio tab open, tool calls drive the real viewport over a local
  socket. With no tab, scene/project tools still block scenes, derive framing, render prompts,
  and write `.cclayproject` files; capture, prompt-block installation, motion generation and
  atomic live batches remain editor-only.
- **Motion from plain beats.** `generate_motion` preserves composite physical wording while
  stripping camera, scenery and internal-state language ARDY cannot animate, splits only beats
  that exceed ARDY's duration bound, and lands each phase as a Prompt Block on the timeline.
- **24 tools**, all documented in [`mcp/README.md`](mcp/README.md).

### Cut a photograph out and stand it up

Drop an image on Props — or straight onto the shot — and it becomes a card you can place, turn and
block against. The background editor lives in the card's own inspector: paint or erase the
selection, zoom and pan with the wheel, and the picture sits on a stage rather than being framed
by one. Assets are stored once by content hash, so the same picture imported twice costs one copy.

### An open stage

The two-walled room corner is gone. The set is a 500 m open deck — far enough that no ordinary
blocking meets its edge — with a two-tier grid (quiet 1 m cells, assertive 10 m lines) and a
distance falloff that dissolves the floor into the background instead of ending at a horizon.
Movement clamps moved from ±11 m to ±240 m, so a run or a chase finally has room.

### Group props and move them as one

Scene objects now carry a parent. Build a rocket from ten primitives, group them, and the whole
thing drags as one body — through the gizmo, the inspector and the MCP tools alike. Deleting a
parent promotes its children rather than taking them with it.

### Everything else

- **Gizmo** — the cast rides the same gizmo as scene objects, with rotate and scale; an XZ pad for
  free ground drags; pick targets balanced so the pad no longer swallows every press.
- **Mocap** — a video capture panel, takes assigned to cast members, and take trimming.
- **Timeline** — authoring runs on a 24 fps production clock while ARDY is still spoken to at
  20 fps, and exports record at true motion speed.
- **Multi-character** — an unbounded cast with per-character motion layers.

### Fixes

- Props reported `1x1x1` regardless of how they were built: scale never crossed the live protocol,
  and the server reset whatever did arrive. Sizes are now real, and per-axis scale is exposed.
- A 6 m ceiling survived the walls it belonged to, silently decapitating anything tall.
- Generating four Prompt Blocks produced one. IK keys from a discarded take made a fresh run look
  like a local edit, and that path ships no schedule. Replacing a take now clears the corrections
  authored against it.
- A stale service worker served yesterday's bundle to the dev server, so edits appeared to do
  nothing. Dev now serves a self-destructing worker.
- Prompt blocks are capped at 4 s everywhere, not just in the UI — longer beats chain instead of
  being authored into something the timeline would refuse.

### Packaging

- `mcp/` ships with the package, so `npx cozyclay mcp` works without a clone.
- `exports` makes `cozyclay/src/*` a public contract instead of an accident.
- `three` is declared as an optional peer: the studio bundles its own copy, but anything importing
  `cozyclay/src/*` needs it, and now npm says so.

## 1.2.0

- `npx cozyclay` opens the studio again.
- Stopped shipping 26 MB of scratch files.

## 0.1.0

First public release.
