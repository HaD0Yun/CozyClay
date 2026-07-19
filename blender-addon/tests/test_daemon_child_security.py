import base64
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from unittest import mock
import unittest

from oh_my_blender.daemon_child import (
    DaemonChild,
    UnsafeExecutableError,
    verify_executable,
)


PYTHON = str(Path(sys.executable).resolve(strict=True))
SENTINEL = "omb-sentinel-secret-DO-NOT-LOG"


def script(body, *arguments):
    return [PYTHON, "-c", body, *arguments]


def record_code(prefix="", suffix=""):
    token = base64.urlsafe_b64encode(b"x" * 32).decode().rstrip("=")
    record = {
        "type": "omb_daemon_ready",
        "protocol": 1,
        "port": 12345,
        "pid": "PID",
        "launch_id": "12345678-1234-4234-8234-123456789abc",
        "bearer_token": token,
        "expires_in_ms": 10000,
    }
    encoded = json.dumps(record).replace('"PID"', '__import__("os").getpid()')
    return f"import json,os,sys,time; r={encoded}; {prefix}print(json.dumps(r), flush=True); {suffix}"


class DaemonChildSecurityTests(unittest.TestCase):
    def test_spawn_uses_minimal_environment_and_only_selected_provider_credential(self):
        body = "import json,os; print(json.dumps(dict(os.environ),sort_keys=True),flush=True)"
        with mock.patch.dict(os.environ, {
            "ANTHROPIC_API_KEY": SENTINEL,
            "UNRELATED_SECRET": "must-not-cross",
            "PATH": os.environ.get("PATH", ""),
        }, clear=True):
            child = DaemonChild.spawn(script(body, "--provider", "anthropic", "--model", "claude-haiku-4-5"))
        output, _ = child.process.communicate(timeout=3)
        child.close_streams()
        received = json.loads(output)
        self.assertEqual(received["ANTHROPIC_API_KEY"], SENTINEL)
        self.assertNotIn("UNRELATED_SECRET", received)
        self.assertLessEqual(
            set(received),
            {
                "ANTHROPIC_API_KEY", "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE",
                "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "__CF_USER_TEXT_ENCODING",
            },
        )

    def test_faux_child_receives_no_parent_credentials_and_sentinel_reaches_no_sink(self):
        body = record_code(suffix="sys.stderr.write('diagnostic-only'); time.sleep(.05)")
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {
                "ANTHROPIC_API_KEY": SENTINEL,
                "OPENAI_API_KEY": SENTINEL,
                "UNRELATED_SECRET": SENTINEL,
                "PATH": os.environ.get("PATH", ""),
            }, clear=True):
                child = DaemonChild.spawn(script(body, "--faux"), cwd=directory)
            record = child.read_startup_record()
            child.process.wait(timeout=3)
            child.close_streams()
            sinks = [json.dumps(record), child.stderr_diagnostics]
            sinks.extend(path.read_text(errors="replace") for path in Path(directory).rglob("*") if path.is_file())
            self.assertTrue(all(SENTINEL not in sink for sink in sinks))

    def test_executable_must_be_absolute_owned_regular_nonsymlink(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory).resolve() / "node"
            shutil.copy2(PYTHON, target)
            target.chmod(target.stat().st_mode | stat.S_IXUSR)
            self.assertEqual(verify_executable(target), str(target.resolve()))
            link = Path(directory).resolve() / "linked-node"
            link.symlink_to(target)
            with self.assertRaises(UnsafeExecutableError):
                verify_executable(link)
            with self.assertRaises(UnsafeExecutableError):
                verify_executable("node")
            with self.assertRaises(UnsafeExecutableError):
                verify_executable(Path(directory) / "missing")

    def test_stderr_is_continuously_drained_chunk_redacted_and_bounded_during_operation(self):
        prefix = (
            "sys.stderr.buffer.write(b'x'*70000); sys.stderr.buffer.flush(); "
            "sys.stderr.buffer.write(b'omb-sentinel-secret-'); sys.stderr.buffer.flush(); time.sleep(.03); "
            "sys.stderr.buffer.write(b'DO-NOT-LOG'); sys.stderr.buffer.flush(); "
        )
        child = DaemonChild.spawn(
            script(record_code(prefix=prefix, suffix="time.sleep(5)"), "--provider", "anthropic", "--model", "claude-haiku-4-5"),
            environment={"ANTHROPIC_API_KEY": SENTINEL},
        )
        child.read_startup_record(timeout=3)
        child.kill()
        self.assertNotIn(SENTINEL, child.stderr_diagnostics)
        self.assertIn("[REDACTED]", child.stderr_diagnostics)
        self.assertLessEqual(len(child.stderr_diagnostics.encode()), child.stderr_limit_bytes)
        self.assertEqual(child.stderr_bytes_drained, 70000 + len(SENTINEL.encode()))

    def test_stderr_burst_during_shutdown_never_blocks(self):
        suffix = "sys.stderr.buffer.write(b'y'*131072); sys.stderr.buffer.flush()"
        child = DaemonChild.spawn(script(record_code(suffix=suffix), "--faux"))
        child.read_startup_record(timeout=3)
        child.process.wait(timeout=3)
        child.close_streams()
        self.assertEqual(child.stderr_bytes_drained, 131072)
        self.assertLessEqual(len(child.stderr_diagnostics.encode()), child.stderr_limit_bytes)


if __name__ == "__main__":
    unittest.main()
