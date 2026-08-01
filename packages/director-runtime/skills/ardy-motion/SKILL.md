---
name: ardy-motion
description: Use for character or player animation/motion. Call the typed ardy_regenerate tool for constrained regeneration through the host queue, verify the archived motion, then bake it with stage_scene apply_motion.
---

# ARDY character motion

ARDY is a typed host-side generation pipeline exposed to the director only through `ardy_regenerate`. That tool publishes a closed request to the host-side regeneration queue; the host owns `MotionArchiveStore`, `ArdyArchiveService`, `ArdyMotionKernel`, and `CharacterRigAdapter`, commits the validated archive, and applies it through the durable mutation path. Do not invoke ARDY wrappers, construct archive files, or trigger Blender operators from Python.

The typed ARDY APIs are correctness boundaries for well-behaved callers: they validate archive, rig, and request contracts. They are not a security boundary. Arbitrary `execute_blender_python` can bypass that validation; do not claim ARDY provides OS isolation or a drift detector.

`stage_scene` is retained only for `add_character`, `adopt_entity`, `set_render_settings`, and `apply_motion`. Use `execute_blender_python` for all ordinary Blender work: placement, transforms, material/light/camera construction, hierarchy, and local corrections. Every Python mutation starts with `import bpy` and uses the latest `expected_revision_id`.

## 1. Specify and measure the requested motion

Before requesting regeneration, identify the existing `base_motion_id`, character `entity_id`, latest `expected_revision_id`, and the measured corrections the motion needs. `ardy_regenerate` is constrained regeneration of an existing base motion; it is not unconstrained text-to-motion generation.

Placement and facing are not ARDY inputs. Use `execute_blender_python` to position or rotate the character armature and props. For an existing interaction, call `inspect_relations` first with the props' explicit `entity_ids` and the armature as `reference_entity_id`.

Use one `ardy_regenerate` request for one correction pass. Keep its `request_id` stable across retries so the durable queue can return the recorded outcome instead of committing the same request twice. Do not concatenate, splice, crossfade, or hand-edit motion npz files or arrays.

## 2. Regenerate through the typed host path

Call `ardy_regenerate` with the base motion, character, latest revision, and measured effector, full-body, or root-path targets. The tool writes the request to the host queue and waits for its typed durable outcome. The host invokes the generator through `ArdyMotionKernel`, commits through `ArdyArchiveService`, applies the resulting `motion_id`, and returns `resulting_revision_id`.

When geometry contact must be exact, request constrained regeneration using the host's typed request contract, with the base motion and measured targets. End-effector positions use `LeftFoot`, `RightFoot`, `LeftHand`, or `RightHand`; target coordinates are motion-local npz coordinates (Y-up, meters). Convert Blender `(x, y, z)` only from the reported `preflight_motion` scale and coordinate contract; Blender is Z-up. Use `foot_contacts` to select planted-foot timing when available, otherwise `contact_windows`.

Constrained joint accuracy does not prove sole contact: `LeftFoot` and `RightFoot` are skeleton joint centers, not sole contact points. An `achieved_error_m` of zero proves only that the joint hit its target. Never use a guessed joint-to-sole offset as final verification. Use `inspect_pose_contacts` in visual QA to verify the deformed sole against the support surface.

## 3. Preflight, then apply

Before applying a candidate, call `preflight_motion` with its `motion_id` and character `entity_id`. Compare `travel.distance_horizontal`, `travel.height_change`, `contact_windows`, and `end_pose` with `inspect_relations`. A material mismatch requires another queued constrained regeneration or a Python layout correction; do not apply blindly.

Apply only through the retained operation:

```
stage_scene op: {op: "apply_motion", entity_id: <uuid>, motion_id: "<motion_id>", hand_shapes: {left: "<preset>", right: "<preset>"}, start_frame?: 1}
```

Target a CozyClay character created with `add_character` or explicitly claimed with `adopt_entity`. `apply_motion` replaces the character action, sets scene fps to 20, and extends `frame_end` as needed. Do not set a conflicting fps with `set_render_settings` for a scene that will receive baked motion.

Choose both hand presets explicitly from visible requested digit shape, not action/object keywords. The validated library (`1.1.0`) vocabulary is exactly: `relaxed`, `open`, `fist`, `soft_fist`, `point`, `two_finger`, `cup`, `grasp`, `thumb_extended`, `three_finger`, `hook`. Use `hand_track` for a side that changes shape mid-clip; derive its 0-based clip frames from contact evidence. Do not claim ARDY generates fingers.

## 4. Verify

Immediately after `apply_motion`, read the `visual-qa` skill. Pass the generation receipt, including segments, continuity, constraint residuals, and `max_jump_frame` when present. Visual QA owns frame selection, `inspect_pose_contacts`, capture/render evidence, defect classification, and the correction loop.
