"""Validation and measurement math for scripts/ardy/cclay_constrained_generate.py.

This lives under blender-addon/tests because that is the ONLY Python test
directory CI discovers (.github/workflows/ci.yml runs
`python3 -m unittest discover -s blender-addon/tests -v`). The module under test
is a generator script that runs on the ARDY GPU box, but its argument validation
and its error math are pure and are exactly the parts that must not regress
silently: they decide whether a malformed constraint reaches a shared GPU and
whether the numbers the director reads mean anything.

The script imports torch, numpy and ardy LAZILY inside the functions that need
them precisely so this file can import it with plain stdlib. If someone moves an
`import torch` back to module scope, every test here fails with ImportError,
which is the intended alarm.
"""

import importlib.util
import math
import pathlib
import sys
import unittest

SCRIPT = (
    pathlib.Path(__file__).parents[2] / "scripts" / "ardy" / "cclay_constrained_generate.py"
)


def _load():
    spec = importlib.util.spec_from_file_location("cclay_constrained_generate", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ccg = _load()

IDENTITY = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))


class ImportSurfaceTests(unittest.TestCase):
    def test_module_imports_without_torch_numpy_or_ardy(self):
        """The heavy imports must stay lazy or this suite cannot run at all.

        The machine that edits this script has no torch, no numpy and no ardy;
        only the GPU box does. Module-scope heavy imports would leave every
        validator untested.
        """
        self.assertEqual(
            ccg.JOINT_TO_CONSTRAINT,
            ("LeftFoot", "RightFoot", "LeftHand", "RightHand"),
        )
        # The load above would already ImportError if a heavy import went back to
        # module scope, but assert the absence directly so the failure names the
        # cause instead of erroring at collection with a bare ImportError.
        for heavy in ("torch", "numpy", "ardy"):
            self.assertNotIn(
                heavy,
                sys.modules,
                f"{heavy} must not be imported at module scope: the machine that "
                "edits this script cannot provide it, so every validator here "
                "would become untestable.",
            )


class FrameAndNumberTests(unittest.TestCase):
    def test_frame_must_be_an_integer_inside_the_clip(self):
        self.assertEqual(ccg._parse_frame("0", 100, "--x"), 0)
        self.assertEqual(ccg._parse_frame("99", 100, "--x"), 99)
        for bad in ("100", "-1", "3.5", "ten", ""):
            with self.subTest(frame=bad):
                with self.assertRaises(ValueError):
                    ccg._parse_frame(bad, 100, "--x")

    def test_floats_reject_non_numbers_and_name_the_flag(self):
        self.assertEqual(ccg._parse_floats(("1", "-2.5"), "--x", "A B"), [1.0, -2.5])
        with self.assertRaises(ValueError) as caught:
            ccg._parse_floats(("1", "sideways"), "--root-2d", "X Z")
        self.assertIn("--root-2d", str(caught.exception))


class OrientationTests(unittest.TestCase):
    TARGETS = [{"frame": 10, "joint": "RightHand", "requested": [0.0, 0.0, 0.0]}]

    def test_orientation_requires_its_matching_position(self):
        """An end-effector constraint conditions position AND rotation together,
        so an orientation alone would leave the joint's location to the sampler
        and reintroduce the arbitrary-position defect this flag exists to fix.
        """
        for frame, joint in ((11, "RightHand"), (10, "LeftHand")):
            with self.subTest(frame=frame, joint=joint):
                with self.assertRaises(ValueError) as caught:
                    ccg.parse_orientations(
                        [[str(frame), joint, "1", "0", "0", "0"]], 100, self.TARGETS
                    )
                self.assertIn("no matching --target", str(caught.exception))

    def test_non_unit_and_degenerate_quaternions_are_rejected(self):
        for quaternion in (
            ("2", "0", "0", "0"),
            ("0", "0", "0", "0"),
            ("nan", "0", "0", "0"),
            ("inf", "0", "0", "0"),
            ("1e400", "0", "0", "0"),
        ):
            with self.subTest(quaternion=quaternion):
                with self.assertRaises(ValueError):
                    ccg.parse_orientations(
                        [["10", "RightHand", *quaternion]], 100, self.TARGETS
                    )

    def test_unknown_joint_and_duplicates_are_rejected(self):
        with self.assertRaises(ValueError):
            ccg.parse_orientations([["10", "Nose", "1", "0", "0", "0"]], 100, self.TARGETS)
        with self.assertRaises(ValueError) as caught:
            ccg.parse_orientations(
                [
                    ["10", "RightHand", "1", "0", "0", "0"],
                    ["10", "RightHand", "1", "0", "0", "0"],
                ],
                100,
                self.TARGETS,
            )
        self.assertIn("duplicate", str(caught.exception))

    def test_a_valid_orientation_is_accepted(self):
        self.assertEqual(
            ccg.parse_orientations([["10", "RightHand", "1", "0", "0", "0"]], 100, self.TARGETS),
            [{"frame": 10, "joint": "RightHand", "quaternion": [1.0, 0.0, 0.0, 0.0]}],
        )


class PoseTests(unittest.TestCase):
    def test_source_frame_and_destination_frame_are_validated(self):
        with self.assertRaises(ValueError) as caught:
            ccg.parse_poses([[str(SCRIPT), "-1", "5"]], 100)
        self.assertIn("SRC_FRAME must be >= 0", str(caught.exception))
        with self.assertRaises(ValueError) as caught:
            ccg.parse_poses([[str(SCRIPT), "3.5", "5"]], 100)
        self.assertIn("SRC_FRAME must be an integer", str(caught.exception))
        with self.assertRaises(ValueError):
            ccg.parse_poses([[str(SCRIPT), "0", "100"]], 100)

    def test_missing_source_file_is_rejected_before_anything_else(self):
        with self.assertRaises(ValueError) as caught:
            ccg.parse_poses([["/tmp/definitely-not-here.npz", "0", "5"]], 100)
        self.assertIn("not found", str(caught.exception))

    def test_one_pose_per_destination_frame(self):
        with self.assertRaises(ValueError) as caught:
            ccg.parse_poses([[str(SCRIPT), "0", "5"], [str(SCRIPT), "1", "5"]], 100)
        self.assertIn("duplicate", str(caught.exception))
        self.assertEqual(
            [entry["frame"] for entry in ccg.parse_poses(
                [[str(SCRIPT), "0", "9"], [str(SCRIPT), "1", "5"]], 100
            )],
            [5, 9],
        )


class RootWaypointTests(unittest.TestCase):
    def test_heading_is_all_or_nothing(self):
        """ARDY conditions the whole waypoint set on one heading tensor, so a
        partly-headed request would silently invent headings for the rest.
        """
        with self.assertRaises(ValueError) as caught:
            ccg.parse_root_waypoints(
                [["0", "0", "0", "none"], ["10", "1", "0", "0.5"]], 100
            )
        self.assertIn("for every waypoint or for none", str(caught.exception))

    def test_none_is_case_insensitive_and_waypoints_sort_by_frame(self):
        waypoints = ccg.parse_root_waypoints(
            [["20", "2", "0", "NONE"], ["5", "1", "0", "nOnE"]], 100
        )
        self.assertEqual([entry["frame"] for entry in waypoints], [5, 20])
        self.assertEqual([entry["heading"] for entry in waypoints], [None, None])

    def test_duplicate_frames_are_rejected(self):
        with self.assertRaises(ValueError):
            ccg.parse_root_waypoints(
                [["5", "0", "0", "none"], ["5", "1", "0", "none"]], 100
            )


class RotationMathTests(unittest.TestCase):
    @staticmethod
    def _matrix(quaternion):
        return [
            [float(value) for value in row]
            for row in ccg._quaternion_matrix_rows(quaternion)
        ]

    def test_quaternion_is_normalized_so_every_accepted_input_is_rigid(self):
        """The 1e-3 unit tolerance is an input-sanity check, not a rigidity one.

        Fed verbatim, a norm-1.001 quaternion yields determinant 1.005 and
        orthonormality error 0.0036 -- not a rotation, but handed to ARDY as one.
        """
        for scale in (1.0, 1.0009, 0.9991, 3.0):
            with self.subTest(scale=scale):
                matrix = self._matrix([0.7071068 * scale, 0.7071068 * scale, 0.0, 0.0])
                determinant = (
                    matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
                    - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
                    + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
                )
                self.assertAlmostEqual(determinant, 1.0, places=6)
                for i in range(3):
                    for j in range(3):
                        expected = 1.0 if i == j else 0.0
                        dot = sum(matrix[i][k] * matrix[j][k] for k in range(3))
                        self.assertAlmostEqual(dot, expected, places=6)

    def test_negated_quaternion_is_the_same_rotation(self):
        forward = self._matrix([0.0, 0.0, 1.0, 0.0])
        negated = self._matrix([0.0, 0.0, -1.0, 0.0])
        self.assertEqual(ccg._geodesic_degrees(forward, negated), 0.0)

    def test_convention_holds_about_every_axis_not_just_x(self):
        """Closes the y/z coverage hole in the X-only convention test.

        A rotation about X leaves the y/z-coupled terms of the quaternion formula
        at zero, so an X-only probe cannot see a y<->z swap -- which is exactly
        the axis-reordering mirror hazard that the Blender->npz reflection makes
        easy to introduce. Each axis below must send the next basis vector to the
        one after it under a right-handed +90 degrees rotation.
        """
        half = math.sqrt(0.5)
        cases = (
            ("about X", [half, half, 0.0, 0.0], (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
            ("about Y", [half, 0.0, half, 0.0], (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
            ("about Z", [half, 0.0, 0.0, half], (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
        )
        for label, quaternion, probe, expected in cases:
            with self.subTest(axis=label):
                matrix = self._matrix(quaternion)
                sent = [
                    sum(matrix[i][k] * probe[k] for k in range(3)) for i in range(3)
                ]
                for got, want in zip(sent, expected):
                    self.assertAlmostEqual(got, want, places=6)

    def test_convention_is_the_active_column_vector_form(self):
        """Pins the convention against an INDEPENDENT construction.

        `achieved_error_deg: 0.0` on a live run cannot prove this, because the
        same helper builds the constraint and measures it -- a transpose would
        cancel and still report 0.0. Here a +90 degrees rotation about X must send
        local +Y to +Z; the transpose sends it to -Z, so this test fails loudly
        on a mirrored convention. Verified live against ARDY's own emitted
        global_rot_mats: round-tripping matrix -> quaternion -> matrix returned
        the original at 0.000000 deg and its transpose at 179.980218 deg.
        """
        matrix = self._matrix([math.cos(math.pi / 4), math.sin(math.pi / 4), 0.0, 0.0])
        sent = [sum(matrix[i][k] * (0.0, 1.0, 0.0)[k] for k in range(3)) for i in range(3)]
        self.assertAlmostEqual(sent[0], 0.0, places=6)
        self.assertAlmostEqual(sent[1], 0.0, places=6)
        self.assertAlmostEqual(sent[2], 1.0, places=6)

    def test_geodesic_endpoints(self):
        self.assertEqual(ccg._geodesic_degrees(IDENTITY, IDENTITY), 0.0)
        turned = self._matrix([0.0, 1.0, 0.0, 0.0])
        self.assertAlmostEqual(ccg._geodesic_degrees(IDENTITY, turned), 180.0, places=4)


class SampleRankingTests(unittest.TestCase):
    """The best-of-N ordering is load-bearing, so it is pinned here.

    A regression in any of these (ranking three terms instead of two, min becoming
    max, the tuple order swapping) would ship green otherwise: the wrapper suite
    stops at the ssh boundary and the live GPU run is not a repo test.
    """

    def test_constraint_error_outranks_smoothness(self):
        """Hitting the contact comes first; a silky clip that misses is still wrong."""
        self.assertEqual(
            ccg.rank_samples([(0.10, 0.01, 2.0), (0.00, 0.90, 2.0)]), 1
        )

    def test_acceleration_breaks_a_constraint_tie(self):
        """The common case: ARDY lands these contacts to under a millimetre, so
        nearly every real run is decided by this term rather than the first.
        """
        self.assertEqual(
            ccg.rank_samples([(0.0, 0.44, 2.7), (0.0, 0.24, 1.9), (0.0, 0.33, 2.8)]), 1
        )

    def test_travel_is_reported_but_never_ranked(self):
        """Including travel would quietly make it a third tie-breaker preferring
        whichever draw moved less, which is the opposite of a quality signal.
        """
        self.assertEqual(ccg.rank_samples([(0.0, 0.2, 0.05), (0.0, 0.2, 9.9)]), 0)
        self.assertEqual(ccg.rank_samples([(0.0, 0.2, 9.9), (0.0, 0.2, 0.05)]), 0)

    def test_ties_keep_the_lowest_index_so_a_seeded_rerun_is_stable(self):
        self.assertEqual(ccg.rank_samples([(0.0, 0.2, 1.0)] * 4), 0)

    def test_a_diverged_sample_cannot_win_from_the_lowest_index(self):
        """NaN loses every comparison, so a diverged draw at index 0 used to win
        outright -- Python's own min has the same hole. Non-finite ranked terms are
        mapped to +inf so they can only ever lose.
        """
        nan = float("nan")
        self.assertEqual(ccg.rank_samples([(nan, 0.01, 1.0), (0.0, 0.90, 1.0)]), 1)
        self.assertEqual(ccg.rank_samples([(0.0, nan, 1.0), (0.0, 0.90, 1.0)]), 1)
        self.assertEqual(
            ccg.rank_samples([(float("inf"), 0.01, 1.0), (0.5, 0.90, 1.0)]), 1
        )
        # Every draw diverged: there is no good answer, so keep index 0 rather
        # than raising, and let the reported costs show what happened.
        self.assertEqual(ccg.rank_samples([(nan, nan, 1.0), (nan, nan, 1.0)]), 0)

    def test_single_sample_and_empty_input(self):
        self.assertEqual(ccg.rank_samples([(0.5, 0.5, 0.5)]), 0)
        with self.assertRaises(ValueError):
            ccg.rank_samples([])


class ResidualTests(unittest.TestCase):
    def test_no_target_reports_null_not_zero(self):
        """A run may constrain only a path or only a pose. Zero would read as a
        perfect hit on a measurement that was never taken.
        """
        reported, residual = ccg.measure_residuals([], [], None, None)
        self.assertEqual(reported, [])
        self.assertIsNone(residual)


if __name__ == "__main__":
    unittest.main()
