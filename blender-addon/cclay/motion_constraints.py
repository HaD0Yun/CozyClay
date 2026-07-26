"""Pure, bpy-free inverse math for regenerating ARDY constraints from a pose.

ARDY constraint regeneration reads a Blender pose (keyframed by the user on a
few frames) and writes back the per-frame local rotations and root trajectory
that ARDY's npz format expects. The forward direction -- npz local rotations to
Blender pose-bone quaternions -- already lives in ``motion_retarget.py``:

    basis = Rb^T @ L @ Rb          (PoseTrackBuilder.step)

where ``L`` is the ARDY local rotation and ``Rb`` is the target bone's
armature-space rest rotation. Constraint regeneration needs the inverse:

    L = Rb @ basis @ Rb^T

This module is deliberately free of bpy and numpy, mirroring
``motion_retarget.py`` and ``ik_chains.py``, so the round-trip and frame math
can be unit tested with plain CPython without a Blender process. Keeping the
math in a separate module also avoids touching ``motion_retarget.py`` (other
slices may edit it concurrently) while still reusing its verified helpers
(``_mat_mul``, ``_mat_transpose``, ``_mat_to_quat``) so the math is not
re-derived here. The one helper missing upstream -- quaternion -> 3x3 matrix --
is implemented locally for the same collision-avoidance reason.

The npz position transform is the exact inverse of ``PoseTrackBuilder.step``'s
hips-location mapping, which is component-wise with no axis swap (npz axis 1 is
the Y-up height axis, axes 0 and 2 are the horizontal plane; see
``motion_preflight.UP_AXIS`` / ``HORIZONTAL_AXES`` for the evidence).
"""

from __future__ import annotations

import math
from numbers import Integral, Real

from .motion_retarget import (
    CSKEL27_JOINTS,
    JOINT_INDEX,
    _mat_mul,
    _mat_transpose,
    _mat_vec,
)

# Re-exported from motion_preflight's evidence so callers and tests have a
# single source of truth for the npz axis layout without importing bpy-facing
# code. npz axis 1 is the Y-up height axis; axes 0 and 2 are the horizontal
# plane, in ascending index order.
UP_AXIS = 1
HORIZONTAL_AXES = (0, 2)

# Quaternion norm below which we refuse to build a rotation matrix. Matches
# motion_retarget._QUATERNION_NORM_EPSILON so the inverse path rejects the same
# degenerate inputs the forward path would have produced via _mat_to_quat.
_QUATERNION_NORM_EPSILON = 1e-12


class MotionConstraintError(ValueError):
    """A constraint-regeneration input is malformed or out of range."""


def _is_finite_number(value: object) -> bool:
    return isinstance(value, Real) and math.isfinite(value)


def _quat_to_mat(quaternion) -> list[list[float]]:
    """Normalized (w, x, y, z) -> row-major 3x3 rotation matrix.

    The inverse of :func:`motion_retarget._mat_to_quat`. A zero-length or
    non-finite quaternion is rejected explicitly rather than producing a
    garbage matrix, because the round-trip contract treats a degenerate basis
    as a hard error (the forward path rejects the same via ``_mat_to_quat``).
    """
    if not isinstance(quaternion, (tuple, list)):
        raise MotionConstraintError("quaternion must be a sequence of four numbers")
    if len(quaternion) != 4:
        raise MotionConstraintError("quaternion must contain exactly four components")
    for component in quaternion:
        if not _is_finite_number(component):
            raise MotionConstraintError("quaternion has a non-finite component")

    w, x, y, z = (float(c) for c in quaternion)
    norm_sq = w * w + x * x + y * y + z * z
    if not math.isfinite(norm_sq) or norm_sq <= _QUATERNION_NORM_EPSILON:
        raise MotionConstraintError("quaternion is zero-length and cannot represent a rotation")
    inverse_norm = 1.0 / math.sqrt(norm_sq)
    w, x, y, z = w * inverse_norm, x * inverse_norm, y * inverse_norm, z * inverse_norm

    # Standard quaternion -> rotation matrix (right-handed, row-major).
    return [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - w * z), 2.0 * (x * z + w * y)],
        [2.0 * (x * y + w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - w * x)],
        [2.0 * (x * z - w * y), 2.0 * (y * z + w * x), 1.0 - 2.0 * (x * x + y * y)],
    ]


def basis_quaternion_to_local_rotation(quaternion, rest_rotation) -> list[list[float]]:
    """Invert ``basis = Rb^T @ L @ Rb`` to recover the ARDY local rotation ``L``.

    ``quaternion`` is the Blender pose-bone rotation as a normalized
    ``(w, x, y, z)`` tuple/list. ``rest_rotation`` is the target bone's
    armature-space rest rotation ``Rb`` as a row-major 3x3 nested list (the
    same value ``PoseTrackBuilder`` reads from ``bone.matrix_local.to_3x3()``).

    Returns ``L`` as a fresh row-major 3x3 nested list. The round trip
    ``L -> basis -> _mat_to_quat -> basis_quaternion_to_local_rotation`` is the
    identity up to float error for any valid ``L`` and ``Rb``.
    """
    basis = _quat_to_mat(quaternion)
    rest_t = _mat_transpose(rest_rotation)
    return _mat_mul(_mat_mul(rest_rotation, basis), rest_t)


# There is NO linear map from a Blender joint position to an npz one, and the
# measurements that establish that are recorded here so nobody re-derives the
# wrong answer.
#
# For the ROOT the retarget path does give an exact identity. A root pose bone's
# armature-space head is ``rest_head + Rb @ location``, and PoseTrackBuilder
# writes ``location = Rb^T @ (npz_hips * scale - rest_head)``, so the two
# collapse to ``armature_head == npz_hips * scale``. Measured against a real
# clip on the bundled x-bot rig that identity holds to 3e-8 armature units.
#
# For every other joint it does NOT hold, because retargeting copies ROTATIONS
# ONLY and the two skeletons have different proportions. Same clip, same frames,
# armature-space error against ``npz * scale``:
#
#     Hips 3e-8   LeftFoot 3.1   RightFoot 4.4   LeftHand 16.4   Head 22.5
#
# (armature units at scale 107.7, i.e. the wrist lands ~16 cm away). No choice
# of axis permutation, sign or scale fixes that -- the mixamo forearm is simply
# not the cskel27 forearm.
#
# So an end-effector target is obtained by running the ARDY skeleton's own
# forward kinematics on the edited rotations, exactly as the remote generator
# does when it loads a pose source. That is what the FK helpers below are for.


# Parent joint per cskel27 index, in CSKEL27_JOINTS order. motion_retarget
# deliberately carries no hierarchy (it is rotation-only), so this table is not
# copied from anywhere -- it was verified numerically: deriving the constant
# bone offsets from one frame and running FK across every other frame
# reproduces the npz's own posed_joints to 2.8e-07 / 4.5e-07 / 2.9e-07 on three
# unrelated ARDY clips, which is float32 serialization noise. A wrong parent
# moves that error to whole npz units immediately.
_PARENT_BY_NAME = {
    "Hips": None,
    "Spine": "Hips", "Spine1": "Spine", "Spine2": "Spine1", "Spine3": "Spine2",
    "Neck": "Spine3", "Head": "Neck",
    "RightShoulder": "Spine3", "RightArm": "RightShoulder",
    "RightForeArm": "RightArm", "RightHand": "RightForeArm",
    "RightHandEnd": "RightHand", "RightHandThumb1": "RightHand",
    "LeftShoulder": "Spine3", "LeftArm": "LeftShoulder",
    "LeftForeArm": "LeftArm", "LeftHand": "LeftForeArm",
    "LeftHandEnd": "LeftHand", "LeftHandThumb1": "LeftHand",
    "RightUpLeg": "Hips", "RightLeg": "RightUpLeg",
    "RightFoot": "RightLeg", "RightToeBase": "RightFoot",
    "LeftUpLeg": "Hips", "LeftLeg": "LeftUpLeg",
    "LeftFoot": "LeftLeg", "LeftToeBase": "LeftFoot",
}
CSKEL27_PARENTS = tuple(
    None if _PARENT_BY_NAME[name] is None else JOINT_INDEX[_PARENT_BY_NAME[name]]
    for name in CSKEL27_JOINTS
)


def _topological_order() -> tuple[int, ...]:
    """Joint indices ordered so every parent precedes its children."""
    placed = {index for index, parent in enumerate(CSKEL27_PARENTS) if parent is None}
    order = sorted(placed)
    while len(order) < len(CSKEL27_PARENTS):
        progressed = False
        for index, parent in enumerate(CSKEL27_PARENTS):
            if index not in placed and parent in placed:
                order.append(index)
                placed.add(index)
                progressed = True
        if not progressed:
            raise MotionConstraintError("cskel27 parent table is not a tree")
    return tuple(order)


CSKEL27_TOPOLOGICAL_ORDER = _topological_order()


def global_rotations(local_rotations):
    """Accumulate per-joint local rotations into global ones down the tree."""
    if len(local_rotations) != len(CSKEL27_PARENTS):
        raise MotionConstraintError(
            f"local_rotations must hold {len(CSKEL27_PARENTS)} joints"
        )
    out: list[list[list[float]] | None] = [None] * len(CSKEL27_PARENTS)
    for index in CSKEL27_TOPOLOGICAL_ORDER:
        parent = CSKEL27_PARENTS[index]
        local = [list(row) for row in local_rotations[index]]
        out[index] = local if parent is None else _mat_mul(out[parent], local)
    return out


def derive_bone_offsets(local_rotations, joint_positions):
    """Constant bone vectors, each expressed in its parent's global frame.

    A bone's length and direction relative to its parent do not change over a
    clip, so one frame determines them: ``offset = R_parent^T @ (child - parent)``.
    Deriving them from the clip itself rather than hardcoding a rest skeleton
    keeps this correct if ARDY ever reproportions cskel27.
    """
    rotations = global_rotations(local_rotations)
    if len(joint_positions) != len(CSKEL27_PARENTS):
        raise MotionConstraintError(
            f"joint_positions must hold {len(CSKEL27_PARENTS)} joints"
        )
    offsets: list[list[float]] = [[0.0, 0.0, 0.0]] * len(CSKEL27_PARENTS)
    for index in CSKEL27_TOPOLOGICAL_ORDER:
        parent = CSKEL27_PARENTS[index]
        if parent is None:
            continue
        delta = [
            float(joint_positions[index][axis]) - float(joint_positions[parent][axis])
            for axis in range(3)
        ]
        offsets[index] = _mat_vec(_mat_transpose(rotations[parent]), delta)
    return offsets


def forward_kinematics(local_rotations, bone_offsets, root_position):
    """Joint positions in npz space for one posed frame.

    This is the mapping an end-effector constraint needs: it answers "where
    does the ARDY skeleton put the wrist when the user's edited rotations are
    applied", which is the question ``--constrain x y z`` is asking. Running it
    with the clip's own rotations reproduces the clip's own posed_joints, which
    is how the parent table above was verified.
    """
    rotations = global_rotations(local_rotations)
    if len(bone_offsets) != len(CSKEL27_PARENTS):
        raise MotionConstraintError(
            f"bone_offsets must hold {len(CSKEL27_PARENTS)} joints"
        )
    if len(root_position) != 3:
        raise MotionConstraintError("root_position must be a sequence of three numbers")
    positions: list[list[float]] = [[0.0, 0.0, 0.0]] * len(CSKEL27_PARENTS)
    for index in CSKEL27_TOPOLOGICAL_ORDER:
        parent = CSKEL27_PARENTS[index]
        if parent is None:
            positions[index] = [float(component) for component in root_position]
            continue
        moved = _mat_vec(rotations[parent], bone_offsets[index])
        positions[index] = [positions[parent][axis] + moved[axis] for axis in range(3)]
    return positions


def armature_root_position_to_npz(armature_position, scale: float) -> list[float]:
    """Armature-space ROOT position -> npz coordinate.

    Only valid for the root (Hips): see the measurement note above. Callers
    must not reach for this with a wrist or an ankle -- use
    :func:`forward_kinematics` for those.
    """
    if not _is_finite_number(scale) or scale <= 0.0:
        raise MotionConstraintError("scale must be a positive finite number")
    if not isinstance(armature_position, (tuple, list)) or len(armature_position) != 3:
        raise MotionConstraintError("armature_position must be a sequence of three numbers")
    for component in armature_position:
        if not _is_finite_number(component):
            raise MotionConstraintError("position has a non-finite component")
    return [float(component) / scale for component in armature_position]


def npz_horizontal(position) -> list[float]:
    """The two ground-plane components of an npz coordinate, in axis order."""
    if not isinstance(position, (tuple, list)) or len(position) != 3:
        raise MotionConstraintError("position must be a sequence of three numbers")
    return [float(position[axis]) for axis in HORIZONTAL_AXES]


def scene_frame_to_clip_frame(scene_frame, start_frame: int, frame_count: int) -> int:
    """Scene frame -> in-clip frame index (``scene_frame - start_frame``).

    Out-of-range inputs are rejected, never silently clamped: a constraint
    written for the wrong frame would corrupt the regenerated motion, so the
    caller must hear about it. ``frame_count`` is the number of frames in the
    clip, so valid clip frames are ``0..frame_count - 1`` inclusive.
    """
    if isinstance(scene_frame, bool) or not isinstance(scene_frame, Integral):
        raise MotionConstraintError("scene_frame must be an integer")
    if isinstance(start_frame, bool) or not isinstance(start_frame, Integral):
        raise MotionConstraintError("start_frame must be an integer")
    if isinstance(frame_count, bool) or not isinstance(frame_count, Integral):
        raise MotionConstraintError("frame_count must be an integer")
    if frame_count <= 0:
        raise MotionConstraintError("frame_count must be a positive integer")
    clip_frame = int(scene_frame) - int(start_frame)
    if clip_frame < 0 or clip_frame >= int(frame_count):
        raise MotionConstraintError(
            f"scene frame {int(scene_frame)} is outside clip range "
            f"[{int(start_frame)}, {int(start_frame) + int(frame_count) - 1}]"
        )
    return clip_frame
