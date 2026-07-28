"""Real-Blender live conversational-surfaces integration gate."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
NODE_EXECUTABLE = Path(shutil.which("node") or "/nonexistent").resolve()
LIVE_BLEND = Path(os.environ.get("CCLAY_LIVE_BLEND", "/nonexistent")).expanduser().resolve()
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/conversational_surfaces_live_fixture.py"
RESULT_PREFIX = "CCLAY_CONVERSATIONAL_SURFACES_LIVE_RESULTS="


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
@unittest.skipUnless(NODE_EXECUTABLE.is_file(), "Node is unavailable")
@unittest.skipUnless(
    os.environ.get("CCLAY_LIVE_BLEND") and LIVE_BLEND.is_file(),
    "CCLAY_LIVE_BLEND is unavailable",
)
class ConversationalSurfacesLiveTests(unittest.TestCase):
    def test_conversational_surfaces_live_contract(self):
        with tempfile.TemporaryDirectory(prefix="cclay-conversational-surfaces-") as directory:
            project_path = Path(directory).resolve()
            project_blend = project_path / LIVE_BLEND.name
            shutil.copy2(LIVE_BLEND, project_blend)
            completed = subprocess.run(
                [
                    str(BLENDER),
                    "--background",
                    str(project_blend),
                    "--python",
                    str(SCRIPT),
                ],
                cwd=REPOSITORY_ROOT,
                env={
                    **os.environ,
                    "CCLAY_NODE_EXECUTABLE": str(NODE_EXECUTABLE),
                    "CCLAY_LIVE_PROJECT": str(project_path),
                },
                check=False,
                capture_output=True,
                text=True,
                timeout=300,
            )

        self.assertEqual(
            completed.returncode,
            0,
            f"conversational surfaces fixture failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith(RESULT_PREFIX)
        ]
        self.assertEqual(
            len(lines),
            1,
            f"expected exactly one conversational surfaces result, got {len(lines)}\n"
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        result = json.loads(lines[0][len(RESULT_PREFIX):])

        expected = {
            "projectBoundBeforeListen": True,
            "ownerResumeSeenByPeer": False,
            "supersededAccepted": 0,
            "replayGap": 0,
            "replayDuplicate": 0,
            "durableDrop": 0,
            "busyTargetCount": 1,
            "stageCode": "STAGE_SCENE_FAILED",
            "bridgeSurvived": True,
            "bridgeReconnected": True,
            "transactionMismatch": 0,
            "ordinaryCrashRecoveryRequired": 0,
            "qaDisplayed": True,
            "peerShutdownDenied": True,
            "ownerShutdownSucceeded": True,
            "unauthorizedCredentialMatches": 0,
            "uuidTransactionViolations": 0,
            "commitHashMismatches": 0,
            "resumeHeaderViolations": 0,
            "rateLimitStateMismatches": 0,
            "unknownReconcilePhasesAccepted": 0,
            "cleanupTimerCount": 0,
            "cleanupControllerCount": 0,
            "cleanupThreadCount": 0,
            "cleanupClassCount": 0,
            "cleanupSocketCount": 0,
        }
        for metric, expected_value in expected.items():
            self.assertEqual(
                result[metric],
                expected_value,
                f"{metric} expected {expected_value!r}, got {result[metric]!r}; result={result!r}",
            )

        limits = {
            "firstDeltaMs": 250,
            "reconnectMs": 60_000,
            "timerP95Ms": 4,
            "timerMaxMs": 8,
        }
        for metric, maximum in limits.items():
            self.assertLessEqual(
                result[metric],
                maximum,
                f"{metric} expected <= {maximum}, got {result[metric]!r}",
            )
        print(RESULT_PREFIX + json.dumps(result, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    unittest.main()
