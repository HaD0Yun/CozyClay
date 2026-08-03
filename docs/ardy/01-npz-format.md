# 01 — the ARDY npz motion format: what ARDY writes, what cclay reads

Summary: ARDY emits a plain numpy `.npz` (a ZIP archive whose members are per-key `.npy`
files) written by `np.savez(path, **arrays)` with nine members for the default "core" model:
`local_rot_mats` (F,27,3,3) float32, `global_rot_mats` (F,27,3,3) float32, `posed_joints`
(F,27,3) float32, `root_positions` (F,3) float32, `smooth_root_pos` (F,3) float32,
`foot_contacts` (F,4) bool, `global_root_heading` (F,2) float32, plus two scalars: `fps`
(int64, 20 for core) and `text` (unicode). The motion is Y-up, right-handed, in meters,
motion-local with frame-0 root at the origin facing +Z; the root translation is duplicated
as Hips joint 0 of `posed_joints` AND as the separate `root_positions` member, and the root
yaw is duplicated as `global_root_heading` AND as the Hips global rotation inside
`local_rot_mats[:, 0]`. cclay consumes the same file through a closed member allowlist:
exactly three members are required (`local_rot_mats`, `posed_joints`, `fps`) and six more
are validated-if-present, so every current ARDY member is either required or carried, and
any future ARDY member would be rejected until allowlisted.

## 1. Who serializes the file (ARDY side)

All three generation entry points end in the same writer:

- `save_motion_npz(path, motion_dict, fps, text)` does `arrays = {k: np.asarray(v) ...}`,
  then `arrays["fps"] = np.asarray(fps)`, `arrays["text"] = np.asarray(text)`, then
  `np.savez(path, **arrays)` — `remote:~/ardy/scripts/generate.py:159-165`; the cclay copies
  are byte-identical in behavior at `scripts/ardy/cclay_constrained_generate.py:250-257` and
  `scripts/ardy/cclay_sequence_generate.py:192-197` (verified: local copies are identical to
  the deployed ones on the box). `np.savez` means the archive is a ZIP of one `.npy` member
  per key (that is why cclay's reader parses it with `zipfile` + per-member NPY headers,
  `blender-addon/cclay/motion_archive.py:171-311`).

- The `motion_dict` itself is produced by `model.motion_rep.inverse(motion, is_normalized=True)`
  (`remote:~/ardy/scripts/generate.py:263`), whose output dict is exactly
  `{local_rot_mats, global_rot_mats, posed_joints, root_positions, smooth_root_pos,
  foot_contacts, global_root_heading}`
  (`remote:~/ardy/ardy/motion_rep/reps/ardy_motionrep.py:271-282`). Details:
  - `local_rot_mats = global_rots_to_local_rots(global_rot_mats, skeleton)` — parent-relative
    rotations (Hips has no parent, so its local rotation IS the global root rotation)
    (`remote:~/ardy/ardy/motion_rep/reps/ardy_motionrep.py:262`; skeleton `root_idx == 0`
    asserted at `:50`; FK treats joint 0 as parentless, `remote:~/ardy/ardy/skeleton/kinematics.py:15-62`).
  - `posed_joints` comes from `fk(local_rot_mats, root_positions, skeleton)`, i.e. root
    translation is ADDED to the FK result, so `posed_joints[..., 0, :] == root_positions`
    (Hips = joint 0) (`remote:~/ardy/ardy/motion_rep/reps/ardy_motionrep.py:264-265`,
    `remote:~/ardy/ardy/skeleton/kinematics.py:61-62`).
  - `smooth_root_pos` is written as the same tensor as `root_positions`
    (`remote:~/ardy/ardy/motion_rep/reps/ardy_motionrep.py:276`).
  - `foot_contacts = foot_contacts > 0.5` — boolean threshold of the decoded contact channel
    (`remote:~/ardy/ardy/motion_rep/reps/ardy_motionrep.py:277`).

- Motion post-processing (`post_process_motion`) replaces `local_rot_mats`,
  `root_positions`, `posed_joints`, `global_rot_mats` in place
  (`remote:~/ardy/ardy/postprocess.py:339-344`, applied via `output.update(corrected)` at
  `remote:~/ardy/scripts/generate.py:267-275`). It does NOT touch `smooth_root_pos`, so after
  post-processing `smooth_root_pos` is the pre-correction root trajectory and may differ from
  `root_positions` (observed: max abs diff 0.129 m, mean 0.038 m, in
  `outputs/cclay/a-person-steadily-walks-up-a-curving-fli-0726010506-base.npz` on the box).
  Post-processing runs for core and soma, not g1
  (`remote:~/ardy/scripts/generate.py:266`, same gate in both cclay scripts:
  `scripts/ardy/cclay_constrained_generate.py:1065-1078`, `scripts/ardy/cclay_sequence_generate.py:390-399`).

- SOMA models convert the dict to the 77-joint skeleton before saving: `local_rot_mats`
  expands to 77 joints, FK re-runs for `global_rot_mats`/`posed_joints`, and `foot_contacts`
  expands 4 -> 6 channels (`[L_heel, L_toe, L_toe_end, R_heel, R_toe, R_toe_end]`)
  (`remote:~/ardy/ardy/skeleton/definitions.py:264-284`; triggered at
  `remote:~/ardy/scripts/generate.py:278-279`).

- `to_numpy` converts tensors via `obj.cpu().numpy()`, preserving dtype
  (`remote:~/ardy/ardy/tools.py:204-211`); the model runs float32, which is what lands in the
  npz (observed). With `--num_samples N > 1` the batch dimension is dropped per sample and
  files are written as `<stem>_00.npz`, `<stem>_01.npz`, ... (`remote:~/ardy/scripts/generate.py:283-301`).

## 2. Key-by-key on-disk format (observed + code)

Observed on the box, `outputs/cclay/x-0725195207.npz` and
`outputs/omb/seq-acceptance.npz` (read with numpy; keys/shapes/dtypes):

| key | shape | dtype | observed value / units | code source |
|---|---|---|---|---|
| `local_rot_mats` | (F, 27, 3, 3) | float32 | row-major 3x3 rotation matrices, parent-relative; F = frame count (observed F: 1, 120, 140, 160, 220, 240 across staged files) | `ardy_motionrep.py:272` |
| `global_rot_mats` | (F, 27, 3, 3) | float32 | same as above but world-space | `ardy_motionrep.py:273` |
| `posed_joints` | (F, 27, 3) | float32 | global joint CENTER positions, meters; `[..., 0, :]` == `root_positions` | `ardy_motionrep.py:274`; hip y ≈ 0.93-0.97 m standing |
| `root_positions` | (F, 3) | float32 | Hips translation, meters (x, y, z) | `ardy_motionrep.py:275`; frame0 ≈ (0, 0.93, 0) |
| `smooth_root_pos` | (F, 3) | float32 | alias of root_positions pre-postprocess | `ardy_motionrep.py:276` |
| `foot_contacts` | (F, 4) | bool | [left heel, left toe, right heel, right toe] | `ardy_motionrep.py:277`; channel order per `motion_rep/feet.py:24-25,52` |
| `global_root_heading` | (F, 2) | float32 | (cos θ, sin θ) of root yaw; dimensionless | `ardy_motionrep.py:278`; θ=0 means facing +Z |
| `fps` | () | int64 | 20 (core) | `generate.py:162` + `generate.py:189` |
| `text` | () | unicode `<UN` | the prompt | `generate.py:163`; e.g. `<U169` for a 169-char prompt |

F (frame count) = `int(duration_seconds * fps)` (floor) in `scripts/generate.py`
(`remote:~/ardy/scripts/generate.py:190`) and `cclay_constrained_generate.py`
(`scripts/ardy/cclay_constrained_generate.py:976`). The sequence script rounds per segment
instead: `n = max(1, int(round(seconds * fps)))` (`scripts/ardy/cclay_sequence_generate.py:295`).

Historical variant: some staged files carry only `{local_rot_mats, posed_joints, fps}`
(observed: `outputs/cclay/probe-base.npz` (F=220) and
`regenerate-0728204950-pose-cclay-pose-50c7cf4fcdfc4dd3-f55.npz` (F=1)). These are old
probe/pose-transfer artifacts; they still satisfy cclay's required-member set. Also observed:
several files under `outputs/cclay/` (the `num-samples-4-*`, `a-num-samples-4-*`, `x-07...`
series) fail `numpy.load` with "No data left in file" — truncated uploads, not format
variants; do not treat them as evidence of the format.

## 3. Frame rate ARDY natively emits

Where it is set/derived (not asserted):

- The runtime value is `fps = model.motion_rep.fps`
  (`remote:~/ardy/scripts/generate.py:189`; `scripts/ardy/cclay_constrained_generate.py:975`;
  `scripts/ardy/cclay_sequence_generate.py:260`). `model.motion_rep` is
  `denoiser.motion_rep` (`remote:~/ardy/ardy/model/ardy_model.py:61`), an
  `ArdyMotionRep` whose constructor stores the `fps` argument it receives
  (`remote:~/ardy/ardy/motion_rep/reps/base.py:32-37`).
- That argument comes from the released model's `config.yaml` via Hydra instantiation
  (`remote:~/ardy/ardy/model/load_model.py:223-248`). The released core config sets
  `motion_rep: {_target_: ardy.motion_rep.ArdyMotionRep, fps: 20, skeleton: ardy.skeleton.CoreSkeleton27}`
  in both the autoencoder and denoiser sections — verified by fetching
  `https://huggingface.co/nvidia/ARDY-Core-RP-20FPS-Horizon40/raw/main/config.yaml` (fps: 20).
- The model FOLDER names encode the fps by convention: `MODELS_BY_SKELETON` maps core ->
  `ARDY-Core-RP-20FPS-Horizon40`/`...-Horizon8` and g1 -> `ARDY-G1-RP-25FPS-Horizon52`/
  `...-Horizon8` (`remote:~/ardy/ardy/model/registry.py:23-30`); `DEFAULT_MODEL = "core"`
  (`remote:~/ardy/ardy/model/registry.py:46`); a released-style name parses as
  `ardy-(core|g1|soma)-.*horizon(\d+)` (`remote:~/ardy/ardy/model/registry.py:57-64`).
- The g1 config confirms `fps: 25` (fetched from `nvidia/ARDY-G1-RP-25FPS-Horizon52`).
  SOMA is referenced in the registry docstring as `ARDY-SOMA-RP-30FPS-Horizon60` but is NOT
  among the released models (HF API lists only the four core/g1 repos; a bare `soma` nickname
  is not in `MODELS` — `registry.py:23-44` — so it only resolves against a local
  `checkpoints_dir` folder).
- Observed in every readable staged npz on the box: `fps` = 20, dtype int64 (20 staged files
  checked: 12 under `outputs/cclay/`, 8 under `outputs/omb/` and `outputs/`; every one also
  carries the full 9-key member set).

Verdict on the cclay claim: `blender-addon/cclay/stage_scene.py:1350-1351` states
"apply_motion bakes exactly one npz frame per scene frame, so the scene rate IS the motion
rate -- ARDY Core is 20 fps." The "ARDY Core is 20 fps" part is VERIFIED for the default
core model (config `fps: 20`, folder name `20FPS`, observed npz `fps` = 20). It is not a
universal ARDY constant: g1 is 25 fps (config + folder name) and a hypothetical soma would
be 30 fps. cclay's own reader does not require 20 — it accepts any integer fps in 1..240
(`blender-addon/cclay/motion_retarget.py:55,248-253`) — but `apply_motion` sets
`scene.render.fps = fps` and `fps_base = 1.0` so the scene plays at the npz's native rate
(`blender-addon/cclay/stage_scene.py:1686-1690`), and `_require_plan_fps_agrees` forces one
rate across a plan (`blender-addon/cclay/stage_scene.py:1347-1405`). The stage_scene comment
at 1354-1355 ("Render-last left 20 fps keys playing at 24") is consistent: Blender's
factory scene is 24 fps (`stage_scene.py:1364-1365`).

## 4. Coordinate convention

- Up axis: Y. Evidence: the foot-contact heuristic reads height from axis index 1
  (`remote:~/ardy/ardy/motion_rep/feet.py:37,45`); cclay hard-rejects any motion whose
  frame-0 Hips is not +Y dominant ("motion is not Y-up",
  `blender-addon/cclay/motion_retarget.py:318-326` and the vectorized twin at
  `blender-addon/cclay/motion_preflight.py:437-447`); `motion_preflight.UP_AXIS = 1` with the
  axis-mapping evidence chain in its module docstring
  (`blender-addon/cclay/motion_preflight.py:9-22,58-61`). The skeleton T-pose (`joints.p`
  for cskel27) puts the feet at y = -0.954 relative to Hips at origin (measured on the box),
  and generated motions put standing Hips at y ≈ 0.93-0.97 m with foot joints near y ≈ 0
  (measured), so the height axis points up and the unit is meters. Meters also hold up
  cross-checked: the frame-0 thigh length (RightUpLeg 19 -> RightLeg 20) measures ≈ 0.456 m
  in the npz (measured), a realistic human thigh.
- Handedness and facing: right-handed Y-up with +Z forward. The model is generated with
  `first_heading_angle = torch.zeros(...)  # facing +Z`
  (`remote:~/ardy/scripts/generate.py:240`; both cclay scripts pass `torch.zeros(1, ...)`,
  `scripts/ardy/cclay_constrained_generate.py:1058`, `cclay_sequence_generate.py:322`).
  Heading is `atan2(diff_z, -diff_x)` over the right-minus-left hip vector
  (`remote:~/ardy/ardy/motion_rep/tools.py:114-129`), so heading 0 = facing +Z; measured
  frame-0 headings on staged clips are ≈ 0 (within 1 deg) and "runs forward" clips travel
  +Z-dominant (e.g. 7.04 m z vs -0.79 m x over 160 frames, measured on
  `outputs/omb/a-person-runs-forward-0722151659.npz`). In the T-pose the left foot sits at
  x = +0.095, the right at x = -0.095 (measured from `joints.p`), i.e. +X is the character's
  left — consistent with a right-handed Y-up system where the character faces +Z.
- Root motion is NOT separate from joint positions: `posed_joints` includes the root as Hips
  (joint 0), so every joint (including the root) is a world position per frame
  (`remote:~/ardy/ardy/motion_rep/reps/ardy_motionrep.py:264-265`); the same root translation
  is additionally written standalone as `root_positions`, and the root yaw is written
  standalone as `global_root_heading` (cos θ, sin θ) while also living implicitly in
  `local_rot_mats[:, 0]` (Hips global rotation). Blender retargeting consumes the root from
  `posed_joints[frame][JOINT_INDEX["Hips"]]`, not from `root_positions`
  (`blender-addon/cclay/motion_retarget.py:436-442`).
- Motion-local origin: the frame-0 root x/z is ≈ 0 (e.g. (2.1e-05, 0.966, 6e-05) in
  `outputs/cclay/x-0725195207.npz`); cclay treats the npz as "motion-local" and converts to
  Blender world with the character placement
  (`blender-addon/cclay/motion_preflight.py:5-7`). World y at frame 0 is the hip height, not
  0 (the ground is not stored anywhere in the file).

## 5. What cclay requires when reading the same file

Archive boundary (`blender-addon/cclay/motion_archive.py`), used by both
`preflight_motion` (`motion_preflight.py:484-508`) and `apply_motion`
(`stage_scene.py:1429-1431`):

- Required members: `local_rot_mats.npy`, `posed_joints.npy`, `fps.npy`
  (`motion_archive.py:41-45`). Optional-but-allowlisted: `foot_contacts.npy` bool (F,4),
  `global_rot_mats.npy` f (F,27,3,3), `global_root_heading.npy` f (F,2),
  `root_positions.npy` f (F,3), `smooth_root_pos.npy` f (F,3), `text.npy` U scalar
  (`motion_archive.py:55-62`). The member-name set is CLOSED: unknown members are rejected
  (`motion_archive.py:179-181`).
- Shape pins: `local_rot_mats` exactly (F,27,3,3) with 1 <= F <= 24_000, `posed_joints`
  exactly (F,27,3) with the same F (`motion_archive.py:218-229`); every optional member's
  shape is frame-locked to F (`motion_archive.py:268-283`). Dtype rules: real numeric
  (i/u 1/2/4/8 or f 2/4/8), bool only for foot_contacts, unicode only for text; C order only;
  NPY header size <= 16 KiB; archive <= 64 MiB, uncompressed payload <= 96 MiB
  (`motion_archive.py:38-40,139-165,218-283`; payload cap also enforced by
  `MotionValidationCursor`, `motion_retarget.py:56,269-272`).
- `fps.npy` must be a non-boolean integral scalar whose value lies in `FPS_BOUNDS = (1, 240)`
  (`motion_archive.py:242-251,305-310`; `motion_retarget.py:55`).

Frame/content validation (`blender-addon/cclay/motion_retarget.py`):

- `MAX_FRAMES = 24_000` — "20 minutes at 20 fps" (`motion_retarget.py:54`).
- `MotionValidationCursor` (motion_retarget.py:244-333): fps must be an integer in 1..240
  (`:248-253`); per frame, every component of every 3x3 matrix and every joint position must
  be finite (`:302-314`); each matrix must be a proper rotation within
  `ROTATION_MATRIX_TOLERANCE = 1e-3` on row/column squared norms, pairwise dots, and
  determinant ≈ +1 (`:154-186`; comment at `:58-61`: 1e-3 "comfortably covers float32 ARDY
  serialization noise"); at the end, frame-0 Hips must be +Y dominant (`:317-326`).
- `derive_scale(posed_joints[0], rig_thigh_length)` returns meters-per-npz-unit =
  rig thigh / npz thigh, using the frame-0 RightUpLeg->RightLeg vector
  (`motion_retarget.py:347-359`). Preflight folds in the armature object's uniform world
  scale before deriving (`motion_preflight.py:371-398`); a reported sample scale ≈ 98.5x
  error from a 0.01 object scale is documented as the bug this fixes (`motion_preflight.py:345-352`).

Preflight analysis (`blender-addon/cclay/motion_preflight.py`):

- Assumes UP_AXIS = 1, HORIZONTAL_AXES = (0, 2), ROOT_JOINT_INDEX = 0
  (`motion_preflight.py:58-63`); all measurements come from `posed_joints` in the
  motion-local frame (`motion_preflight.py:5-7`).
- `FOOT_CONTACT_CHANNELS` maps the 4 npz channels to joints
  [(left_heel, LeftFoot), (left_toe, LeftToeBase), (right_heel, RightFoot),
  (right_toe, RightToeBase)] and ASSERTS the joint indices equal (25, 26, 21, 22)
  (`motion_preflight.py:80-89`), i.e. a skeleton reorder fails loudly.
- Contact tolerances apply after scaling and are sized for 20 fps
  (`motion_preflight.py:65-73`: "at the 20 fps ARDY target this allows up to 0.2 units/s of
  drift"). `foot_contacts` is optional: "motions staged before the carried-member contract
  have no such array (measured: 27 of 43 staged npz)" (`motion_preflight.py:251-256`).
- Preflight runs `_validate_arrays_vectorized` (numpy gram/det check, `motion_preflight.py:401-448`)
  because the cursor's pure-python pass over a maximal 24000x27 payload costs 15-35 s
  (`motion_preflight.py:453-458`).

Bake-time rate contract (`blender-addon/cclay/stage_scene.py`):

- `apply_motion` bakes one npz frame per scene frame at the npz's native fps
  (`stage_scene.py:1350-1351,1686-1690`), records `cclay.motion_fps` on the action
  (`stage_scene.py:1503`), and `_require_plan_fps_agrees` rejects plans whose
  `set_render_settings` fps or second motion disagree (`stage_scene.py:1347-1405`).

The host-side write validator (TS) enforces a subset at ingestion time (fps integer 1..240,
finite floats in `posed_joints`/`local_rot_mats`, frame-0 Hips +Y dominant, member
allowlist/shapes) — documented with citations in `docs/ardy/04-cclay-ingestion.md:17-63`.

## 6. Field-by-field comparison: ARDY emits X <-> cclay expects Y

| npz member | ARDY emits (code + observed) | cclay expects | verdict |
|---|---|---|---|
| `local_rot_mats` | (F,27,3,3) float32, parent-relative rotation matrices | (F,27,3,3), any real numeric dtype, F in 1..24000, C order, finite, orthonormal within 1e-3, det +1 | AGREE (float32 passes; tolerance explicitly sized for float32 noise, motion_retarget.py:58-61) |
| `posed_joints` | (F,27,3) float32, meters, joint centers, Hips=joint 0 | (F,27,3) same F, real numeric, finite, frame-0 Hips +Y dominant | AGREE |
| `global_rot_mats` | (F,27,3,3) float32 | allowlisted as (F,27,3,3) float, not consumed by bake (carried only) | AGREE (carried; `load_motion_payload` materializes only requested members, motion_archive.py:374-379) |
| `root_positions` | (F,3) float32, Hips translation | allowlisted as (F,3) float; bake reads the root from `posed_joints` instead | AGREE (present + allowlisted; reader prefers posed_joints) |
| `smooth_root_pos` | (F,3) float32; == root_positions pre-postprocess, may differ after (observed 0.129 m max diff) | allowlisted as (F,3) float | AGREE (allowlisted; nobody consumes it today) |
| `foot_contacts` | (F,4) bool, [L_heel, L_toe, R_heel, R_toe] | (F,4) bool, channel order asserted to joints (25,26,21,22) | AGREE (observed bool arrays match; the 0.5 threshold, ardy_motionrep.py:277, is baked at write time) |
| `global_root_heading` | (F,2) float32 (cos θ, sin θ) | allowlisted as (F,2) float | AGREE (carried; unused by bake) |
| `fps` | int64 scalar, 20 (core) | integral scalar in 1..240; scene rate forced equal by plan gate | AGREE for core; cclay never hard-requires 20 |
| `text` | unicode scalar (`<UN`) | allowlisted U scalar | AGREE (carried) |
| joint layout | 27-joint cskel27 order pinned by `CSKEL27_JOINTS` == definitions.py bone order | hard shape (F,27,3,3); order assumed = cskel27 (comment motion_retarget.py:22-23) | AGREE for core; no explicit joint-name check in the reader (foot-channel indices asserted only in preflight) |
| g1 skeleton npz | would be (F,34,...) 34 joints, fps 25 | requires 27 joints | DISAGREE — a g1 npz fails `motion_archive` shape pin (motion_archive.py:218-229); cclay is core-only by design |
| soma skeleton npz | 77 joints, foot_contacts (F,6) after `output_to_SOMASkeleton77` (definitions.py:264-284) | requires 27 joints and (F,4) contacts | DISAGREE — 77-joint npz fails the same pins; (F,6) contacts also fail the (F,4) pin |
| 3-key historical variant | only local_rot_mats/posed_joints/fps (probe files) | exactly the required set | AGREE (valid cclay archive) |
| unknown extra members | any future ARDY member | rejected (closed allowlist, motion_archive.py:179-181) | UNVERIFIED as a live case — would be a hard failure until allowlisted |

## 7. Open questions / unverified

- No g1 (34-joint) or soma (77-joint) npz exists on the box and generating one is forbidden,
  so the g1/soma rows above are code-derived only: g1 fps=25 confirmed from the HF config,
  but the on-disk g1/soma npz key set, shapes, and dtypes are UNVERIFIED against a real file.
- `outputs/cclay/` contains several npz that fail `numpy.load` ("No data left in file") —
  truncated uploads. Whether the truncation happened on the box or during a past sync is
  UNVERIFIED; none of them can be used as format evidence.
- The `smooth_root_pos` divergence after post-processing is observed in exactly two staged
  files (max 0.129 m); the magnitude of root correction depends on `--root-margin`
  (default 0.04 m, `scripts/ardy/cclay_constrained_generate.py:214-222`) and whether
  contacts were constrained, so the observed value is a sample, not a bound.
- `fps` in the npz is written via `np.asarray(fps)` where `fps = model.motion_rep.fps`; the
  released config declares `fps: 20` as an int, but whether Hydra delivers a Python int or
  float is what makes the observed npz int64. All 20 observed files show int64; a float
  config value would still pass cclay's integral-scalar pin only if it converted to int64
  with a fractional part of 0 (np.asarray(20.0) is float64 and would be REJECTED by
  motion_archive.py:242-251) — UNVERIFIED that no float-fps variant exists.
- The exact row-majorness of the stored 3x3 matrices is inferred from cclay's
  `_mat_to_quat` ("Row-major 3x3 rotation matrix", motion_retarget.py:189-190) and the
  validation passing on staged data; no ARDY-side doc statement of storage order was found.
- Whether the model's frame-0 canonical heading is exactly 0 in every clip: measured ≈ 0
  within 1 deg on two staged clips and the code passes `first_heading_angle = 0`, but the
  older `omb_sequence_generate.py`-era file (0722 dates) showed the raw feature heading at
  ≈ -0.1 deg; the invariant is "approximately facing +Z", not proven bit-exact.
