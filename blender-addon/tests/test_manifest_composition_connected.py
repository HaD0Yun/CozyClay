"""Connected V2 -> assembly V4 -> staging V4 -> camera V4 -> QA regression."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
NODE = Path(shutil.which("node") or "/nonexistent").resolve()
SCRIPT = (
    REPOSITORY_ROOT
    / "blender-addon/tests/fixtures/connected_manifest_composition_fixture.py"
)


@unittest.skipUnless(BLENDER.is_file() and NODE.is_file(), "Blender or Node is unavailable")
class ManifestCompositionConnectedTests(unittest.TestCase):
    def test_v2_assembly_stage_camera_qa_revision_chain(self):
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            env={**os.environ, "OMB_NODE_EXECUTABLE": str(NODE)},
            check=False,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if completed.returncode != 0:
            self.fail(
                "connected composition fixture failed\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("OMB_CONNECTED_COMPOSITION_RESULTS=")
        ]
        if len(lines) != 1:
            self.fail(
                "missing connected composition results\n"
                f"{completed.stdout}\n{completed.stderr}"
            )
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertEqual(
            [result["baseSchema"], result["stageSchema"], result["cameraSchema"]],
            # The daemon persists durable manifests as schemaVersion 4 since the
            # assembly-hierarchy slice; flat scenes stay hash-identical to v3.
            [2, 4, 4],
        )
        self.assertEqual(len(set(result["revisionChain"])), 4)
        self.assertTrue(all(result["stagedFieldsSurvive"].values()))
        self.assertEqual(
            result["materialFields"],
            {"useNodes": True, "principledMatches": True},
        )
        self.assertEqual(
            [identity["requested_name"] for identity in result["identities"]],
            ["Composition Cube", "Composition Part B", "Composition Key"],
        )
        self.assertTrue(
            all(
                identity["entity_id"]
                and identity["actual_name"] == identity["requested_name"]
                for identity in result["identities"]
            )
        )
        self.assertTrue(result["liveHashMatchesCamera"])
        self.assertEqual(result["assemblyMembers"], 3)
        self.assertEqual(result["qaRevision"], result["revisionChain"][-1])
        self.assertEqual(result["qaFrameCount"], 1)


if __name__ == "__main__":
    unittest.main()
