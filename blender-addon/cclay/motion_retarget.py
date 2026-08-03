"""Pure cskel27 -> mixamorig retargeting math for apply_motion.

ARDY motion npz files carry per-frame local joint rotations for the 27-joint
"core" skeleton (cskel27). cskel27 uses mixamo bone names without the
``mixamorig:`` prefix and shares the mixamo T-pose, so retargeting reduces to a
per-bone change of basis: with L the ARDY local rotation and Rb the target
bone's armature-space rest rotation, the Blender pose-bone basis is

    basis = Rb^T @ L @ Rb

No hierarchy recursion is needed. The only structural differences are the
extra spine joint (core ``Spine`` has no mixamo bone and its rotation is not
applied anywhere) and the HandEnd leaf joints (no mixamo counterpart; dropped).

This module is deliberately free of bpy and numpy so it can be unit tested
with plain CPython. Matrices may be nested lists or numpy-like indexable arrays.
"""
import math
from numbers import Integral, Real


# Joint order of the ARDY core skeleton. Index in this list == joint index in
# the npz arrays (local_rot_mats[:, i], posed_joints[:, i]).
CSKEL27_JOINTS = (
    "Hips", "Spine", "Spine1", "Spine2", "Spine3", "Neck", "Head",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "RightHandEnd", "RightHandThumb1",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "LeftHandEnd", "LeftHandThumb1",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
)
JOINT_INDEX = {name: index for index, name in enumerate(CSKEL27_JOINTS)}

# cskel27 joint -> mixamo bone (without the mixamorig: prefix). None means the
# joint has no direct counterpart and its rotation is not applied anywhere.
# cskel27 has four spine joints, the mixamo rig has three; the measured rest
# alignment keeps the top three (Spine1/Spine2/Spine3 onto Spine/Spine1/Spine2,
# see test_motion_retarget_pure.py) so the bottom joint Spine is dropped, as
# are the HandEnd leaves.
MIXAMO_TARGETS = {
    "Hips": "Hips", "Spine": None, "Spine1": "Spine", "Spine2": "Spine1",
    "Spine3": "Spine2",
    "Neck": "Neck", "Head": "Head",
    "RightShoulder": "RightShoulder", "RightArm": "RightArm",
    "RightForeArm": "RightForeArm", "RightHand": "RightHand",
    "RightHandEnd": None, "RightHandThumb1": "RightHandThumb1",
    "LeftShoulder": "LeftShoulder", "LeftArm": "LeftArm",
    "LeftForeArm": "LeftForeArm", "LeftHand": "LeftHand",
    "LeftHandEnd": None, "LeftHandThumb1": "LeftHandThumb1",
    "RightUpLeg": "RightUpLeg", "RightLeg": "RightLeg",
    "RightFoot": "RightFoot", "RightToeBase": "RightToeBase",
    "LeftUpLeg": "LeftUpLeg", "LeftLeg": "LeftLeg",
    "LeftFoot": "LeftFoot", "LeftToeBase": "LeftToeBase",
}

MAX_FRAMES = 24_000  # 20 minutes at 20 fps
FPS_BOUNDS = (1, 240)
MAX_PAYLOAD_BYTES = 96 * 1024 * 1024
_MISSING = object()
# Maximum absolute error for squared row/column norms, pairwise dot products,
# and determinant. 1e-3 comfortably covers float32 ARDY serialization noise
# while remaining far below scale, shear, and reflection errors.
ROTATION_MATRIX_TOLERANCE = 1e-3
_QUATERNION_NORM_EPSILON = 1e-12


class MotionRetargetError(ValueError):
    """The motion payload is malformed or incompatible with the skeleton."""


def _is_finite_number(value: object) -> bool:
    return isinstance(value, Real) and math.isfinite(value)


def _array_preflight(values, expected_tail, label):
    """Return ``(frames, has_shape)`` after validating array metadata."""
    shape = getattr(values, "shape", _MISSING)
    has_shape = shape is not _MISSING
    if has_shape:
        try:
            shape = tuple(shape)
        except (TypeError, ValueError) as exc:
            raise MotionRetargetError(f"{label} shape metadata is invalid") from exc
        if (
            len(shape) != len(expected_tail) + 1
            or any(
                isinstance(size, bool) or not isinstance(size, Integral)
                for size in shape
            )
        ):
            raise MotionRetargetError(
                f"{label} must have shape (F, {', '.join(map(str, expected_tail))})"
            )
        frames = int(shape[0])
        if tuple(int(size) for size in shape[1:]) != expected_tail:
            raise MotionRetargetError(
                f"{label} must have shape (F, {', '.join(map(str, expected_tail))})"
            )
    else:
        try:
            frames = len(values)
        except (TypeError, ValueError) as exc:
            raise MotionRetargetError(f"{label} must be an indexable array") from exc

    dtype = getattr(values, "dtype", _MISSING)
    if (
        dtype is not _MISSING
        and getattr(dtype, "kind", None) not in ("i", "u", "f")
    ):
        raise MotionRetargetError(
            f"{label} dtype must be real numeric and non-object"
        )

    scalar_count = frames
    for size in expected_tail:
        scalar_count *= size
    nbytes = getattr(values, "nbytes", scalar_count * 8)
    if isinstance(nbytes, bool) or not isinstance(nbytes, Integral) or nbytes < 0:
        raise MotionRetargetError(f"{label} nbytes metadata is invalid")
    return frames, has_shape, int(nbytes)


def _require_length(values, expected, label):
    try:
        actual = len(values)
    except (TypeError, ValueError) as exc:
        raise MotionRetargetError(f"{label} must be an indexable sequence") from exc
    if actual != expected:
        raise MotionRetargetError(f"{label} must contain exactly {expected} values")


def _mat_transpose(m):
    return [[m[0][0], m[1][0], m[2][0]],
            [m[0][1], m[1][1], m[2][1]],
            [m[0][2], m[1][2], m[2][2]]]


def _mat_mul(a, b):
    return [
        [
            a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]
            for j in range(3)
        ]
        for i in range(3)
    ]


def _mat_vec(m, v):
    return [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]


def _validate_rotation_matrix(m):
    """Require a finite, approximately orthonormal 3x3 matrix with det near +1."""
    rows = [[m[i][j] for j in range(3)] for i in range(3)]
    columns = [[m[i][j] for i in range(3)] for j in range(3)]
    for vectors in (rows, columns):
        for vector in vectors:
            squared_norm = sum(component * component for component in vector)
            if (
                not math.isfinite(squared_norm)
                or abs(squared_norm - 1.0) > ROTATION_MATRIX_TOLERANCE
            ):
                raise MotionRetargetError("rotation matrix is not a proper rotation")
        for first, second in ((0, 1), (0, 2), (1, 2)):
            dot = sum(
                vectors[first][index] * vectors[second][index]
                for index in range(3)
            )
            if (
                not math.isfinite(dot)
                or abs(dot) > ROTATION_MATRIX_TOLERANCE
            ):
                raise MotionRetargetError("rotation matrix is not a proper rotation")

    determinant = (
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    )
    if (
        not math.isfinite(determinant)
        or abs(determinant - 1.0) > ROTATION_MATRIX_TOLERANCE
    ):
        raise MotionRetargetError("rotation matrix is not a proper rotation")


def _mat_to_quat(m):
    """Row-major 3x3 rotation matrix -> normalized (w, x, y, z)."""
    try:
        trace = m[0][0] + m[1][1] + m[2][2]
        if trace > 0.0:
            s = math.sqrt(trace + 1.0) * 2.0
            quat = (
                0.25 * s,
                (m[2][1] - m[1][2]) / s,
                (m[0][2] - m[2][0]) / s,
                (m[1][0] - m[0][1]) / s,
            )
        elif m[0][0] > m[1][1] and m[0][0] > m[2][2]:
            s = math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2.0
            quat = (
                (m[2][1] - m[1][2]) / s,
                0.25 * s,
                (m[0][1] + m[1][0]) / s,
                (m[0][2] + m[2][0]) / s,
            )
        elif m[1][1] > m[2][2]:
            s = math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2.0
            quat = (
                (m[0][2] - m[2][0]) / s,
                (m[0][1] + m[1][0]) / s,
                0.25 * s,
                (m[1][2] + m[2][1]) / s,
            )
        else:
            s = math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2.0
            quat = (
                (m[1][0] - m[0][1]) / s,
                (m[0][2] + m[2][0]) / s,
                (m[1][2] + m[2][1]) / s,
                0.25 * s,
            )
        squared_norm = sum(component * component for component in quat)
        if (
            not math.isfinite(squared_norm)
            or squared_norm <= _QUATERNION_NORM_EPSILON
        ):
            raise MotionRetargetError("derived quaternion is non-finite or degenerate")
        inverse_norm = 1.0 / math.sqrt(squared_norm)
        normalized = tuple(component * inverse_norm for component in quat)
        if not all(math.isfinite(component) for component in normalized):
            raise MotionRetargetError("derived quaternion is non-finite or degenerate")
        return normalized
    except MotionRetargetError:
        raise
    except (ArithmeticError, ValueError) as exc:
        raise MotionRetargetError(
            "derived quaternion is non-finite or degenerate"
        ) from exc


class MotionValidationCursor:
    """Incremental, allocation-free validation of one decoded motion payload."""

    def __init__(self, local_rot_mats, posed_joints, fps):
        if (
            isinstance(fps, bool)
            or not isinstance(fps, Integral)
            or not FPS_BOUNDS[0] <= fps <= FPS_BOUNDS[1]
        ):
            raise MotionRetargetError(f"fps must be an integer in {FPS_BOUNDS}")
        joint_count = len(CSKEL27_JOINTS)
        frames, self._rotations_have_shape, rotations_nbytes = _array_preflight(
            local_rot_mats, (joint_count, 3, 3), "local_rot_mats"
        )
        posed_frames, self._joints_have_shape, joints_nbytes = _array_preflight(
            posed_joints, (joint_count, 3), "posed_joints"
        )
        if not 1 <= frames <= MAX_FRAMES:
            raise MotionRetargetError(
                f"frame count must be 1..{MAX_FRAMES}, got {frames}"
            )
        if posed_frames != frames:
            raise MotionRetargetError(
                "posed_joints frame count does not match local_rot_mats"
            )
        if rotations_nbytes + joints_nbytes > MAX_PAYLOAD_BYTES:
            raise MotionRetargetError(
                f"motion payload exceeds {MAX_PAYLOAD_BYTES} uncompressed bytes"
            )
        self.local_rot_mats = local_rot_mats
        self.posed_joints = posed_joints
        self.frames = frames
        self.frame_index = 0
        self.done = False

    def step(self, max_frames=64, cancelled=lambda: False):
        """Validate at most ``max_frames`` rows; return whether validation finished."""
        if isinstance(max_frames, bool) or not isinstance(max_frames, Integral) or max_frames < 1:
            raise ValueError("max_frames must be a positive integer")
        try:
            stop = min(self.frames, self.frame_index + int(max_frames))
            joint_count = len(CSKEL27_JOINTS)
            while self.frame_index < stop:
                if cancelled():
                    raise MotionRetargetError("motion validation was cancelled")
                frame_rots = self.local_rot_mats[self.frame_index]
                frame_joints = self.posed_joints[self.frame_index]
                if not self._rotations_have_shape:
                    _require_length(frame_rots, joint_count, "rotation frame")
                if not self._joints_have_shape:
                    _require_length(frame_joints, joint_count, "joint frame")
                for joint_index in range(joint_count):
                    rotation = frame_rots[joint_index]
                    joint = frame_joints[joint_index]
                    if not self._rotations_have_shape:
                        _require_length(rotation, 3, "rotation matrix")
                    if not self._joints_have_shape:
                        _require_length(joint, 3, "joint position")
                    for row_index in range(3):
                        row = rotation[row_index]
                        if not self._rotations_have_shape:
                            _require_length(row, 3, "rotation matrix row")
                        for column_index in range(3):
                            if not _is_finite_number(row[column_index]):
                                raise MotionRetargetError(
                                    "non-finite or non-numeric rotation component"
                                )
                        if not _is_finite_number(joint[row_index]):
                            raise MotionRetargetError(
                                "non-finite or non-numeric joint position"
                            )
                    _validate_rotation_matrix(rotation)
                self.frame_index += 1
            if self.frame_index == self.frames:
                hips0 = self.posed_joints[0][JOINT_INDEX["Hips"]]
                if not (
                    hips0[1] > 0
                    and abs(hips0[1]) >= abs(hips0[0])
                    and abs(hips0[1]) >= abs(hips0[2])
                ):
                    raise MotionRetargetError(
                        "motion is not Y-up (frame-0 hips not +Y dominant)"
                    )
                self.done = True
            return self.done
        except MotionRetargetError:
            raise
        except Exception as exc:
            raise MotionRetargetError(f"malformed motion payload: {exc}") from exc


def validate_motion(local_rot_mats, posed_joints, fps) -> int:
    """Validate a decoded npz payload by shape/index; return frame count.

    Plain nested lists and numpy-like arrays are accepted. No nested copy is
    made. Malformed inputs always fail as :class:`MotionRetargetError`.
    """
    cursor = MotionValidationCursor(local_rot_mats, posed_joints, fps)
    while not cursor.step():
        pass
    return cursor.frames


def derive_scale(posed_joints_frame0, rig_thigh_length: float) -> float:
    """Units-per-meter scale from the thigh bone (RightUpLeg -> RightLeg)."""
    upleg = posed_joints_frame0[JOINT_INDEX["RightUpLeg"]]
    leg = posed_joints_frame0[JOINT_INDEX["RightLeg"]]
    dx = leg[0] - upleg[0]
    dy = leg[1] - upleg[1]
    dz = leg[2] - upleg[2]
    npz_thigh = (dx * dx + dy * dy + dz * dz) ** 0.5
    if npz_thigh <= 1e-6:
        raise MotionRetargetError("degenerate thigh length in motion data")
    if rig_thigh_length <= 1e-6:
        raise MotionRetargetError("degenerate thigh length on the target rig")
    return rig_thigh_length / npz_thigh


def build_pose_tracks(local_rot_mats, posed_joints, rest_rotations, rest_hips_head, scale):
    """Retarget the motion onto the rig described by the rest data.

    - ``rest_rotations``: cskel joint name -> 3x3 armature-space rest rotation
      of the corresponding mixamo bone (only for joints with a target present
      on the rig).
    - ``rest_hips_head``: armature-space rest head of the hips bone.
    - ``scale``: from :func:`derive_scale`.

    Returns ``{"rotations": {cskel_name: [(w,x,y,z), ...]},
    "hips_locations": [(x,y,z), ...]}`` where hips locations are in hips
    bone-local space (``pose_bone.location`` semantics: pose head = rest head
    + Rb @ loc).
    """
    builder = PoseTrackBuilder(
        local_rot_mats, posed_joints, rest_rotations, rest_hips_head, scale
    )
    while not builder.step():
        pass
    return builder.tracks


class PoseTrackBuilder:
    """Resumable retarget builder that processes bounded frame chunks."""

    def __init__(
        self, local_rot_mats, posed_joints, rest_rotations, rest_hips_head, scale
    ):
        self.local_rot_mats = local_rot_mats
        self.posed_joints = posed_joints
        self.rest_rotations = rest_rotations
        self.rest_hips_head = rest_hips_head
        self.scale = scale
        self.frames = len(local_rot_mats)
        self.frame_index = 0
        self.rotations = {name: [] for name in rest_rotations}
        self.rest_transposes = {
            name: _mat_transpose(rest) for name, rest in rest_rotations.items()
        }
        if "Hips" not in self.rest_transposes:
            raise MotionRetargetError("rest rotations are missing Hips")
        self.hips_locations = []
        self.done = False

    @property
    def tracks(self):
        if not self.done:
            raise MotionRetargetError("pose tracks are not complete")
        return {
            "rotations": self.rotations,
            "hips_locations": self.hips_locations,
        }

    def step(self, max_frames=64, cancelled=lambda: False):
        """Retarget at most ``max_frames`` rows; return whether building finished."""
        if isinstance(max_frames, bool) or not isinstance(max_frames, Integral) or max_frames < 1:
            raise ValueError("max_frames must be a positive integer")
        stop = min(self.frames, self.frame_index + int(max_frames))
        hips_rest_rot_t = self.rest_transposes["Hips"]
        while self.frame_index < stop:
            if cancelled():
                raise MotionRetargetError("motion retargeting was cancelled")
            frame = self.frame_index
            frame_rots = self.local_rot_mats[frame]
            for cskel_name in self.rotations:
                local = frame_rots[JOINT_INDEX[cskel_name]]
                rest = self.rest_rotations[cskel_name]
                basis = _mat_mul(
                    _mat_mul(self.rest_transposes[cskel_name], local), rest
                )
                self.rotations[cskel_name].append(_mat_to_quat(basis))
            hips_target = self.posed_joints[frame][JOINT_INDEX["Hips"]]
            delta = [
                hips_target[0] * self.scale - self.rest_hips_head[0],
                hips_target[1] * self.scale - self.rest_hips_head[1],
                hips_target[2] * self.scale - self.rest_hips_head[2],
            ]
            self.hips_locations.append(tuple(_mat_vec(hips_rest_rot_t, delta)))
            self.frame_index += 1
        self.done = self.frame_index == self.frames
        return self.done
