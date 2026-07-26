"""Clips applied before cclay.motion_start_frame existed stay usable.

Every constraint frame is expressed relative to the clip start, so a wrong
start frame does not fail -- it quietly aims the regeneration at frames the
animator never picked. That makes both halves load-bearing: the recovery must
be exact where the assumption holds, and it must refuse where it does not.
"""

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/legacy_clip_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class LegacyClipStartFrameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_LEGACY_CLIP=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing legacy clip report\n{completed.stdout}")
        cls.report = json.loads(lines[0].split("=", 1)[1])

    def test_the_start_frame_is_recovered_from_the_first_keyframe(self):
        # Keys run 5..14, so the clip starts at 5 and not at the scene's 1.
        self.assertEqual(self.report["recovered"]["start_frame"], 5)
        self.assertEqual(self.report["recovered"]["motion_id"], "legacy-clip")
        self.assertEqual(self.report["recovered"]["frame_count"], 10)

    def test_the_recovered_value_is_backfilled_onto_the_action(self):
        # Otherwise every later read re-derives it, and the recovery stops
        # being a one-time migration.
        self.assertEqual(self.report["backfilled"], 5)
        self.assertEqual(self.report["second"], 5)

    def test_a_clip_whose_span_contradicts_its_length_is_refused(self):
        self.assertIsNotNone(
            self.report["mismatch"], "a contradictory clip must not be recovered"
        )
        self.assertIn("INVALID_MOTION_START_FRAME_MISSING", self.report["mismatch"])

    def test_the_read_only_bridge_resolves_without_writing(self):
        # inspect_motion_constraints is classified read-only, which skips task
        # tracking and durable commit handling. A backfill on that path would
        # change Blender data behind the revision bookkeeping's back.
        self.assertEqual(self.report["readOnlyStartFrame"], 5)
        self.assertTrue(self.report["readOnlyLeftNoTrace"])

    def test_an_action_with_no_keyframes_is_refused(self):
        self.assertIsNotNone(self.report["unkeyed"])
        self.assertIn("INVALID_MOTION_START_FRAME_MISSING", self.report["unkeyed"])


if __name__ == "__main__":
    unittest.main()
