"""Owned daemon and WebSocket connection lifecycle for the Blender add-on."""

import hashlib
import json
import os
import queue
import subprocess
import shlex
import threading
import time
from enum import Enum
from os import PathLike
from pathlib import Path
from typing import Any, Callable, Sequence

from .checkpoint import Checkpoint, restore, verify
from .daemon_child import DaemonChild, UnsafeExecutableError, verify_executable
from .handshake import HandshakeError, build_hello, validate_hello_ack
from .ws_client import WebSocketClient, WebSocketError

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover - exercised by host-side imports
    bpy = None


class ConnectionError(RuntimeError):
    """The owned daemon connection violated its lifecycle contract."""


class DurableCommitReconciliationRequired(ConnectionError):
    """A post-mutation durable outcome cannot be determined safely."""


class StaleBridgeBase(ConnectionError):
    """The durable project revision differs from the bridge request."""

    code = "STALE_BASE"

class LifecycleState(str, Enum):
    """Closed lifecycle contract shared by the detector, UI, and restart path."""

    ACTIVE = "active"
    LOST = "lost"
    DISCONNECTED = "disconnected"
    RECOVERY_REQUIRED = "recovery_required"
    DRAINING = "draining"
    STOPPED = "stopped"


RECONNECTABLE_STATES = frozenset({
    LifecycleState.LOST,
    LifecycleState.DISCONNECTED,
    LifecycleState.RECOVERY_REQUIRED,
})


class Connection:
    """One daemon child and its single authenticated WebSocket."""

    def __init__(
        self,
        child: DaemonChild,
        websocket: WebSocketClient,
        project_directory: str | PathLike[str] | None = None,
        *,
        tools_exposed: bool = True,
        identity: dict[str, str] | None = None,
    ):
        self.child = child
        self.websocket = websocket
        self.state = LifecycleState.ACTIVE
        self.tools_exposed = tools_exposed
        self.identity = identity
        self.active_checkpoint: Checkpoint | None = None
        self.durable_commit_reconciliation: dict | None = None
        self._bridge_cancellations: dict[str, threading.Event] = {}
        self._terminal_bridge_ids: set[str] = set()
        self._reader_thread: threading.Thread | None = None
        self._response_queues: dict[str, queue.Queue] = {}
        self._cancel_ack_queues: dict[str, queue.Queue] = {}
        self._main_thread_messages: queue.Queue = queue.Queue()
        self.last_bridge_response: dict | None = None
        self._send_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self.project_directory = (
            Path(project_directory) if project_directory is not None else None
        )

    def expose_tools(self) -> None:
        """Expose bridge tools only after the reconnect scene gate succeeds."""
        if self.state != LifecycleState.ACTIVE:
            raise ConnectionError("cannot expose tools on an inactive connection")
        self.tools_exposed = True

    def require_recovery(self) -> None:
        """Hide every bridge tool and retain a terminal recovery state."""
        self.tools_exposed = False
        with self._state_lock:
            self.state = LifecycleState.RECOVERY_REQUIRED

    def _mark_lost_if_active(self) -> None:
        """Record reader failure without replacing a main-thread terminal state."""
        with self._state_lock:
            if self.state == LifecycleState.ACTIVE:
                self.state = LifecycleState.LOST

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
                raise StaleBridgeBase(
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
        """Run queued Blender work and recover socket loss on the main thread."""
        for _index in range(8):
            try:
                message = self._main_thread_messages.get_nowait()
            except queue.Empty:
                break
            self.dispatch_bridge_message(message)

        if self.state == LifecycleState.LOST:
            self.tools_exposed = False
            if self.active_checkpoint is not None:
                if self.durable_commit_reconciliation is not None:
                    self.state = LifecycleState.RECOVERY_REQUIRED
                else:
                    from .camera_plan import _read_scope, _restore_scope

                    try:
                        restored = self.restore_on_unexpected_loss(
                            _restore_scope, _read_scope
                        )
                    except BaseException:
                        restored = False
                    self.state = (
                        LifecycleState.DISCONNECTED
                        if restored
                        else LifecycleState.RECOVERY_REQUIRED
                    )
            else:
                self.state = LifecycleState.DISCONNECTED
        if self.state != LifecycleState.ACTIVE:
            if not self.websocket.closed:
                try:
                    self.websocket.close()
                except (OSError, WebSocketError):
                    pass
            if self._reader_thread is not None and self._reader_thread.is_alive():
                self._reader_thread.join(timeout=0.2)
            return None
        return 0.01


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
            while self.state == LifecycleState.ACTIVE and not self.websocket.closed:
                try:
                    message = self.websocket.recv_json()
                except StopIteration:
                    self._mark_lost_if_active()
                    return
                except TimeoutError:
                    continue
                except (OSError, WebSocketError):
                    self._mark_lost_if_active()
                    return
                if not isinstance(message, dict):
                    continue
                if message.get("type") == "bridge_request":
                    self._main_thread_messages.put(message)
                    continue
                if message.get("type") == "bridge_cancel":
                    self.dispatch_bridge_message(message)
                    continue
                if message.get("type") == "cancel_ack":
                    response_queue = self._cancel_ack_queues.get(message.get("id"))
                elif message.get("type") in ("response", "error"):
                    response_queue = self._response_queues.get(message.get("id"))
                else:
                    response_queue = None
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
        if not self.tools_exposed:
            self._send_bridge_error(
                message,
                "RECOVERY_REQUIRED",
                "tool capabilities remain hidden until reconnect verification succeeds",
            )
            return
        if message.get("method") not in ("apply_camera_plan", "render_qa_frames"):
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
                f"{message.get('method')} bridge request has invalid fields",
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
                getattr(error, "code", "DURABLE_BASE_UNAVAILABLE"),
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
            if message["method"] == "apply_camera_plan":
                bpy.ops.omb.apply_camera_plan(
                    plan_json=json.dumps(message["params"], separators=(",", ":")),
                    current_scene_hash=current_scene_hash,
                    bridge_id=bridge_id,
                    request_id=message["request_id"],
                    deadline_ms=message["deadline_ms"],
                )
            else:
                bpy.ops.omb.render_qa_frames(
                    request_json=json.dumps(message["params"], separators=(",", ":")),
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

    def ensure_mutation_connection(self, phase: str) -> None:
        """Enforce the socket-loss barrier between main-thread mutation phases."""
        socket = getattr(self.websocket, "socket", None)
        fileno = getattr(socket, "fileno", None)
        socket_closed = self.websocket.closed
        if callable(fileno):
            try:
                socket_closed = socket_closed or fileno() < 0
            except OSError:
                socket_closed = True
        if (
            self.state != LifecycleState.ACTIVE
            or socket_closed
            or self._child_has_exited()
        ):
            self.state = LifecycleState.LOST
            raise ConnectionError(
                f"daemon connection was lost during camera-plan phase {phase}"
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

    def _candidate_revision_id(self, result: dict) -> str:
        try:
            revision_id = result["manifest"]["revisionId"]
        except (KeyError, TypeError) as error:
            raise ConnectionError(
                "camera-plan mutation result does not retain a candidate revision"
            ) from error
        if (
            not isinstance(revision_id, str)
            or len(revision_id) != 64
            or any(character not in "0123456789abcdef" for character in revision_id)
        ):
            raise ConnectionError("camera-plan candidate revision is invalid")
        return revision_id

    def _read_durable_revision_id(self) -> str:
        if self.project_directory is None:
            raise DurableCommitReconciliationRequired(
                "camera-plan commit reconciliation required: "
                "durable project directory is unavailable"
            )
        try:
            project = json.loads(
                (self.project_directory / ".omb/project.json").read_text(
                    encoding="utf-8"
                )
            )
            revision_id = project["current_revision_id"]
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as error:
            raise DurableCommitReconciliationRequired(
                "camera-plan commit reconciliation required: "
                f"durable project state is unavailable: {error}"
            ) from error
        if (
            not isinstance(revision_id, str)
            or len(revision_id) != 64
            or any(character not in "0123456789abcdef" for character in revision_id)
        ):
            raise DurableCommitReconciliationRequired(
                "camera-plan commit reconciliation required: "
                "durable current revision is invalid"
            )
        return revision_id

    def reconcile_durable_bridge_commit(
        self, *, base_is_definitive: bool = False
    ) -> str:
        """Idempotently compare an in-doubt mutation with durable project state."""
        reconciliation = self.durable_commit_reconciliation
        if reconciliation is None:
            raise ConnectionError("no durable bridge commit is awaiting reconciliation")
        outcome = reconciliation["outcome"]
        if outcome in ("committed", "not_committed"):
            return outcome
        try:
            durable_revision_id = self._read_durable_revision_id()
        except DurableCommitReconciliationRequired:
            reconciliation["outcome"] = "reconciliation_required"
            raise
        candidate_revision_id = reconciliation["candidate_revision_id"]
        base_revision_id = reconciliation["base_revision_id"]
        if durable_revision_id == candidate_revision_id:
            reconciliation["outcome"] = "committed"
            self.release_checkpoint()
            return "committed"
        if durable_revision_id == base_revision_id:
            if base_is_definitive:
                reconciliation["outcome"] = "not_committed"
                return "not_committed"
            reconciliation["outcome"] = "in_doubt"
            return "in_doubt"
        reconciliation["outcome"] = "reconciliation_required"
        raise DurableCommitReconciliationRequired(
            "camera-plan commit reconciliation required: durable project is at "
            f"unexpected revision {durable_revision_id}"
        )

    def _record_durable_response(self, message: dict) -> dict:
        reconciliation = self.durable_commit_reconciliation
        if reconciliation is None:
            raise ConnectionError("durable bridge response has no retained candidate")
        if message.get("resulting_revision_id") != reconciliation["candidate_revision_id"]:
            reconciliation["outcome"] = "reconciliation_required"
            raise DurableCommitReconciliationRequired(
                "camera-plan commit reconciliation required: "
                "daemon response does not match the candidate revision"
            )
        reconciliation["outcome"] = "committed"
        self.release_checkpoint()
        self.last_bridge_response = message
        return message

    def _child_has_exited(self) -> bool:
        poll = getattr(self.child.process, "poll", None)
        return callable(poll) and poll() is not None

    def _await_in_doubt_resolution(
        self,
        response_queue: queue.Queue | None,
        request_id: str,
    ) -> dict:
        reconciliation_deadline = time.monotonic() + 8.0
        while time.monotonic() < reconciliation_deadline:
            outcome = self.reconcile_durable_bridge_commit()
            if outcome == "committed":
                return {
                    "type": "response",
                    "id": request_id,
                    "resulting_revision_id": self.durable_commit_reconciliation[
                        "candidate_revision_id"
                    ],
                    "reconciled": True,
                }
            message = None
            if response_queue is not None:
                try:
                    message = response_queue.get_nowait()
                except queue.Empty:
                    pass
            if isinstance(message, dict) and message.get("type") == "response":
                return self._record_durable_response(message)
            if isinstance(message, dict) and message.get("type") == "error":
                self.reconcile_durable_bridge_commit(base_is_definitive=True)
                raise ConnectionError(
                    "camera-plan durable commit failed: "
                    f"{message.get('code', 'UNKNOWN')}"
                )
            if self._child_has_exited() and (
                self.reconcile_durable_bridge_commit(base_is_definitive=True)
                == "not_committed"
            ):
                raise ConnectionError(
                    "camera-plan durable commit did not complete before connection loss"
                )
            time.sleep(0.01)
        self.durable_commit_reconciliation["outcome"] = "reconciliation_required"
        raise DurableCommitReconciliationRequired(
            "camera-plan commit reconciliation required: "
            "durable outcome remained in doubt"
        )

    def await_durable_bridge_commit(
        self,
        bridge_id: str,
        request_id: str,
        result: dict,
        deadline: float | None = None,
    ) -> dict:
        """Send a bridge result and retain the mutation until durable resolution."""
        candidate_revision_id = self._candidate_revision_id(result)
        base_revision_id = result.get("expected_revision_id")
        if not isinstance(base_revision_id, str):
            raise ConnectionError("camera-plan mutation result does not retain its base revision")
        self.durable_commit_reconciliation = {
            "bridge_id": bridge_id,
            "request_id": request_id,
            "base_revision_id": base_revision_id,
            "candidate_revision_id": candidate_revision_id,
            "outcome": "awaiting_ack",
        }
        response_queue = None
        if self._reader_thread is not None and self._reader_thread.is_alive():
            response_queue = queue.Queue(maxsize=1)
            self._response_queues[request_id] = response_queue
        try:
            self._send_json({
                "type": "bridge_result",
                "id": bridge_id,
                "request_id": request_id,
                "result": result,
            })
        except (OSError, StopIteration, TimeoutError, WebSocketError):
            self.durable_commit_reconciliation["outcome"] = "in_doubt"
            try:
                return self._await_in_doubt_resolution(
                    response_queue, request_id
                )
            finally:
                self._response_queues.pop(request_id, None)
        try:
            while True:
                remaining = None
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        self.durable_commit_reconciliation["outcome"] = "in_doubt"
                        return self._await_in_doubt_resolution(
                            response_queue, request_id
                        )
                try:
                    if response_queue is not None:
                        message = response_queue.get(timeout=remaining)
                    else:
                        socket = getattr(self.websocket, "socket", None)
                        if socket is not None and remaining is not None:
                            socket.settimeout(remaining)
                        message = self.websocket.recv_json()
                except queue.Empty:
                    self.durable_commit_reconciliation["outcome"] = "in_doubt"
                    return self._await_in_doubt_resolution(response_queue, request_id)
                except (OSError, StopIteration, TimeoutError, WebSocketError):
                    self.durable_commit_reconciliation["outcome"] = "in_doubt"
                    return self._await_in_doubt_resolution(response_queue, request_id)
                if (
                    not isinstance(message, dict)
                    or message.get("id") != request_id
                ):
                    continue
                if message.get("type") == "response":
                    return self._record_durable_response(message)
                if message.get("type") == "error":
                    self.durable_commit_reconciliation["outcome"] = "not_committed"
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
        expose_tools: bool = True,
    ) -> "Connection":
        """Spawn, authenticate, and complete the protocol-v2 hello exchange."""
        child = child_type.spawn(argv, cwd=cwd)
        websocket = None
        try:
            record = child.read_startup_record()
            token = record["bearer_token"]
            token_fingerprint = hashlib.sha256(token.encode("ascii")).hexdigest()
            websocket = websocket_type.connect(record["port"], token, timeout=3.0)
            token = None
            if hasattr(websocket, "socket"):
                websocket.socket.settimeout(3.0)
            hello = build_hello(project_id, addon_version, blender_version)
            websocket.send_json(hello)
            try:
                ack = validate_hello_ack(websocket.recv_json())
            except HandshakeError as exc:
                raise ConnectionError(str(exc)) from exc
            if ack["launch_id"] != record["launch_id"]:
                raise ConnectionError("hello_ack launch_id does not match daemon launch")
            connection = cls(
                child,
                websocket,
                project_directory=cwd,
                tools_exposed=expose_tools,
                identity={
                    "launch_id": record["launch_id"],
                    "bearer_token_fingerprint": token_fingerprint,
                    "client_nonce": hello["client_nonce"],
                    "session_id": ack["session_id"],
                    "server_nonce": ack["server_nonce"],
                },
            )
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
        if self.state == LifecycleState.STOPPED:
            return
        self.state = LifecycleState.DRAINING
        if bpy is not None and bpy.app.timers.is_registered(self.pump_bridge_messages):
            bpy.app.timers.unregister(self.pump_bridge_messages)
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
        if self._reader_thread is not None and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=0.2)
        self._response_queues.clear()
        self._cancel_ack_queues.clear()
        self._bridge_cancellations.clear()
        self._terminal_bridge_ids.clear()
        while True:
            try:
                self._main_thread_messages.get_nowait()
            except queue.Empty:
                break
        self.state = LifecycleState.STOPPED


def verify_reconnect_hash(
    live_scene_hash: str, canonical_revision_scene_hash: str
) -> None:
    """Enforce the protocol-v2 full-restart scene consistency gate."""
    if live_scene_hash != canonical_revision_scene_hash:
        raise ConnectionError(
            "live scene hash does not match the canonical current revision"
        )


def _read_reconnect_scene_hash(cwd: str | PathLike[str]) -> str:
    try:
        project = json.loads(
            (Path(cwd) / ".omb/project.json").read_text(encoding="utf-8")
        )
        current_revision_id = project["current_revision_id"]
        manifest = project["manifest"]
        manifest_revision_id = manifest["revisionId"]
        scene_hash = manifest["sceneHash"]
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise ConnectionError(
            f"durable canonical current revision is unavailable: {error}"
        ) from error
    if manifest_revision_id != current_revision_id:
        raise ConnectionError(
            "durable canonical manifest does not match the current revision"
        )
    for name, value in (
        ("current revision", current_revision_id),
        ("scene hash", scene_hash),
    ):
        if (
            not isinstance(value, str)
            or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)
        ):
            raise ConnectionError(f"durable canonical {name} is invalid")
    return scene_hash


def _confirm_previous_child_exit(previous_connection: Connection | None) -> None:
    if previous_connection is None:
        return
    poll = getattr(previous_connection.child.process, "poll", None)
    if not callable(poll):
        raise ConnectionError("previous daemon child exit cannot be confirmed")
    poll()
    if previous_connection.state != LifecycleState.STOPPED:
        previous_connection.disconnect("restart_after_unexpected_loss")
    if poll() is None:
        raise ConnectionError("previous daemon child did not exit before restart")


def _verify_fresh_connection_identity(
    previous_connection: Connection | None, replacement: Connection
) -> None:
    if previous_connection is None:
        return
    previous_identity = previous_connection.identity
    replacement_identity = replacement.identity
    if not isinstance(previous_identity, dict) or not isinstance(replacement_identity, dict):
        return
    reused = [
        name
        for name in (
            "launch_id",
            "bearer_token_fingerprint",
            "client_nonce",
            "session_id",
            "server_nonce",
        )
        if previous_identity.get(name) == replacement_identity.get(name)
    ]
    if reused:
        raise ConnectionError(
            "replacement daemon reused restart identities: " + ", ".join(reused)
        )


def reconnect(
    argv: Sequence[str],
    *,
    cwd: str | PathLike[str],
    project_id: str,
    addon_version: str,
    blender_version: str,
    live_scene_hash_fn: Callable[[], str],
    previous_connection: Connection | None = None,
    child_type: type[DaemonChild] = DaemonChild,
    websocket_type: type[WebSocketClient] = WebSocketClient,
) -> Connection:
    """Restart with fresh identities and expose tools only after the V2 hash gate."""
    _confirm_previous_child_exit(previous_connection)
    expected_scene_hash = _read_reconnect_scene_hash(cwd)
    connection = Connection.start(
        argv,
        cwd=cwd,
        project_id=project_id,
        addon_version=addon_version,
        blender_version=blender_version,
        child_type=child_type,
        websocket_type=websocket_type,
        expose_tools=False,
    )
    try:
        _verify_fresh_connection_identity(previous_connection, connection)
        verify_reconnect_hash(live_scene_hash_fn(), expected_scene_hash)
        connection.expose_tools()
    except Exception:
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
_NODE_EXECUTABLE_ENV = "OMB_NODE_EXECUTABLE"


def _resolve_daemon_argv(daemon_args: Sequence[str] | None) -> tuple[str, ...]:
    """Resolve an explicit launch mode and a safety-verified absolute Node path."""
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
    configured_node = os.environ.get(_NODE_EXECUTABLE_ENV)
    if configured_node is None:
        raise ConnectionError(
            f"NOT_CONFIGURED: {_NODE_EXECUTABLE_ENV} must be an absolute trusted Node executable"
        )
    try:
        node_executable = verify_executable(configured_node)
    except UnsafeExecutableError as error:
        raise ConnectionError(str(error)) from error
    if daemon_args is None:
        configured = os.environ.get(_DAEMON_ARGS_ENV)
        if configured is None:
            raise ConnectionError(
                "NOT_CONFIGURED: no daemon launch mode is configured; set the "
                f"{_DAEMON_ARGS_ENV} environment variable (or pass daemon_args "
                "explicitly) to '--faux' or explicit '--provider <id> --model <id>'"
            )
        daemon_args = tuple(shlex.split(configured))
    daemon_args = tuple(daemon_args)
    if daemon_args != ("--faux",):
        parsed: dict[str, str] = {}
        index = 0
        while index < len(daemon_args):
            flag = daemon_args[index]
            if (
                flag not in ("--provider", "--model")
                or flag in parsed
                or index + 1 >= len(daemon_args)
                or not daemon_args[index + 1]
                or daemon_args[index + 1].startswith("--")
            ):
                raise ConnectionError(
                    "INVALID_ARGUMENT: unsupported daemon arguments; credentials "
                    "must be supplied only through the provider environment variable"
                )
            parsed[flag] = daemon_args[index + 1]
            index += 2
        if set(parsed) != {"--provider", "--model"}:
            raise ConnectionError(
                "NOT_CONFIGURED: explicit --provider <id> and --model <id> are required"
            )
    return (
        node_executable,
        "--import",
        str(tsx_loader),
        daemon_main,
        "--port",
        "0",
        *daemon_args,
    )


def _live_scene_hash() -> str:
    from .manifest import extract_scene_manifest_v2

    return extract_scene_manifest_v2()["sceneHash"]


def connect(
    *,
    cwd: str | PathLike[str],
    project_id: str,
    addon_version: str,
    blender_version: str,
    daemon_args: Sequence[str] | None = None,
) -> Connection:
    """Create or hash-gate a replacement for the add-on's sole daemon connection."""
    global _active_connection
    previous = _active_connection
    if previous is not None and previous.state not in (
        LifecycleState.STOPPED,
        *RECONNECTABLE_STATES,
    ):
        raise ConnectionError("the add-on already owns an active daemon connection")
    argv = _resolve_daemon_argv(daemon_args)
    if previous is not None and previous.state in RECONNECTABLE_STATES:
        replacement = reconnect(
            argv,
            cwd=cwd,
            project_id=project_id,
            addon_version=addon_version,
            blender_version=blender_version,
            live_scene_hash_fn=_live_scene_hash,
            previous_connection=previous,
        )
    else:
        replacement = Connection.start(
            argv,
            cwd=cwd,
            project_id=project_id,
            addon_version=addon_version,
            blender_version=blender_version,
        )
    _active_connection = replacement
    return replacement


def disconnect_active(reason: str) -> bool:
    """Disconnect and release the retained connection, if one exists."""
    global _active_connection
    if _active_connection is None or _active_connection.state == LifecycleState.STOPPED:
        _active_connection = None
        return False
    active = _active_connection
    try:
        active.disconnect(reason)
    finally:
        _active_connection = None
    return True
