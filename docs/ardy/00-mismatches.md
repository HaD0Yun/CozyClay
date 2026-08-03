# ARDY <-> cclay mismatches

Reconciliation over `01`..`06` in this directory. Each row was re-verified against
current source; the lane docs carry the full detail and the `path:line` citations.

The two systems disagree in three different ways, and they need different fixes:

- **A. Real, live defects.** The pipeline is wrong today, silently.
- **B. Structural limits.** ARDY cannot express what the Blender rig has. No fix,
  only honest scoping.
- **C. Doctrine drift.** `AGENTS.md` describes a property the code does not have.

## A. Live defects

### A1. Frame rate: ARDY Core emits 20 fps, the working scene is 30 fps

ARDY Core is genuinely 20 fps -- not a stale comment. Verified three ways:
the released config (`nvidia/ARDY-Core-RP-20FPS-Horizon40`, `fps: 20`), the model
registry, and 20 real staged `.npz` files on the GPU box, every one `fps=20`
`int64`.

`apply_motion` bakes **one npz frame per scene frame** and does not resample
(`stage_scene.py:1350`, `:1524`). So a 20 fps clip in a 30 fps scene plays 1.5x
fast. The session that produced issue #1 was working in exactly that scene:
`"fps": 30`.

The wrapper only ever runs Core -- it never passes `--model`, and
`DEFAULT_MODEL='core'`. So 20 fps is not a corner case, it is the only case.

### A2. The fps guard is skipped entirely by a plan with no `apply_motion`

The guard is gated on the plan containing at least one motion
(`stage_scene.py:2185` `if self.motion_count:`). Two calls defeat it:

```
plan A: apply_motion(20 fps motion)   -> baked, scene fps set to 20   PASSES
plan B: set_render_settings(fps=30)   -> motion_count == 0, guard never runs
result: 20 fps keys play at 30 fps. Nothing rejects it.
```

**Not blocked.** There is no cross-call state. The docstring at
`stage_scene.py:1371-1376` predicted this gap and it is real.

The docstring points at the fix it did not take: the baked action already records
`cclay.motion_fps` (`stage_scene.py:1503`). That value is read back in exactly one
production place -- `constraint_capture.py:622` (`base_clip_of`) and the
regeneration guard at `:1218` -- and **never by any fps enforcement**. The signal
needed to close the gap already exists and is simply not consulted.

### A3. `--contact-threshold` is inert

`inverse()` binarizes `foot_contacts` at `>0.5` (`ardy_motionrep.py:277`) *before*
`post_process_motion` runs. The downstream C++ filter then compares `1.0 > t` and
`0.0 > t` (`Utility.cpp:102`), which is constant for every `t` in `(0,1)`.

So the flag the wrapper validated and forwarded had no effect on output.

CONFIRMED BY MEASUREMENT and FIXED, 2026-08-03. Three GPU runs on the box: one
base motion, then two constrained generations holding prompt, duration, seed and
base motion fixed and varying only `--contact-threshold` between 0.05 and 0.95.
The two outputs were byte-identical -- SHA-256 equal, and all nine npz keys
bit-identical with max absolute difference 0 (`foot_contacts`, `fps`,
`global_root_heading`, `global_rot_mats`, `local_rot_mats`, `posed_joints`,
`root_positions`, `smooth_root_pos`, `text`). The remote run JSON echoed
`postprocess.contact_threshold` back as 0.05 and 0.95 respectively, proving the
value reached the post-processor and still changed nothing.

Caveat recorded honestly: `seed_everything(seed, deterministic=False)`
(`remote:~/ardy/ardy/tools.py:230-238`) leaves cudnn autotune on, so byte identity
is not guaranteed in general. Here the two runs WERE identical, which serves as
both the determinism observation and the inertness evidence -- there was no
difference to attribute to anything.

`scripts/cclay-ardy-generate` now REFUSES `--contact-threshold` with a message
naming the cause, rather than accepting a knob that silently does nothing. The
flag is not exposed on any typed model tool, so no wire contract changed.

### A4. `apply_motion` does not fail closed on non-uniform scale, but preflight does

`motion_preflight` folds object world scale into its meters report and **fails
closed** on non-uniform scale, because there is no single meters-per-unit factor
(`motion_preflight.py:363`). This is the fix for the ~98.5x scale bug: the
unscaled rig thigh was being divided straight into the npz thigh, yielding `0.01`
where `0.985` was correct (`motion_preflight.py:378`).

But `apply_motion`'s own retarget uses the raw local rig thigh
(`stage_scene.py:1464-1465`) and does **not** fail closed. A non-uniformly-scaled
character passes apply and lands wrong. The two ends of the same pipeline
disagree about the same hazard.

### A5. The spine correspondence disagrees between the two sides, and cclay's is wrong

cskel27 has four spine joints (`Spine`, `Spine1`, `Spine2`, `Spine3`); the Mixamo
rig has three (`Spine`, `Spine1`, `Spine2`). One core joint must be dropped. The
two halves of this repo drop opposite ends:

| Mixamo bone | ARDY side (`scripts/ardy/interactive_demo/mixamo_avatar.py:26-28`) | cclay side (`blender-addon/cclay/motion_retarget.py:39-40`) |
|---|---|---|
| `Spine`  | core `Spine1` | core `Spine`  |
| `Spine1` | core `Spine2` | core `Spine1` |
| `Spine2` | core `Spine3` | core `Spine2` |

cclay keeps the bottom three and drops `Spine3`; the ARDY side keeps the top three
and drops `Spine`. The mapping is off by one segment.

**Measured, not argued.** cskel27 rest heights come from
`remote:~/ardy/ardy/assets/skeletons/cskel27/joints.p` (27x3, loaded with
`torch.load`); Mixamo rest heights from `y-bot-tpose.fbx` imported into Blender
5.2.0 (`head_local`, +Y is up in this rig). Both normalised by the Hips->Neck
span:

| joint | cskel27 | Mixamo |
|---|---|---|
| `Hips`   | 0.0000 | 0.0000 |
| `Spine`  | 0.1180 | 0.1986 |
| `Spine1` | 0.2729 | 0.4317 |
| `Spine2` | 0.4297 | 0.6991 |
| `Spine3` | 0.5869 | -      |
| `Neck`   | 1.0000 | 1.0000 |

Alignment error against the three Mixamo spine bones:

| alignment | per-joint error | max | mean |
|---|---|---|---|
| cclay, bottom-3 (`Spine`/`Spine1`/`Spine2`) | 0.0806, 0.1588, 0.2694 | 0.2694 | 0.1696 |
| ARDY, top-3 (`Spine1`/`Spine2`/`Spine3`)    | 0.0743, 0.0020, 0.1122 | 0.1122 | 0.0628 |

The ARDY-side alignment is **2.7x** better on mean error and **2.4x** better on
max error. Its middle pair is essentially exact (0.0020). cclay's mapping puts
core `Spine2` (43% of the way up the torso) onto Mixamo `Spine2` (70% of the way
up) -- a 27% torso-length error on the single joint that carries most of a forward
lean.

Consequence: the same npz renders one torso posture in the ARDY viewer and a
different one baked into Blender. Forward lean, which is distributed across these
segments, is the most affected quantity -- and torso lean was one of the
naturalness defects reported against the stair climb.

Correction to an earlier draft of this document: it claimed "nothing composes
`Spine3`, it is dropped". That was wrong. `PoseTrackBuilder.step` did fold
`L_Spine2 @ L_Spine3` before writing the `Spine2` track, and a test pinned that
behaviour. The `None` in the table meant only "no bone of its own", not "rotation
discarded". The comment was accurate; the draft was not.

FIXED 2026-08-03. `MIXAMO_TARGETS` now maps core `Spine1`/`Spine2`/`Spine3` onto
mixamo `Spine`/`Spine1`/`Spine2`, and core `Spine` is the dropped joint. The fold
was removed with the remap: keeping it would have polluted mixamo `Spine1` and
double-applied `Spine3`. This matches the ARDY viewer, which applies only mapped
joints (`scripts/ardy/interactive_demo/mixamo_avatar.py:160-163`). The driven-bone
set is unchanged at 24 bones with identical names. `ik_chains.py`'s docstring
previously said 25 and was wrong; this change set corrected it to 24, so the
count assumptions in `ik_rig.py` and `stage_scene.py` still hold. The measurement was
independently re-derived before the change and reproduced the table above to the
fourth decimal.

## B. Structural limits

These are accepted scope, not defects. The model emits 27 joints; that is fixed
and correct.

### B1. cskel27 drives 24 of the rig's 66 bones

cskel27 **does** carry `LeftToeBase`/`RightToeBase` and they map to real Mixamo
bones (`motion_retarget.py:30-31`, `:49-51`). An earlier version of this document
claimed cskel27 had no toes; that was wrong.

Of the 27 core joints, 24 map. Since the A5 fix the three unmapped joints are
`Spine`, `RightHandEnd` and `LeftHandEnd` (it was `Spine3` before the remap).
Measured against `y-bot-tpose.fbx` (66 distinct `mixamorig:` bones), 42 rig bones
are not driven by ARDY:

- **38 finger bones.** cskel27 carries `LeftHandThumb1`/`RightHandThumb1` only.
  Every other digit joint is absent. Covered separately by baked digit curves from
  `blender-addon/calibration/hand-shapes-v1.json`, independent of ARDY.
- **4 leaf/skin bones**: `HeadTop_End`, `LeftToe_End`, `RightToe_End`, `Hips_skin`.
  `ToeBase` rotation is driven, but the toe tip is not, so the exact contact point
  at the front of the foot is not established by the motion.

### B2. Only four joints are constrainable

`--constrain` accepts `LeftFoot RightFoot LeftHand RightHand` and nothing else.
Stair authoring therefore cannot pin a toe, a knee, or a root height -- and stair
authoring is mostly about height. `--constrain-path` gives root x/z/heading only.

Position and orientation are also separate flags (`--constrain` vs
`--constrain-orient`): a position-only constraint leaves joint rotation to the
solver, which is the structural reason an ankle can end up reversed.

### B3. Other ARDY models would be rejected outright

`g1` is 34 joints @ 25 fps and `soma` is 77 joints; cclay hard-pins
`(F, 27, 3, 3)`. Anything but Core fails ingestion. Fine today -- the wrapper only
runs Core -- but it makes "just use a 30 fps model" a non-answer to A1.

## C. Doctrine drift

### C1. `cclay.locked_by_human` is written and never read

`AGENTS.md` states:

> The director may mutate any entity except one stamped `cclay.locked_by_human`.

Repo-wide, the property appears in exactly two adjacent lines -- both writes, in
the migration (`stage_scene.py:549-550`). There is no read anywhere.

Enforcement is by ownership instead, and the two predicates are exact logical
negations:

```python
_owned(o, pid)             ==  o.get("cclay.owned_project_id") == pid   # :281
_is_foreign_object(o, pid) ==  o.get("cclay.owned_project_id") != pid   # :288
```

The migration stamps the lock on exactly the set `_require_owned_entity` already
rejects (`:313`). At cutover the two are indistinguishable, which is why no test
caught it.

They diverge in the case the invariant's wording invites: **a human stamping
`cclay.locked_by_human` on a project-owned entity gets zero protection.** The flag
is decorative.

RESOLVED as doctrine, 2026-08-03: the sentence was struck. `AGENTS.md:135` now
states enforcement by ownership alone and records that the property is written and
never read, so it must not be described as a lock. No code changed; the behaviour
was always ownership-based.

### C2. No archive signing exists

`AGENTS.md` scopes HMAC as non-adversarial tamper-*evidence* "if retained". It was
not retained. The only `hmac` use in the tree is `compare_digest` on the hello
bearer token (`blender_server.py:592`); there is no archive key anywhere.

The doctrine's threat table is still accurate -- it already says typed services
provide no tamper resistance. But the "if retained" clause describes something
that does not exist and should be struck rather than left as a maybe.

## Fixed, recorded so it stays fixed

| | |
|---|---|
| ~98.5x scale | Fixed via `_object_world_scale`; preflight fails closed on non-uniform scale |
| Y-up <-> Z-up | Converted at every typed boundary; frame-0 `+Y`-dominant check rejects violators. Raw `execute_blender_python` is unprotected by design |
| Blender-based in-betweening | Replaced by `ardy_inbetween` on `dev`. Awaiting live GPU acceptance |

## Priority

| Rank | Item | Why |
|---|---|---|
| 1 | **A5** spine off-by-one | Measured wrong: 2.7x worse mean alignment error. Torso posture is baked incorrectly on every clip |
| 2 | **A2** fps guard bypass | Silent, reachable in two ordinary calls, and the closing signal already exists |
| 3 | **A1** 20 vs 30 fps | Every Core clip is wrong in a 30 fps scene |
| 4 | **A4** apply/preflight scale asymmetry | Same hazard, two verdicts |
| 5 | **A3** inert contact threshold | Verify live before acting |
| 6 | **C2** signing doctrine | Wording only |
| - | **B1-B3** | Accepted scope. Document, do not fix |
| done | **C1** decorative lock | Sentence struck from `AGENTS.md` |

A5 outranks A1/A2 because the rate defects make a correct pose play at the wrong
speed, while A5 bakes the wrong pose. Speed is recoverable after the fact; posture
is not.

## Open questions

- A5: whether the ARDY-side mapping is deliberately display-only. The measurement
  says it is anatomically better regardless, but the intent is unrecorded on both
  sides. Neither file cites a reason.
- A3 is a code-chain inference. One live A/B at two thresholds settles it.
- Whether resampling (the real A1 fix) is wanted at all: the docstring lists
  `hand_track` clip frames, `start_frame`, contact windows and camera cut frames
  as things that would all have to move together. All four were verified to
  exist. That is a design decision, not a patch.