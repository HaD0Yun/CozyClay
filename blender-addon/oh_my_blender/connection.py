"""Owned daemon and WebSocket connection lifecycle for the Blender add-on."""

import json
import os
import queue
import subprocess
import threading
import time
from os import PathLike
from pathlib import Path
from typing import Any, Callable, Sequence

from .checkpoint import Checkpoint, restore, verify
from .daemon_child import DaemonChild
from .handshake import HandshakeError, build_hello, validate_hello_ack
from .ws_client import WebSocketClient, WebSocketError

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover - exercised by host-side imports
    bpy = None


class ConnectionError(RuntimeError):
    """The owned daemon connection violated its lifecycle contract."""


class Connection:
    """One daemon child and its single authenticated WebSocket."""

    def __init__(
        self,
        child: DaemonChild,
        websocket: WebSocketClient,
        project_directory: str | PathLike[str] | None = None,
    ):
        self.child = child
        self.websocket = websocket
        self.state = "active"
        self.active_checkpoint: Checkpoint | None = None
        self._bridge_cancellations: dict[str, threading.Event] = {}
        self._terminal_bridge_ids: set[str] = set()
        self._reader_thread: threading.Thread | None = None
        self._response_queues: dict[str, queue.Queue] = {}
        self._main_thread_messages: queue.Queue = queue.Queue()
        self.last_bridge_response: dict | None = None
        self._send_lock = threading.Lock()
        self.project_directory = (
            Path(project_directory) if project_directory is not None else None
        )

    def _durable_scene_hash(self, expected_revision_id: str) -> str:
        if self.project_directory is None:
            raise ConnectionError("durable project directory is unavailable")
        try:
            project = json.loads(
                (self.project_directory / ".omb/project.json").read_text(
                    encoding="utf-8"
                )
            )
            if project["current_revision_id"] != expected_revision_id:
                raise ConnectionError(
                    "durable project revision does not match the bridge request"
                )
            scene_hash = project["manifest"]["sceneHash"]
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as error:
            raise ConnectionError(f"durable project manifest is unavailable: {error}") from error
        if (
            not isinstance(scene_hash, str)
            or len(scene_hash) != 64
            or any(character not in "0123456789abcdef" for character in scene_hash)
        ):
            raise ConnectionError("durable project scene hash is invalid")
        return scene_hash

    def hold_checkpoint(self, checkpoint: Checkpoint) -> None:
        """Retain the sole in-flight mutation checkpoint."""
        if self.active_checkpoint is not None:
            raise ConnectionError("a mutation checkpoint is already active")
        self.active_checkpoint = checkpoint

    def release_checkpoint(self) -> Checkpoint | None:
        """Clear and return the in-flight mutation checkpoint, if any."""
        checkpoint = self.active_checkpoint
        self.active_checkpoint = None
        return checkpoint

    def is_bridge_cancelled(self, bridge_id: str) -> bool:
        cancellation = self._bridge_cancellations.get(bridge_id)
        return cancellation is not None and cancellation.is_set()

    def finish_bridge(self, bridge_id: str) -> None:
        self._bridge_cancellations.pop(bridge_id, None)
        self._terminal_bridge_ids.add(bridge_id)

    def _send_json(self, message: dict) -> None:
        with self._send_lock:
            self.websocket.send_json(message)

    def pump_bridge_messages(self) -> float | None:
        """Run a bounded batch of queued Blender work on the main thread."""
        for _index in range(8):
            try:
                message = self._main_thread_messages.get_nowait()
            except queue.Empty:
                break
            if message.get("type") == "_restore_checkpoint":
                from .camera_plan import _read_scope, _restore_scope

                self.restore_on_unexpected_loss(_restore_scope, _read_scope)
            else:
                self.dispatch_bridge_message(message)
        return 0.01 if self.state == "active" else None


    def start_bridge_dispatcher(self) -> None:
        """Continuously receive protocol-v2 bridge traffic off the Blender thread."""
        if self._reader_thread is not None and self._reader_thread.is_alive():
            raise ConnectionError("bridge dispatcher is already running")
        socket = getattr(self.websocket, "socket", None)
        if socket is not None:
            socket.settimeout(0.1)
        if bpy is not None:
            bpy.app.timers.register(self.pump_bridge_messages, first_interval=0.0)

        def receive_loop() -> None:
            while self.state == "active" and not self.websocket.closed:
                try:
                    message = self.websocket.recv_json()
                except StopIteration:
                    return
                except TimeoutError:
                    continue
                except (OSError, WebSocketError):
                    self.state = "lost"
                    if self.active_checkpoint is not None:
                        self._main_thread_messages.put({
                            "type": "_restore_checkpoint",
                        })
                    return
                if not isinstance(message, dict):
                    continue
                if message.get("type") == "bridge_request":
                    self._main_thread_messages.put(message)
                    continue
                if message.get("type") == "bridge_cancel":
                    self.dispatch_bridge_message(message)
                    continue
                if message.get("type") in ("response", "error"):
                    response_queue = self._response_queues.get(message.get("id"))
                    if response_queue is not None:
                        response_queue.put(message)

        self._reader_thread = threading.Thread(
            target=receive_loop,
            name="omb-bridge-receiver",
            daemon=True,
        )
        self._reader_thread.start()

    def _send_bridge_error(
        self,
        message: dict,
        code: str,
        detail: str,
    ) -> None:
        self._send_json({
            "type": "bridge_error",
            "id": message.get("id", ""),
            "request_id": message.get("request_id", ""),
            "code": code,
            "message": detail,
            "retryable": False,
        })

    def dispatch_bridge_message(self, message: object) -> None:
        """Route one daemon bridge message without touching Blender off-thread."""
        if not isinstance(message, dict):
            raise ConnectionError("bridge message must be an object")
        message_type = message.get("type")
        if message_type == "bridge_cancel":
            bridge_id = message.get("id")
            request_id = message.get("request_id")
            cancellation = self._bridge_cancellations.get(bridge_id)
            if cancellation is not None:
                cancellation.set()
                status = "accepted"
            elif bridge_id in self._terminal_bridge_ids:
                status = "already_terminal"
            else:
                status = "unknown"
            self._send_json({
                "type": "bridge_cancel_ack",
                "id": bridge_id,
                "request_id": request_id,
                "status": status,
            })
            return
        if message_type != "bridge_request":
            raise ConnectionError("unsupported daemon bridge message")
        if message.get("method") != "apply_camera_plan":
            self._send_bridge_error(
                message,
                "METHOD_NOT_SUPPORTED",
                f"unsupported bridge method: {message.get('method')}",
            )
            return
        required_fields = {
            "type",
            "id",
            "request_id",
            "method",
            "params",
            "expected_revision_id",
            "deadline_ms",
        }
        if set(message) not in (
            required_fields,
            required_fields | {"current_scene_hash"},
        ):
            self._send_bridge_error(
                message,
                "INVALID_BRIDGE_REQUEST",
                "apply_camera_plan bridge request has invalid fields",
            )
            return
        try:
            current_scene_hash = message.get("current_scene_hash")
            if current_scene_hash is None:
                current_scene_hash = self._durable_scene_hash(
                    message["expected_revision_id"]
                )
        except ConnectionError as error:
            self._send_bridge_error(
                message,
                "DURABLE_BASE_UNAVAILABLE",
                str(error),
            )
            return
        bridge_id = message["id"]
        if self._bridge_cancellations:
            self._send_bridge_error(message, "BUSY", "a mutation bridge is already active")
            return
        self._bridge_cancellations[bridge_id] = threading.Event()
        if bpy is None:
            self.finish_bridge(bridge_id)
            self._send_bridge_error(
                message,
                "BLENDER_UNAVAILABLE",
                "bridge dispatch requires Blender",
            )
            return
        try:
            bpy.ops.omb.apply_camera_plan(
                plan_json=json.dumps(message["params"], separators=(",", ":")),
                current_scene_hash=current_scene_hash,
                bridge_id=bridge_id,
                request_id=message["request_id"],
                deadline_ms=message["deadline_ms"],
            )
        except BaseException as error:
            self.finish_bridge(bridge_id)
            self._send_bridge_error(
                message,
                getattr(error, "code", type(error).__name__),
                str(error),
            )

    def restore_on_unexpected_loss(
        self,
        apply_fn: Callable[[str, dict], None],
        read_fn: Callable[[str], dict],
    ) -> bool:
        """Restore and verify the held checkpoint after unexpected socket loss."""
        checkpoint = self.active_checkpoint
        if checkpoint is None:
            return True
        try:
            restore(checkpoint, apply_fn)
            return verify(checkpoint, read_fn)
        finally:
            self.active_checkpoint = None

    def await_durable_bridge_commit(
        self,
        bridge_id: str,
        request_id: str,
        result: dict,
        deadline: float | None = None,
    ) -> dict:
        """Send a bridge result and wait until the daemon reports durable commit."""
        response_queue = None
        if self._reader_thread is not None and self._reader_thread.is_alive():
            response_queue = queue.Queue(maxsize=1)
            self._response_queues[request_id] = response_queue
        self._send_json({
            "type": "bridge_result",
            "id": bridge_id,
            "request_id": request_id,
            "result": result,
        })
        try:
            while True:
                remaining = None
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ConnectionError(
                            "camera-plan commit acknowledgement timed out"
                        )
                if response_queue is not None:
                    try:
                        message = response_queue.get(timeout=remaining)
                    except queue.Empty as error:
                        raise ConnectionError(
                            "camera-plan commit acknowledgement timed out"
                        ) from error
                else:
                    socket = getattr(self.websocket, "socket", None)
                    if socket is not None and remaining is not None:
                        socket.settimeout(remaining)
                    message = self.websocket.recv_json()
                    if (
                        not isinstance(message, dict)
                        or message.get("id") != request_id
                    ):
                        continue
                if message.get("type") == "response":
                    self.last_bridge_response = message
                    return message
                if message.get("type") == "error":
                    raise ConnectionError(
                        "camera-plan durable commit failed: "
                        f"{message.get('code', 'UNKNOWN')}"
                    )
        finally:
            self._response_queues.pop(request_id, None)

    @classmethod
    def start(
        cls,
        argv: Sequence[str],
        *,
        cwd: str | PathLike[str],
        project_id: str,
        addon_version: str,
        blender_version: str,
        child_type: type[DaemonChild] = DaemonChild,
        websocket_type: type[WebSocketClient] = WebSocketClient,
    ) -> "Connection":
        """Spawn, authenticate, and complete the protocol-v2 hello exchange."""
        child = child_type.spawn(argv, cwd=cwd)
        websocket = None
        try:
            record = child.read_startup_record()
            token = record["bearer_token"]
            websocket = websocket_type.connect(record["port"], token, timeout=3.0)
            token = None
            if hasattr(websocket, "socket"):
                websocket.socket.settimeout(3.0)
            websocket.send_json(build_hello(project_id, addon_version, blender_version))
            try:
                ack = validate_hello_ack(websocket.recv_json())
            except HandshakeError as exc:
                raise ConnectionError(str(exc)) from exc
            if ack["launch_id"] != record["launch_id"]:
                raise ConnectionError("hello_ack launch_id does not match daemon launch")
            connection = cls(child, websocket, project_directory=cwd)
            if bpy is not None:
                connection.start_bridge_dispatcher()
            return connection
        except Exception:
            if websocket is not None:
                try:
                    websocket.close()
                except Exception:
                    pass
            child.kill()
            raise

    def disconnect(self, reason: str, timeout: float = 8.0) -> None:
        """Drain the daemon, then force-kill only if its exit exceeds the bound."""
        if self.state == "stopped":
            return
        self.state = "draining"
        deadline = time.monotonic() + timeout
        if self._reader_thread is not None and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=min(0.2, timeout))
        if not self.websocket.closed:
            try:
                self._send_json({"type": "shutdown", "reason": reason})
                while time.monotonic() < deadline:
                    socket = getattr(self.websocket, "socket", None)
                    if socket is not None:
                        socket.settimeout(max(0.001, deadline - time.monotonic()))
                    message = self.websocket.recv_json()
                    if isinstance(message, dict) and message.get("type") == "shutdown_ack":
                        break
            except (OSError, StopIteration, WebSocketError):
                pass
            finally:
                try:
                    self.websocket.close()
                except (OSError, WebSocketError):
                    pass
        remaining = max(0.0, deadline - time.monotonic())
        try:
            self.child.process.wait(timeout=remaining)
            self.child.close_streams()
        except subprocess.TimeoutExpired:
            self.child.kill()
        self.state = "stopped"


def verify_reconnect_hash(
    live_scene_hash: str, canonical_revision_scene_hash: str
) -> None:
    """Enforce the protocol-v1 full-restart scene consistency gate."""
    if live_scene_hash != canonical_revision_scene_hash:
        raise ConnectionError(
            "live scene hash does not match the canonical current revision"
        )


def reconnect(
    argv: Sequence[str],
    *,
    cwd: str | PathLike[str],
    project_id: str,
    addon_version: str,
    blender_version: str,
    expected_scene_hash: str,
    live_scene_hash_fn: Callable[[], str],
    child_type: type[DaemonChild] = DaemonChild,
    websocket_type: type[WebSocketClient] = WebSocketClient,
) -> Connection:
    """Start a fresh connection and expose it only after scene verification."""
    connection = Connection.start(
        argv,
        cwd=cwd,
        project_id=project_id,
        addon_version=addon_version,
        blender_version=blender_version,
        child_type=child_type,
        websocket_type=websocket_type,
    )
    try:
        verify_reconnect_hash(live_scene_hash_fn(), expected_scene_hash)
    except ConnectionError:
        try:
            connection.disconnect("reconnect_hash_mismatch")
        except Exception:
            pass
        raise
    return connection


def _test_only_inject_disconnect_fault(
    checkpoint_entities: dict[str, dict],
    entity_key: str,
    property_key: str,
    mutate_value: Any,
) -> None:
    """Test-only: mutate one harmless value before a simulated socket sever."""
    try:
        checkpoint_entities[entity_key][property_key] = mutate_value
    except KeyError as exc:
        raise ConnectionError(f"fault injection target does not exist: {exc}") from exc


_active_connection: Connection | None = None


_DAEMON_ARGS_ENV = "OMB_DAEMON_ARGS"


def _resolve_daemon_argv(daemon_args: Sequence[str] | None) -> tuple[str, ...]:
    """Resolve the daemon launch mode; never silently default to a fake provider.

    apps/omb-daemon/src/main.ts accepts only an explicit `--faux` test-provider
    invocation today (no real model-provider configuration exists yet in this
    phase). The add-on itself must not hard-code that -- or any other -- mode:
    the caller (an explicit `daemon_args` argument, e.g. from the integration
    test) or the `OMB_DAEMON_ARGS` environment variable (e.g. from a future
    real deployment's launcher) must say so explicitly.
    """
    repository_root = Path(__file__).resolve().parents[2]
    daemon_main = str(repository_root / "apps/omb-daemon/src/main.ts")
    tsx_loader = next(
        (
            parent / "node_modules/tsx/dist/loader.mjs"
            for parent in (repository_root, *repository_root.parents)
            if (parent / "node_modules/tsx/dist/loader.mjs").is_file()
        ),
        None,
    )
    if tsx_loader is None:
        raise ConnectionError("NOT_CONFIGURED: tsx runtime is unavailable")
    if daemon_args is not None:
        return ("node", "--import", str(tsx_loader), daemon_main, "--port", "0", *daemon_args)
    configured = os.environ.get(_DAEMON_ARGS_ENV)
    if configured is None:
        raise ConnectionError(
            "NOT_CONFIGURED: no daemon launch mode is configured; set the "
            f"{_DAEMON_ARGS_ENV} environment variable (or pass daemon_args "
            "explicitly) to a supported mode such as '--faux' for the test "
            "provider before connecting"
        )
    return ("node", "--import", str(tsx_loader), daemon_main, "--port", "0", *configured.split())


def connect(
    *,
    cwd: str | PathLike[str],
    project_id: str,
    addon_version: str,
    blender_version: str,
    daemon_args: Sequence[str] | None = None,
) -> Connection:
    """Create and retain the add-on's sole daemon connection."""
    global _active_connection
    if _active_connection is not None and _active_connection.state != "stopped":
        raise ConnectionError("the add-on already owns an active daemon connection")
    argv = _resolve_daemon_argv(daemon_args)
    _active_connection = Connection.start(
        argv,
        cwd=cwd,
        project_id=project_id,
        addon_version=addon_version,
        blender_version=blender_version,
    )
    return _active_connection


def disconnect_active(reason: str) -> bool:
    """Disconnect and release the retained connection, if one exists."""
    global _active_connection
    if _active_connection is None or _active_connection.state == "stopped":
        _active_connection = None
        return False
    active = _active_connection
    try:
        active.disconnect(reason)
    finally:
        _active_connection = None
    return True
