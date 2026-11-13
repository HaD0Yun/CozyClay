# Auto Pose core

Numeric core of the Auto Pose tool (module `src/poser/`): from a few handles to a full-body pose.
Plain ES modules, no React and no three.js. The UI applies the output to a three.js skeleton.

```
 handle sends --> effectors, floor shift, encode --> network (async) --> decode + FK
      --> IK (12 LM steps) --> floor + toe roll --> world output --> bone transforms
```

## Entry

```js
import { createPoser } from "./poser.js";
import { createWebNetwork } from "./ort-web.js";
import { characterFromRigJson } from "./ybot.js";

const network = await createWebNetwork();          // lazy onnxruntime-web, hashed + Cache Storage model
const poser = createPoser({ network });             // skeleton defaults to ./skeleton.json
const character = characterFromRigJson();           // Y Bot rig JSON at its own size; { scale } for another size
const pose = await poser.solve(sends, character);   // one call per pointer move
```

- `createWebNetwork({ model, wasmPaths, threads, onProgress })` loads the model once.
  Keep the returned network for the session.
  It throws `PoserModelError` with `code` set to `offline`, `http`, `checksum` or `no-crypto`.
  `network.info` holds `source` (`cache` or `network`), `threads`, `downloadMs` and `sessionMs`.
- The model URL, SHA-256 and byte size are set in `config.js` and nowhere else.
  The default URL is `/models/cozy-poser-v1.onnx`, same origin. The file is not in git (it is ignored); copy it to `public/models/` for
  local runs and before a release build. A build copies it into `dist`, so the npm package (`npx cozyclay`) ships it, and
  `tools/verify-package-tarball.mjs` refuses to publish a package without it or with other bytes. A build without the file
  (CI, the hosted site, a fresh clone) sets `POSER_MODEL.bundled` to false (`build-plugin.js`): pressing E then says Auto
  Pose comes with the installed app, with no request and no retry.
- `poser.prepare(character)` derives the rig facts (frame, rest correction, bone lengths, written joints) once and caches them per character object.
  `solve` calls it for you.

## Handle sends (input)

A send is what one handle contributes to this solve: `{ id, position?, rotation?, lookAt?, tol?, rotTol? }`.
Build sends with `dragSends(state, drag)`, or build them yourself.

| id | joint | can send | on at start | held by default |
|---|---|---|---|---|
| `body` | hips | nothing (rigid move, UI only) | always | |
| `hips` | hips | position, rotation | yes | |
| `spineLow`, `spineMid` | spine, spine_mid | rotation | | |
| `chest`, `neck`, `head` | chest, neck, head | position, rotation | | |
| `lookAt` | head | lookAt, rotation | yes | |
| `leftShoulder`, `rightShoulder` | shoulders | rotation | | |
| `leftHand`, `rightHand` | hands | position, rotation | yes | |
| `leftElbow`, `rightElbow` | forearms | position, rotation | | |
| `leftFoot`, `rightFoot` | ankles | position, rotation | yes | yes |
| `leftKnee`, `rightKnee` | shins | position, rotation | | |
| `leftToes`, `rightToes` | balls | position, rotation | | yes |

- Positions and look-at points use the poser world frame: metres, Y up, the character faces +Z, its left is +X.
  The floor is y = 0 plus the character's `floorHeight`.
  Results come back in the same metres at any body size. A body outside the size range the network knows (summed
  bone length beyond ±2.5 summed spreads of the mean) is solved at the nearest ordinary size and scaled back.
  The Auto Pose tool always passes the body at its own size; stage stature stays in the rig root's world matrix.
  `placementFrame({ x, y, z, rot })` converts stage points to this frame and back.
- `rotation` is the joint's global rotation relative to its rest orientation, in the skeleton frame.
  Give it as 6D (columns 0 and 1) or as a flat row-major 3x3.
  `readPose` gives these rotations for the current pose.
- `tol` is the position tolerance in metres and `rotTol` the turn tolerance. Both default to 0.005. The Auto Pose panel keeps them between 0.001 and 0.5; the core does not clamp.
  A dragged handle uses `min(tolerance, 0.02)`.

## Output

`solve` resolves one of two shapes:

- `{ ok: false, reason, detail }`: the query was rejected and the pose must stay unchanged.
  `no-position-effector` means no handle sent a position; tell the user.
  The other reasons are `effector-domain` and `too-many-effectors`.
- `{ ok: true, ... }` with these fields:

| field | meaning |
|---|---|
| `bones[]` | per touched bone: `name`, `quaternion` [x, y, z, w] and `position` (three.js parent-relative local, armature units), `pose` (armature-space 4x4, row-major) and `basis` (relative to rest, row-major) |
| `joints`, `root` | 30 joint positions and the root, world frame (metres, after the floor shift) |
| `rot6dGlobal`, `G`, `L` | global rotations (6D, and 3x3 row-major) and local rotations |
| `warnings` | `few-position-effectors` when there are only one or two position handles |
| `ikInfo` | `errBeforeCm`, `errAfterCm`, `maxDeltaDeg`, `lookBeforeDeg`, `lookAfterDeg` |
| `errAfterCm`, `belowFloorCm` | final weighted effector error and the lowest joint below the floor |
| `pins` | limb-fit pins in armature space (tight hand and foot positions) |
| `timings` | `encodeMs`, `networkMs`, `ikMs`, `floorMs`, `writeMs`, `totalMs` |

- Write the bones by setting each bone's `quaternion`, then its `position`.
  Only the Hips position changes; other positions are the rest offsets.
  Bones not listed (fingers, head top, toe ends) stay as they are.
- three.js matrices are column-major. Every matrix here is row-major.

## Async behaviour

- Only the network call is asynchronous. Everything else runs synchronously on the calling thread.
- `solve` holds no lock. If a solve is still running when the pointer moves again, wait and solve only the latest move (`ui/solve-loop.js` does this).
- The Auto Pose tool (`ui/`) runs the network in a module worker (`ui/network-worker.js`) and falls back to the main thread only when the worker cannot start.
- A download that sends nothing for 30 s stops as `stalled`; a dropped one is `offline`. Both show Try again. A worker that dies after loading is replaced (the model comes from Cache Storage) and later solves go to the new one.
- Browser QA reads `window.__cozyclayPoser` in dev builds, or in a production build whose page sets `window.__COZYCLAY_QA__ = true` before loading; it is removed when the handles unmount.

## Measured latency

Headless Chrome 157 on Apple Silicon, 14 cores, Vite dev server, onnxruntime-web 1.30.0 WASM, 128 runs.
The solve is a 12-handle Y Bot drag.
Command: `QA_URL=http://127.0.0.1:5199/ CDP_PORT=9333 node tools/qa-browser.mjs -- node tools/qa-poser-bench.mjs`.

| median / p95 ms | 1 thread (not cross-origin isolated) | 4 threads (COOP/COEP set) |
|---|---|---|
| network per call | 15.7 / 20.6 | 5.2 / 6.6 |
| IK incl. decode + FK | 0.7 / 0.8 | 0.75 / 0.8 |
| full solve | 17.5 / 17.9 | 6.3 / 6.6 |
| model load, cold (empty Cache Storage) | 773 | 670 |
| model load, cached | 392 | 365 |

The target is p95 16 ms per solve (one frame at 60 Hz). Single-threaded WASM misses it, so the page needs cross-origin isolation (COOP/COEP) for threads.
Today no CozyClay server sends those headers.

## The Auto Pose tool (`ui/`)

Pose mode's E tool on the X Bot and the Y Bot. The viewport handles and the Pose Details section share `ui/poser-store.js`.

| file | role |
|---|---|
| `ui/PoserHandles.jsx` | loads the model on first use, draws the handles, turns pointer drags into solves |
| `ui/poser-marks.jsx`, `ui/poser-pick.js` | handle and turn-ring looks; screen-space picking |
| `ui/PoserPanel.jsx`, `ui/poser.css` | Pose Details section: model state, hint, whole-pose actions, per-handle switches |
| `ui/poser-controller.js` | press, live drag and turn, release, switches and actions for one character |
| `ui/handle-state.js` | per-handle state as pure data |
| `ui/solve-loop.js` | one solve in flight, the latest pointer move wins |
| `ui/solve-guard.js` | refuses a solve that is not finite, throws the body, or pulls a held handle more than 3 cm; reports a dragged handle out of reach; lifts the character so no written joint is under the floor |
| `ui/pose-ops.js` | flip left and right, copy and paste, back to T-pose, bones no key stores |
| `ui/rig-bridge.js` | the live three.js rig as poser data: frame, read-back, bone writes |
| `ui/model-host.js`, `ui/network-worker.js` | lazy, shared model load in a worker |

- Every pose change goes through the motion domain's IK drag path (`ikSolve("poser", …)`, then `ikDragEnd()`): an IK key at the playhead without a take, the preview-then-apply flow with one. One release is one undo step; analytics count it as `pose_edit`.
- IK keys have no track for the upper chest (Mixamo `Spine2`) or the toes. The tool holds those bones at the rotation playback gives them, so the pose on screen is the pose that is keyed. A held hand or foot still meets its handle through the limb fit.
- After a drag the dragged handle stays held where it was left; a handle the body could not reach goes back onto its joint. A new press, Back to T-pose, Flip left and right or Paste ends a gesture whose pointer release never arrived. Places and turns left by the user are dropped when the pose changes elsewhere (undo, another frame).

## Files

`skeleton.js` (joint table, rest layout, FK), `encode.js` (effectors to inputs), `network.js`, `ort-web.js` and `model-source.js` (the network), `decode.js` (network answer to pose, pose to world), `ik.js`, `floor.js`, `rig.js` and `rig-lengths.js` (rig facts), `retarget.js` (bone write and read-back), `ybot.js` (Mixamo table, rig JSON adapter, placement frame), `handles.js` (handle set, drag sends), `poser.js` (entry).
Tests are in `test/poser/`; the real network runs there on onnxruntime-web (WASM) when the model file is present.
`verify-poser-goldens.mjs` replays `test/fixtures/poser/ybot-goldens.json`, written by
`make-poser-goldens.mjs` from the authored cases in `poser-cases.mjs`; regenerate only when a change is meant to move answers.
