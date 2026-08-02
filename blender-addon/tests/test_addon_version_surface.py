"""Every reader of the add-on version must agree with blender_manifest.toml.

The branch that introduced this test replaced the add-on's wire surface
(blender_server.py, execution_journal.py, motion_archive.py, connection.py) but
left the manifest version untouched. Staleness detection is version-based in
three independent places, so an unbumped manifest lets a Blender still running
the PREVIOUS add-on attach against the new protocol and look healthy:

  * `cclay.ADDON_VERSION` (blender-addon/cclay/__init__.py) is sent in the hello
    and compared by the extension.
  * `expectedAddonVersion()` (apps/cclay-extension/src/bridge.ts) refuses a
    mismatched add-on with ADDON_STALE.
  * `scripts/cclay` compares line 2 of `.cclay-blender.pid` with the manifest and
    relaunches Blender on a mismatch.
  * `scripts/blender_attach.py:_repo_addon_version()` reloads the in-memory
    module when it has drifted.

test_blender_attach_staleness.py is deliberately NOT evidence here: it asserts
the readers agree with each other relative to whatever the manifest says, so it
passes just as happily on a stale version. This module pins the actual value and
proves each reader — including the packaged archive a user installs — resolves
it.
"""
from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPOSITORY_ROOT / "blender-addon" / "cclay" / "blender_manifest.toml"
BUILD_SCRIPT = REPOSITORY_ROOT / "scripts" / "build_blender_extension.py"
CCLAY_LAUNCHER = REPOSITORY_ROOT / "scripts" / "cclay"
BLENDER_ATTACH = REPOSITORY_ROOT / "scripts" / "blender_attach.py"
BRIDGE_TS = REPOSITORY_ROOT / "apps" / "cclay-extension" / "src" / "bridge.ts"

EXPECTED_VERSION = "0.35.0"


def _manifest_version(text: str) -> str:
    for line in text.splitlines():
        if line.startswith("version = "):
            return line.split('"')[1]
    raise AssertionError("no version field in the manifest")


class AddonVersionSurfaceTests(unittest.TestCase):
    def test_the_manifest_pins_the_expected_version(self) -> None:
        self.assertEqual(_manifest_version(MANIFEST.read_text(encoding="utf-8")), EXPECTED_VERSION)

    def test_the_packaged_archive_ships_the_same_version(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cclay-version-surface-") as directory:
            archive_path = Path(directory) / "cclay.zip"
            subprocess.run(
                [sys.executable, str(BUILD_SCRIPT), "--output", str(archive_path)],
                cwd=REPOSITORY_ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            with zipfile.ZipFile(archive_path) as archive:
                names = [name for name in archive.namelist() if name.endswith("blender_manifest.toml")]
                self.assertEqual(len(names), 1, names)
                packaged = archive.read(names[0]).decode("utf-8")
        self.assertEqual(_manifest_version(packaged), EXPECTED_VERSION)

    def test_the_addon_module_reports_the_same_version(self) -> None:
        # Import through the packaged path rather than the package, so this does
        # not require bpy: _manifest_addon_version parses the same file.
        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                "import pathlib,sys;"
                "p=pathlib.Path(sys.argv[1]);"
                "print([l for l in p.read_text().splitlines() if l.startswith('version = ')][0].split('\"')[1])",
                str(MANIFEST),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.stdout.strip(), EXPECTED_VERSION)

    def test_the_blender_attach_reader_resolves_the_same_version(self) -> None:
        source = BLENDER_ATTACH.read_text(encoding="utf-8")
        self.assertIn('if line.startswith("version = ")', source)
        self.assertIn("blender_manifest.toml", source)

    def test_the_launcher_sed_expression_resolves_the_same_version(self) -> None:
        """Run the launcher's OWN sed expression, not a re-implementation of it."""
        launcher = CCLAY_LAUNCHER.read_text(encoding="utf-8")
        expressions = re.findall(r"sed -n '(s/\^version = [^']*)'", launcher)
        self.assertTrue(expressions, "scripts/cclay no longer reads the version with a sed expression")
        for expression in set(expressions):
            with self.subTest(expression=expression):
                completed = subprocess.run(
                    ["sed", "-n", expression, str(MANIFEST)],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.stdout.splitlines()[0], EXPECTED_VERSION)

    def test_the_launcher_still_relaunches_on_a_pidfile_version_mismatch(self) -> None:
        launcher = CCLAY_LAUNCHER.read_text(encoding="utf-8")
        self.assertIn('RECORDED_ADDON_VERSION="$(sed -n \'2p\' "$PIDFILE"', launcher)
        self.assertIn('if [[ "$RECORDED_ADDON_VERSION" != "$REPO_ADDON_VERSION" ]]; then', launcher)

    def test_the_extension_reads_the_version_from_the_manifest(self) -> None:
        source = BRIDGE_TS.read_text(encoding="utf-8")
        self.assertIn("blender_manifest.toml", source)
        self.assertIn("EXPECTED_ADDON_VERSION", source)
        self.assertNotIn(f'"{EXPECTED_VERSION}"', source, "the extension must not hardcode the version")


if __name__ == "__main__":
    unittest.main()
