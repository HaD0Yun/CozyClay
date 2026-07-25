"""Real-Blender regression: a reused Blender reloads a stale in-memory add-on.

Drives blender-addon/tests/fixtures/stale_addon_reload_fixture.py inside
headless Blender: the fixture registers the current add-on, fakes a lower
loaded version, re-runs the attach script's reload path, and proves the
in-memory add-on is replaced by the repo version without double-registration.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/stale_addon_reload_fixture.py"


def _repo_manifest_version() -> str:
    manifest = REPOSITORY_ROOT / "blender-addon/cclay/blender_manifest.toml"
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if line.startswith("version = "):
            return line.split('"')[1]
    raise AssertionError(f"no version field in {manifest}")


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class StaleAddonReloadRealBlenderTests(unittest.TestCase):
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
        result_lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_STALE_RELOAD_RESULTS=")
        ]
        if len(result_lines) != 1:
            raise AssertionError(f"missing stale-reload results\n{completed.stdout}")
        cls.results = json.loads(result_lines[0].split("=", 1)[1])

    def test_fixture_completed_without_errors(self):
        self.assertNotIn("error", self.results, self.results.get("error"))
        self.assertTrue(self.results["initialRegistered"])

    def test_stale_module_is_detected_and_replaced_by_the_repo_version(self):
        repo_version = _repo_manifest_version()
        self.assertEqual(self.results["repoVersion"], repo_version)
        self.assertEqual(self.results["staleDetectedVersion"], "0.1.0")
        self.assertTrue(self.results["moduleReplaced"])
        self.assertEqual(self.results["reloadedVersion"], repo_version)
        self.assertTrue(self.results["reloadedMatchesRepo"])

    def test_reload_permits_re_registration_and_is_idempotent(self):
        self.assertTrue(self.results["reRegistered"])
        self.assertTrue(self.results["idempotent"])

    def test_reloaded_hello_reports_the_repo_version_capability(self):
        self.assertTrue(self.results["helloReportsRepoVersion"])

    def test_pidfile_records_pid_and_loaded_addon_version_for_the_launcher(self):
        self.assertTrue(self.results["pidfilePidMatches"])
        self.assertEqual(self.results["pidfileVersionLine"], _repo_manifest_version())


if __name__ == "__main__":
    unittest.main()
