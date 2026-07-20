"""Owned daemon and WebSocket connection lifecycle for the Blender add-on."""

import hashlib
import json
import os
import queue
import secrets
import subprocess
import shlex
import stat
import tempfile
import threading
import time
from dataclasses import dataclass, replace
from enum import Enum
from os import PathLike
from pathlib import Path
from typing import Any, Callable, Sequence
from uuid import UUID, uuid4

from .checkpoint import Checkpoint, restore, verify
from .daemon_child import DaemonChild, UnsafeExecutableError, verify_executable
from .handshake import (
    HandshakeError,
    MUTATION_BRIDGE_CAPABILITY,
    SCENE_MANIFEST_V3_CAPABILITY,
    TRANSACTION_COMMIT_CAPABILITY,
    build_hello,
    validate_hello_ack,
)
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


@dataclass(frozen=True)
class TaskStatus:
    """Closed, credential-free status retained for the read-only Blender UI."""

    task_kind: str | None = None
    descriptor: str = "Awaiting Pi-issued task"
    phase: str = "idle"
    completed: int = 0
    total: int = 0
    outcome: str | None = None
    evidence: str = "No retained evidence"


_TASK_KINDS = {
    "apply_camera_plan": "camera_plan",
    "render_qa_frames": "qa_render",
    "stage_scene": "stage_scene",
}
_BOOTSTRAP_REVISION_ID = "0" * 64
_TASK_PHASES = frozenset({
    "dispatching",
    "validating",
    "mutating",
    "durable_commit",
    "rendering",
    "rendered",
    "publishing",
    "recovery_required",
    "disconnected",
    "recovered",
})
_TASK_OUTCOMES = frozenset({
    "success",
    "error",
    "cancelled",
    "disconnected",
    "recovery_required",
    "recovered",
})


def _digest_prefix(value: object) -> str:
    if (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    ):
        return value[:12]
    return "unavailable"


def _task_descriptor(method: str, params: object) -> tuple[str, int]:
    value = params if isinstance(params, dict) else {}
    if method == "apply_camera_plan":
        keyframes = value.get("keyframes")
        count = len(keyframes) if isinstance(keyframes, list) else 0
        revision = _digest_prefix(value.get("expected_revision_id"))
        noun = "keyframe" if count == 1 else "keyframes"
        return f"Camera plan revision {revision}, {count} camera-plan {noun}", 1
    if method == "stage_scene":
        operations = value.get("operations")
        count = len(operations) if isinstance(operations, list) else 0
        revision = _digest_prefix(value.get("expected_revision_id"))
        noun = "operation" if count == 1 else "operations"
        return f"Stage scene revision {revision}, {count} {noun}", count
    frames = value.get("frames")
    safe_frames = [
        frame for frame in frames
        if isinstance(frame, int) and not isinstance(frame, bool)
    ] if isinstance(frames, list) else []
    rendered_frames = ", ".join(str(frame) for frame in safe_frames) or "none"
    revision = _digest_prefix(value.get("revision_id"))
    return f"QA render revision {revision}, frames {rendered_frames}", len(safe_frames)


def _owned_by_current_user(metadata: os.stat_result) -> bool:
    getuid = getattr(os, "getuid", None)
    return not callable(getuid) or metadata.st_uid == getuid()


def _verify_private_runtime_directory(directory: Path) -> None:
    try:
        metadata = directory.lstat()
    except OSError as error:
        raise ConnectionError(f"runtime directory is unavailable: {error}") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise ConnectionError("runtime directory must be a nonsymlink directory")
    if not _owned_by_current_user(metadata):
        raise ConnectionError("runtime directory must be owned by the current user")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise ConnectionError("runtime directory must be private (mode 0700)")


_ATTACH_HANDOFF_FILENAME = "attach-handoff.json"
_ATTACH_HANDOFF_FIELDS = {"schema_version", "project_id", "ticket", "expires_at_ms"}
_DISCOVERY_SLOT_FILENAMES = {
    "bridge": "bridge-slot.json",
    "controller_peer": "controller-peer-slot.json",
}
_DISCOVERY_SLOT_V1_FIELDS = {
    "bridge": {
        "schema_version",
        "project_id",
        "ticket",
        "expires_at_ms",
        "generation",
    },
    "controller_peer": {
        "schema_version",
        "project_id",
        "ticket",
        "expires_at_ms",
        "generation",
        "lineage_id",
    },
}
_DISCOVERY_SLOT_V2_FIELDS = {
    "bridge": {
        "schema_version",
        "slot",
        "project_id",
        "launch_id",
        "ticket",
        "expires_at_ms",
        "generation",
    },
    "controller_peer": {
        "schema_version",
        "slot",
        "project_id",
        "launch_id",
        "ticket",
        "expires_at_ms",
        "generation",
        "lineage_id",
    },
}


@dataclass(frozen=True)
class DiscoverySlot:
    """One atomically consumed bridge or controller-peer discovery credential."""

    runtime_directory: Path
    slot: str
    project_id: str
    launch_id: str
    ticket: str
    generation: int
    expires_at_ms: int
    lineage_id: str | None = None


def _runtime_user_directory() -> Path:
    configured = os.environ.get("XDG_RUNTIME_DIR")
    base = (
        Path(configured)
        if configured and Path(configured).is_absolute()
        else Path(tempfile.gettempdir())
    )
    getuid = getattr(os, "getuid", None)
    uid = getuid() if callable(getuid) else "user"
    return base / f"omb-{uid}"


def _valid_attach_ticket(ticket: object) -> bool:
    return (
        isinstance(ticket, str)
        and len(ticket) == 43
        and all(
            character.isascii() and (character.isalnum() or character in "_-")
            for character in ticket
        )
    )


def _read_attach_handoff(path: Path) -> tuple[dict[str, object], os.stat_result]:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ConnectionError(f"attach handoff is unavailable: {error}") from error
    if stat.S_ISLNK(metadata.st_mode):
        raise ConnectionError("attach handoff must not be a symlink")
    if not stat.S_ISREG(metadata.st_mode):
        raise ConnectionError("attach handoff must be a regular file")
    if not _owned_by_current_user(metadata):
        raise ConnectionError("attach handoff must be owned by the current user")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise ConnectionError("attach handoff must be private (mode 0600)")
    descriptor = -1
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ConnectionError("attach handoff changed during verification")
        with os.fdopen(descriptor, encoding="utf-8") as stream:
            descriptor = -1
            value = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ConnectionError(f"attach handoff is invalid: {error}") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if not isinstance(value, dict) or set(value) != _ATTACH_HANDOFF_FIELDS:
        raise ConnectionError("attach handoff fields are invalid")
    return value, metadata


def consume_attach_handoff(
    project_id: str,
    *,
    runtime_user_directory: str | PathLike[str] | None = None,
    now_ms: int | None = None,
) -> tuple[Path, str] | None:
    """Find and atomically consume a trusted, unexpired handoff for a project."""
    user_directory = (
        Path(runtime_user_directory)
        if runtime_user_directory is not None
        else _runtime_user_directory()
    )
    try:
        _verify_private_runtime_directory(user_directory)
        launches = tuple(user_directory.iterdir())
    except (ConnectionError, OSError):
        return None

    current_time = int(time.time() * 1000) if now_ms is None else now_ms
    for runtime_directory in sorted(launches, key=lambda path: path.name):
        try:
            _verify_private_runtime_directory(runtime_directory)
            handoff_path = runtime_directory / _ATTACH_HANDOFF_FILENAME
            value, metadata = _read_attach_handoff(handoff_path)
        except (ConnectionError, OSError):
            continue

        expires_at_ms = value.get("expires_at_ms")
        if (
            value.get("schema_version") != 1
            or not isinstance(value.get("project_id"), str)
            or not isinstance(expires_at_ms, int)
            or isinstance(expires_at_ms, bool)
            or not _valid_attach_ticket(value.get("ticket"))
        ):
            continue
        if expires_at_ms <= current_time:
            try:
                current = handoff_path.lstat()
                if (current.st_dev, current.st_ino) == (metadata.st_dev, metadata.st_ino):
                    handoff_path.unlink()
            except OSError:
                pass
            continue
        if value["project_id"] != project_id:
            continue

        try:
            current = handoff_path.lstat()
            if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
                continue
            handoff_path.unlink()
        except OSError:
            continue
        return runtime_directory, value["ticket"]
    return None

def _read_discovery_slot_file(
    path: Path, slot: str
) -> tuple[dict[str, object], os.stat_result]:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ConnectionError(f"{slot} discovery slot is unavailable: {error}") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ConnectionError(f"{slot} discovery slot must be a nonsymlink regular file")
    if not _owned_by_current_user(metadata):
        raise ConnectionError(f"{slot} discovery slot must be owned by the current user")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise ConnectionError(f"{slot} discovery slot must be private (mode 0600)")
    descriptor = -1
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ConnectionError(f"{slot} discovery slot changed during verification")
        with os.fdopen(descriptor, encoding="utf-8") as stream:
            descriptor = -1
            value = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ConnectionError(f"{slot} discovery slot is invalid: {error}") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if not isinstance(value, dict):
        raise ConnectionError(f"{slot} discovery slot must be an object")
    return value, metadata


def consume_discovery_slot(
    project_id: str,
    slot: str,
    *,
    runtime_user_directory: str | PathLike[str] | None = None,
    lineage_id: str | None = None,
    launch_id: str | None = None,
    now_ms: int | None = None,
) -> DiscoverySlot | None:
    """Atomically consume one exact independent discovery slot.

    Schema 1 is the currently deployed daemon file shape. Schema 2 is the
    frozen project/launch-bound shape; every version remains exact-key closed.
    """
    if slot not in _DISCOVERY_SLOT_FILENAMES:
        raise ConnectionError("discovery slot must be bridge or controller_peer")
    if slot == "bridge" and lineage_id is not None:
        raise ConnectionError("bridge discovery does not accept a lineage_id")
    user_directory = (
        Path(runtime_user_directory)
        if runtime_user_directory is not None
        else _runtime_user_directory()
    )
    try:
        _verify_private_runtime_directory(user_directory)
        launches = tuple(user_directory.iterdir())
    except (ConnectionError, OSError):
        return None

    current_time = int(time.time() * 1000) if now_ms is None else now_ms
    for runtime_directory in sorted(launches, key=lambda path: path.name):
        path = runtime_directory / _DISCOVERY_SLOT_FILENAMES[slot]
        try:
            _verify_private_runtime_directory(runtime_directory)
            endpoint = _read_runtime_endpoint(runtime_directory)
            value, metadata = _read_discovery_slot_file(path, slot)
        except (ConnectionError, OSError):
            continue
        schema_version = value.get("schema_version")
        expected_fields = (
            _DISCOVERY_SLOT_V1_FIELDS[slot]
            if schema_version == 1
            else _DISCOVERY_SLOT_V2_FIELDS[slot]
            if schema_version == 2
            else None
        )
        generation = value.get("generation")
        expires_at_ms = value.get("expires_at_ms")
        value_lineage = value.get("lineage_id")
        if (
            expected_fields is None
            or set(value) != expected_fields
            or value.get("project_id") != project_id
            or (launch_id is not None and endpoint["launch_id"] != launch_id)
            or not _valid_attach_ticket(value.get("ticket"))
            or isinstance(generation, bool)
            or not isinstance(generation, int)
            or not 1 <= generation <= 2_147_483_647
            or isinstance(expires_at_ms, bool)
            or not isinstance(expires_at_ms, int)
            or (slot == "controller_peer" and not isinstance(value_lineage, str))
            or (lineage_id is not None and value_lineage != lineage_id)
            or (
                schema_version == 2
                and (
                    value.get("slot") != slot
                    or value.get("launch_id") != endpoint["launch_id"]
                )
            )
        ):
            continue
        if expires_at_ms <= current_time:
            try:
                current = path.lstat()
                if (current.st_dev, current.st_ino) == (metadata.st_dev, metadata.st_ino):
                    path.unlink()
            except OSError:
                pass
            continue
        try:
            current = path.lstat()
            if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
                continue
            path.unlink()
        except OSError:
            continue
        return DiscoverySlot(
            runtime_directory=runtime_directory,
            slot=slot,
            project_id=project_id,
            launch_id=str(endpoint["launch_id"]),
            ticket=str(value["ticket"]),
            generation=generation,
            expires_at_ms=expires_at_ms,
            lineage_id=value_lineage if isinstance(value_lineage, str) else None,
        )
    return None


def connect_from_handoff(
    *,
    cwd: str | PathLike[str],
    project_id: str,
    addon_version: str,
    blender_version: str,
    runtime_user_directory: str | PathLike[str] | None = None,
) -> "Connection":
    """Consume a matching handoff before attempting its one-use daemon attach."""
    discovered = consume_attach_handoff(
        project_id, runtime_user_directory=runtime_user_directory
    )
    if discovered is None:
        raise ConnectionError(
            "No attach handoff found for this project; run the omb TUI first"
        )
    runtime_directory, ticket = discovered
    return connect(
        cwd=cwd,
        project_id=project_id,
        addon_version=addon_version,
        blender_version=blender_version,
        attach_runtime_directory=runtime_directory,
        attach_ticket=ticket,
    )


def _read_runtime_endpoint(
    runtime_directory: str | PathLike[str],
) -> dict[str, str | int]:
    directory = Path(runtime_directory)
    _verify_private_runtime_directory(directory.parent)
    _verify_private_runtime_directory(directory)
    endpoint_path = directory / "endpoint.json"
    try:
        metadata = endpoint_path.lstat()
    except OSError as error:
        raise ConnectionError(f"runtime endpoint is unavailable: {error}") from error
    if stat.S_ISLNK(metadata.st_mode):
        raise ConnectionError("runtime endpoint must not be a symlink")
    if not stat.S_ISREG(metadata.st_mode):
        raise ConnectionError("runtime endpoint must be a regular file")
    if not _owned_by_current_user(metadata):
        raise ConnectionError("runtime endpoint must be owned by the current user")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise ConnectionError("runtime endpoint must be private (mode 0600)")
    descriptor = -1
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(endpoint_path, flags)
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ConnectionError("runtime endpoint changed during verification")
        with os.fdopen(descriptor, encoding="utf-8") as stream:
            descriptor = -1
            endpoint = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ConnectionError(f"runtime endpoint is invalid: {error}") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    expected_fields = {"schema_version", "launch_id", "host", "port"}
    if not isinstance(endpoint, dict) or set(endpoint) != expected_fields:
        raise ConnectionError("runtime endpoint fields are invalid")
    launch_id = endpoint["launch_id"]
    try:
        parsed_launch_id = UUID(launch_id)
    except (AttributeError, TypeError, ValueError) as error:
        raise ConnectionError("runtime endpoint launch_id is invalid") from error
    if (
        parsed_launch_id.version != 4
        or str(parsed_launch_id) != launch_id
        or directory.name != launch_id
    ):
        raise ConnectionError("runtime endpoint launch_id does not match its directory")
    port = endpoint["port"]
    if (
        endpoint["schema_version"] != 1
        or endpoint["host"] != "127.0.0.1"
        or isinstance(port, bool)
        or not isinstance(port, int)
        or port < 1
        or port > 65535
    ):
        raise ConnectionError("runtime endpoint values are invalid")
    return endpoint


class Connection:
    """One owned daemon child or attached daemon bridge connection."""

    def __init__(
        self,
        child: DaemonChild | None,
        websocket: WebSocketClient,
        project_directory: str | PathLike[str] | None = None,
        *,
        tools_exposed: bool = True,
        identity: dict[str, str] | None = None,
        capabilities: frozenset[str] | None = None,
    ):
        self.child = child
        self.websocket = websocket
        self.state = LifecycleState.ACTIVE
        self.tools_exposed = tools_exposed
        self.identity = identity
        self.capabilities = (
            capabilities
            if capabilities is not None
            else frozenset({
                MUTATION_BRIDGE_CAPABILITY,
                SCENE_MANIFEST_V3_CAPABILITY,
            })
        )
        self.active_checkpoint: Checkpoint | None = None
        self._checkpoint_recovery: Callable[[], bool] | None = None
        self.durable_commit_reconciliation: dict | None = None
        self.task_status = TaskStatus()
        self._bridge_cancellations: dict[str, threading.Event] = {}
        self._terminal_bridge_ids: set[str] = set()
        self._reader_thread: threading.Thread | None = None
        self._response_queues: dict[str, queue.Queue] = {}
        self._cancel_ack_queues: dict[str, queue.Queue] = {}
        self._main_thread_messages: queue.Queue = queue.Queue()
        self.last_bridge_response: dict | None = None
        self._send_lock = threading.Lock()
        self._last_ping_at = time.monotonic()
        self.last_pong_nonce: str | None = None
        self._state_lock = threading.Lock()
        self.project_directory = (
            Path(project_directory) if project_directory is not None else None
        )
        self._auto_reconnect_options: dict[str, object] | None = None

    def begin_task(self, method: str, params: object) -> None:
        """Replace retained terminal evidence only when a real bridge task starts."""
        task_kind = _TASK_KINDS.get(method)
        if task_kind is None:
            raise ConnectionError("unsupported task status method")
        descriptor, total = _task_descriptor(method, params)
        self.task_status = TaskStatus(
            task_kind=task_kind,
            descriptor=descriptor,
            phase="dispatching",
            completed=0,
            total=total,
        )

    def update_task_progress(self, phase: str, completed: int, total: int) -> None:
        """Update progress using only closed phases and bounded integer counts."""
        if phase not in _TASK_PHASES:
            raise ConnectionError("unsupported task status phase")
        if (
            isinstance(completed, bool)
            or isinstance(total, bool)
            or not isinstance(completed, int)
            or not isinstance(total, int)
            or completed < 0
            or total < 0
            or completed > total
        ):
            raise ConnectionError("invalid task status progress")
        self.task_status = replace(
            self.task_status,
            phase=phase,
            completed=completed,
            total=total,
        )

    def finish_task(
        self,
        outcome: str,
        *,
        code: object = None,
        revision_id: object = None,
        frames: object = None,
    ) -> None:
        """Retain a terminal outcome with evidence derived from closed safe fields."""
        if outcome not in _TASK_OUTCOMES:
            raise ConnectionError("unsupported task status outcome")
        evidence = "No retained evidence"
        if outcome == "cancelled":
            evidence = "Cancellation accepted"
        elif outcome == "disconnected":
            evidence = "Connection disconnected"
        elif outcome == "recovery_required":
            evidence = "Recovery required"
        elif outcome == "recovered":
            evidence = self.task_status.evidence
        elif outcome == "error":
            safe_code = (
                code
                if isinstance(code, str)
                and code
                and len(code) <= 64
                and all(
                    character.isupper()
                    or character.isdigit()
                    or character == "_"
                    for character in code
                )
                else "UNKNOWN"
            )
            evidence = f"Error code: {safe_code}"
        elif self.task_status.task_kind == "camera_plan":
            evidence = f"Revision sha256:{_digest_prefix(revision_id)}"
        elif self.task_status.task_kind == "qa_render":
            safe_frames = frames if isinstance(frames, list) else []
            summaries = []
            for frame in safe_frames:
                if not isinstance(frame, dict):
                    continue
                number = frame.get("frame")
                if isinstance(number, int) and not isinstance(number, bool):
                    summaries.append(
                        f"{number}:sha256:{_digest_prefix(frame.get('sha256'))}"
                    )
            evidence = (
                "Frames " + ", ".join(summaries)
                if summaries
                else "No retained evidence"
            )
        terminal_phase = {
            "disconnected": "disconnected",
            "recovery_required": "recovery_required",
            "recovered": "recovered",
        }.get(outcome, self.task_status.phase)
        self.task_status = replace(
            self.task_status,
            phase=terminal_phase,
            outcome=outcome,
            evidence=evidence,
        )

    def _finish_in_flight_for_lifecycle(self, outcome: str) -> None:
        if self.task_status.outcome is None:
            self.finish_task(outcome)

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
        self._finish_in_flight_for_lifecycle("recovery_required")

    def _mark_lost_if_active(self) -> None:
        """Record reader failure without replacing a main-thread terminal state."""
        with self._state_lock:
            if self.state == LifecycleState.ACTIVE:
                self.state = LifecycleState.LOST

    def _durable_project_base(
        self,
        expected_revision_id: str,
        *,
        allow_bootstrap: bool = False,
    ) -> tuple[str, str]:
        if self.project_directory is None:
            raise ConnectionError("durable project directory is unavailable")
        try:
            project = json.loads(
                (self.project_directory / ".omb/project.json").read_text(
                    encoding="utf-8"
                )
            )
            revision_id = project["current_revision_id"]
            scene_hash = project["manifest"]["sceneHash"]
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as error:
            raise ConnectionError(f"durable project manifest is unavailable: {error}") from error
        if (
            revision_id != expected_revision_id
            and not (
                allow_bootstrap
                and expected_revision_id == _BOOTSTRAP_REVISION_ID
            )
        ):
            raise StaleBridgeBase(
                "durable project revision does not match the bridge request"
            )
        for name, value in (
            ("revision", revision_id),
            ("scene hash", scene_hash),
        ):
            if (
                not isinstance(value, str)
                or len(value) != 64
                or any(character not in "0123456789abcdef" for character in value)
            ):
                raise ConnectionError(f"durable project {name} is invalid")
        return revision_id, scene_hash

    def _durable_scene_hash(self, expected_revision_id: str) -> str:
        return self._durable_project_base(expected_revision_id)[1]

    def _inspect_project_result(
        self,
        revision_id: str,
        current_scene_hash: str,
    ) -> dict:
        from .manifest import (
            extract_scene_manifest_v2,
            extract_scene_manifest_v3,
            extract_scene_snapshot,
        )

        live_manifest = extract_scene_manifest_v2()
        if live_manifest["sceneHash"] != current_scene_hash:
            live_manifest = extract_scene_manifest_v3()
        if live_manifest["sceneHash"] != current_scene_hash:
            raise StaleBridgeBase(
                "live Blender scene does not match the durable project substrate"
            )
        return {
            "revision": revision_id,
            "snapshot": extract_scene_snapshot(),
        }

    def hold_checkpoint(
        self,
        checkpoint: Checkpoint,
        recovery_fn: Callable[[], bool] | None = None,
    ) -> None:
        """Retain the sole in-flight mutation checkpoint and optional recovery."""
        if self.active_checkpoint is not None:
            raise ConnectionError("a mutation checkpoint is already active")
        self.active_checkpoint = checkpoint
        self._checkpoint_recovery = recovery_fn

    def release_checkpoint(self) -> Checkpoint | None:
        """Clear and return the in-flight mutation checkpoint, if any."""
        checkpoint = self.active_checkpoint
        self.active_checkpoint = None
        self._checkpoint_recovery = None
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
        now = time.monotonic()
        if (
            self.state == LifecycleState.ACTIVE
            and now - self._last_ping_at >= 20.0
        ):
            try:
                self._send_json({
                    "type": "ping",
                    "nonce": secrets.token_urlsafe(16),
                })
            except (OSError, WebSocketError):
                self._mark_lost_if_active()
            else:
                self._last_ping_at = now
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
                    if self._checkpoint_recovery is not None:
                        try:
                            restored = self._checkpoint_recovery()
                        except BaseException:
                            restored = False
                        finally:
                            self.active_checkpoint = None
                            self._checkpoint_recovery = None
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
            self._finish_in_flight_for_lifecycle(
                "recovery_required"
                if self.state == LifecycleState.RECOVERY_REQUIRED
                else "disconnected"
            )
        if self.state != LifecycleState.ACTIVE:
            if not self.websocket.closed:
                try:
                    self.websocket.close()
                except (OSError, WebSocketError):
                    pass
            if self._reader_thread is not None and self._reader_thread.is_alive():
                self._reader_thread.join(timeout=0.2)
            _begin_bridge_auto_reconnect(self)
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
                if message.get("type") == "pong":
                    nonce = message.get("nonce")
                    if isinstance(nonce, str):
                        self.last_pong_nonce = nonce
                    response_queue = None
                elif message.get("type") == "cancel_ack":
                    response_queue = self._cancel_ack_queues.get(message.get("id"))
                elif message.get("type") in (
                    "response",
                    "error",
                    "bridge_transaction_ack",
                    "bridge_transaction_error",
                    "bridge_transaction_status",
                ):
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
            if status == "accepted":
                self.finish_task("cancelled")
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
        if message.get("method") not in (
            "inspect_project",
            "apply_camera_plan",
            "stage_scene",
            "render_qa_frames",
        ):
            self._send_bridge_error(
                message,
                "METHOD_NOT_SUPPORTED",
                f"unsupported bridge method: {message.get('method')}",
            )
            return
        if (
            message.get("method") == "stage_scene"
            and SCENE_MANIFEST_V3_CAPABILITY not in self.capabilities
        ):
            self._send_bridge_error(
                message,
                "CAPABILITY_NOT_NEGOTIATED",
                "stage_scene requires negotiated scene_manifest_v3 capability",
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
            durable_revision_id = message["expected_revision_id"]
            if message["method"] == "inspect_project":
                durable_revision_id, durable_scene_hash = self._durable_project_base(
                    message["expected_revision_id"],
                    allow_bootstrap=True,
                )
                if current_scene_hash is None:
                    current_scene_hash = durable_scene_hash
            elif current_scene_hash is None:
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
        if message["method"] != "inspect_project":
            self.begin_task(message["method"], message["params"])
        if bpy is None:
            self.finish_bridge(bridge_id)
            if message["method"] != "inspect_project":
                self.finish_task("error", code="BLENDER_UNAVAILABLE")
            self._send_bridge_error(
                message,
                "BLENDER_UNAVAILABLE",
                "bridge dispatch requires Blender",
            )
            return
        if message["method"] == "inspect_project":
            try:
                result = self._inspect_project_result(
                    durable_revision_id,
                    current_scene_hash,
                )
                self._send_json({
                    "type": "bridge_result",
                    "id": bridge_id,
                    "request_id": message["request_id"],
                    "result": result,
                })
            except BaseException as error:
                self._send_bridge_error(
                    message,
                    getattr(error, "code", type(error).__name__),
                    str(error),
                )
            finally:
                self.finish_bridge(bridge_id)
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
            elif message["method"] == "stage_scene":
                bpy.ops.omb.stage_scene(
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
            self.finish_task(
                "error",
                code=getattr(error, "code", type(error).__name__),
            )
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
            self._checkpoint_recovery = None

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
            self.finish_task("success", revision_id=candidate_revision_id)
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
        self.finish_task(
            "success",
            revision_id=message.get("resulting_revision_id"),
        )
        return message

    def _child_has_exited(self) -> bool:
        if self.child is None:
            return False
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

    def reconcile_prepared_transaction(
        self,
        *,
        canonical_blend_path: str | PathLike[str],
        read_blend_project_id: Callable[[Path], str],
        read_blend_scene_hash: Callable[[Path], str],
        reload_blend: Callable[[Path], object],
        expose_tools: bool = True,
        deadline: float | None = None,
    ) -> dict | None:
        """Resolve durable startup evidence before exposing mutation tools."""

        from .prepared_transaction import (
            PreparedTransactionError,
            advance_marker,
            cleanup_transaction,
            marker_path,
            read_marker,
            recover_candidate_authority,
            restore_base_backup,
        )

        if self.project_directory is None:
            raise ConnectionError("prepared transaction requires a project directory")
        marker_file = marker_path(self.project_directory)
        if not marker_file.exists():
            if expose_tools:
                self.expose_tools()
            return None
        self.tools_exposed = False
        if TRANSACTION_COMMIT_CAPABILITY not in self.capabilities:
            self.require_recovery()
            raise DurableCommitReconciliationRequired(
                "transaction recovery capability is unavailable"
            )
        try:
            marker = read_marker(
                self.project_directory,
                canonical_blend_path=canonical_blend_path,
            )
        except PreparedTransactionError as error:
            self.require_recovery()
            raise DurableCommitReconciliationRequired(
                "prepared transaction recovery marker is invalid"
            ) from error
        reconcile_id = str(uuid4())
        response_queue = None
        if self._reader_thread is not None and self._reader_thread.is_alive():
            response_queue = queue.Queue(maxsize=1)
            self._response_queues[reconcile_id] = response_queue
        try:
            self._send_json({
                "type": "bridge_transaction_reconcile",
                "id": reconcile_id,
                "project_id": marker.project_id,
                "transaction_id": marker.transaction_id,
                "marker_phase": marker.phase,
            })
            while True:
                remaining = None
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("transaction reconciliation timed out")
                message = (
                    response_queue.get(timeout=remaining)
                    if response_queue is not None
                    else self.websocket.recv_json()
                )
                if not isinstance(message, dict) or message.get("id") != reconcile_id:
                    continue
                if message.get("type") == "bridge_transaction_error":
                    raise DurableCommitReconciliationRequired(
                        f"{message.get('code', 'TRANSACTION_EVIDENCE_INVALID')}: "
                        "transaction recovery requires operator intervention"
                    )
                if set(message) != {
                    "type",
                    "id",
                    "transaction_id",
                    "status",
                    "revision_id",
                } or message.get("type") != "bridge_transaction_status":
                    raise PreparedTransactionError(
                        "transaction reconciliation response is invalid"
                    )
                if message.get("transaction_id") != marker.transaction_id:
                    raise PreparedTransactionError(
                        "transaction reconciliation id does not match marker"
                    )
                status = message.get("status")
                revision_id = message.get("revision_id")
                if status == "unknown":
                    raise DurableCommitReconciliationRequired(
                        "transaction authority is unknown"
                    )
                if status == "base_authoritative":
                    if revision_id != marker.base_revision_id:
                        raise PreparedTransactionError(
                            "base-authoritative revision does not match marker"
                        )
                    marker = restore_base_backup(
                        self.project_directory,
                        marker,
                        read_blend_project_id=read_blend_project_id,
                    )
                    reload_blend(Path(marker.canonical_blend_path))
                    if (
                        read_blend_project_id(Path(marker.canonical_blend_path))
                        != marker.project_id
                        or read_blend_scene_hash(Path(marker.canonical_blend_path))
                        != marker.base_scene_hash
                    ):
                        raise PreparedTransactionError(
                            "restored base blend does not match marker authority"
                        )
                elif status == "candidate_authoritative":
                    if revision_id != marker.candidate_revision_id:
                        raise PreparedTransactionError(
                            "candidate-authoritative revision does not match marker"
                        )
                    marker = recover_candidate_authority(
                        self.project_directory,
                        marker,
                        read_blend_project_id=read_blend_project_id,
                        read_blend_scene_hash=read_blend_scene_hash,
                    )
                    if marker.phase == "candidate_saved":
                        marker = advance_marker(
                            self.project_directory, marker, "manifest_committed"
                        )
                    if marker.phase == "manifest_committed":
                        marker = advance_marker(
                            self.project_directory, marker, "acknowledged"
                        )
                    self._send_json({
                        "type": "bridge_transaction_acknowledged",
                        "id": reconcile_id,
                        "transaction_id": marker.transaction_id,
                    })
                else:
                    raise PreparedTransactionError(
                        "transaction reconciliation status is invalid"
                    )
                cleanup_transaction(
                    self.project_directory,
                    marker,
                    read_blend_project_id=read_blend_project_id,
                )
                self.durable_commit_reconciliation = {
                    "transaction_id": marker.transaction_id,
                    "base_revision_id": marker.base_revision_id,
                    "candidate_revision_id": marker.candidate_revision_id,
                    "marker_phase": marker.phase,
                    "outcome": "recovered",
                }
                if expose_tools:
                    self.expose_tools()
                return message
        except DurableCommitReconciliationRequired:
            self.require_recovery()
            raise
        except (OSError, PreparedTransactionError, queue.Empty, TimeoutError, WebSocketError) as error:
            self.require_recovery()
            raise DurableCommitReconciliationRequired(
                "prepared transaction recovery evidence is invalid"
            ) from error
        finally:
            self._response_queues.pop(reconcile_id, None)
    def commit_prepared_transaction(
        self,
        *,
        bridge_id: str,
        request_id: str,
        transaction_id: str,
        operation: str,
        project_id: str,
        base_revision_id: str,
        base_scene_hash: str,
        candidate_revision_id: str,
        candidate_scene_hash: str,
        canonical_blend_path: str | PathLike[str],
        result: dict,
        save_blend: Callable[[Path], object],
        read_blend_project_id: Callable[[Path], str],
        deadline: float | None = None,
    ) -> dict:
        """Persist a candidate blend and complete the negotiated v2 commit handshake."""
        from .prepared_transaction import (
            PreparedTransactionError,
            advance_marker,
            cleanup_transaction,
            prepare_transaction,
            save_candidate,
        )

        if TRANSACTION_COMMIT_CAPABILITY not in self.capabilities:
            raise ConnectionError(
                "CAPABILITY_NOT_NEGOTIATED: transaction_commit_v2 is required"
            )
        if self.project_directory is None:
            raise ConnectionError("prepared transaction requires a project directory")
        marker = prepare_transaction(
            project_root=self.project_directory,
            transaction_id=transaction_id,
            project_id=project_id,
            operation=operation,
            request_id=request_id,
            base_revision_id=base_revision_id,
            base_scene_hash=base_scene_hash,
            candidate_revision_id=candidate_revision_id,
            candidate_scene_hash=candidate_scene_hash,
            canonical_blend_path=canonical_blend_path,
            read_blend_project_id=read_blend_project_id,
        )
        marker = save_candidate(
            self.project_directory,
            marker,
            save_blend=save_blend,
            read_blend_project_id=read_blend_project_id,
        )
        assert marker.canonical_blend_sha256 is not None
        prepared = {
            "type": "bridge_transaction_prepared",
            "id": bridge_id,
            "transaction_id": transaction_id,
            "operation": operation,
            "project_id": project_id,
            "base_revision_id": base_revision_id,
            "base_scene_hash": base_scene_hash,
            "candidate_revision_id": candidate_revision_id,
            "candidate_scene_hash": candidate_scene_hash,
            "base_backup_sha256": marker.base_backup_sha256,
            "canonical_blend_sha256": marker.canonical_blend_sha256,
        }
        self.durable_commit_reconciliation = {
            "bridge_id": bridge_id,
            "request_id": request_id,
            "transaction_id": transaction_id,
            "base_revision_id": base_revision_id,
            "candidate_revision_id": candidate_revision_id,
            "marker_phase": marker.phase,
            "outcome": "awaiting_ack",
        }
        response_queue = None
        if self._reader_thread is not None and self._reader_thread.is_alive():
            response_queue = queue.Queue(maxsize=1)
            self._response_queues[bridge_id] = response_queue
        try:
            self._send_json(prepared)
            self._send_json({
                "type": "bridge_result",
                "id": bridge_id,
                "request_id": request_id,
                "result": result,
            })
            while True:
                remaining = None
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("transaction commit acknowledgement timed out")
                message = (
                    response_queue.get(timeout=remaining)
                    if response_queue is not None
                    else self.websocket.recv_json()
                )
                if not isinstance(message, dict) or message.get("id") != bridge_id:
                    continue
                if message.get("type") == "bridge_transaction_error":
                    code = message.get("code", "TRANSACTION_EVIDENCE_INVALID")
                    self.durable_commit_reconciliation["outcome"] = "recovery_required"
                    self.require_recovery()
                    raise DurableCommitReconciliationRequired(
                        f"{code}: prepared transaction requires reconciliation"
                    )
                if message.get("type") != "bridge_transaction_ack":
                    continue
                if set(message) != {
                    "type",
                    "id",
                    "transaction_id",
                    "status",
                    "resulting_revision_id",
                }:
                    raise ConnectionError("bridge transaction ack fields are invalid")
                if (
                    message.get("transaction_id") != transaction_id
                    or message.get("status") != "committed"
                    or message.get("resulting_revision_id") != candidate_revision_id
                ):
                    raise ConnectionError("bridge transaction ack values are invalid")
                marker = advance_marker(
                    self.project_directory, marker, "manifest_committed"
                )
                marker = advance_marker(
                    self.project_directory, marker, "acknowledged"
                )
                self._send_json({
                    "type": "bridge_transaction_acknowledged",
                    "id": bridge_id,
                    "transaction_id": transaction_id,
                })
                cleanup_transaction(
                    self.project_directory,
                    marker,
                    read_blend_project_id=read_blend_project_id,
                )
                self.durable_commit_reconciliation["marker_phase"] = "acknowledged"
                self.durable_commit_reconciliation["outcome"] = "committed"
                return message
        except DurableCommitReconciliationRequired:
            raise
        except (OSError, queue.Empty, StopIteration, TimeoutError, WebSocketError) as error:
            self.durable_commit_reconciliation["outcome"] = "in_doubt"
            raise DurableCommitReconciliationRequired(
                "prepared transaction durable outcome requires reconciliation"
            ) from error
        except PreparedTransactionError:
            self.require_recovery()
            raise
        finally:
            self._response_queues.pop(bridge_id, None)
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
        self.update_task_progress("durable_commit", 1, 1)
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
                capabilities=frozenset(ack["capabilities"]),
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

    @classmethod
    def attach(
        cls,
        runtime_directory: str | PathLike[str],
        attach_ticket: str,
        *,
        cwd: str | PathLike[str],
        project_id: str,
        addon_version: str,
        blender_version: str,
        websocket_type: type[WebSocketClient] = WebSocketClient,
        expose_tools: bool = True,
    ) -> "Connection":
        """Discover and authenticate an existing daemon as its Blender bridge."""
        endpoint = _read_runtime_endpoint(runtime_directory)
        if (
            not isinstance(attach_ticket, str)
            or len(attach_ticket) != 43
            or any(
                not (
                    character.isascii()
                    and (character.isalnum() or character in "_-")
                )
                for character in attach_ticket
            )
        ):
            raise ConnectionError("attach ticket must be a 32-byte base64url credential")
        websocket = None
        ticket_fingerprint = hashlib.sha256(
            attach_ticket.encode("ascii")
        ).hexdigest()
        try:
            websocket = websocket_type.connect(
                endpoint["port"],
                attach_ticket,
                timeout=3.0,
                role="bridge",
            )
            attach_ticket = ""
            if hasattr(websocket, "socket"):
                websocket.socket.settimeout(3.0)
            hello = build_hello(project_id, addon_version, blender_version)
            websocket.send_json(hello)
            try:
                ack = validate_hello_ack(websocket.recv_json())
            except HandshakeError as exc:
                raise ConnectionError(str(exc)) from exc
            if ack["launch_id"] != endpoint["launch_id"]:
                raise ConnectionError(
                    "hello_ack launch_id does not match runtime advertisement"
                )
            connection = cls(
                None,
                websocket,
                project_directory=cwd,
                tools_exposed=expose_tools,
                capabilities=frozenset(ack["capabilities"]),
                identity={
                    "launch_id": endpoint["launch_id"],
                    "attach_ticket_fingerprint": ticket_fingerprint,
                    "attach_mode": "ticket",
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
            raise

    def disconnect(self, reason: str, timeout: float = 8.0) -> None:
        """Drain the daemon, then force-kill only if its exit exceeds the bound."""
        if self.state == LifecycleState.STOPPED:
            return
        self.state = LifecycleState.DRAINING
        self._finish_in_flight_for_lifecycle("disconnected")
        if bpy is not None and bpy.app.timers.is_registered(self.pump_bridge_messages):
            bpy.app.timers.unregister(self.pump_bridge_messages)
        deadline = time.monotonic() + timeout
        if self._reader_thread is not None and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=min(0.2, timeout))
        if self.child is None:
            if not self.websocket.closed:
                try:
                    self.websocket.close()
                except (OSError, WebSocketError):
                    pass
        elif not self.websocket.closed:
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
        if self.child is not None:
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
    if previous_connection.child is None:
        previous_connection.disconnect("restart_after_unexpected_loss")
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
    live_scene_hash_fn: Callable[[str], str],
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
        verify_reconnect_hash(
            live_scene_hash_fn(expected_scene_hash),
            expected_scene_hash,
        )
        _reconcile_connected_transaction(connection, cwd)
        if (
            previous_connection is not None
            and isinstance(previous_connection.task_status, TaskStatus)
            and previous_connection.task_status.task_kind is not None
        ):
            connection.task_status = replace(
                previous_connection.task_status,
                phase="recovered",
                outcome="recovered",
            )
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
@dataclass
class _BridgeReconnectPlan:
    source: Connection
    child: DaemonChild | None
    options: dict[str, object]
    started_at: float
    next_attempt_at: float
    attempt: int = 0
    source_released: bool = False


_bridge_reconnect_plan: _BridgeReconnectPlan | None = None
_BRIDGE_RECONNECT_DELAYS = (0.25, 0.5, 1.0, 2.0, 4.0)
_BRIDGE_RECONNECT_CEILING = 5.0
_BRIDGE_RECONNECT_WINDOW = 60.0
_BRIDGE_MANUAL_POLL_DELAY = 10.0


def _bridge_production_jitter(delay: float) -> float:
    return delay * ((secrets.randbelow(401) - 200) / 1000)


def configure_bridge_auto_reconnect(
    connection: Connection,
    *,
    cwd: str | PathLike[str],
    project_id: str,
    addon_version: str,
    blender_version: str,
    runtime_user_directory: str | PathLike[str] | None = None,
    live_scene_hash_fn: Callable[[str], str] | None = None,
    jitter: Callable[[float], float] = _bridge_production_jitter,
    websocket_type: type[WebSocketClient] = WebSocketClient,
) -> None:
    """Retain only noncredential inputs needed to consume reissued bridge slots."""
    connection._auto_reconnect_options = {
        "cwd": Path(cwd),
        "project_id": project_id,
        "addon_version": addon_version,
        "blender_version": blender_version,
        "runtime_user_directory": Path(runtime_user_directory)
        if runtime_user_directory is not None
        else None,
        "live_scene_hash_fn": live_scene_hash_fn or _live_scene_hash,
        "jitter": jitter,
        "websocket_type": websocket_type,
    }


def _begin_bridge_auto_reconnect(connection: Connection) -> None:
    global _bridge_reconnect_plan
    if connection._auto_reconnect_options is None:
        return
    if (
        _bridge_reconnect_plan is not None
        and _bridge_reconnect_plan.source is connection
    ):
        return
    now = time.monotonic()
    jitter = connection._auto_reconnect_options["jitter"]
    assert callable(jitter)
    delay = _BRIDGE_RECONNECT_DELAYS[0]
    _bridge_reconnect_plan = _BridgeReconnectPlan(
        source=connection,
        child=connection.child,
        options=connection._auto_reconnect_options,
        started_at=now,
        next_attempt_at=now + delay + jitter(delay),
    )


def _schedule_bridge_retry(plan: _BridgeReconnectPlan, now: float) -> None:
    plan.attempt += 1
    elapsed = now - plan.started_at
    jitter = plan.options["jitter"]
    assert callable(jitter)
    if elapsed >= _BRIDGE_RECONNECT_WINDOW:
        delay = _BRIDGE_MANUAL_POLL_DELAY
    else:
        delay = (
            _BRIDGE_RECONNECT_DELAYS[plan.attempt]
            if plan.attempt < len(_BRIDGE_RECONNECT_DELAYS)
            else _BRIDGE_RECONNECT_CEILING
        )
        delay += jitter(delay)
    plan.next_attempt_at = now + max(0.0, delay)


def poll_active_bridge_reconnect(
    *, force: bool = False, now: float | None = None
) -> bool:
    """Consume one reissued bridge generation when its reconnect attempt is due."""
    global _active_connection, _bridge_reconnect_plan
    plan = _bridge_reconnect_plan
    if plan is None:
        return False
    current = time.monotonic() if now is None else now
    if not force and current < plan.next_attempt_at:
        return False
    options = plan.options
    identity = plan.source.identity if isinstance(plan.source.identity, dict) else {}
    slot = consume_discovery_slot(
        str(options["project_id"]),
        "bridge",
        runtime_user_directory=options["runtime_user_directory"],
        launch_id=identity.get("launch_id"),
    )
    if slot is None:
        _schedule_bridge_retry(plan, current)
        return False

    replacement: Connection | None = None
    try:
        expected_scene_hash = _read_reconnect_scene_hash(options["cwd"])
        if not plan.source_released:
            if plan.child is not None:
                plan.source.child = None
            plan.source.disconnect("reattach_after_unexpected_loss", timeout=0.2)
            plan.source_released = True
        websocket_type = options["websocket_type"]
        assert isinstance(websocket_type, type)
        replacement = Connection.attach(
            slot.runtime_directory,
            slot.ticket,
            cwd=options["cwd"],
            project_id=str(options["project_id"]),
            addon_version=str(options["addon_version"]),
            blender_version=str(options["blender_version"]),
            websocket_type=websocket_type,
            expose_tools=False,
        )
        live_scene_hash_fn = options["live_scene_hash_fn"]
        assert callable(live_scene_hash_fn)
        verify_reconnect_hash(
            live_scene_hash_fn(expected_scene_hash), expected_scene_hash
        )
        _reconcile_connected_transaction(replacement, options["cwd"])
        replacement.child = plan.child
        if plan.source.task_status.task_kind is not None:
            replacement.task_status = replace(
                plan.source.task_status,
                phase="recovered",
                outcome="recovered",
            )
        replacement._auto_reconnect_options = options
        _active_connection = replacement
        _bridge_reconnect_plan = None
        return True
    except Exception:
        if replacement is not None:
            replacement.child = None
            replacement.disconnect("reattach_failed", timeout=0.2)
        _schedule_bridge_retry(plan, current)
        return False


def pump_connection_lifecycle() -> float:
    """Blender timer callback for automatic bridge slot consumption."""
    poll_active_bridge_reconnect()
    return 0.1


_DAEMON_ARGS_ENV = "OMB_DAEMON_ARGS"
_DAEMON_EXECUTABLE_ENV = "OMB_DAEMON_EXECUTABLE"
_NODE_EXECUTABLE_ENV = "OMB_NODE_EXECUTABLE"


def _verified_executable(configured: str) -> str:
    try:
        return verify_executable(configured)
    except UnsafeExecutableError as error:
        raise ConnectionError(str(error)) from error


def _resolve_daemon_args(daemon_args: Sequence[str] | None) -> tuple[str, ...]:
    if daemon_args is None:
        configured = os.environ.get(_DAEMON_ARGS_ENV)
        if configured is None:
            raise ConnectionError(
                "NOT_CONFIGURED: no daemon launch mode is configured; set the "
                f"{_DAEMON_ARGS_ENV} environment variable (or pass daemon_args "
                "explicitly) to '--faux' or explicit '--provider <id> --model <id>'"
            )
        daemon_args = tuple(shlex.split(configured))
    resolved = tuple(daemon_args)
    if resolved == ("--faux",):
        return resolved

    parsed: dict[str, str] = {}
    index = 0
    while index < len(resolved):
        flag = resolved[index]
        if (
            flag not in ("--provider", "--model")
            or flag in parsed
            or index + 1 >= len(resolved)
            or not resolved[index + 1]
            or resolved[index + 1].startswith("--")
        ):
            raise ConnectionError(
                "INVALID_ARGUMENT: unsupported daemon arguments; credentials "
                "must be supplied only through the provider environment variable"
            )
        parsed[flag] = resolved[index + 1]
        index += 2
    if set(parsed) != {"--provider", "--model"}:
        raise ConnectionError(
            "NOT_CONFIGURED: explicit --provider <id> and --model <id> are required"
        )
    return resolved


def _resolve_installed_daemon_argv(
    configured_executable: str, daemon_args: tuple[str, ...]
) -> tuple[str, ...]:
    executable = _verified_executable(configured_executable)
    return (executable, "--port", "0", *daemon_args)


def _resolve_development_daemon_argv(
    configured_node: str, daemon_args: tuple[str, ...]
) -> tuple[str, ...]:
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
    node_executable = _verified_executable(configured_node)
    return (
        node_executable,
        "--import",
        str(tsx_loader),
        daemon_main,
        "--port",
        "0",
        *daemon_args,
    )


def _resolve_daemon_argv(daemon_args: Sequence[str] | None) -> tuple[str, ...]:
    """Resolve one explicit launch mode with a safety-verified executable."""
    configured_daemon = os.environ.get(_DAEMON_EXECUTABLE_ENV)
    configured_node = os.environ.get(_NODE_EXECUTABLE_ENV)
    if configured_daemon is not None and configured_node is not None:
        raise ConnectionError(
            "INVALID_ARGUMENT: both OMB_DAEMON_EXECUTABLE and "
            "OMB_NODE_EXECUTABLE are set; configure exactly one"
        )
    if configured_daemon is None and configured_node is None:
        raise ConnectionError(
            "NOT_CONFIGURED: set OMB_DAEMON_EXECUTABLE for an installed daemon "
            "or OMB_NODE_EXECUTABLE for repository development"
        )

    resolved_args = _resolve_daemon_args(daemon_args)
    if configured_daemon is not None:
        return _resolve_installed_daemon_argv(configured_daemon, resolved_args)
    assert configured_node is not None
    return _resolve_development_daemon_argv(configured_node, resolved_args)


def _live_scene_hash(current_scene_hash: str) -> str:
    from .manifest import extract_scene_manifest_v2, extract_scene_manifest_v3

    v2_hash = extract_scene_manifest_v2()["sceneHash"]
    if v2_hash == current_scene_hash:
        return v2_hash
    return extract_scene_manifest_v3()["sceneHash"]
def _reconcile_connected_transaction(
    bridge: Connection,
    cwd: str | PathLike[str],
) -> None:
    """Keep tools hidden until any durable marker reaches one authority."""

    marker_file = Path(cwd) / ".omb" / "prepared-transaction.json"
    if not marker_file.exists():
        if not bridge.tools_exposed:
            bridge.expose_tools()
        return
    bridge.tools_exposed = False
    if bpy is None:
        bridge.require_recovery()
        raise DurableCommitReconciliationRequired(
            "Blender is required to reconcile a prepared transaction"
        )
    from .manifest import extract_scene_manifest_v2, extract_scene_manifest_v3
    from .prepared_transaction import PreparedTransactionError, read_marker

    canonical = Path(bpy.data.filepath)
    try:
        marker = read_marker(cwd, canonical_blend_path=canonical)
    except PreparedTransactionError as error:
        bridge.require_recovery()
        raise DurableCommitReconciliationRequired(
            "prepared transaction recovery marker is invalid"
        ) from error

    def read_project_id(_path: Path) -> str:
        project_id = bpy.context.scene.get("omb.project_id")
        if not isinstance(project_id, str):
            raise PreparedTransactionError("blend project id is unavailable")
        return project_id

    def read_scene_hash(_path: Path) -> str:
        v2_hash = extract_scene_manifest_v2()["sceneHash"]
        if v2_hash in (marker.base_scene_hash, marker.candidate_scene_hash):
            return v2_hash
        v3_hash = extract_scene_manifest_v3()["sceneHash"]
        if v3_hash in (marker.base_scene_hash, marker.candidate_scene_hash):
            return v3_hash
        return v3_hash

    bridge.reconcile_prepared_transaction(
        canonical_blend_path=canonical,
        read_blend_project_id=read_project_id,
        read_blend_scene_hash=read_scene_hash,
        reload_blend=lambda path: bpy.ops.wm.open_mainfile(filepath=str(path)),
        expose_tools=True,
        deadline=time.monotonic() + 3.0,
    )



def connect_addon_spawned(
    *,
    cwd: str | PathLike[str],
    project_id: str,
    addon_version: str,
    blender_version: str,
    daemon_args: Sequence[str] | None = None,
    child_type: type[DaemonChild] = DaemonChild,
    websocket_type: type[WebSocketClient] = WebSocketClient,
) -> Connection:
    """Spawn one daemon with an owner controller and independent bridge slot."""
    global _active_connection
    from . import controller_connection

    if _active_connection is not None and _active_connection.state not in (
        LifecycleState.STOPPED,
        *RECONNECTABLE_STATES,
    ):
        raise ConnectionError("the add-on already owns an active daemon connection")
    if _active_connection is not None:
        disconnect_active("client_exit")

    child = child_type.spawn(_resolve_daemon_argv(daemon_args), cwd=cwd)
    owner = None
    bridge = None
    try:
        record = child.read_startup_record()
        runtime_directory = _runtime_user_directory() / record["launch_id"]
        owner = controller_connection.ControllerConnection.connect_owner(
            port=record["port"],
            boot_token=record["bearer_token"],
            launch_id=record["launch_id"],
            project_id=project_id,
            addon_version=addon_version,
            blender_version=blender_version,
            runtime_directory=runtime_directory,
            websocket_type=websocket_type,
            start_reader=False,
        )
        record["bearer_token"] = ""
        owner.publish_bridge_slot()
        slot = consume_discovery_slot(
            project_id,
            "bridge",
            runtime_user_directory=runtime_directory.parent,
            launch_id=record["launch_id"],
        )
        if slot is None:
            raise ConnectionError("daemon did not publish the requested bridge slot")
        bridge = Connection.attach(
            slot.runtime_directory,
            slot.ticket,
            cwd=cwd,
            project_id=project_id,
            addon_version=addon_version,
            blender_version=blender_version,
            websocket_type=websocket_type,
            expose_tools=False,
        )
        bridge.child = child
        _reconcile_connected_transaction(bridge, cwd)
        configure_bridge_auto_reconnect(
            bridge,
            cwd=cwd,
            project_id=project_id,
            addon_version=addon_version,
            blender_version=blender_version,
            runtime_user_directory=runtime_directory.parent,
            websocket_type=websocket_type,
        )
        owner.start_reader()
        controller_connection.set_active_controller(owner)
        _active_connection = bridge
        return bridge
    except Exception:
        if bridge is not None:
            bridge.child = None
            bridge.disconnect("addon_spawn_failed", timeout=0.2)
        if owner is not None:
            owner.close()
        child.kill()
        raise


def connect_tui_spawned(
    *,
    cwd: str | PathLike[str],
    project_id: str,
    addon_version: str,
    blender_version: str,
    runtime_user_directory: str | PathLike[str] | None = None,
    websocket_type: type[WebSocketClient] = WebSocketClient,
) -> Connection:
    """Consume TUI-published bridge and peer slots independently."""
    from . import controller_connection

    slot = consume_discovery_slot(
        project_id,
        "bridge",
        runtime_user_directory=runtime_user_directory,
    )
    if slot is not None:
        bridge = connect(
            cwd=cwd,
            project_id=project_id,
            addon_version=addon_version,
            blender_version=blender_version,
            attach_runtime_directory=slot.runtime_directory,
            attach_ticket=slot.ticket,
        )
    else:
        discovered = consume_attach_handoff(
            project_id, runtime_user_directory=runtime_user_directory
        )
        if discovered is None:
            raise ConnectionError(
                "No bridge discovery slot found for this project; run the omb TUI first"
            )
        runtime_directory, ticket = discovered
        bridge = connect(
            cwd=cwd,
            project_id=project_id,
            addon_version=addon_version,
            blender_version=blender_version,
            attach_runtime_directory=runtime_directory,
            attach_ticket=ticket,
        )
    configure_bridge_auto_reconnect(
        bridge,
        cwd=cwd,
        project_id=project_id,
        addon_version=addon_version,
        blender_version=blender_version,
        runtime_user_directory=runtime_user_directory,
        websocket_type=websocket_type,
    )
    controller_connection.configure_peer_discovery(
        project_id=project_id,
        addon_version=addon_version,
        blender_version=blender_version,
        runtime_user_directory=runtime_user_directory,
    )
    controller_connection.poll_controller_lifecycle(force=True)
    return bridge


def connect(
    *,
    cwd: str | PathLike[str],
    project_id: str,
    addon_version: str,
    blender_version: str,
    daemon_args: Sequence[str] | None = None,
    attach_runtime_directory: str | PathLike[str] | None = None,
    attach_ticket: str | None = None,
) -> Connection:
    """Create, attach, or hash-gate the add-on's sole daemon connection."""
    global _active_connection
    previous = _active_connection
    if previous is not None and previous.state not in (
        LifecycleState.STOPPED,
        *RECONNECTABLE_STATES,
    ):
        raise ConnectionError("the add-on already owns an active daemon connection")
    attach_mode = attach_runtime_directory is not None or attach_ticket is not None
    if attach_mode and (
        attach_runtime_directory is None
        or attach_ticket is None
        or daemon_args is not None
    ):
        raise ConnectionError(
            "attach mode requires exactly a runtime directory and attach ticket"
        )
    if attach_mode:
        recovering = previous is not None and previous.state in RECONNECTABLE_STATES
        expected_scene_hash = _read_reconnect_scene_hash(cwd) if recovering else None
        if recovering:
            previous.disconnect("reattach_after_unexpected_loss")
        assert attach_runtime_directory is not None
        assert attach_ticket is not None
        replacement = Connection.attach(
            attach_runtime_directory,
            attach_ticket,
            cwd=cwd,
            project_id=project_id,
            addon_version=addon_version,
            blender_version=blender_version,
            expose_tools=False,
        )
        try:
            if expected_scene_hash is not None:
                verify_reconnect_hash(
                    _live_scene_hash(expected_scene_hash),
                    expected_scene_hash,
                )
                if previous is not None and previous.task_status.task_kind is not None:
                    replacement.task_status = replace(
                        previous.task_status,
                        phase="recovered",
                        outcome="recovered",
                    )
        except Exception:
            replacement.disconnect("reattach_hash_mismatch")
            raise
    else:
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
                expose_tools=False,
            )
        _reconcile_connected_transaction(replacement, cwd)
    _active_connection = replacement
    return replacement
def reset_lifecycle_state() -> None:
    """Clear reconnect coordinators after unload or an explicit disconnect."""
    global _bridge_reconnect_plan
    _bridge_reconnect_plan = None


def disconnect_active(reason: str) -> bool:
    """Disconnect controllers and release the retained bridge, if one exists."""
    global _active_connection
    from . import controller_connection

    active = _active_connection
    controller_closed = controller_connection.disconnect_active_controller(
        reason=reason if reason in ("client_exit", "addon_unload") else "client_exit",
        shutdown_owner=active is not None and active.child is not None,
    )
    if active is None or active.state == LifecycleState.STOPPED:
        _active_connection = None
        reset_lifecycle_state()
        return controller_closed
    try:
        active.disconnect(reason)
    finally:
        _active_connection = None
        reset_lifecycle_state()
    return True
