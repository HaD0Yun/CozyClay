# lowvis prototype: contract

A 17-joint figure over the X Bot's bones is the previs body. The lowvis engine answers one question: **how does
the figure move?** People judge it by eye. Since 3.3.0 it is the Studio agent's default motion engine (the motion door,
below); rig characters are drawn in the cube look unless the launch names another (`COZYCLAY_FIGURE`).

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
because the 17 joints are X Bot bones). `skin.jsx` draws the launch look (`studio/figure.js`: the cube figure unless
`COZYCLAY_FIGURE` names another; `block` for the block figure) over every X Bot character from its bones; a new
character is an X Bot, so that look is the one look of rig characters.

The scene the motion writer reads (`scene.js` `studioScene(describe, { turn, tops })`): the Studio's objects as boxes,
each the object's own box turned about Y as the object stands (`turn`), with the parts it draws where its shape is not
its box (`tops`: `tops.js` objectParts over the editor's describe answer, `parts.js`; the motion tool asks for them
again before every compile, sets them on the writer's scene as the only parts a prop has, and tells the ones the Studio
draws later, `pi/shapes.mjs`; the compiled scene kept with a take carries them); the X Bot characters, and the Y Bot characters, which the install
changes to the rig figure before it animates them (the report ends "Changed to the rig figure (model x-bot-tpose): <ids>."), each with
the scale and tint the Studio holds for it (`body`). Capsule figures and imported rigs cannot be animated and stand as
they are; the request says so. An existing character loses its root path before its new take goes in.

Body size and colour. A character of the motion writer's scene may have `scale` (0.2 to 3, the limits of the Studio's
`character.scale`) and `tint` ("#rrggbb"). They are the cast member's own `scale` and `tint` fields: the scene the
motion writer reads lists them, a value its scene leaves out is the one the Studio holds (a new character: scale 1, no
tint), and the install sets what differs (`character.add`, `character.update`). The engine never chooses either.
- The motion is of a body of that size: `engine-simple/size.js` builds the body layer and solves each frame for the
  rig's own figure in a world divided by the scale and multiplies the result by it, and the lengths `engine.js` keeps
  for a body (the pad between a wrist and what it holds, the default heights) are multiplied by the
  scale of the body they belong to. Lengths in a spec stay world metres. The clip character carries `scale` and `tint`;
  `validateClip`, the checks (`checks.js`, `pi/measure.mjs`) and the sheets (`pi/render.mjs`) read them.
- The Studio take of a sized body (`studio/take.js`, `motion-v4/track/codec.js` `scale`) holds the unit skeleton's
  motion; `motion.v4.install` installs it on a character at that scale and refuses another, the rig plays it at the
  character's scale, and the readers of a take (`motion3/physics-frames.js`, `studio-export-framing.js`) multiply by it.
  `skin.jsx` draws the launch look at the character's scale and, when it has a tint, in that colour.
- The motion tool's result names each animated character's scale and tint (`bodies`) when one is not the default, and
  the scale and tint the install set (`bodiesSet`, also the first word of a progress line of the tool, only when it set
  one). An edit that changes the scale of an animated
  character answers with `motionFit.bodies` (`bin/agent/motion-fit.mjs`): the take then plays that many times as large.
- Not following the size: the timing of a move (frames are as written; `travel` says the speed and steps that came
  out), the old engine's readers of other people's takes (`motion3/people.js`) and its QA numbers.

The motion door. The Studio's default agent has one tool for body motion, `motion { request, images? }`
(`bin/agent/motion-door.mjs`). It hands the user's words to `runMotion` (`bin/agent/motion-run.mjs`): the editor's
describe answer becomes the props and characters of the scene, the motion writer (`src/lowvis/pi/harness.mjs`,
variant `studio`) writes and checks the motion, and the clip is installed. The writer's model
(`bin/agent/motion-writer.mjs`): claude-opus-5-5 at effort medium through `CLIPROXY_BASE_URL` / `CLIPROXY_API_KEY` when
they are set and that proxy lists it; else through a sign-in of the model picker that offers it, on the provider
registry the agent's own turns use; else the model the turn runs on. With none of them the session has no motion tool,
and the agent tells the user to sign in. A sign-in that lists the motion model and then refuses it for the account
(not found, not permitted, not on the plan; never a rate limit, a refused credential or a server error) is asked once
per conversation: the model the turn runs on writes that motion and the later ones. The answer's `writer` names the
model that wrote, and the sign-in that refused which model when one did. The tool answers the motion writer's report, which ends with a Missing line; the agent repeats it. Pictures
the user attached go along when the agent sets `images: true`. The scene and spec of the conversation's last motion
go with the next request. The agent's prompt under this engine has no guidance for the old motion engine
(`bin/agent/studio-prompt-lowvis.mjs`), and the old motion and hand-fix actions are out of its view
(`bin/agent/agent-view.mjs`, `HIDDEN_ACTIONS` in `bin/agent/motion-engine.mjs`); the editor and MCP keep them.
Under this engine the agent works with the human form only. Its prompt says people are rig figures (model
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
  entries in the model picker and its motion tasks, and rig characters in the block look unless `COZYCLAY_FIGURE`
  names one (`studio/figure.js` `launchValue`). Unset or anything else: the lowvis engine.
- `COZYCLAY_FIGURE=<look>`: the look rig characters are drawn in and the body the engine builds for, in the page and in
  the agent sidecar alike (`studio/figure.js`). Unset: the cube figure; `block`: the block figure.
- `COZYCLAY_MOTION_MODEL=<id>`, `COZYCLAY_MOTION_EFFORT=<level>`: the motion writer's model and effort (default
  claude-opus-5-5 at medium).
- `COZYCLAY_MOTION_DIRECT=on`: the model picker also lists "Opus 5.5 (lowvis motion)", which sends the whole request
  straight to the motion writer with no Studio agent around it (`bin/agent/lowvis-turn.mjs`).
- `COZYCLAY_MOTION_OFF=pace,turn,tops,body,balance,inside`: engine steps of the lowvis engine switched off by name
  (`src/lowvis/pi/prompt.mjs` `OFF`): the travel line of the tool result, turned props, a prop's drawn parts and a body's (the
  parts of the launch look, `engine-simple/body-parts.js`, the word `{on: characterId, part}` and the rows against them,
  `pi/bodies.mjs`), a body's scale
  and tint (off: a character at another scale than 1 is not animated, as before), the row of a body at rest whose
  centre of mass lies outside its supports, the rows of a body or a moving prop inside another prop.

`node --env-file=<cliproxy env> tools/lowvis/pi/try.mjs [--viewer <port>] [--live <port>] [--no-direct]` starts the dev
Studio with the agent sidecar (live hub on its own port, sidecar files in `lowvis-out/studio-config`) and sets
`COZYCLAY_MOTION_DIRECT=on` unless `--no-direct`. Requests go through the Studio's Agent box; there is no separate
request panel.

## Lines

A scene prop `{ id, line: { length, thick }, at, turn? }` is a line (`engine-simple/line.js`): a chain of up to 64
segments of about 0.1 m solved after each frame's bodies and props (gravity, fixed segment length, the floor and the
solid props' boxes or drawn parts, a little friction where it lies), fastened by its own keys `tie`, `over`, `untie` and
by the hands of a `hold` of it. Before frame 0 it is laid from what frame 0 fastens (straight between two fastened
points, the slack let out as it settles), so those fastenings drag it through no prop. The clip stores it as `lines`
(`clip.js`: every point of every frame). The tool tells each span between fastened points as taut or slack
(`engine-simple/line-told.js`); the sheets and the viewer draw it as boxes along it. The Studio gets one thin box
object per segment, named `<id>~<k>`, each on a track of the take of the character that holds it most
(`studio/line-objects.js`, `install.js`: a listed line's boxes are moved again when they are as many and of that
length and thickness, else made anew); `studio/scene.js` tells them back as one line, outside the 40 props it lists
(the line of a playing take's scene, or, for a whole set no take plays, the length and thickness read off the boxes).
The Studio agent's answer counts them as `lines`. One-way: a line moves nothing it is fastened to; it does not touch
bodies; no knots, coils, wraps, cloth or stiff rods. A box keeps its length, so a span drawn longer than the line's
thickness over its segment length (0.04 m on 0.1 m: 40 %) shows gaps between its boxes in the Studio.

## Balance assist

`LOWVIS_BALANCE_ASSIST=1` in the environment of the process that builds the clip (the agent sidecar, a tool, a test)
switches it on for engine-simple (`engine-simple/balance.js`); unset or anything else, the engine builds what it built
before, byte for byte. With it on, a body that stands on its feet with its centre of mass, dropped to the floor, outside
the soles it stands on moves its pelvis sideways and forward or back over them while the clip is built: the balance
row (`pi/balance.mjs`) then tells nothing for it.
- The centre of mass: the shares of an adult human body's segments (the table `pi/balance.mjs` reads too). Supports:
  the soles of the feet on the floor in the pose as the spec has it (a foot the body layer holds planted, or a keyed
  foot down on the floor whose key's target is there too; a foot a key lifts, or one that hangs short of a target out
  of the leg's reach, is none) and a hand on its target on the floor. The centre of mass is taken 5 mm x scale inside.
- Only the pelvis moves, on top of the hip key's x and z. Planted feet stay; a lifted foot stays on its target (one the
  shift takes out of the leg's reach goes with the pelvis); no bow, lean, look or twist key changes. A hand with a
  target keeps it: the shift is cut back where a hand would end more than 1.5 mm x scale further from its target, and a
  hand in its blend keeps its path in the world.
- The shift eases in and out (at most 2 mm x scale of change of its speed a frame), is eased away over the 10 frames
  before a frame it leaves alone, and waits while the centre of mass already moves back over the feet or the body comes
  up from a bend.
- Left alone (those frames exactly as with it off): a sit, kneel, lie or push stance, a step, turn, walk, run or push
  and every other change of the body layer, a launch and its flight, a body on a prop (standing on its drawn parts or
  riding it), a tilt, a hold, carry or place of a prop or line, a hand, elbow or foot on a target that is a prop, a
  world point or another body, a deep crouch (the hips under 0.45 m x scale; it fades out from 0.52 m), and a body that
  carries a prop riding one of its joints (all its frames).
- Cost: on the frames it works, the last of the two solves the engine does of each frame is done twice (once as the
  spec has it, once shifted). Test: `test/lowvis/verify-balance-assist.mjs`.

## Not done

- Fingers and wrists: the hand is one piece.
- A line as one Studio object (a tube along its points); a line that pulls what it is tied to; a hand that lets a line
  run through it under tension.
- Collisions between bodies and props, other than what an action aims at.
- Attaching a prop to a body point, doors, support by a body point, stepping onto heights, pre-roll, elbow and knee
  direction.
- A block woman, a look per character, a look picker.
- Removing the old motion engine (`src/motion3`, `src/motion-v4`, `bin/agent/v4`, `mcp/motionbricks`): it stays and
  comes back with `COZYCLAY_MOTION_ENGINE=old`.

## Recorder

`node tools/lowvis/record.mjs --url <viewer url> --out <file.mp4>`: headless Chrome, `seek` frame by frame, one
screenshot per frame, ffmpeg at the clip's fps. Dev server port for this work: 5193 (never 5180 or 5184).
