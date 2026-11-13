# Agent prompt-to-scene rules (ask / infer / omit)

Users paste an existing Seedance prompt into the Agent panel. This page is the rule the agent follows when turning that prompt into 3D blocking, so results stay consistent instead of depending on how the agent feels that day. The core idea comes from previz tools that already solve this: never over-ask, never silently guess.

## What to extract from the prompt

Read every prompt for six groups:

1. **Aspect ratio and overall duration** for the shot.
2. **Space and set pieces**: the room or location, and the objects that fill it.
3. **Characters**: how many, their relative position, their pose, which way they face, and where they look.
4. **Focus props**: the objects the prompt calls out by name.
5. **Per-shot details**: framing, camera direction, camera move, and that shot's duration.
6. **Dialogue or SFX timing**: what is said or heard, and when.

## Three tiers: ask, infer, omit

**ASK only when the frame cannot be judged without it.** The ask-list is short: aspect ratio, relative placement when two or more characters appear and the prompt gives no direction, per-shot framing or camera direction, and duration. Batch the questions, at most 5 in one round, and give every question a default so the user can just say "use defaults" and move on.

**INFER, and list the guess as an assumption.** These are safe defaults the agent picks and then states openly: character height, which side the camera sits on, that characters start standing, that each character faces the other, and field of view derived from shot size.

**OMIT without asking or guessing.** Dialogue timing, director intent, walk paths, and camera moves the prompt never states. The agent leaves these empty instead of inventing them.

## Which tools realise each group

| Group | Tools |
| --- | --- |
| Space and set pieces | `place_object`, `update_object`, `describe_scene` |
| A prop or creature from a reference image | `sculpt_object` (Studio: `object.sculpt`), then `compare_sculpt` against the reference and `edits`; rules in `sculpt-from-image.md` |
| Characters | `add_character`, `place_character`, `focus_character` |
| Per-shot framing and camera | `frame_shot`, `set_camera`, `mark_camera_move` |
| Anything the user confirms in one batch | `apply_batch` |
| Reading the result back | `describe_scene`, `describe_shot`, `capture_frame` |

In the Studio, `verify_result` with a `framing` check returns code-measured `cameraSide` (left, right or on-axis of the line between the two leading characters) and `axisConsistent` (the 180-degree rule across the cut), so the side the camera sits on is checked, not guessed; `visual: "plan"` adds a top-view diagram drawn from scene state (cast, footprints, every shot camera, the current action line and blocked sight lines). A Studio turn with two or more characters, any shot, or a shot/camera/coverage request gets that plan attached automatically, and the Studio system prompt's "Previs procedure" repeats these ask/infer/omit rules alongside staging-first, coverage order and the 180-degree rule.

The names above are MCP tool names, defined in `mcp/tool-handlers.mjs` for MCP clients and the `cclay` live tool — they are not the Agent/Studio panel's current tools. The Studio panel itself drives the scene through the Studio families: `inspect_studio`, `operate_studio`, `arrange_objects`, `arrange_characters`, `frame_shot`, `verify_result`, `undo_edit`.

## Storyboard projects: one panel per request

In a storyboard project the Studio Agent works on the Board, not the timeline, under its own system prompt. The rule is **one panel per request**: each user request becomes exactly one new still. The agent adds the cast and set pieces the panel needs (capsule figures are allowed), calls `shot.createStill` with the caption set to a one-line summary of the user's words, frames that still with `frame_shot`, sets per-panel placement through the normal placement actions, and finishes with `verify_result`. A request that describes several beats is still one panel; the user asks again for the next.

- **No motion.** The `motion.*` actions are not in the agent's tool set, and the MCP motion tools answer `NOT_IN_MODE` in a storyboard project. The agent never asks about duration: a panel's hold is a Board field, not a question.
- **Ask / infer / omit still applies** to what a frame needs (framing, relative placement), with the same short, defaulted questions.
- **Capsule figures** have no rig. A rig-only tool aimed at one (pose, IK, motion, take import) answers `TARGET_NOT_READY` with the reason, so the agent changes `posture` (stand, sit, lie) and placement instead of retrying.

## Cast style: rig, capsule or hybrid

A project picks one cast style, and the agent reads it from the context field `scene.castStyle`. The system prompt states all three rules, so the project's value never enters the cached prompt.

- **rig**: the agent casts only X Bot or Y Bot and never adds a capsule figure. When a request is too hard for the rig, it says what fails and keeps the rig.
- **capsule**: the agent casts only capsule figures and shows action by placement, route waypoints and posture. It calls no motion, pose or IK action.
- **hybrid**: the agent uses rigs by default and judges each shot before and after compiling. Before: more than two hand or prop interactions outside the skill list, three or more rigs that touch or pass props, or a scale other than 1. After: `output.stuck` with `qa.ok` false, or a `LOAD`, `COLLIDE`, `BODY`, `SELF` or `PERSON` group left at top severity.
- **The proposal** is plain chat text in the user's language. The agent leaves the scene untouched, ends the turn, and reads the next message as the answer. On yes it adds capsule figures as new characters (a rig is never converted) and hides a rig only if the user agrees, saying that hiding applies to every shot. It asks once per shot.
- **Captions** are authored text. They are never sent as analytics.

## Known failure

LLM-generated coordinates overlap or float: two characters end up inside each other, or a character hovers above the floor. The fix is a loop, not a better guess: place everything, call `describe_scene` to read the actual positions, then correct the placements that look wrong. The agent should expect to run that loop at least once per scene.
