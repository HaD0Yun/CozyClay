"""Owned daemon-child startup and strict ready-record parsing."""

import base64
import json
import os
import re
import selectors
import subprocess
import time
from typing import Any, Sequence

_UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")
_FIELDS = {"type", "protocol", "port", "pid", "launch_id", "bearer_token", "expires_in_ms"}


class StartupError(RuntimeError):
    """The daemon failed its startup-record contract."""


class DaemonChild:
    def __init__(self, process: subprocess.Popen[bytes]):
        self.process = process

    @classmethod
    def spawn(cls, argv: Sequence[str]) -> "DaemonChild":
        return cls(subprocess.Popen(list(argv), stdout=subprocess.PIPE, stderr=subprocess.PIPE))

    def kill(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait()
        if self.process.stdout is not None:
            self.process.stdout.close()
        if self.process.stderr is not None:
            self.process.stderr.close()

    def _fail(self, message: str) -> "None":
        self.kill()
        raise StartupError(message)

    def read_startup_record(self, timeout: float = 10.0) -> dict[str, Any]:
        assert self.process.stdout is not None
        deadline = time.monotonic() + timeout
        selector = selectors.DefaultSelector()
        selector.register(self.process.stdout, selectors.EVENT_READ)
        data = bytearray()
        while b"\n" not in data:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._fail("startup record timed out")
            if not selector.select(remaining):
                self._fail("startup record timed out")
            chunk = os.read(self.process.stdout.fileno(), 4097 - len(data))
            if not chunk:
                self._fail("daemon exited before startup record")
            data.extend(chunk)
            if len(data) > 4096:
                self._fail("startup record exceeds 4096 bytes")
        line, trailing = bytes(data).split(b"\n", 1)
        if trailing:
            self._fail("duplicate startup record or trailing stdout")
        # Catch an immediately emitted duplicate without waiting for daemon exit.
        if selector.select(min(0.05, max(0.0, deadline - time.monotonic()))):
            if os.read(self.process.stdout.fileno(), 1):
                self._fail("duplicate startup record or trailing stdout")
        try:
            record = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._fail(f"malformed startup record: {exc}")
        if not isinstance(record, dict) or set(record) != _FIELDS:
            self._fail("startup record fields are not exact")
        valid = (record["type"] == "omb_daemon_ready"
                 and type(record["protocol"]) is int and record["protocol"] == 1
                 and type(record["port"]) is int and 1 <= record["port"] <= 65535
                 and type(record["pid"]) is int and record["pid"] == self.process.pid
                 and isinstance(record["launch_id"], str) and bool(_UUID4.fullmatch(record["launch_id"]))
                 and isinstance(record["bearer_token"], str) and bool(_TOKEN.fullmatch(record["bearer_token"]))
                 and type(record["expires_in_ms"]) is int and record["expires_in_ms"] == 10000)
        if not valid:
            self._fail("startup record contains invalid values")
        try:
            if len(base64.urlsafe_b64decode(record["bearer_token"] + "=")) != 32:
                self._fail("bearer token length is invalid")
        except ValueError:
            self._fail("bearer token encoding is invalid")
        return record
