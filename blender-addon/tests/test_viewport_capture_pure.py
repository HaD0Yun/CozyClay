"""Pure tests for capture sizing: fixed pixel budget, adaptive aspect."""

from __future__ import annotations

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from cclay.viewport_capture import (  # noqa: E402
    CAPTURE_MAX_SIDE,
    CAPTURE_PIXEL_BUDGET,
    clamp_capture_aspect,
    fit_capture_dimensions,
)


class FitCaptureDimensionsTests(unittest.TestCase):
    def test_reference_aspects_keep_the_old_budget(self):
        self.assertEqual(fit_capture_dimensions(16.0 / 9.0), (1024, 576))
        self.assertEqual(fit_capture_dimensions(9.0 / 16.0), (576, 1024))
        self.assertEqual(fit_capture_dimensions(1.0), (768, 768))

    def test_every_fit_stays_inside_budget_and_side_caps(self):
        for aspect in (0.2, 0.5, 9.0 / 16.0, 1.0, 16.0 / 9.0, 3.0, 10.0):
            with self.subTest(aspect=aspect):
                width, height = fit_capture_dimensions(aspect)
                self.assertLessEqual(width, CAPTURE_MAX_SIDE)
                self.assertLessEqual(height, CAPTURE_MAX_SIDE)
                self.assertLessEqual(width * height, CAPTURE_PIXEL_BUDGET)
                self.assertGreaterEqual(width, 1)
                self.assertGreaterEqual(height, 1)

    def test_degenerate_aspect_falls_back_to_wide(self):
        self.assertEqual(clamp_capture_aspect(0.0), 16.0 / 9.0)
        self.assertEqual(clamp_capture_aspect(float("nan")), 16.0 / 9.0)
        self.assertEqual(fit_capture_dimensions(0.0), (1024, 576))


if __name__ == "__main__":
    unittest.main()
