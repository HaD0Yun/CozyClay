"""Owned daemon-child startup, isolated environment, and redacted diagnostics."""

import base64
import json
import os
from os import PathLike
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import threading
import time
from typing import Any, Mapping, Sequence

_UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")
_FIELDS = {"type", "protocol", "port", "pid", "launch_id", "bearer_token", "expires_in_ms"}
_BASE_ENVIRONMENT_ALLOWLIST = (
    "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP",
    "SYSTEMROOT", "XDG_RUNTIME_DIR", "CCLAY_IDLE_TIMEOUT_MS",
)
_PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLES = {
    "ant-ling": "ANT_LING_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "cerebras": "CEREBRAS_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "fireworks": "FIREWORKS_API_KEY",
    "google": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "huggingface": "HF_TOKEN",
    "kimi-coding": "KIMI_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "moonshotai-cn": "MOONSHOT_API_KEY",
    "moonshotai": "MOONSHOT_API_KEY",
    "nvidia": "NVIDIA_API_KEY",
    "openai": "OPENAI_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
    "opencode": "OPENCODE_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "together": "TOGETHER_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    "xai": "XAI_API_KEY",
    "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
    "xiaomi": "XIAOMI_API_KEY",
    "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
    "zai": "ZAI_API_KEY",
}


class StartupError(RuntimeError):
    """The daemon failed its startup-record contract."""


class UnsafeExecutableError(StartupError):
    """The configured daemon executable failed local ownership/path checks."""


def verify_executable(value: str | PathLike[str]) -> str:
    """Return an absolute executable path only for an owned regular nonsymlink file."""
    path = Path(value)
    if not path.is_absolute():
        raise UnsafeExecutableError("DAEMON_EXECUTABLE_UNSAFE: executable path must be absolute")
    try:
        path_stat = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise UnsafeExecutableError("DAEMON_EXECUTABLE_UNSAFE: executable could not be safely resolved") from error
    if (
        stat.S_ISLNK(path_stat.st_mode)
        or not stat.S_ISREG(path_stat.st_mode)
        or path_stat.st_uid != os.getuid()
        or resolved != path
        or not os.access(path, os.X_OK)
    ):
        raise UnsafeExecutableError(
            "DAEMON_EXECUTABLE_UNSAFE: executable must be an owned executable regular nonsymlink file"
        )
    return str(resolved)


def _argument_value(argv: Sequence[str], flag: str) -> str | None:
    indexes = [index for index, value in enumerate(argv) if value == flag]
    if len(indexes) != 1 or indexes[0] + 1 >= len(argv):
        return None
    return argv[indexes[0] + 1]


def _credential_environment_variable(argv: Sequence[str]) -> str | None:
    if "--faux" in argv:
        return None
    provider = _argument_value(argv, "--provider")
    if provider is None:
        return None
    return _PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLES.get(provider)


def _isolated_environment(
    argv: Sequence[str], source: Mapping[str, str]
) -> tuple[dict[str, str], tuple[bytes, ...]]:
    environment = {
        name: source[name] for name in _BASE_ENVIRONMENT_ALLOWLIST if source.get(name)
    }
    credential_name = _credential_environment_variable(argv)
    if credential_name is None:
        return environment, ()
    credential = source.get(credential_name)
    if credential is None or not credential.strip():
        raise StartupError(f"MISSING_CREDENTIAL: {credential_name} must contain a nonempty API key")
    environment[credential_name] = credential
    return environment, (credential.encode("utf-8"),)


class _StderrDrain:
    def __init__(self, stream: Any, secrets: Sequence[bytes], limit: int):
        self._stream = stream
        self._secrets = tuple(sorted((secret for secret in secrets if secret), key=len, reverse=True))
        self._maximum_secret_length = max((len(secret) for secret in self._secrets), default=1)
        self._limit = limit
        self._ring = bytearray()
        self._pending = bytearray()
        self._lock = threading.Lock()
        self.bytes_drained = 0
        self.thread = threading.Thread(target=self._run, name="cclay-daemon-stderr", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def _retain(self, value: bytes) -> None:
        with self._lock:
            self._ring.extend(value)
            overflow = len(self._ring) - self._limit
            if overflow > 0:
                del self._ring[:overflow]

    def _emit_one(self, *, final: bool) -> bool:
        for secret in self._secrets:
            if self._pending.startswith(secret):
                self._retain(b"[REDACTED]")
                del self._pending[:len(secret)]
                return True
        if not final and len(self._pending) < self._maximum_secret_length:
            return False
        self._retain(bytes(self._pending[:1]))
        del self._pending[:1]
        return True

    def _run(self) -> None:
        try:
            while True:
                chunk = os.read(self._stream.fileno(), 4096)
                if not chunk:
                    break
                self.bytes_drained += len(chunk)
                self._pending.extend(chunk)
                while self._emit_one(final=False):
                    pass
            while self._pending:
                self._emit_one(final=True)
        except (OSError, ValueError):
            # Closing an already-terminated child's streams can race the final read.
            pass

    def join(self) -> None:
        self.thread.join(timeout=2.0)

    @property
    def text(self) -> str:
        with self._lock:
            return bytes(self._ring).decode("utf-8", errors="replace")


class DaemonChild:
    stderr_limit_bytes = 16 * 1024

    def __init__(self, process: subprocess.Popen[bytes], stderr_drain: _StderrDrain):
        self.process = process
        self._stderr_drain = stderr_drain

    @classmethod
    def spawn(
        cls,
        argv: Sequence[str],
        *,
        cwd: str | PathLike[str] | None = None,
        environment: Mapping[str, str] | None = None,
    ) -> "DaemonChild":
        if not argv:
            raise UnsafeExecutableError("DAEMON_EXECUTABLE_UNSAFE: executable path is required")
        executable = verify_executable(argv[0])
        child_environment, secrets = _isolated_environment(argv, environment or os.environ)
        process = subprocess.Popen(
            [executable, *argv[1:]],
            cwd=cwd,
            env=child_environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        assert process.stderr is not None
        drain = _StderrDrain(process.stderr, secrets, cls.stderr_limit_bytes)
        child = cls(process, drain)
        drain.start()
        return child

    @property
    def stderr_diagnostics(self) -> str:
        return self._stderr_drain.text

    @property
    def stderr_bytes_drained(self) -> int:
        return self._stderr_drain.bytes_drained

    def close_streams(self) -> None:
        """Close the owned stdout/stderr pipes idempotently after the drain completes."""
        if self.process.poll() is not None:
            self._stderr_drain.join()
        for stream in (self.process.stdout, self.process.stderr):
            if stream is not None and not stream.closed:
                stream.close()

    def kill(self) -> None:
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.process.wait()
        self._stderr_drain.join()
        self.close_streams()

    def _fail(self, message: str) -> "None":
        self.kill()
        diagnostics = self.stderr_diagnostics.strip()
        if diagnostics:
            message = f"{message}; daemon diagnostics: {diagnostics}"
        raise StartupError(message[:self.stderr_limit_bytes])

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
        if selector.select(min(0.05, max(0.0, deadline - time.monotonic()))):
            if os.read(self.process.stdout.fileno(), 1):
                self._fail("duplicate startup record or trailing stdout")
        try:
            record = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._fail(f"malformed startup record: {exc}")
        if not isinstance(record, dict) or set(record) != _FIELDS:
            self._fail("startup record fields are not exact")
        valid = (record["type"] == "cclay_daemon_ready"
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
