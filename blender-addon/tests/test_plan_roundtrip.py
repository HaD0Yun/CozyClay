"""Round-trip checks for the Blender-exported ARDY camera plan fixture."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from oh_my_blender.snapshot import assemble_snapshot, snapshot_revision  # noqa: E402

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
