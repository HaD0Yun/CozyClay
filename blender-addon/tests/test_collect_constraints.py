"""collect_constraints against a real ARDY clip, in real Blender.

Two properties, and the second one is why this file exists.

Fidelity: bake a real npz, commit constraints without touching the pose, and
every collected target must land on that npz's own posed_joints. The reference
is external, so the collector cannot pass by agreeing with itself -- an error in
the rotation inverse, the FK, the bone offsets or the root identity all surface
here as a distance.

Responsiveness: then drag a handle and collect again. The target must move. The
first version of the collector read ``matrix_basis``, which is the keyed value
BEFORE constraints, so an IK edit was invisible: fidelity passed and this check
returned exactly 0.0.
"""

import json
import pathlib
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]

BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/collect_constraints_fixture.py"

# float32 is the npz's own storage precision, so a correct round trip cannot be
# tighter than this. The measured worst case across the three constraint kinds
# was 4.1e-07. A wrong transform does not land near here: reading the pose
# before constraints put the wrist 1.4e-03 out, three orders of magnitude away.
NPZ_TOLERANCE = 1e-05
# The handle is dragged 8 armature units at scale ~107.7, so a collector that
# sees the edit reports roughly 0.074 npz units. Any real movement proves the
# solved pose is being read; the pre-fix collector reported 0.0.
MIN_EDIT_MOVEMENT = 0.01

_SEARCH_ROOTS = (
    REPOSITORY_ROOT / ".cclay" / "motions",
    Path.home() / "blenderPi" / "blender-mcp-lab" / ".cclay" / "motions",
)


def _a_real_clip():
    for root in _SEARCH_ROOTS:
        if not root.is_dir():
            continue
        for path in sorted(root.glob("*.npz")):
            return path
    return None


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class CollectConstraintsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        clip = _a_real_clip()
        if clip is None:
            raise unittest.SkipTest("no .npz motion archive in this checkout")
        completed = subprocess.run(
            [
                str(BLENDER), "--background", "--factory-startup",
                "--python", str(SCRIPT), "--", str(clip),
            ],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=900,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_COLLECT_CONSTRAINTS=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing collect results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])
        cls.clip = clip

    def test_an_unedited_pose_collects_the_clips_own_joint_positions(self):
        self.assertTrue(self.results["errors"], "no constraints were collected")
        for entry in self.results["errors"]:
            self.assertLess(
                entry["distance"],
                NPZ_TOLERANCE,
                f"{entry['joint']} at clip frame {entry['clipFrame']} in {self.clip.name}",
            )

    def test_every_marked_kind_appears_in_the_collected_request(self):
        collected = self.results["collected"]
        self.assertEqual(
            sorted(entry["joint"] for entry in collected["effectors"]),
            ["LeftFoot", "RightHand"],
        )
        self.assertEqual(len(collected["root_2d"]), 1)
        self.assertEqual(len(collected["full_body"]), 1)

    def test_frames_are_reported_in_clip_space_not_scene_space(self):
        # Marked on scene frames 4/5/7/9 over a clip starting at scene frame 1.
        collected = self.results["collected"]
        self.assertEqual(
            sorted(entry["frame"] for entry in collected["effectors"]), [3, 6]
        )
        self.assertEqual(collected["root_2d"][0]["frame"], 4)
        self.assertEqual(collected["full_body"][0]["frame"], 8)

    def test_a_root_waypoint_leaves_the_heading_free(self):
        self.assertIsNone(self.results["collected"]["root_2d"][0]["heading"])

    def test_collecting_restores_the_frame_it_scrubbed_from(self):
        self.assertEqual(self.results["restoredFrame"], 9)

    def test_dragging_a_handle_moves_the_collected_target(self):
        self.assertGreater(self.results["editMovedTargetBy"], MIN_EDIT_MOVEMENT)


if __name__ == "__main__":
    unittest.main()
