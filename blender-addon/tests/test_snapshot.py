"""Headless tests for Blender-independent Scene Snapshot v2 assembly."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay.snapshot import (  # noqa: E402
    EXPORT_MAGNITUDE,
    EXPORT_NONFINITE,
    SNAPSHOT_TOO_LARGE,
    UNSUPPORTED_FCURVE_FEATURE,
    UNSUPPORTED_FPS_BASE,
    UNSUPPORTED_LINKED_DATABLOCK,
    UNSUPPORTED_PLAN_POSE,
    UNSUPPORTED_PLAN_UP,
    ExportError,
    assemble_snapshot,
    canonical_quaternion,
    snapshot_revision,
    validate_plan_pose,
)


def assemble(**overrides: object) -> dict:
    parts = {
        "scene": {"name": "Scene"},
        "render": {},
        "objects": [],
        "cameras": [],
        "markers": [],
        "animations": [],
    }
    parts.update(overrides)
    return assemble_snapshot(**parts)


class QuaternionTest(unittest.TestCase):
    def test_normalizes(self) -> None:
        self.assertEqual(canonical_quaternion([2.0, 0.0, 0.0, 0.0]), [1.0, 0.0, 0.0, 0.0])

    def test_negative_w_flips_sign(self) -> None:
        self.assertEqual(canonical_quaternion([-2.0, 0.0, 0.0, 0.0]), [1.0, 0.0, 0.0, 0.0])

    def test_zero_w_uses_first_nonzero_component(self) -> None:
        result = canonical_quaternion([0.0, 0.0, -3.0, 4.0])
        self.assertEqual(result, [0.0, 0.0, 0.6, -0.8])

    def test_sign_variants_are_identical(self) -> None:
        quaternion = [0.25, -0.5, 0.75, -1.0]
        self.assertEqual(canonical_quaternion(quaternion), canonical_quaternion([-x for x in quaternion]))

    def test_nan_is_export_error(self) -> None:
        with self.assertRaises(EXPORT_NONFINITE) as raised:
            canonical_quaternion([math.nan, 0.0, 0.0, 1.0])
        self.assertEqual(raised.exception.code, "EXPORT_NONFINITE")

    def test_zero_length_is_value_error(self) -> None:
        with self.assertRaises(ValueError):
            canonical_quaternion([0.0, 0.0, 0.0, 0.0])


class AssemblyTest(unittest.TestCase):
    def test_sorts_all_semantic_arrays(self) -> None:
        snapshot = assemble(
            objects=[{"name": "z"}, {"name": "a"}],
            cameras=[{"name": "z"}, {"name": "a"}],
            markers=[
                {"name": "z", "frame": 1, "camera": None},
                {"name": "a", "frame": 2, "camera": "z"},
                {"name": "a", "frame": 1, "camera": "z"},
                {"name": "a", "frame": 1, "camera": None},
            ],
            animations=[
                {"objectName": "z", "target": "object", "fcurves": []},
                {
                    "objectName": "a",
                    "target": "object",
                    "fcurves": [
                        {
                            "dataPath": "z",
                            "arrayIndex": 0,
                            "keyframes": [{"frame": 2.0}, {"frame": 1.0}],
                        },
                        {"dataPath": "a", "arrayIndex": 2, "keyframes": []},
                        {"dataPath": "a", "arrayIndex": 1, "keyframes": []},
                    ],
                },
                {"objectName": "a", "target": "cameraData", "fcurves": []},
            ],
        )
        self.assertEqual([item["name"] for item in snapshot["objects"]], ["a", "z"])
        self.assertEqual([item["name"] for item in snapshot["cameras"]], ["a", "z"])
        self.assertEqual(
            [(item["name"], item["frame"], item["camera"]) for item in snapshot["markers"]],
            [("a", 1, None), ("a", 1, "z"), ("a", 2, "z"), ("z", 1, None)],
        )
        self.assertEqual(
            [(item["objectName"], item["target"]) for item in snapshot["animations"]],
            [("a", "cameraData"), ("a", "object"), ("z", "object")],
        )
        fcurves = snapshot["animations"][1]["fcurves"]
        self.assertEqual([(item["dataPath"], item["arrayIndex"]) for item in fcurves], [("a", 1), ("a", 2), ("z", 0)])
        self.assertEqual([item["frame"] for item in fcurves[2]["keyframes"]], [1.0, 2.0])

    def test_sorts_optional_assemblies(self) -> None:
        snapshot = assemble(
            assemblies=[
                {"assemblyId": "00000000-0000-4000-8000-000000000002"},
                {"assemblyId": "00000000-0000-4000-8000-000000000001"},
            ]
        )
        self.assertEqual(
            [item["assemblyId"] for item in snapshot["assemblies"]],
            [
                "00000000-0000-4000-8000-000000000001",
                "00000000-0000-4000-8000-000000000002",
            ],
        )
    def test_rejects_nonfinite_leaf(self) -> None:
        with self.assertRaises(EXPORT_NONFINITE) as raised:
            assemble(render={"value": math.inf})
        self.assertEqual(raised.exception.code, "EXPORT_NONFINITE")

    def test_rejects_magnitude_leaf(self) -> None:
        with self.assertRaises(EXPORT_MAGNITUDE) as raised:
            assemble(render={"value": 1e15})
        self.assertEqual(raised.exception.code, "EXPORT_MAGNITUDE")

    def test_rejects_oversize_snapshot(self) -> None:
        with self.assertRaises(SNAPSHOT_TOO_LARGE) as raised:
            assemble(scene={"name": "x" * 1_048_576})
        self.assertEqual(raised.exception.code, "SNAPSHOT_TOO_LARGE")

    def test_schema_version_and_stable_revision(self) -> None:
        snapshot = assemble()
        self.assertEqual(snapshot["schemaVersion"], 2)
        first = snapshot_revision(snapshot)
        self.assertEqual(first, snapshot_revision(snapshot))
        self.assertRegex(first, r"^[0-9a-f]{64}$")


class ExportErrorSurfaceTest(unittest.TestCase):
    def test_exact_codes(self) -> None:
        error_types = (
            EXPORT_NONFINITE,
            EXPORT_MAGNITUDE,
            UNSUPPORTED_FPS_BASE,
            UNSUPPORTED_LINKED_DATABLOCK,
            UNSUPPORTED_FCURVE_FEATURE,
            SNAPSHOT_TOO_LARGE,
            UNSUPPORTED_PLAN_UP,
        )
        expected = {
            "EXPORT_NONFINITE",
            "EXPORT_MAGNITUDE",
            "UNSUPPORTED_FPS_BASE",
            "UNSUPPORTED_LINKED_DATABLOCK",
            "UNSUPPORTED_FCURVE_FEATURE",
            "SNAPSHOT_TOO_LARGE",
            "UNSUPPORTED_PLAN_UP",
        }
        self.assertEqual({error_type().code for error_type in error_types}, expected)
        self.assertTrue(all(issubclass(error_type, ExportError) for error_type in error_types))


class ValidatePlanPoseTest(unittest.TestCase):
    def test_valid_pose_passes(self) -> None:
        validate_plan_pose([0.0, 2.15, 5.2], [0.0, 0.9, 0.0], [0.0, 1.0, 0.0])

    def test_coincident_position_and_target_rejected(self) -> None:
        with self.assertRaises(UNSUPPORTED_PLAN_POSE):
            validate_plan_pose([1.0, 2.0, 3.0], [1.0, 2.0, 3.0], [0.0, 1.0, 0.0])

    def test_up_collinear_view_rejected(self) -> None:
        for target_y in (7.0, -7.0):
            with self.subTest(target_y=target_y), self.assertRaises(UNSUPPORTED_PLAN_POSE):
                validate_plan_pose([0.0, 2.0, 0.0], [0.0, target_y, 0.0], [0.0, 1.0, 0.0])

    def test_nonfinite_pose_rejected(self) -> None:
        with self.assertRaises(EXPORT_NONFINITE):
            validate_plan_pose([0.0, float("nan"), 0.0], [0.0, 0.9, 0.0], [0.0, 1.0, 0.0])


if __name__ == "__main__":
    unittest.main()
