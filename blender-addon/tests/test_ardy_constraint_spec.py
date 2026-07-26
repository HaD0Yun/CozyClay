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

import ast
import importlib.util
import math
import pathlib
import sys
import unittest
import unittest.mock

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


class FiniteOutputGuardTests(unittest.TestCase):
    """A diverged clip (NaN/Inf) must be rejected before any measurement or save.

    This guard is a STRENGTHENING, not a re-home of the old best-of-N
    protection, and an earlier version of this docstring said otherwise. The old
    rank_samples did map non-finite cost terms to +inf, but it started from
    ``best = 0`` and only moved on a strictly smaller key, so a diverged draw at
    index 0 still won whenever nothing displaced it. Measured against
    3cd5fafa~1: ``rank_samples([(nan, nan, 1.0)])`` returns 0. Since
    --num-samples defaulted to 1, the DEFAULT path had no divergence protection
    at all; the +inf mapping only helped a multi-sample run that happened to
    contain a finite draw.

    A threshold comparison cannot do this job either, because NaN comparisons are
    always False, so ``value > threshold`` silently passes a diverged clip. So
    find_non_finite walks every array bound for the npz with math.isfinite.
    Stdlib-only so it runs here without numpy/torch/ardy.
    """

    NAN = float("nan")
    INF = float("inf")

    @staticmethod
    def _clip(**overrides):
        """A small finite motion_dict (all-finite baseline) with optional overrides."""
        frame = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
        base = {
            "posed_joints": [[[0.0, 0.0, 0.0], [0.1, 0.2, 0.3]]],
            "global_rot_mats": [[frame]],
            "local_rot_mats": [[frame]],
            "root_positions": [[0.0, 0.0, 0.0]],
            "foot_contacts": [[0.0, 1.0, 0.0]],
        }
        base.update(overrides)
        return base

    def test_all_finite_returns_none(self):
        self.assertIsNone(ccg.find_non_finite(self._clip()))

    def test_a_nan_is_found_with_member_frame_and_index(self):
        """The report must name where the divergence is, not just that one exists."""
        clip = self._clip(
            posed_joints=[[[0.0, 0.0, 0.0], [self.NAN, 0.2, 0.3]]]
        )
        result = ccg.find_non_finite(clip)
        self.assertIsNotNone(result)
        self.assertEqual(result["member"], "posed_joints")
        self.assertEqual(result["frame"], 0)
        self.assertEqual(result["index"], (1, 0))
        self.assertTrue(math.isnan(result["value"]))

    def test_positive_and_negative_inf_are_found(self):
        """Both signs of infinity are non-finite; a threshold check would miss NaN
        but must also not special-case +inf over -inf.
        """
        for bad, label in ((self.INF, "pos"), (-self.INF, "neg")):
            with self.subTest(sign=label):
                clip = self._clip(root_positions=[[bad, 0.0, 0.0]])
                result = ccg.find_non_finite(clip)
                self.assertIsNotNone(result)
                self.assertEqual(result["member"], "root_positions")
                self.assertEqual(result["frame"], 0)
                self.assertEqual(result["index"], (0,))
                self.assertEqual(result["value"], bad)

    def test_detection_covers_every_production_member(self):
        """The guard must cover EVERY member save_motion_npz serializes.

        All five real members are poisoned in turn, global_rot_mats included:
        omitting it would let a guard that skips exactly that member pass while
        a diverged rotation reached the npz.
        """
        rotation = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
        bad_rotation = [[self.NAN, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
        for member, shape in (
            ("posed_joints", [[[0.0, 0.0, 0.0], [self.NAN, 0.2, 0.3]]]),
            ("global_rot_mats", [[bad_rotation]]),
            ("local_rot_mats", [[bad_rotation]]),
            ("root_positions", [[0.0, self.NAN, 0.0]]),
            ("foot_contacts", [[0.0, 1.0, self.NAN]]),
        ):
            with self.subTest(member=member):
                clip = self._clip(**{member: shape})
                result = ccg.find_non_finite(clip)
                self.assertIsNotNone(result)
                self.assertEqual(result["member"], member)
        # Sanity: the unpoisoned baseline that every case above starts from must
        # itself be clean, or these subTests could pass for the wrong reason.
        self.assertIsNone(ccg.find_non_finite(self._clip(global_rot_mats=[[rotation]])))

    def test_a_divergence_after_the_first_frame_is_found(self):
        """Every frame is scanned, not just the first.

        Every other fixture here puts the bad value in frame 0, so a guard
        weakened to inspect only the opening frame would pass them all while a
        clip that diverges mid-motion still reached the npz.
        """
        good = [[0.0, 0.0, 0.0], [0.1, 0.2, 0.3]]
        bad = [[0.0, 0.0, 0.0], [0.1, self.NAN, 0.3]]
        clip = self._clip(posed_joints=[good, good, good, bad])
        result = ccg.find_non_finite(clip)
        self.assertIsNotNone(result)
        self.assertEqual(result["member"], "posed_joints")
        self.assertEqual(result["frame"], 3)
        self.assertEqual(result["index"], (1, 1))

    def test_detection_does_not_depend_on_iteration_order(self):
        """A NaN in the last member when sorted alphabetically is still found."""
        clip = self._clip(zzz_last_member=[[self.NAN]])
        result = ccg.find_non_finite(clip)
        self.assertIsNotNone(result)
        self.assertEqual(result["member"], "zzz_last_member")

    def test_integer_and_boolean_members_are_never_reported(self):
        """Integer and boolean arrays are always finite; reporting them would be a
        false alarm that blocks a valid clip.
        """
        clip = self._clip(
            foot_contacts=[[1, 0, 1]],          # plain ints / bools
            frame_counts=[[10, 20]],            # integer member
        )
        self.assertIsNone(ccg.find_non_finite(clip))

    def test_sorted_member_order_not_insertion_order(self):
        """Members are visited in sorted name order, not dict insertion order, so
        the report is deterministic regardless of how the dict was built. Build the
        dict with a later-sorted member inserted FIRST: sorted iteration must still
        report the alphabetically-earlier member.
        """
        # root_positions sorts AFTER posed_joints, but is inserted first here.
        clip = {
            "root_positions": [[self.INF, 0.0, 0.0]],
            "posed_joints": [[[self.NAN, 0.0, 0.0]]],
        }
        result = ccg.find_non_finite(clip)
        self.assertEqual(result["member"], "posed_joints")

    @staticmethod
    def _scalar(value):
        """A stdlib stub for a numpy 0-D float member.

        Exposes shape == (), dtype.kind == 'f' and __float__ but no __iter__, so
        it reproduces exactly how a scalar / 0-D numpy value reaches the guard.
        No numpy on this machine, so the stub stands in for it.
        """
        class _Dtype:
            kind = "f"

        class _Scalar:
            shape = ()
            dtype = _Dtype()

            def __float__(self_inner):
                return float(value)

        return _Scalar()

    def test_a_non_finite_scalar_member_is_reported_not_crashed(self):
        """A member with no frame axis (0-D) must be reported, not raise
        TypeError on enumerate(). This guard runs only when output is already
        suspect, so an opaque crash instead of a named divergence is wrong.
        """
        clip = self._clip(posed_joints=self._scalar(self.NAN))
        result = ccg.find_non_finite(clip)
        self.assertIsNotNone(result)
        self.assertEqual(result["member"], "posed_joints")
        self.assertIsNone(result["frame"])
        self.assertEqual(result["index"], ())
        self.assertTrue(math.isnan(result["value"]))

    def test_a_finite_scalar_member_returns_none(self):
        clip = self._clip(posed_joints=self._scalar(1.5))
        self.assertIsNone(ccg.find_non_finite(clip))

    def test_a_non_numeric_member_is_skipped_not_crashed(self):
        """A non-numeric member must not abort a generation that is otherwise fine.

        save_motion_npz stores every member through np.asarray, which accepts a
        string or object member happily, so the pre-guard pipeline tolerated one.
        Calling float() on it would make this guard fail a valid run -- a
        regression the guard itself would have introduced. Only real numbers can
        be non-finite, so anything else is outside its remit and is skipped.
        """
        for label, member in (
            ("string", "some-metadata"),
            ("bytes", b"raw"),
            ("dict", {"note": 1.0}),
            ("nested object", [[object()]]),
        ):
            with self.subTest(member=label):
                self.assertIsNone(ccg.find_non_finite(self._clip(extra=member)))

    def test_a_non_numeric_member_does_not_hide_a_real_divergence(self):
        """The skip must not become a blanket escape hatch."""
        clip = self._clip(extra="some-metadata", root_positions=[[0.0, self.NAN, 0.0]])
        result = ccg.find_non_finite(clip)
        self.assertIsNotNone(result)
        self.assertEqual(result["member"], "root_positions")


class MainGuardContractTests(unittest.TestCase):
    """main() invokes the divergence guard in the right place, locked at the AST level.

    main() needs torch and numpy, so it cannot be executed on this machine. A
    static contract over the parsed source is the idiomatic lock here:
    ImportSurfaceTests already treats source-level invariants as first-class.
    Each assertion below fails under a concrete mutation (verified manually for
    the five mutations named in the story), not just a reorder.

    Compared by source line number of the enclosing statement (ast lineno),
    which is robust to statements being nested in if blocks and to reordering.
    """

    MEASURE_NAMES = ("measure_residuals", "measure_orientations",
                     "measure_poses", "measure_waypoints")

    @classmethod
    def _main_node(cls):
        tree = ast.parse(SCRIPT.read_text())
        mains = [node for node in tree.body
                 if isinstance(node, ast.FunctionDef) and node.name == "main"]
        assert mains, "no main() definition in cclay_constrained_generate.py"
        return mains[0]

    @classmethod
    def _call_lineno(cls, node, predicate):
        """First lineno of a Call matching predicate, anywhere inside node."""
        first = None
        for child in ast.walk(node):
            if isinstance(child, ast.Call) and predicate(child):
                lineno = getattr(child, "lineno")
                if first is None or lineno < first:
                    first = lineno
        return first

    @classmethod
    def _guard_statements(cls):
        """The ``non_finite = find_non_finite(...)`` assign and the statement after it.

        Returned as a pair so a test can prove the raise is controlled BY the
        guard's result, not merely that both exist somewhere in main().

        Searches ONLY ``main.body``, deliberately. A pair nested in an inner
        block is not equivalent: wrapping the guard in ``if False:`` or in a
        ``try`` whose handler swallows the raise satisfies every other assertion
        while a default run walks straight on to measurement and save. Requiring
        the guard on main()'s own unconditional statement list is what rules that
        out, and line-number ordering alone cannot.

        Collects EVERY match rather than the first: with two such assignments a
        first-match search could validate a decoy pair while the real one was
        weakened. The caller asserts there is exactly one.
        """
        block = cls._main_node().body
        pairs = []
        for index, statement in enumerate(block):
            if (
                isinstance(statement, ast.Assign)
                and len(statement.targets) == 1
                and isinstance(statement.targets[0], ast.Name)
                and statement.targets[0].id == "non_finite"
                and isinstance(statement.value, ast.Call)
                and isinstance(statement.value.func, ast.Name)
                and statement.value.func.id == "find_non_finite"
            ):
                following = block[index + 1] if index + 1 < len(block) else None
                pairs.append((statement, following))
        return pairs

    # No standalone "main calls X" tests: the two ordering tests below already
    # assert both endpoints exist before comparing them, and the binding test
    # proves the guard call exists. Separate existence tests only duplicated
    # that, and duplicated assertions rot independently.

    def test_guard_call_precedes_first_measure_call(self):
        guard = self._call_lineno(
            self._main_node(),
            lambda c: isinstance(c.func, ast.Name) and c.func.id == "find_non_finite",
        )
        measure = self._call_lineno(
            self._main_node(),
            lambda c: (isinstance(c.func, ast.Name)
                       and c.func.id in self.MEASURE_NAMES),
        )
        self.assertIsNotNone(guard)
        self.assertIsNotNone(measure)
        self.assertLess(guard, measure,
                        "find_non_finite must run BEFORE the first measure_* call")

    def test_guard_call_precedes_save_motion_npz(self):
        guard = self._call_lineno(
            self._main_node(),
            lambda c: isinstance(c.func, ast.Name) and c.func.id == "find_non_finite",
        )
        save = self._call_lineno(
            self._main_node(),
            lambda c: isinstance(c.func, ast.Name) and c.func.id == "save_motion_npz",
        )
        self.assertIsNotNone(guard)
        self.assertIsNotNone(save)
        self.assertLess(guard, save,
                        "find_non_finite must run BEFORE save_motion_npz")

    def test_the_guard_result_controls_the_raise(self):
        """The raise must be controlled BY the guard's result, bound structurally.

        Proving only that main() calls the guard and that a divergence-worded
        raise exists somewhere leaves the worst mutation open: inverting
        ``is not None`` to ``is None`` keeps every such assertion green while
        rejecting healthy clips and saving diverged ones. Two weaker forms fail
        here too -- a decoy unreachable raise carrying the wording, and moving
        the raise out from under the guard.

        So pin the chain: the assignment calls find_non_finite on the motion
        dict, the very next statement tests that result with `is not None`, and
        the raise must be a DIRECT statement of that if body. Exactly one such
        assignment and exactly one divergence-worded raise may exist.

        Nesting matters: found with ast.walk, a raise wrapped in
        ``if non_finite["member"] == "posed_joints":`` would satisfy a
        "somewhere in the body" check while letting non-finite rotations, root
        positions or contacts through to measurement and save. So the raise has
        to be unavoidable once the guard fires.
        """
        source = SCRIPT.read_text()
        pairs = self._guard_statements()
        self.assertEqual(
            len(pairs),
            1,
            "main() must assign non_finite = find_non_finite(...) exactly once",
        )
        assign, following = pairs[0]

        arguments = [
            node.id for node in assign.value.args if isinstance(node, ast.Name)
        ]
        self.assertIn(
            "motion_dict",
            arguments,
            "the guard must be handed the dict that save_motion_npz serializes",
        )

        self.assertIsInstance(
            following,
            ast.If,
            "the statement right after the guard call must test its result",
        )
        test = following.test
        self.assertIsInstance(test, ast.Compare, "the guard test must be a comparison")
        self.assertIsInstance(
            test.left, ast.Name, "the guard test must compare non_finite itself"
        )
        self.assertEqual(test.left.id, "non_finite")
        self.assertEqual(len(test.ops), 1)
        self.assertIsInstance(
            test.ops[0],
            ast.IsNot,
            "must be `non_finite is not None`; inverting this saves diverged clips",
        )
        self.assertIsInstance(test.comparators[0], ast.Constant)
        self.assertIsNone(test.comparators[0].value)

        # The divergence raise is now identified by the helper it calls rather
        # than by inline wording, since main() delegates the message to
        # divergence_message().
        direct = [
            statement
            for statement in following.body
            if isinstance(statement, ast.Raise)
            and "divergence_message" in (ast.get_source_segment(source, statement) or "")
        ]
        self.assertEqual(
            len(direct),
            1,
            "the divergence raise must be a DIRECT statement of the guard body, "
            "not nested behind a further condition that could let members through",
        )
        # Exact reachability: the raise is the guard body's FIRST statement, so
        # nothing can run ahead of it. An earlier form allowed "safe" preceding
        # statement kinds, which was both too weak and too strict -- ast.Expr
        # admits sys.exit() and a bare yield, while an ordinary AugAssign used to
        # build the message was rejected. Delegating the wording to
        # divergence_message() is what makes this simple invariant possible.
        self.assertIs(
            direct[0],
            following.body[0],
            "the raise must be the guard body's FIRST statement, so nothing can "
            "exit, branch or loop ahead of it; build the message in "
            "divergence_message() instead of inline",
        )
        self.assertEqual(
            len(following.body),
            1,
            "the guard body must be exactly the raise, nothing else",
        )
        # The wording itself lives in the helper and is pinned there, so a
        # reworded message still fails a test rather than passing silently.
        self.assertIn(
            "refusing to save or measure a non-finite clip",
            ccg.divergence_message(
                {"member": "posed_joints", "frame": 3, "index": (1, 1), "value": float("nan")}
            ),
        )

        everywhere = [
            node
            for node in ast.walk(self._main_node())
            if isinstance(node, ast.Raise)
            and "divergence_message" in (ast.get_source_segment(source, node) or "")
        ]
        self.assertEqual(
            len(everywhere),
            1,
            "a second divergence raise would let the guarded one be downgraded",
        )

    def test_exactly_one_sample_is_generated_and_it_is_what_gets_saved(self):
        """The guarded dict must BE the saved payload, generated exactly once.

        Guarding `motion_dict` proves nothing if a different clip is what
        reaches disk. Replacing the save argument with a second generation
        satisfied every other assertion here -- the guard still ran on
        motion_dict, still preceded the save, still controlled its raise --
        while producing a SECOND, unguarded draw that could diverge straight
        into the npz. It also silently broke this story's whole point, one
        generation per run, and made the reported measurements describe a clip
        other than the saved one. Rebinding motion_dict between the guard and
        the save is the same bug.

        So pin the chain end to end: the sampling pass is inline, motion_dict is
        assigned once from it, and that same name is handed to the single save.
        """
        main = self._main_node()

        # No `sample_once` name ban and no shape pin on how motion_dict is built.
        # Both were implementation spellings, and execution cardinality now
        # belongs to test_ardy_generate_once.py, which counts sampler invocations.
        # What syntax genuinely expresses, and what stays here, is the DATA
        # binding: one assignment, and that same name handed to the single save.

        assignments = [
            statement
            for statement in ast.walk(main)
            if isinstance(statement, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == "motion_dict"
                for target in statement.targets
            )
        ]
        self.assertEqual(
            len(assignments),
            1,
            "motion_dict must be assigned once; a later rebinding escapes the guard",
        )

        saves = [
            node
            for node in ast.walk(main)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "save_motion_npz"
        ]
        self.assertEqual(len(saves), 1, "main() must save exactly once")
        payload = saves[0].args[1]
        self.assertIsInstance(
            payload,
            ast.Name,
            "the saved payload must be the guarded name, not a fresh expression",
        )
        self.assertEqual(
            payload.id,
            "motion_dict",
            "save_motion_npz must serialize the dict find_non_finite inspected",
        )

    # There is deliberately NO sampler-cardinality test in this file. Six
    # attempts lived here and each was defeated by one more spelling: a list
    # comprehension around the draw, a nested draw() called twice, a @retry_once
    # decorator on the helper, and then aliases and bound methods of the model
    # object. The invariant is semantic -- how many times a callable is invoked --
    # and syntax cannot express it. test_ardy_generate_once.py owns it by counting
    # invocations against a fake sampler, and that suite catches every one of
    # those spellings including `_retry_once(model.forward, ...)`, which no AST
    # rule here could see.
    #
    # What stays in this file is what syntax genuinely does express: the guard
    # is bound to its result and precedes measurement and save, the saved payload
    # is the guarded name, the entrypoint is canonical, and the removed flags are
    # rejected by the parser.

    def test_main_itself_runs_once_per_process(self):
        """The module must invoke main() once, undecorated and non-reentrant.

        Owning the draw inside main() is not enough while main() is itself a
        callable: a @retry_once decorator on main re-enters the whole body after
        a post-draw failure in inverse, post-processing, measurement or save, so
        a second GPU draw happens in the same run. `if __name__ == "__main__":
        main(); main()` is the blunter version. Both were verified to pass every
        other assertion in this class before this test existed.

        This closes the module boundary, which is as far as a source contract
        over this file can reach. It deliberately does NOT try to prove one draw
        per user intent: the shell wrapper could invoke the CLI twice and nothing
        in this file could tell. That side is covered separately, by the wrapper
        tests asserting a single constrained ssh invocation.
        """
        module = ast.parse(SCRIPT.read_text())
        main = self._main_node()

        self.assertEqual(
            main.decorator_list,
            [],
            "main() must be undecorated; a retry decorator would re-enter the "
            "whole body and draw again after a post-draw failure",
        )

        recursive = [
            node
            for node in ast.walk(main)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "main"
        ]
        self.assertEqual(recursive, [], "main() must not call itself")

        guards = [
            node
            for node in module.body
            if isinstance(node, ast.If) and "__main__" in ast.unparse(node.test)
        ]
        self.assertEqual(len(guards), 1, "exactly one __main__ entrypoint guard")
        body = guards[0].body
        self.assertEqual(
            len(body), 1, "the entrypoint must be exactly one statement: main()"
        )
        self.assertIsInstance(body[0], ast.Expr)
        self.assertIsInstance(body[0].value, ast.Call)
        self.assertIsInstance(body[0].value.func, ast.Name)
        self.assertEqual(
            body[0].value.func.id,
            "main",
            "the entrypoint must call main() directly, not a wrapper around it",
        )

    def test_the_module_surface_has_no_other_activation_path(self):
        """The canonical guard is the only syntactic path to main().

        Checking main()'s decorators and its own body was not the terminal
        boundary I claimed. Two in-file mutations were verified to slip past it:
        `atexit.register(main)` at module level re-invokes main at interpreter
        shutdown, and an indirect helper called from main can call main back,
        because a recursion scan over main only sees a callee named `main`.

        So pin the module SURFACE instead of enumerating callback APIs, which
        would repeat the same losing pattern: at module level allow only the
        docstring, imports, literal constant assignments, function definitions
        and the one entry guard; and allow exactly one reference to the name
        `main` in the whole module, the call inside that guard.

        What this still cannot prove is dynamic: reflection such as
        globals()["main"](), or an outer process invoking the CLI twice. The
        second is covered on the wrapper side, which asserts exactly one
        constrained generation ssh record.

        Scope, stated narrowly on purpose: this pins that no module-level
        STATEMENT other than the guard can reach main. It does NOT claim nothing
        whatsoever executes at import. Definitions are admitted whole, and Python
        does evaluate their decorators, default arguments, annotations, class
        bases and class bodies at import time. That is not a route to a second
        draw by itself, because the reference count below allows exactly one
        mention of the name `main` anywhere in the module.

        Measured costs, all accepted. A module-level `if TYPE_CHECKING:` block is
        rejected even though it runs nothing; so are an `AnnAssign` and a
        constant built by a call such as `frozenset((...))`. This module has none
        of them and must keep its heavy imports lazy anyway, so adding one would
        be a deliberate change that can update this contract with it. Meanwhile
        `__all__ = ["main"]` is allowed, correctly: the string is not a
        reference, so it neither defers nor repeats a call. `X = main` after the
        definition IS rejected, by the reference count rather than by the
        statement filter.
        """
        module = ast.parse(SCRIPT.read_text())

        allowed = (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        for index, statement in enumerate(module.body):
            if isinstance(statement, allowed):
                continue
            if index == 0 and isinstance(statement, ast.Expr) and isinstance(
                statement.value, ast.Constant
            ):
                continue  # module docstring
            if isinstance(statement, ast.Assign) and all(
                isinstance(node, (ast.Constant, ast.Tuple, ast.List, ast.Dict, ast.Name, ast.Load))
                for node in ast.walk(statement.value)
            ):
                continue  # literal constant table
            self.assertTrue(
                isinstance(statement, ast.If) and "__main__" in ast.unparse(statement.test),
                "module level must hold only the docstring, imports, literal "
                "constants, definitions and the entry guard; anything else runs "
                f"at import and could re-enter main (found "
                f"{type(statement).__name__} at line {statement.lineno}: "
                f"{ast.unparse(statement)[:60]})",
            )

        references = [
            node
            for node in ast.walk(module)
            if isinstance(node, ast.Name) and node.id == "main"
        ]
        self.assertEqual(
            len(references),
            1,
            "the name `main` may appear exactly once in the module, as the call "
            "inside the entry guard; any other reference could defer or repeat it "
            f"(found {len(references)})",
        )


class ArgParseTests(unittest.TestCase):
    """--num-samples must be GONE, not merely unused: argparse must reject it.

    parse_args is module-level and stdlib-only, so it can be exercised here by
    patching sys.argv. A minimal valid argv must still parse, so the rejection
    test cannot pass vacuously by rejecting everything.
    """

    MINIMAL = [
        "cclay_constrained_generate.py",
        "--prompt", "a person waves",
        "--duration", "2",
        "--base", "/tmp/base.npz",
        "--target", "5", "LeftFoot", "0.1", "0.2", "0.3",
    ]

    def test_num_samples_flag_is_rejected(self):
        """The flag is deleted from the parser, so argparse exits with code 2."""
        with self.assertRaises(SystemExit) as caught:
            with unittest.mock.patch.object(sys, "argv", self.MINIMAL + ["--num-samples", "4"]):
                ccg.parse_args()
        self.assertEqual(caught.exception.code, 2)

    def test_a_minimal_valid_argv_still_parses(self):
        """Guard against the rejection test passing by rejecting everything."""
        with unittest.mock.patch.object(sys, "argv", self.MINIMAL):
            args = ccg.parse_args()
        self.assertEqual(args.prompt, "a person waves")
        self.assertEqual(args.duration, 2.0)
        self.assertFalse(hasattr(args, "num_samples"))


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
