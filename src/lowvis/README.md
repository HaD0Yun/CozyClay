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

## Studio layer (prototype, `src/lowvis/studio/`)

A lowvis clip becomes ordinary Studio scene content (`install.js`): each prop a Studio object (a prop that moves
rides a track of a take), each character an X Bot cast member whose take is the clip's motion (`take.js`: exact,
because the 17 joints are X Bot bones). `skin.jsx` draws the block look over rig characters from their bones.

Two ways in, both started by `node --env-file=<cliproxy env> tools/lowvis/pi/try.mjs` (dev server with the agent
sidecar, live hub on its own port, sidecar files in `lowvis-out/studio-config`):

- The Studio's Agent box with the model "Opus 5.5 (lowvis motion)" (`bin/agent/lowvis-turn.mjs`). The turn reads
  the Studio's objects and X Bot characters (`scene.js`) and hands them to the model as the props and characters of
  its scene, so a set made by a build step or by the user is the set the motion plays in; it also hands over the
  scene and spec of the conversation's last lowvis turn.
- `/app/?lowvis[=<port>]`: a request box on the stage that asks `try.mjs` (default port 5201) and installs the
  finished clip. With "As Studio characters" off, the clip is only drawn over the stage (`layer.jsx`).

Not done: a Studio object reaches the model as one upright box (a bench with a backrest is a solid block, a turned
object the box around it); Y Bot characters are not used; the task coordinator's motion tasks still run on the
other motion engine.

## Recorder

`node tools/lowvis/record.mjs --url <viewer url> --out <file.mp4>`: headless Chrome, `seek` frame by frame, one
screenshot per frame, ffmpeg at the clip's fps. Dev server port for this work: 5193 (never 5180 or 5184).
