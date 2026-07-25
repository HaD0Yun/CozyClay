"""A failed transaction that mutated a pre-existing material's Principled finish
must restore both Roughness and Metallic sockets so the scene hash returns to its
pre-transaction value.

The defect introduced by commit 45f7788c: set_material_color now mutates
Roughness/Metallic, but the transaction snapshot/restore only carried diffuse
color, use_nodes and base color. A transaction that changed a finish and then
failed on a later op left the sockets mutated, so the rolled-back scene no longer
matched the base manifest and rollback verification escalated to recovery.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/material_rollback_fixture.py"

# Blender stores the sockets as IEEE-754 binary32, so a request of 0.28 reads back
# as its float32 neighbour. Compare with a tolerance, never with ==.
ABS_TOLERANCE = 1e-5


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class MaterialRollbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_MATERIAL_ROLLBACK=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing material rollback results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_the_failing_transaction_did_fail(self):
        # The fixture's second transaction is designed to raise; if it did not,
        # the rollback assertions below are meaningless.
        self.assertEqual(self.results["failure"], "STAGE_SCENE_TARGET_NOT_FOUND")

    def test_roughness_socket_is_restored_to_pre_transaction_value(self):
        self.assertAlmostEqual(
            self.results["post_roughness"],
            self.results["pre_roughness"],
            delta=ABS_TOLERANCE,
        )

    def test_metallic_socket_is_restored_to_pre_transaction_value(self):
        self.assertAlmostEqual(
            self.results["post_metallic"],
            self.results["pre_metallic"],
            delta=ABS_TOLERANCE,
        )

    def test_scene_hash_returns_to_pre_transaction_value(self):
        self.assertEqual(self.results["post_hash"], self.results["committed_hash"])

    def test_disabling_material_nodes_is_not_possible_on_this_blender(self):
        # A review raised a rollback hole for a material with `use_nodes` off: the
        # snapshot used to require use_nodes before reading the Principled sockets,
        # while the exporter reads them whenever a node tree exists. The snapshot
        # now matches the exporter, and this pins WHY that hole was unreachable
        # anyway -- on Blender 5.2 Material.use_nodes is writable but always reads
        # back True, since every material is node-based. If a future Blender starts
        # honouring the write, this fails and the divergence needs re-examining.
        self.assertFalse(self.results["disabled_nodes_disable_took_effect"])

    def test_rollback_restores_the_finish_after_a_disable_attempt(self):
        self.assertEqual(
            self.results["disabled_nodes_failure"], "STAGE_SCENE_TARGET_NOT_FOUND"
        )
        self.assertAlmostEqual(
            self.results["disabled_nodes_post_roughness"],
            self.results["disabled_nodes_pre_roughness"],
            delta=ABS_TOLERANCE,
        )
        self.assertEqual(
            self.results["disabled_nodes_post_hash"],
            self.results["disabled_nodes_committed_hash"],
        )


if __name__ == "__main__":
    unittest.main()
