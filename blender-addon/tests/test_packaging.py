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
ADDON_ROOT = REPOSITORY_ROOT / "blender-addon" / "oh_my_blender"
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


def write_incompatible_daemon(path: Path, daemon_version: str) -> None:
    source = f'''#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import socket
import struct
import uuid

listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(1)
launch_id = str(uuid.uuid4())
token = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("=")
print(json.dumps({{
    "type": "omb_daemon_ready",
    "protocol": 1,
    "port": listener.getsockname()[1],
    "pid": os.getpid(),
    "launch_id": launch_id,
    "bearer_token": token,
    "expires_in_ms": 10000,
}}), flush=True)
connection, _ = listener.accept()
def receive_exact(length):
    data = b""
    while len(data) < length:
        data += connection.recv(length - len(data))
    return data
request = b""
while b"\\r\\n\\r\\n" not in request:
    request += connection.recv(4096)
headers = {{
    line.split(":", 1)[0].strip().lower(): line.split(":", 1)[1].strip()
    for line in request.decode("ascii").split("\\r\\n")[1:]
    if ":" in line
}}
accept = base64.b64encode(hashlib.sha1(
    (headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
).digest()).decode("ascii")
connection.sendall((
    "HTTP/1.1 101 Switching Protocols\\r\\n"
    "Upgrade: websocket\\r\\n"
    "Connection: Upgrade\\r\\n"
    f"Sec-WebSocket-Accept: {{accept}}\\r\\n\\r\\n"
).encode("ascii"))
header = receive_exact(2)
length = header[1] & 0x7f
if length == 126:
    length = struct.unpack("!H", receive_exact(2))[0]
elif length == 127:
    length = struct.unpack("!Q", receive_exact(8))[0]
mask = receive_exact(4)
payload = bytearray(receive_exact(length))
for index in range(len(payload)):
    payload[index] ^= mask[index % 4]
ack = json.dumps({{
    "type": "hello_ack",
    "protocol": 2,
    "daemon_version": {daemon_version!r},
    "launch_id": launch_id,
    "session_id": str(uuid.uuid4()),
    "server_nonce": base64.urlsafe_b64encode(os.urandom(16)).decode("ascii").rstrip("="),
    "capabilities": ["mutation_bridge_v2"],
}}).encode("utf-8")
if len(ack) < 126:
    frame_header = bytes([0x81, len(ack)])
else:
    frame_header = bytes([0x81, 126]) + struct.pack("!H", len(ack))
connection.sendall(frame_header + ack)
connection.recv(1024)
'''
    path.write_text(source, encoding="utf-8")
    path.chmod(0o700)


class BlenderExtensionPackagingTests(unittest.TestCase):
    def test_archive_is_deterministic_and_exactly_allowlisted(self):
        with tempfile.TemporaryDirectory(prefix="omb-package-test-") as directory:
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
            self.assertFalse(any("generate" in Path(name).name for name in names))

    def test_archive_loads_panel_detached_and_installed_mode_avoids_repo_discovery(self):
        with tempfile.TemporaryDirectory(prefix="omb-isolated-install-") as directory:
            isolated = Path(directory).resolve()
            archive_path = isolated / "oh-my-blender.zip"
            package_path = isolated / "site" / "oh_my_blender"
            executable = isolated / "omb-daemon"
            package_path.mkdir(parents=True)
            executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            executable.chmod(0o700)
            build_archive(archive_path)
            with zipfile.ZipFile(archive_path) as archive:
                archive.extractall(package_path)

            environment = os.environ.copy()
            environment["OMB_DAEMON_EXECUTABLE"] = str(executable)
            environment.pop("OMB_NODE_EXECUTABLE", None)
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
                        import oh_my_blender
                        from oh_my_blender import connection, ui_panel
                        connection._resolve_development_daemon_argv = lambda *_: (_ for _ in ()).throw(
                            AssertionError("repository development discovery ran")
                        )
                        argv = connection._resolve_daemon_argv(("--faux",))
                        assert argv == (str(pathlib.Path(sys.argv[2]).resolve()), "--port", "0", "--faux")
                        install_root = pathlib.Path(sys.argv[1]).resolve()
                        assert pathlib.Path(oh_my_blender.__file__).resolve().is_relative_to(install_root)
                        assert pathlib.Path(ui_panel.__file__).resolve().is_relative_to(install_root)
                        assert callable(ui_panel.draw_status)
                        print(oh_my_blender.__file__)
                        print(ui_panel.__file__)
                        """
                    ),
                    str(package_path.parent),
                    str(executable),
                ],
                cwd=isolated,
                env=environment,
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
        with tempfile.TemporaryDirectory(prefix="omb-blender-install-") as directory:
            isolated = Path(directory)
            archive_path = isolated / "oh-my-blender.zip"
            resources = isolated / "resources"
            extensions = isolated / "extensions"
            build_archive(archive_path)
            environment = os.environ.copy()
            environment.update({
                "BLENDER_USER_RESOURCES": str(resources),
                "BLENDER_USER_EXTENSIONS": str(extensions),
                "OMB_DAEMON_ARGS": "--faux",
            })
            environment.pop("PYTHONPATH", None)
            environment.pop("OMB_NODE_EXECUTABLE", None)

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
                    "import bpy, importlib, pathlib; module_name='bl_ext.user_default.oh_my_blender'; m=importlib.import_module(module_name); panel=importlib.import_module(module_name+'.ui_panel'); assert m.bl_info['name'] == 'Oh My Blender'; assert module_name in bpy.context.preferences.addons; assert hasattr(bpy.types, 'OMB_OT_connect'); assert hasattr(bpy.types, 'OMB_PT_pi_status'); assert pathlib.Path(m.__file__).is_relative_to(pathlib.Path(bpy.utils.user_resource('EXTENSIONS'))); assert callable(panel.draw_status)",
                ],
                cwd=isolated,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(probe.returncode, 0)
            self.assertTrue(any(path.name == "oh_my_blender" for path in extensions.rglob("oh_my_blender")))

            for daemon_version in ("9.9.9", "not-semver"):
                with self.subTest(daemon_version=daemon_version):
                    daemon = isolated / f"incompatible-{daemon_version}"
                    write_incompatible_daemon(daemon, daemon_version)
                    mismatch_environment = environment | {"OMB_DAEMON_EXECUTABLE": str(daemon)}
                    mismatch = subprocess.run(
                        [
                            "blender",
                            "--background",
                            "--python-expr",
                            "import importlib, tempfile, uuid; m=importlib.import_module('bl_ext.user_default.oh_my_blender.connection'); caught=None;\ntry: m.connect(cwd=tempfile.mkdtemp(), project_id=str(uuid.uuid4()), addon_version='0.1.0', blender_version='5.1.2')\nexcept m.ConnectionError as error: caught=str(error)\nassert caught and 'incompatible daemon version' in caught, caught; assert m._active_connection is None",
                        ],
                        cwd=isolated,
                        env=mismatch_environment,
                        check=True,
                        capture_output=True,
                        text=True,
                        timeout=60,
                    )
                    self.assertEqual(mismatch.returncode, 0)

            subprocess.run(
                ["blender", "--command", "extension", "remove", "oh_my_blender"],
                cwd=isolated,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertFalse(any(path.name == "oh_my_blender" for path in extensions.rglob("oh_my_blender")))
            disabled_probe = subprocess.run(
                [
                    "blender",
                    "--background",
                    "--python-expr",
                    "import bpy, importlib.util; assert not hasattr(bpy.types, 'OMB_OT_connect'); assert not hasattr(bpy.types, 'OMB_PT_pi_status'); assert importlib.util.find_spec('bl_ext.user_default.oh_my_blender') is None",
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
