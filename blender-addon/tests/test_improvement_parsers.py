"""Closed contract tests for improvement bridge request parsers."""

from __future__ import annotations

import unittest

from cclay.camera_action import (
    CameraActionValidationError,
    parse_replace_camera_action,
)
from cclay.fall_motion import (
    FallMotionValidationError,
    parse_create_fall_motion,
)
from cclay.performance import (
    PerformanceValidationError,
    parse_apply_performance_mode,
)
from cclay.qa_metrics import (
    QaMetricsValidationError,
    parse_inspect_visual_qa_metrics,
)

REVISION = "a" * 64
ENTITY_ID = "123e4567-e89b-42d3-a456-426614174000"


class PerformanceParserTests(unittest.TestCase):
    def test_parses_closed_performance_request(self):
        request = parse_apply_performance_mode(
            {"expected_revision_id": REVISION, "profile": "playback"}
        )
        self.assertEqual(request["profile"], "playback")

    def test_rejects_unknown_profile(self):
        with self.assertRaisesRegex(PerformanceValidationError, "profile"):
            parse_apply_performance_mode(
                {"expected_revision_id": REVISION, "profile": "maximum"}
            )


class FallMotionParserTests(unittest.TestCase):
    def test_derives_gravity_impact_frame(self):
        request = parse_create_fall_motion(
            {
                "expected_revision_id": REVISION,
                "character_entity_id": ENTITY_ID,
                "start_frame": 214,
                "drop_height_m": 6.2,
                "fps": 20,
                "direction_xy": [0, -1],
            }
        )
        self.assertEqual(request["impact_frame"], 237)
        self.assertGreaterEqual(request["end_frame"], request["impact_frame"])

    def test_rejects_zero_direction(self):
        with self.assertRaisesRegex(FallMotionValidationError, "direction_xy"):
            parse_create_fall_motion(
                {
                    "expected_revision_id": REVISION,
                    "character_entity_id": ENTITY_ID,
                    "start_frame": 214,
                    "drop_height_m": 6.2,
                    "fps": 20,
                    "direction_xy": [0, 0],
                }
            )


class CameraActionParserTests(unittest.TestCase):
    def test_parses_sorted_camera_keyframes(self):
        request = parse_replace_camera_action(
            {
                "expected_revision_id": REVISION,
                "camera_entity_id": ENTITY_ID,
                "keyframes": [
                    {
                        "frame": 1,
                        "location": [0, 0, 1],
                        "look_at": [0, 0, 0],
                        "transition": "smooth",
                    },
                    {
                        "frame": 20,
                        "location": [1, 0, 1],
                        "look_at": [0, 0, 0],
                        "transition": "cut",
                    },
                ],
            }
        )
        self.assertEqual(request["keyframes"][-1]["transition"], "cut")

    def test_rejects_unsorted_keyframes(self):
        with self.assertRaisesRegex(CameraActionValidationError, "strictly increasing"):
            parse_replace_camera_action(
                {
                    "expected_revision_id": REVISION,
                    "camera_entity_id": ENTITY_ID,
                    "keyframes": [
                        {
                            "frame": 20,
                            "location": [0, 0, 1],
                            "look_at": [0, 0, 0],
                            "transition": "smooth",
                        },
                        {
                            "frame": 1,
                            "location": [1, 0, 1],
                            "look_at": [0, 0, 0],
                            "transition": "cut",
                        },
                    ],
                }
            )


class QaMetricsParserTests(unittest.TestCase):
    def test_parses_and_sorts_unique_frames(self):
        request = parse_inspect_visual_qa_metrics(
            {
                "expected_revision_id": REVISION,
                "frames": [40, 1, 20],
                "subject_entity_ids": [ENTITY_ID],
            }
        )
        self.assertEqual(request["frames"], [1, 20, 40])

    def test_rejects_duplicate_frames(self):
        with self.assertRaisesRegex(QaMetricsValidationError, "duplicates"):
            parse_inspect_visual_qa_metrics(
                {
                    "expected_revision_id": REVISION,
                    "frames": [1, 1],
                    "subject_entity_ids": [ENTITY_ID],
                }
            )


if __name__ == "__main__":
    unittest.main()
