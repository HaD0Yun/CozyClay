"""Blender-owned loopback transport for the local extension."""

import collections
import hmac
import json
import os
import queue
import re
import secrets
import socket
import struct
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover
    bpy = None


PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 18 * 1024 * 1024
BACKLOG_LIMIT = 16
COMPLETED_RESULT_LIMIT = 64
COMPLETED_RESULT_TTL_SECONDS = 10 * 60
SERVER_CAPABILITIES = ("execute_blender_python_v1",)
_DISCOVERY_FIELDS = {
    "schema_version", "host", "port", "pid", "token", "token_generation",
    "addon_version", "protocol_version",
}
_HELLO_FIELDS = {"type", "token", "client", "protocol_version", "capabilities"}
_PROJECT_LOCK_FIELDS = {"schema_version", "pid", "owner_token"}
_EXECUTE_REQUEST_FIELDS = {
    "type", "request_id", "script", "deadline_ms", "capture_stdout",
    "expected_revision_id",
}
_OUTCOME_REQUEST_FIELDS = {"type", "request_id"}
_UUID_V4_LOWERCASE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_HASH_64 = re.compile(r"^[0-9a-f]{64}$")


class BlenderServerError(RuntimeError):
    """The Blender loopback server cannot safely continue."""


def _token() -> str:
    return secrets.token_urlsafe(32)


def encode_frame(message: dict) -> bytes:
    """Encode one bounded UTF-8 JSON transport frame."""
    try:
        payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise BlenderServerError("frame message must be JSON serializable") from error
    if len(payload) > MAX_FRAME_BYTES:
        raise BlenderServerError("frame exceeds 18 MiB limit")
    return struct.pack(">I", len(payload)) + payload


def _read_exact(stream, size: int) -> bytes:
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream) -> dict:
    """Read exactly one bounded JSON frame from a binary stream."""
    header = _read_exact(stream, 4)
    if not header:
        raise EOFError()
    if len(header) != 4:
        raise BlenderServerError("truncated frame length")
    size = struct.unpack(">I", header)[0]
    if size > MAX_FRAME_BYTES:
        raise BlenderServerError("frame exceeds 18 MiB limit")
    payload = _read_exact(stream, size)
    if len(payload) != size:
        raise BlenderServerError("truncated frame payload")
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BlenderServerError("frame is not UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise BlenderServerError("frame must contain a JSON object")
    return value


def _valid_request_id(value: object) -> bool:
    return isinstance(value, str) and _UUID_V4_LOWERCASE.fullmatch(value) is not None


def _valid_execute_request(message: dict) -> bool:
    script = message.get("script")
    deadline_ms = message.get("deadline_ms")
    return (
        set(message) == _EXECUTE_REQUEST_FIELDS
        and _valid_request_id(message.get("request_id"))
        and isinstance(script, str)
        and bool(script)
        and len(script.encode("utf-8")) <= 8192
        and isinstance(message.get("capture_stdout"), bool)
        and isinstance(deadline_ms, int)
        and not isinstance(deadline_ms, bool)
        and 1 <= deadline_ms <= 30_000
        and isinstance(message.get("expected_revision_id"), str)
        and _HASH_64.fullmatch(message["expected_revision_id"]) is not None
    )


def _valid_outcome_request(message: dict) -> bool:
    return set(message) == _OUTCOME_REQUEST_FIELDS and _valid_request_id(
        message.get("request_id")
    )


class BlenderServer:
    """One project-local listener; Blender work is drained only by its timer."""

    def __init__(
        self,
        project_directory: str | Path,
        addon_version: str,
        dispatch: Callable[[dict, Callable[[dict], None]], None],
        *,
        capabilities: tuple[str, ...] = SERVER_CAPABILITIES,
        log: Callable[[str, dict], None] | None = None,
        outcome_lookup: Callable[[str], dict | None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        token_generation: int = 0,
    ):
        self.project_directory = Path(project_directory).resolve()
        self.addon_version = addon_version
        self.dispatch = dispatch
        self.capabilities = capabilities
        if (
            not isinstance(addon_version, str)
            or not addon_version
            or len(addon_version) > 64
            or not capabilities
            or len(capabilities) > 16
            or len(set(capabilities)) != len(capabilities)
            or not all(
                isinstance(capability, str) and 0 < len(capability) <= 64
                for capability in capabilities
            )
            or isinstance(token_generation, bool)
            or not isinstance(token_generation, int)
            or token_generation < 0
        ):
            raise BlenderServerError("server hello fields are invalid")
        self._log = log or (lambda _event, _fields: None)
        self._outcome_lookup = outcome_lookup
        self._clock = clock
        self._listener: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._project_lock_owner: tuple[str, int, int] | None = None
        self._rotation_timer: threading.Timer | None = None
        self._clients: dict[socket.socket, int] = {}
        self._work: queue.Queue[tuple[dict, Callable[[dict], None]]] = queue.Queue(BACKLOG_LIMIT)
        self._active = False
        self._active_request = False
        self._token = _token()
        self._token_generation = token_generation
        self._completed: collections.OrderedDict[str, tuple[float, dict]] = collections.OrderedDict()

    @property
    def discovery_path(self) -> Path:
        return self.project_directory / ".cclay" / "bridge-endpoint.json"

    @property
    def token_generation(self) -> int:
        return self._token_generation
    @property
    def project_lock_path(self) -> Path:
        return self.discovery_path.parent / "bridge-endpoint.lock"


    def start(self) -> dict:
        """Bind an ephemeral loopback listener and publish discovery atomically."""
        with self._lock:
            if self._listener is not None:
                raise BlenderServerError("Blender bridge server is already running")
            self._inspect_existing_discovery()
            self._acquire_project_lock()
            try:
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind(("127.0.0.1", 0))
                listener.listen(BACKLOG_LIMIT)
                listener.settimeout(0.2)
                self._listener = listener
                self._stop.clear()
                self._publish_discovery()
                self._thread = threading.Thread(target=self._accept_loop, name="cclay-blender-server", daemon=True)
                self._thread.start()
            except Exception:
                if self._listener is not None:
                    self._listener.close()
                    self._listener = None
                self._release_project_lock()
                raise
        self._register_timer()
        self._log("blender_server_started", {"port": self._listener.getsockname()[1]})
        return self.discovery()

    def discovery(self) -> dict:
        listener = self._listener
        if listener is None:
            raise BlenderServerError("Blender bridge server is not running")
        return {
            "schema_version": 1, "host": "127.0.0.1", "port": listener.getsockname()[1],
            "pid": os.getpid(), "token": self._token, "token_generation": self._token_generation,
            "addon_version": self.addon_version, "protocol_version": PROTOCOL_VERSION,
        }

    def rotate_token(self) -> dict:
        with self._lock:
            if self._listener is None:
                raise BlenderServerError("Blender bridge server is not running")
            self._token = _token()
            self._token_generation += 1
            generation = self._token_generation
            self._publish_discovery()
            self._rotation_timer = threading.Timer(
                5.0, self._close_prior_generation, args=(generation,)
            )
            self._rotation_timer.daemon = True
            self._rotation_timer.start()
        self._log("blender_server_token_rotated", {"token_generation": generation})
        return self.discovery()

    def stop(self) -> None:
        """Synchronously remove discovery and stop accepting new clients."""
        self._stop.set()
        with self._lock:
            listener, self._listener = self._listener, None
            self._active = False
            self._active_request = False
            clients = tuple(self._clients)
            self._clients.clear()
            if self._rotation_timer is not None:
                self._rotation_timer.cancel()
                self._rotation_timer = None
        if listener is not None:
            listener.close()
        for client in clients:
            self._close_client(client)
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        try:
            self.discovery_path.unlink()
        except FileNotFoundError:
            pass
        self._release_project_lock()
        self._unregister_timer()
        self._log("blender_server_stopped", {})

    def pump(self) -> float | None:
        """Timer callback: execute queued requests serially on Blender's thread."""
        if self._stop.is_set():
            return None
        self._expire_completed()
        for _ in range(8):
            if self._active_request:
                break
            try:
                message, send = self._work.get_nowait()
            except queue.Empty:
                break
            request_id = message.get("request_id")
            if message.get("type") == "get_execution_outcome":
                if not _valid_outcome_request(message):
                    self._log("blender_server_invalid_execution_request", {})
                    continue
                assert isinstance(request_id, str)
                cached = self._completed.get(request_id)
                durable = self._outcome_lookup(request_id) if cached is None and self._outcome_lookup else None
                send(
                    cached[1]
                    if cached is not None
                    else durable
                    if durable is not None
                    else {"type": "execution_outcome_not_found", "request_id": request_id}
                )
                continue
            if message.get("type") == "execute_blender_python" and not _valid_execute_request(message):
                self._log("blender_server_invalid_execution_request", {})
                continue

            self._active_request = True

            def send_and_remember(response: dict, send=send, request_id=request_id) -> None:
                send(response)
                if isinstance(request_id, str) and response.get("type") == "execute_result":
                    self._completed[request_id] = (self._clock(), response)
                    self._completed.move_to_end(request_id)
                    while len(self._completed) > COMPLETED_RESULT_LIMIT:
                        self._completed.popitem(last=False)
                self._active_request = False
            def close_client(send=send) -> None:
                closer = getattr(send, "close_client", None)
                if callable(closer):
                    closer()
                self._active_request = False

            setattr(send_and_remember, "close_client", close_client)

            try:
                self.dispatch(message, send_and_remember)
            except Exception as error:
                self._active_request = False
                self._log("blender_server_dispatch_error", {"error": repr(error)})
        return 0.01
    def _expire_completed(self) -> None:
        deadline = self._clock() - COMPLETED_RESULT_TTL_SECONDS
        while self._completed:
            request_id, (completed_at, _result) = next(iter(self._completed.items()))
            if completed_at > deadline:
                break
            self._completed.pop(request_id)

    def _inspect_existing_discovery(self) -> None:
        try:
            value = json.loads(self.discovery_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise BlenderServerError(f"existing discovery is invalid: {error}") from error
        pid = value.get("pid") if isinstance(value, dict) and set(value) == _DISCOVERY_FIELDS else None
        if isinstance(pid, bool) or not isinstance(pid, int) or pid < 1:
            raise BlenderServerError("existing discovery is invalid")
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            self.discovery_path.unlink()
            self._log("blender_server_stale_discovery_replaced", {"pid": pid})
        except PermissionError:
            raise BlenderServerError("PROJECT_ALREADY_ATTACHED") from None
        else:
            raise BlenderServerError("PROJECT_ALREADY_ATTACHED")
    @staticmethod
    def _set_private_mode(descriptor: int, path: Path) -> None:
        try:
            os.fchmod(descriptor, 0o600)
        except AttributeError:  # pragma: no cover - Windows lacks fchmod.
            os.chmod(path, 0o600)

    @staticmethod
    def _lock_owner_is_alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def _read_project_lock(self) -> dict:
        try:
            value = json.loads(self.project_lock_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise BlenderServerError("PROJECT_ALREADY_ATTACHED") from error
        if (
            not isinstance(value, dict)
            or set(value) != _PROJECT_LOCK_FIELDS
            or value.get("schema_version") != 1
            or isinstance(value.get("pid"), bool)
            or not isinstance(value.get("pid"), int)
            or value["pid"] < 1
            or not isinstance(value.get("owner_token"), str)
            or len(value["owner_token"]) != 43
        ):
            raise BlenderServerError("PROJECT_ALREADY_ATTACHED")
        return value

    def _reclaim_stale_project_lock(self, owner: dict) -> None:
        claim_path = self.project_lock_path.with_name(f"{self.project_lock_path.name}.reclaim")
        try:
            descriptor = os.open(claim_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return
        try:
            self._set_private_mode(descriptor, claim_path)
        finally:
            os.close(descriptor)
        try:
            try:
                if self._read_project_lock() == owner:
                    self.project_lock_path.unlink()
            except FileNotFoundError:
                pass
        finally:
            try:
                claim_path.unlink()
            except FileNotFoundError:
                pass


    def _acquire_project_lock(self) -> None:
        directory = self.discovery_path.parent
        directory.mkdir(parents=True, exist_ok=True)
        for _attempt in range(100):
            owner_token = secrets.token_urlsafe(32)
            try:
                descriptor = os.open(
                    self.project_lock_path,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
            except FileExistsError:
                owner = self._read_project_lock()
                if self._lock_owner_is_alive(owner["pid"]):
                    raise BlenderServerError("PROJECT_ALREADY_ATTACHED")
                self._reclaim_stale_project_lock(owner)
                time.sleep(0.001)
                continue
            try:
                self._set_private_mode(descriptor, self.project_lock_path)
                stat_result = os.fstat(descriptor)
                os.write(
                    descriptor,
                    json.dumps(
                        {"schema_version": 1, "pid": os.getpid(), "owner_token": owner_token},
                        separators=(",", ":"),
                    ).encode("utf-8"),
                )
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            self._project_lock_owner = (owner_token, stat_result.st_dev, stat_result.st_ino)
            return
        raise BlenderServerError("PROJECT_ALREADY_ATTACHED")

    def _release_project_lock(self) -> None:
        owner, self._project_lock_owner = self._project_lock_owner, None
        if owner is None:
            return
        owner_token, device, inode = owner
        try:
            stat_result = self.project_lock_path.lstat()
            if (stat_result.st_dev, stat_result.st_ino) != (device, inode):
                return
            lock_owner = self._read_project_lock()
            if lock_owner["owner_token"] == owner_token:
                self.project_lock_path.unlink()
        except FileNotFoundError:
            pass

    def _close_prior_generation(self, generation: int) -> None:
        with self._lock:
            clients = tuple(
                client for client, client_generation in self._clients.items()
                if client_generation < generation
            )
        for client in clients:
            self._close_client(client)
        if clients:
            self._log("blender_server_token_grace_expired", {
                "token_generation": generation, "closed_clients": len(clients),
            })
    @staticmethod
    def _close_client(client: socket.socket) -> None:
        shutdown = getattr(client, "shutdown", None)
        if callable(shutdown):
            try:
                shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        client.close()
    def _publish_discovery(self) -> None:
        directory = self.discovery_path.parent
        directory.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".bridge-endpoint-", dir=directory)
        try:
            self._set_private_mode(descriptor, temporary)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                descriptor = -1
                json.dump(self.discovery(), handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.discovery_path)
            os.chmod(self.discovery_path, 0o600)
            try:
                directory_descriptor = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(directory_descriptor)
                finally:
                    os.close(directory_descriptor)
            except OSError:  # pragma: no cover - directory fsync is unavailable on Windows.
                pass
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _accept_loop(self) -> None:
        while not self._stop.is_set():
            listener = self._listener
            if listener is None:
                return
            try:
                client, _address = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self._serve_client, args=(client,), daemon=True).start()

    def _serve_client(self, client: socket.socket) -> None:
        send_lock = threading.Lock()
        stream = client.makefile("rwb")
        claimed_active = False

        def send(message: dict) -> None:
            try:
                with send_lock:
                    stream.write(encode_frame(message))
                    stream.flush()
            except OSError:
                pass

        setattr(send, "close_client", lambda: self._close_client(client))

        try:
            hello = read_frame(stream)
            rejection = self._hello_rejection(hello)
            if rejection is not None:
                send({"type": "hello_reject", "reason": rejection})
                return
            with self._lock:
                if self._active:
                    send({"type": "hello_reject", "reason": "PROJECT_ALREADY_ATTACHED"})
                    return
                self._active = True
                self._clients[client] = self._token_generation
                claimed_active = True
            send({
                "type": "hello_ack",
                "addon_version": self.addon_version,
                "protocol_version": PROTOCOL_VERSION,
                "capabilities": list(self.capabilities),
            })
            while not self._stop.is_set():
                message = read_frame(stream)
                if message.get("type") == "bridge_transaction_ack":
                    # A prepared domain mutation waits for this acknowledgement.
                    # It is a transport control message, not Blender work, so route
                    # it immediately: queuing it behind the active main-thread
                    # dispatch would deadlock the durable commit handshake.
                    self.dispatch(message, send)
                    continue
                try:
                    self._work.put_nowait((message, send))
                except queue.Full:
                    send({"type": "hello_reject", "reason": "QUEUE_FULL"})
                    return
        except (EOFError, BlenderServerError, OSError) as error:
            if isinstance(error, BlenderServerError):
                self._log("blender_server_malformed_frame", {"error": str(error)})
        finally:
            if claimed_active:
                with self._lock:
                    self._active = False
                    self._clients.pop(client, None)
            try:
                stream.close()
            finally:
                client.close()
            self._log("blender_server_client_disconnected", {})

    def _hello_rejection(self, hello: dict) -> str | None:
        if set(hello) != _HELLO_FIELDS or hello.get("type") != "hello" or hello.get("client") != "cclay-extension":
            return "BAD_TOKEN"
        token = hello.get("token")
        if not isinstance(token, str) or not hmac.compare_digest(token, self._token):
            return "BAD_TOKEN"
        if hello.get("protocol_version") != PROTOCOL_VERSION:
            return "VERSION_MISMATCH"
        capabilities = hello.get("capabilities")
        if (
            not isinstance(capabilities, list)
            or len(capabilities) > 16
            or len(set(capabilities)) != len(capabilities)
            or not all(isinstance(value, str) and 0 < len(value) <= 64 for value in capabilities)
            or not set(self.capabilities).issubset(capabilities)
        ):
            return "BAD_TOKEN"
        return None

    def _register_timer(self) -> None:
        if bpy is not None and not bpy.app.timers.is_registered(self.pump):
            bpy.app.timers.register(self.pump, first_interval=0.0)

    def _unregister_timer(self) -> None:
        if bpy is not None and bpy.app.timers.is_registered(self.pump):
            bpy.app.timers.unregister(self.pump)
