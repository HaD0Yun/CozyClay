# lowvis prototype: contract

A 17-joint box-like figure replaces the X Bot / Y Bot as the default previs body. This prototype answers one
question: **how does the figure move?** The user judges side-by-side videos. No Studio integration, no PR, no CI.

## Fixed files (do not edit; report a needed change instead)

| File | What it fixes |
|---|---|
| `src/lowvis/rig17.json`, `rig17.js` | The 17 joints, parents, rest positions (m), tips, `fk()`, quaternion helpers |
| `src/lowvis/clip.js` | `lowvis.clip.v1`: the only thing an engine hands to the viewer; `validateClip`. A character may carry `scale` and `tint` (see "Body size and colour") |
| `src/lowvis/demos.js` | The four demos: scene, beats, frame ranges |
| `tools/lowvis/sample-clip.mjs` | Example use; writes `public/lowvis/clips/sample/*.json` |

Conventions: metres, Y up, floor y = 0, rest figure faces +Z with +X on its left, 24 fps. A joint's quaternion in a
clip is its world rotation **from rest** (identity at rest).

## Who owns what

| Part | Owns | Output |
|---|---|---|
| Engine m3 | `src/lowvis/engine-m3/`, `tools/lowvis/engine-m3/`, edits in `src/motion3/` | `public/lowvis/clips/m3-xbot/<demo>.json`, `public/lowvis/clips/m3-17/<demo>.json` |
| Engine simple | `src/lowvis/engine-simple/`, `tools/lowvis/engine-simple/` | `public/lowvis/clips/simple/<demo>.json` |
| Viewer | `lowvis/index.html`, `src/lowvis/looks/`, `src/lowvis/viewer/`, `tools/lowvis/record*.mjs` | the page `/lowvis/`, videos in `lowvis-out/` |

Every engine has `tools/lowvis/<engine>/build.mjs`: it builds all four demos, runs `validateClip` on each, writes
the clips and prints `buildMs` per demo.

## Look interface (`src/lowvis/looks/index.js`)

```js
export const LOOKS = { box, capsule, stick, man, woman, block };  // each: ({ tint }) => look
// look = { object3D, setPose(pos, quat, frame, grip) }  // pos/quat: a clip character's flat arrays
// grip (optional) = { Left, Right }: truthy where that hand holds a prop at this frame, read from the clip by
// src/lowvis/grip.js. A look may close such a hand (the block look shows a fist); a look may ignore it.
```

## Viewer page (`/lowvis/`)

- `?panels=<engine>/<demo>:<look>,<engine>/<demo>:<look>,...` One panel per entry, a grid, the same camera in every
  panel, a label per panel (engine and look). `&view=three|front|side|top` (default `three`), `&cols=<n>`.
- `window.lowvis = { ready, fps, frameCount, seek(f), play(), pause() }`. `ready` is a promise. `seek(f)` draws
  frame f in every panel and resolves when it is on screen. A shorter clip holds its last frame.
- Props are clay boxes; the floor has a 1 m grid.

## Studio layer (`src/lowvis/studio/`, `bin/agent/motion-*.mjs`)

A lowvis clip becomes ordinary Studio scene content (`install.js`): each prop a Studio object (a prop that moves
rides a track of a take), each character an X Bot cast member whose take is the clip's motion (`take.js`: exact,
because the 17 joints are X Bot bones). `skin.jsx` draws the block figure over every X Bot character from its bones;
a new character is an X Bot, so the block figure is the one look of rig characters.

The scene the motion writer reads (`scene.js` `studioScene(describe, { turn, tops })`): the Studio's objects as boxes,
each the object's own box turned about Y as the object stands (`turn`), with the flat heights it offers (`tops`, from
`tops.js` over the editor's describe answer); the X Bot characters, and the Y Bot characters, which the install
changes to the block figure before it animates them (the report ends "Changed to the block figure: <ids>."), each with
the scale and tint the Studio holds for it (`body`). Capsule figures and imported rigs cannot be animated and stand as
they are; the request says so. An existing character loses its root path before its new take goes in.

Body size and colour. A character of the motion writer's scene may have `scale` (0.2 to 3, the limits of the Studio's
`character.scale`) and `tint` ("#rrggbb"). They are the cast member's own `scale` and `tint` fields: the scene the
motion writer reads lists them, a value its scene leaves out is the one the Studio holds (a new character: scale 1, no
tint), and the install sets what differs (`character.add`, `character.update`). The engine never chooses either.
- The motion is of a body of that size: `engine-simple/size.js` builds the body layer and solves each frame for the
  rig's own figure in a world divided by the scale and multiplies the result by it, and the lengths `engine.js` keeps
  for a body (the pad between a wrist and what it holds, the grip offsets, the default heights) are multiplied by the
  scale of the body they belong to. Lengths in a spec stay world metres. The clip character carries `scale` and `tint`;
  `validateClip`, the checks (`checks.js`, `pi/measure.mjs`) and the sheets (`pi/render.mjs`) read them.
- The Studio take of a sized body (`studio/take.js`, `motion-v4/track/codec.js` `scale`) holds the unit skeleton's
  motion; `motion.v4.install` installs it on a character at that scale and refuses another, the rig plays it at the
  character's scale, and the readers of a take (`motion3/physics-frames.js`, `studio-export-framing.js`) multiply by it.
  `skin.jsx` draws the block figure at the character's scale and, when it has a tint, in that colour.
- The motion tool's result names each animated character's scale and tint (`bodies`) when one is not the default, and
  the scale and tint the install set (`bodiesSet`, also the first word of a progress line of the tool, only when it set
  one). An edit that changes the scale of an animated
  character answers with `motionFit.bodies` (`bin/agent/motion-fit.mjs`): the take then plays that many times as large.
- Not following the size: the timing of a move (frames are as written; `travel` says the speed and steps that came
  out), the old engine's readers of other people's takes (`motion3/people.js`) and its QA numbers.

The motion door. The Studio's default agent has one tool for body motion, `motion { request, images? }`
(`bin/agent/motion-door.mjs`). It hands the user's words to `runMotion` (`bin/agent/motion-run.mjs`): the editor's
describe answer becomes the props and characters of the scene, the motion writer (`src/lowvis/pi/harness.mjs`,
claude-opus-5-5 at effort medium on CLIProxyAPI, variant `studio`) writes and checks the motion, and the clip is
installed. The tool answers the motion writer's report, which ends with a Missing line; the agent repeats it. Pictures
the user attached go along when the agent sets `images: true`. The scene and spec of the conversation's last motion
go with the next request. The agent's prompt under this engine has no guidance for the old motion engine
(`bin/agent/studio-prompt-lowvis.mjs`), and the old motion and hand-fix actions are out of its view
(`bin/agent/agent-view.mjs`, `HIDDEN_ACTIONS` in `bin/agent/motion-engine.mjs`); the editor and MCP keep them.
Under this engine the agent works with the human form only. Its prompt says people are block figures (model
x-bot-tpose) moved by the motion tool, with no cast-style gate and nothing on capsule figures; the actions it reads have
no capsule model, posture or cast style, its context has no `scene.castStyle`, and `run_action` / `patch_elements`
refuse its adding a capsule figure (model proxy-figure) or changing a character into one. A capsule figure the user
adds in the editor stays and the motion tool lists it with the characters it cannot animate.
In task mode a motion is an ordinary task whose agent calls the same tool. In a task the tool adds no character or
prop: a motion that needs one the scene does not have is not installed and the task is told to build it first. The
task's summary carries the Missing line of its last motion call (`missing`), and the coordinator repeats it
(`bin/agent/main-prompt.mjs` rule 8).

Switches (`bin/agent/motion-engine.mjs`, read from the environment of the agent sidecar):

- `COZYCLAY_MOTION_ENGINE=old`: the old motion engine comes back: the old prompt, every action in view, the v4
  entries in the model picker and its motion tasks. Unset or anything else: the lowvis engine.
- `COZYCLAY_MOTION_DIRECT=on`: the model picker also lists "Opus 5.5 (lowvis motion)", which sends the whole request
  straight to the motion writer with no Studio agent around it (`bin/agent/lowvis-turn.mjs`).
- `COZYCLAY_MOTION_OFF=pace,turn,tops,body,balance,inside`: engine steps of the lowvis engine switched off by name
  (`src/lowvis/pi/prompt.mjs` `OFF`): the travel line of the tool result, turned props, flat heights, a body's scale
  and tint (off: a character at another scale than 1 is not animated, as before), the row of a body at rest whose
  centre of mass lies outside its supports, the rows of a body or a moving prop inside another prop.

`node --env-file=<cliproxy env> tools/lowvis/pi/try.mjs [--viewer <port>] [--live <port>] [--no-direct]` starts the dev
Studio with the agent sidecar (live hub on its own port, sidecar files in `lowvis-out/studio-config`) and sets
`COZYCLAY_MOTION_DIRECT=on` unless `--no-direct`. Requests go through the Studio's Agent box; there is no separate
request panel.

## Not done

- Fingers and wrists: the hand is one piece.
- Collisions between bodies and props, other than what an action aims at.
- Attaching a prop to a body point, doors, support by a body point, stepping onto heights, pre-roll, elbow and knee
  direction.
- A block woman, a look per character, a look picker.
- Removing the old motion engine (`src/motion3`, `src/motion-v4`, `bin/agent/v4`, `mcp/motionbricks`): it stays and
  comes back with `COZYCLAY_MOTION_ENGINE=old`.

## Recorder

`node tools/lowvis/record.mjs --url <viewer url> --out <file.mp4>`: headless Chrome, `seek` frame by frame, one
screenshot per frame, ffmpeg at the clip's fps. Dev server port for this work: 5193 (never 5180 or 5184).
