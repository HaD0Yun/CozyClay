"""Owner/peer controller transport and reconnect lifecycle for Blender surfaces.

The module is independent of ``bpy``. It exposes a bounded drain surface for the
panel lane while retaining all credentials only in process memory.
"""

import base64
from collections import deque
from collections.abc import Callable
from enum import Enum
import hashlib
import json
import os
from pathlib import Path
import socket
import threading
import time
import uuid

from .connection import DiscoverySlot, _read_runtime_endpoint, consume_discovery_slot
from .ws_client import ProtocolError, WebSocketClient, WebSocketError


_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_TOKEN_CHARACTERS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
)
_CONTROLLER_PEERS_CAPABILITY = "controller_peers_v1"
_RECONNECT_DELAYS = (0.25, 0.5, 1.0, 2.0, 4.0)
_RECONNECT_CEILING = 5.0
_RECONNECT_WINDOW = 60.0
_MANUAL_POLL_DELAY = 10.0
_KNOWN_SERVER_TYPES = frozenset({
    "progress",
    "response",
    "error",
    "cancel_ack",
    "shutdown_ack",
    "pong",
    "director_turn_delta",
    "director_assistant_utterance",
    "director_turn_started",
    "director_tool_call_started",
    "director_tool_call_finished",
    "director_turn_completed",
    "director_turn_failed",
    "director_turn_cancelled",
    "director_transcript",
    "bridge_discovery_slot_ack",
    "controller_peer_discovery_slot_ack",
    "revoke_controller_peer_ack",
    "attach_ticket",
    "bridge_status",
})


class ControllerConnectionError(RuntimeError):
    """A controller credential, handshake, or lifecycle transition is invalid."""


class ControllerState(str, Enum):
    ACTIVE = "active"
    LOST = "lost"
    RECONNECTING = "reconnecting"
    MANUAL_RECOVERY = "manual_recovery"
    STOPPED = "stopped"


def _valid_token(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 43
        and all(character in _TOKEN_CHARACTERS for character in value)
    )


def _valid_uuid4(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        return False
    return parsed.version == 4 and str(parsed) == value


def _nonce() -> str:
    return base64.urlsafe_b64encode(os.urandom(16)).decode("ascii").rstrip("=")


def _controller_hello(
    project_id: str, addon_version: str, blender_version: str
) -> dict[str, object]:
    if not _valid_uuid4(project_id):
        raise ControllerConnectionError("project_id must be a lowercase UUIDv4")
    return {
        "type": "hello",
        "protocol": 1,
        "addon_version": addon_version,
        "blender_version": blender_version,
        "project_id": project_id,
        "client_nonce": _nonce(),
    }


def _validate_hello_ack(value: object, launch_id: str) -> dict[str, object]:
    common = {
        "type",
        "protocol",
        "daemon_version",
        "launch_id",
        "session_id",
        "server_nonce",
        "capabilities",
    }
    if not isinstance(value, dict) or set(value) not in (common, common | {"protocol_features"}):
        raise ControllerConnectionError("controller hello_ack fields are invalid")
    capabilities = value.get("capabilities")
    if (
        value.get("type") != "hello_ack"
        or value.get("protocol") != 1
        or value.get("daemon_version") != "0.1.0"
        or value.get("launch_id") != launch_id
        or not _valid_uuid4(value.get("session_id"))
        or not isinstance(value.get("server_nonce"), str)
        or len(value["server_nonce"]) != 22
        or not isinstance(capabilities, list)
        or not all(isinstance(capability, str) for capability in capabilities)
    ):
        raise ControllerConnectionError("controller hello_ack values are invalid")
    if "protocol_features" in value and value["protocol_features"] != [
        "snapshot_cursor_v2"
    ]:
        raise ControllerConnectionError("controller hello_ack features are invalid")
    return value


def _validate_owner_auth(value: object, launch_id: str) -> str:
    if (
        not isinstance(value, dict)
        or set(value) != {"type", "resume_token", "launch_id"}
        or value.get("type") != "controller_auth"
        or value.get("launch_id") != launch_id
        or not _valid_token(value.get("resume_token"))
    ):
        raise ControllerConnectionError("owner auth frame is invalid")
    return value["resume_token"]


def _validate_peer_auth(
    value: object,
    launch_id: str,
    lineage_id: str,
    expected_generation: int,
) -> str:
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "type",
            "resume_token",
            "launch_id",
            "lineage_id",
            "generation",
            "expires_in_ms",
        }
        or value.get("type") != "controller_peer_auth"
        or value.get("launch_id") != launch_id
        or value.get("lineage_id") != lineage_id
        or value.get("generation") != expected_generation
        or value.get("expires_in_ms") != 300_000
        or not _valid_token(value.get("resume_token"))
    ):
        raise ControllerConnectionError("peer auth frame is invalid")
    return value["resume_token"]


def _connect_resume_websocket(
    port: int,
    token: str,
    headers: dict[str, str],
    timeout: float,
) -> WebSocketClient:
    """Upgrade with the exact launch/lineage resume headers."""
    if not _valid_token(token):
        raise ControllerConnectionError("resume token is invalid")
    allowed_headers = {
        "X-CCLAY-Launch-ID",
        "X-CCLAY-Peer-Lineage-ID",
        "X-CCLAY-Peer-Generation",
    }
    if not headers or not set(headers).issubset(allowed_headers):
        raise ControllerConnectionError("resume headers are invalid")
    for value in headers.values():
        if not value or not value.isascii() or "\r" in value or "\n" in value:
            raise ControllerConnectionError("resume header value is invalid")

    connection = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    connection.settimeout(timeout)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    exact_headers = "".join(f"{name}: {value}\r\n" for name, value in headers.items())
    request = (
        f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\nAuthorization: Bearer {token}\r\n"
        f"X-CCLAY-Role: controller\r\n{exact_headers}\r\n"
    )
    try:
        connection.sendall(request.encode("ascii"))
        raw = bytearray()
        while b"\r\n\r\n" not in raw:
            chunk = connection.recv(4096)
            if not chunk or len(raw) + len(chunk) > 16_384:
                raise ProtocolError("invalid HTTP upgrade response")
            raw.extend(chunk)
        header, remainder = bytes(raw).split(b"\r\n\r\n", 1)
        if remainder:
            raise ProtocolError("unexpected bytes after HTTP upgrade")
        lines = header.decode("ascii").split("\r\n")
        if lines[0] != "HTTP/1.1 101 Switching Protocols":
            raise ProtocolError("WebSocket upgrade rejected")
        response_headers: dict[str, str] = {}
        for line in lines[1:]:
            name, separator, value = line.partition(":")
            if not separator or name.lower() in response_headers:
                raise ProtocolError("malformed upgrade header")
            response_headers[name.lower()] = value.strip()
        expected = base64.b64encode(
            hashlib.sha1((key + _GUID).encode("ascii")).digest()
        ).decode("ascii")
        connection_tokens = {
            part.strip().lower()
            for part in response_headers.get("connection", "").split(",")
        }
        if (
            response_headers.get("sec-websocket-accept") != expected
            or response_headers.get("upgrade", "").lower() != "websocket"
            or "upgrade" not in connection_tokens
        ):
            raise ProtocolError("invalid upgrade headers")
        return WebSocketClient(connection)
    except Exception:
        connection.close()
        raise


class ControllerConnection:
    """One immutable-authority owner or peer controller connection."""

    def __init__(
        self,
        *,
        websocket: WebSocketClient,
        authority: str,
        project_id: str,
        launch_id: str,
        port: int,
        addon_version: str,
        blender_version: str,
        resume_token: str,
        runtime_directory: Path | None,
        lineage_id: str | None,
        generation: int,
        resume_connect: Callable[[int, str, dict[str, str], float], WebSocketClient],
        jitter: Callable[[float], float],
    ):
        self.websocket = websocket
        self.authority = authority
        self.project_id = project_id
        self.launch_id = launch_id
        self.port = port
        self.addon_version = addon_version
        self.blender_version = blender_version
        self.resume_token = resume_token
        self.runtime_directory = runtime_directory
        self.lineage_id = lineage_id
        self.generation = generation
        self.state = ControllerState.ACTIVE
        self.capabilities: frozenset[str] = frozenset()
        self.session_id: str | None = None
        self._resume_connect = resume_connect
        self._jitter = jitter
        self._reader_thread: threading.Thread | None = None
        self._updates: deque[dict[str, object]] = deque()
        self._updates_lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._response_queues: dict[str, deque[dict[str, object]]] = {}
        self._response_condition = threading.Condition()
        self._shutdown_ack = threading.Event()
        self._lost_at: float | None = None
        self._next_reconnect_at: float | None = None
        self._attempt = 0
        self._start_reader_after_reconnect = False

    @classmethod
    def connect_owner(
        cls,
        *,
        port: int,
        boot_token: str,
        launch_id: str,
        project_id: str,
        addon_version: str,
        blender_version: str,
        runtime_directory: str | os.PathLike[str] | None,
        websocket_type: type[WebSocketClient] = WebSocketClient,
        resume_connect: Callable[
            [int, str, dict[str, str], float], WebSocketClient
        ] = _connect_resume_websocket,
        start_reader: bool = True,
        jitter: Callable[[float], float] | None = None,
    ) -> "ControllerConnection":
        if not _valid_uuid4(launch_id) or not _valid_token(boot_token):
            raise ControllerConnectionError("owner boot credential is invalid")
        websocket = websocket_type.connect(
            port, boot_token, timeout=3.0, role="controller"
        )
        try:
            hello = _controller_hello(project_id, addon_version, blender_version)
            websocket.send_json(hello)
            ack = _validate_hello_ack(websocket.recv_json(), launch_id)
            token = _validate_owner_auth(websocket.recv_json(), launch_id)
            controller = cls(
                websocket=websocket,
                authority="owner",
                project_id=project_id,
                launch_id=launch_id,
                port=port,
                addon_version=addon_version,
                blender_version=blender_version,
                resume_token=token,
                runtime_directory=Path(runtime_directory)
                if runtime_directory is not None
                else None,
                lineage_id=None,
                generation=1,
                resume_connect=resume_connect,
                jitter=jitter or (lambda delay: delay * 0.2 * (2 * os.urandom(1)[0] / 255 - 1)),
            )
            controller.capabilities = frozenset(ack["capabilities"])
            controller.session_id = str(ack["session_id"])
            if start_reader:
                controller.start_reader()
            return controller
        except Exception:
            websocket.close()
            raise

    @classmethod
    def attach_peer(
        cls,
        slot: DiscoverySlot,
        *,
        project_id: str,
        addon_version: str,
        blender_version: str,
        websocket_type: type[WebSocketClient] = WebSocketClient,
        resume_connect: Callable[
            [int, str, dict[str, str], float], WebSocketClient
        ] = _connect_resume_websocket,
        start_reader: bool = True,
        jitter: Callable[[float], float] | None = None,
    ) -> "ControllerConnection":
        if slot.slot != "controller_peer" or slot.lineage_id is None:
            raise ControllerConnectionError("peer discovery slot is invalid")
        endpoint = _read_runtime_endpoint(slot.runtime_directory)
        if endpoint["launch_id"] != slot.launch_id:
            raise ControllerConnectionError("peer slot launch does not match endpoint")
        websocket = websocket_type.connect(
            endpoint["port"], slot.ticket, timeout=3.0, role="controller"
        )
        try:
            websocket.send_json(
                _controller_hello(project_id, addon_version, blender_version)
            )
            ack = _validate_hello_ack(websocket.recv_json(), slot.launch_id)
            if _CONTROLLER_PEERS_CAPABILITY not in ack["capabilities"]:
                raise ControllerConnectionError(
                    "controller peer capability was not negotiated"
                )
            token = _validate_peer_auth(
                websocket.recv_json(),
                slot.launch_id,
                slot.lineage_id,
                slot.generation,
            )
            controller = cls(
                websocket=websocket,
                authority="peer",
                project_id=project_id,
                launch_id=slot.launch_id,
                port=int(endpoint["port"]),
                addon_version=addon_version,
                blender_version=blender_version,
                resume_token=token,
                runtime_directory=slot.runtime_directory,
                lineage_id=slot.lineage_id,
                generation=slot.generation,
                resume_connect=resume_connect,
                jitter=jitter or (lambda delay: delay * 0.2 * (2 * os.urandom(1)[0] / 255 - 1)),
            )
            controller.capabilities = frozenset(ack["capabilities"])
            controller.session_id = str(ack["session_id"])
            if start_reader:
                controller.start_reader()
            return controller
        except Exception:
            websocket.close()
            raise

    def _send_json(self, message: dict[str, object]) -> None:
        if self.state != ControllerState.ACTIVE:
            raise ControllerConnectionError("controller connection is not active")
        with self._send_lock:
            self.websocket.send_json(message)

    def _authenticate_resumed(self, websocket: WebSocketClient) -> None:
        websocket.send_json(
            _controller_hello(
                self.project_id, self.addon_version, self.blender_version
            )
        )
        ack = _validate_hello_ack(websocket.recv_json(), self.launch_id)
        if self.authority == "owner":
            token = _validate_owner_auth(websocket.recv_json(), self.launch_id)
            generation = self.generation
        else:
            if self.lineage_id is None:
                raise ControllerConnectionError("peer lineage is unavailable")
            generation = self.generation + 1
            token = _validate_peer_auth(
                websocket.recv_json(), self.launch_id, self.lineage_id, generation
            )
        previous_websocket = self.websocket
        self.websocket = websocket
        if (
            previous_websocket is not websocket
            and not previous_websocket.closed
        ):
            previous_websocket.close()
        self.resume_token = token
        self.generation = generation
        self.capabilities = frozenset(ack["capabilities"])
        self.session_id = str(ack["session_id"])

    def mark_lost(self) -> None:
        """Enter reconnect state without changing immutable controller authority."""
        with self._state_lock:
            if self.state not in (ControllerState.ACTIVE, ControllerState.RECONNECTING):
                return
            self.state = ControllerState.LOST
            now = time.monotonic()
            self._lost_at = now
            self._attempt = 0
            self._next_reconnect_at = now + _RECONNECT_DELAYS[0] + self._jitter(
                _RECONNECT_DELAYS[0]
            )

    def _resume_headers(self) -> dict[str, str]:
        headers = {"X-CCLAY-Launch-ID": self.launch_id}
        if self.authority == "peer":
            if self.lineage_id is None:
                raise ControllerConnectionError("peer lineage is unavailable")
            headers.update({
                "X-CCLAY-Peer-Lineage-ID": self.lineage_id,
                "X-CCLAY-Peer-Generation": str(self.generation),
            })
        return headers

    def _schedule_retry(self, now: float) -> None:
        self._attempt += 1
        elapsed = now - (self._lost_at if self._lost_at is not None else now)
        if elapsed >= _RECONNECT_WINDOW:
            self.state = ControllerState.MANUAL_RECOVERY
            delay = _MANUAL_POLL_DELAY
        else:
            self.state = ControllerState.LOST
            delay = (
                _RECONNECT_DELAYS[self._attempt]
                if self._attempt < len(_RECONNECT_DELAYS)
                else _RECONNECT_CEILING
            )
            delay += self._jitter(delay)
        self._next_reconnect_at = now + max(0.0, delay)

    def poll_reconnect(self, *, force: bool = False, now: float | None = None) -> bool:
        """Attempt one owner/peer resume when its bounded backoff is due."""
        if self.state not in (
            ControllerState.LOST,
            ControllerState.RECONNECTING,
            ControllerState.MANUAL_RECOVERY,
        ):
            return False
        current = time.monotonic() if now is None else now
        if not force and self._next_reconnect_at is not None and current < self._next_reconnect_at:
            return False
        self.state = ControllerState.RECONNECTING
        websocket: WebSocketClient | None = None
        try:
            websocket = self._resume_connect(
                self.port,
                self.resume_token,
                self._resume_headers(),
                3.0,
            )
            self._authenticate_resumed(websocket)
            self.state = ControllerState.ACTIVE
            self._lost_at = None
            self._next_reconnect_at = None
            self._attempt = 0
            if self._start_reader_after_reconnect:
                self.start_reader()
            return True
        except Exception:
            if websocket is not None:
                websocket.close()
            self._schedule_retry(current)
            return False

    def handle_server_message(self, message: object) -> None:
        """Validate the server discriminator and enqueue one credential-free update."""
        if not isinstance(message, dict) or message.get("type") not in _KNOWN_SERVER_TYPES:
            try:
                self.websocket.close(1008)
            finally:
                self.mark_lost()
            raise ControllerConnectionError("unknown server frame")
        if message["type"] == "shutdown_ack":
            self._shutdown_ack.set()
        request_id = message.get("id")
        if isinstance(request_id, str):
            with self._response_condition:
                pending = self._response_queues.get(request_id)
                if pending is not None:
                    pending.append(message)
                    self._response_condition.notify_all()
                    return
        with self._updates_lock:
            self._updates.append(message)

    def start_reader(self) -> None:
        if self._reader_thread is not None and self._reader_thread.is_alive():
            raise ControllerConnectionError("controller reader is already running")
        self._start_reader_after_reconnect = True
        self.websocket.socket.settimeout(0.1)

        def receive_loop() -> None:
            while self.state == ControllerState.ACTIVE and not self.websocket.closed:
                try:
                    message = self.websocket.recv_json()
                except TimeoutError:
                    continue
                except (OSError, StopIteration, WebSocketError):
                    self.mark_lost()
                    return
                try:
                    self.handle_server_message(message)
                except ControllerConnectionError:
                    return

        self._reader_thread = threading.Thread(
            target=receive_loop,
            name=f"cclay-controller-{self.authority}-receiver",
            daemon=True,
        )
        self._reader_thread.start()

    @property
    def pending_update_count(self) -> int:
        with self._updates_lock:
            return len(self._updates)

    def drain_updates(
        self,
        *,
        max_updates: int = 32,
        budget_ms: float = 4.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> list[dict[str, object]]:
        """Drain at most 32 updates or 4 ms for the Blender panel timer."""
        if not 1 <= max_updates <= 32 or not 0 < budget_ms <= 4.0:
            raise ControllerConnectionError("controller drain bounds are invalid")
        deadline = clock() + budget_ms / 1000
        drained: list[dict[str, object]] = []
        while len(drained) < max_updates and clock() < deadline:
            with self._updates_lock:
                if not self._updates:
                    break
                drained.append(self._updates.popleft())
        return drained

    def request(
        self,
        message: dict[str, object],
        expected_type: str,
        *,
        timeout: float = 3.0,
    ) -> dict[str, object]:
        request_id = message.get("id")
        if not isinstance(request_id, str):
            raise ControllerConnectionError("controller request requires an id")
        if self._reader_thread is None or not self._reader_thread.is_alive():
            self._send_json(message)
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                response = self.websocket.recv_json()
                if (
                    isinstance(response, dict)
                    and response.get("id") == request_id
                    and response.get("type") == expected_type
                ):
                    return response
                self.handle_server_message(response)
            raise ControllerConnectionError("controller request timed out")

        pending: deque[dict[str, object]] = deque()
        with self._response_condition:
            self._response_queues[request_id] = pending
        try:
            self._send_json(message)
            deadline = time.monotonic() + timeout
            with self._response_condition:
                while True:
                    while pending:
                        response = pending.popleft()
                        if response.get("type") == expected_type:
                            return response
                        if response.get("type") == "error":
                            raise ControllerConnectionError(
                                f"controller request failed: {response.get('code')}"
                            )
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ControllerConnectionError("controller request timed out")
                    self._response_condition.wait(remaining)
        finally:
            with self._response_condition:
                self._response_queues.pop(request_id, None)

    def publish_bridge_slot(self, *, timeout: float = 3.0) -> dict[str, object]:
        if self.authority != "owner":
            raise ControllerConnectionError("peer controller cannot publish bridge discovery")
        request_id = str(uuid.uuid4())
        return self.request(
            {"type": "publish_bridge_discovery_slot", "id": request_id},
            "bridge_discovery_slot_ack",
            timeout=timeout,
        )

    def publish_peer_slot(
        self, lineage_id: str, *, timeout: float = 3.0
    ) -> dict[str, object]:
        if self.authority != "owner":
            raise ControllerConnectionError("peer controller cannot publish peer discovery")
        if not _valid_uuid4(lineage_id):
            raise ControllerConnectionError("peer lineage_id must be a lowercase UUIDv4")
        request_id = str(uuid.uuid4())
        return self.request(
            {
                "type": "publish_controller_peer_discovery_slot",
                "id": request_id,
                "lineage_id": lineage_id,
            },
            "controller_peer_discovery_slot_ack",
            timeout=timeout,
        )

    def shutdown(self, reason: str, *, timeout: float = 3.0) -> None:
        if self.authority != "owner":
            raise ControllerConnectionError("peer controller cannot shut down daemon")
        if reason not in ("client_exit", "addon_unload"):
            raise ControllerConnectionError("shutdown reason is invalid")
        self._send_json({"type": "shutdown", "reason": reason})
        if self._reader_thread is not None and self._reader_thread.is_alive():
            self._shutdown_ack.wait(timeout)
        else:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                message = self.websocket.recv_json()
                if isinstance(message, dict) and message.get("type") == "shutdown_ack":
                    break
                self.handle_server_message(message)
        self.close()

    def close(self) -> None:
        with self._state_lock:
            if self.state == ControllerState.STOPPED:
                return
            self.state = ControllerState.STOPPED
        self.resume_token = ""
        if not self.websocket.closed:
            self.websocket.close()
        if self._reader_thread is not None and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=0.1)
        with self._updates_lock:
            self._updates.clear()
        with self._response_condition:
            self._response_queues.clear()
            self._response_condition.notify_all()


_active_controller: ControllerConnection | None = None
_pending_peer_configuration: dict[str, object] | None = None


def set_active_controller(controller: ControllerConnection | None) -> None:
    global _active_controller, _pending_peer_configuration
    if _active_controller is not None and _active_controller is not controller:
        _active_controller.close()
    _active_controller = controller
    if controller is not None:
        _pending_peer_configuration = None


def configure_peer_discovery(
    *,
    project_id: str,
    addon_version: str,
    blender_version: str,
    runtime_user_directory: str | os.PathLike[str] | None = None,
    lineage_id: str | None = None,
) -> None:
    global _pending_peer_configuration
    _pending_peer_configuration = {
        "project_id": project_id,
        "addon_version": addon_version,
        "blender_version": blender_version,
        "runtime_user_directory": runtime_user_directory,
        "lineage_id": lineage_id,
    }


def poll_controller_lifecycle(*, force: bool = False) -> float:
    """Drive peer discovery or in-memory owner/peer resume from one Blender timer."""
    global _active_controller
    if _active_controller is not None:
        controller = _active_controller
        controller.poll_reconnect(force=force)
        if controller.state == ControllerState.ACTIVE:
            return 0.016
        if (
            controller.authority == "peer"
            and controller.runtime_directory is not None
        ):
            slot = consume_discovery_slot(
                controller.project_id,
                "controller_peer",
                runtime_user_directory=controller.runtime_directory.parent,
                lineage_id=controller.lineage_id,
                launch_id=controller.launch_id,
            )
            if slot is not None:
                try:
                    replacement = ControllerConnection.attach_peer(
                        slot,
                        project_id=controller.project_id,
                        addon_version=controller.addon_version,
                        blender_version=controller.blender_version,
                    )
                except Exception:
                    pass
                else:
                    controller.close()
                    _active_controller = replacement
                    return 0.016
        return 0.1
    if _pending_peer_configuration is None:
        return 0.1
    configuration = _pending_peer_configuration
    slot = consume_discovery_slot(
        str(configuration["project_id"]),
        "controller_peer",
        runtime_user_directory=configuration["runtime_user_directory"],
        lineage_id=configuration["lineage_id"],
    )
    if slot is None:
        return 0.1
    try:
        _active_controller = ControllerConnection.attach_peer(
            slot,
            project_id=str(configuration["project_id"]),
            addon_version=str(configuration["addon_version"]),
            blender_version=str(configuration["blender_version"]),
        )
    except Exception:
        _active_controller = None
        return 0.1
    return 0.016


def disconnect_active_controller(
    *, reason: str = "addon_unload", shutdown_owner: bool = False
) -> bool:
    global _active_controller, _pending_peer_configuration
    _pending_peer_configuration = None
    controller = _active_controller
    _active_controller = None
    if controller is None:
        return False
    if shutdown_owner and controller.authority == "owner" and controller.state == ControllerState.ACTIVE:
        try:
            controller.shutdown(reason)
        except (ControllerConnectionError, OSError, WebSocketError):
            controller.close()
    else:
        controller.close()
    return True
