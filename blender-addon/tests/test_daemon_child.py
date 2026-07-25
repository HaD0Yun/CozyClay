import base64
import json
from pathlib import Path
import sys
import unittest
import uuid

from cclay.daemon_child import DaemonChild, StartupError


def script(body):
    return [str(Path(sys.executable).resolve(strict=True)), "-c", body]


class DaemonChildTests(unittest.TestCase):
    def record_code(self, prefix="", suffix=""):
        token = base64.urlsafe_b64encode(b"x" * 32).decode().rstrip("=")
        record = {"type": "cclay_daemon_ready", "protocol": 1, "port": 12345, "pid": "PID", "launch_id": str(uuid.uuid4()), "bearer_token": token, "expires_in_ms": 10000}
        encoded = json.dumps(record).replace('"PID"', '__import__("os").getpid()')
        return f"import json,os; r={encoded}; {prefix}print(json.dumps(r), flush=True); {suffix}"

    def test_startup_record_exact_clause_4(self):
        child = DaemonChild.spawn(script(self.record_code()))
        try:
            record = child.read_startup_record()
            self.assertEqual(record["pid"], child.process.pid)
        finally:
            child.kill()

    def test_startup_record_rejection_matrix_clause_4(self):
        cases = {
            "garbage-before": self.record_code("print('garbage', flush=True); "),
            "oversize": "import sys,time; print('x'*4097, flush=True); time.sleep(1)",
            "duplicate": self.record_code(suffix="print(json.dumps(r), flush=True)"),
            "early-exit": "pass",
        }
        for name, code in cases.items():
            with self.subTest(name=name):
                child = DaemonChild.spawn(script(code))
                with self.assertRaises(StartupError):
                    child.read_startup_record(timeout=0.5)
                self.assertIsNotNone(child.process.poll())

    def test_startup_record_timeout_kills_clause_4(self):
        child = DaemonChild.spawn(script("import time; time.sleep(5)"))
        with self.assertRaises(StartupError):
            child.read_startup_record(timeout=0.05)
        self.assertIsNotNone(child.process.poll())


if __name__ == "__main__":
    unittest.main()
