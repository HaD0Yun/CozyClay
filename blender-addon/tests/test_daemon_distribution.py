from pathlib import Path
import os
import shutil
import sys
import tempfile
from unittest import mock
import unittest
import uuid

from oh_my_blender.connection import Connection, LifecycleState, _resolve_daemon_argv
from tests.daemon_project_support import provision_daemon_project


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
NODE_SEARCH_RESULT = shutil.which("node")
if NODE_SEARCH_RESULT is None:
    raise unittest.SkipTest("node is unavailable")
NODE_EXECUTABLE = str(Path(NODE_SEARCH_RESULT).resolve(strict=True))
TSX_LOADER = next(
    (
        parent / "node_modules/tsx/dist/loader.mjs"
        for parent in (REPOSITORY_ROOT, *REPOSITORY_ROOT.parents)
        if (parent / "node_modules/tsx/dist/loader.mjs").is_file()
    ),
    None,
)
if TSX_LOADER is None:
    raise unittest.SkipTest("tsx is unavailable")
DAEMON_MAIN = REPOSITORY_ROOT / "apps/omb-daemon/src/main.ts"


class DaemonDistributionTests(unittest.TestCase):
    def test_installed_executable_boots_real_daemon_end_to_end(self):
        with tempfile.TemporaryDirectory(prefix="omb-installed-daemon-") as directory:
            project_id = provision_daemon_project(directory)
            installed_executable = Path(directory).resolve() / "omb-daemon"
            installed_executable.write_text(
                f"#!{sys.executable}\n"
                "import os\n"
                "import sys\n"
                f"executable = {NODE_EXECUTABLE!r}\n"
                "os.execv(executable, ("
                f"executable, '--import', {str(TSX_LOADER)!r}, {str(DAEMON_MAIN)!r}, *sys.argv[1:]))\n",
                encoding="utf-8",
            )
            installed_executable.chmod(0o700)
            with mock.patch.dict(
                os.environ,
                {"OMB_DAEMON_EXECUTABLE": str(installed_executable)},
                clear=True,
            ):
                argv = _resolve_daemon_argv(("--faux",))
                connection = Connection.start(
                    argv,
                    cwd=directory,
                    project_id=project_id,
                    addon_version="0.1.0",
                    blender_version="5.1.2",
                )
            try:
                self.assertEqual(argv[0], str(installed_executable))
                self.assertEqual(connection.state, LifecycleState.ACTIVE)
                self.assertEqual(uuid.UUID(connection.identity["launch_id"]).version, 4)
            finally:
                connection.disconnect("installed_executable_test")
            self.assertEqual(connection.child.process.returncode, 0)


if __name__ == "__main__":
    unittest.main()
