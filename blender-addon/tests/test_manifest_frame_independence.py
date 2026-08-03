"""Canonical manifest is playhead-independent (real Blender, gated).

The scene hash must be a function of authored state, not navigation state:
Blender's animation system rewrites an animated object's RNA properties to the
evaluated value at the current frame on every frame_set, so the add-on samples
the manifest at scene.frame_start and restores the playhead. The per-object
animationDigest keeps keyframe edits visible to the revision even though the
frame_start pose does not move.
"""

import json
import pathlib
import shutil
import subprocess
import sys
import unittest

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

BLENDER = pathlib.Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/manifest_frame_independence_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class ManifestFrameIndependenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [
                str(BLENDER),
                "--background",
                "--factory-startup",
                "--python",
                str(SCRIPT),
            ],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=900,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_MANIFEST_FRAME_REPORT=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing frame report\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_playhead_position_does_not_change_the_scene_hash(self):
        self.assertTrue(self.results["hashesEqual"], self.results)

    def test_every_extraction_restores_the_playhead(self):
        for label in ("frame1", "frame25", "frame50"):
            self.assertTrue(self.results[f"{label}PlayheadRestored"], label)

    def test_animated_objects_carry_a_stable_digest_and_static_objects_omit_it(self):
        self.assertTrue(self.results["cubeDigestPresent"], self.results)
        self.assertTrue(self.results["cubeDigestStable"], self.results)
        self.assertTrue(self.results["staticDigestAbsent"], self.results)

    def test_a_keyframe_edit_changes_the_hash_without_moving_frame_start(self):
        self.assertTrue(self.results["keyframeEditChangedHash"], self.results)

    def test_moving_a_static_object_changes_the_hash(self):
        self.assertTrue(self.results["staticMoveChangedHash"], self.results)

    def test_driver_on_a_tracked_object_fails_closed(self):
        self.assertTrue(self.results["driverFailsClosed"], self.results)


if __name__ == "__main__":
    unittest.main()
