# lowvis prototype: contract

A 17-joint box-like figure replaces the X Bot / Y Bot as the default previs body. This prototype answers one
question: **how does the figure move?** The user judges side-by-side videos. No Studio integration, no PR, no CI.

## Fixed files (do not edit; report a needed change instead)

| File | What it fixes |
|---|---|
| `src/lowvis/rig17.json`, `rig17.js` | The 17 joints, parents, rest positions (m), tips, `fk()`, quaternion helpers |
| `src/lowvis/clip.js` | `lowvis.clip.v1`: the only thing an engine hands to the viewer; `validateClip` |
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
because the 17 joints are X Bot bones). `skin.jsx` draws the block look over rig characters from their bones.

The motion door. The Studio's default agent has one tool for body motion, `motion { request, images? }`
(`bin/agent/motion-door.mjs`). It hands the user's words to `runMotion` (`bin/agent/motion-run.mjs`): the editor's
describe answer becomes the props and characters of the scene (`scene.js`), the motion writer (`src/lowvis/pi/harness.mjs`,
claude-opus-5-5 at effort medium on CLIProxyAPI, variant `studio`) writes and checks the motion, and the clip is
installed. The tool answers the motion writer's report, which ends with a Missing line; the agent repeats it. Pictures
the user attached go along when the agent sets `images: true`. The scene and spec of the conversation's last motion
go with the next request. The agent's prompt under this engine has no guidance for the old motion engine
(`bin/agent/studio-prompt-lowvis.mjs`), and the old motion and hand-fix actions are out of its view
(`bin/agent/agent-view.mjs`, `HIDDEN_ACTIONS` in `bin/agent/motion-engine.mjs`); the editor and MCP keep them.
In task mode a motion is an ordinary task whose agent calls the same tool; in a task the tool adds no character or
prop (`bin/agent/main-prompt.mjs` rule 8).

Switches (`bin/agent/motion-engine.mjs`, read from the environment of the agent sidecar):

- `COZYCLAY_MOTION_ENGINE=old`: the old motion engine comes back: the old prompt byte for byte, every action in view,
  the v4 entries in the model picker and its motion tasks. Unset or anything else: the lowvis engine.
- `COZYCLAY_MOTION_DIRECT=on`: the model picker also lists "Opus 5.5 (lowvis motion)", which sends the whole request
  straight to the motion writer with no Studio agent around it (`bin/agent/lowvis-turn.mjs`). `tools/lowvis/pi/try.mjs`
  sets it for the Studio it starts.
- `COZYCLAY_MOTION_OFF=pace,turn,tops`: engine steps of the lowvis engine switched off by name
  (`src/lowvis/pi/prompt.mjs` `OFF`).

`node --env-file=<cliproxy env> tools/lowvis/pi/try.mjs` starts the dev server with the agent sidecar (live hub on its
own port, sidecar files in `lowvis-out/studio-config`). `/app/?lowvis[=<port>]` adds a prototype request box on the
stage that asks `try.mjs` (default port 5201) and installs the finished clip.

## Recorder

`node tools/lowvis/record.mjs --url <viewer url> --out <file.mp4>`: headless Chrome, `seek` frame by frame, one
screenshot per frame, ffmpeg at the clip's fps. Dev server port for this work: 5193 (never 5180 or 5184).
