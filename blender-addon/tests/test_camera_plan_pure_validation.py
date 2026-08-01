"""Parity regressions for production CameraPlanV1 validation rows 11-34."""

from __future__ import annotations

import math
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import cclay.camera_plan as camera_plan
from cclay.camera_plan import validate_camera_plan

HASH = "a" * 64
FOV = 2 * math.atan(12 / 48)


def valid_plan() -> dict:
    return {
        "schema_version": 1,
        "expected_revision_id": HASH,
        "evidence_sha256": "b" * 64,
        "output_format": {"width": 640, "height": 360},
        "keyframes": [
            {
                "frame": 80,
                "pose": {
                    "position": [0, 0, 50],
                    "look_at": [0, 0, 0],
                    "up": [0, 1, 0],
                    "vertical_fov_radians": FOV,
                },
                "transition": "smooth",
            },
            {
                "frame": 100,
                "pose": {
                    "position": [10, 0, 50],
                    "look_at": [10, 0, 0],
                    "up": [0, 1, 0],
                    "vertical_fov_radians": FOV,
                },
                "transition": "cut",
            },
        ],
    }


def valid_evidence() -> dict:
    return {
        "schema_version": 1,
        "revision_id": HASH,
        "scene_hash": "c" * 64,
        "frame_range": {"start": 0, "end": 200},
        "producer": {"id": "cclay.approved_fixture", "version": "boxing-v4", "digest": "d" * 64},
        "analysis": {
            "motion_valley_frames": [100],
            "action_peak_ranges": [],
            "action_axis": {"a": [0, 0, 0], "b": [20, 0, 0], "up": [0, 0, 1]},
            "subject_samples": [
                {"frame": 99, "center": [10, 0, 0], "height_m": 1},
                {"frame": 100, "center": [10, 0, 0], "height_m": 1},
            ],
        },
    }


class CameraPlanPureValidationTests(unittest.TestCase):
    def assert_code(self, code: str, mutate_plan=None, mutate_evidence=None) -> None:
        plan = valid_plan()
        evidence = valid_evidence()
        if mutate_plan:
            mutate_plan(plan)
        if mutate_evidence:
            mutate_evidence(evidence)
        with self.assertRaises(Exception) as raised:
            validate_camera_plan(plan, evidence)
        self.assertEqual(getattr(raised.exception, "code", None), code)

    def test_valid_plan_passes(self):
        self.assertEqual(validate_camera_plan(valid_plan(), valid_evidence()), valid_plan())
    def test_plan_without_evidence_retains_internal_validation(self):
        plan = valid_plan()
        del plan["evidence_sha256"]
        self.assertEqual(validate_camera_plan(plan), plan)

    def test_no_evidence_live_scene_hash_drift_rejects_before_checkpoint(self):
        plan = valid_plan()
        del plan["evidence_sha256"]
        connection = mock.Mock()
        with (
            mock.patch.object(camera_plan, "bpy", mock.Mock()),
            mock.patch.object(camera_plan, "_extract_live_scene_manifest", return_value={"sceneHash": "d" * 64}),
            mock.patch.object(camera_plan, "create_checkpoint") as create_checkpoint,
        ):
            with self.assertRaises(Exception) as raised:
                camera_plan.apply_camera_plan_transaction(
                    plan,
                    "c" * 64,
                    connection,
                    lambda _result: None,
                )
        self.assertEqual(getattr(raised.exception, "code", None), "STALE_BASE")
        create_checkpoint.assert_not_called()
        connection.hold_checkpoint.assert_not_called()

    def test_rows_11_through_18_and_20_through_22(self):
        cases = [
            ("PLAN_FRAME_OUT_OF_EVIDENCE_RANGE", lambda p: p["keyframes"][1].update(frame=201), None),
            ("EVIDENCE_SUBJECT_SAMPLE_MISSING", None, lambda e: e["analysis"]["subject_samples"].pop()),
            ("EVIDENCE_ACTION_AXIS_ZERO_LENGTH", None, lambda e: e["analysis"]["action_axis"].update(b=[0, 0, 0])),
            ("EVIDENCE_ACTION_AXIS_PARALLEL_TO_UP", None, lambda e: e["analysis"]["action_axis"].update(b=[0, 0, 20])),
            ("PLAN_FRAME_NOT_INTEGER", lambda p: p["keyframes"][0].update(frame=80.5), None),
            ("PLAN_MINIMUM_TWO_KEYFRAMES", lambda p: p["keyframes"].pop(), None),
            ("PLAN_FRAME_ORDER_INVALID", lambda p: (p["keyframes"][0].update(frame=100), p["keyframes"][1].update(frame=80, transition="smooth")), None),
            ("UNSUPPORTED_PLAN_UP", lambda p: p["keyframes"][0]["pose"].update(up=[0, 1, 1e-8]), None),
            ("PLAN_ZERO_VIEW_DISTANCE", lambda p: p["keyframes"][0]["pose"].update(position=[0, 0, 0]), None),
            ("PLAN_POSE_COLLINEAR_UP", lambda p: p["keyframes"][0]["pose"].update(position=[0, 50, 0]), None),
        ]
        for code, mutate_plan, mutate_evidence in cases:
            with self.subTest(code=code):
                self.assert_code(code, mutate_plan, mutate_evidence)

        plan = valid_plan()
        evidence = valid_evidence()
        plan["keyframes"][0]["transition"] = "cut"
        evidence["analysis"]["motion_valley_frames"].insert(0, 80)
        evidence["analysis"]["subject_samples"][:0] = [
            {"frame": 79, "center": [0, 0, 0], "height_m": 1},
            {"frame": 80, "center": [0, 0, 0], "height_m": 1},
        ]
        with self.assertRaises(Exception) as raised:
            validate_camera_plan(plan, evidence)
        self.assertEqual(getattr(raised.exception, "code", None), "PLAN_FIRST_TRANSITION_NOT_SMOOTH")

    def test_rows_28_through_34(self):
        cases = [
            ("FRAMING_BAND_VIOLATION", lambda p: p["keyframes"][0]["pose"].update(vertical_fov_radians=2 * math.atan(12 / 40)), None),
            ("CUT_NOT_AT_MOTION_VALLEY", None, lambda e: e["analysis"].update(motion_valley_frames=[])),
            ("CUT_SPLITS_ACTION_PEAK", None, lambda e: e["analysis"].update(action_peak_ranges=[{"start": 99, "end": 99}])),
            ("CUT_SCALE_UNDEFINED", None, lambda e: [sample.update(height_m=5e-324) for sample in e["analysis"]["subject_samples"]]),
            ("CUT_SCALE_DISCONTINUITY", None, lambda e: e["analysis"]["subject_samples"][1].update(height_m=2)),
            ("ACTION_AXIS_CROSSING", lambda p: p["keyframes"][1]["pose"].update(position=[10, 0, -50]), None),
        ]
        for code, mutate_plan, mutate_evidence in cases:
            with self.subTest(code=code):
                self.assert_code(code, mutate_plan, mutate_evidence)

        plan = valid_plan()
        evidence = valid_evidence()
        plan["keyframes"][0]["pose"].update(position=[0, 0, 0], look_at=[0, 0, 50])
        evidence["analysis"]["subject_samples"][0]["center"] = [0, -50, 0]
        with self.assertRaises(Exception) as raised:
            validate_camera_plan(plan, evidence)
        self.assertEqual(getattr(raised.exception, "code", None), "CAMERA_ON_ACTION_AXIS")

    def test_live_scene_hash_is_recomputed_before_checkpoint(self):
        evidence = valid_evidence()
        plan = valid_plan()
        expected_hash = evidence["scene_hash"]
        connection = mock.Mock()
        with (
            mock.patch.object(camera_plan, "bpy", mock.Mock()),
            mock.patch.object(camera_plan, "parse_camera_plan", return_value=plan),
            mock.patch.object(camera_plan, "load_authorized_fixture", return_value=evidence),
            mock.patch.object(camera_plan, "validate_camera_plan", return_value=plan),
            mock.patch.object(
                camera_plan,
                "_extract_live_scene_manifest",
                return_value={"sceneHash": "d" * 64},
                create=True,
            ),
            mock.patch.object(camera_plan, "create_checkpoint") as create_checkpoint,
        ):
            with self.assertRaises(Exception) as raised:
                camera_plan.apply_camera_plan_transaction(
                    plan,
                    expected_hash,
                    connection,
                    lambda _result: None,
                )
        self.assertEqual(getattr(raised.exception, "code", None), "STALE_BASE")
        create_checkpoint.assert_not_called()
        connection.hold_checkpoint.assert_not_called()


if __name__ == "__main__":
    unittest.main()
