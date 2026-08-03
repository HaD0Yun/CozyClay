# 06. Evaluated-pose capture and in-between generation

The newest ARDY path works in two halves. First, the add-on's `capture_evaluated_pose`
bridge method reads the Blender rig's EVALUATED (constraint-applied, IK-solved) pose at
declared scene frames and writes one validated single-frame synthetic npz per frame into
`.cclay/motions/` (`blender-addon/cclay/constraint_capture.py:1151-1349`). Second, the
host-side `ardy_inbetween` capability submits a request whose `pose_frames` name those
archives, the constrained wrapper run (`scripts/cclay-ardy-generate` +
`scripts/ardy/cclay_constrained_generate.py`) re-generates a fixed 600 s / 20 fps clip with
`--constrain-pose` pointing at each captured pose, and the result is committed and applied
as a durable mutation through a write-ahead queue. The unconstrained first pass
(`ardy_generate`) is the same queue machinery with a prompt-only argv and no poses. The
captured pose is a cskel27 skeleton placement (27 joint centers + rotations + root); it is
NOT a sole/foot contact measurement, and every surface in this path says so explicitly.

## 1. `capture_evaluated_pose`: what it captures, in which space, at which frame

Bridge method surface (`blender-addon/cclay/constraint_capture.py`):

- The request is closed to exactly `{entity_id, expected_revision_id, base_motion_id, request_id, pose_frames}`
  (`CAPTURE_PARAM_KEYS`, :890-896); each `pose_frames` entry is exactly
  `{scene_frame, clip_frame}` (`POSE_FRAME_KEYS`, :897). Bounds: 1..32 poses
  (`POSE_FRAME_LIMIT = 32`, :884), `scene_frame` in -100000..100000
  (`SCENE_FRAME_BOUND`, :885), `clip_frame` in 0..11999 (`CLIP_FRAME_BOUND = 600 * 20 - 1`, :886).
  Entries must be unique on both axes and share ONE constant `scene_frame - clip_frame`
  offset (:1006-1015). `entity_id` is lowercase UUID v4 (:898-901); `request_id` follows the
  32-hex filename grammar (schema-grammar.ts `REQUEST_ID_PATTERN`).
- Registration: in `SUPPORTED_BRIDGE_METHODS`
  (`blender-addon/cclay/handshake.py:40`, comment :35-39) and deliberately NOT in
  `_READ_ONLY_BRIDGE_METHODS` (`blender-addon/cclay/connection.py:107-118`) — it verifies
  `expected_revision_id` and writes revision-bound archives, so a mutation freeze refuses it
  and it participates in task tracking (`_TASK_KINDS["capture_evaluated_pose"] = "pose_capture"`,
  connection.py:105). Dispatched at connection.py:1403-1417 with
  `expected_revision_id=durable_revision_id`.

Order of checks — everything runs BEFORE any frame is evaluated, and every failure fails
closed with no file written (:1157-1159, :1229-1241):

1. `expected_revision_id` vs the current durable revision (:1167-1172, `REVISION_MISMATCH`).
2. Project index present (:1175-1178) and armature found by `cclay.entity_id` (:1180-1192, `ENTITY_NOT_FOUND`).
3. Ownership stamp `cclay.owned_project_id` == project id (:1195-1199, `ENTITY_NOT_OWNED`).
4. The armature's applied clip (`base_clip_of`, :596-632) motion_id == requested `base_motion_id` (:1200-1206, `BASE_MOTION_MISMATCH`).
5. Base archive frame count == applied clip frame_count and base fps == clip fps (:1208-1225).
6. Every `(scene_frame, clip_frame)` pair satisfies the affine rule against THIS clip (:1226-1228 via `_require_pose_frame_mapping`, :1026-1051).
7. Destination collision preflight for every synthetic id it would write (:1235-1241).

Capture loop (:1260-1317), per entry in declared order:

- `scene.frame_set(request_entry["scene_frame"])` (:1261) — the pose is read at the SCENE frame.
- `rotations = pose_local_rotations(armature, basis["base_rotations"][clip_frame])` (:1262-1264) —
  the EVALUATED pose, not the rest pose and not the base archive. `pose_local_rotations`
  (:448-485) reads the pose bone's basis WITH constraints applied via `_effective_basis`
  (:422-438), which uses `pose_bone.matrix` (the evaluated, IK-solved matrix in armature
  space) and inverts the rest chain — never `pose_bone.matrix_basis`, which is the keyed
  pre-constraint transform and would miss an IK solve. Only the IK-driven joints
  (`IK_DRIVEN_JOINTS`, :443-445 — the 8 chain bones of the four two-bone chains,
  `blender-addon/cclay/ik_chains.py:123-131`) are re-derived from the pose; the other 19
  cskel27 joints are taken VERBATIM from the base clip's rotations at the clip frame
  (:455-462). That is deliberate: the mixamo rig has no Spine3 bone, the retarget folds
  Spine3 into Spine2, and re-deriving the spine from the pose moves the arms (measured
  1.4e-3 npz units at the wrist) while keeping the legs at 4e-7.
- `root = armature_root_position_to_npz(list(_hips_pose_bone(armature).head), basis["scale"])`
  (:1265-1267) — the evaluated Hips bone head position, converted to npz space by dividing
  by the motion scale (`motion_constraints.py:251-265`).
- `write_pose_source_npz(project_directory, synthetic_motion_id, local_rotations=rotations,
  bone_offsets=basis["bone_offsets"], root_position=root, fps=clip["fps"])` (:1276-1283).

Space: ARDY npz space — 27 x 3 x 3 local rotation matrices in `CSKEL27_JOINTS` order
(`blender-addon/cclay/motion_retarget.py:24-32`) plus a root position in npz units (Y-up,
meters, motion-local; axis 1 is height — `motion_constraints.py:47-48`). What is written:
one single-frame archive per pose frame, named `cclay-pose-<request_id>-<index + 1>` in
declared order (:1235-1237, :1272); the ordinal IS the declared order, which is what the
host reproduces when it rebuilds the `--pose-from` argv.

Return value (:1342-1349): `{schema_version, request_id, entity_id, expected_revision_id, base_motion_id, pose_frames: [{scene_frame, clip_frame, synthetic_motion_id}]}`.

Atomicity and hygiene: every destination is preflighted before any publish (:1254-1257);
any failure after the loop starts rolls back every archive this invocation created, with
ownership proven by inode (`_rollback_archives`, :1070-1129; `_StagedArchive` records
`(st_ino, st_dev)` at staging, :701-716); the entered scene frame is restored in a
`finally` that can never mask the primary failure (:1325-1341). The capture runs on the
Blender main thread via the bridge dispatcher's timer, which is what makes
`scene.frame_set` and the evaluated reads safe (:1164-1166).

## 2. The per-clip-frame indexing contract (the "corrupt every pose" warning)

`blender-addon/cclay/constraint_capture.py:1208-1210`:

> The archive and the applied clip must describe the same motion: the frame mapping binds
> to the clip's start and length, and the rotations are indexed per clip frame, so a
> mismatch would corrupt every pose.

The contract has three parts:

1. `basis["base_rotations"]` is indexed PER CLIP FRAME, `0..frame_count-1`. The capture
   loop reads `basis["base_rotations"][request_entry["clip_frame"]]` (:1263) as the
   reference for the 19 non-IK-driven joints. A wrong clip length means either an
   out-of-bounds read or — silently worse — every pose bound to the wrong base frame.
2. The frame mapping (`clip_frame = scene_frame - start_frame`) binds to the clip's start
   and length, so the clip's `frame_count` and the archive's frame count must agree.
3. Therefore `len(basis["base_rotations"]) != clip["frame_count"]` fails closed as
   `BASE_MOTION_MISMATCH` BEFORE any frame is evaluated (:1211-1216), and the same holds
   for an fps mismatch (:1217-1225) — fps drives the time-to-frame mapping. The add-on-side
   test asserts the base-mismatch path leaves zero files (`blender-addon/tests/test_ardy_pose_capture.py:449-452`).

The warning is load-bearing because the synthetic archive is SINGLE-frame: it carries no
frame index of its own, so the correctness of every captured pose depends entirely on the
`clip_frame` the request carries and the base archive it points at. A mismatch does not
fail downstream — the archive still round-trips validation — it silently corrupts every
pose's reference.

## 3. `write_pose_source_npz` and how it feeds `--constrain-pose`

`write_pose_source_npz` (`blender-addon/cclay/constraint_capture.py:731-817`) writes the
single-frame archive a full-body constraint points at:

- `numpy.savez` with `local_rot_mats=[local_rotations]` (shape (1, 27, 3, 3), float32),
  `posed_joints=[positions]` (shape (1, 27, 3), float32), `fps` (int64) (:781-786).
- `posed_joints` is NOT filled with anything convenient: it is recomputed by forward
  kinematics from the rotations + root (`motion_constraints.forward_kinematics`,
  motion_constraints.py:224-248, called at :763-765). The docstring records why (:742-746):
  archives in this project that skipped that step disagree with their own rotations by
  1.4 units, and nothing downstream would report it.
- Publication is create-only: staging via `tempfile.mkstemp` with O_EXCL in
  `.cclay/motions/` (:774-776), then `os.link(staged, destination)` (:801-805) so an
  existing destination is refused atomically (`FileExistsError` -> "motion <id> already
  exists", :804); the staged copy is unlinked on success. Mode 0600 (:789); the archive is
  round-tripped through the same validator apply_motion uses
  (`motion_archive.inspect_motion_archive`, :793). Path: `.cclay/motions/<motion_id>.npz`
  (:726-728).
- Two callers mint the `cclay-pose-` prefix into the SAME motions directory:
  `capture_regeneration_request` (`cclay-pose-<request_id[:16]>-f<frame>`, :851-859) and
  `capture_evaluated_pose` (`cclay-pose-<request_id>-<index + 1>`), which is why the orphan
  sweep must know both queues (`packages/director-runtime/src/ardy-synthetic-poses.ts:11-25`).

How it feeds the constrained generator:

- The wrapper parses `--constrain-pose <src-motion-id> <src-frame> <dst-frame>`
  (`scripts/cclay-ardy-generate:167-178`), requires `--base-motion` for any constraint flag
  (:228-231), refuses `--base-motion` without a constraint flag (:232-235), checks every
  src-motion-id's npz exists locally (:344-348), uploads each unique source once
  (:364-392) and emits remote `--pose-from <remote-path> <src-frame> <dst-frame>` (:391).
- The remote constrained script parses `--pose-from` (`scripts/ardy/cclay_constrained_generate.py:143-154`
  nargs=3; `parse_poses` :491-519) and `load_poses` (:620-655) reads `local_rot_mats` and
  `posed_joints` from the npz, indexes `[source_frame]`, and runs `skeleton.fk(local, root)`
  with `root = posed_joints[source_frame, skeleton.root_idx]` — so only
  `local_rot_mats[frame]` and the root out of `posed_joints[frame]` are consumed, which is
  exactly what the FK-computed archive guarantees. It then builds a
  `FullBodyConstraintSet` per pose (:733-742) pinning all 27 joints + root xz + root y +
  global heading at the destination frame (upstream `ardy/constraints.py:109-198`, verified
  on the box at `remote:~/ardy/ardy/constraints.py:109-198`).
- The pose archives are single-frame, so the host always passes src-frame `"0"`
  (`packages/director-runtime/src/ardy-inbetween-service.ts:160-175`). The box's copy of
  `cclay_constrained_generate.py` is byte-identical to the repo's (md5
  `329a9eebb95cf9fd43aced02ab7baf9f` verified via ssh), and the box HEAD is exactly
  `UPSTREAM_BASE` (`693f74d13b3d04a0a22ce127ee79c929dd89756b`, verified via ssh).

## 4. The `ardy_generate` and `ardy_inbetween` typed contracts

Both live in `packages/blender-protocol/src/`; the tool layer
(`packages/blender-tools/src/ardy-generate.ts`, `ardy-inbetween.ts`) exposes them as
`Type.Omit(schema, ["schema_version"])`.

### `ardy_generate` (`packages/blender-protocol/src/ardy-generate.ts`)

Request V1: `{ schema_version: 1, request_id, entity_id, expected_revision_id, prompt,
duration_seconds, seed, requested_at_ms }` where:

- `request_id` = 32 lowercase hex (queue idempotency key / outcome file name; schema-grammar.ts `REQUEST_ID_PATTERN`).
- `entity_id` = lowercase UUID v4; `expected_revision_id` = 64 hex.
- `prompt`: 1..512 chars, pattern `^[^-]` — the wrapper's argument loop has no
  end-of-options marker, so a leading hyphen would be parsed as an unknown option
  (comment citing `scripts/cclay-ardy-generate:208`).
- `duration_seconds`: `0 < d <= 1200` (mirrors the wrapper cap and the add-on's
  `motion_retarget.MAX_FRAMES = 24000` frames, 20 minutes at 20 fps —
  `scripts/cclay-ardy-generate:255-264`).
- `seed`: nullable integer 0..4294967295.

Result V1: `{ schema_version: 1, request_id, motion_id, frames (>=1), duration_seconds, seed }`.

Queue outcome: `succeeded { result, resulting_revision_id }` | `failed { error_code, message }`
with the closed 7-code union `INVALID_ARDY_GENERATE_REQUEST, ENTITY_NOT_FOUND,
REVISION_MISMATCH, ARDY_HOST_UNAVAILABLE, GENERATION_FAILED, GENERATION_INTERRUPTED,
APPLY_FAILED`. The header (:65-70) states this is deliberately a SUBSET of the in-between
union: generate is the UNCONSTRAINED first pass — it runs without `--base-motion` and
captures no poses, so `BASE_MOTION_NOT_FOUND` and `POSE_CAPTURE_FAILED` are unreachable.
The wrapper enforces the constraint combinations (`scripts/cclay-ardy-generate:228-235`);
the argv is exactly `[prompt, "--duration", seconds, ("--seed", seed)?]`
(`ardy-generate-service.ts:139-145`).

### `ardy_inbetween` (`packages/blender-protocol/src/ardy-inbetween.ts`)

Constants (numeric source of truth, :30-36): `ARDY_CONSTRAINED_PROMPT = "regenerate"`,
`ARDY_CONSTRAINED_DURATION_SECONDS_VALUE = 600`, `ARDY_CLIP_FPS = 20`,
`ARDY_CONSTRAINED_CLIP_FRAME_MAX = 600 * 20 - 1 = 11999`, argv string derived.

Request V1: `{ schema_version: 1, request_id, entity_id, expected_revision_id,
base_motion_id, pose_frames, requested_at_ms }` where `pose_frames` is 1..32 entries of
`{ scene_frame: -100000..100000, clip_frame: 0..11999 }`. There is NO prompt and NO
duration: the runtime service builds the argv from the constants (the request comment says
the same constants are currently private to `ardy-regenerate-service.ts` and the
regenerate service will import them instead). The `scene_frame` bound is the product
timeline ceiling the director can set (stage-scene frame_start/frame_end), not Blender's
raw MAXFRAME (:31-34).

`parseArdyInbetweenRequest` enforces cross-field invariants in code (:155-175): unique
`scene_frame` values, unique `clip_frame` values, and ONE constant offset
`scene_frame - clip_frame` across all entries — the exact affine rule the add-on uses,
checked FIRST for uniqueness so a human gets a specific diagnosis.

Result V1: `{ schema_version: 1, request_id, motion_id, frames (>=1), captured_frames (>=1),
base_motion_id, continuity, dropped_constraints }` where `continuity` is the regenerate
vocabulary `{ mean_jump_m, max_jump_m, max_jump_frame }` and `dropped_constraints` is an
array of `{ frame, reason }` (both imported from `ardy-regenerate.ts`, whose schema is at
`packages/blender-protocol/src/ardy-regenerate.ts:75-105`).

Queue outcome: `succeeded { result, resulting_revision_id }` | `failed { error_code, message }`
with the closed 9-code union `INVALID_ARDY_INBETWEEN_REQUEST, ENTITY_NOT_FOUND,
BASE_MOTION_NOT_FOUND, REVISION_MISMATCH, POSE_CAPTURE_FAILED, ARDY_HOST_UNAVAILABLE,
GENERATION_FAILED, GENERATION_INTERRUPTED, APPLY_FAILED`.

## 5. Host services and queue runners: write-ahead, status ladder, claim recovery, live-revision guard

### The write-ahead record `ArdyQueueProgressV1` (`packages/blender-protocol/src/ardy-queue-progress.ts`)

Union of three members, all `{schema_version: 1, request_id, motion_id, result}` plus:

- `status: "generated"` — written ATOMICALLY after the wrapper result parses (the first
  moment the motion id exists) and BEFORE `commitGenerated`; a crash before this record
  means nothing was committed, so a replay may safely re-run the generator (the bounded
  residual: at most one extra run per crash in that window).
- `status: "committed"` — the motion archive is committed.
- `status: "applied"` — additionally carries `resulting_revision_id`; only an applied
  record has one.

`result` is an opaque bounded JSON object (maxProperties 64, <= 65536 serialized bytes
enforced in `parseArdyQueueProgress`): each capability validates its own closed result
shape when the queue reads the record. The record is request-scoped (request_id +
motion_id), not entity-scoped. Written temp-then-rename with fsync on both the file and
the directory (`ardy-queue.ts:writeJsonAtomically`), same 0600 contract as the add-on's
request files.

### The status ladder

Design vocabulary `generate / generating / committed / applied / outcome` maps to concrete
files in `ardy-queue.ts` / the queue instantiations:

| design state | on disk | where |
|---|---|---|
| queued ("generate") | `.cclay/generate-requests|<id>.json` or `.cclay/inbetween-requests/<id>.json` | `ardy-generate-queue.ts:56-58`, `ardy-inbetween-queue.ts:50-52` |
| claimed ("generating") | `<id>.json.claimed` — the rename IS the lock; POSIX-atomic, so two sweeps cannot claim the same request | `ardy-queue.ts:CLAIMED_SUFFIX`, `sweepArdyQueue` |
| generated | `.cclay/generate-progress|<id>.json` (or inbetween-progress) with `status: "generated"` | kernel's `onGenerated` seam, `ardy-motion-kernel.ts:175-177`; runners `generate-queue-runner.ts:84-92`, `inbetween-queue-runner.ts` |
| committed | same record, `status: "committed"` | `runArdyClaimedFresh`, `ardy-queue.ts:354-390` |
| applied | same record, `status: "applied"` + `resulting_revision_id` | after `writeAhead.apply` |
| outcome | `.cclay/generate-outcomes|<id>.json` (or inbetween-outcomes): `succeeded`/`failed` | written BEFORE the claim and inputs are retired (`runArdyClaimed`) |

The queue machinery (`ardy-queue.ts`) is deliberately ignorant of every request field but
`request_id`: a queue is a directory pair + closed request/outcome schemas + an error
classifier + a handler. Two descriptor shapes: the legacy shape (regenerate queue keeps it
forever — its closed outcome union cannot carry new codes) and the write-ahead shape whose
handler is the generate-only kernel (runCli through commitGenerated, NO apply — the queue
is the single apply point, so a composite handler would commit a second revision on replay).

### Claim recovery and replay

- `recoverAbandonedGenerateClaims` / `recoverAbandonedInbetweenClaims` (`ardy-generate-queue.ts`,
  `ardy-inbetween-queue.ts`) re-queue claims a previous sweep left behind: a claim is NOT
  evidence the work did not happen, so each claim is checked against its recorded outcome
  first and merely retired when one exists; otherwise renamed back to `.json`
  (`ardy-queue.ts:recoverAbandonedArdyClaims`). Runs at startup and EVERY tick, so a sweep
  failure does not strand a request until restart (`generate-queue-runner.ts:120-127`,
  `inbetween-queue-runner.ts`).
- Replay (`runArdyClaimedReplay`, `ardy-queue.ts:400-450`): an `applied` record returns the
  RECORDED result verbatim with zero applies; `generated`/`committed` follow
  recover-read-commit-sweep-apply, with recovery FIRST (claim restore before any
  readability check) and the post-commit stale-claim sweep after `commitGenerated` makes
  the canonical bytes known-valid. A `committed` replay that re-applies after the first
  apply landed is rejected by the mutation boundary as REVISION_MISMATCH — at most one
  apply ever lands durably.
- `GENERATION_INTERRUPTED` (`ArdyInterruptedCommitError`, `ardy-queue.ts`) is terminal: a
  request consumed a generator run but neither its archive nor a claim survives; the
  operator must resubmit under a NEW request_id.

### The live-revision guard

Two independent bindings, both required (never optional with a fallback — the comments say
an optional freshness check that silently defaults is how the tautological context
comparison got in):

1. Service path: `ArdyGenerateService.generate` / `ArdyInbetweenService.inbetween` read
   `liveRevisionId()` fresh and throw `REVISION_MISMATCH` before the generator runs
   (`ardy-generate-service.ts`, `ardy-inbetween-service.ts`).
2. Queue path: the write-ahead descriptor's handler runs the same guard BEFORE the kernel
   executes, so a stale queued request makes ZERO wrapper invocations
   (`ardy-generate-queue.ts:134-150`, `ardy-inbetween-queue.ts`). The runners pass a live
   getter `liveRevisionId: () => bridge.revisionId`
   (`apps/cclay-extension/src/cclay/index.ts:118-147`).
3. Apply binding: `writeAhead.apply` dispatches `stageScene(applyMotionRequest(motionId,
   entity_id, expected_revision_id))` — the apply_motion op built by
   `ardy-queue-runner-shared.ts:73-90` — so the revision commit travels the same validated,
   committed path as every other mutation (`generate-queue-runner.ts:97-106`,
   `inbetween-queue-runner.ts`).

### Generation mechanics and host gate

- `ArdyMotionKernel` (`ardy-motion-kernel.ts`) is the ONE generation kernel shared by
  regenerate/generate/in-between: preflight -> argv -> `runCli` (execFile with argv array,
  cwd = project dir, 30-minute timeout — `ardy-queue-runner-shared.ts`) -> exit
  classification (stderr naming an unset `CCLAY_ARDY_HOST` or an `ssh:`/`scp:` client
  failure = `ARDY_HOST_UNAVAILABLE`, distinct from `GENERATION_FAILED`) -> last stdout line
  JSON parse -> capability result adapter -> `onGenerated` seam -> `commitGenerated`.
- `commitGenerated` (`ardy-archive-service.ts:395-463`) renames the staged archive to a
  `.claim` name, validates it, publishes the canonical copy, and unlinks the claim;
  `recoverGenerated` (:477+) restores the winning claim; `removeStaleGeneratedClaims`
  (:538+) runs only after a successful commit.
- In-between preflight fails BEFORE the wrapper: unreadable base archive ->
  `BASE_MOTION_NOT_FOUND`; missing synthetic pose -> `POSE_CAPTURE_FAILED`
  (`ardy-inbetween-service.ts:227-245`).
- The synthetic-pose orphan sweep `removeOrphanedSyntheticPoses`
  (`ardy-synthetic-poses.ts`) is fail-closed and its owner set covers BOTH queues
  (`ardy-regenerate-queue.ts:170-205`), because both mint the same `cclay-pose-` prefix
  into the same motions directory.
- Host-config gate: `isArdyHostConfigured` (`ardy-host-config.ts`, env `CCLAY_ARDY_HOST`
  non-empty); when absent, `ardy_generate`/`ardy_inbetween` are omitted from the tool set
  and their queue runners are not started (`session.ts:271-274`, `cclay/index.ts:88-94,
  118-147, 173-175`).
- The two tool descriptions carry the contact doctrine verbatim
  (`packages/blender-tools/src/ardy-generate.ts:21-22`, `ardy-inbetween.ts:21-22`): "A pose
  constraint proves skeleton placement, NOT sole contact".

## 6. `scene_frame` vs `clip_frame`: numbering, conversion site, who converts

- `scene_frame` is a Blender scene-timeline frame — the frame the pose was captured at,
  bounded to the product timeline the director can set (-100000..100000;
  `ardy-inbetween.ts:31-34`).
- `clip_frame` is the frame of the CONSTRAINED clip the generator will produce: the clip is
  always `ARDY_CONSTRAINED_DURATION_SECONDS_VALUE * ARDY_CLIP_FPS` = 12000 frames long, so
  `clip_frame` is 0..11999 (`ardy-inbetween.ts:13-15, 35`).
- The EXACT conversion site is
  `blender-addon/cclay/motion_constraints.py:291` inside
  `scene_frame_to_clip_frame` (:275-297):

  ```python
  clip_frame = int(scene_frame) - int(start_frame)
  ```

  Out-of-range inputs are rejected, never silently clamped (:278-281, :292-296). The rule
  is the affine mapping of the applied clip: `start_frame` is stamped on the action by
  apply_motion (`cclay.motion_id` / `cclay.motion_frames` / `cclay.motion_fps` /
  `cclay.motion_start_frame`), recovered by `base_clip_of` / `_resolve_start_frame`
  (`constraint_capture.py:596-663`; the lowest keyframe IS the start frame because
  apply_motion keys dense frames as `start_frame + offset`).
- Who converts: nobody computes one from the other at runtime. The model sends BOTH numbers
  in each `pose_frames` entry; three layers then verify they agree:
  1. the protocol parser enforces one constant offset `scene_frame - clip_frame`
     (`ardy-inbetween.ts:155-175`),
  2. the add-on's `parse_capture_evaluated_pose` enforces the same constant offset
     (`constraint_capture.py:1006-1015`),
  3. the add-on's `_require_pose_frame_mapping` re-derives each `clip_frame` with the exact
     function above and refuses a pair that contradicts THIS clip's `start_frame`
     (`constraint_capture.py:1026-1051`, calling `motion_constraints.scene_frame_to_clip_frame`
     at :1039-1045).
  The host consumes only `clip_frame` in the argv — `--constrain-pose <id> 0 <clip_frame>`
  (`ardy-inbetween-service.ts:160-175`) — with src-frame hardcoded `"0"` because the pose
  archives are single-frame.
- Where an off-by-one lands: `clip_frame` becomes the `--pose-from` dst-frame, validated
  remotely against `num_frames = int(duration * fps)`
  (`scripts/ardy/cclay_constrained_generate.py:491-519`, `_parse_frame` :428-436). A pair
  that violates the affine rule is REFUSED (add-on `POSE_FRAME_MAPPING_INVALID`, protocol
  `INVALID_ARDY_INBETWEEN_REQUEST`) — that case cannot reach the GPU. The dangerous case is
  a consistent-but-wrong offset (e.g. the model uses `scene_frame - start_frame + 1` for
  every entry): every check passes because the offset is constant, and every pose binds one
  frame off in the 12000-frame clip — the generator in-betweens toward keyframes at the
  wrong timestamps and nothing downstream reports it, because the full-body constraint is
  satisfied at the (wrong) dst-frame. The constant-offset rule makes the whole pose set
  shift together: the failure is a global timing shift of the pose track, not per-pose
  corruption. An off-by-one additionally reads the wrong base reference frame for the 19
  non-driven joints at capture time (`base_rotations[clip_frame]`,
  `constraint_capture.py:1263`).

## 7. What the in-between path CANNOT do

- **A captured pose proves skeleton placement, NOT sole/foot contact.** This is
  load-bearing repo doctrine; it appears in `blender-addon/cclay/motion_preflight.py:31-46`
  (SEMANTICS, CozyClay issue #2): every measurement is derived from `posed_joints` —
  SKELETON JOINT CENTERS, not the deformed mesh surface. `LeftFoot`/`RightFoot` are
  bone-space points; the offset from a foot joint to the visually-deformed sole is NOT
  constant (issue #2 measured roughly 0.11-0.17 m of variation across a single
  stair-climbing clip, driven by foot rotation); a zero constraint residual against a foot
  joint target is a joint-center accuracy statement only and says nothing about whether the
  sole touches its intended surface. The same wording is in
  `packages/blender-protocol/src/ardy-regenerate.ts:9-16` ("a zero or near-zero residual
  proves joint-center placement only, NOT sole/surface contact"), in the tool descriptions
  (`blender-tools/ardy-inbetween.ts:21-22`), and in `blender-addon/cclay/pose_contacts.py:4-19`
  (`surface_contact_verified` derives ONLY from the deformed sole point against declared
  support AABBs; joint position is carried as audit evidence and never substitutes). The
  in-between path's captured pose is exactly such a skeleton placement — it cannot establish
  that a foot is on the floor. Contact must be verified after apply with
  `inspect_pose_contacts` (deformed-mesh sole sampling, `stage_scene.py:813-816`) or
  rendered QA.
- **Joints the Blender rig has but cskel27 lacks are not captured at all.** The archive
  holds exactly the 27 `CSKEL27_JOINTS` (`motion_retarget.py:24-32`);
  `pose_local_rotations` iterates that list and nothing else. Extra mixamo bones (finger
  chains, toe detail — the rig has ~63 bones) never enter the pose, and the remote
  `FullBodyConstraintSet` pins only the 27 cskel27 joints (`remote:~/ardy/ardy/constraints.py:109-198`),
  so ARDY regenerates those extra joints freely. The reverse gap is handled explicitly:
  cskel27 joints the rig lacks (`Spine3` -> None, `RightHandEnd`/`LeftHandEnd` -> None,
  `MIXAMO_TARGETS`, `motion_retarget.py:38-52`) are not IK-driven and are carried verbatim
  from the base clip; Spine3 specifically is folded into mixamo Spine2 by the retarget and
  cannot be split back out (`constraint_capture.py:455-462`; the driven set is 25 bones,
  `ik_chains.py:16-32`).
- The constrained pass always regenerates the WHOLE 600 s / 12000-frame clip from the base;
  there is no partial or per-segment in-between (`ARDY_CONSTRAINED_DURATION_SECONDS_VALUE`,
  `ardy-inbetween.ts:33`). Poses only pin their declared frames; everything between is the
  sampler's synthesis.
- `ardy_generate` (the first pass) carries NO constraints at all — the wrapper rejects the
  combinations (`scripts/cclay-ardy-generate:228-235`), so its outcome is prompt-only and
  nothing in it is contact-verified.
- `ardy_inbetween` cannot run without a base motion already staged and every synthetic pose
  already captured: the preflight fails as `BASE_MOTION_NOT_FOUND` / `POSE_CAPTURE_FAILED`
  before any GPU run (`ardy-inbetween-service.ts:227-245`).
- The result reports `dropped_constraints: []` unconditionally because the protocol pins
  `clip_frame <= 11999` — structurally inside the 12000-frame clip — unlike regenerate,
  whose request schema leaves constraint frames unbounded
  (`ardy-inbetween-service.ts:63-66`).
- A base motion at a different fps than the clip is refused at capture (fps check,
  `constraint_capture.py:1217-1225`); the in-between clip is 20 fps by protocol constant.
- The captured pose does not observe the deformed MESH: `_effective_basis` reads evaluated
  BONE transforms and the Hips head only; weight deformation and the sole surface are
  outside this path entirely.

## Open questions / unverified

- **Host-side caller of `capture_evaluated_pose` is not wired in the visible tree.**
  The bridge method exists add-on-side and is dispatched at `connection.py:1403-1417`, but
  there is no model-facing tool for it and no runner invokes it: the only mentions in
  `apps/cclay-extension/src/` and `packages/director-runtime/src/` are comments saying the
  in-between service "never captures" (`ardy-inbetween-service.ts:13`) and derives the pose
  ids instead. UNVERIFIED: how a production director drives the capture before submitting
  the in-between request.
- Runtime behavior was not exercised: I could not run Blender, the queue/crash-matrix
  suites, or any generation (the GPU box is read-only and running `scripts/generate.py`
  or `cclay_constrained_generate.py` is forbidden). Claims about live behavior rest on the
  code, the committed tests, and static inspection of the box.
- The box's model runtime (`.venv`, weights, `model.motion_rep.fps`) was not loaded;
  `ARDY_CLIP_FPS = 20` is a protocol constant and the wrapper asserts "ARDY Core is 20 fps"
  (`scripts/cclay-ardy-generate:38`), but the actual `fps` a live model reports is
  UNVERIFIED.
- The end-to-end in-between QA scenario (five alternating-foot key poses -> base clip ->
  in-between clip -> deformed sole verification) was human-blocked on an authenticated GPU
  host and never produced (ledger G011/G012, `.gjc/ultragoal/ledger.jsonl`).
- `measure_poses`' full per-pose report fields beyond `root_error_m` were truncated during
  inspection of `remote:~/ardy/scripts/cclay_constrained_generate.py:821-860`; the result
  vocabulary consumed by the bridge is `continuity` + `dropped_constraints`, both schema
  pinned, so the gap is informational only.
- `upstream-patches/0001-cclay-demo-integration.patch` and `interactive_demo/` exist and
  are described in `scripts/ardy/README.md`, but their content was not audited for this
  doc; they are unrelated to the pose-capture path except that the box carries them.
