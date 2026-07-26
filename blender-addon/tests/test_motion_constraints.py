"""Pure-python tests for the ARDY constraint-regeneration inverse math (no bpy).

The core contract is the round trip: forward ``basis = Rb^T @ L @ Rb`` (via
``motion_retarget._mat_to_quat``) then inverse
``L = Rb @ basis @ Rb^T`` (via ``basis_quaternion_to_local_rotation``) must
recover the original ``L`` within float tolerance, for any valid ``L`` and
``Rb``. Error paths (zero-length quaternion, non-finite, out-of-range frame,
non-positive scale) are exercised separately.
"""

import math
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay import motion_constraints  # noqa: E402
from cclay.motion_retarget import (  # noqa: E402
    CSKEL27_JOINTS,
    JOINT_INDEX,
    _mat_mul,
    _mat_to_quat,
    _mat_transpose,
    _mat_vec,
)
from cclay.motion_constraints import (  # noqa: E402
    MotionConstraintError,
    basis_quaternion_to_local_rotation,
    scene_frame_to_clip_frame,
)

IDENTITY = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]


def _rot_x(degrees: float):
    r = math.radians(degrees)
    c, s = math.cos(r), math.sin(r)
    return [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]


def _rot_y(degrees: float):
    r = math.radians(degrees)
    c, s = math.cos(r), math.sin(r)
    return [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]


def _rot_z(degrees: float):
    r = math.radians(degrees)
    c, s = math.cos(r), math.sin(r)
    return [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]


def _assert_matrices_equal(testcase, actual, expected, places=6, msg=None):
    for i in range(3):
        for j in range(3):
            testcase.assertAlmostEqual(
                actual[i][j], expected[i][j], places=places, msg=f"{msg} [{i}][{j}]"
            )


class QuaternionToMatrixTests(unittest.TestCase):
    def test_identity_quaternion_yields_identity_matrix(self):
        mat = motion_constraints._quat_to_mat((1.0, 0.0, 0.0, 0.0))
        _assert_matrices_equal(self, mat, IDENTITY, msg="identity quaternion")

    def test_90deg_z_quaternion_matches_rotation_matrix(self):
        half = math.radians(45)
        w, x, y, z = math.cos(half), 0.0, 0.0, math.sin(half)
        mat = motion_constraints._quat_to_mat((w, x, y, z))
        _assert_matrices_equal(self, mat, _rot_z(90), msg="RotZ(90)")

    def test_normalizes_a_non_unit_quaternion(self):
        # Twice the identity-length quaternion still represents identity.
        mat = motion_constraints._quat_to_mat((2.0, 0.0, 0.0, 0.0))
        _assert_matrices_equal(self, mat, IDENTITY, msg="scaled identity")

    def test_rejects_zero_length_quaternion(self):
        with self.assertRaisesRegex(MotionConstraintError, "zero-length"):
            motion_constraints._quat_to_mat((0.0, 0.0, 0.0, 0.0))

    def test_rejects_non_finite_quaternion(self):
        with self.assertRaisesRegex(MotionConstraintError, "non-finite"):
            motion_constraints._quat_to_mat((float("inf"), 0.0, 0.0, 0.0))

    def test_rejects_wrong_arity(self):
        with self.assertRaisesRegex(MotionConstraintError, "exactly four"):
            motion_constraints._quat_to_mat((1.0, 0.0, 0.0))


class BasisToLocalRoundTripTests(unittest.TestCase):
    """L -> basis -> quat -> L must be the identity for any valid L and Rb."""

    def _round_trip(self, local, rest, msg):
        basis = _mat_mul(_mat_mul(_mat_transpose(rest), local), rest)
        quat = _mat_to_quat(basis)
        recovered = basis_quaternion_to_local_rotation(quat, rest)
        _assert_matrices_equal(self, recovered, local, places=6, msg=msg)

    def test_identity_local_with_identity_rest(self):
        self._round_trip(IDENTITY, IDENTITY, "identity/identity")

    def test_identity_local_with_rotated_rest(self):
        # A pose with no ARDY rotation must recover identity regardless of Rb.
        for rest in (_rot_x(90), _rot_y(45), _rot_z(120)):
            self._round_trip(IDENTITY, rest, f"identity local / {rest}")

    def test_rotated_local_with_identity_rest(self):
        # With Rb = I, basis == L, so the round trip is just quat->mat->quat.
        for local in (_rot_x(30), _rot_y(-50), _rot_z(135)):
            self._round_trip(local, IDENTITY, f"{local} / identity rest")

    def test_rotated_local_with_rotated_rest(self):
        # The general case: conjugation actually moves the rotation axis.
        cases = [
            (_rot_y(30), _rot_x(90), "RotY(30)/RotX(90)"),
            (_rot_x(25), _rot_y(70), "RotX(25)/RotY(70)"),
            (_rot_z(80), _rot_x(140), "RotZ(80)/RotX(140)"),
            (_rot_y(30), _rot_z(45), "RotY(30)/RotZ(45)"),
        ]
        for local, rest, msg in cases:
            self._round_trip(local, rest, msg)

    def test_rejects_zero_length_quaternion_at_the_public_api(self):
        with self.assertRaisesRegex(MotionConstraintError, "zero-length"):
            basis_quaternion_to_local_rotation((0.0, 0.0, 0.0, 0.0), IDENTITY)



class Cskel27HierarchyTests(unittest.TestCase):
    def test_covers_every_joint_exactly_once_with_a_single_root(self):
        self.assertEqual(
            len(motion_constraints.CSKEL27_PARENTS), len(CSKEL27_JOINTS)
        )
        roots = [i for i, p in enumerate(motion_constraints.CSKEL27_PARENTS) if p is None]
        self.assertEqual(roots, [JOINT_INDEX["Hips"]])

    def test_topological_order_places_every_parent_before_its_children(self):
        order = motion_constraints.CSKEL27_TOPOLOGICAL_ORDER
        self.assertCountEqual(order, range(len(motion_constraints.CSKEL27_PARENTS)))
        seen = set()
        for index in order:
            parent = motion_constraints.CSKEL27_PARENTS[index]
            if parent is not None:
                self.assertIn(parent, seen, f"{index} precedes its parent {parent}")
            seen.add(index)


class ForwardKinematicsTests(unittest.TestCase):
    """FK is cross-checked against a chain composed by hand, not against itself.

    The parent table itself was verified against real ARDY clips (see the
    measurement note in motion_constraints); these tests lock the accumulation
    mechanism, which is what would silently rot under a refactor.
    """

    def _clip_inputs(self):
        local = [IDENTITY for _ in CSKEL27_JOINTS]
        local[JOINT_INDEX["Spine3"]] = _rot_z(20)
        local[JOINT_INDEX["LeftShoulder"]] = _rot_y(35)
        local[JOINT_INDEX["LeftArm"]] = _rot_x(-40)
        local[JOINT_INDEX["LeftForeArm"]] = _rot_z(25)
        offsets = [[0.0, 0.0, 0.0] for _ in CSKEL27_JOINTS]
        for name, offset in (
            ("Spine", [0.0, 1.0, 0.0]),
            ("Spine1", [0.0, 1.0, 0.0]),
            ("Spine2", [0.0, 1.0, 0.0]),
            ("Spine3", [0.0, 1.0, 0.0]),
            ("LeftShoulder", [1.0, 0.5, 0.0]),
            ("LeftArm", [2.0, 0.0, 0.0]),
            ("LeftForeArm", [3.0, 0.0, 0.0]),
            ("LeftHand", [4.0, 0.0, 0.0]),
        ):
            offsets[JOINT_INDEX[name]] = offset
        return local, offsets

    def test_matches_a_chain_composed_by_hand(self):
        local, offsets = self._clip_inputs()
        root = [7.0, 3.0, -2.0]
        positions = motion_constraints.forward_kinematics(local, offsets, root)

        # The same wrist, composed explicitly down Hips -> ... -> LeftHand
        # without the topological loop or the parent table.
        chain = ("Spine", "Spine1", "Spine2", "Spine3", "LeftShoulder", "LeftArm",
                 "LeftForeArm", "LeftHand")
        position = list(root)
        rotation = IDENTITY
        for name in chain:
            index = JOINT_INDEX[name]
            moved = _mat_vec(rotation, offsets[index])
            position = [position[axis] + moved[axis] for axis in range(3)]
            rotation = _mat_mul(rotation, local[index])

        for axis in range(3):
            self.assertAlmostEqual(
                positions[JOINT_INDEX["LeftHand"]][axis], position[axis], places=9
            )

    def test_preserves_every_bone_length(self):
        local, offsets = self._clip_inputs()
        positions = motion_constraints.forward_kinematics(local, offsets, [0.0, 0.0, 0.0])
        for index, parent in enumerate(motion_constraints.CSKEL27_PARENTS):
            if parent is None:
                continue
            expected = sum(component ** 2 for component in offsets[index]) ** 0.5
            actual = sum(
                (positions[index][axis] - positions[parent][axis]) ** 2
                for axis in range(3)
            ) ** 0.5
            self.assertAlmostEqual(actual, expected, places=9)

    def test_offsets_are_recovered_from_the_posed_clip(self):
        local, offsets = self._clip_inputs()
        positions = motion_constraints.forward_kinematics(local, offsets, [1.0, 2.0, 3.0])
        recovered = motion_constraints.derive_bone_offsets(local, positions)
        for index, parent in enumerate(motion_constraints.CSKEL27_PARENTS):
            if parent is None:
                continue
            for axis in range(3):
                self.assertAlmostEqual(
                    recovered[index][axis], offsets[index][axis], places=9
                )

    def test_rejects_a_wrong_joint_count(self):
        local, offsets = self._clip_inputs()
        with self.assertRaisesRegex(MotionConstraintError, "27 joints"):
            motion_constraints.forward_kinematics(local[:-1], offsets, [0.0, 0.0, 0.0])
        with self.assertRaisesRegex(MotionConstraintError, "27 joints"):
            motion_constraints.forward_kinematics(local, offsets[:-1], [0.0, 0.0, 0.0])


class ArmatureRootPositionTests(unittest.TestCase):
    def test_divides_the_root_by_scale(self):
        self.assertEqual(
            motion_constraints.armature_root_position_to_npz([10.0, 20.0, -5.0], 2.0),
            [5.0, 10.0, -2.5],
        )

    def test_rejects_non_positive_scale(self):
        with self.assertRaisesRegex(MotionConstraintError, "positive finite"):
            motion_constraints.armature_root_position_to_npz([1.0, 1.0, 1.0], 0.0)

    def test_rejects_non_finite_position(self):
        with self.assertRaisesRegex(MotionConstraintError, "non-finite"):
            motion_constraints.armature_root_position_to_npz(
                [float("inf"), 1.0, 1.0], 1.0
            )

    def test_horizontal_drops_the_up_axis(self):
        self.assertEqual(motion_constraints.npz_horizontal([3.0, 9.0, 4.0]), [3.0, 4.0])


class SceneFrameToClipFrameTests(unittest.TestCase):
    def test_subtracts_start_frame(self):
        self.assertEqual(scene_frame_to_clip_frame(110, 100, 50), 10)

    def test_first_frame_is_zero(self):
        self.assertEqual(scene_frame_to_clip_frame(100, 100, 50), 0)

    def test_last_frame_is_frame_count_minus_one(self):
        self.assertEqual(scene_frame_to_clip_frame(149, 100, 50), 49)

    def test_rejects_frame_before_start(self):
        with self.assertRaisesRegex(MotionConstraintError, "outside clip range"):
            scene_frame_to_clip_frame(99, 100, 50)

    def test_rejects_frame_at_or_past_end(self):
        with self.assertRaisesRegex(MotionConstraintError, "outside clip range"):
            scene_frame_to_clip_frame(150, 100, 50)

    def test_rejects_non_integer_frame(self):
        with self.assertRaisesRegex(MotionConstraintError, "scene_frame must be an integer"):
            scene_frame_to_clip_frame(100.0, 100, 50)

    def test_rejects_boolean_frame(self):
        # bool is an Integral subclass; the API must not accept it silently.
        with self.assertRaisesRegex(MotionConstraintError, "scene_frame must be an integer"):
            scene_frame_to_clip_frame(True, 100, 50)

    def test_rejects_non_positive_frame_count(self):
        with self.assertRaisesRegex(MotionConstraintError, "frame_count must be a positive"):
            scene_frame_to_clip_frame(100, 100, 0)


if __name__ == "__main__":
    unittest.main()
