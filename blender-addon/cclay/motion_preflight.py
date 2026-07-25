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
"""

from __future__ import annotations

import math

from . import motion_retarget

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

# Closed set of stage_scene contract codes the preflight loader/validation
# path can raise; encoded by stage_scene as a leading "CODE: " message prefix.
_APPLY_MOTION_CODES = frozenset({
    "APPLY_MOTION_PROJECT_DIR_UNKNOWN",
    "APPLY_MOTION_NOT_FOUND",
    "APPLY_MOTION_TOO_LARGE",
    "APPLY_MOTION_MALFORMED",
})


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


def analyze_motion(posed_joints, fps: int, scale=None) -> dict:
    """Pure preflight analysis of one posed_joints array (motion-local frame).

    Returns the full contract result minus ``revision``/``motion_id``. When
    ``scale`` (meters per npz unit) is given, every reported length is in
    meters and the tolerances apply post-scale; otherwise raw npz units.
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
        "end_pose": _end_pose(root_track, lowest, fps),
    }


def _validated_params(params) -> tuple[str, str | None]:
    """Return (motion_id, entity_id) or raise PreflightMotionError.

    Explicit nulls for optional fields are rejected (parity with the TS
    Type.Optional contract, which forbids ``null`` for absent fields).
    """
    # Lazy: keeps host-side pure imports free of the heavier bpy-facing module
    # graph and avoids import cycles.
    from .scene_relations import _UUID_V4_LOWERCASE
    from .stage_scene import _MOTION_ID

    if not isinstance(params, dict):
        _invalid("params must be an object")
    unknown = set(params) - {"motion_id", "entity_id"}
    if unknown:
        _invalid(f"unknown fields {sorted(unknown)}")
    motion_id = params.get("motion_id")
    if not isinstance(motion_id, str) or _MOTION_ID.fullmatch(motion_id) is None:
        _invalid(
            "motion_id must be a lowercase [a-z0-9-] slug of at most 64 characters"
        )
    entity_id = None
    if "entity_id" in params:
        entity_id = params["entity_id"]
        if not isinstance(entity_id, str) or _UUID_V4_LOWERCASE.fullmatch(entity_id) is None:
            _invalid("entity_id must be a lowercase UUIDv4")
    return motion_id, entity_id


def _derive_entity_scale(entity_id: str, posed_joints) -> float:
    """Meters-per-npz-unit scale from the target rig, exactly like apply_motion."""
    from . import stage_scene
    from .scene_relations import _object_for_entity

    scene_object = _object_for_entity(entity_id)
    if scene_object is None:
        raise PreflightMotionError(
            "ENTITY_NOT_FOUND", f"entity {entity_id} does not exist"
        )
    if scene_object.type != "ARMATURE" or scene_object.data is None:
        _invalid(f"entity {entity_id} must be an CCLAY character armature")
    # Shared, read-only scale inputs; extracted into stage_scene so the
    # preflight and apply_motion measurements cannot drift.
    _prefix, rig_thigh = stage_scene._rig_scale_inputs(scene_object.data.bones)
    if rig_thigh is None:
        _invalid(f"entity {entity_id} rig is missing the RightUpLeg/RightLeg bones")
    try:
        return motion_retarget.derive_scale(posed_joints[0], rig_thigh)
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
    from . import stage_scene

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
        raise stage_scene.StageSceneError(f"APPLY_MOTION_MALFORMED: {error}") from error


def _as_contract_error(error):
    """Map a stage_scene "CODE: message" error onto a coded contract error.

    StageSceneError has no ``code`` attribute, so the bridge dispatcher's
    ``getattr(error, "code", ...)`` would surface the class name. Returns the
    input unchanged when no closed contract code prefixes the message.
    """
    code, separator, rest = str(error).partition(": ")
    if separator and code in _APPLY_MOTION_CODES:
        return PreflightMotionError(code, rest)
    return error


def collect_preflight(revision_id: str, params, project_directory) -> dict:
    """bpy-facing preflight_motion entry: validate, load, analyze. Read-only."""
    motion_id, entity_id = _validated_params(params)
    # Lazy import: avoids import cycles and keeps this module importable
    # host-side without bpy.
    from . import stage_scene

    try:
        _local_rot_mats, posed_joints, fps = stage_scene._load_motion_payload(
            project_directory, motion_id, validate=False
        )
        _validate_motion_payload(_local_rot_mats, posed_joints, fps)
        scale = None
        if entity_id is not None:
            scale = _derive_entity_scale(entity_id, posed_joints)
        analysis = analyze_motion(posed_joints, fps, scale)
    except stage_scene.StageSceneError as error:
        mapped = _as_contract_error(error)
        if mapped is error:
            raise
        raise mapped from error
    return {
        "revision": revision_id,
        "schema_version": analysis["schema_version"],
        "motion_id": motion_id,
        **{key: value for key, value in analysis.items() if key != "schema_version"},
    }
