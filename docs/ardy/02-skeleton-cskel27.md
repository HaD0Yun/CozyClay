# cskel27: the ARDY core skeleton and how cclay maps it onto a Blender armature

ARDY's "core" model animates a fixed 27-joint skeleton named `cskel27`; every ARDY motion npz that cclay consumes carries per-frame local rotations and global joint positions indexed by that fixed joint order. The authoritative definition is `CoreSkeleton27.bone_order_names_with_parents` in `remote:~/ardy/ardy/skeleton/definitions.py:348-380`, and the same 27 names in the same order are duplicated as the shipped binary asset `skin_standard.npz`'s `rig_joint_names` array (verified equal, `remote:~/ardy/ardy/viz/core_skin.py:82-84` asserts equality). cclay mirrors the order in `CSKEL27_JOINTS` (`blender-addon/cclay/motion_retarget.py:22-32`) and retargets onto a Mixamo-format Blender armature by change of basis per bone: 24 of the 27 joints map 1:1 to mixamo bones (`MIXAMO_TARGETS`, `blender-addon/cclay/motion_retarget.py:38-52`), `Spine3` is composed into the rig's `Spine2`, and the two `HandEnd` leaves have no bone to write to and are dropped. Everything ARDY can author is a subset of those 27 joints; the cclay rigs (vendored `y-bot-tpose.fbx` / `x-bot-tpose.fbx`) carry 66 `mixamorig:`-prefixed bone names, of which 42 — every finger joint past `Thumb1` per side, both `Toe_End` bones, and two helper bones — are structurally unrepresentable in cskel27 and therefore can never be authored by ARDY (cclay fills the fingers itself via hand-shape presets at apply time). The joint vocabulary cclay exposes to the generation model is even narrower: exactly `LeftFoot RightFoot LeftHand RightHand` for end-effector constraints, enforced identically in `scripts/cclay-ardy-generate:118-121` and in the remote `scripts/ardy/cclay_constrained_generate.py:86`.

## 1. The cskel27 joint list: names, order, and hierarchy

**Authoritative definition.** `remote:~/ardy/ardy/skeleton/definitions.py:338` declares `class CoreSkeleton27(SkeletonBase)`; its `bone_order_names_with_parents` list (`definitions.py:348-380`) is the 27-entry `(joint, parent)` table below. The skeleton is dispatched by joint count in `remote:~/ardy/ardy/skeleton/registry.py:39`: `nbjoints == 27` -> `CoreSkeleton27(assets_folder / "cskel27")`.

**Index order is defined here, and enforced everywhere by construction.** `SkeletonBase.__init__` (`remote:~/ardy/ardy/skeleton/base.py`) derives the canonical order and its inverse:

- `self.bone_order_names = [x for x, y in self.bone_order_names_with_parents]` — `base.py:84`
- `self.bone_index = {x: idx for idx, x in enumerate(self.bone_order_names)}` — `base.py:87`
- a `joint_parents` index tensor is built from the same list (`base.py:91-94`), and `root_idx` is the single `-1` parent (`base.py:103-105`); `nbjoints = 27` (`base.py:96`).

Every downstream consumer indexes arrays with `bone_index`: FK/constraints (`remote:~/ardy/ardy/constraints.py:245-248`), the constrained generator (`scripts/ardy/cclay_constrained_generate.py:685, 895`, `skeleton.bone_index[target["joint"]]`), and the demo skin collapse (`scripts/ardy/interactive_demo/mixamo_avatar.py:133-135`). On the cclay side the identical order is hard-coded as `CSKEL27_JOINTS` with `JOINT_INDEX = {name: index ...}` (`blender-addon/cclay/motion_retarget.py:22-33`), and payload validation requires exactly 27 joints: `local_rot_mats` shape `(F, 27, 3, 3)` and `posed_joints` shape `(F, 27, 3)` (`blender-addon/cclay/motion_retarget.py:254-260`). `blender-addon/cclay/motion_preflight.py:6` restates it: "posed_joints array (frames x 27 x 3, cskel27, Hips = joint 0)". The concrete foot indices are asserted in `blender-addon/tests/test_motion_preflight_pure.py:738`: `FOOT_CONTACT_JOINT_INDICES == (25, 26, 21, 22)` (LeftFoot, LeftToeBase, RightFoot, RightToeBase; `blender-addon/cclay/motion_preflight.py:80-89`).

The table (index = position in `bone_order_names` / `local_rot_mats[:, i]`; parent from `bone_order_names_with_parents`, cross-checked against the shipped `rig_joint_connections` edge list in `remote:~/ardy/ardy/assets/skeletons/cskel27/skin_standard.npz`):

| idx | joint | parent | mixamo target (cclay `MIXAMO_TARGETS`) | notes |
|---|---|---|---|---|
| 0 | `Hips` | — | `Hips` | root; driven as a location track, not a rotation |
| 1 | `Spine` | `Hips` | `Spine` | |
| 2 | `Spine1` | `Spine` | `Spine1` | |
| 3 | `Spine2` | `Spine1` | `Spine2` | absorbs `Spine3`'s rotation at retarget |
| 4 | `Spine3` | `Spine2` | *none* | composed into `Spine2` (`blender-addon/cclay/motion_retarget.py:429-430`) |
| 5 | `Neck` | `Spine3` | `Neck` | |
| 6 | `Head` | `Neck` | `Head` | |
| 7 | `RightShoulder` | `Spine3` | `RightShoulder` | |
| 8 | `RightArm` | `RightShoulder` | `RightArm` | |
| 9 | `RightForeArm` | `RightArm` | `RightForeArm` | |
| 10 | `RightHand` | `RightForeArm` | `RightHand` | end effector |
| 11 | `RightHandEnd` | `RightHand` | *none* | leaf; no mixamo counterpart, dropped |
| 12 | `RightHandThumb1` | `RightHand` | `RightHandThumb1` | |
| 13 | `LeftShoulder` | `Spine3` | `LeftShoulder` | |
| 14 | `LeftArm` | `LeftShoulder` | `LeftArm` | |
| 15 | `LeftForeArm` | `LeftArm` | `LeftForeArm` | |
| 16 | `LeftHand` | `LeftForeArm` | `LeftHand` | end effector |
| 17 | `LeftHandEnd` | `LeftHand` | *none* | leaf; no mixamo counterpart, dropped |
| 18 | `LeftHandThumb1` | `LeftHand` | `LeftHandThumb1` | |
| 19 | `RightUpLeg` | `Hips` | `RightUpLeg` | thigh; the cclay scale reference |
| 20 | `RightLeg` | `RightUpLeg` | `RightLeg` | thigh; the cclay scale reference |
| 21 | `RightFoot` | `RightLeg` | `RightFoot` | end effector |
| 22 | `RightToeBase` | `RightFoot` | `RightToeBase` | |
| 23 | `LeftUpLeg` | `Hips` | `LeftUpLeg` | |
| 24 | `LeftLeg` | `LeftUpLeg` | `LeftLeg` | |
| 25 | `LeftFoot` | `LeftLeg` | `LeftFoot` | end effector |
| 26 | `LeftToeBase` | `LeftFoot` | `LeftToeBase` | |

Ordering structure: torso chain (0-6), right arm (7-12), left arm (13-18), right leg (19-22), left leg (23-26) — `definitions.py:348-380`. Both shoulders parent to `Spine3` (`definitions.py:358, 365`); `HandEnd` and `Thumb1` both parent to `Hand` (`definitions.py:362-363, 369-370`). Semantic groups for constraints: `right_foot_joint_names = ["RightFoot", "RightToeBase"]`, `left_foot_joint_names = ["LeftFoot", "LeftToeBase"]`, `right_hand_joint_names = ["RightHand", "RightHandEnd"]`, `left_hand_joint_names = ["LeftHand", "LeftHandEnd"]`, `hip_joint_names = ["RightUpLeg", "LeftUpLeg"]` — `definitions.py:342-346`.

## 2. Rest/bind pose and `fist_bind_vertices.npy`

**Rest pose.** `SkeletonBase.__init__` loads `joints.p` from the skeleton folder as the `neutral_joints` buffer (`remote:~/ardy/ardy/skeleton/base.py:72`). Measured on the box: `ardy/assets/skeletons/cskel27/joints.p` is a `(27, 3)` float64 tensor in exactly the `bone_order_names` order, row 0 (`Hips`) = `[0.0, 0.0, 0.0]`, row 26 (`LeftToeBase`) = `[0.0949, -0.9544, 0.1607]`. `base.py:108` asserts `(self.neutral_joints[0] == 0).all()`, and `base.py:101` asserts `nbjoints == len(neutral_joints)`. The cskel27 asset folder contains only three files — `joints.p`, `skin_standard.npz`, `fist_bind_vertices.npy` — with no `bvh_joints.p` and no `standard_t_pose_global_offsets_rots.p` (which `base.py:75-81` would load if present), so `neutral_joints` alone is the rest pose.

**Bind pose / skin.** `CoreSkin` (`remote:~/ardy/ardy/viz/core_skin.py:50-84`) loads `skin_standard.npz` (`SKIN_NAME`, `core_skin.py:13`) from the skeleton folder and consumes: `bind_rig_transform` `(27, 4, 4)` (per-joint bind rig transforms), `bind_vertices` `(V, 3)`, `faces` `(F, 3)`, `lbs_indices`/`lbs_weights` `(V, 5)` (max 5 joints per vertex), `rig_joint_names` `(27,)`, `rig_joint_connections` `(26, 2)`. Measured on the box: `bind_vertices (9084, 3)`, `faces (18152, 3)`, `bind_rig_transform (27, 4, 4) float32`, `lbs_indices/lbs_weights (9084, 5)`, `rig_joint_names (27,)` matching the table above exactly, `rig_joint_connections (26, 2)` matching the parent edges. `core_skin.py:82-84` walks `zip(self.skeleton.bone_order_names, rig_joint_names)` and raises `SkinRigMismatchError` on any mismatch — this is the hard cross-check that the binary asset and the code definition cannot drift apart.

**`fist_bind_vertices.npy`.** A same-topology alternative bind mesh for the closed-hand pose: measured `(9084, 3)` float32 — identical shape to `bind_vertices`. `CoreSkin` resolves it purely by filename: `FIST_BIND_VERTICES_NAME = "fist_bind_vertices.npy"` (`core_skin.py:14`), located as `skin_data_path.with_name(FIST_BIND_VERTICES_NAME)` (`core_skin.py:72`), i.e. it must sit beside `skin_standard.npz` in the skeleton folder. It is used only when the env var `ARDY_CORE_HAND_POSE` equals the literal `fist` (`core_skin.py:69`); `apply_fist_pose` (`core_skin.py:39-43`) swaps it in for `bind_vertices` and raises `FistPoseShapeError` on shape mismatch. `scripts/ardy/README.md:31` documents this dependency: "`ardy/viz/core_skin.py` resolves `fist_bind_vertices.npy` by filename, so the patch is inert without the file beside it". The demo viewer mirrors the same env-var switch for its private avatar meshes (`scripts/ardy/interactive_demo/mixamo_avatar.py:117-119`), and the upstream tests exercise both states (`remote:~/ardy/tests/test_mixamo_avatar.py:24`, `remote:~/ardy/tests/test_yun_cpu_runner.py:23`). The GPU box's `cskel27` folder carries the file (`remote:~/ardy/ardy/assets/skeletons/cskel27/fist_bind_vertices.npy`, 109136 bytes); the repo copy is `scripts/ardy/assets/skeletons/cskel27/fist_bind_vertices.npy`.

## 3. How cclay maps cskel27 onto the live Blender rig

**`CharacterRigAdapter`** — `blender-addon/cclay/character_rig.py:8-43`, a read-only "cskel27-to-character-rig lookup and scale adapter":

- `__init__` (`character_rig.py:11-13`): auto-detects the rig's name prefix — `"mixamorig:"` if any bone name starts with it, else `""`. So the adapter works identically on a stock Mixamo import (`mixamorig:Hips`, `mixamorig:LeftFoot`, ...) and on an unprefixed rig of the same names.
- `rig_thigh` (`character_rig.py:16-21`): `(bones["{prefix}RightLeg"].head_local - bones["{prefix}RightUpLeg"].head_local).length`; returns `None` when either bone is missing. This is the failure the preflight surfaces: `blender-addon/cclay/motion_preflight.py:389-391` — `_invalid(f"entity {entity_id} rig is missing the RightUpLeg/RightLeg bones")`.
- `rest_rotations` (`character_rig.py:23-31`): for every cskel joint whose `MIXAMO_TARGETS` entry is non-`None` and present on the rig, the bone's armature-space rest rotation `matrix_local.to_3x3()` keyed by cskel joint name.
- `hips_head` (`character_rig.py:33-35`): `{prefix}Hips` head in local space.
- `authored_bone_names` (`character_rig.py:37-43`): the rig bone names (`{prefix}{MIXAMO_TARGETS[cskel]}`) that exist as pose bones for a given track set — used to bound which channels `apply_motion` captures.

**Retarget math** (`blender-addon/cclay/motion_retarget.py:1-17` module docstring): cskel27 uses mixamo bone names (unprefixed) and shares the mixamo T-pose, so each frame's local rotation is converted per bone with `basis = Rb^T @ L @ Rb` (Rb = target bone rest rotation) — no hierarchy recursion. The only structural differences: `Spine3` is multiplied into the `Spine2` frame rotation (`motion_retarget.py:429-430`), and the `HandEnd` leaves are dropped (`MIXAMO_TARGETS` has `None` for them, `motion_retarget.py:38-52`). The retarget is executed by `PoseTrackBuilder` (`motion_retarget.py:384-445`), which also converts each rotation to a wxyz quaternion and computes `hips_locations` (hips local-space offsets) from `posed_joints` scaled by `scale`.

**Scale** (`derive_scale`, `motion_retarget.py:347-359`): meters-per-npz-unit = `rig_thigh_length / npz_thigh`, where `npz_thigh` is the frame-0 distance between `posed_joints[RightUpLeg]` and `posed_joints[RightLeg]` (`JOINT_INDEX` lookups). Preflight folds the object's uniform world scale into this so the reported scale is real-world meters (`motion_preflight.py:339-398`; the fix for CozyClay issue #2's ~98.5x error is documented at `motion_preflight.py:346-352`).

**The `apply_motion` path** (`blender-addon/cclay/stage_scene.py:1408-1591`): validates the rig's hand bones (`stage_scene.py:1422-1427` via `hand_shapes.validate_rig_bones`), loads and cursor-validates the npz (`stage_scene.py:1429-1440`; Y-up check at `motion_retarget.py:318-326`, fps bounds 1..240, `MAX_FRAMES = 24000`, payload cap 96 MiB at `motion_retarget.py:54-56`), then builds `CharacterRigAdapter(scene_object.data.bones)` (`stage_scene.py:1456`), requires `Hips`, `RightUpLeg`, `RightLeg` present in `rest_rotations` (`stage_scene.py:1459-1463`), derives scale from `rig.rig_thigh` (`stage_scene.py:1465`), and runs `PoseTrackBuilder` (`stage_scene.py:1466-1472`). Tracks are written as `rotation_quaternion` fcurves per driven bone (`stage_scene.py:1537-1573`) and `location` fcurves for `{prefix}Hips` (`stage_scene.py:1575+`); hand-shape deltas are composed onto the digit bones at apply time (`stage_scene.py:1525-1553`). The captured channel set is `authored_bone_names + {prefix}Hips + digit bones` (`stage_scene.py:1487-1491`). One npz frame is baked per scene frame and the motion rate must agree with the scene rate, because "ARDY Core is 20 fps" (`stage_scene.py:1350-1351`). `constraint_capture.py` reuses the same adapter for pose capture (`blender-addon/cclay/constraint_capture.py:690-698`: `rig_thigh` + `derive_scale` + `bone_offsets`).

**Against a Mixamo rig** named `mixamorig:Hips`, `mixamorig:LeftFoot`, `mixamorig:LeftToeBase`, etc., the adapter's prefix detection (`character_rig.py:13`) makes every lookup `mixamorig:`-prefixed, which is exactly what the bundled rigs are: `stage_scene.py:62-65` maps `Y_BOT -> y-bot-tpose.fbx`, `X_BOT -> x-bot-tpose.fbx`, imported from `blender-addon/cclay/assets/characters/` (`stage_scene.py:598-620`), and the calibration JSON records `"bone_prefix": "mixamorig:"` for both (`blender-addon/calibration/hand-shapes-v1.json:41, 250`). Tests exercise the same surface with `mixamorig:`-prefixed bones (`blender-addon/tests/test_motion_preflight_pure.py:438-443, 481-483`).

## 4. Rig joints cskel27 cannot drive — and the reverse

**Rig inventory (measured).** A byte-level scan of the vendored FBX files (`blender-addon/cclay/assets/characters/y-bot-tpose.fbx`, `x-bot-tpose.fbx`; both Blender FBX 7700) for distinct `mixamorig:` name strings yields 66 names per character, identical across both:

- spine/torso: `Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`, `HeadTop_End`, `Hips_skin`
- arms: `Left/RightShoulder`, `Left/RightArm`, `Left/RightForeArm`, `Left/RightHand`
- fingers (per side): `Thumb1-4`, `Index1-4`, `Middle1-4`, `Ring1-4`, `Pinky1-4`
- legs: `Left/RightUpLeg`, `Left/RightLeg`, `Left/RightFoot`, `Left/RightToeBase`, `Left/RightToe_End`

No twist/roll bones (`*ArmRoll`, `*ForeArmRoll`, `*UpLegRoll`, `*LegRoll`, `*FootRoll`) exist in the shipped rigs — the scan finds none — so the "twist-bone" question is moot for cclay's own characters (a stock Mixamo "with twist" export would add them, but nothing in cclay consumes such names).

**Rig names present in the rig but ABSENT from cskel27 — 42 of 66 (ARDY can never author these):**

- 38 finger joints: `Thumb2`, `Thumb3`, `Thumb4`, `Index1-4`, `Middle1-4`, `Ring1-4`, `Pinky1-4` per side. cskel27 has only `LeftHandThumb1`/`RightHandThumb1` and the skin-leaf `HandEnd` per side (`definitions.py:344-345`); no Index/Middle/Ring/Pinky chain exists at all. cclay drives these itself with deterministic presets at apply time, not with ARDY data: `hand_shapes.CANONICAL_ROLES` is the 20-role-per-side list `Thumb1..4, Index1..4, Middle1..4, Ring1..4, Pinky1..4` (`blender-addon/cclay/hand_shapes.py:14-20`), `validate_rig_bones` requires all 40 present or fails (`hand_shapes.py:171-200`), and `stage_scene.py:1487-1491` adds the digit names to the captured channels.
- 2 toe ends: `LeftToe_End`, `RightToe_End`. cskel27's leg chains end at `ToeBase` (`definitions.py:342-343, 379-380`), so toe articulation beyond the base cannot be authored.
- 2 helpers: `HeadTop_End`, `Hips_skin` (standard Mixamo helper/skin bones; present in the FBX byte stream — whether Blender treats `Hips_skin` as an animated bone is not verified node-level, see Open questions).

**cskel27 joints ABSENT from the rig — 3 of 27 (authored by ARDY but unmappable):**

- `Spine3` — the rig has no `mixamorig:Spine3`; its rotation is folded into `mixamorig:Spine2` (`blender-addon/cclay/motion_retarget.py:429-430`).
- `RightHandEnd`, `LeftHandEnd` — skin leaves with no mixamo bone; they exist in the npz (and condition the hand end-effector position via `expand_joint_names`, `remote:~/ardy/ardy/skeleton/base.py:130-168`) but no bone receives their rotation.

**What ARDY structurally can never author on cclay's rigs:** finger curl/spread beyond a single thumb base (the other 19 finger joints per side are not representable in the 27-joint model), toe articulation past `ToeBase`, twist/roll channels (none exist in either side), and a neck/chest joint (`ik_chains.py:103-106` notes cskel27 has neither `Neck1` nor `Chest`). The demo's own skin collapse draws the same boundary on the ARDY side: `_MIXAMO_TO_CORE` (`scripts/ardy/interactive_demo/mixamo_avatar.py:25-51`) maps `Spine2 -> Spine3`, `RightToe_End -> RightToeBase`, `HeadTop_End -> Head`, and `_core_joint_name` (`mixamo_avatar.py:99-111`) folds every `RightHandThumb*` to `RightHandThumb1`, every other `RightHand*` to `RightHandEnd`, and anything unmatched to `Hips`.

**Feet note:** cclay's preflight/pose-contact measurements do use the four foot joints ARDY does author — `FOOT_CONTACT_CHANNELS` = `(left_heel, LeftFoot), (left_toe, LeftToeBase), (right_heel, RightFoot), (right_toe, RightToeBase)` (`blender-addon/cclay/motion_preflight.py:80-85`), indices `(25, 26, 21, 22)` (`motion_preflight.py:86-89`, asserted in `test_motion_preflight_pure.py:738`) — but `stage_scene.py:742-750` warns these skeleton joints must not be treated as sole-contact markers.

## 5. The joint-name vocabulary exposed to the model

**Wrapper side (`scripts/cclay-ardy-generate`).** Only `--constrain` (position) and `--constrain-orient` (orientation) take a joint name, and only four names are accepted: the usage text states "joint is one of LeftFoot RightFoot LeftHand RightHand" (`scripts/cclay-ardy-generate:57`), and the parser enforces it in the `case` statements at `scripts/cclay-ardy-generate:118-121` (`--constrain`) and `133-136` (`--constrain-orient`) — anything else prints the usage and exits 2. `--constrain-path` and `--constrain-pose` take no joint name at all (root XZ waypoint / full-body pose copy, `scripts/cclay-ardy-generate:179-189, 167-178`). Clip frames are additionally bounded to `0 <= frame < int(duration * 20)` (ARDY Core 20 fps) before any ssh (`scripts/cclay-ardy-generate:244-298`), and orientations require a matching position target at the same `(frame, joint)` (`scripts/cclay-ardy-generate:299-325`).

**Remote side (`scripts/ardy/cclay_constrained_generate.py`, synced to the box before each run — `scripts/cclay-ardy-generate:350-362`).** The vocabulary is declared as `JOINT_TO_CONSTRAINT = ("LeftFoot", "RightFoot", "LeftHand", "RightHand")` (`scripts/ardy/cclay_constrained_generate.py:86`), resolved to ARDY constraint classes in `_joint_constraint_classes` (`:89-102`), and enforced in `parse_targets` (`:407-425`: "--target joint must be one of {sorted(JOINT_TO_CONSTRAINT)}") and `parse_orientations` (`:461-488`). A further guard checks the names against the loaded model's skeleton: `this model's skeleton has no joint(s) {unknown}; constrained generation needs {sorted(JOINT_TO_CONSTRAINT)}` (`:1008-1015`).

**ARDY library side.** The four end-effector constraint classes are `LeftHandConstraintSet`/`RightHandConstraintSet`/`LeftFootConstraintSet`/`RightFootConstraintSet` (`remote:~/ardy/ardy/constraints.py:382-412`), each with `joint_names = ["<effector>", "Hips"]`. `SkeletonBase.expand_joint_names` (`remote:~/ardy/ardy/skeleton/base.py:130-168`) hard-codes the same base list `["LeftFoot", "RightFoot", "LeftHand", "RightHand", "Hips"]` (`base.py:141`) and expands each effector to its chain: a foot target conditions position on `[Foot, ToeBase]` and rotation on `[Foot]`; a hand target conditions position on `[Hand, HandEnd]` and rotation on `[Hand]`; `Hips` (pelvis) rides along (`base.py:142-167`). So the model-facing vocabulary is a strict subset of cskel27: the other 23 joints can never be constrained directly.

## Open questions / unverified

- The 66-name rig inventory is a regex scan of the vendored FBX byte streams for `mixamorig:` strings, not a full FBX node parse; I could not verify at Model-node level which of `Hips_skin`, `HeadTop_End`, `Left/RightToe_End` are treated as animated bones by Blender's importer vs. skin/geometry helpers. The classification of the first two as "helpers" is inferred from their names and from the demo's collapse map (`scripts/ardy/interactive_demo/mixamo_avatar.py:25-51`), not verified.
- `blender-addon/cclay/ik_chains.py:4` and `:18` claim "every one of the 25 driven bones" / "the driven set is 25 bones", but `MIXAMO_TARGETS` has only 24 non-`None` rotation targets (`blender-addon/cclay/motion_retarget.py:38-52`). The most consistent reading is 24 rotation-driven bones plus `Hips`, which is driven as a location track (`stage_scene.py:1575+`); the comment's wording is unverified against any explicit 25-name list.
- ARDY Core being exactly 20 fps is asserted only in cclay's own code (`blender-addon/cclay/stage_scene.py:1351`, `scripts/cclay-ardy-generate:38, 244-265`) and implied by the model folder names `ARDY-Core-RP-20FPS-Horizon40`/`Horizon8` (`remote:~/ardy/ardy/model/registry.py:25-26`) plus `fps = model.motion_rep.fps` (`remote:~/ardy/scripts/generate.py:189`, `scripts/ardy/cclay_constrained_generate.py:975`); I did not find a literal `fps = 20` assignment in the model code.
- The exact vertex count of `bind_vertices`/`fist_bind_vertices.npy` (9084) and the rig transforms were measured with numpy/torch on the GPU box (read-only) and in the repo copy; I did not verify the LBS weights' per-vertex joint distribution beyond the documented max of 5 (`remote:~/ardy/ardy/viz/core_skin.py:61` comment).
