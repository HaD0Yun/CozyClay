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

`/app/?lowvis[=<port>]` opens the Studio with a lowvis request box. A request goes to `tools/lowvis/pi/try.mjs` on
that port (default 5201); the finished clip is drawn in the Studio's own scene at the Studio playhead (`layer.jsx`),
so the timeline, the editor and shot cameras and the shot preview show it. The Studio's cast hides while a clip
plays. The figures and props of a clip are not Studio cast members or objects: they cannot be selected, moved, posed
or saved with the project, and the Studio's own agent box does not write lowvis scenes.

## Recorder

`node tools/lowvis/record.mjs --url <viewer url> --out <file.mp4>`: headless Chrome, `seek` frame by frame, one
screenshot per frame, ffmpeg at the clip's fps. Dev server port for this work: 5193 (never 5180 or 5184).
