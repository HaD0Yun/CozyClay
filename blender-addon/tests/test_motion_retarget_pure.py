"""Pure-python tests for the cskel27 -> mixamorig retarget math (no bpy)."""

import json
import math
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay.motion_retarget import (
    CSKEL27_JOINTS,
    JOINT_INDEX,
    MIXAMO_TARGETS,
    MAX_PAYLOAD_BYTES,
    MotionRetargetError,
    MotionValidationCursor,
    PoseTrackBuilder,
    build_pose_tracks,
    derive_scale,
    validate_motion,
)

FIXTURE = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "ardy_motion_3frames.json").read_text()
)

IDENTITY = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]

# Rest heights along the torso, normalised by the Hips->Neck Y span (+Y up).
# cskel27 values measured 2026-08-03 from remote:~/ardy/ardy/assets/
# skeletons/cskel27/joints.p: torch.load(path, weights_only=False) yields a
# 27x3 float64 array; joint order is
# ardy.skeleton.CoreSkeleton27.bone_order_names_with_parents
# (ardy/skeleton/definitions.py:348). Mixamo values measured from
# blender-addon/cclay/assets/characters/y-bot-tpose.fbx imported into Blender
# 5.2.0 headless (bone.head_local; +Y is up in this rig's armature space).
# Both are normalised by the Hips->Neck span so the two skeletons are
# comparable; Hips and Neck normalise to 0.0 and 1.0 by construction.
CSKEL27_SPINE_HEIGHTS = {
    "Spine": 0.1180, "Spine1": 0.2729, "Spine2": 0.4297, "Spine3": 0.5870,
}
MIXAMO_SPINE_HEIGHTS = {
    "Spine": 0.1986, "Spine1": 0.4317, "Spine2": 0.6991,
}


def _rot_x(degrees: float):
    r = math.radians(degrees)
    c, s = math.cos(r), math.sin(r)
    return [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]


def _identity_frame():
    return [
        [row[:] for row in IDENTITY] for _ in CSKEL27_JOINTS
    ]


def _tpose_joints():
    """A minimal plausible Y-up standing pose (hips high, thigh below hips)."""
    joints = [[0.0, 1.0, 0.0] for _ in CSKEL27_JOINTS]
    joints[JOINT_INDEX["RightUpLeg"]] = [-0.1, 0.9, 0.0]
    joints[JOINT_INDEX["RightLeg"]] = [-0.1, 0.5, 0.0]
    return joints


class _DType:
    def __init__(self, kind):
        self.kind = kind


class _ArrayLike:
    """Minimal ndarray stand-in that deliberately forbids ``tolist``."""

    def __init__(self, values, shape, kind="f", nbytes=None):
        self._values = values
        self.shape = shape
        self.dtype = _DType(kind)
        scalar_count = 1
        for size in shape:
            scalar_count *= size
        self.nbytes = scalar_count * 4 if nbytes is None else nbytes

    def __len__(self):
        return len(self._values)

    def __getitem__(self, index):
        return self._values[index]

    def tolist(self):
        raise AssertionError("validation/retargeting must not call tolist()")


class ValidateMotionTests(unittest.TestCase):
    def test_accepts_the_real_ardy_fixture(self):
        frames = validate_motion(
            FIXTURE["local_rot_mats"], FIXTURE["posed_joints"], FIXTURE["fps"]
        )
        self.assertEqual(frames, 3)

    def test_accepts_numpy_like_arrays_without_copying(self):
        rotations = _ArrayLike(
            [_identity_frame()], (1, len(CSKEL27_JOINTS), 3, 3)
        )
        joints = _ArrayLike(
            [_tpose_joints()], (1, len(CSKEL27_JOINTS), 3)
        )
        self.assertEqual(validate_motion(rotations, joints, 20), 1)

    def test_rejects_wrong_joint_count(self):
        rots = [_identity_frame()[:26]]
        joints = [_tpose_joints()[:26]]
        with self.assertRaises(MotionRetargetError):
            validate_motion(rots, joints, 20)

    def test_rejects_non_finite_components(self):
        rots = [_identity_frame()]
        rots[0][3][1][1] = float("nan")
        with self.assertRaises(MotionRetargetError):
            validate_motion(rots, [_tpose_joints()], 20)

    def test_rejects_matrices_that_are_not_proper_rotations(self):
        malformed = {
            "zero": [[0.0, 0.0, 0.0]] * 3,
            "reflection": [[-1.0, 0.0, 0.0],
                           [0.0, 1.0, 0.0],
                           [0.0, 0.0, 1.0]],
            "scaled": [[1.1, 0.0, 0.0],
                       [0.0, 1.0, 0.0],
                       [0.0, 0.0, 1.0]],
            "sheared": [[1.0, 0.1, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0]],
            "extreme": [[1e308, 0.0, 0.0],
                        [0.0, 1e308, 0.0],
                        [0.0, 0.0, 1e308]],
        }
        for name, matrix in malformed.items():
            with self.subTest(name=name):
                rotations = [_identity_frame()]
                rotations[0][JOINT_INDEX["Head"]] = matrix
                with self.assertRaisesRegex(
                    MotionRetargetError,
                    "^rotation matrix is not a proper rotation$",
                ):
                    validate_motion(rotations, [_tpose_joints()], 20)

    def test_accepts_float32_scale_rotation_noise(self):
        rotations = [_identity_frame()]
        rotations[0][JOINT_INDEX["Head"]] = [
            [1.0, 2e-5, 0.0],
            [-2e-5, 0.99999, -1e-5],
            [0.0, 1e-5, 1.00001],
        ]
        self.assertEqual(validate_motion(rotations, [_tpose_joints()], 20), 1)

    def test_rejects_non_y_up_motion(self):
        joints = [_tpose_joints()]
        joints[0][JOINT_INDEX["Hips"]] = [0.0, 0.0, 1.0]  # Z-up hips
        with self.assertRaises(MotionRetargetError):
            validate_motion([_identity_frame()], joints, 20)

    def test_rejects_out_of_bounds_fps(self):
        with self.assertRaises(MotionRetargetError):
            validate_motion([_identity_frame()], [_tpose_joints()], 0)
        with self.assertRaises(MotionRetargetError):
            validate_motion([_identity_frame()], [_tpose_joints()], 241)

    def test_accepts_fps_boundaries_and_rejects_non_integral_fps(self):
        rotations = [_identity_frame()]
        joints = [_tpose_joints()]
        self.assertEqual(validate_motion(rotations, joints, 1), 1)
        self.assertEqual(validate_motion(rotations, joints, 240), 1)
        for fps in (20.0, True):
            with self.subTest(fps=fps), self.assertRaises(MotionRetargetError):
                validate_motion(rotations, joints, fps)

    def test_rejects_frame_count_boundaries_from_shape_metadata(self):
        for frames in (0, 24_001):
            with self.subTest(frames=frames), self.assertRaises(MotionRetargetError):
                validate_motion(
                    _ArrayLike([], (frames, len(CSKEL27_JOINTS), 3, 3)),
                    _ArrayLike([], (frames, len(CSKEL27_JOINTS), 3)),
                    20,
                )

    def test_rejects_wrong_ndarray_shape_or_dtype(self):
        cases = (
            (
                _ArrayLike([_identity_frame()], (1, 26, 3, 3)),
                _ArrayLike([_tpose_joints()], (1, 27, 3)),
            ),
            (
                _ArrayLike([_identity_frame()], (1, 27, 3, 3), kind="O"),
                _ArrayLike([_tpose_joints()], (1, 27, 3)),
            ),
        )
        for rotations, joints in cases:
            with self.subTest(shape=rotations.shape, kind=rotations.dtype.kind):
                with self.assertRaises(MotionRetargetError):
                    validate_motion(rotations, joints, 20)

    def test_enforces_combined_nbytes_boundary(self):
        joints = _ArrayLike(
            [_tpose_joints()], (1, len(CSKEL27_JOINTS), 3)
        )
        rotations = _ArrayLike(
            [_identity_frame()],
            (1, len(CSKEL27_JOINTS), 3, 3),
            nbytes=MAX_PAYLOAD_BYTES - joints.nbytes,
        )
        self.assertEqual(validate_motion(rotations, joints, 20), 1)

        rotations.nbytes += 1
        with self.assertRaises(MotionRetargetError):
            validate_motion(rotations, joints, 20)

        rotations.nbytes = -1
        with self.assertRaises(MotionRetargetError):
            validate_motion(rotations, joints, 20)

    def test_malformed_nested_lists_fail_as_motion_retarget_error(self):
        rotations = [_identity_frame()]
        rotations[0][0][0] = [1.0, 0.0]
        with self.assertRaises(MotionRetargetError):
            validate_motion(rotations, [_tpose_joints()], 20)

    def test_rejects_frame_count_mismatch(self):
        with self.assertRaises(MotionRetargetError):
            validate_motion([_identity_frame()] * 2, [_tpose_joints()], 20)


class DeriveScaleTests(unittest.TestCase):
    def test_scale_is_rig_thigh_over_npz_thigh(self):
        scale = derive_scale(_tpose_joints(), 40.0)
        self.assertAlmostEqual(scale, 100.0, places=6)

    def test_rejects_degenerate_thighs(self):
        joints = _tpose_joints()
        joints[JOINT_INDEX["RightLeg"]] = joints[JOINT_INDEX["RightUpLeg"]][:]
        with self.assertRaises(MotionRetargetError):
            derive_scale(joints, 40.0)
        with self.assertRaises(MotionRetargetError):
            derive_scale(_tpose_joints(), 0.0)

    def test_accepts_numpy_like_frame(self):
        frame = _ArrayLike(
            _tpose_joints(), (len(CSKEL27_JOINTS), 3)
        )
        self.assertAlmostEqual(derive_scale(frame, 40.0), 100.0, places=6)


class SpineCorrespondenceTests(unittest.TestCase):
    """Pins the cskel27 <-> mixamo spine correspondence to measured rest heights.

    Bottom-3 alignment (core Spine/Spine1/Spine2 onto mixamo
    Spine/Spine1/Spine2) scores mean 0.1696 / max 0.2694 absolute error;
    top-3 alignment (core Spine1/Spine2/Spine3 onto mixamo Spine/Spine1/
    Spine2) scores mean 0.0628 / max 0.1121. MIXAMO_TARGETS must keep the
    better (top-3) alignment, dropping core Spine.
    """

    def test_top_three_alignment_scores_better_than_bottom_three(self):
        def absolute_errors(pairs):
            return [
                abs(CSKEL27_SPINE_HEIGHTS[cskel] - MIXAMO_SPINE_HEIGHTS[target])
                for cskel, target in pairs
            ]

        bottom_three = absolute_errors(
            [("Spine", "Spine"), ("Spine1", "Spine1"), ("Spine2", "Spine2")]
        )
        top_three = absolute_errors(
            [("Spine1", "Spine"), ("Spine2", "Spine1"), ("Spine3", "Spine2")]
        )
        self.assertLess(
            sum(top_three) / len(top_three), sum(bottom_three) / len(bottom_three)
        )
        self.assertLess(max(top_three), max(bottom_three))

    def test_mixamo_targets_keep_the_top_three_spine_joints(self):
        self.assertEqual(MIXAMO_TARGETS["Spine"], None)
        self.assertEqual(MIXAMO_TARGETS["Spine1"], "Spine")
        self.assertEqual(MIXAMO_TARGETS["Spine2"], "Spine1")
        self.assertEqual(MIXAMO_TARGETS["Spine3"], "Spine2")
        dropped = [
            name
            for name in ("Spine", "Spine1", "Spine2", "Spine3")
            if MIXAMO_TARGETS[name] is None
        ]
        self.assertEqual(dropped, ["Spine"])


class BuildPoseTracksTests(unittest.TestCase):
    def _rest_rotations(self, rest=IDENTITY):
        return {
            name: [row[:] for row in rest]
            for name, target in MIXAMO_TARGETS.items()
            if target is not None
        }

    def _array(self, values, tail):
        return _ArrayLike(values, (len(values),) + tail)

    def test_identity_motion_yields_identity_quaternions_at_rest_pose(self):
        tracks = build_pose_tracks(
            [_identity_frame()],
            [_tpose_joints()],
            self._rest_rotations(),
            [0.0, 1.0, 0.0],  # rest hips == frame-0 hips at scale 1
            1.0,
        )
        self.assertEqual(len(tracks["rotations"]), 24)
        for name, quats in tracks["rotations"].items():
            w, x, y, z = quats[0]
            self.assertAlmostEqual(w, 1.0, places=6, msg=name)
            self.assertAlmostEqual(abs(x) + abs(y) + abs(z), 0.0, places=6, msg=name)
        for component in tracks["hips_locations"][0]:
            self.assertAlmostEqual(component, 0.0, places=6)

    def test_numpy_like_output_matches_plain_list_output(self):
        rest_rotations = self._rest_rotations()
        plain = build_pose_tracks(
            FIXTURE["local_rot_mats"],
            FIXTURE["posed_joints"],
            rest_rotations,
            FIXTURE["posed_joints"][0][JOINT_INDEX["Hips"]],
            1.0,
        )
        array_backed = build_pose_tracks(
            self._array(FIXTURE["local_rot_mats"], (len(CSKEL27_JOINTS), 3, 3)),
            self._array(FIXTURE["posed_joints"], (len(CSKEL27_JOINTS), 3)),
            rest_rotations,
            FIXTURE["posed_joints"][0][JOINT_INDEX["Hips"]],
            1.0,
        )
        self.assertEqual(array_backed, plain)

    def test_basis_is_rest_conjugated_local_rotation(self):
        # With rest = RotX(90), a local RotX(30) must conjugate into the bone
        # frame: basis = rest^T @ local @ rest is still RotX(30) here because
        # rotations about the same axis commute — so use RotX rest with a
        # RotY local, whose conjugation moves the axis to -Z.
        def _rot_y(degrees):
            r = math.radians(degrees)
            c, s = math.cos(r), math.sin(r)
            return [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]

        frame = _identity_frame()
        frame[JOINT_INDEX["Head"]] = _rot_y(30)
        tracks = build_pose_tracks(
            [frame],
            [_tpose_joints()],
            self._rest_rotations(rest=_rot_x(90)),
            [0.0, 1.0, 0.0],
            1.0,
        )
        w, x, y, z = tracks["rotations"]["Head"][0]
        half = math.radians(15)
        # RotY(30) conjugated by RotX(90)^T maps the +Y axis to -Z.
        self.assertAlmostEqual(w, math.cos(half), places=6)
        self.assertAlmostEqual(x, 0.0, places=6)
        self.assertAlmostEqual(y, 0.0, places=6)
        self.assertAlmostEqual(z, -math.sin(half), places=6)

    def test_spine_rotation_is_dropped_and_each_driven_spine_joint_is_own_track(self):
        frame = _identity_frame()
        frame[JOINT_INDEX["Spine"]] = _rot_x(10)
        frame[JOINT_INDEX["Spine1"]] = _rot_x(20)
        frame[JOINT_INDEX["Spine2"]] = _rot_x(30)
        frame[JOINT_INDEX["Spine3"]] = _rot_x(40)
        tracks = build_pose_tracks(
            [frame],
            [_tpose_joints()],
            self._rest_rotations(),
            [0.0, 1.0, 0.0],
            1.0,
        )
        # Core Spine has no mixamo target: its rotation is not applied anywhere
        # and no track exists for it.
        self.assertNotIn("Spine", tracks["rotations"])
        for name, degrees in (("Spine1", 20.0), ("Spine2", 30.0), ("Spine3", 40.0)):
            w, x, _y, _z = tracks["rotations"][name][0]
            half = math.radians(degrees) / 2
            self.assertAlmostEqual(w, math.cos(half), places=6, msg=name)
            self.assertAlmostEqual(x, math.sin(half), places=6, msg=name)

    def test_hips_location_scales_and_offsets_against_rest_head(self):
        joints = _tpose_joints()
        joints[JOINT_INDEX["Hips"]] = [0.5, 1.0, 0.25]
        tracks = build_pose_tracks(
            [_identity_frame()],
            [joints],
            self._rest_rotations(),
            [0.0, 100.0, 0.0],
            100.0,
        )
        x, y, z = tracks["hips_locations"][0]
        self.assertAlmostEqual(x, 50.0, places=4)
        self.assertAlmostEqual(y, 0.0, places=4)
        self.assertAlmostEqual(z, 25.0, places=4)

    def test_real_fixture_quaternions_are_unit_length(self):
        posed = FIXTURE["posed_joints"]
        scale = derive_scale(posed[0], 0.406)  # ~rig thigh in meters
        tracks = build_pose_tracks(
            FIXTURE["local_rot_mats"],
            posed,
            self._rest_rotations(),
            posed[0][JOINT_INDEX["Hips"]],
            scale,
        )
        for name, quats in tracks["rotations"].items():
            for quat in quats:
                norm = sum(component * component for component in quat) ** 0.5
                self.assertAlmostEqual(norm, 1.0, places=4, msg=name)

    def test_noisy_valid_rotation_yields_finite_unit_quaternion(self):
        frame = _identity_frame()
        frame[JOINT_INDEX["Head"]] = [
            [1.0, 2e-5, 0.0],
            [-2e-5, 0.99999, -1e-5],
            [0.0, 1e-5, 1.00001],
        ]
        validate_motion([frame], [_tpose_joints()], 20)
        tracks = build_pose_tracks(
            [frame],
            [_tpose_joints()],
            self._rest_rotations(),
            [0.0, 1.0, 0.0],
            1.0,
        )
        quaternion = tracks["rotations"]["Head"][0]
        self.assertTrue(all(math.isfinite(component) for component in quaternion))
        norm = sum(component * component for component in quaternion) ** 0.5
        self.assertAlmostEqual(norm, 1.0, places=12)


    def test_validation_cursor_bounds_a_24k_clip(self):
        frame = _identity_frame()
        joints = _tpose_joints()
        cursor = MotionValidationCursor([frame] * 24_000, [joints] * 24_000, 20)
        self.assertFalse(cursor.step(max_frames=17))
        self.assertEqual(cursor.frame_index, 17)
        self.assertFalse(cursor.done)

    def test_pose_track_builder_yields_at_requested_frame_chunks(self):
        frame = _identity_frame()
        joints = _tpose_joints()
        rest = {
            name: IDENTITY
            for name, target in MIXAMO_TARGETS.items()
            if target is not None
        }
        builder = PoseTrackBuilder(
            [frame] * 100,
            [joints] * 100,
            rest,
            [0.0, 1.0, 0.0],
            1.0,
        )
        self.assertFalse(builder.step(max_frames=13))
        self.assertEqual(builder.frame_index, 13)
        while not builder.step(max_frames=13):
            pass
        self.assertEqual(len(builder.tracks["hips_locations"]), 100)

    def test_incremental_cursors_check_cancellation(self):
        cursor = MotionValidationCursor(
            [_identity_frame()] * 2, [_tpose_joints()] * 2, 20
        )
        with self.assertRaisesRegex(MotionRetargetError, "cancelled"):
            cursor.step(cancelled=lambda: True)

if __name__ == "__main__":
    unittest.main()
