# 05 — cclay apply: how a stored ARDY motion becomes Blender keyframes, and every rate/timing assumption in that path

Summary: `_apply_motion` (`blender-addon/cclay/stage_scene.py:1408`) is the only place a stored ARDY motion (`.cclay/motions/<motion_id>.npz`) becomes Blender animation. It loads the npz's `local_rot_mats`/`posed_joints`/`fps.npy`, retargets cskel27 local rotations into per-bone pose-bone local quaternions (`basis = Rb^T @ L @ Rb`), and writes one keyframe per npz frame onto the mixamorig-prefixed bones plus the Hips location channel, with the scene frame rate forced to the npz's native fps (`scene.render.fps = fps`, `fps_base = 1.0`). There is exactly one npz frame per scene frame — no resampling anywhere. The single plan-level guard `_require_plan_fps_agrees` (`stage_scene.py:1347`) enforces "one frame rate per plan" and deliberately ignores the LIVE scene fps; it is only invoked when a plan contains at least one `apply_motion`, which leaves a documented cross-plan gap: a later separate plan that carries only `set_render_settings {fps}` is never checked and can silently re-time an already-baked motion. `cclay.motion_fps` is written onto the baked action (`stage_scene.py:1503`) and is read back in exactly one place — `constraint_capture.base_clip_of` (`constraint_capture.py:622`) — for regeneration metadata and a pose-capture fps-mismatch guard, never to re-validate scene fps.

## 1. `_apply_motion`: the full bake path

### 1.1 Gates before baking

- `_require_owned_entity(operation["entity_id"], project_id)` (`stage_scene.py:1414`, def at `:309`): the object must exist (found by `cclay.entity_id` in `bpy.data.objects`, `:269-277`) and carry `cclay.owned_project_id == project_id` (`:280-281`); failures raise `STAGE_SCENE_TARGET_NOT_FOUND` / `STAGE_SCENE_TARGET_NOT_CCLAY_OWNED` (`:311-316`).
- Armature type check (`:1415-1418`): `scene_object.type != "ARMATURE"` raises `STAGE_SCENE_TARGET_TYPE_INVALID` ("must be an CCLAY character armature").
- `_require_exclusive_datablocks` (`:1419`, def at `:320-337`): armature data with `users > 1` raises `STAGE_SCENE_SHARED_DATABLOCK`. (A library-linked datablock check exists but only in `_adopt_entity`, `:698-703`; `_apply_motion` does not re-check `.library` directly.)
- `hand_shapes.validate_rig_bones(scene_object.get("cclay.character_type"), bone names)` (`:1422-1427`): character type must be `Y_BOT` or `X_BOT` and all canonical hand bones must be present (`hand_shapes.py:171-200`); failure → `APPLY_MOTION_HAND_SHAPE_RIG_UNSUPPORTED`.

### 1.2 Payload load and validation

- `motion_archive.load_motion_payload(project_directory, motion_id, validate=False)` (`:1429-1433`, def at `motion_archive.py:357-392`) resolves `.cclay/motions/<motion_id>.npz` (`motion_path`, `:318-343`) and materializes `local_rot_mats` (`(F, 27, 3, 3)`) and `posed_joints` (`(F, 27, 3)`). `validate=False` because validation runs incrementally on the Blender main thread instead.
- `motion_retarget.MotionValidationCursor(local_rot_mats, posed_joints, fps)` stepped in bounded chunks (`:1435-1442`, def at `motion_retarget.py:244-332`): fps must be an integer in `FPS_BOUNDS = (1, 240)` (`:55`, `:247-253`); frame count 1..`MAX_FRAMES` (24000, `:54`, `:261-264`); shapes `(F,27,3,3)`/`(F,27,3)` (`:255-260`); every component finite; every rotation matrix orthonormal within `ROTATION_MATRIX_TOLERANCE = 1e-3` (`:61`, `:295-315`); payload ≤ 96 MiB (`:269-272`); and the frame-0 Hips must be +Y dominant ("motion is not Y-up", `:318-326`). Failure → `APPLY_MOTION_MALFORMED` (`:1441-1442`).
- `frame_count = len(local_rot_mats)` (`:1443`). The hand track is resolved only after the payload loads, because it is validated against the real clip length (`:1444-1451`, `hand_shapes.resolve_hand_track` at `hand_shapes.py:79-142`).

### 1.3 Retargeting (space and scale)

- `CharacterRigAdapter(scene_object.data.bones)` (`:1456`, def at `character_rig.py:8-43`): prefix is `"mixamorig:"` when any bone starts with it, else `""` (`:13`).
- `rig.rest_rotations()` (`:1458`, `character_rig.py:23-31`): armature-space rest rotation of each target mixamo bone (`bone.matrix_local.to_3x3()`), keyed by cskel27 name. Hips/RightUpLeg/RightLeg must exist or `STAGE_SCENE_TARGET_TYPE_INVALID` (`:1459-1463`).
- `derive_scale(posed_joints[0], rig.rig_thigh)` (`:1465`, def at `motion_retarget.py:347-359`): `rig_thigh_length / npz_thigh` where the thigh is `RightUpLeg -> RightLeg` in frame 0 (units-per-meter).
- `PoseTrackBuilder(...)` (`:1466-1475`, def at `motion_retarget.py:384-445`): per frame and per cskel joint, `local = frame_rots[JOINT_INDEX[cskel]]`; Spine3 is composed into Spine2 (`local = L_Spine2 @ L_Spine3`, `:429-430`); then `basis = Rb^T @ L @ Rb` (`:431-434`) and converted to a wxyz quaternion. This is the change of basis from ARDY's cskel27 local frame to the mixamo bone's armature-space rest frame — documented at `motion_retarget.py:1-13`. Hips location per frame: `(hips_target * scale - rest_hips_head)` rotated by the hips rest-rotation transpose (`:436-442`), in **hips-bone-local space** with `pose_bone.location` semantics (`:371-374`). Failure → `APPLY_MOTION_MALFORMED` (`:1478-1479`).

### 1.4 What is written, onto which bones

- Rotation curves (`:1537-1573`): for each cskel joint in `tracks["rotations"]`, mapped through `motion_retarget.MIXAMO_TARGETS` (`motion_retarget.py:38-52`) to bone `f"{prefix}{target}"`. Joints with `target is None` (Spine3, RightHandEnd, LeftHandEnd) are skipped (`:1539-1540`); bones absent from the rig are skipped (`:1543-1544`). Per bone: 4 fcurves (`rotation_quaternion` array indices 0..3, `data_path = pose_bone.path_from_id("rotation_quaternion")`, `:1555-1556`) written via `_bulk_fcurve` (`:1561-1568`). Digit roles (from the hand-shape inventory) get `hand_shapes.compose_quaternions(quaternion, delta)` applied first (`:1545-1553`, compose at `hand_shapes.py:233-244`).
- Hips location curves (`:1575-1594`): 3 fcurves (`location` indices 0..2) from `tracks["hips_locations"]` on `f"{prefix}Hips"`.
- Hand-shape curves for digit roles the body retarget does not author (`:1597-1656`): untracked sides get a clip-wide constant at `sparse_frames = [start_frame]` (+`end_frame` when different, `:1597-1599`), skipped when the delta is identity (`:1621-1625`); tracked sides get per-role keys at `start_frame + clip_frame` from `hand_shapes.track_role_keys` (`:1637`, def at `hand_shapes.py:145-168`), with the resting delta being the track's last preset (`:1630-1633`).
- Every keyframe is written with interpolation `BEZIER`, easing `AUTO`, and `AUTO_CLAMPED` handles (`_keyframe_bulk_values`, `:952-971`, applied in `_bulk_fcurve` at `:1071-1074`). So between two dense keys the value is bezier-interpolated, not held.
- Keyframe authoring mode is gated by `_motion_keyframe_mode()` (`:1770-1776`): env `CCLAY_MOTION_KEYFRAME_MODE` defaults to `bulk_dense`; the adaptive writer is disabled.

### 1.5 The action datablock and its metadata

- A new action named `CCLAY Motion <motion_id>` is created (`:1497`) and registered for rollback/orphan cleanup (`:1498`, `:530-537`).
- Metadata custom properties (`:1501-1519`):
  - `cclay.motion_id` (`:1502`), `cclay.motion_fps` = npz fps (`:1503`), `cclay.motion_start_frame` (`:1506`, "Downstream clip-frame conversion (clip_frame = scene_frame - start_frame) reads this from the action instead of re-deriving it from the caller", `:1504-1505`), `cclay.motion_frames` = frame_count (`:1507`), `cclay.hand_shape_left/right` + `cclay.hand_shape_library = 1` (`:1508-1510`), legacy `cclay.hand_pose` only when neither `hand_shapes` nor `hand_track` was given (`:1511-1512`), and per-side `cclay.hand_track_<side>` as JSON of clip-relative `{"frame", "preset"}` keys (`:1513-1519`).

### 1.6 Detached topology, bind, and final pose

- `_create_detached_action_topology` (`:1521`, def at `:974-1000`): OBJECT-slot + a `CCLAY Motion` layer + KEYFRAME strip + slot channel bag; feature-probed, `APPLY_MOTION_ACTION_TOPOLOGY_UNSUPPORTED` on partial probe.
- After all curves are written, `_validate_detached_curves` checks exact curve inventory and channel-bag ownership (`:1658`, def `:1254-1310`); then binds `animation_data.action = action` and `animation_data.action_slot = slot` (`:1661-1668`), re-enumerates bound curves via `manifest.animation_fcurves` and compares key counts against expectations (`:1669-1678`; mismatch → `APPLY_MOTION_CURVE_INVALID`).
- Final pose (`:1680-1684`): every bone in `final_rotations` gets `rotation_mode = "QUATERNION"` and its final quaternion; `hips.location = final_hips_location`. This is a side effect of authoring, not a bind pose.

### 1.7 npz → scene frame mapping (no resampling)

- `start_frame = operation.get("start_frame", 1)` (`:1501`; plan bounds `-100000..100000`, `:260-261` and `stage-scene.ts:83`).
- `end_frame = start_frame + frame_count - 1` (`:1523`).
- `dense_frames = [float(start_frame + offset) for offset in range(frame_count)]` (`:1524`): **npz frame i is baked at scene frame `start_frame + i`, exactly one keyframe per npz frame, with no gaps and no resampling.** The docstring states this contract verbatim: "apply_motion bakes exactly one npz frame per scene frame" (`:1350`).
- Timing side effects (`:1686-1692`): `scene.render.fps = fps`, `scene.render.fps_base = 1.0`, `scene.frame_end` extended to `end_frame` when smaller, then `view_layer.update()`. `scene.frame_start` is not touched. Comment: "the baked keys are at the motion's native fps, so the scene rate follows the motion (rollback restores it via render_state)" (`:1686-1687`).
- Rollback: `transaction.capture_render()` snapshots fps/fps_base/frame_start/frame_end/frame_current/resolution before mutation (`:1492`, def `:426-440`) and restores them on rollback (`:465-475`); `capture_animation` snapshots the previous action/slot/pose channels (`:1491`, def `:390-415`).

### 1.8 Result

`{"entity_id", "motion_id", "left", "right", "library_version": hand_shapes.LIBRARY_VERSION ("1.1.0", hand_shapes.py:13)}` plus `track[side]` (clip-relative `{frame, preset}` keys) when a side was tracked (`:1694-1708`). The generator yields progress phases `MOTION_PREPARE`/`OPTIMIZE_OR_DENSE`/`ACTION_CREATE`/`CURVE_BUILD_READY`/`CURVE_BUILD`/`DETACHED_VALIDATE`, consumed by the executor at `:2257-2296`.

## 2. The frame-rate contract

### 2.1 `_requested_scene_fps` — last write wins

`stage_scene.py:1334-1344` (read in full above): iterates `plan["operations"]` and returns the `fps` of the **last** `set_render_settings` operation that carries one, `int()`-cast, else `None`. Docstring: "Last write wins, mirroring Blender: a plan may carry several set_render_settings operations and only the final fps survives." Covered by `test_stage_scene_validation.py:493-504`.

### 2.2 `_require_plan_fps_agrees` — one rate per plan

`stage_scene.py:1347-1405` (read in full above). Behavior:
1. Collect rates: `("set_render_settings", requested)` when the plan names an fps (`:1378-1381`), plus `("motion <motion_id>", int(motion_fps_of(motion_id)))` for every `apply_motion` (`:1382-1385`).
2. If the distinct rate set has ≤ 1 element, return (`:1386-1387`).
3. Otherwise raise `StageSceneError` with code `APPLY_MOTION_FPS_CONFLICT` and a detail string naming every source and rate (`:1400-1405`). Remediation is computed to name only the sources actually in conflict: "omit fps from set_render_settings" only when the plan itself requests an fps (`:1391-1393`), "apply only motions that share a frame rate" only when the motions disagree with each other (`:1394-1398`), and always "or regenerate the motion at the rate you want" (`:1399`).

Call site: `_StageSceneRun.step`, phase `NEW`, **before any mutation** ("Up front, before any mutation: one frame rate for the whole plan. Order-independent by construction...", `:2181-2184`), gated on `self.motion_count` — i.e. only when the plan contains at least one `apply_motion` (`:2185-2192`). `motion_fps_of` is `_stage_motion_fps` (`:728-732`), which calls `motion_archive.motion_fps` (`motion_archive.py:346-354`), a header-only read of the `fps.npy` scalar member (`inspect_motion_archive`, `motion_archive.py:168-311`; the member is required, `:41-45`; integral scalar, `:242-251`; range-checked 1..240, `:305-310`). `fps.npy` is written by the generators: `scripts/ardy/cclay_constrained_generate.py:250-257` and `cclay_sequence_generate.py:192-197` (`arrays["fps"] = np.asarray(fps)`), with `fps = model.motion_rep.fps` (`cclay_constrained_generate.py:975`); upstream does the same (`remote:~/ardy/scripts/generate.py:159-162, 189`).

### 2.3 Why the LIVE scene fps is ignored

Docstring, `:1364-1366`: "Deliberately ignores the LIVE scene fps: a factory-startup Blender scene is already 24 fps, so comparing against it would reject every first apply_motion." Because `_apply_motion` overwrites the scene rate to the motion's native fps (`:1689-1690`), the live fps is an output, not an input. The factory default claim is a comment claim; the observable fact is that the check takes no scene argument and only reads the plan plus `motion_fps_of` (`:1347`).

### 2.4 The exact `APPLY_MOTION_FPS_CONFLICT` trigger

The check raises when the set of distinct rates among {the plan's last requested fps, each applied motion's npz fps} has more than one element (`:1386` → `:1400-1405`). It fires in both operation orders of `{set_render_settings fps:24, apply_motion walk-20}` and for two motions with different native fps, and does not fire for motion-only plans, fps-matching plans, or plans with no motion (tests: `test_stage_scene_validation.py:506-596`; real-Blender rows `test_stage_scene_character.py:682-692`, fixture `stage_scene_character_fixture.py:861-864`). The two historical silent defects it fixes are named in the docstring (`:1354-1357`): render-last left 20 fps keys playing at 24 (clip runs 20% fast); motion-last discarded the requested fps.

### 2.5 The known cross-plan gap, with a concrete two-call reproduction

Docstring, `:1371-1376`: "KNOWN GAP, within-plan only. Ignoring the live fps also means a LATER, separate plan that carries an fps and no apply_motion is not checked at all, so it can still overwrite an already-baked motion's rate and reproduce the same 20%-fast defect split across two stage_scene calls. Closing it needs a different signal than the plan — the baked action already records `cclay.motion_fps` — so it is recorded here rather than half-enforced."

Concrete reproduction (both calls are valid `StageScenePlanV1` per `parse_stage_scene_plan`, `stage_scene.py:174-262`, and the wire schema `stage-scene.ts:42-50, 79-120`; fps 1..1000 is in bounds, `stage_scene.py:58`):

- Call 1 — plan A: `{"schema_version": 1, "expected_revision_id": <hash>, "operations": [{"op": "apply_motion", "entity_id": <uuid>, "motion_id": "walk-20"}]}` where `walk-20.npz` has `fps.npy = 20`.
  - `motion_count = 1` → `_require_plan_fps_agrees` runs (`:2185-2192`): rates = `[("motion walk-20", 20)]` → single rate → passes (`:1386-1387`).
  - `_apply_motion` bakes keys at scene frames `1..frame_count` and sets `scene.render.fps = 20`, `fps_base = 1.0` (`:1501, 1523-1524, 1689-1690`).
- Call 2 — plan B: `{"operations": [{"op": "set_render_settings", "fps": 30}]}` (no apply_motion).
  - `motion_count = 0` → the gate at `:2185` skips `_require_plan_fps_agrees` entirely. Even if it ran, the check has no scene input and would see a single rate (30) and pass.
  - `_set_render_settings` writes `render.fps = 30`, `fps_base = 1.0` (`:719-721`).
- Result: the same baked action (keys spaced one per npz frame, authored for 20 fps timing) now plays at 30 fps. Wall-clock duration shrinks from `frame_count/20` s to `frame_count/30` s — 50% fast. (The docstring's canonical example is 20→24 = 20% fast, `:1374`; the mechanism is identical.) Note the same pair in ONE plan — `{apply_motion walk-20, set_render_settings fps:30}` — IS rejected (`APPLY_MOTION_FPS_CONFLICT`); only the split-across-two-calls form slips through, exactly as documented.

### 2.6 Is anything currently blocking the gap? `cclay.motion_fps` read-backs

Verdict: **nothing blocks it.** The check is within-plan only (docstring `:1371`), the executor keeps no cross-call rate state, and no code consults a previously baked action's fps when validating a later plan. A repo-wide search for `cclay.motion_fps` finds:

- Writer: `stage_scene.py:1503` (`action["cclay.motion_fps"] = fps`) and the docstring mention `:1376`.
- The only read-back in production code: `constraint_capture.base_clip_of` at `constraint_capture.py:621-622` (`frame_count = int(action["cclay.motion_frames"]); fps = int(action["cclay.motion_fps"])`), used to return the clip metadata for regeneration/pose-capture. That fps is compared against the npz's native fps on the pose-capture path (`constraint_capture.py:1218-1225`, `BASE_MOTION_MISMATCH`: "base archive fps {fps} differs from the applied clip fps {clip['fps']}") — this guards regeneration, not the scene playback rate.
- Fixtures that synthesize actions also write it (`blender-addon/tests/fixtures/*`, e.g. `ardy_rig_scaffold.py:126`, `regenerate_request_fixture.py:107`).

So `cclay.motion_fps` is read back exactly once in the shipped add-on (regeneration metadata), never by any fps-enforcement path. Nothing in `packages/director-runtime` or `packages/blender-tools` re-checks fps across stage_scene calls (search for `fps` there finds only display strings, `inspect-summary.ts:98`, and the archive `fps.npy` scalar validation `ardy-archive-service.ts:290-291`).

## 3. Resampling: none — and everything it would have to move

There is no resampling anywhere in the bake path. "apply_motion bakes exactly one npz frame per scene frame" (`stage_scene.py:1350`); `dense_frames = [start_frame + offset for offset in range(frame_count)]` (`:1524`); the only rate logic is the fps write at `:1689-1690` and the within-plan conflict check. The docstring defers the alternative contract explicitly (`:1366-1369`): "Resampling key spacing by scene_fps/motion_fps is the other possible contract and is deliberately deferred rather than half-done — it would have to move hand_track clip frames, start_frame, contact windows and camera cut frames together." Each of those four is real, verified:

- **hand_track clip frames**: `hand_shapes.resolve_hand_track` docstring — "Frames are 0-based CLIP frames — the same space as `preflight_motion` contact windows and the ARDY constraint targets" (`hand_shapes.py:84-88`); keys are validated against `0..frame_count-1` (`:127-131`) and baked at scene frames `start_frame + frame` (`stage_scene.py:1637`). If key spacing changed, these offsets would shift relative to wall-clock time.
- **start_frame**: plan field, default 1 (`stage_scene.py:1501`, bounds `:260-261`), recorded on the action (`:1506`) and consumed by the downstream conversion `clip_frame = scene_frame - start_frame` (`:1504-1505`; `motion_constraints.scene_frame_to_clip_frame`, `motion_constraints.py:275-297`; callers `constraint_capture.py:533, 549, 569`).
- **contact windows**: `motion_preflight._contact_windows` emits `{"start_frame", "end_frame", "height"}` with `start_frame`/`end_frame` as 0-based indices into the npz `posed_joints` track (`motion_preflight.py:125-169`, especially `:164-168`); wire schema `packages/blender-protocol/src/motion-preflight.ts:106`. Same clip-frame space as hand_track (per the `hand_shapes.py:84-88` statement).
- **camera cut frames**: camera plan keyframes carry `transition: "smooth" | "cut"` (`camera_action.py:92-96`, `packages/blender-protocol/src/camera-plan.ts:28`); a cut gets CONSTANT interpolation at its scene-frame position (`camera_action.py:120-124`) and a `CUT_<frame>` timeline marker at that scene frame (`camera_plan.py:678-682`). Cut frames are authored in scene frames and validated against directing-evidence samples at `keyframe.frame - 1`/`keyframe.frame` (`camera-plan.ts:156-160`, `camera_plan.py:135-140`), so changing the scene rate (and thus which scene frame a given wall-clock instant lands on) would require moving them.

## 4. `start_frame`, contact windows, `hand_track`: whose frame numbering

- **`start_frame` — scene frames.** A plan-level `apply_motion` field (`stage_scene.py:49-52`), integer `-100000..100000` (`:260-261`, `stage-scene.ts:83`), default 1 (`:1501`). It is the scene frame of npz frame 0; npz frame i lands at scene frame `start_frame + i` (`:1524`). It is persisted on the action (`cclay.motion_start_frame`, `:1506`) and is the reference for every downstream clip conversion (`clip_frame = scene_frame - start_frame`, `motion_constraints.py:275-297`, `constraint_capture.py:533/549/569`; `_resolve_start_frame` recovers it from the lowest key when absent, `constraint_capture.py:635-673`).
- **contact windows — 0-based npz clip frames.** `preflight_motion` reports `start_frame`/`end_frame` as indices into the npz track (`motion_preflight.py:125-169`), i.e. the ARDY motion-local frame (`motion_preflight.py:3-7`); the minimum window length is `max(2, fps // 10)` frames (`:137`). These are pre-apply measurements in the clip's own timebase.
- **`hand_track` — 0-based clip frames, converted to scene frames at bake time.** Keys are `{"frame": <clip frame>, "preset": <name>}` with clip frame in `0..frame_count-1`, strictly increasing, ≤ 32 keys (`hand_shapes.py:110-137`), at least one side (`:140-141`), presets from `PRESET_NAMES` (`:22-25`); the docstring pins them to the same space as contact windows and ARDY constraint targets (`:84-88`). At bake time they are placed at scene frames `start_frame + clip_frame` (`stage_scene.py:1637`), recorded on the action as clip-relative JSON (`:1513-1519`), and returned in the result as clip frames (`:1701-1707`). A tracked side's resting preset is its LAST key (`:1452-1454`).

## 5. Entity locking: `_require_owned_entity` and `cclay.locked_by_human`

`_require_owned_entity` (`stage_scene.py:309-317`) accepts exactly one kind of target: an object whose `cclay.entity_id` resolves in `bpy.data.objects` (`_entity`, `:269-277`) AND whose `cclay.owned_project_id` equals the current `project_id` (`_owned`, `:280-281`). Absence of the object → `STAGE_SCENE_TARGET_NOT_FOUND`; missing/wrong owner → `STAGE_SCENE_TARGET_NOT_CCLAY_OWNED`. `_apply_motion` additionally requires `type == "ARMATURE"` (`:1415-1418`) and unshared datablocks (`:1419`, `:320-337`). The only way an object acquires ownership is `add_character`/`_create_character` or `adopt_entity` (`_adopt_entity`, `:676-707`, stamps `cclay.owned_project_id`).

`cclay.locked_by_human` interaction with apply_motion: **none in code.** Repo-wide search finds exactly one write — the ownership-inversion migration `_migrate_foreign_objects` (`:540-552`), run as the first action of the first stage_scene call after `cclay.migration_version` falls behind `_MIGRATION_VERSION = 1` (phase `MIGRATE_FOREIGN_OBJECTS`, `:2233-2241`). It stamps `cclay.locked_by_human = True` on every object that is foreign per `_is_foreign_object` (`:286-288`: `cclay.owned_project_id != project_id`, absent counts as foreign), skipping library-linked objects (`:546-547`), and records the scene marker (`:551-552`). Consequences, all verified:

- `_apply_motion` never reads `cclay.locked_by_human`; the only gate is ownership. A migration-locked entity is by construction foreign, so it already fails `_require_owned_entity` — but for the ownership reason, not the lock flag.
- No enforcement read of `cclay.locked_by_human` exists anywhere in the current tree (searched with `gitignore: false`): `execute_blender_python` performs no lock check (`connection.py:2110-2215`), and its warning states plainly "Locked objects are not protected" (`execute_blender_python_warning.json:3`).
- No per-entity lock/unlock UI control exists in `ui_panel.py`; the only lock-related string there is the migration status label ("Migration: Foreign objects locked", `ui_panel.py:414-416`).
- `AGENTS.md:135` USED to document the invariant "The director may mutate any entity except one stamped `cclay.locked_by_human`". That sentence was struck on 2026-08-03 precisely because of the finding above: no code path enforced it. `AGENTS.md:135` now states enforcement by ownership alone and records that the property is written and never read, so it carries no authority and must not be described as a lock.
- Therefore a hypothetical human-locked-but-owned armature would still be a valid `apply_motion` target, and for migration-locked (foreign) entities the lock adds no rejection that ownership does not already provide.

## Open questions / unverified

- "ARDY Core is 20 fps" is now VERIFIED, not a docstring claim: the released config `nvidia/ARDY-Core-RP-20FPS-Horizon40` carries `fps: 20`, and all 20 staged npz on the GPU box are `fps=20 int64`. The runtime contract still only bounds fps to 1..240 (`motion_retarget.py:55`, `motion_archive.py:305-310`, `ardy-archive-service.ts:291`), and the apply path now rejects a later plan that would re-rate a live bake.
- `cclay.locked_by_human` enforcement: confirmed absent, and the doctrine was corrected to match rather than the code being changed to enforce it.
- Camera cut-frame semantics were verified only at the source level (`camera_action.py`, `camera_plan.py`, `camera-plan.ts`); no camera plan was applied to confirm behavior in a live scene.
- The fps-gap reproduction (section 2.5) is a code-reading result; per task constraints no Blender or test run was performed to execute it.
