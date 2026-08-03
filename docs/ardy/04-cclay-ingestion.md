# 04 — cclay ingestion: where an ARDY artifact becomes a durable cclay motion

Summary: an ARDY motion archive (`<id>.npz` under `.cclay/motions/`) crosses the ingestion
boundary in three hops, each with its own validator: (1) the bash wrapper
`scripts/cclay-ardy-generate` mints the `motion_id` and scp's the npz into the project's
motion directory, unvalidated; (2) the host queue's `ArdyMotionKernel` calls
`commitGenerated`, which runs `NpzMotionArchiveValidator.validateForWrite` — structural
ZIP/NPY checks plus a small set of value checks (fps 1..240 integer, every float in
`posed_joints`/`local_rot_mats` finite, frame-0 Hips +Y dominant) — then atomically
republishes the bytes; (3) Blender-side `preflight_motion` / `apply_motion` re-validate the
decoded arrays with `MotionValidationCursor` (or its vectorized twin), which is where
rotation-matrix orthonormality and the Y-up invariant are actually enforced, and where the
per-entity meters scale is derived. Everything is documented as a correctness boundary for
well-behaved callers, explicitly not a security boundary. What the archive can smuggle
through all three hops without any rejection is listed in the final section.

## 1. `ArdyArchiveService`: what WRITE validates vs what READ validates

The repo's invariant text (AGENTS.md:139, mirrored in README.md:209-212) claims:
"`ArdyArchiveService` (module boundary inside `director-runtime`) validates
cskel27/Y-up/FPS/replay invariants at write time and structural well-formedness at read
time via typed schemas". The code under that claim does the following; the mapping of the
four words to actual checks is:

- "cskel27" — shape checks only. `validateStructure` requires
  `local_rot_mats.npy` shape `(F, 27, 3, 3)` with `1 <= F <= 24_000` and a numeric dtype,
  and `posed_joints.npy` shape `(F, 27, 3)` with the same F
  (packages/director-runtime/src/ardy-archive-service.ts:245-262). It never checks joint
  identity or order; "cskel27" means "27 joints" here. (The add-on asserts the actual joint
  semantics separately: `motion_preflight.py:86-89` asserts the foot-contact joint indices
  equal `(25, 26, 21, 22)`.)
- "Y-up" — exactly one check, on frame 0 only, at WRITE time:
  `const x = firstFloat(joints, 0); const y = firstFloat(joints, 1); const z = firstFloat(joints, 2);
  if (!(y > Math.abs(x) && y > Math.abs(z))) fail("ARDY_ARCHIVE_INVARIANT", "frame-0 cskel27 Hips must be +Y dominant")`
  (ardy-archive-service.ts:300-304). Note the strict `>` comparisons and that the check is
  only applied to frame-0 Hips of `posed_joints`; later frames are unconstrained.
- "FPS" — `fps.npy` must be an integral scalar (line 263, via `scalarInteger` at lines
  198-210, which rejects non-integer kinds) and `if (fps < 1 || fps > 240) fail("ARDY_ARCHIVE_INVARIANT", "fps must be in 1..240")`
  (ardy-archive-service.ts:291). The ARDY target of 20 fps is NOT enforced anywhere in this
  validator; anything in 1..240 passes.
- "replay" — every float in `posed_joints.npy` and `local_rot_mats.npy` must be finite
  ("contains a non-finite replay value", ardy-archive-service.ts:294-299), and the sweep
  only works on float32/float64 members (`firstFloat` fails with
  "must use float32 or float64 for replay validation" for any other dtype,
  ardy-archive-service.ts:212-214). A side effect: integer-dtype `posed_joints` passes
  READ (`isNumeric` allows `i`/`u` 1/2/4/8, lines 191-196) but FAILS WRITE, because
  `validateForWrite` runs the float-only sweep.

WRITE time (`validateForWrite`, ardy-archive-service.ts:285-305) = `validateStructure` +
the three value checks above. READ time (`validateStructure`, lines 222-283) = ZIP
container parse (EOCD/central-directory/local-header walk in `parseZip`, lines 99-135;
zlib inflation + size verification in `decodeMember`, lines 137-152; NPY
magic/header/shape/payload-size parse in `parseNpy`, lines 154-188), a member allowlist
with size caps — archive ≤ 64 MiB (line 7), uncompressed
payload ≤ 96 MiB (line 8), NPY header ≤ 16 KiB (line 9) — member-name safety
(`basename(name) === name`, no backslash, no duplicates, unknown members rejected,
lines 227-239), the three required members present (lines 241-242), the shape/dtype checks
above, and optional-member shape/dtype pinning (lines 264-282): `foot_contacts.npy` bool
(F,4), `global_rot_mats.npy` f (F,27,3,3), `global_root_heading.npy` f (F,2),
`root_positions.npy` f (F,3), `smooth_root_pos.npy` f (F,3), `text.npy` U scalar.
READ time runs NO value checks at all (no fps bounds, no finiteness, no Y-up): the
`store.read` path only calls `validateStructure` (ardy-archive-service.ts:338-347).

Where this runs in practice: the wrapper writes the npz directly into
`.cclay/motions/<id>.npz` (scripts/cclay-ardy-generate:428, 485, 513), then the kernel
`ArdyMotionKernel.run` parses the wrapper JSON and calls
`archive.commitGenerated(result.motion_id)` (packages/director-runtime/src/ardy-motion-kernel.ts:179);
`commitGenerated` renames the canonical file to a `.claim` name, runs
`validateForWrite` on the bytes, writes them back through `MotionArchiveStore.write`, and
unlinks the claim (ardy-archive-service.ts:396-430). So the first WRITE-time validation of
a generated npz happens after the fact, at commit. The archive service is injected into the
kernel as `archive: Pick<ArdyArchiveService, "commitGenerated">`
(ardy-generate-service.ts:108-116); queue-side reads for preflight input verification call
`archive.read` (regenerate/inbetween: ardy-regenerate-service.ts:230-234,
ardy-inbetween-service.ts:226-235), i.e. READ-time structural checks only.

The invariant claim's own scope is stated in AGENTS.md:139: "this is real for WELL-BEHAVED
callers (regeneration queue runner, ARDY services) and prevents accidental/malformed writes
on that path. It provides NO authenticated caller identity, NO adversarial tamper
resistance, and NO proof an archive entry was genuinely ARDY-produced."

## 2. Where `motion_id` is minted

Three minting sites, two of them in Blender-land, one in the wrapper:

- Direct generations (unconstrained, constrained, sequence): the bash wrapper mints the id
  locally before any ssh:
  `SLUG="$(printf '%s' "$SLUG_SOURCE" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed -e 's/^-*//' -e 's/-*$//' | cut -c1-40)"`,
  `STAMP="$(date +%m%d%H%M%S)"`, `MOTION_ID="${SLUG:-motion}-${STAMP}"`
  (scripts/cclay-ardy-generate:329-334). `SLUG_SOURCE` is the prompt, or the first
  `--segment` prompt (lines 330-331). So the id is derived from (prompt slug, wall-clock
  second: month-day-hour-minute-second, no year, no randomness). Two runs within the same
  second with the same prompt slug collide: the local scp overwrites
  `.cclay/motions/<id>.npz` (lines 428/485/513) and the remote
  `outputs/cclay/<id>.npz` is shared too (line 336). The wrapper echoes the id back in one
  JSON line with `frames`/`fps` (lines 442, 494, 553-554).
- Synthetic pose archives (regenerate surface): the add-on operator mints a request id via
  `constraint_capture.new_request_id()` = `uuid.uuid4().hex`
  (blender-addon/cclay/__init__.py:1647, constraint_capture.py:1658-1659; grammar
  `[0-9a-f]{32}`, constraint_capture.py:63) and `capture_regeneration_request` derives
  `synthetic_motion_id = f"cclay-pose-{request_id[:16]}-f{entry['frame']}"`
  (constraint_capture.py:851).
- Synthetic pose archives (in-between surface): `capture_evaluated_pose` mints exactly
  `f"cclay-pose-{request['request_id']}-{index + 1}"` per `pose_frames` entry in declared
  order (constraint_capture.py:1235-1237); the host reproduces the same rule in
  `inbetweenSyntheticPoseIds` (ardy-inbetween-service.ts:52-58) and the shared orphan sweep
  keys on the prefix `cclay-pose-` (ardy-synthetic-poses.ts:25).

The host treats the wrapper's `motion_id` as authoritative — it does not mint one. The
service only requires it to be a string (`wrapper.motion_id` must exist,
ardy-generate-service.ts:154-157) and the kernel passes it through to `commitGenerated`,
where `motionFileName` re-validates the grammar `^[a-z0-9][a-z0-9-]{0,63}$` and fails with
`ARDY_ARCHIVE_INVALID_ID` otherwise (ardy-archive-service.ts:82-87). The add-on applies the
same grammar at archive load (`MOTION_ID` regex, motion_archive.py:15, validated in
`validate_motion_id` 27-34) and when reading queue outcomes
(constraint_capture.py:1576). Queue request ids are pinned to `^[0-9a-f]{32}$` by the
closed capability schemas, which the write-ahead machinery relies on for filename safety
(ardy-queue.ts:164-167).

## 3. `motion_preflight.py` rejection codes (complete)

Entry point `collect_preflight(revision_id, params, project_directory)`
(motion_preflight.py:484-508). It returns the analysis dict or raises `PreflightMotionError`
with exactly one of these codes; the bridge surfaces `error.code` unchanged
(connection.py:921-922 calls `collect_preflight`). The `_as_contract_error` mapping
(motion_preflight.py:480-482) re-raises `MotionArchiveError`s with their OWN code, so the
archive-load codes below are also observable from this method.

| code | trigger condition | path:line |
|---|---|---|
| `INVALID_PREFLIGHT_MOTION_PARAMS` | `params` is not a dict | motion_preflight.py:308-309 |
| `INVALID_PREFLIGHT_MOTION_PARAMS` | unknown fields beyond `{motion_id, entity_id}` | motion_preflight.py:310-311 |
| `INVALID_PREFLIGHT_MOTION_PARAMS` | `motion_id` not a lowercase `[a-z0-9-]` slug, ≤ 64 chars (explicit `null` included) | motion_preflight.py:314-318 |
| `INVALID_PREFLIGHT_MOTION_PARAMS` | `entity_id` present but not a lowercase UUIDv4 | motion_preflight.py:322-327 |
| `INVALID_PREFLIGHT_MOTION_PARAMS` | object `scale` is not 3 int/float components | motion_preflight.py:354-356 |
| `INVALID_PREFLIGHT_MOTION_PARAMS` | object `scale` has a non-finite axis | motion_preflight.py:358-359 |
| `INVALID_PREFLIGHT_MOTION_PARAMS` | object `scale` has any axis ≤ 0 | motion_preflight.py:360-361 |
| `INVALID_PREFLIGHT_MOTION_PARAMS` | non-uniform object scale: `max(axes) - min(axes) > SCALE_UNIFORMITY_TOLERANCE * max(axes)` (`SCALE_UNIFORMITY_TOLERANCE = 1e-4`, line 336) | motion_preflight.py:362-367 |
| `INVALID_PREFLIGHT_MOTION_PARAMS` | entity exists but is not an ARMATURE / has no bones data | motion_preflight.py:387-388 |
| `INVALID_PREFLIGHT_MOTION_PARAMS` | rig is missing RightUpLeg/RightLeg (`rig_thigh` is None) | motion_preflight.py:389-391 |
| `ENTITY_NOT_FOUND` | `entity_id` given but no scene object resolves to it | motion_preflight.py:382-386 |
| `APPLY_MOTION_MALFORMED` | `derive_scale` raises (`npz_thigh <= 1e-6` or `rig_thigh <= 1e-6`) | motion_preflight.py:393-398, motion_retarget.py:355-358 |
| `APPLY_MOTION_MALFORMED` | payload validation fails: non-finite/non-numeric rotation or joint component, rotation matrix not a proper rotation, or frame-0 Hips not +Y dominant (the check the assignment points at, "motion is not Y-up (frame-0 hips not +Y dominant)") | motion_preflight.py:476-477; checks at 401-448, Y-up at 437-447 |
| `APPLY_MOTION_MALFORMED` (mapped from archive) | `motion_id` invalid; npz not readable / wrong members / wrong shapes / wrong dtypes / size mismatch / fps out of 1..240 | motion_archive.py:31, 66 (via `_malformed`), 218-251, 284-289, 305-310, 315 |
| `APPLY_MOTION_NOT_FOUND` (mapped) | `<project>/.cclay/motions/<id>.npz` missing, a symlink, or escaping the motions directory | motion_archive.py:328-337 |
| `APPLY_MOTION_TOO_LARGE` (mapped) | archive file > 64 MiB | motion_archive.py:338-342 |
| `APPLY_MOTION_PROJECT_DIR_UNKNOWN` (mapped) | no project directory bound to the connection | motion_archive.py:322-325 |

The preflight-only Y-up check (motion_preflight.py:437-447) mirrors the retarget cursor:
`hips0[1] > 0 and abs(hips0[1]) >= abs(hips0[0]) and abs(hips0[1]) >= abs(hips0[2])` on
frame 0 of `posed_joints` (index `ROOT_JOINT_INDEX = JOINT_INDEX["Hips"]` = 0,
motion_preflight.py:63). Note the non-strict `>=` here vs the strict `>` in the TS write
check (section 1) — a frame-0 hips with `y == |x|` passes the add-on but fails host commit.

The preflight payload validation itself is the vectorized numpy fast path
`_validate_arrays_vectorized` (motion_preflight.py:401-448) when both arrays carry
numpy `shape`/`dtype` metadata, else the stepwise cursor; both reject with the same
`MotionRetargetError` messages, which are wrapped into `APPLY_MOTION_MALFORMED`
(motion_preflight.py:450-478). The vectorized rotation check is:
`|R@Rᵀ − I|.max() <= ROTATION_MATRIX_TOLERANCE`, `|Rᵀ@R − I|.max() <= ...`,
`|det(R) − 1|.max() <= ...` (lines 417-432), matching the cursor's row/column
norm/dot/det checks (section 5).

## 4. The ~98.5x scale mismatch (motion_preflight.py:339-378)

Documented in the `_object_world_scale` docstring (motion_preflight.py:341-352): CozyClay
issue #2 reported a preflight scale of ~98.514099 for a YBot whose object scale is
`[0.01, 0.01, 0.01]`, where the correct meters-per-npz-unit factor is ~0.985 — exactly a
100x error.

The bug: `CharacterRigAdapter.rig_thigh` is `(RightLeg.head_local - RightUpLeg.head_local).length`
measured in the armature's LOCAL edit-bone space (character_rig.py:16-21), i.e. it is the
UNSCALED local thigh (~0.4 m of local units for a humanoid rig). `derive_scale` divides
`rig_thigh / npz_thigh` (motion_retarget.py:347-359), so dividing the unscaled local thigh
by the npz thigh (which ARDY expresses in real meters) yields a factor ~100x too large for
an object that is itself scaled 0.01. The old code never consulted the object transform.

The fix: the shared derivation `_derive_scale_for_object` (motion_preflight.py:371-394)
resolves the rig (`CharacterRigAdapter` on the object's bones, requiring the rig thigh) and
the object's world scale, and returns the LOCAL units-per-npz-unit retarget factor
`motion_retarget.derive_scale(posed_joints[0], rig_thigh)` — `object_scale` from
`_object_world_scale` (motion_preflight.py:339-368), which reads `scene_object.scale`,
validates it, and returns the uniform factor `axes[0]`. The meters-per-npz-unit REPORT is
the local factor folded by the object scale: `_meters_scale_for_entity`
(motion_preflight.py:414-434) multiplies `local * object_scale` (the multiplication is the
fix, motion_preflight.py:431-434; `derive_scale` is linear in the thigh length, so
`local * object_scale == derive_scale(posed, rig_thigh * object_scale)`).
`_derive_entity_scale` (motion_preflight.py:397-411) is the entity-lookup wrapper both
callers share.

What still fails closed: `_object_world_scale` rejects (all `INVALID_PREFLIGHT_MOTION_PARAMS`)
a malformed scale (line 354-356), a non-finite axis (358-359), any axis ≤ 0 (360-361), and
— the case named in the docstring — non-uniform scale:
`max(axes) - min(axes) > SCALE_UNIFORMITY_TOLERANCE * largest` (362-367), because "a
non-uniform scale has no single meters-per-unit factor, so this fails closed rather than
silently picking one axis" (motion_preflight.py:350-352). The tolerance is
`SCALE_UNIFORMITY_TOLERANCE = 1e-4` (relative to the largest axis, line 336), loose enough
for values that round-trip through UI edits or importers (comment at 333-335).

Symmetry with `apply_motion` (CozyClay A4): the retarget path uses the SAME shared
derivation — `_apply_motion_scale` (stage_scene.py:1478-1493) calls `_derive_scale_for_object`
and `PoseTrackBuilder` writes the LOCAL factor into armature space, letting Blender's object
transform carry it to world meters (stage_scene.py:1552-1557; the rationale is restated in
the `_object_world_scale` docstring, motion_preflight.py:342-347). Because the shared
derivation validates the object scale, a non-uniformly-scaled character now fails closed in
apply_motion with the SAME `INVALID_PREFLIGHT_MOTION_PARAMS` code preflight uses, carried on
the `StageSceneError` so the bridge_error code field never leaks the class name
(stage_scene.py:1490-1492). The preflight meters report is a reporting number; the retarget
scale is the same derivation without the meters fold.

## 5. `motion_retarget.py`: `validate_motion`, `MotionValidationCursor`, `derive_scale`

Constants (motion_retarget.py:54-62):
- `MAX_FRAMES = 24_000` — "20 minutes at 20 fps" (comment at line 54); frame count must be
  `1..24_000` (motion_retarget.py:261-264).
- `FPS_BOUNDS = (1, 240)` — fps must be an `Integral` (bool rejected) in range
  (motion_retarget.py:248-253).
- `MAX_PAYLOAD_BYTES = 96 * 1024 * 1024` — `rotations_nbytes + joints_nbytes` cap
  (motion_retarget.py:269-272).
- `ROTATION_MATRIX_TOLERANCE = 1e-3` — "Maximum absolute error for squared row/column
  norms, pairwise dot products, and determinant. 1e-3 comfortably covers float32 ARDY
  serialization noise while remaining far below scale, shear, and reflection errors"
  (motion_retarget.py:58-61).

`MotionValidationCursor.__init__` (motion_retarget.py:247-277) is metadata-only: fps
bounds, `_array_preflight` on both arrays (shape `(F,27,3,3)`/`(F,27,3)` or len-based
fallback, dtype kind in `i/u/f`, nbytes sanity — lines 73-118), frame-count match between
the two arrays, payload-size cap. `MotionValidationCursor.step(max_frames=64, cancelled)`
(motion_retarget.py:279-332) validates at most `max_frames` rows per call: per frame it
requires finite numeric components (`_is_finite_number` on every rotation and joint
component, lines 306-314) and a proper rotation via `_validate_rotation_matrix` (lines
154-186: row and column squared norms within 1e-3 of 1, pairwise row/column dots within
1e-3, determinant within 1e-3 of 1 — a reflection with det −1 fails). When the cursor
finishes, it applies the single Y-up check to frame-0 Hips (motion_retarget.py:317-326):
`hips0[1] > 0 and abs(hips0[1]) >= abs(hips0[0]) and abs(hips0[1]) >= abs(hips0[2])`.
`validate_motion` (motion_retarget.py:335-344) is a convenience loop over `step()`.

`derive_scale(posed_joints_frame0, rig_thigh_length)` (motion_retarget.py:347-359) computes
the frame-0 thigh from `RightUpLeg` (index 19 per `JOINT_INDEX`) and `RightLeg` (index 20),
then returns `rig_thigh_length / npz_thigh`, failing if either length ≤ 1e-6.

Where this runs in the ingestion path:
- `load_motion_payload(..., validate=True)` calls `validate_motion` after
  `inspect_motion_archive` (motion_archive.py:357-392; the validation call at 387-391). The
  two ARDY consumers that load with the default `validate=True` are the pose-capture paths
  (constraint_capture.py:684-687).
- `preflight_motion` loads with `validate=False` and runs its own vectorized/cursor
  validation instead (motion_preflight.py:489-496, 450-478).
- `apply_motion` loads with `validate=False` and amortizes the cursor across modal ticks:
  `while not validation_cursor.step(max_frames=64): yield "MOTION_PREPARE"`
  (stage_scene.py:1428-1442), then derives the retarget scale and builds tracks
  (stage_scene.py:1456-1473).

Malformed inputs that get through `validate_motion`/cursor (validated only elsewhere or not
at all):
- fps values other than 20: anything integral in 1..240 passes, and the archive is applied
  at its declared fps.
- Y-up violations in frames 1..F−1: only frame-0 Hips is ever inspected.
- Joint ORDER: validation is purely index-based against the fixed `CSKEL27_JOINTS` list
  (motion_retarget.py:33); a shape-correct array whose rows are not cskel27 order passes.
  Preflight additionally asserts `FOOT_CONTACT_JOINT_INDICES == (25, 26, 21, 22)` at import
  time (motion_preflight.py:86-89) and reads named indices (`Hips`, `RightUpLeg`,
  `RightLeg`, `LeftFoot`, `LeftToeBase`, `RightFoot`, `RightToeBase`), so a reorder that
  preserves those indices slips through validation entirely and is retargeted as if cskel27.
- Semantic consistency between `local_rot_mats` and `posed_joints`: each array is validated
  independently; nothing checks that a joint's rotation agrees with its position
  (e.g. a limb rotated 90 degrees away from where its joints are).
- Magnitude/plausibility of `posed_joints`: any finite values pass; `derive_scale` then
  normalizes whatever scale the thigh implies (any `npz_thigh > 1e-6`).
- Optional members (`foot_contacts`, `root_positions`, `global_rot_mats`,
  `global_root_heading`, `smooth_root_pos`, `text`): not part of `validate_motion` at all;
  see section "What ingestion will not catch".
- Non-float dtypes: `_array_preflight` only restricts dtype kind to `i/u/f`
  (motion_retarget.py:103-110); itemsize is not checked at the cursor level (the archive
  inspector adds itemsize restrictions, motion_archive.py:139-146).

## 6. HMAC / signing: what is actually implemented

Implementation reality: there is NO HMAC, signature, or keyed checksum on motion archives
anywhere in the current tree. A repo-wide search for `hmac` finds exactly one production
use: `hmac.compare_digest(token, self._token)` in the Blender-owned local server's hello
handshake (blender-addon/cclay/blender_server.py:591-593) — a constant-time comparison of
the bearer token, not an archive signature. No `.cclay/ardy-archive.key` or equivalent key
material is referenced by any shipped file.

The doctrine is stated verbatim in AGENTS.md:139: HMAC signing, "if retained, is scoped
explicitly as non-adversarial corruption/tamper-EVIDENCE diagnostics only (disk errors,
pipeline bugs, interrupted writes) — never described as security", and the same bullet
fixes the threat table: a same-OS-user process "can read every file under `.cclay/`
including archive entries and any key material; write/overwrite archive files directly,
bypassing `ArdyArchiveService` entirely; produce a validly-"signed" forged entry if HMAC
diagnostics are retained; and directly pose/mutate the rig in the live scene exactly as it
always could". README.md:209-212 states the same: "It is not a security boundary;
same-OS-user processes, including `execute_blender_python`, can read, write, forge, bypass,
and mutate rigs."

History: the plan artifacts show an HMAC-SHA256 per-project key (`.cclay/ardy-archive.key`,
mode 0600) was proposed as "authenticated provenance" in an early stage, that claim was
retracted as an overclaim (the key is as readable as the data it protects), and the design
was re-scoped to "accidental-corruption/tamper-EVIDENCE diagnostics only ... explicitly
documented as providing NO security guarantee" (see .gjc/plans/.../stage-03-revision.md
and the "retracted — overclaim" comparison in stage-04-final.md). The shipped code retains
neither the key logic nor any signature verification; the only integrity primitive actually
in the pipeline is the non-keyed SHA-256 used for revisions/evidence/QA digests elsewhere
(e.g. revision.py:8-9, fixture_registry.py:407-409), which is unrelated to archive signing.
So the honest report is: nothing is signed today; the "HMAC if retained" clause is a
conditional that the implementation did not exercise.

## What an ARDY artifact can contain that ingestion will NOT catch

Concrete payloads that pass every gate above without a rejection:

1. Non-rotation `local_rot_mats`: matrices need only be FINITE at host write (sweep at
   ardy-archive-service.ts:297-299) and at read; orthonormality/det≈1 is enforced only by
   the Blender-side cursor/vectorized path (motion_retarget.py:154-186,
   motion_preflight.py:417-432). A matrix with row norms of 10, or a reflection (det −1),
   commits and reads fine and is rejected later at preflight/apply.
2. NaN in OPTIONAL members: `foot_contacts`, `root_positions`, `global_rot_mats`,
   `global_root_heading`, `smooth_root_pos`, `text` get shape/dtype checks only at both the
   host (ardy-archive-service.ts:264-282) and the add-on (motion_archive.py:268-283); the
   finiteness sweeps cover only `posed_joints` and `local_rot_mats`. A NaN
   `foot_contacts` array commits, and preflight then reports NaN contact-window heights
   instead of rejecting (the windows are built with `bool()` thresholding and no isfinite
   check, motion_preflight.py:195-241).
3. Reordered "cskel27": joint ORDER is never verified; only the count 27 (host) and the few
   indices the add-on actually reads (Hips=0, RightUpLeg/RightLeg, foot joints 25/26/21/22)
   are meaningful. A shape-correct, reordered array that keeps those indices passes
   everything and is retargeted as if it were cskel27.
4. Non-20 fps: fps 1..240 (integer) passes host write (ardy-archive-service.ts:291),
   add-on inspect (motion_archive.py:305-310) and cursor (motion_retarget.py:248-253). The
   20 fps assumption exists only in comments and the wrapper's local frame-range checks
   (scripts/cclay-ardy-generate:36-38).
5. Frames after 0 not Y-up: only frame-0 Hips is checked (host strict `>`,
   ardy-archive-service.ts:300-304; add-on non-strict `>=`, motion_retarget.py:317-326).
   A clip that flips upside down at frame 10 passes every validator.
6. Degenerate or absurd geometry: e.g. all joints at the origin except Hips=(0,1,0) passes
   host write; only `derive_scale`'s `npz_thigh <= 1e-6` guard (motion_retarget.py:355-356)
   catches the degenerate case at preflight/apply, and any thigh above 1e-6 is silently
   normalized to whatever scale it implies.
7. Rotation/position disagreement: no cross-check between `local_rot_mats` and
   `posed_joints`; each is validated in isolation.
8. Non-uniformly-scaled entity: preflight refuses to report a meters scale
   (motion_preflight.py:362-367) but apply_motion does NOT fail closed — it retargets using
   the local rig thigh regardless of object scale (stage_scene.py:1464-1465).
9. Members never consumed: `global_rot_mats`, `global_root_heading`, `root_positions`,
   `smooth_root_pos`, `text` are never read by preflight or apply (only `foot_contacts` is
   carried, motion_preflight.py:489-493); their CONTENT is completely unchecked beyond
   shape/dtype.
10. Anything forged or hand-authored: no provenance or authenticity check exists by design
    (AGENTS.md:139) — a same-user process can write any npz that satisfies the structural
    and value checks above and it will be treated as a valid motion.
11. Extremes that are legal by construction: 24,000 frames at fps=1 (a ~6.7-hour clip) is
    within `MAX_FRAMES` (motion_retarget.py:54) and `FPS_BOUNDS`; there is no duration or
    frames-per-second relationship check anywhere.

## Open questions / unverified

- Whether any production wiring constructs `MotionArchiveStore` with a custom validator or
  additional checks: only tests construct it directly in the packages I searched; the
  queue/service construction site outside tests was not located, so I could not confirm
  there is no wrapper around `NpzMotionArchiveValidator` at the actual call site
  (the kernel/queue interfaces only expose `commitGenerated`/`read`/`recoverGenerated`/
  `removeStaleClaims`).
- The exact measured preflight scale of issue #2 ("~98.514099") is quoted from the code's
  own docstring (motion_preflight.py:348), not from the issue tracker; the issue itself was
  not reachable from this repo.
- Whether any component enforces fps == 20 outside the wrapper's local clip-frame
  validation: I found none in `director-runtime`, `blender-addon/cclay`, or the ARDY
  scripts, but a search for every "20" would be needed to prove it exhaustively.
- The remote ARDY side was only cited for the foot-contact channel order
  (verified at remote:~/ardy/ardy/motion_rep/feet.py:24: "[X, T, 4] contact labels (left
  heel, left toe, right heel, right toe)"); upstream `generate.py`'s exact member set and
  the constrained/sequence generators' NaN guards (scripts/ardy/cclay_constrained_generate.py:260-313
  walks every serialized member) are producer-side checks that were not cross-verified
  against the pinned upstream commit's runtime behavior.
