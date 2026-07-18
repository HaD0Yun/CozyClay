"""Owned daemon and WebSocket connection lifecycle for the Blender add-on."""

import os
import subprocess
import time
from os import PathLike
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

    def __init__(self, child: DaemonChild, websocket: WebSocketClient):
        self.child = child
        self.websocket = websocket
        self.state = "active"
        self.active_checkpoint: Checkpoint | None = None

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
        self.websocket.send_json({
            "type": "bridge_result",
            "id": bridge_id,
            "request_id": request_id,
            "result": result,
        })
        while True:
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ConnectionError("camera-plan commit acknowledgement timed out")
                socket = getattr(self.websocket, "socket", None)
                if socket is not None:
                    socket.settimeout(remaining)
            message = self.websocket.recv_json()
            if not isinstance(message, dict) or message.get("id") != request_id:
                continue
            if message.get("type") == "response":
                return message
            if message.get("type") == "error":
                raise ConnectionError(
                    f"camera-plan durable commit failed: {message.get('code', 'UNKNOWN')}"
                )

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
        """Spawn, authenticate, and complete the protocol-v1 hello exchange."""
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
            return cls(child, websocket)
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
        if not self.websocket.closed:
            try:
                self.websocket.send_json({"type": "shutdown", "reason": reason})
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
    if daemon_args is not None:
        return ("node", "--import", "tsx", "apps/omb-daemon/src/main.ts", "--port", "0", *daemon_args)
    configured = os.environ.get(_DAEMON_ARGS_ENV)
    if configured is None:
        raise ConnectionError(
            "NOT_CONFIGURED: no daemon launch mode is configured; set the "
            f"{_DAEMON_ARGS_ENV} environment variable (or pass daemon_args "
            "explicitly) to a supported mode such as '--faux' for the test "
            "provider before connecting"
        )
    return ("node", "--import", "tsx", "apps/omb-daemon/src/main.ts", "--port", "0", *configured.split())


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
