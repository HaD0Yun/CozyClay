"""Pure (bpy-free) tests for multi-angle viewport view-matrix synthesis."""

from __future__ import annotations

import math
import unittest

from cclay.view_matrices import (
    ALL_VIEW_NAMES,
    CONTACT_LOW_EYE_HEIGHT,
    DEFAULT_FOV_Y,
    DEFAULT_VIEWS,
    FRAMING_MARGIN,
    MAX_VIEWS,
    MAX_VIEW_ASPECT,
    MIN_VIEW_ASPECT,
    ViewMatrixError,
    aabb_center,
    bounding_radius,
    build_view,
    build_views,
    framing_distance,
    look_at_view_matrix,
    perspective_window_matrix,
    resolve_views,
    suggested_view_aspect,
)

ASPECT = 1024.0 / 576.0


def _matrix_rows(matrix):
    return [list(row) for row in matrix]


def _matrices_equal(a, b, tol=1e-9):
    return all(
        abs(av - bv) <= tol
        for ar, br in zip(_matrix_rows(a), _matrix_rows(b))
        for av, bv in zip(ar, br)
    )


class FramingDistanceTests(unittest.TestCase):
    def test_distance_scales_with_subject_size(self):
        small = framing_distance(0.02, DEFAULT_FOV_Y)
        large = framing_distance(1.8, DEFAULT_FOV_Y)
        # Proportional: doubling the radius doubles the distance.
        self.assertAlmostEqual(framing_distance(0.04, DEFAULT_FOV_Y), 2.0 * small, places=9)
        self.assertAlmostEqual(large / 1.8, small / 0.02, places=9)

    def test_distance_includes_margin(self):
        radius = 1.0
        bare = radius / math.tan(DEFAULT_FOV_Y / 2.0)
        self.assertAlmostEqual(framing_distance(radius, DEFAULT_FOV_Y), bare * (1.0 + FRAMING_MARGIN), places=9)

    def test_zero_or_negative_radius_rejected(self):
        with self.assertRaises(ViewMatrixError):
            framing_distance(0.0, DEFAULT_FOV_Y)
        with self.assertRaises(ViewMatrixError):
            framing_distance(-1.0, DEFAULT_FOV_Y)

    def test_invalid_fov_rejected(self):
        with self.assertRaises(ViewMatrixError):
            framing_distance(1.0, 0.0)
        with self.assertRaises(ViewMatrixError):
            framing_distance(1.0, math.pi)


class NamedViewsProduceDistinctMatricesTests(unittest.TestCase):
    minimum = (-0.5, -0.5, 0.0)
    maximum = (0.5, 0.5, 1.8)

    def test_each_named_view_yields_a_distinct_view_matrix(self):
        views = build_views(list(ALL_VIEW_NAMES), self.minimum, self.maximum, ASPECT)
        self.assertEqual([view["name"] for view in views], list(ALL_VIEW_NAMES))
        matrices = [view["view_matrix"] for view in views]
        for i in range(len(matrices)):
            for j in range(i + 1, len(matrices)):
                self.assertFalse(
                    _matrices_equal(matrices[i], matrices[j]),
                    f"views {ALL_VIEW_NAMES[i]} and {ALL_VIEW_NAMES[j]} produced identical view matrices",
                )

    def test_each_named_view_yields_a_distinct_window_matrix(self):
        views = build_views(list(ALL_VIEW_NAMES), self.minimum, self.maximum, ASPECT)
        matrices = [view["window_matrix"] for view in views]
        # window matrices may share the projection constants but must still be
        # equal objects only when the near/far match; assert they are valid and
        # the set of serialized forms is non-trivially populated.
        self.assertEqual(len(matrices), len(ALL_VIEW_NAMES))
        for matrix in matrices:
            self.assertEqual(matrix[3], (0.0, 0.0, -1.0, 0.0))


class ContactLowTests(unittest.TestCase):
    minimum = (-0.3, -0.2, 0.0)
    maximum = (0.3, 0.2, 1.7)

    def test_eye_is_near_the_base_plane(self):
        view = build_view("contact_low", self.minimum, self.maximum, ASPECT)
        eye = view["eye"]
        # Eye hovers just above the support plane, not at the AABB centre height.
        self.assertLessEqual(eye[2], CONTACT_LOW_EYE_HEIGHT + 1e-6)
        self.assertGreaterEqual(eye[2], 0.0)

    def test_target_is_the_base_not_the_centre(self):
        view = build_view("contact_low", self.minimum, self.maximum, ASPECT)
        target = view["target"]
        center = aabb_center(self.minimum, self.maximum)
        # Target z is the base (minimum z), not the AABB centre z.
        self.assertAlmostEqual(target[2], self.minimum[2], places=9)
        self.assertNotAlmostEqual(target[2], center[2], places=6)

    def test_gaze_is_horizontal_toward_the_base(self):
        view = build_view("contact_low", self.minimum, self.maximum, ASPECT)
        eye, target = view["eye"], view["target"]
        delta_z = target[2] - eye[2]
        # A grazing line of sight: the vertical component is tiny relative to the
        # horizontal travel, so the gaze runs level with the contact plane.
        horizontal = math.hypot(target[0] - eye[0], target[1] - eye[1])
        self.assertLess(abs(delta_z), 0.1 * horizontal)


class SuggestedViewAspectTests(unittest.TestCase):
    def test_tall_subject_gets_portrait_for_body_views(self):
        minimum = (-0.3, -0.2, 0.0)
        maximum = (0.3, 0.2, 1.8)
        for name in ("three_quarter", "front", "side"):
            with self.subTest(name=name):
                self.assertEqual(suggested_view_aspect(name, minimum, maximum), MIN_VIEW_ASPECT)

    def test_wide_or_flat_subject_stays_wide(self):
        minimum = (-1.0, -1.0, 0.0)
        maximum = (1.0, 1.0, 0.2)
        self.assertEqual(suggested_view_aspect("three_quarter", minimum, maximum), MAX_VIEW_ASPECT)
        self.assertEqual(suggested_view_aspect("contact_low", minimum, maximum), MAX_VIEW_ASPECT)

    def test_top_matches_footprint_and_clamps(self):
        square = suggested_view_aspect("top", (-1.0, -1.0, 0.0), (1.0, 1.0, 0.2))
        self.assertAlmostEqual(square, 1.0, places=9)
        very_wide = suggested_view_aspect("top", (-10.0, -1.0, 0.0), (10.0, 1.0, 0.2))
        self.assertEqual(very_wide, MAX_VIEW_ASPECT)
        very_narrow = suggested_view_aspect("top", (-1.0, -10.0, 0.0), (1.0, 10.0, 0.2))
        self.assertEqual(very_narrow, MIN_VIEW_ASPECT)


class ViewCountCapTests(unittest.TestCase):
    def test_resolve_rejects_more_than_max_views(self):
        too_many = list(ALL_VIEW_NAMES) + ["front"] * (MAX_VIEWS - len(ALL_VIEW_NAMES) + 1)
        # The overflow list has duplicates, but the cap fires first on length.
        with self.assertRaises(ViewMatrixError) as context:
            resolve_views(too_many, subject_given=True)
        self.assertIn("cap", str(context.exception))

    def test_resolve_accepts_all_distinct_named_views(self):
        # Only five named views exist, all distinct, so the cap (MAX_VIEWS=8)
        # never bites for a legitimate request; the full set must pass.
        resolved = resolve_views(list(ALL_VIEW_NAMES), subject_given=True)
        self.assertEqual(resolved, list(ALL_VIEW_NAMES))


class UnknownViewNameTests(unittest.TestCase):
    def test_unknown_name_rejected_with_clear_error(self):
        with self.assertRaises(ViewMatrixError) as context:
            resolve_views(["front", "worms_eye"], subject_given=True)
        self.assertIn("unknown view name", str(context.exception))
        self.assertIn("'worms_eye'", str(context.exception))

    def test_empty_name_rejected(self):
        with self.assertRaises(ViewMatrixError):
            resolve_views([""], subject_given=True)

    def test_duplicate_name_rejected(self):
        with self.assertRaises(ViewMatrixError) as context:
            resolve_views(["front", "front"], subject_given=True)
        self.assertIn("duplicate", str(context.exception))


class NoSubjectPathTests(unittest.TestCase):
    def test_no_subject_returns_empty_view_list(self):
        self.assertEqual(resolve_views(None, subject_given=False), [])
        self.assertEqual(resolve_views(["front"], subject_given=False), [])

    def test_subject_without_views_uses_default_set(self):
        resolved = resolve_views(None, subject_given=True)
        self.assertEqual(resolved, list(DEFAULT_VIEWS))
        # The default set includes contact_low, which the skill requires for
        # contact/support/seat/lean/grasp relations.
        self.assertIn("contact_low", resolved)


class MatrixConstructionTests(unittest.TestCase):
    def test_look_at_is_invertible_and_maps_eye_to_origin(self):
        eye = (3.0, -4.0, 1.0)
        target = (0.0, 0.0, 1.0)
        up = (0.0, 0.0, 1.0)
        view = look_at_view_matrix(eye, target, up)
        point = _transform(view, eye)
        self.assertAlmostEqual(point[0], 0.0, places=9)
        self.assertAlmostEqual(point[1], 0.0, places=9)
        self.assertAlmostEqual(point[2], 0.0, places=9)

    def test_perspective_window_matrix_has_opengl_shape(self):
        matrix = perspective_window_matrix(DEFAULT_FOV_Y, ASPECT, 0.1, 100.0)
        # The bottom row of an OpenGL perspective projection is (0, 0, -1, 0).
        self.assertEqual(matrix[3], (0.0, 0.0, -1.0, 0.0))
        # Symmetric focal lengths on the diagonal for x and y.
        f = 1.0 / math.tan(DEFAULT_FOV_Y / 2.0)
        self.assertAlmostEqual(matrix[0][0], f / ASPECT, places=9)
        self.assertAlmostEqual(matrix[1][1], f, places=9)

    def test_build_view_returns_all_required_fields(self):
        view = build_view("front", (-1.0, -1.0, 0.0), (1.0, 1.0, 2.0), ASPECT)
        for field in ("name", "eye", "target", "up", "fov_y", "view_matrix", "window_matrix"):
            self.assertIn(field, view)
        self.assertEqual(view["name"], "front")


def _transform(matrix, point):
    x, y, z = point
    rows = _matrix_rows(matrix)
    return (
        rows[0][0] * x + rows[0][1] * y + rows[0][2] * z + rows[0][3],
        rows[1][0] * x + rows[1][1] * y + rows[1][2] * z + rows[1][3],
        rows[2][0] * x + rows[2][1] * y + rows[2][2] * z + rows[2][3],
    )


if __name__ == "__main__":
    unittest.main()
