"""Round-trip checks for the Blender-exported ARDY camera plan fixture."""

from __future__ import annotations

import json
import math
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from oh_my_blender.snapshot import (  # noqa: E402
    assemble_snapshot,
    canonical_quaternion,
    snapshot_revision,
)

PLAN_PATH = REPOSITORY_ROOT / "packages/blender-director/test/fixtures/ardy-camera-plan-v4.json"
SNAPSHOT_PATH = REPOSITORY_ROOT / "packages/blender-director/test/fixtures/blender-exported-snapshot.json"
if not SNAPSHOT_PATH.exists():
    raise unittest.SkipTest("generated Blender snapshot fixture is absent")

PLAN = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
SNAPSHOT = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
CAMERA = "ARDY_CinematicCamera"
CUT_FRAMES = {80, 161, 199, 243}


def animation(target: str) -> dict:
    return next(
        item
        for item in SNAPSHOT["animations"]
        if item["objectName"] == CAMERA and item["target"] == target
    )


def fcurve(target: str, data_path: str, array_index: int = 0) -> dict:
    return next(
        curve
        for curve in animation(target)["fcurves"]
        if curve["dataPath"] == data_path and curve["arrayIndex"] == array_index
    )

def _normalize(vector: list[float]) -> list[float]:
    length = math.sqrt(sum(value * value for value in vector))
    return [value / length for value in vector]


def _cross(left: list[float], right: list[float]) -> list[float]:
    return [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]


def _camera_quaternion(pose: dict) -> list[float]:
    z_axis = _normalize(
        [position - target for position, target in zip(pose["position"], pose["look_at"])]
    )
    x_axis = _normalize(_cross([0.0, 1.0, 0.0], z_axis))
    y_axis = _cross(z_axis, x_axis)
    matrix = [
        [x_axis[0], y_axis[0], z_axis[0]],
        [x_axis[1], y_axis[1], z_axis[1]],
        [x_axis[2], y_axis[2], z_axis[2]],
    ]
    trace = matrix[0][0] + matrix[1][1] + matrix[2][2]
    if trace > 0:
        scale = math.sqrt(trace + 1.0) * 2
        quaternion = [
            scale / 4,
            (matrix[2][1] - matrix[1][2]) / scale,
            (matrix[0][2] - matrix[2][0]) / scale,
            (matrix[1][0] - matrix[0][1]) / scale,
        ]
    elif matrix[0][0] > matrix[1][1] and matrix[0][0] > matrix[2][2]:
        scale = math.sqrt(1.0 + matrix[0][0] - matrix[1][1] - matrix[2][2]) * 2
        quaternion = [
            (matrix[2][1] - matrix[1][2]) / scale,
            scale / 4,
            (matrix[0][1] + matrix[1][0]) / scale,
            (matrix[0][2] + matrix[2][0]) / scale,
        ]
    elif matrix[1][1] > matrix[2][2]:
        scale = math.sqrt(1.0 + matrix[1][1] - matrix[0][0] - matrix[2][2]) * 2
        quaternion = [
            (matrix[0][2] - matrix[2][0]) / scale,
            (matrix[0][1] + matrix[1][0]) / scale,
            scale / 4,
            (matrix[1][2] + matrix[2][1]) / scale,
        ]
    else:
        scale = math.sqrt(1.0 + matrix[2][2] - matrix[0][0] - matrix[1][1]) * 2
        quaternion = [
            (matrix[1][0] - matrix[0][1]) / scale,
            (matrix[0][2] + matrix[2][0]) / scale,
            (matrix[1][2] + matrix[2][1]) / scale,
            scale / 4,
        ]
    return canonical_quaternion(quaternion)



class PlanRoundTripTest(unittest.TestCase):
    def test_snapshot_canonical_revision_is_stable(self) -> None:
        rebuilt = assemble_snapshot(
            scene=SNAPSHOT["scene"],
            render=SNAPSHOT["render"],
            objects=SNAPSHOT["objects"],
            cameras=SNAPSHOT["cameras"],
            markers=SNAPSHOT["markers"],
            animations=SNAPSHOT["animations"],
        )
        self.assertEqual(rebuilt, SNAPSHOT)
        self.assertEqual(snapshot_revision(rebuilt), snapshot_revision(SNAPSHOT))

    def test_cut_markers_are_exact_and_camera_bound(self) -> None:
        self.assertEqual(
            SNAPSHOT["markers"],
            sorted(
                (
                    {"name": f"CUT_{frame}", "frame": frame, "camera": CAMERA}
                    for frame in CUT_FRAMES
                ),
                key=lambda marker: marker["name"],
            ),
        )

    def test_animation_targets_are_exclusive(self) -> None:
        self.assertEqual(
            {curve["dataPath"] for curve in animation("object")["fcurves"]},
            {"location", "rotation_quaternion"},
        )
        self.assertEqual(
            {curve["dataPath"] for curve in animation("cameraData")["fcurves"]},
            {"angle"},
        )

    def test_camera_quaternion_round_trip(self) -> None:
        expected = [_camera_quaternion(item["pose"]) for item in PLAN["keyframes"]]
        for axis in range(4):
            points = fcurve("object", "rotation_quaternion", axis)["keyframes"]
            for point, quaternion in zip(points, expected, strict=True):
                self.assertAlmostEqual(point["value"], quaternion[axis], delta=1e-6)

    def test_angle_handles_stay_in_angle_space(self) -> None:
        for point in fcurve("cameraData", "angle")["keyframes"]:
            for handle_name in ("handleLeft", "handleRight"):
                self.assertGreaterEqual(point[handle_name][1], 0.4)
                self.assertLessEqual(point[handle_name][1], 0.6)
    def test_plan_values_and_cut_interpolation_round_trip(self) -> None:
        keyframes = PLAN["keyframes"]
        expected_constant_frames = {frame - 1 for frame in CUT_FRAMES}
        for axis in range(3):
            points = fcurve("object", "location", axis)["keyframes"]
            self.assertEqual([point["frame"] for point in points], [item["frame"] for item in keyframes])
            for point, item in zip(points, keyframes, strict=True):
                self.assertAlmostEqual(point["value"], item["pose"]["position"][axis], delta=1e-6)
                expected = "CONSTANT" if point["frame"] in expected_constant_frames else "BEZIER"
                self.assertEqual(point["interpolation"], expected)

        angle_points = fcurve("cameraData", "angle")["keyframes"]
        self.assertEqual([point["frame"] for point in angle_points], [item["frame"] for item in keyframes])
        for point, item in zip(angle_points, keyframes, strict=True):
            self.assertAlmostEqual(point["value"], item["pose"]["vertical_fov_radians"], delta=1e-6)
            expected = "CONSTANT" if point["frame"] in expected_constant_frames else "BEZIER"
            self.assertEqual(point["interpolation"], expected)


if __name__ == "__main__":
    unittest.main()
