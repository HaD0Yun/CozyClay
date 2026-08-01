import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
import zipfile


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ADDON_ROOT = REPOSITORY_ROOT / "blender-addon" / "cclay"
PACKAGE_MANIFEST = REPOSITORY_ROOT / "blender-addon" / "package-files.txt"
BUILD_SCRIPT = REPOSITORY_ROOT / "scripts" / "build_blender_extension.py"


def build_archive(output: Path) -> None:
    subprocess.run(
        [sys.executable, str(BUILD_SCRIPT), "--output", str(output)],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )




class BlenderExtensionPackagingTests(unittest.TestCase):
    def test_archive_is_deterministic_and_exactly_allowlisted(self):
        with tempfile.TemporaryDirectory(prefix="cclay-package-test-") as directory:
            first = Path(directory) / "first.zip"
            second = Path(directory) / "second.zip"
            build_archive(first)
            build_archive(second)

            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(
                hashlib.sha256(first.read_bytes()).digest(),
                hashlib.sha256(second.read_bytes()).digest(),
            )
            allowed = [
                line
                for raw_line in PACKAGE_MANIFEST.read_text(encoding="utf-8").splitlines()
                if (line := raw_line.strip()) and not line.startswith("#")
            ]
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(archive.namelist(), sorted(allowed))
                for info in archive.infolist():
                    self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                    self.assertEqual(info.external_attr >> 16, 0o100644)
                    self.assertFalse(info.filename.startswith("/"))
                    self.assertNotIn("..", Path(info.filename).parts)

            names = set(allowed)
            self.assertEqual(
                {path.name for path in ADDON_ROOT.glob("*.py")},
                {Path(name).name for name in names if Path(name).parent == Path(".") and name.endswith(".py")},
            )
            self.assertIn("blender_manifest.toml", names)
            self.assertIn("__init__.py", names)
            self.assertIn("ui_panel.py", names)
            self.assertFalse(any("tests" in Path(name).parts for name in names))
            self.assertFalse(any("__pycache__" in Path(name).parts for name in names))
            self.assertFalse(any(name.endswith(".pyc") for name in names))
            self.assertFalse(any(Path(name).name.startswith("generate_") for name in names))

    def test_archive_loads_panel_detached_and_avoids_repo_discovery(self):
        with tempfile.TemporaryDirectory(prefix="cclay-isolated-install-") as directory:
            isolated = Path(directory).resolve()
            archive_path = isolated / "cclay.zip"
            package_path = isolated / "site" / "cclay"
            package_path.mkdir(parents=True)
            build_archive(archive_path)
            with zipfile.ZipFile(archive_path) as archive:
                archive.extractall(package_path)

            loaded = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    "-c",
                    textwrap.dedent(
                        """
                        import pathlib
                        import sys
                        sys.path.insert(0, sys.argv[1])
                        import cclay
                        from cclay import ui_panel
                        install_root = pathlib.Path(sys.argv[1]).resolve()
                        assert pathlib.Path(cclay.__file__).resolve().is_relative_to(install_root)
                        assert pathlib.Path(ui_panel.__file__).resolve().is_relative_to(install_root)
                        assert callable(ui_panel.draw_status)
                        print(cclay.__file__)
                        print(ui_panel.__file__)
                        """
                    ),
                    str(package_path.parent),
                ],
                cwd=isolated,
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertIn(str(package_path), loaded.stdout)
            source_path = str(REPOSITORY_ROOT).encode()
            self.assertNotIn(str(REPOSITORY_ROOT), loaded.stdout)
            for installed_file in package_path.rglob("*"):
                if installed_file.is_file():
                    self.assertNotIn(source_path, installed_file.read_bytes())

    @unittest.skipUnless(shutil.which("blender"), "Blender is required for extension install coverage")
    def test_real_blender_install_register_version_refusal_and_remove(self):
        with tempfile.TemporaryDirectory(prefix="cclay-blender-install-") as directory:
            isolated = Path(directory)
            archive_path = isolated / "cclay.zip"
            resources = isolated / "resources"
            extensions = isolated / "extensions"
            build_archive(archive_path)
            environment = os.environ.copy()
            environment.update({
                "BLENDER_USER_RESOURCES": str(resources),
                "BLENDER_USER_EXTENSIONS": str(extensions),
                "CCLAY_DAEMON_ARGS": "--faux",
            })
            environment.pop("PYTHONPATH", None)
            environment.pop("CCLAY_NODE_EXECUTABLE", None)

            subprocess.run(
                ["blender", "--command", "extension", "install-file", "-r", "user_default", "-e", str(archive_path)],
                cwd=isolated,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            probe = subprocess.run(
                [
                    "blender",
                    "--background",
                    "--python-expr",
                    "import bpy, importlib, pathlib; module_name='bl_ext.user_default.cclay'; m=importlib.import_module(module_name); panel=importlib.import_module(module_name+'.ui_panel'); assert m.bl_info['name'] == 'CozyClay'; assert module_name in bpy.context.preferences.addons; assert hasattr(bpy.types, 'CCLAY_OT_connect'); assert hasattr(bpy.types, 'CCLAY_PT_pi_status'); assert pathlib.Path(m.__file__).is_relative_to(pathlib.Path(bpy.utils.user_resource('EXTENSIONS'))); assert callable(panel.draw_status)",
                ],
                cwd=isolated,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(probe.returncode, 0)
            self.assertTrue(any(path.name == "cclay" for path in extensions.rglob("cclay")))


            subprocess.run(
                ["blender", "--command", "extension", "remove", "cclay"],
                cwd=isolated,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertFalse(any(path.name == "cclay" for path in extensions.rglob("cclay")))
            disabled_probe = subprocess.run(
                [
                    "blender",
                    "--background",
                    "--python-expr",
                    "import bpy, importlib.util; assert not hasattr(bpy.types, 'CCLAY_OT_connect'); assert not hasattr(bpy.types, 'CCLAY_PT_pi_status'); assert importlib.util.find_spec('bl_ext.user_default.cclay') is None",
                ],
                cwd=isolated,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(disabled_probe.returncode, 0)


if __name__ == "__main__":
    unittest.main()
