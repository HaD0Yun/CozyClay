---
name: visual-qa
description: Read after creating or significantly changing a Blender scene, object, character motion, or camera, immediately before visual verification. Covers relation-driven numeric checks, capture/render evidence, and correction routing.
---

# Visual QA

Load after a significant visual mutation and before reporting completion. Verify the intended relation numerically, render only evidence that can disprove it, correct visible defects, then stop.

`stage_scene` is retained only for `add_character`, `adopt_entity`, `set_render_settings`, and `apply_motion`. Use `execute_blender_python` for ordinary Blender placement, transforms, materials, lights, cameras, hierarchy, and local corrections. Python scripts begin with `import bpy` and must carry the latest `expected_revision_id`.

ARDY's `MotionArchiveStore`, `ArdyArchiveService`, `ArdyMotionKernel`, and `CharacterRigAdapter` are typed correctness boundaries for well-behaved callers, not a security boundary. Arbitrary Python can bypass their validation; do not claim OS isolation or a drift detector.

## 1. Declare the relation

Identify the subject, target region, active body part, approach direction, expected end relation, and frames/views that expose failure. Use `support`, `contact`, `grasp`, `seat`, `lean`, or `target` as applicable. Do not invent exact contact constraints that the scene or request does not provide.

## 2. Verify numerically before rendering

For static placement, use `inspect_relations`. For character motion, compare `preflight_motion` for the applied/candidate `motion_id` against `inspect_relations` for the relevant props and character armature:

- Compare `travel.distance_horizontal`, `travel.height_change`, `contact_windows`, and `end_pose` to measured travel, support heights, and the intended relation.
- Use `foot_contacts` to identify the frame and side of a planted foot when available. Its joint heights are not sole contact measurements.
- `LeftFoot` and `RightFoot` are skeleton joint centers, not sole contact points. For every declared planted frame, call `inspect_pose_contacts`; `support_gap_m` must be within ±0.03 m and `inside_support_footprint` must be true for `surface_contact_verified` to be true. `surface_contact_verified: false` is a hard QA failure.
- ARDY is scene-blind. Measured caption numbers bias output but do not bind geometry. Do not claim the model used prop geometry.

Reuse unchanged preflight/relation results. Select QA frames from contact windows, segment boundaries, and `max_jump_frame`, not guesses.

## 3. Capture and render evidence

Use `capture_viewport` for fast checks; capture an establishing view, a side/contact view, and a close view only when needed. A `support`, `contact`, `seat`, `lean`, or `grasp` relation requires at least two views including `contact_low`; never approve actor-object contact from a single camera angle.

Use `render_qa_frames` for final motion checks at selected frames. Read returned images directly and do not build montages. If no suitable camera exists, create and activate it with `execute_blender_python` (`import bpy`), preserving the latest expected revision; a temporary unsaved camera is not a deliverable.

Check requested elements, scale, framing, occlusion, floating/intersecting geometry, actor-facing, contact, foot skating, segment pops, and consequential hand shapes. For a hand track, inspect its contact-frame state rather than only its resting shape.

## 4. Correct the smallest defect

Classify before changing the scene:

| defect class | correction |
|---|---|
| Uniform offset or global facing error | Use `execute_blender_python` to make one whole-armature or prop-assembly transform correction. |
| Per-contact offset | A single transform cannot fit it. Queue typed constrained ARDY regeneration against measured contacts; never keyframe a clip-wide offset to hide it. |
| Layout mismatch | Use `execute_blender_python` to refit prop geometry to measured contacts, or queue constrained regeneration for the intended layout. |
| Local contact residual | Use a bounded local Python correction only; never a large clip-wide whole-body offset. |
| Wrong hand shape only | Re-apply the same `motion_id` with `apply_motion`, preserving the correct side and changing only the failed side. |
| Wrong hand timing | Re-apply that side with `hand_track` keyed from contact evidence. |
| Wrong body mechanics or missing action | Queue ARDY regeneration; never edit or splice motion arrays. |
| Framing or occlusion only | Correct the camera with `execute_blender_python`, not the scene. |

Make one logical correction, then re-check only the failed comparison/view/phase. Do not report success while a numeric or visible failure remains.
