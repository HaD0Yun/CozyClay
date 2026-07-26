"""Blender-facing capture of ARDY constraints marked on the IK layer.

``motion_constraints`` holds the math and stays bpy-free so it can be unit
tested on plain CPython; this module is its single Blender-facing consumer, the
same split ``ik_chains``/``ik_rig`` already use.

The problem this solves is telling a DELIBERATE constraint apart from the dense
bake. ``ik_rig.attach`` keys every control bone's location on every frame of the
clip, so the location curves cannot say which frames the animator actually
meant. A separate boolean custom property, keyed only when the animator commits
a constraint, carries that intent: the frames on ``cclay_constraint`` ARE the
constraint list, and the location curves are read only at those frames.

Nothing here talks to ARDY. The capture ends at a request file under
``.cclay/regenerate-requests/``; running the generator is the host's job, which
is what keeps the add-on free of shell and network access.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import tempfile
import uuid

from . import ik_chains, motion_constraints, motion_retarget

try:  # pragma: no cover - exercised inside Blender
    import bpy  # type: ignore
except ImportError:  # pragma: no cover - importable outside Blender
    bpy = None  # type: ignore

# The property is a marker, not a value: it exists to be keyed. Blender needs a
# concrete value to key, so it carries 1.0 and nobody should read it.
CONSTRAINT_MARKER = "cclay_constraint"
HEADING = "cclay_heading"
HEADING_FREE = "cclay_heading_free"

REQUEST_DIRECTORY = "regenerate-requests"
OUTCOME_DIRECTORY = "regenerate-outcomes"
# Stamped on the armature when a request is published. Regeneration replaces
# the action, which takes the marker curves with it, so the frames the animator
# committed have to survive somewhere that is not the action. Without this the
# constraints silently vanish the moment the new clip lands and the animator
# has to re-mark everything to make a second pass.
PENDING_PROPERTY = "cclay.regenerate_request"
REQUEST_SCHEMA_VERSION = 1

# The same slug grammar stage_scene enforces for apply_motion, applied to the
# synthetic pose archives written here so a full-body constraint cannot name a
# motion the bridge would later reject.
_MOTION_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")

# Request ids are uuid4 hex and are used directly as filenames. Checking the
# shape where they are consumed stops a hand-edited pending property from
# steering a read out of the queue directory: pathlib lets an absolute path
# replace the join outright, so "/etc/passwd" would otherwise be opened and
# only rejected afterwards by the id comparison inside validate_outcome.
_REQUEST_ID = re.compile(r"[0-9a-f]{32}")


def _require_request_id(request_id) -> str:
    if not isinstance(request_id, str) or _REQUEST_ID.fullmatch(request_id) is None:
        raise ConstraintCaptureError(f"malformed regeneration request id {request_id!r}")
    return request_id

# Constraint kind -> the bone whose marker curve records it. End-effector kinds
# reuse the IK handle the animator already drags, so committing a constraint
# needs no second selection.
ANCHOR_BY_KIND = {
    "LeftHand": ik_chains.target_bone_name("LeftHand"),
    "RightHand": ik_chains.target_bone_name("RightHand"),
    "LeftFoot": ik_chains.target_bone_name("LeftFoot"),
    "RightFoot": ik_chains.target_bone_name("RightFoot"),
    "FullBody": ik_chains.FULLBODY_ANCHOR,
    "Root2D": ik_chains.ROOT2D_ANCHOR,
}
EFFECTOR_KINDS = ("LeftHand", "RightHand", "LeftFoot", "RightFoot")


class ConstraintCaptureError(RuntimeError):
    """The rig cannot carry constraints, or a request cannot be written."""


def _require_pose_bone(armature, bone_name: str):
    pose_bone = armature.pose.bones.get(bone_name)
    if pose_bone is None:
        raise ConstraintCaptureError(
            f"{bone_name} is missing; attach the IK layer before marking constraints"
        )
    return pose_bone


def mark_constraint(armature, kind: str, frame: int) -> str:
    """Commit a constraint of ``kind`` at ``frame``; return the anchor bone name."""
    if kind not in ANCHOR_BY_KIND:
        raise ConstraintCaptureError(f"unknown constraint kind {kind!r}")
    bone_name = ANCHOR_BY_KIND[kind]
    pose_bone = _require_pose_bone(armature, bone_name)
    pose_bone[CONSTRAINT_MARKER] = 1.0
    pose_bone.keyframe_insert(f'["{CONSTRAINT_MARKER}"]', frame=frame)
    if kind in EFFECTOR_KINDS or kind == "Root2D":
        # The value the constraint carries lives on the location curve, which
        # attach() already keys densely; re-keying it here makes the committed
        # frame authoritative even if the animator later scrubs without keying.
        pose_bone.keyframe_insert("location", frame=frame)
    return bone_name


def clear_constraint(armature, kind: str, frame: int) -> None:
    """Drop the marker key for ``kind`` at ``frame`` if one is present."""
    if kind not in ANCHOR_BY_KIND:
        raise ConstraintCaptureError(f"unknown constraint kind {kind!r}")
    pose_bone = _require_pose_bone(armature, ANCHOR_BY_KIND[kind])
    try:
        pose_bone.keyframe_delete(f'["{CONSTRAINT_MARKER}"]', frame=frame)
    except RuntimeError:
        return


def _marker_data_path(bone_name: str) -> str:
    return f'pose.bones["{bone_name}"]["{CONSTRAINT_MARKER}"]'


def _action_fcurves(action):
    """Every F-curve on an action, across both action layouts.

    Blender 4.4+ keeps curves in layered channelbags while older actions expose
    them directly, and ``apply_motion`` may have produced either.
    """
    found = []
    if hasattr(action, "layers") and len(action.layers):
        for layer in action.layers:
            for strip in layer.strips:
                for bag in getattr(strip, "channelbags", ()):
                    found.extend(bag.fcurves)
    found.extend(getattr(action, "fcurves", ()))
    return found


def _fcurves(armature):
    animation_data = armature.animation_data
    if animation_data is None:
        return []
    action = animation_data.action
    if action is None:
        return []
    return _action_fcurves(action)


def marked_frames(armature, kind: str) -> list[int]:
    """Scene frames where ``kind`` carries a committed constraint, sorted."""
    if kind not in ANCHOR_BY_KIND:
        raise ConstraintCaptureError(f"unknown constraint kind {kind!r}")
    wanted = _marker_data_path(ANCHOR_BY_KIND[kind])
    frames: set[int] = set()
    for curve in _fcurves(armature):
        if curve.data_path == wanted:
            frames.update(int(round(point.co[0])) for point in curve.keyframe_points)
    return sorted(frames)


def _effective_basis(armature, pose_bone, bone):
    """The bone's basis matrix WITH constraints applied.

    ``pose_bone.matrix_basis`` is the keyed transform before constraints, so it
    cannot see an IK solve -- reading it makes a dragged handle collect as if
    the animator had never touched it, which is exactly the failure this
    function exists to avoid. ``pose_bone.matrix`` is the evaluated result in
    armature space, so the basis is recovered by removing the rest chain from
    it. For a parented bone the rest chain includes the parent's evaluated
    matrix, which is how Blender composes pose space in the first place.
    """
    rest = bone.matrix_local
    parent = pose_bone.parent
    if parent is None:
        return rest.inverted() @ pose_bone.matrix
    chain = parent.matrix @ parent.bone.matrix_local.inverted() @ rest
    return chain.inverted() @ pose_bone.matrix


# The only joints an IK edit can rotate. ik_rig bakes with exactly this set for
# the same reason: the constraints drive the chain bones and nothing else.
IK_DRIVEN_JOINTS = frozenset(
    bone for chain in ik_chains.IK_CHAINS for bone in chain.bones()
)


def pose_local_rotations(armature, base_rotations=None) -> list[list[list[float]]]:
    """The current pose as ARDY local rotations, one per cskel27 joint.

    Inverts the retarget that produced the pose (``basis = Rb^T @ L @ Rb``), so
    an IK edit the animator made in the viewport comes back out in the
    representation ARDY consumes.

    ``base_rotations`` is the clip's own rotations for this frame. When given,
    only the IK-driven joints are taken from the pose and the rest are kept
    verbatim. That is not an optimisation: the mixamo rig has no Spine3 bone,
    so the retarget folds Spine3 into Spine2 and the inverse cannot split them
    again. Re-deriving the spine from the pose therefore moves the frame the
    arms hang off, which measured as 1.4e-3 npz units at the wrist while the
    legs -- parented to Hips, clear of the fold -- stayed at 4e-7. Keeping the
    untouched joints from the clip removes that error instead of tolerating it.
    """
    identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    bones = armature.data.bones
    prefix = "mixamorig:" if any(b.name.startswith("mixamorig:") for b in bones) else ""
    rotations = []
    for index, name in enumerate(motion_retarget.CSKEL27_JOINTS):
        if base_rotations is not None and name not in IK_DRIVEN_JOINTS:
            rotations.append([[float(value) for value in row] for row in base_rotations[index]])
            continue
        target = motion_retarget.MIXAMO_TARGETS.get(name)
        bone = None if target is None else bones.get(f"{prefix}{target}")
        if bone is None:
            rotations.append([row[:] for row in identity])
            continue
        pose_bone = armature.pose.bones[f"{prefix}{target}"]
        quaternion = _effective_basis(armature, pose_bone, bone).to_quaternion()
        rest = [list(row) for row in bone.matrix_local.to_3x3()]
        rotations.append(
            motion_constraints.basis_quaternion_to_local_rotation(
                (quaternion.w, quaternion.x, quaternion.y, quaternion.z), rest
            )
        )
    return rotations


def _hips_pose_bone(armature):
    bones = armature.data.bones
    prefix = "mixamorig:" if any(b.name.startswith("mixamorig:") for b in bones) else ""
    return armature.pose.bones[f"{prefix}Hips"]


def collect_constraints(
    armature,
    scene,
    *,
    bone_offsets,
    scale: float,
    base_rotations,
    start_frame: int,
    frame_count: int,
) -> dict:
    """Read every committed constraint back as npz-space request entries.

    Two different routes, because only one of them is exact. The ROOT position
    comes straight off the rig: ``armature_head == npz * scale`` is an identity
    that falls out of the retarget and measures to 3e-8. Every other joint does
    NOT satisfy it -- the mixamo limb is not the cskel27 limb -- so an effector
    target is computed by running ARDY's own forward kinematics on the edited
    rotations, which answers the question ``--constrain`` actually asks: where
    does the ARDY skeleton put this wrist when posed like this.

    ``bone_offsets`` come from the base clip via
    ``motion_constraints.derive_bone_offsets``; they are constant for the
    skeleton, so one frame of the base npz determines them.
    ``base_rotations`` is indexed by clip frame and supplies every joint the IK
    layer does not drive; see ``pose_local_rotations`` for why re-deriving
    those from the pose is lossy on this rig.

    Scrubbing is unavoidable: a pose only exists once the frame is evaluated.
    The caller's frame is restored before returning.
    """
    entered_frame = scene.frame_current
    hips = _hips_pose_bone(armature)
    effectors: list[dict] = []
    root_2d: list[dict] = []
    full_body: list[dict] = []
    try:
        for kind in EFFECTOR_KINDS:
            joint_index = motion_retarget.JOINT_INDEX[kind]
            for frame in marked_frames(armature, kind):
                clip_frame = motion_constraints.scene_frame_to_clip_frame(
                    frame, start_frame, frame_count
                )
                scene.frame_set(frame)
                positions = motion_constraints.forward_kinematics(
                    pose_local_rotations(armature, base_rotations[clip_frame]),
                    bone_offsets,
                    motion_constraints.armature_root_position_to_npz(
                        list(hips.head), scale
                    ),
                )
                x, y, z = positions[joint_index]
                effectors.append(
                    {"frame": clip_frame, "joint": kind, "x": x, "y": y, "z": z}
                )
        for frame in marked_frames(armature, "Root2D"):
            clip_frame = motion_constraints.scene_frame_to_clip_frame(
                frame, start_frame, frame_count
            )
            scene.frame_set(frame)
            root = motion_constraints.armature_root_position_to_npz(
                list(hips.head), scale
            )
            horizontal = motion_constraints.npz_horizontal(root)
            # Heading is left free unless the animator set one: a waypoint that
            # also pins the facing is a stronger constraint than dragging a
            # ground marker implies.
            root_2d.append(
                {
                    "frame": clip_frame,
                    "x": horizontal[0],
                    "z": horizontal[1],
                    "heading": None,
                }
            )
        for frame in marked_frames(armature, "FullBody"):
            clip_frame = motion_constraints.scene_frame_to_clip_frame(
                frame, start_frame, frame_count
            )
            scene.frame_set(frame)
            # A full-body constraint is delivered to the generator as a source
            # npz, not as coordinates, so the whole pose has to come out here
            # while the rig is still posed. write_pose_source_npz turns this
            # into the archive `--constrain-pose` reads.
            full_body.append(
                {
                    "frame": clip_frame,
                    "local_rotations": pose_local_rotations(
                        armature, base_rotations[clip_frame]
                    ),
                    "root": motion_constraints.armature_root_position_to_npz(
                        list(hips.head), scale
                    ),
                }
            )
    finally:
        scene.frame_set(entered_frame)
    effectors.sort(key=lambda entry: (entry["frame"], entry["joint"]))
    root_2d.sort(key=lambda entry: entry["frame"])
    full_body.sort(key=lambda entry: entry["frame"])
    return {"effectors": effectors, "full_body": full_body, "root_2d": root_2d}


def base_clip_of(armature, *, backfill: bool = True) -> dict:
    """The clip metadata apply_motion stamped on the armature's action.

    Regeneration needs the base motion id, where the clip starts in scene
    frames and how long it is. ``_apply_motion`` records all three, except on
    clips applied before the start frame was recorded; see ``_resolve_start_frame``.

    ``backfill=False`` makes the whole call non-mutating, which the read-only
    bridge method needs: an inspection that writes a custom property changes
    Blender data outside the mutation path's task tracking and revision
    handling, and the scene hash contract does not expect that.
    """
    animation_data = getattr(armature, "animation_data", None)
    action = None if animation_data is None else animation_data.action
    if action is None:
        raise ConstraintCaptureError(
            "the armature carries no action, so there is no clip to regenerate"
        )
    motion_id = action.get("cclay.motion_id")
    if not isinstance(motion_id, str):
        raise ConstraintCaptureError(
            f"action {action.name!r} was not applied by apply_motion "
            "(no cclay.motion_id)"
        )
    try:
        frame_count = int(action["cclay.motion_frames"])
        fps = int(action["cclay.motion_fps"])
    except (KeyError, TypeError, ValueError) as error:
        raise ConstraintCaptureError(
            f"action {action.name!r} is missing its motion metadata ({error})"
        ) from None
    return {
        "motion_id": motion_id,
        "start_frame": _resolve_start_frame(action, frame_count, backfill=backfill),
        "frame_count": frame_count,
        "fps": fps,
    }


def _resolve_start_frame(action, frame_count: int, *, backfill: bool) -> int:
    """Where the clip begins, recovered for clips applied before it was recorded.

    ``_apply_motion`` keys its dense frames as ``start_frame + offset`` with no
    gaps, so the lowest keyframe on the action IS the start frame by
    construction rather than by guess. With ``backfill`` the recovered value is
    written back so every later read takes the recorded path; callers on a
    read-only path pass ``backfill=False`` and get the same number without
    touching the action.

    Failing closed matters more than being lenient here: a wrong start frame
    shifts every constraint the animator placed, and re-applying a clip is a
    cheap fix next to a regeneration aimed at the wrong frames.
    """
    recorded = action.get("cclay.motion_start_frame")
    if isinstance(recorded, (int, float)) and not isinstance(recorded, bool):
        return int(recorded)
    keyed = [
        int(round(point.co[0]))
        for curve in _action_fcurves(action)
        for point in curve.keyframe_points
    ]
    if not keyed:
        raise ConstraintCaptureError(
            "INVALID_MOTION_START_FRAME_MISSING: action "
            f"{action.name!r} has no keyframes to recover its start frame from; "
            "re-apply the clip before marking constraints"
        )
    start_frame = min(keyed)
    span = max(keyed) - start_frame + 1
    if span != frame_count:
        raise ConstraintCaptureError(
            "INVALID_MOTION_START_FRAME_MISSING: action "
            f"{action.name!r} spans {span} frames but records {frame_count}; "
            "re-apply the clip before marking constraints"
        )
    if backfill:
        action["cclay.motion_start_frame"] = start_frame
    return start_frame


def motion_basis(armature, project_directory, motion_id: str) -> dict:
    """Everything collect_constraints needs that comes from the base clip.

    The bone offsets and the rig scale are properties of the skeleton pair, not
    of a frame, so one frame of the base npz fixes them. The per-frame
    rotations are handed back as the loaded array rather than converted: only
    the marked frames are ever read, and a 240-frame clip is 583k floats.
    """
    from . import stage_scene

    local_rot_mats, posed_joints, _fps, _carried = stage_scene._load_motion_payload(
        project_directory, motion_id
    )
    prefix, rig_thigh = stage_scene._rig_scale_inputs(armature.data.bones)
    del prefix
    return {
        "bone_offsets": motion_constraints.derive_bone_offsets(
            [[[float(v) for v in row] for row in joint] for joint in local_rot_mats[0]],
            [[float(v) for v in position] for position in posed_joints[0]],
        ),
        "scale": float(motion_retarget.derive_scale(posed_joints[0], rig_thigh)),
        "base_rotations": local_rot_mats,
    }


def write_pose_source_npz(
    project_directory,
    motion_id: str,
    *,
    local_rotations,
    bone_offsets,
    root_position,
    fps: int,
) -> object:
    """Write the single-frame archive a full-body constraint points at.

    ``--constrain-pose`` reads only ``local_rot_mats[frame]`` and the root out
    of ``posed_joints[frame]``, but ``posed_joints`` is still recomputed here
    by forward kinematics instead of being filled with anything convenient.
    Archives in this project that skipped that step disagree with their own
    rotations by 1.4 units, and nothing downstream would report it.
    """
    import numpy

    from . import stage_scene

    if _MOTION_ID.fullmatch(motion_id) is None:
        raise ConstraintCaptureError(f"invalid synthetic motion id {motion_id!r}")
    positions = motion_constraints.forward_kinematics(
        local_rotations, bone_offsets, root_position
    )
    directory = pathlib.Path(project_directory) / ".cclay" / "motions"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{motion_id}.npz"
    if path.exists():
        raise ConstraintCaptureError(f"motion {motion_id} already exists")
    staged = path.with_suffix(".npz.partial")
    try:
        with open(staged, "wb") as stream:
            numpy.savez(
                stream,
                local_rot_mats=numpy.asarray([local_rotations], dtype=numpy.float32),
                posed_joints=numpy.asarray([positions], dtype=numpy.float32),
                fps=numpy.asarray(fps, dtype=numpy.int64),
            )
        # Round-trips the archive through the same validator apply_motion uses,
        # so a malformed synthetic pose fails here rather than deep inside a
        # regeneration the host already started.
        stage_scene._inspect_motion_archive(staged, motion_id)
        os.replace(staged, path)
    except BaseException:
        try:
            os.unlink(staged)
        except OSError:
            pass
        raise
    return path


def capture_regeneration_request(
    armature,
    scene,
    *,
    project_directory,
    entity_id: str,
    expected_revision_id: str,
    request_id: str,
    requested_at_ms: int,
) -> dict:
    """Build the complete regeneration request for the armature's clip.

    Ordering matters and is the reason this is one function: the constraints
    can only be read while the IK layer is still attached, so every synthetic
    pose archive is written here too. The caller detaches afterwards and only
    then writes the request, which is what lets the host treat the request file
    as self-contained.
    """
    clip = base_clip_of(armature)
    basis = motion_basis(armature, project_directory, clip["motion_id"])
    collected = collect_constraints(
        armature,
        scene,
        bone_offsets=basis["bone_offsets"],
        scale=basis["scale"],
        base_rotations=basis["base_rotations"],
        start_frame=clip["start_frame"],
        frame_count=clip["frame_count"],
    )
    full_body = []
    for entry in collected["full_body"]:
        synthetic_motion_id = f"cclay-pose-{request_id[:16]}-f{entry['frame']}"
        write_pose_source_npz(
            project_directory,
            synthetic_motion_id,
            local_rotations=entry["local_rotations"],
            bone_offsets=basis["bone_offsets"],
            root_position=entry["root"],
            fps=clip["fps"],
        )
        full_body.append(
            {"frame": entry["frame"], "synthetic_motion_id": synthetic_motion_id}
        )
    return {
        "schema_version": REQUEST_SCHEMA_VERSION,
        "request_id": request_id,
        "entity_id": entity_id,
        "base_motion_id": clip["motion_id"],
        "expected_revision_id": expected_revision_id,
        "effectors": collected["effectors"],
        "full_body": full_body,
        "root_2d": collected["root_2d"],
        "requested_at_ms": requested_at_ms,
    }


def request_directory(project_directory) -> object:
    return pathlib.Path(project_directory) / ".cclay" / REQUEST_DIRECTORY


def outcome_directory(project_directory) -> object:
    return pathlib.Path(project_directory) / ".cclay" / OUTCOME_DIRECTORY


def marked_frames_by_kind(armature) -> dict:
    """Every committed constraint, keyed by kind, in scene frames."""
    return {
        kind: frames
        for kind in ANCHOR_BY_KIND
        for frames in (marked_frames(armature, kind),)
        if frames
    }


# Continuity of the regenerated clip, carried forward so the next regeneration
# has something to compare against. Kept on the object rather than the action
# for the same reason as the pending record: regeneration replaces the action.
CONTINUITY_PROPERTY = "cclay.regenerate_max_jump_m"
# A regeneration is never blocked on this. The plan is explicit that the
# animator judges the result and the add-on only reports, so these bounds
# decide when to say something, not when to refuse.
CONTINUITY_GROWTH_FACTOR = 1.2
CONTINUITY_ABSOLUTE_FLOOR_M = 0.05


def continuity_warning(previous, current) -> str | None:
    """Whether the new clip's worst jump is worth telling the animator about.

    Compared against the clip immediately before it, not against the original
    base: every regeneration becomes the base for the next one, so drift is
    what accumulates and what nobody would otherwise notice.

    The absolute floor is there because the ratio alone is useless near zero --
    a jump growing from 0.1mm to 1mm is a tenfold rise and still nothing.
    """
    if previous is None or current is None:
        return None
    threshold = max(previous * CONTINUITY_GROWTH_FACTOR, CONTINUITY_ABSOLUTE_FLOOR_M)
    if current <= threshold:
        return None
    return (
        f"continuity worsened: max jump {current:.4f}m against "
        f"{previous:.4f}m before (threshold {threshold:.4f}m)"
    )


def record_continuity(armature, max_jump_m) -> None:
    if max_jump_m is None:
        return
    armature[CONTINUITY_PROPERTY] = float(max_jump_m)


def previous_continuity(armature):
    value = armature.get(CONTINUITY_PROPERTY)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def record_pending_request(armature, request_id: str, marks: dict) -> None:
    """Remember what was asked for, so the answer can be put back on the rig.

    Regeneration replaces the whole action, so the marker curves that encode
    the constraints do not survive it. Stashing the frames on the object -- not
    on the action -- is what lets a second pass start from the constraints the
    animator already placed instead of a blank clip.
    """
    armature[PENDING_PROPERTY] = json.dumps(
        {"request_id": _require_request_id(request_id), "marks": marks}, sort_keys=True
    )


def read_pending_request(armature) -> dict | None:
    raw = armature.get(PENDING_PROPERTY)
    if not raw:
        return None
    try:
        pending = json.loads(raw)
        request_id = pending["request_id"]
        marks = pending["marks"]
    except (KeyError, TypeError, ValueError):
        raise ConstraintCaptureError(
            "the pending regeneration record on this object is unreadable"
        ) from None
    _require_request_id(request_id)
    if not isinstance(marks, dict):
        raise ConstraintCaptureError(
            "the pending regeneration record on this object is malformed"
        )
    return {"request_id": request_id, "marks": marks}


def clear_pending_request(armature) -> None:
    if PENDING_PROPERTY in armature:
        del armature[PENDING_PROPERTY]


def read_outcome(project_directory, request_id: str) -> dict | None:
    """The host's answer for ``request_id``, or None while it is still pending.

    Absence is not failure: the host writes the outcome only once it has run
    the generator, so a missing file means the sweep has not reached this
    request yet.
    """
    path = outcome_directory(project_directory) / f"{_require_request_id(request_id)}.json"
    try:
        body = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ConstraintCaptureError(f"cannot read the regeneration outcome: {error}")
    try:
        outcome = json.loads(body)
    except ValueError as error:
        raise ConstraintCaptureError(
            f"the regeneration outcome is not readable JSON: {error}"
        ) from None
    return validate_outcome(outcome, request_id)


def discard_outcome(project_directory, request_id: str) -> None:
    """Drop an outcome the add-on has finished acting on.

    Outcomes are addressed by request id, so leaving consumed ones behind
    accumulates forever and, worse, lets a later request that happens to reuse
    an id read a verdict meant for something else.
    """
    try:
        path = outcome_directory(project_directory) / f"{_require_request_id(request_id)}.json"
        path.unlink()
    except FileNotFoundError:
        return
    except OSError as error:
        raise ConstraintCaptureError(
            f"cannot discard the regeneration outcome: {error}"
        ) from None


# Mirrors ArdyRegenerateQueueOutcomeV1Schema in
# packages/blender-protocol/src/ardy-regenerate.ts. The two must agree; this
# side is checked because the operator changes rig state -- reattaches IK,
# rewrites marker curves, clears the pending record -- before it ever reads
# `result`. Accepting a malformed success meant tearing all that down and then
# raising, leaving the scene in a state no code path expects.
_OUTCOME_COMMON_KEYS = {"schema_version", "request_id", "status"}
_OUTCOME_SUCCESS_KEYS = _OUTCOME_COMMON_KEYS | {"result", "resulting_revision_id"}
_OUTCOME_FAILURE_KEYS = _OUTCOME_COMMON_KEYS | {"error_code", "message"}
_RESULT_KEYS = {
    "schema_version",
    "request_id",
    "motion_id",
    "frames",
    "achieved_error_m",
    "residual",
    "continuity",
    "dropped_constraints",
}
_CONTINUITY_KEYS = {"mean_jump_m", "max_jump_m", "max_jump_frame"}
_ERROR_CODES = frozenset({
    "INVALID_ARDY_REGENERATE_REQUEST",
    "BASE_MOTION_NOT_FOUND",
    "ENTITY_NOT_FOUND",
    "REVISION_MISMATCH",
    "GENERATION_FAILED",
})
_REVISION_ID = re.compile(r"[0-9a-f]{64}")


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_integer(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_outcome(outcome, request_id: str) -> dict:
    """Check an outcome completely, before anything acts on it.

    Raises rather than returning a verdict: every caller here is about to
    change rig state on the strength of this, so there is no useful way to
    continue with a half-trusted answer.
    """

    def bad(message: str):
        raise ConstraintCaptureError(f"the regeneration outcome {message}")

    if not isinstance(outcome, dict):
        bad("is not an object")
    if outcome.get("schema_version") != 1:
        bad("does not declare schema_version 1")
    if outcome.get("request_id") != request_id:
        # An outcome addressed to a different request would apply a clip the
        # animator never asked for on this armature.
        bad(f"answers {outcome.get('request_id')!r}, not {request_id!r}")
    status = outcome.get("status")
    if status == "failed":
        if set(outcome) != _OUTCOME_FAILURE_KEYS:
            bad(f"has unexpected failure keys {sorted(set(outcome) ^ _OUTCOME_FAILURE_KEYS)}")
        if outcome["error_code"] not in _ERROR_CODES:
            bad(f"reports unknown error code {outcome['error_code']!r}")
        if not isinstance(outcome["message"], str) or not outcome["message"]:
            bad("carries no failure message")
        return outcome
    if status != "succeeded":
        bad(f"has unknown status {status!r}")
    if set(outcome) != _OUTCOME_SUCCESS_KEYS:
        bad(f"has unexpected success keys {sorted(set(outcome) ^ _OUTCOME_SUCCESS_KEYS)}")
    revision = outcome["resulting_revision_id"]
    if not isinstance(revision, str) or _REVISION_ID.fullmatch(revision) is None:
        bad(f"has a malformed resulting_revision_id {revision!r}")
    result = outcome["result"]
    if not isinstance(result, dict) or set(result) != _RESULT_KEYS:
        bad("has a result that does not match the closed schema")
    if result["schema_version"] != 1 or result["request_id"] != request_id:
        bad("has a result addressed to a different request")
    if not isinstance(result["motion_id"], str) or _MOTION_ID.fullmatch(result["motion_id"]) is None:
        bad(f"names an invalid motion {result['motion_id']!r}")
    if not _is_integer(result["frames"]) or result["frames"] < 1:
        bad(f"reports {result['frames']!r} frames")
    if result["achieved_error_m"] is not None and not _is_number(result["achieved_error_m"]):
        bad("has a non-numeric achieved_error_m")
    continuity = result["continuity"]
    if not isinstance(continuity, dict) or set(continuity) != _CONTINUITY_KEYS:
        bad("has a continuity block that does not match the closed schema")
    if not _is_number(continuity["mean_jump_m"]) or not _is_number(continuity["max_jump_m"]):
        bad("has non-numeric continuity values")
    if not _is_integer(continuity["max_jump_frame"]) or continuity["max_jump_frame"] < 0:
        bad("has a malformed continuity frame")
    if not isinstance(result["dropped_constraints"], list):
        bad("has a malformed dropped_constraints list")
    return outcome


def restore_constraints(armature, scene, marks: dict) -> int:
    """Re-key the remembered constraints onto the regenerated clip.

    Called after the new action has landed and the IK layer has been
    re-attached. Frames outside the new clip are skipped rather than keyed onto
    a frame the clip does not have: the generator is free to return a clip of a
    different length, and a marker past the end would come back out of
    ``scene_frame_to_clip_frame`` as an out-of-range clip frame.

    The bound is the ACTION's own range, not the scene's. A scene is routinely
    longer than the clip playing in it, so checking the scene would happily
    restore a marker on frame 200 of a twenty-frame clip.
    """
    clip = base_clip_of(armature)
    first = clip["start_frame"]
    last = first + clip["frame_count"] - 1
    restored = 0
    entered_frame = scene.frame_current
    try:
        for kind, frames in marks.items():
            if kind not in ANCHOR_BY_KIND:
                raise ConstraintCaptureError(f"unknown constraint kind {kind!r}")
            for frame in frames:
                frame = int(frame)
                if not first <= frame <= last:
                    continue
                scene.frame_set(frame)
                mark_constraint(armature, kind, frame)
                restored += 1
    finally:
        scene.frame_set(entered_frame)
    return restored


def write_request(project_directory, payload: dict) -> object:
    """Write one regeneration request atomically; return its path.

    Written through a temp file and renamed so the host never observes a
    half-written request, matching how ``connection`` hands off its single-use
    discovery slots. The payload is complete on its own: by the time the host
    reads it the IK layer has been detached and the anchors are gone.
    """
    directory = request_directory(project_directory)
    directory.mkdir(parents=True, exist_ok=True)
    # allow_nan=False: Python emits bare NaN/Infinity by default, which is not
    # JSON and which the host's TypeBox Number would reject after the add-on
    # has already detached. Failing here keeps the rig recoverable.
    body = json.dumps(payload, indent=1, sort_keys=True, allow_nan=False).encode()
    handle, staged = tempfile.mkstemp(dir=str(directory), suffix=".partial")
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(body)
        os.chmod(staged, 0o600)
        final = directory / f"{_require_request_id(payload['request_id'])}.json"
        os.replace(staged, final)
    except BaseException:
        try:
            os.unlink(staged)
        except OSError:
            pass
        raise
    return final


def new_request_id() -> str:
    return uuid.uuid4().hex
