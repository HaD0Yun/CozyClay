---
name: ardy-motion
description: Use whenever the user asks for character or player animation/motion — walking, running, dancing, fighting, gestures, sitting, bowing, any humanoid body movement. Covers translating user intent into ARDY text-to-motion prompts (NVIDIA guidance), single-prompt and multi-segment (--segment) generation, and baking with stage_scene apply_motion.
---

# ARDY character motion

Pipeline: NVIDIA ARDY (text-to-motion diffusion, 20 fps) generates a motion clip from English prompt(s); `apply_motion` bakes it onto a CozyClay character (Y_BOT/X_BOT). One clip per character — the latest apply replaces the character's action, so generate the whole action sequence as ONE clip (single prompt, or segment mode for behavior transitions).

## 1. Capture the user's intent first

Before writing a motion prompt, extract from the user's request:

- **Action(s)** — the concrete physical movements, in order.
- **Manner/mood** — translate emotion into body physics (see table below). ARDY only understands physical description.
- **Duration** — estimate if unstated (table below).
- **Placement/facing** — NOT part of the motion prompt. Position and rotate the character's armature object with transform_entity BEFORE applying motion; the baked root motion travels relative to that transform.
- **Sequencing** — a trivial return-to-neutral stays inside one prompt ("A person bows down and then stands upright."); a real behavior transition (run → bow) becomes one segment per behavior (section 2 routing rule).
- **Hand configuration** — at request time, infer the visible digit shape for each side independently. Choose an explicit preset for both left and right on every `apply_motion` call; do not route from action, object, chair, or other keyword templates.

If the request is ambiguous, pick a concrete, physical interpretation, state it in one line, and proceed.

Emotion → physics translation (model card guidance: neutral, physical terms only — never demographic adjectives):

| user says | motion prompt says |
|---|---|
| sadly, depressed | "walks slowly with head lowered and shoulders slumped" |
| excited, happy | "jumps up and down waving both arms energetically" |
| like an old man | "walks slowly with shuffled, unsteady steps" |
| sneakily | "walks forward slowly in a low crouch with careful steps" |
| confidently | "walks forward with long strides and upright posture" |

## 2. Write the motion prompt (NVIDIA style)

**Routing rule — pick the mode first:**

- **SINGLE behavior** (one gesture/action, possibly with a trivial return-to-neutral like NVIDIA's "bows down and then stands upright") → ONE prompt, single-prompt mode.
- **BEHAVIOR TRANSITION or multi-phase sequence** (locomotion→gesture, A then B then C, e.g. "runs forward, stops, bows") → SEGMENT mode, one behavior per segment:
  `scripts/cclay-ardy-generate --segment "A person runs forward." 3 --segment "A person stands still and bows deeply from the waist." 4` — segments are chained through ARDY's native history conditioning into one continuous motion, so transitions are model-continuous. Boundaries land exactly on the requested durations; read each segment's start/end frames from the output JSON `segments` field. Long chained sentences in one prompt get clauses DROPPED by the model (verified failure) — never encode a behavior transition as one long sentence.
  Fold a momentary stop/pause into the START of the following segment's prompt ("stands still and bows...") rather than giving it its own segment — transitional settling comes from the model, not from a filler segment.

Prompt style (applies to every prompt/segment):

- Third person, present tense, one sentence: **"A person ..."**. NVIDIA's own presets: "A person is walking.", "A person jumps backwards.", "A person side steps to the right.", "A person is kicking with their right leg.", "A young lady walks forward elegantly.", "A person bows down and then stands upright."
- Concrete verbs + limb specifics beat adjectives: "waves both hands above the head", "kicks with their right leg".
- Model strengths: locomotion, gestures, combat, dancing, everyday activities. Weak/unsupported: precise object interaction (model is scene-blind), cartoon or physically impossible motion, multi-person contact.
- For object interaction, infer the actor, target, active body part, target region, approach direction, and intended end relation. Pre-align the character and prop with `transform_entity`, then describe relative body mechanics in the motion prompt. ARDY does not consume scene coordinates or prop geometry.
- **Dimensioned prompt requirement:** when props the character must interact with already exist, call `inspect_relations` FIRST — pass the props' `entity_ids` (parented props need them explicitly) and the character armature as `reference_entity_id`. Write the measured numbers into the prompt text: travel distance (`relative.horizontal_distance`), rise height (the LAST pattern member's `top_above_reference_base` — direct measurement, preferred — or equivalently the first member's `top_above_reference_base` + (count-1) × the pattern pitch's vertical component `dz` for a regular layout), and target offsets — numbers, not adjectives. "A person walks 2.4 meters forward and climbs onto a 0.9 meter high platform." beats "walks over and climbs up". Derive each segment's duration from distance ÷ expected speed (walk ~1.4 m/s, run ~3 m/s) instead of guessing.
- **Text numbers bias, they do not bind.** A dimensioned prompt makes the model land closer, but ARDY still never sees the prop, so per-contact error stays. When the contacts must actually meet the geometry (stair treads, a platform edge, a seat), plan on the constrained pass in section 3b rather than expecting the prompt alone to fit.
- English only (training captions are English).

Duration heuristics (fps is 20; frames = 20 x seconds):

| motion | --duration / segment seconds |
|---|---|
| single gesture (wave, bow, kick) | 2-4 |
| short action (sit down, turn around) | 3-5 |
| walk/dance/fight sequence | 5-10 |
| behavior transition | segment mode, 2-10 per segment |

Keep each prompt/segment <= ~10 s (training clips were 10 s). Longer choreography: segment mode is the supported path — chain segments in ONE generate call, keeping the total clip a sane scene beat.

**Stay on the default `core40` model; do not reach for `core8`.** ARDY publishes two Core checkpoints, Horizon40 and Horizon8. A short horizon looks like it should adapt faster — 8 frames is 0.4 s of committed future against 40 frames at 2.0 s — so it reads as the obvious fix for a mushy segment transition. It is measured to be the opposite. On the same three-segment sequence, prompts and seed held identical, `core8` was 2.7x WORSE at the seams: `boundary_max_jump_m` 0.2026 against `core40`'s 0.0747, i.e. it blows through the 0.08 continuity gate that `core40` passes, with mean jump also 55% higher (0.0788 vs 0.0507). Constraint satisfaction was no better either (position 0.0059 m against 0.0000 m on the same target), and its unconstrained pass showed slight floor penetration (lowest track −0.006). The reason is that the horizon is the room the model has to SETTLE an action before a boundary, and history conditioning needs that room; cutting it makes seams choppier, not more responsive. A short horizon only pays off for genuinely online streaming where a new prompt arrives mid-rollout, which is not how this pipeline generates.

## 3. Generate and bake

```
# from the project directory (or pass --project)
scripts/cclay-ardy-generate "A person bows down and then stands upright." --duration 4
# behavior transition -> segment mode, one continuous rollout:
scripts/cclay-ardy-generate --segment "A person runs forward." 3 --segment "A person stands still and bows deeply from the waist." 4
# -> {"motion_id":"...","frames":140,"fps":20,"segments":[...],"continuity":{...}}   (runs in seconds on the GPU box)
```

**Preflight gate — compare, then apply.** Before `stage_scene` `apply_motion`, run `preflight_motion` with the new `motion_id` and the character's `entity_id` (armature → heights in meters). Apply only when `travel.distance_horizontal`, `travel.height_change`, and `contact_windows` heights are within tolerance of the `inspect_relations` measurements — ~10% or ~0.05 m, whichever is larger. On mismatch, prefer a CONSTRAINED regeneration (section 3b) over a blind reseed, or refit the prop layout to the measured contacts; never apply blind and eyeball afterwards. `preflight_motion` is motion-local (horizontal distance and heights, not world XY); placement and facing still come from the armature transform. This gate is intentionally looser than the visual QA skill's ~0.03 m defect threshold: residual uniform error that passed the gate is a rank-1 transform fix in visual QA, not a regeneration.

## 3b. Constrained regeneration — when contacts must land on measured geometry

Prompt text is a caption, not a constraint: "climbs a 0.18 m step" only biases the model, and ARDY never sees the prop. When the actor must contact geometry that already exists — stair treads, a platform edge, a seat, a handhold — and the preflight gate shows the contacts off, regenerate with ARDY's end-effector constraints instead of reseeding.

```
# pass 1 already happened (section 3). Then:
scripts/cclay-ardy-generate "A person walks forward and climbs three steps." --duration 6 \
  --base-motion <pass-1 motion_id> \
  --constrain 30 LeftFoot 0.12 0.18 0.55 \
  --constrain 46 RightFoot 0.12 0.36 0.85 \
  --constrain 62 LeftFoot 0.12 0.54 1.15
```

- `--base-motion` is required: an ARDY constraint is a POSE at a frame, so pass 1 supplies the pose and the root is translated to put the named joint exactly on the target. Only that joint and the hips survive into the condition, so the model still regenerates stride, knee bend, and timing to reach the contacts.
- Joints are exactly `LeftFoot`, `RightFoot`, `LeftHand`, `RightHand`.
- **Coordinates are npz space: Y-up, meters, motion-local** — not Blender space. Blender is Z-up, and the rig may be scaled, so convert: divide scene meters by the `scale` (meters per npz unit) that `preflight_motion` reports, and map Blender `(x, y, z)` to npz `(x, z, y)`. Motion-local means relative to the motion's own start, which is what `inspect_relations` `relative.*` gives you when `reference_entity_id` is the character armature.
- Frames come from `preflight_motion` `foot_contacts` (pass 1) or the beat you want the contact on; `0 <= frame < duration x 20`. Prefer `foot_contacts` over `contact_windows` when picking a FOOT target: it is ARDY's own channel and it names the limb (`left_heel`, `left_toe`, `right_heel`, `right_toe`), so the window tells you which joint to constrain as well as when. `contact_windows` is the minimum over all joints and cannot say whose contact it saw. `foot_contacts` is `null` on archives that carry no channel — fall back to `contact_windows` there rather than treating it as "no contact".
- Read `residual.max_error_m` and each target's `achieved_error_m` from the result: they are MEASURED on the generated npz, not asserted. `base_error_m` on the same line is the unconstrained distance, so the pair shows whether constraining helped. Non-zero residual means the sampler could not reach the target — the request is likely geometrically impossible for the clip length, so lengthen the duration or move the contact rather than repeating the call.
- **Hard rule: `LeftFoot`/`RightFoot` are skeleton joint centers, not sole contact points.** `achieved_error_m: 0.0` proves the joint reached its target; it says nothing about whether the deformed sole mesh actually touches the surface. The joint-to-sole offset is NOT constant — it changes with foot rotation (measured 0.11-0.17 m across a stair clip) — so a fixed guessed offset (e.g. "subtract 0.06 m") is never acceptable as final verification, and zero joint residual never substitutes for a sole-contact check. Use `foot_contacts` to find WHEN and WHICH foot is planted (contact timing and side), then hand off to the visual-qa skill's `inspect_pose_contacts` check (`support_gap_m`, `inside_support_footprint`, `surface_contact_verified` against a ±0.03 m gate) to confirm the deformed sole actually touches the surface before treating a constrained contact as verified.
- Prefer a natural, unconstrained base motion and fit the prop layout to its measured contacts. Reach for `--constrain` only when the layout is fixed and the base motion misses it; piling on many sparse joint constraints to chase sole contact visibly distorts the body (knee/hip mechanics), so favor a true foot-locking/IK correction on the mesh over overconstraining the diffusion pass.
- Constraints bind ONLY the frames you list. Frames after the last target are free, so the motion drifts there; constrain the whole contact sequence you care about, or keep the clip from running long past it.
- Still run `preflight_motion` on the constrained result before `apply_motion`. Exact end-effector placement does not by itself prove the body reads correctly.

`--constrain` pins a POSITION. Three further flags pin the rest of what ARDY can actually observe; all three require `--base-motion` and none may be combined with `--segment`.

- **`--constrain-orient <frame> <joint> <qw> <qx> <qy> <qz>` — the direction, not just the point.** A proxy keyframe is a pose, and `--constrain` alone supplies half of it: the hand reaches the coordinate with whatever wrist axis pass 1 happened to produce. Measured on a live run the unconstrained wrist sat **170.06° away** from the requested axis, so without this the axis really is arbitrary. The quaternion is the joint's GLOBAL rotation in npz space (Y-up). It requires a `--constrain` at the same frame and joint; an orientation with no position is rejected rather than half-applied. Read `orientations[].achieved_error_deg` next to `base_error_deg`. **Read all three warnings before using it — the reported numbers cannot tell you when the axis is wrong.**
  - **No tool reports a surface normal today.** `inspect_relations` returns AABBs, `top_above_reference_base`, support planes and a 2D direction — no orientation of any kind. There is no supported path from a measured scene to a quaternion yet, so deriving one means raw Blender scripting and you own the correctness.
  - **A normal is not a rotation, and the npz mapping is not a swap.** One axis leaves the spin about it free, so a normal underdetermines the quaternion. Worse, the position mapping Blender `(x, y, z)` → npz `(x, z, y)` is a REFLECTION (determinant −1); applying that same component reorder to a rotation MIRRORS it. Converting a rotation needs conjugation by the basis change with the handedness sign corrected, never a reordering.
  - **`achieved_error_deg: 0.0` does not mean the axis was right.** It is measured against the very quaternion you supplied, so it proves the sampler converged on your request, not that your request encoded the pose you intended — a mirrored or spun quaternion reports 0.0 just as happily. Confirm the axis visually, or against the sole/palm contact geometry, before trusting it.
- **`--constrain-pose <src-motion-id> <src-frame> <dst-frame>` — a whole-body pose.** Sitting and lying are not end-effector positions, which is why seated prompts fail no matter how the feet are constrained: 27 joint rotations are not authorable by hand, so the pose is copied out of an already-staged motion. Live run: the unconstrained frame was 1.0964 m off in shape and 1.5154 m off at the root; pinned it was 0.0 on both, and the very next frame still differed by 0.0942 m, so the pin is exact and local rather than a smoothed average. Two limits to plan around:
  - **This is the mechanism, not the answer to "make it sit".** The source pose has to come from somewhere, and ARDY's text-to-motion is exactly what fails to sit — so a seated source cannot itself be generated here. It has to come from imported mocap, an authored rig pose exported to npz, or a frame where a clip transiently achieves it.
  - **The pose brings its own root**, and `FullBodyConstraintSet` pins that root too. `--constrain-path` binds only XZ and would fight the pinned root at the same frame, so it does not give you seat height. Place the result with the armature transform in Blender instead, and pick a source whose root height already matches the seat. Read `poses[].shape_max_error_m` against `base_shape_max_error_m` to see whether the pin actually took.
- **`--constrain-path <frame> <x> <z> <heading>` — where the root actually goes.** This is the 2D route on the floor: `x` and `z` are the horizontal plane in npz space (Y is up and is NOT constrained here), and `heading` is radians or the literal `none` to leave facing free. Prose like "walk two metres then turn left" only biases; this binds. A live 4-waypoint zig-zag landed every waypoint within **0.04 m**. Give `heading` for every waypoint or for none — ARDY conditions the whole set on one heading tensor, so a partly-headed request would invent the rest. Read `waypoints[].achieved_error_m`.

A run may use any combination of these and `--constrain`, and may use them with no `--constrain` at all — `residual` is then `null` rather than a zero that would read as a perfect hit.

Three quality knobs, all constrained-mode only:

- **`--samples <n>` (1-8) draws n candidates and keeps the best one.** Each draw is a full sampling pass so cost is linear; 3-4 is the useful range. Raise it when a run comes back with a borderline `residual` or a visibly jerky clip and you would otherwise reseed by hand — best-of-N is that reseed, done once and measured. Selection is lexicographic: lowest MEASURED constraint error first, then lowest peak joint ACCELERATION as the tie-breaker. Both halves of that are load-bearing. ARDY lands these end-effector constraints to well under a millimetre, so ranking on constraint error alone leaves every candidate tied and the flag would do nothing — the tie-breaker decides nearly every real run. And it ranks acceleration, not speed: an earlier velocity-based version conflated smooth with slow and picked the laziest satisfying draw. Measured on the same four draws, the velocity metric chose the SHORTEST clip (1.90 m travel) while acceleration chose a longer, genuinely smoother one (peak acceleration 0.0877 against 0.1027, travel 2.00 m). A pop or a teleport is an acceleration spike; sustained fast motion is not. Read `selection.sample_costs` and `selection.chosen_index`; the choice is reported, never hidden. `travel_m` is reported per sample and deliberately NOT ranked — if the distance covered matters, bind it with `--constrain-path` rather than hoping the tie-breaker picks it. Two more limits worth knowing: selection optimises acceleration, not the jump-based continuity gate, so a selected draw can still trip that gate and warrant a reseed; and because the tie-breaker cannot see the prompt, an under-constrained motion request ("a person waves while standing" pinned only at its own start) lets a near-static draw tie and win — constrain the motion itself rather than changing the sample count.
- **`--root-margin <m>` (0-0.5 m, default 0.04)** is ARDY's post-process root-correction margin. The default 0.04 is 10% of a 0.4 m box height, so lower it when a contact has to be tight and you accept less foot-skate smoothing in exchange.
- **`--contact-threshold <t>` (strictly 0-1, default 0.5)** is the foot-contact probability cut-off post-processing trusts. Raise it to act on fewer, more confident contacts.

The result echoes `postprocess.contact_threshold` and `postprocess.root_margin` (`null` when post-processing is off), so the settings that produced a clip stay recoverable from the clip's own receipt.

Then, with the character's entity_id from inspect_project:

```
stage_scene op: {op: "apply_motion", entity_id: <uuid>, motion_id: "<motion_id>", hand_shapes: {left: "<preset>", right: "<preset>"}, start_frame?: 1}
```

- Target must be a CozyClay character (add_character Y_BOT/X_BOT first if none exists).
- apply_motion replaces the character's current action, sets scene fps to 20, and extends frame_end to fit.
- ARDY's compact skeleton has no articulated fingers. The director, not a runtime classifier, chooses each side dynamically from the request's visible hand-configuration intent. The validated library (`1.1.0`) vocabulary is exactly: `relaxed`, `open`, `fist`, `soft_fist`, `point`, `two_finger`, `cup`, `grasp`, `thumb_extended`, `three_finger`, `hook`. Do not send any preset outside this vocabulary.
- `hand_shapes` is request-time, per-side, and clip-wide: one left and one right shape apply for the entire baked clip. Omitted sides resolve to `relaxed`, but normally send both explicitly for observable intent. Never route a preset from action/object keywords.
- **`hand_track` — a side that changes shape mid-clip.** When a hand must be open on approach and closed on contact, send `hand_track` instead of `hand_shapes` (the two, and the legacy `hand_pose`, are mutually exclusive):

```
stage_scene op: {op: "apply_motion", entity_id: <uuid>, motion_id: "<id>",
                 hand_track: {right: [{frame: 0, preset: "open"},
                                      {frame: 38, preset: "grasp"},
                                      {frame: 70, preset: "grasp"},
                                      {frame: 78, preset: "open"}]}}
```

  - `frame` is a 0-based CLIP frame — the same space as `contact_windows` and `--constrain` targets, so a contact never needs converting twice. `start_frame` still offsets the whole clip within the scene.
  - Frames must strictly increase, at most 32 keys per side, every frame inside the clip. A frame past the end fails as `APPLY_MOTION_HAND_TRACK_INVALID`; it is never clamped.
  - Omit a side to leave it clip-wide `relaxed`. Include a side only when it actually changes.
  - Blender interpolates between keys, and that is exact here rather than an approximation: every preset is a pure flexion about the same per-joint axis, so two presets differ only in angle.
  - **Timing is inferred, not generated.** ARDY has no fingers, so a track is a rule you author: derive the close/open keys from `contact_windows` or the `--constrain` frames. Never guess when the hand "should" close.
  - The result reports `left`/`right` as the RESTING shape (the track's last key) plus a `track` field carrying the keys actually baked. Verify against `track`.
- Choose by visible digits, not by the named activity: `point` extends the index; `two_finger` extends index and middle; `three_finger` extends index, middle, and ring; `hook` bends the fingers into a hook; `cup` forms a shallow curved palm while `grasp` closes farther around a volume; `fist` is fully closed while `soft_fist` is looser; and `thumb_extended` closes the fingers while extending the thumb. Use `relaxed` for no consequential shape and `open` for a neutral fully extended hand.
- A preset controls finger-joint shape only. Wrist rotation, palm facing, and hand position come from ARDY/body motion or armature placement; never treat wrist/world orientation as a digit-shape choice.
- Generation is cheap; the npz stays in `.cclay/motions/` and can be re-applied after a rollback.
- Use `--seed N` only when you need a different deterministic take; keep the prompt and segmentation fixed while comparing seeds.

**Hard guardrail: Never concatenate, splice, crossfade, or hand-edit motion npz files or arrays.** If a result is wrong, regenerate — reword, reseed, re-segment, or add end-effector constraints (section 3b). Constrained regeneration is the supported way to make a motion hit specific coordinates; raw npz surgery guarantees pose discontinuity.

## 4. Hand off to visual verification

Immediately after `apply_motion`, before judging the result or reporting completion, read the `visual-qa` skill listed in `available_skills`. Give its workflow the generation result, including `segments`, `continuity`, `boundary_gate`, `residual`/`targets` (constrained runs), and `max_jump_frame` when present. It owns frame/view selection, actor-object fit checks, defect classification, and the correction loop.

Generation-specific facts the QA step must preserve:

- Text-following is not guaranteed; wrong body mechanics require a clearer prompt or a different seed.
- In segment mode, `exhausted: true` means the deterministic continuity gate shipped its calmest attempt. Re-running the identical command will not improve it; reword the segment transition.
- ARDY is scene-blind by default, so small prop/contact offsets from an unconstrained clip are placement defects: fix them with whole-armature or prop transforms, never motion-array edits. When the offset is per-contact rather than uniform — the signature of a stair or multi-step layout, where one transform cannot fit every tread — a single transform CANNOT fix it; that case routes back to a constrained regeneration (section 3b) with the measured contact coordinates.
