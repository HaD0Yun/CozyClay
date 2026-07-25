---
name: visual-qa
description: Read after creating or significantly changing a Blender scene, object, character motion, or camera, immediately before visual verification. Covers relation-driven QA, numeric verification with inspect_relations and preflight_motion, lightweight multi-view evidence, motion frame selection, actor-object fit, defect classification, and smallest-first correction routing.
---

# Visual QA

Load this skill only after generation or a significant visual mutation, before reporting completion. Keep QA proportional: verify the intended relation numerically first, render only the views and frames that can disprove the result, fix visible defects, then stop.

## 1. Declare the intended interaction relation

Use one short internal checklist, not a new artifact or schema:

- What is the subject and what should it look like or do?
- For actor-object interaction, name the **relation kind**: `support` (weight rests on a surface), `contact` (a body part touches something), `grasp` (a hand closes around it), `seat` (sitting on it), `lean` (resting against it), or `target` (facing/reaching toward it).
- Derive the **active body part(s) from the relation kind** — support → the weight-bearing parts, grasp → the hands, seat → pelvis and thighs, lean → back or shoulder, contact → the touching part named by the action, target → the facing/reaching part. Checked body parts come from the declared relation, not from a fixed list.
- Name the target object region, approach direction, and expected end relation.
- Which frames or views would expose a failure?

Do not invent exact contact constraints that the scene or request does not provide.

## 2. Verify numerically before rendering anything

Numeric checks replace eyeball passes; they do not add render work. For static placement, `inspect_relations` alone is the numeric check. For character-motion work, before rendering, compare `preflight_motion` output for the applied/candidate motion against `inspect_relations` measurements of the scene:

- Call `inspect_relations` with the interaction props (parented props need explicit `entity_ids`; modifier-generated copies are not measured) and the character armature as `reference_entity_id`, to get support-surface heights (`support_planes`), relative offsets/distances, pattern pitch, and the character's `standing_height` / `rest_heights`.
- Call `preflight_motion` with the `motion_id` and the character's `entity_id` so heights come out in meters. Its analysis is motion-local (horizontal distance and heights, not world XY); placement and facing still come from the armature transform.
- Compare:
  - `travel.distance_horizontal` vs the required travel to the target (`relative.horizontal_distance`).
  - `travel.height_change` vs the required rise: the LAST pattern member's `top_above_reference_base` (direct measurement, preferred) — or equivalently the first member's `top_above_reference_base` + (count-1) × the pattern pitch's vertical component `dz` for a regular layout.
  - `contact_windows` heights vs the measured support-surface heights — a gap or penetration beyond ~0.03 m is a defect.
  - `foot_contacts` — ARDY's own per-foot channel, when present. Compare a channel against ITSELF across windows, never against a surface height directly: the heel and toe joints sit at different heights on a planted foot (measured ~0.058 m apart), so reading `right_heel` against the floor invents a 5.8 cm float. For a climb, one channel's window heights should step by the measured riser (e.g. `right_toe` at 0.007 → 0.187 → 0.367 for 0.18 m steps); if every window of that channel reports the same height, the character never left the floor no matter what the render looks like. `height_max` is the worst frame inside a window, so `height_max` far above `height` means the foot drifted while the model still called it planted. Windows name the limb (`left_heel`, `left_toe`, `right_heel`, `right_toe`) and the frames, which is what a rank-2 fix needs. `null` means the archive carries no channel, not that there is no contact.
  - **Hard rule: `Foot` joints (`LeftFoot`/`RightFoot`) are skeleton joint centers, not sole contact points.** `contact_windows`/`foot_contacts` heights and any `--constrain` `achieved_error_m: 0.0` describe skeleton JOINT positions, never the deformed sole mesh. Confirm actual sole-to-support contact with `inspect_pose_contacts` for each declared planted frame: `support_gap_m` must be within ±0.03 m (positive = gap, negative = penetration) AND `inside_support_footprint` must be true for `surface_contact_verified` to read true. A guessed constant joint-to-sole offset (e.g. "always subtract 6 cm") is never an acceptable substitute for this measurement — the real offset changes with foot rotation. Treat `surface_contact_verified: false` on any declared planted frame as a hard QA failure, not an advisory, and do not report completion while it fails.
  - `end_pose.resting` and `end_pose.root_height` vs the intended end relation.

Only after the numeric checks pass — or to diagnose a specific numeric mismatch — proceed to visual confirmation. If the ardy-motion preflight gate already ran and the scene and motion are unchanged since, reuse its `preflight_motion` / `inspect_relations` outputs instead of re-measuring. Choose QA frames FROM `contact_windows` and segment boundaries instead of guessing.

## 3. Choose economical evidence

- Use `capture_viewport` for fast iterative checks. With no `subject` it captures the human's live viewport as one image; with a `subject` (entity id) and optional `views` it synthesizes several purposeful angles of that entity in a single call (named views `three_quarter`, `front`, `side`, `top`, `contact_low`; default set `three_quarter`, `side`, `contact_low`). Pass `subject` and let one call produce the required views instead of capturing the same angle repeatedly. Inspect up to 3 useful views: an establishing view, a side view that reveals depth/contact, and a close view of the subject or interaction; once the numeric checks pass, one confirming view suffices for non-contact relations. A declared `support`/`contact`/`seat`/`lean`/`grasp` relation always needs at least two views, including `contact_low` specifically — a near-ground grazing angle aimed at the subject's base is the only view that reveals a support gap or penetration, so it must be in the `views` for those relations before they can be approved — never approve actor-object contact from a single camera angle. Add another view only when something is occluded. These captures do not mutate the scene or bump the revision.
- Use `render_qa_frames` for the final check. For motion, inspect the frames selected in section 2 (contact windows, segment boundaries) plus `max_jump_frame` when present. Check temporal frames from one revealing side first; use 1–2 extra views only for the failed/contact frame. Do not render the full frame set from every viewpoint. When the numeric checks passed, a short confirmation pass is enough.
- If the scene has no active camera, create and activate one with `stage_scene` `add_camera` before final rendering. A temporary camera in an unsaved background process is not a deliverable.
- Read returned images directly. Do not build montages or probe optional image packages. Put any unavoidable helper script or disposable output under `/tmp`, not the project root.
- A single attractive angle is not proof. Prefer views that reveal intersections, floating geometry, incorrect facing, and contact gaps. A single oblique establishing render is never sufficient contact evidence by itself.

## 4. Evaluate only actionable defects

Check:

- **Scene/readability** — requested elements are present, scale and framing read correctly, no accidental occlusion; multi-part props are grouped in an assembly rather than left as loose objects.
- **Geometry** — no visible floating, ground penetration, or unintended object intersection. A clear gap between the relation's weight-bearing body parts and their support surface is a failure, not an advisory.
- **Interaction** — actor faces and reaches the intended target region with the body part the declared relation names; the main contact has no obvious gap or penetration; the ending appears supported and stable. A requested-stable ending with `end_pose.resting: false`, or any planted support point with `inside_support_footprint: false` or inside the required edge margin, is a hard failure — do not report completion while either holds.
- **Motion** — intended action is present, root travel matches the preflight numbers, feet do not visibly skate, and segment boundaries do not pop.
- **Hands, only when consequential** — inspect a close view only when a hand's visible configuration matters or it is near the face, body, or an object; reject the wrong digit shape, rigidly splayed fingers, or visible penetration. Otherwise skip hand close-ups. Read required `applied_hand_shapes` from the `apply_motion` result as the resolved state ordered `left`, then `right`; do not infer it from defaults. When a row carries a `track`, that is the authoritative baked state and `left`/`right` only report its resting shape — check the contact frame, not just the last one.
- Treat the validated hand-shape library (`1.1.0`) as fail-closed. Its vocabulary is exactly: `relaxed`, `open`, `fist`, `soft_fist`, `point`, `two_finger`, `cup`, `grasp`, `thumb_extended`, `three_finger`, `hook`. Never preserve or submit a value outside this vocabulary during repair.

ARDY is scene-blind. Judge object interaction from the numeric comparison and the relative visual result; do not claim the model used prop geometry.

## 5. Route the correction smallest-first by defect class

Classify the defect from the numeric signature before changing anything, then take the FIRST matching row:

| rank | defect class (signature) | correction |
|---|---|---|
| 1 | **Uniform offset** — all contact windows share one constant error against the measured surfaces (or a global position/facing offset) | One `transform_entity` on the character armature or the prop assembly. |
| 2 | **Per-contact offset** — the contact errors DIFFER from each other (typically growing across a stair or multi-step layout) | No single transform can fit them: constrained regeneration. Read the `ardy-motion` skill's section 3b and re-generate with `--constrain` at the measured contact coordinates. Do not keyframe a clip-wide offset to hide it. |
| 3 | **Layout mismatch** — measured contact pitch/heights disagree with the prop layout | Refit prop positions/dimensions to the MEASURED contact points, or regenerate constrained against the layout you intend to keep. |
| 4 | **Local contact residual** — one contact window is off while the others fit | Bounded local correction over that window only. NEVER a clip-wide whole-body offset above a small threshold (~0.05 m). |
| 5 | **Wrong hand shape only** — one side's visible digit configuration is wrong while the body motion fits | Re-apply the same `motion_id` with `hand_shapes` containing both values from returned `applied_hand_shapes`, changing only the failed side; this preserves the correct side and makes the repair explicit — never regenerate correct body motion for a finger-only defect. |
| 6 | **Hand shape right but wrongly timed** — the digits are correct at the contact but held that way through the approach or the release (e.g. already closed while still reaching) | Re-apply that side as a `hand_track`, keying the open/close frames from `contact_windows`. Do not substitute a different preset to compensate for timing. |
| 7 | **Wrong body mechanics or missing action** | Reword, reseed, or re-segment ARDY; never edit or splice motion arrays. |

**Do not** paper over a layout mismatch by keyframing a large clip-wide vertical offset (e.g. half a meter) on a parent Empty — refit the layout or regenerate instead.

Remaining local defect classes:

- Bad object scale or placement → transform the object or its assembly.
- Loose multi-part prop → create one assembly and parent its parts before completion.
- Framing or occlusion only → adjust the camera, not the scene.
- Segment pop → use ARDY continuity data and reword the earlier segment ending; an identical rerun cannot improve an exhausted deterministic gate.

Make one logical correction, then re-check only the failed comparison, view, or phase — re-running the numeric comparison is cheaper than re-rendering. Do not restart a full inspection/render loop for a local defect. One correction pass is normally enough; take a second only for a clearly visible remaining defect.
Do not claim verification succeeded while a numeric or visible failure remains; either correct it or state the residual limitation precisely.
