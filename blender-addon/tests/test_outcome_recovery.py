"""A bad or failed answer must not strand the animator or half-rebuild the rig.

By the time an outcome exists the add-on has already detached the IK layer, so
the state the operator leaves behind is the animator's whole world. Two ways
that went wrong:

The failure path used to return early. The panel keys off the pending record,
so it offered only the apply button, and that button kept hitting the same
permanent failure -- no handles, no way to edit, no way to ask again.

The success path used to trust any dict with the right `status`. A malformed
success was believed far enough to reattach IK, re-key markers and clear the
pending record BEFORE the missing field was noticed, tearing the rig down and
then raising.

So the two properties are opposite and both load-bearing: a REFUSED outcome
must change nothing, and a FAILED outcome must change everything back.
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/outcome_recovery_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class OutcomeRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._directory = tempfile.TemporaryDirectory()
        completed = subprocess.run(
            [
                str(BLENDER), "--background", "--factory-startup",
                "--python", str(SCRIPT), "--", cls._directory.name,
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
            if line.startswith("CCLAY_OUTCOME_RECOVERY=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing recovery report\n{completed.stdout}")
        cls.report = json.loads(lines[0].split("=", 1)[1])

    @classmethod
    def tearDownClass(cls) -> None:
        directory = getattr(cls, "_directory", None)
        if directory is not None:
            directory.cleanup()

    def test_a_malformed_success_is_refused_before_anything_is_touched(self):
        case = self.report["malformed"]
        self.assertEqual(case["status"], ["CANCELLED"])
        self.assertIn("success keys", case["message"])
        # Nothing was rebuilt and nothing was thrown away, so the animator can
        # try again once the host is fixed.
        self.assertFalse(case["ikLayer"])
        self.assertTrue(case["pending"])

    def test_an_outcome_answering_a_different_request_is_refused(self):
        # Applying it would put a clip on this armature that nobody asked for
        # here, and the pending record would be gone.
        case = self.report["misaddressed"]
        self.assertEqual(case["status"], ["CANCELLED"])
        self.assertIn("different request", case["message"])
        self.assertFalse(case["ikLayer"])
        self.assertTrue(case["pending"])

    def test_a_failed_regeneration_hands_the_rig_back(self):
        case = self.report["failed"]
        self.assertEqual(case["status"], ["FINISHED"])
        self.assertTrue(case["ikLayer"], "the animator must get their handles back")
        self.assertFalse(case["pending"], "a consumed request must not stay pending")
        self.assertEqual(case["marks"], {"RightHand": [4], "Root2D": [5]})

    def test_a_refusal_says_which_check_rejected_the_outcome(self):
        # The two refusals arrive as RuntimeError from bpy.ops and carry the
        # operator's message; a bare "cancelled" would leave the animator with
        # no idea whether to wait, re-mark, or fix the host.
        self.assertIn("outcome", self.report["malformed"]["message"])
        self.assertIn("outcome", self.report["misaddressed"]["message"])


if __name__ == "__main__":
    unittest.main()
