"""Real Blender reload recovery lifecycle harness."""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000"
FAILURE_ID = "123e4567-e89b-42d3-a456-426614174001"


def _worker(directory: str) -> None:
    import bpy

    sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
    import cclay
    from cclay import connection, project_store
    from cclay.execution_journal import ExecutionCoordinator, read_journal

    root = Path(directory)
    canonical = root / "scene.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(canonical), check_existing=False)
    cclay.register()
    bpy.ops.cclay.initialize_project()
    stored = project_store.read_project_index(str(root))
    assert isinstance(stored, dict)
    revision = stored["current_revision_id"]
    server = connection.start_blender_server(root, cclay.ADDON_VERSION)

    class Send:
        closed = False

        def __call__(self, _message: dict) -> None:
            raise AssertionError("a failed execution must not receive a response")

        def close_client(self) -> None:
            self.closed = True

    request = {
        "type": "execute_blender_python",
        "request_id": REQUEST_ID,
        "script": "bpy.context.scene['reload-mutated'] = True\nraise RuntimeError('boom')",
        "deadline_ms": 1,
        "capture_stdout": True,
        "expected_revision_id": revision,
    }
    send = Send()
    connection._execute_blender_python(request, send, root)
    record = read_journal(root, REQUEST_ID)
    recovered_server = connection._blender_server
    recovered = connection.execution_recovery_handoff(root, REQUEST_ID)
    record = read_journal(root, REQUEST_ID)
    recovered_canonical = str(Path(bpy.data.filepath).resolve())

    coordinator = ExecutionCoordinator(
        project_root=root,
        source_blend_path=lambda: canonical,
        save_backup=lambda destination: bpy.ops.wm.save_as_mainfile(filepath=str(destination), copy=True),
        execute_script=lambda _script: (_ for _ in ()).throw(RuntimeError("boom")),
        mint_revision=lambda: (_ for _ in ()).throw(AssertionError("recovery must not mint")),
    )
    failed_request = {**request, "request_id": FAILURE_ID}
    coordinator.execute(failed_request)
    canonical_bytes_before_failure = canonical.read_bytes()
    failed = read_journal(root, FAILURE_ID)
    index_path = root / ".cclay" / "project.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    index["current_revision_id"] = "c" * 64
    index_path.write_text(json.dumps(index), encoding="utf-8")
    connection.stop_blender_server()
    bpy.ops.wm.open_mainfile(filepath=failed.backup_path)
    verification_failed = read_journal(root, FAILURE_ID)
    canonical_bytes_unchanged = canonical.read_bytes() == canonical_bytes_before_failure
    failure_loaded_backup = Path(bpy.data.filepath).resolve() == Path(failed.backup_path).resolve()

    print("CCLAY_RELOAD_RECOVERY=" + json.dumps({
        "closed": send.closed,
        "recovered": recovered,
        "status": record.status,
        "base": record.base_revision_id,
        "canonical": recovered_canonical,
        "generation": recovered_server.token_generation if recovered_server else None,
        "initial_generation": server.token_generation,
        "failed_status": verification_failed.status,
        "failed_outcome": connection.execution_recovery_handoff(root, FAILURE_ID),
        "canonical_bytes_unchanged": canonical_bytes_unchanged,
        "failure_loaded_backup": failure_loaded_backup,
    }, sort_keys=True))


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class ReloadRecoveryTests(unittest.TestCase):
    def test_background_reload_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            completed = subprocess.run(
                [str(BLENDER), "--background", "--factory-startup", "--python", str(Path(__file__).resolve()), "--", "reload-recovery-worker", directory],
                cwd=REPOSITORY_ROOT,
                check=False,
                capture_output=True,
                text=True,
                timeout=900,
            )
            if completed.returncode != 0:
                raise AssertionError(f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}")
            lines = [line for line in completed.stdout.splitlines() if line.startswith("CCLAY_RELOAD_RECOVERY=")]
            self.assertEqual(len(lines), 1, completed.stdout)
            report = json.loads(lines[0].split("=", 1)[1])
            self.assertTrue(report["closed"])
            self.assertEqual(report["status"], "recovered")
            self.assertEqual(report["recovered"]["outcome"], "failed_recovered")
            self.assertEqual(report["recovered"]["restored_revision_id"], report["base"])
            self.assertTrue(report["canonical"].endswith("scene.blend"))
            self.assertEqual(report["generation"], report["initial_generation"] + 1)
            self.assertEqual(report["failed_status"], "recovery_verification_failed")
            self.assertEqual(report["failed_outcome"]["outcome"], "recovery_required")
            self.assertTrue(report["canonical_bytes_unchanged"])
            self.assertTrue(report["failure_loaded_backup"])


if __name__ == "__main__":
    marker = "reload-recovery-worker"
    if marker in sys.argv:
        _worker(sys.argv[sys.argv.index(marker) + 1])
    else:
        unittest.main()
