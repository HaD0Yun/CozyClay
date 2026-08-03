# ARDY generation API: what cclay drives, end to end

Summary: cclay drives ARDY generation exclusively over ssh on the pinned upstream commit
`693f74d13b3d04a0a22ce127ee79c929dd89756b` (`scripts/ardy/UPSTREAM_BASE`; box HEAD verified
identical). Three modes exist, all through the bash wrapper `scripts/cclay-ardy-generate`:
(1) plain text-to-motion against upstream's own `remote:~/ardy/scripts/generate.py`, (2) a
constrained pass against `scripts/ardy/cclay_constrained_generate.py` (synced to the box by scp
before every run), and (3) a segment-chained autoregressive rollout against
`scripts/ardy/cclay_sequence_generate.py` (also scp-synced). The wrapper never selects a model:
all three entry points run ARDY Core (`DEFAULT_MODEL = "core"`, `remote:~/ardy/ardy/model/registry.py:46`),
which is 20 fps with a 40-frame horizon and 4 frames per token, so the wrapper's hardcoded
`int(duration * 20)` frame bound and the box's `int(duration * fps)` agree exactly. Post-processing
(foot-contact stabilization and root correction) is ARDY's own compiled `motion_correction`
pipeline, and both `--contact-threshold` and `--root-margin` are passed through to it only in the
constrained mode. A full CLI survey found `--contact-threshold` to be effectively inert in this
pipeline (see section 6) and the two cclay scripts byte-identical between repo and box (see
section 7). Everything below is grounded in source; "comment claims" are labeled as such.

## 1. Remote CLI: `scripts/generate.py` (upstream-owned)

`remote:~/ardy/scripts/generate.py` (320 lines) is upstream ARDY's CLI; the wrapper calls it only
in plain mode (`scripts/cclay-ardy-generate:505-508`) and never syncs it (it is not a cclay file).
Its full flag surface, from `parse_args` (`remote:~/ardy/scripts/generate.py:31-105`):

| flag | type | default | accepted range | enforced where |
|---|---|---|---|---|
| `prompt` (positional) | str | — (required) | non-empty after strip | `generate.py:167-169` (`text = args.prompt.strip()`; empty prompt silently generates from `""`) |
| `--model` | str | `DEFAULT_MODEL` = `"core"` | nickname `core`/`core8`/`core40`/`g1`/`g18`/`g152`, released folder name, or folder under `CHECKPOINTS_DIR` (`remote:~/ardy/ardy/model/registry.py:17-24,89-99`); `soma` appears in help text but has no registry entry at this commit | `resolve_model_name` (`registry.py:89-99`) |
| `--duration` | float | `5.0` | `> 0` de facto (`num_frames = int(duration * fps)`, `generate.py:191`); no upper bound in `generate.py` itself | none in `generate.py`; wrapper caps `0 < d <= 1200` (`scripts/cclay-ardy-generate:261-264`) |
| `--num_samples` | int | `1` | `>= 1` (`generate.py:170-172`) | `generate.py:170-172` |
| `--diffusion_steps` | int | `None` → model `num_base_steps` | `1 .. num_base_steps` (`generate.py:196-201`) | `generate.py:196-201` |
| `--constraints` | str (path to saved constraint-list JSON) | `None` | loaded via `load_constraints_lst` (`generate.py:217-219`); every frame index must be `< num_frames` (`generate.py:225-231`) | `generate.py:217-231`; not used by the cclay wrapper at all |
| `--output` | str | `"output"` | any path; bare names land under `outputs/` (`_resolve_output_base`); `.npz` appended if missing (`generate.py:285,159-164`) | `generate.py:113-157` |
| `--history_frames` | int | `None` → `_default_history_frames` | positive multiple of model `num_frames_per_token` (`generate.py:206-214`) | `generate.py:208-214` |
| `--no-postprocess` | store_true | off | — | skips `post_process_motion` (`generate.py:266-274`) |
| `--seed` | int | `None` | any int (`seed_everything`, `generate.py:233`); wrapper only admits non-negative (`scripts/cclay-ardy-generate:105-107`) | argparse int conversion; no range check |
| `--cfg_weight` | float, `nargs="+"` | `[2.0, 2.0]` | exactly 1 or 2 values (`generate.py:174-179`); no numeric bound anywhere | `generate.py:174-179` |
| `--checkpoints_dir` | str | `None` | falls back to env `CHECKPOINTS_DIR` (`generate.py:182-183`) | — |

Runtime facts (all verified): `fps = model.motion_rep.fps` (`generate.py:190`), `num_frames =
int(args.duration * fps)` (`generate.py:191`). For the Core model actually used, the released
config (`remote:~/ardy config.yaml`, HF snapshot of `ARDY-Core-RP-20FPS-Horizon40`) sets
`fps: 20` (config.yaml:13,45), `gen_horizon_len: 40` (config.yaml:4), `num_frames_per_token: 4`
(config.yaml:25,40), skeleton `ardy.skeleton.CoreSkeleton27` (config.yaml:16,48). `CoreSkeleton27`
has 27 joints with root `Hips` (`remote:~/ardy/ardy/skeleton/definitions.py:338-339`).
`first_heading_angle` is zeros → the character starts facing +Z (`generate.py:240`).
Post-process runs unless the model name contains `"g1"` or `--no-postprocess` was given
(`generate.py:266`). A `SOMASkeleton30` skeleton is converted to SOMASkeleton77 before save
(`generate.py:276-278`); the Core path does not convert. `--model g1` additionally writes a MuJoCo
qpos CSV next to the npz (`generate.py:305-317`).

`save_motion_npz` writes every motion-dict array plus `fps` (scalar) and `text` (the prompt)
(`generate.py:159-164`). Observed npz layout on the box (read-only inspection of
`outputs/forward_roll_slip.npz`, `outputs/omb-smoke.npz`, `outputs/cclay/probe-constrained.npz`):
`local_rot_mats (F,27,3,3) f32`, `global_rot_mats (F,27,3,3)`, `posed_joints (F,27,3)`,
`root_positions (F,3)`, `smooth_root_pos (F,3)`, `foot_contacts (F,4) bool`,
`global_root_heading (F,2)`, `fps () i64`, `text () str`.

## 2. Constrained entry point: `scripts/ardy/cclay_constrained_generate.py`

CozyClay-owned (GPL-3.0-or-later header, `scripts/ardy/cclay_constrained_generate.py:1-6`); the
box copy at `remote:~/ardy/scripts/cclay_constrained_generate.py` is byte-identical (section 7).
Validation layers stay stdlib-importable; `torch`/`numpy`/`ardy` import lazily inside functions
(`:78-81`). Flags, from `parse_args` (`:105-230`):

| flag | type | default | range / notes | enforced where |
|---|---|---|---|---|
| `--prompt` | str | required | non-empty after strip (`:937-939`) | `main()` |
| `--duration` | float | required | `> 0` (`:940-941`); `num_frames = int(duration * fps)` (`:975-976`) must be `>= 3` (`:977-982`) | `main()` |
| `--base` | str | required | npz with `local_rot_mats` + `posed_joints`; base frames `>= num_frames` (`:603-616`) | `load_base_motion` |
| `--target` | str ×5, append | — | `FRAME JOINT X Y Z`; frame `0..num_frames-1` (`:428-438`); joint in `LeftFoot|RightFoot|LeftHand|RightHand` (`:410-413`); one target per (frame, joint) (`:414-418`) | `parse_targets` (`:404-425`) |
| `--target-orient` | str ×6, append | — | `FRAME JOINT QW QX QY QZ`; unit quaternion `abs(norm-1) <= 1e-3` and finite (`:479-485`); requires a `--target` at the same (frame, joint) (`:474-478`) | `parse_orientations` (`:448-488`) |
| `--pose-from` | str ×3, append | — | `SRC_NPZ SRC_FRAME DST_FRAME`; src npz must exist (`:498`), `SRC_FRAME >= 0` locally (`:506-507`), real range vs the npz's frame count checked at load (`:641-645`); DST_FRAME in clip (`:508`); one pose per dst frame (`:509-513`) | `parse_poses` (`:491-519`) + `load_poses` |
| `--root-2d` | str ×4, append | — | `FRAME X Z HEADING`; X/Z floats, HEADING radians float or literal `none` (`:536-539`); one per frame (`:530-533`); heading must be given for all waypoints or none (`:542-548`) | `parse_root_waypoints` (`:522-549`) |
| `--output` | str | `"output"` | bare names under `outputs/` (`:233-237`); `.npz` appended (`:240-247`) | `_resolve_output_base`/`_single_file_path` |
| `--model` | str | `None` → lazily `DEFAULT_MODEL` (`"core"`) | see `generate.py --model` | `resolve_model_name` (`:968-972`) |
| `--seed` | int | `None` | — | `seed_everything` (`:1050-1051`) |
| `--diffusion_steps` | int | `None` → `num_base_steps` | `1 .. num_base_steps` (`:999-1005`) | `main()` |
| `--cfg_weight` | float, `nargs="+"` | `[2.0, 2.0]` | exactly 1 (text) or 2 (text, constraint) values (`:952-957`); no numeric bound | `main()` |
| `--no-postprocess` | store_true | off | skips `post_process_motion` (`:1065`) | `main()` |
| `--contact-threshold` | float | `0.5` | strictly `(0, 1)` (`:942-946`) | `main()` (mirrored by wrapper, section 4) |
| `--root-margin` | float | `0.04` | `[0, 0.5]` (`:947-951`) | `main()` (mirrored by wrapper, section 4) |
| `--checkpoints_dir` | str | `None` | env `CHECKPOINTS_DIR` fallback (`:968`) | `main()` |

Constraint kinds and their encoding into the model call:

- Closed vocabulary `JOINT_TO_CONSTRAINT = ("LeftFoot", "RightFoot", "LeftHand", "RightHand")`
  (`:86`); each resolves to an ARDY constraint class whose `joint_names` is `[<effector>, "Hips"]`
  (`:89-102`).
- Position targets: for each target, the script takes the base pass's achieved joint position,
  then shifts the ROOT by `(requested - achieved)` — FK is root-translation-equivariant, so the
  named joint lands exactly on the target with the base pose preserved (`:687-694`). Constraints
  are grouped per joint into one `EndEffectorConstraintSet` per joint name with CPU-side
  `frame_indices` (`:700-731`); an optional orientation is spliced into only the named joint's
  global rotation, leaving the rest of the base pose's rotations intact (`:714-722`).
- `--target-orient` is converted with `_quaternion_matrix_rows` (normalizes first, active column
  form, `:552-572`) so any accepted quaternion yields an exactly rigid matrix.
- Full-body poses: `load_poses` runs FK on the source npz frame to get all 27 joints' global
  positions and rotations (`:620-655`), then a `FullBodyConstraintSet` pins the whole body at the
  dst frame (`:733-742`). Comment claim: the pose carries its own root, so pair it with
  `--root-2d` when placement matters (`:623-627`).
- Root waypoints: one `Root2DConstraintSet` holds all waypoints, with `root_2d` as (X, Z) pairs
  and `global_root_heading` either `None` (free heading) or a per-waypoint radians tensor
  (`:744-761`). ARDY converts heading radians to `[cos, sin]` inside `update_constraints`
  (`remote:~/ardy/ardy/constraints.py:58-81`).
- Encoding into the model: `model.motion_rep.create_conditions_from_constraints_batched(...,
  to_normalize=True)` turns the constraint list into `observed_motion` + `motion_mask`; exactly
  ONE `model(...)` sampling call follows, inlined so the exactly-once property is structural
  (`:1033-1063`, comment `:1042-1049`). `cfg_weight` is passed as a scalar or (text, constraint)
  tuple (`:952-957`, `:1061`).
- ARDY-side meaning of the classes: `EndEffectorConstraintSet.update_constraints` appends the
  effector's global positions and rotations (pairs via `create_pairs`) plus root `root_2d`,
  `root_y_pos`, and `global_root_heading` (`remote:~/ardy/ardy/constraints.py:279-315`).
  `expand_joint_names` maps the base EE name to the full foot/hand chain for positions but only
  the chain base for rotations, plus the pelvis (`remote:~/ardy/ardy/skeleton/base.py:130-167`).

Result JSON contract (final stdout line, `:1117-1142`): `target_space` (constant
`"skeleton_joint_center"`, `:1118`), `surface_contact_verified` (constant `False`, `:1119` —
hardcoded, not measured), `frames`, `fps`, `model`, `targets` (per-target `frame`, `joint`,
`requested`, `base`, `achieved`, `base_error_m`, `achieved_error_m`, `:903-913`), `residual`
(`max_error_m`, `mean_error_m`, `worst_frame`, `worst_joint`, `:919-926`), `orientations`
(`base_error_deg`/`achieved_error_deg` geodesic, `:783-790`), `poses` (root + shape errors vs the
unconstrained pair, `:838-854`), `waypoints` (horizontal `achieved_error_m` on XZ, `:870-878`),
`postprocess` (`None` for g1 or `--no-postprocess`, else `{contact_threshold, root_margin}`,
`:1128-1135`), `continuity` (`mean_jump_m`, `max_jump_m`, `max_jump_frame` from posed-joint L2
jumps, `:1116`, `:1136-1140`). Diverged clips (NaN/Inf in any array bound for the npz) are
rejected before measuring (`find_non_finite`, `:1096-1098`).

## 3. Sequence entry point: `scripts/ardy/cclay_sequence_generate.py`

CozyClay-owned, scp-synced like the constrained script. Flags (`:71-162`):

| flag | type | default | range / notes | enforced where |
|---|---|---|---|---|
| `--segment` | str ×2, append | required | `"PROMPT" SECONDS`, repeatable; seconds `> 0` (`:241-242`); per-segment frames `n = max(1, int(round(seconds * fps)))` (`:295`) must be `>= num_frames_per_token` (`:296-300`); chained segments must fit the 10 s trained window together with transition history (`:301-308`) | `main()` |
| `--output` | str | `"output"` | same as constrained | — |
| `--model` | str | `DEFAULT_MODEL` (imported eagerly, `:59`) | same registry as above | `resolve_model_name` (`:255-257`) |
| `--seed` | int | `None` | per-segment derived seeds `seed + 9973*seg + attempt` (`:357-358`, `_SEED_STRIDE = 9973` at `:68`) | `main()` |
| `--diffusion_steps` | int | `None` → `num_base_steps` | `1 .. num_base_steps` (`:265-271`) | `main()` |
| `--history_frames` | int | `None` → `_default_history_frames` (`:165-172`, longest history fitting the 10 s window) | positive multiple of token size (`:276-277`) | `main()` |
| `--transition_frames` | int | `None` → `max(patch, (int(0.6*fps)//patch)*patch)` (~0.6 s) | positive multiple of token size (`:282-283`) | `main()` |
| `--max_boundary_jump` | float | `0.08` | meters/frame continuity gate (`:129-137`) | `main()` (`:373`) |
| `--max_segment_attempts` | int | `6` | `>= 1` (`:251-252`); attempts per non-final segment (`:355`) | `main()` |
| `--cfg_weight` | float `nargs="+"` | `[2.0, 2.0]` | 1 or 2 values (`:245-250`) | `main()` |
| `--no-postprocess` | store_true | off | skips postprocess (`:390`) | `main()` |
| `--checkpoints_dir` | str | `None` | env fallback (`:255`) | `main()` |

Mechanics: one continuous autoregressive rollout; each subsequent segment feeds the previous
motion's tail (clamped to a token multiple) via `init_history_sequence` (`:314-337`, `:359-365`).
Non-final segments are regenerated (derived seeds) until their tail jump over the last
`patch + 1` frames is `<= --max_boundary_jump` or attempts are exhausted (`:351-383`); the final
segment is generated once (`:367-369`). One inverse + one postprocess over the whole rollout
(`:387-399`; `constraint_lst=None`, so no constraint masks — contacts only). Frame count must
equal the planned segment table (`:418-423`). Result JSON (`:424-437`): `frames`, `fps`, `model`,
`segments` (per-segment `prompt`, `requested_s`, `start_frame`, `end_frame`), `continuity`
(`mean_jump_m`, `max_jump_m`, `max_jump_frame`, `boundary_max_jump_m` = max jump within ±2 frames
of any boundary, `:206-224`), `boundary_gate` (`threshold_m`, `max_attempts`, `worst_tail_jump_m`,
`exhausted`).

## 4. Wrapper constraint vocabulary: `scripts/cclay-ardy-generate`

Everything the wrapper validates locally, before any ssh (header comment `:31-41`). The wrapper
uses the fixed 20 fps figure for clip frames because the box always runs Core
(`:38`, `:244-254`); the box's own bound is `num_frames = int(duration * fps)` with the loaded
model's fps — equal in practice.

| flag (wrapper) | meaning | units / space | valid range | enforced where |
|---|---|---|---|---|
| `--constrain <frame> <joint> <x> <y> <z>` | end-effector position target, ARDY `EndEffectorConstraintSet` | npz space: Y-up, meters, motion-local (header `:24-25`; help `:57`; script help `:127`); joint ∈ {LeftFoot, RightFoot, LeftHand, RightHand} | frame non-negative int `0 <= f < int(duration*20)` (`:117`, `:283-289`); x/y/z signed decimals (`:122-124`); joint from the closed 4-name set (`:118-121`) | local wrapper (`:115-129`, frame bound `:281-289`); remote re-checks everything (`parse_targets` `:404-425`) |
| `--constrain-orient <frame> <joint> <qw> <qx> <qy> <qz>` | joint's GLOBAL rotation at that frame, unit quaternion, spliced into the end-effector rotation only | npz space (Y-up), global (world) rotation; radians-free quaternion | `abs(norm - 1) <= 1e-3` and finite (`:148-161`); frame in clip (`:290-292`); must pair with a `--constrain` at the same (frame, joint) (`:307-325`) | local wrapper (awk mirror, `:148-161`; pairing `:307-325`); remote re-checks (`:479-485`, `:474-478`) |
| `--constrain-pose <src-motion-id> <src-frame> <dst-frame>` | copy the full 27-joint pose at `src-frame` of an already-staged motion onto `dst-frame` of the new clip (FullBodyConstraintSet) | src indexes the SOURCE npz (staged motion), dst indexes the clip | src-motion-id must match `^[a-z0-9][a-z0-9-]{0,63}$` (`:169`); src-frame non-negative int, real range vs the src npz checked ONLY remotely (`:170-174`); dst-frame in clip (`:296-298`); npz must exist locally (`:346`, `:375`) | local wrapper (grammar, dst bound, npz existence); remote (src-frame vs actual frame count, `:641-645`) |
| `--constrain-path <frame> <x> <z> <heading>` | root XZ waypoint (Root2DConstraintSet); Y not constrained | X/Z meters, motion-local; heading radians or literal `"none"` (free facing) | frame in clip (`:293-295`); x/z signed decimals (`:182-184`); heading number or `none` (`:185`); heading must be given for all waypoints or none (remote `:542-548`) | local wrapper (`:179-189`); remote re-checks (`:522-549`) |
| `--cfg-weight <text> <constraint>` | two classifier-free-guidance scales: text and constraint | unitless CFG scale | non-negative decimals (`:192-194`); exactly one occurrence (`:81-82`, `:195`); no lower/upper bound enforced anywhere | local wrapper regex only; remote accepts 1 or 2 floats with no numeric bound (`:952-957`) |
| `--contact-threshold T` | ARDY post-process foot-contact probability cut-off | probability | strictly `(0, 1)` | local wrapper awk (`:199-200`); remote `:942-946`; requires `--base-motion` (wrapper `:236-239`) |
| `--root-margin M` | ARDY post-process root-correction margin | meters | `[0, 0.5]` | local wrapper awk (`:205-206`); remote `:947-951`; requires `--base-motion` (wrapper `:240-243`) |

Additional wrapper-level rules: `--segment` and a positional prompt are mutually exclusive
(`:214-217`); constraints and `--segment` are mutually exclusive (`:224-227`); any constraint
requires `--base-motion` (`:228-231`); `--base-motion` alone is rejected (`:232-235`);
`--contact-threshold`/`--root-margin` require the constrained pass (`:236-243`); `--duration`
must satisfy `0 < d <= 1200` s (`:261-264`, tied to the add-on's 24000-frame motion cap at 20 fps)
and a constrained clip needs `>= 3` frames (`:266-280`). Frame bounds use `int(d * 20)` truncation
to match the box exactly (`:244-265`). The wrapper mirrors the remote unit-quaternion and
orientation-pairing checks locally so bad requests die before the model loads (`:140-147`,
`:299-306`).

## 5. The three generation modes and file movement

Dispatch order in the wrapper: constraint mode if any of the four constraint flags appear
(`:340`); segment mode if any `--segment` (`:447`); plain otherwise (`:502-554`).

Plain mode — remote `scripts/generate.py` (`:505-508`):
- in: nothing scp'd; the prompt travels over ssh stdin (`<<<"$PROMPT"` at `:508`, consumed by
  `"$(cat)"` at `:507`); args `--duration`, `--output outputs/cclay/<id>`, optional `--seed`
  (`:506-507`).
- out: `scp <host>:outputs/cclay/<id>.npz -> $PROJECT/.cclay/motions/<id>.npz` (`:513`); remote
  npz deleted after probing (`:547`).
- after download: a read-only probe on the box computes `frames` (from
  `local_rot_mats.shape[0]`), `fps`, and per-frame continuity (max posed-joint L2 displacement
  per frame, `mean_jump_m`/`max_jump_m`/`max_jump_frame`) (`:516-544`).
- printed JSON: `{motion_id, frames, fps, duration_s, path, continuity}` (`:553-554`).

Constrained mode — remote `scripts/cclay_constrained_generate.py` (`:340-445`):
- in (scp): the script itself to `$REMOTE_REPO/scripts/cclay_constrained_generate.py` (`:358`); the base npz to
  `outputs/cclay/<id>-base.npz` (`:362`); one npz per unique `--constrain-pose` source id (reusing
  the base upload when the source IS the base motion) to `outputs/cclay/<id>-pose-<src>.npz`
  (`:364-392`). `mkdir -p outputs/cclay` on the box (`:360`).
- remote command: `--prompt --duration --base --output` + `--target`/`--target-orient`/
  `--pose-from`/`--root-2d` + optional `--seed --cfg_weight --contact-threshold --root-margin`
  (`:394-410`).
- out: npz scp'd to the local motions dir (`:428`); ALL remote copies (output, base, pose) are
  `rm -f`'d (`:431-438`).
- printed JSON: `{motion_id, duration_s, path, base_motion_id, ...remote contract}` where the
  remote contract is the section-2 result body (`:442-443`).

Sequence mode — remote `scripts/cclay_sequence_generate.py` (`:447-497`):
- in (scp): the script itself (`:456`).
- remote command: `--segment <prompt> <seconds>` per pair + `--output` + optional `--seed`
  (`:460-465`).
- out: npz scp'd locally (`:485`); remote npz removed (`:488`).
- printed JSON: `{motion_id, duration_s, path, ...remote contract}` (section-3 body) (`:494-495`).

Shared mechanics: `motion_id` is a slug of the first prompt (lowercased, non-alnum→`-`, trimmed,
cut to 40 chars) + `-MMddHHMMSS` stamp (`:329-334`), matching the add-on grammar
`^[a-z0-9][a-z0-9-]{0,63}$` (`:329`, `:113`). Local motions dir is `mkdir -p` + `chmod 700`
(`:511-512`, `:426-427`), npz `chmod 600` (`:514`, `:429`, `:486`). All remote output is
`outputs/cclay/` under the remote repo so it never grows unbounded (`:431-438`, `:488`, `:547`).
Requires `$PROJECT/.cclay/project.json` (`:327`).

## 6. Post-processing: what `--contact-threshold` and `--root-margin` actually do

Both flags only reach ARDY's post-processor in the CONSTRAINED pass
(`scripts/ardy/cclay_constrained_generate.py:1065-1078`, passing `contact_threshold` and
`root_margin` plus the built `constraint_lst`). Plain mode runs `generate.py`'s postprocess with
ARDY defaults (`contact_threshold=0.5, root_margin=0.04`,
`remote:~/ardy/ardy/postprocess.py:190-191`) and sequence mode likewise (`:390-399`). Post-process
is skipped entirely for `g1` models or `--no-postprocess` (`remote:~/ardy/scripts/generate.py:266`;
constrained `:1065`).

The pipeline (`remote:~/ardy/ardy/postprocess.py:184-346`):
1. Build per-frame constraint masks (`FullBody`, `LeftFoot`, `RightFoot`, `LeftHand`,
   `RightHand`, `Root`) from the constraint list (`:200-258`); frames named by a constraint are
   masked out of free correction.
2. `extract_input_motion_from_constraints` (`:21-114`) recovers the target hip translations and
   rotations at constrained frames (Root2D sets root XZ; FullBody/EE sets the whole root +
   local rotations; EE constraints without Hips keep `root_2d` XZ).
3. `motion_correction.correct_motion` (`:316-325`) — a compiled
   `_motion_correction.cpython-312-x86_64-linux-gnu.so` binding over
   `MotionCorrection/src/cpp/AnimProcessing/Utility.cpp`, marshalled by
   `remote:~/ardy/MotionCorrection/python/motion_correction/motion_postprocess.py:11-101`.

`--contact-threshold` semantics (C++ source): `ComputeContactIntervals` marks a frame as "in
contact" iff `contact_probability > contactThreshold` (strict `>`,
`remote:~/ardy/MotionCorrection/src/cpp/AnimProcessing/Utility.cpp:85-117`, the test at `:102`),
after zeroing the probability on constraint-masked frames (`:90-97`). Contact intervals then pin
feet: `FindContactPoints` + 2-bone IK stabilize the leg chains during contact
(`DoContactIK`, `:615-850`), and the intervals also feed the root-y preservation in `CorrectHipsY`
(`:225-256`, `:1138-1143`). The end-to-end order is: velocity weights → `CorrectHipsY`
(contact-aware root-y) → `CorrectHipsXZ` (root-margin-aware root-xz) → `CorrectJointRotations` →
`DoEffectorIK` → `DoContactIK` (`:1111-1172`).

Important finding — the threshold is effectively INERT in this pipeline (inferred from the code
chain, all links verified): the `foot_contacts` tensor that `post_process_motion` receives is
already binarized by the motion rep's `inverse`, which emits `"foot_contacts": foot_contacts >
0.5` (`remote:~/ardy/ardy/motion_rep/reps/ardy_motionrep.py:277`). The C++ then compares
`1.0 > contactThreshold` / `0.0 > contactThreshold` on those 0/1 floats (`Utility.cpp:102`,
`motion_postprocess.py:78-79` casts to float32), which is constant for every `t in (0, 1)` — the
only range the wrapper and the constrained script accept (`scripts/cclay-ardy-generate:199-200`;
`:942-946`). Raising the threshold to "trust fewer contacts" therefore changes nothing in this
build; the flag would only bite if `foot_contacts` carried fractional probabilities into
post-process. (The rule-based detector `foot_detect_from_pos_and_vel` used when ENCODING features
produces hard 0/1 labels from velocity `< 0.15` and height `< 0.10` thresholds —
`remote:~/ardy/ardy/motion_rep/feet.py:7-52`, called at `ardy_motionrep.py:166`.)

`--root-margin` semantics (C++ source): `CorrectHipsXZ` builds a per-frame margin vector for the
root XZ trajectory: `fullBodyMask` frames get margin `0.0` (hard pin), frames with `rootMask` or
an end-effector contact pin get `root_margin`, everything else is `-1` (free)
(`remote:~/ardy/MotionCorrection/src/cpp/AnimProcessing/Utility.cpp:303-326`, assignments at
`:319` and `:325`). The `TrajectoryCorrector` contract: `margins[i] < 0` unconstrained,
`margins[i] == 0` pinned exactly, `margins[i] > 0` may deviate from the target within that margin
(`:157-162`). So `--root-margin` bounds how far the corrected root may drift from the constrained
root target at root/contact frames — `0` = exact pin, larger = looser; the default `0.04` is
claimed (help text only, `cclay_constrained_generate.py:220-221`) to be 10% of a 0.4 m box height.
Root Y is corrected separately with its own hard/soft logic (`CorrectHipsY`, `:225-256`).

## 7. Local-vs-box drift

None found. `diff` between the repo copies and `remote:~/ardy/scripts/` (via `ssh cat | diff`)
reports both `cclay_constrained_generate.py` and `cclay_sequence_generate.py` byte-identical.
Context that makes drift unlikely to persist: the wrapper scp-overwrites the box copies before
every constrained/sequence run (`scripts/cclay-ardy-generate:358`, `:456`), the box copies are
untracked in the box's git (`git status` shows `?? scripts/cclay_constrained_generate.py` and
`?? scripts/cclay_sequence_generate.py`), and the repo is declared the source of truth
(`scripts/ardy/README.md:37-45`; script headers `:4-6`). The durable push path is
`scripts/ardy/sync-to-box` (README `:43-49`), which fails closed unless the box HEAD equals
`UPSTREAM_BASE`; the box HEAD was verified to be exactly
`693f74d13b3d04a0a22ce127ee79c929dd89756b` at inspection time.

## Open questions / unverified

- `--model soma`: `generate.py`'s help (`remote:~/ardy/scripts/generate.py:38-39`), the registry
  docstrings, and `DEFAULT_HORIZON` (`remote:~/ardy/ardy/model/registry.py:9,11,35,77`) all name
  `soma`, but `MODELS_BY_SKELETON` at this commit defines only `core` and `g1` (`registry.py:17-24`),
  so `resolve_model_name("soma")` raises unless a folder literally named `soma` sits in
  `CHECKPOINTS_DIR` (unverified — `CHECKPOINTS_DIR` is unset on the box). The HF hub cache does
  contain `models--nvidia--Kimodo-SOMA-RP-v1.1`, but nothing in the registry references it; whether
  `load_model` can consume it is UNVERIFIED.
- Whether the model-decoded `foot_contacts` feature channel is a continuous probability before
  `inverse`'s `> 0.5` binarization (`ardy_motionrep.py:277`): the values were not inspected
  (requires loading a model, which was forbidden). The inert-threshold conclusion in section 6 does
  not depend on the answer, only on the binarization happening before post-process.
- The exact ADMM solve inside `TrajectoryCorrector` (`Utility.cpp:130-398`) beyond its documented
  margin contract (`:157-162`); the executable path is the compiled `.so`.
- `SOMASkeleton30 -> output_to_SOMASkeleton77` conversion (`generate.py:276-278`) never runs for
  the Core skeleton actually used; its effect on cclay outputs is untested here (UNVERIFIED).
- The `--history_frames` default for the core40 model resolves to
  `((int(10*20)//4)*4 - 40) // 4 * 4 = 160` frames (from `_default_history_frames`,
  `generate.py:106-113`) — arithmetic derived from the code, not observed in a run.
- The wrapper's hardcoded 20 fps frame bound (`scripts/cclay-ardy-generate:265`) is correct only
  because the wrapper can never select a model; if a future change exposes `--model g1` (25 fps),
  the local bound silently diverges from the box's `int(duration * fps)`.
