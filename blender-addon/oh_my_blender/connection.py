"""Owned daemon and WebSocket connection lifecycle for the Blender add-on."""

import subprocess
import time
from os import PathLike
from typing import Any, Sequence

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


def connect(
    *,
    cwd: str | PathLike[str],
    project_id: str,
    addon_version: str,
    blender_version: str,
) -> Connection:
    """Create and retain the add-on's sole daemon connection."""
    global _active_connection
    if _active_connection is not None and _active_connection.state != "stopped":
        raise ConnectionError("the add-on already owns an active daemon connection")
    argv = ("node", "--import", "tsx", "apps/omb-daemon/src/main.ts", "--port", "0")
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
