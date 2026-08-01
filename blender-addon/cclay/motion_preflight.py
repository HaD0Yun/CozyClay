"""Read-only preflight analysis for the preflight_motion bridge method.

Analyzes a generated ARDY motion archive (``.cclay/motions/<id>.npz``) BEFORE
apply_motion bakes it: root travel, height profile, lowest-extremity track,
contact plateaus, and end pose. All analysis happens in the MOTION-LOCAL frame
of the npz ``posed_joints`` array (frames x 27 x 3, cskel27, Hips = joint 0);
nothing in this module mutates the scene, the durable store, or the npz.

Up-axis evidence (why ``UP_AXIS = 1``): the retarget pipeline requires npz
motions to be Y-up — ``MotionValidationCursor.step`` rejects any motion whose
frame-0 Hips is not +Y dominant ("motion is not Y-up", motion_retarget.py
lines 318-326).  ``PoseTrackBuilder.step`` then maps npz coordinates
component-wise, with no axis swap, into armature space against
``rest_hips_head`` (motion_retarget.py lines 436-442), where
``rest_hips_head`` is ``bones["mixamorig:Hips"].head_local`` measured on the
bundled mixamo character rig (stage_scene.py ``_apply_motion``, the
``PoseTrackBuilder(...)`` call site around lines 1990-1998).  The bundled
character FBX import preserves the importer's base object rotation
(stage_scene.py ``_create_character``, ``base_rotation`` composition around
lines 1008-1011), which is what carries armature-space +Y (character up) to
Blender world +Z.  So npz axis index 1 is the height axis and the remaining
axes (0, 2) form the horizontal plane.

The measurement math is deliberately bpy- and numpy-free so it can be unit
tested with plain CPython (numpy arrays are still accepted; everything is
indexed generically).  Payload validation additionally has a vectorized numpy
fast path (see ``_validate_motion_payload``) because it runs synchronously on
Blender's main thread.  The single bpy-facing entry point is
``collect_preflight``.

SEMANTICS (CozyClay issue #2): every measurement in this module is derived
from ``posed_joints`` -- SKELETON JOINT CENTERS, not the deformed mesh
surface. ``LeftFoot``/``RightFoot`` and their toe joints are bone-space
points; the offset from a foot joint to the visually-deformed sole is NOT
constant (issue #2 measured roughly 0.11-0.17 m of variation across a single
stair-climbing clip, driven by foot rotation). Accordingly:
  - ``contact_windows`` and ``lowest_track`` report the minimum JOINT height
    seen across the whole skeleton -- a proxy for "something is near the
    floor", not a verified sole-to-support contact measurement.
  - ``foot_contacts`` windows report the named foot JOINT's own height
    (``height``/``height_max``), not a distance to a support surface and not
    a sole position; a caller must not treat these as ground-truth contact
    without independently checking the deformed mesh.
  - Zero constraint residual against a foot joint target is a joint-center
    accuracy statement only; it says nothing about whether the sole actually
    touches its intended surface. Never substitute one for the other.
"""

from __future__ import annotations

import math

from . import motion_archive, motion_retarget
from .character_rig import CharacterRigAdapter

SCHEMA_VERSION = 1

# npz axis that maps to Blender +Z (see module docstring for the evidence).
UP_AXIS = 1
# The two non-up axes in ascending index order; horizontal plane of the motion.
HORIZONTAL_AXES = (0, 2)
# Root joint of the cskel27 skeleton (Hips = joint 0).
ROOT_JOINT_INDEX = motion_retarget.JOINT_INDEX["Hips"]

# Contact-window tolerances, applied AFTER scaling: meters when a scale is
# derived, npz units otherwise.
CONTACT_HEIGHT_TOLERANCE = 0.015   # max |L[f] - run_min| within one window
# Per-frame delta: at the 20 fps ARDY target this allows up to 0.2 units/s of
# drift inside a window (max |L[f+1] - L[f]| between consecutive frames).
CONTACT_DELTA_TOLERANCE = 0.01
RESTING_SPEED_TOLERANCE = 0.1      # end-pose resting threshold, units/second
MAX_LOWEST_TRACK_SAMPLES = 240
MAX_CONTACT_WINDOWS = 64
# ARDY's foot_contacts channel order, quoted from ardy/motion_rep/feet.py:
# "[X, T, 4] contact labels (left heel, left toe, right heel, right toe)".
# The joint each channel measures comes from CoreSkeleton27's
# left/right_foot_joint_idx ([25, 26] and [21, 22]); those indices are asserted
# against JOINT_INDEX below so a skeleton reorder fails here instead of
# silently reporting the wrong joint's height.
FOOT_CONTACT_CHANNELS = (
    ("left_heel", "LeftFoot"),
    ("left_toe", "LeftToeBase"),
    ("right_heel", "RightFoot"),
    ("right_toe", "RightToeBase"),
)
FOOT_CONTACT_JOINT_INDICES = tuple(
    motion_retarget.JOINT_INDEX[joint] for _channel, joint in FOOT_CONTACT_CHANNELS
)
assert FOOT_CONTACT_JOINT_INDICES == (25, 26, 21, 22), FOOT_CONTACT_JOINT_INDICES



class PreflightMotionError(ValueError):
    """A preflight_motion request is invalid; ``code`` is the contract code."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _invalid(message: str) -> None:
    raise PreflightMotionError("INVALID_PREFLIGHT_MOTION_PARAMS", message)


def _round3(value: float) -> float:
    """Round to exactly 3 decimals, normalizing -0.0 to 0.0."""
    rounded = round(float(value), 3)
    return 0.0 if rounded == 0.0 else rounded


def _round6(value: float) -> float:
    """Round to exactly 6 decimals, normalizing -0.0 to 0.0 (scale only)."""
    rounded = round(float(value), 6)
    return 0.0 if rounded == 0.0 else rounded


def _lowest_track(posed_joints, factor: float) -> list[float]:
    """Per-frame minimum over ALL joints of the scaled height coordinate."""
    return [
        min(float(joint[UP_AXIS]) * factor for joint in frame_joints)
        for frame_joints in posed_joints
    ]


def _contact_windows(track, fps: int) -> list[dict]:
    """Maximal greedy runs of the full-resolution lowest track.

    A window is a frame run of length >= max(2, fps // 10) where every height
    stays within CONTACT_HEIGHT_TOLERANCE of the run minimum (equivalently:
    run max - run min <= tolerance) and consecutive heights differ by at most
    CONTACT_DELTA_TOLERANCE. The greedy scan already emits maximal runs (a
    run only ends when extending it would break a tolerance, so re-merging
    adjacent runs can never succeed); the output is capped at
    MAX_CONTACT_WINDOWS keeping the earliest windows.
    """
    frames = len(track)
    minimum_length = max(2, int(fps) // 10)
    runs: list[tuple[int, int, float, float]] = []
    start = 0
    while start < frames:
        end = start
        low = high = float(track[start])
        while end + 1 < frames:
            following = float(track[end + 1])
            if abs(following - float(track[end])) > CONTACT_DELTA_TOLERANCE:
                break
            merged_low = min(low, following)
            merged_high = max(high, following)
            if merged_high - merged_low > CONTACT_HEIGHT_TOLERANCE:
                break
            low, high = merged_low, merged_high
            end += 1
        runs.append((start, end, low, high))
        start = end + 1
    windows = []
    for run_start, run_end, _low, _high in runs:
        length = run_end - run_start + 1
        if length < minimum_length:
            continue
        mean_height = (
            sum(float(track[frame]) for frame in range(run_start, run_end + 1))
            / length
        )
        windows.append({
            "start_frame": int(run_start),
            "end_frame": int(run_end),
            "height": _round3(mean_height),
        })
    return windows[:MAX_CONTACT_WINDOWS]


def _end_pose(root_track, lowest_track, fps: int) -> dict:
    """End-of-motion summary over the final max(2, round(0.25 * fps)) frames."""
    frames = len(root_track)
    tail = min(frames, max(2, round(0.25 * int(fps))))
    if tail >= 2:
        displacement = 0.0
        for frame in range(frames - tail, frames - 1):
            here = root_track[frame]
            there = root_track[frame + 1]
            displacement += math.sqrt(
                sum((there[axis] - here[axis]) ** 2 for axis in range(3))
            )
        speed = displacement / (tail - 1) * int(fps)
    else:
        speed = 0.0
    return {
        "root_height": _round3(root_track[-1][UP_AXIS]),
        "lowest_gap": _round3(float(lowest_track[-1]) - min(lowest_track)),
        "speed": _round3(speed),
        "resting": speed <= RESTING_SPEED_TOLERANCE,
    }


def _foot_contact_windows(posed_joints, foot_contacts, factor: float) -> list[dict]:
    """Per-channel runs of the model's own predicted foot contacts.

    This does NOT replace ``contact_windows``. That scan takes the minimum over
    ALL joints, so it also catches a hand on a box or a knee on the floor, but
    it cannot say which limb it saw. These four channels are feet only and are
    named, so a caller can turn "left_toe is planted on frames 12..19 at height
    0.181" straight into a ``--constrain 15 LeftFoot x y z`` target.

    The channel is a learned part of ARDY's motion representation: ``inverse()``
    thresholds the decoded channel at 0.5 (ardy/motion_rep/reps/ardy_motionrep.py).
    Its training labels were themselves derived with a velocity/height heuristic
    (ardy/motion_rep/feet.py), so treat it as the model's opinion, not ground
    truth -- reporting it next to the measured height is what makes a
    disagreement (planted per the model, airborne per the geometry) visible.

    Heights are the contact joint's own height, already scaled, so a foot
    planted on the third stair reads that stair's height rather than an error.
    """
    windows: list[dict] = []
    for channel_index, (channel, _joint) in enumerate(FOOT_CONTACT_CHANNELS):
        joint_index = FOOT_CONTACT_JOINT_INDICES[channel_index]
        frame = 0
        frames = len(foot_contacts)
        while frame < frames:
            if not bool(foot_contacts[frame][channel_index]):
                frame += 1
                continue
            start = frame
            while frame + 1 < frames and bool(foot_contacts[frame + 1][channel_index]):
                frame += 1
            heights = [
                float(posed_joints[index][joint_index][UP_AXIS]) * factor
                for index in range(start, frame + 1)
            ]
            windows.append({
                "channel": channel,
                "start_frame": int(start),
                "end_frame": int(frame),
                "height": _round3(sum(heights) / len(heights)),
                "height_max": _round3(max(heights)),
            })
            frame += 1
    # Sorted by frame so the list reads as a timeline rather than per-channel
    # blocks; ties keep the FOOT_CONTACT_CHANNELS order.
    windows.sort(key=lambda window: (window["start_frame"], window["end_frame"]))
    return windows[:MAX_CONTACT_WINDOWS]


def analyze_motion(posed_joints, fps: int, scale=None, foot_contacts=None) -> dict:
    """Pure preflight analysis of one posed_joints array (motion-local frame).

    Returns the full contract result minus ``revision``/``motion_id``. When
    ``scale`` (meters per npz unit) is given, every reported length is in
    meters and the tolerances apply post-scale; otherwise raw npz units.

    ``foot_contacts`` is ARDY's own (F, 4) contact channel when the npz carries
    it. It is optional on purpose: motions staged before the carried-member
    contract have no such array (measured: 27 of 43 staged npz), so the
    geometric ``contact_windows`` scan stays the always-present signal and
    ``foot_contacts`` reports ``null`` rather than an empty list -- absent and
    "the model saw no contact" must not read the same.
    """
    frames = len(posed_joints)
    fps = int(fps)
    factor = float(scale) if scale is not None else 1.0
    root_track = [
        [float(posed_joints[frame][ROOT_JOINT_INDEX][axis]) * factor for axis in range(3)]
        for frame in range(frames)
    ]
    heights = [position[UP_AXIS] for position in root_track]
    vector_horizontal = [
        root_track[-1][axis] - root_track[0][axis] for axis in HORIZONTAL_AXES
    ]
    lowest = _lowest_track(posed_joints, factor)
    # Smallest integer stride keeping len(samples) <= MAX_LOWEST_TRACK_SAMPLES;
    # min/max always come from the full-resolution track.
    stride = max(1, math.ceil(frames / MAX_LOWEST_TRACK_SAMPLES))
    return {
        "schema_version": SCHEMA_VERSION,
        "frames": int(frames),
        "fps": fps,
        "duration_seconds": _round3(frames / fps),
        "scale": None if scale is None else _round6(scale),
        "units": "npz" if scale is None else "meters",
        "travel": {
            "vector_horizontal": [_round3(value) for value in vector_horizontal],
            "distance_horizontal": _round3(math.hypot(*vector_horizontal)),
            "height_start": _round3(heights[0]),
            "height_end": _round3(heights[-1]),
            "height_min": _round3(min(heights)),
            "height_max": _round3(max(heights)),
            "height_change": _round3(heights[-1] - heights[0]),
        },
        "lowest_track": {
            "min": _round3(min(lowest)),
            "max": _round3(max(lowest)),
            "sample_stride": int(stride),
            "samples": [_round3(lowest[frame]) for frame in range(0, frames, stride)],
        },
        "contact_windows": _contact_windows(lowest, fps),
        "foot_contacts": (
            None
            if foot_contacts is None
            else _foot_contact_windows(posed_joints, foot_contacts, factor)
        ),
        "end_pose": _end_pose(root_track, lowest, fps),
    }


def _validated_params(params) -> tuple[str, str | None]:
    """Return (motion_id, entity_id) or raise PreflightMotionError.

    Explicit nulls for optional fields are rejected (parity with the TS
    Type.Optional contract, which forbids ``null`` for absent fields).
    """
    from .scene_relations import _UUID_V4_LOWERCASE

    if not isinstance(params, dict):
        _invalid("params must be an object")
    unknown = set(params) - {"motion_id", "entity_id"}
    if unknown:
        _invalid(f"unknown fields {sorted(unknown)}")
    motion_id = params.get("motion_id")
    try:
        motion_id = motion_archive.validate_motion_id(motion_id)
    except motion_archive.MotionArchiveError:
        _invalid(
            "motion_id must be a lowercase [a-z0-9-] slug of at most 64 characters"
        )
    entity_id = None
    if "entity_id" in params:
        entity_id = params["entity_id"]
        if not isinstance(entity_id, str) or _UUID_V4_LOWERCASE.fullmatch(entity_id) is None:
            _invalid("entity_id must be a lowercase UUIDv4")
    return motion_id, entity_id


# Relative tolerance for treating an object's per-axis scale as uniform.
# Blender authors this as three independent floats, so exact equality is too
# strict for values that round-trip through UI edits or importers.
SCALE_UNIFORMITY_TOLERANCE = 1e-4


def _object_world_scale(entity_id: str, scene_object) -> float:
    """Uniform real-world meters-per-local-unit factor for ``scene_object``.

    ``CharacterRigAdapter`` measures bone length in the armature's LOCAL (edit
    bone) space, which is exactly what ``apply_motion`` wants: it retargets
    into that same local space and lets Blender's own object transform carry
    the result into world meters when the scene renders. preflight_motion's
    reported ``scale``, unlike that internal retarget scale, is meant to
    describe real-world meters, so it must fold in this same factor -- CozyClay
    issue #2 reported preflight scale ~98.514099 for a YBot with object scale
    ``[0.01, 0.01, 0.01]`` (the unscaled rig thigh, ~100x too large, divided
    straight into the npz thigh) instead of the correct ~0.985. A non-uniform
    scale has no single meters-per-unit factor, so this fails closed rather
    than silently picking one axis.
    """
    axes = tuple(scene_object.scale)
    if len(axes) != 3 or not all(isinstance(value, (int, float)) for value in axes):
        _invalid(f"entity {entity_id} has a malformed object scale")
    axes = tuple(float(value) for value in axes)
    if not all(math.isfinite(value) for value in axes):
        _invalid(f"entity {entity_id} has a non-finite object scale")
    if any(value <= 0.0 for value in axes):
        _invalid(f"entity {entity_id} has a non-positive object scale {axes}")
    largest = max(axes)
    if max(axes) - min(axes) > SCALE_UNIFORMITY_TOLERANCE * largest:
        _invalid(
            f"entity {entity_id} has non-uniform object scale {axes}; "
            "preflight cannot report a single meters-per-unit factor"
        )
    return axes[0]


def _derive_entity_scale(entity_id: str, posed_joints) -> float:
    """Meters-per-npz-unit scale from the target rig and the object's world scale.

    ``rig_thigh`` (from ``CharacterRigAdapter``, shared with ``apply_motion``)
    is measured in the armature's unscaled local space; it
    must be scaled by the object's own (uniform) world scale before deriving
    a real-world meters-per-npz-unit factor. See ``_object_world_scale`` for
    why -- this is the fix for CozyClay issue #2's ~98.5x scale mismatch.
    """
    from .scene_relations import _object_for_entity

    scene_object = _object_for_entity(entity_id)
    if scene_object is None:
        raise PreflightMotionError(
            "ENTITY_NOT_FOUND", f"entity {entity_id} does not exist"
        )
    if scene_object.type != "ARMATURE" or scene_object.data is None:
        _invalid(f"entity {entity_id} must be an CCLAY character armature")
    rig_thigh = CharacterRigAdapter(scene_object.data.bones).rig_thigh
    if rig_thigh is None:
        _invalid(f"entity {entity_id} rig is missing the RightUpLeg/RightLeg bones")
    object_scale = _object_world_scale(entity_id, scene_object)
    try:
        return motion_retarget.derive_scale(posed_joints[0], rig_thigh * object_scale)
    except motion_retarget.MotionRetargetError as error:
        # Same closed-code mapping as collect_preflight: the bridge_error
        # code field must carry APPLY_MOTION_MALFORMED, not a class name.
        raise PreflightMotionError("APPLY_MOTION_MALFORMED", str(error)) from error


def _validate_arrays_vectorized(local_rot_mats, posed_joints) -> None:
    """numpy-vectorized equivalent of the MotionValidationCursor frame loop."""
    # Lazy: numpy is guaranteed present on this path because numpy.load
    # produced the arrays; host-side pure tests never reach it with lists.
    import numpy

    if not numpy.isfinite(local_rot_mats).all():
        raise motion_retarget.MotionRetargetError(
            "non-finite or non-numeric rotation component"
        )
    if not numpy.isfinite(posed_joints).all():
        raise motion_retarget.MotionRetargetError(
            "non-finite or non-numeric joint position"
        )
    tolerance = motion_retarget.ROTATION_MATRIX_TOLERANCE
    matrices = numpy.asarray(local_rot_mats, dtype=numpy.float64).reshape(-1, 3, 3)
    # R @ R^T captures row norms and pairwise row dots in one batched matmul;
    # R^T @ R mirrors the cursor's column norm/dot checks (the max-abs-entry
    # norm is not unitarily invariant, so row- and column-gram errors can
    # differ by 2-3x); det near +1 rejects reflections (mirrors the cursor's
    # _validate_rotation_matrix tolerances).
    transposed = numpy.swapaxes(matrices, -1, -2)
    identity = numpy.eye(3)
    residual = numpy.abs(numpy.matmul(matrices, transposed) - identity).max()
    column_residual = numpy.abs(numpy.matmul(transposed, matrices) - identity).max()
    determinant_error = numpy.abs(numpy.linalg.det(matrices) - 1.0).max()
    # Negated-accept keeps NaN fail-closed: huge-but-finite entries can
    # overflow the gram to inf - inf = NaN, and NaN fails every <= test.
    if not (
        residual <= tolerance
        and column_residual <= tolerance
        and determinant_error <= tolerance
    ):
        raise motion_retarget.MotionRetargetError(
            "rotation matrix is not a proper rotation"
        )
    hips0 = posed_joints[0][ROOT_JOINT_INDEX]
    # Same Y-up invariant MotionValidationCursor.step enforces on frame-0
    # hips (motion_retarget.py lines ~318-327).
    if not (
        hips0[1] > 0
        and abs(hips0[1]) >= abs(hips0[0])
        and abs(hips0[1]) >= abs(hips0[2])
    ):
        raise motion_retarget.MotionRetargetError(
            "motion is not Y-up (frame-0 hips not +Y dominant)"
        )


def _validate_motion_payload(local_rot_mats, posed_joints, fps) -> None:
    """Bounded main-thread validation of a loaded payload before analysis.

    apply_motion amortizes MotionValidationCursor across modal-operator ticks;
    preflight runs synchronously on the main thread, where a full pure-python
    pass over a maximal 24000x27 payload costs 15-35s. The vectorized numpy
    fast path keeps that bounded (~0.15s measured for the same payload);
    the stepwise cursor fallback only ever sees tiny non-numpy test doubles,
    where full validation cost is irrelevant.
    """

    try:
        # Cursor construction is cheap metadata-only validation (fps bounds,
        # shapes, frame count, payload size) shared with apply_motion.
        cursor = motion_retarget.MotionValidationCursor(
            local_rot_mats, posed_joints, fps
        )
        if all(
            getattr(array, "shape", None) is not None
            and getattr(array, "dtype", None) is not None
            for array in (local_rot_mats, posed_joints)
        ):
            _validate_arrays_vectorized(local_rot_mats, posed_joints)
        else:
            while not cursor.step():
                pass
    except motion_retarget.MotionRetargetError as error:
        raise PreflightMotionError("APPLY_MOTION_MALFORMED", str(error)) from error


def _as_contract_error(error: motion_archive.MotionArchiveError) -> PreflightMotionError:
    """Map typed archive errors onto the existing preflight bridge codes."""
    return PreflightMotionError(error.code, error.message)

def collect_preflight(revision_id: str, params, project_directory) -> dict:
    """bpy-facing preflight_motion entry: validate, load, analyze. Read-only."""
    motion_id, entity_id = _validated_params(params)

    try:
        _local_rot_mats, posed_joints, fps, carried = motion_archive.load_motion_payload(
            project_directory,
            motion_id,
            validate=False,
            carried=("foot_contacts",),
        )
        _validate_motion_payload(_local_rot_mats, posed_joints, fps)
        foot_contacts = carried.get("foot_contacts")
        scale = None
        if entity_id is not None:
            scale = _derive_entity_scale(entity_id, posed_joints)
        analysis = analyze_motion(posed_joints, fps, scale, foot_contacts)
    except motion_archive.MotionArchiveError as error:
        raise _as_contract_error(error) from error
    return {
        "revision": revision_id,
        "schema_version": analysis["schema_version"],
        "motion_id": motion_id,
        **{key: value for key, value in analysis.items() if key != "schema_version"},
    }
