"""Transport-neutral bridge request dispatcher for the Blender add-on."""

import contextlib
import json
import os
import queue
import re
import stat
import io
import tempfile
import threading
import time
import traceback
from dataclasses import dataclass, replace
from enum import Enum
from os import PathLike
from pathlib import Path
from typing import Any, Callable
from uuid import UUID, uuid4

from .checkpoint import Checkpoint, restore, verify
from .handshake import (
    MUTATION_BRIDGE_CAPABILITY,
    SCENE_MANIFEST_V3_CAPABILITY,
    SUPPORTED_BRIDGE_METHODS,
    TRANSACTION_COMMIT_CAPABILITY,
)
from .camera_action import parse_replace_camera_action
from .camera_action import replace_camera_action as replace_scene_camera_action
from .fall_motion import create_fall_motion as create_scene_fall_motion
from .fall_motion import parse_create_fall_motion
from .performance import apply_performance_mode as apply_scene_performance_mode
from .performance import inspect_performance as inspect_scene_performance
from .performance import parse_apply_performance_mode
from .qa_metrics import inspect_visual_qa_metrics as inspect_scene_qa_metrics
from .qa_metrics import parse_inspect_visual_qa_metrics
from .ws_client import WebSocketError
from .blender_server import BlenderServer, BlenderServerError, SERVER_CAPABILITIES
from .execution_journal import (
    ExecutionCoordinator,
    ExecutionJournalError,
    query_outcome,
    read_journal,
    recovery_gate,
    failed_pending_reloads,
)

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover - exercised by host-side imports
    bpy = None


class ConnectionError(RuntimeError):
    """The framed bridge dispatcher violated its transport contract."""


class DurableCommitReconciliationRequired(ConnectionError):
    """A post-mutation durable outcome cannot be determined safely."""


class StaleBridgeBase(ConnectionError):
    """The durable project revision differs from the bridge request."""

    code = "STALE_BASE"

class DurableStoreFailed(ConnectionError):
    """A durable project store write (journal or index) failed."""

    code = "DURABLE_STORE_FAILED"


class LifecycleState(str, Enum):
    """Closed dispatcher state shared by request handling and the Blender UI."""

    ACTIVE = "active"
    LOST = "lost"
    DISCONNECTED = "disconnected"
    RECOVERY_REQUIRED = "recovery_required"
    DRAINING = "draining"
    STOPPED = "stopped"




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
# Read-only bridge methods: no task tracking, durable base allows bootstrap.
_READ_ONLY_BRIDGE_METHODS = (
    "inspect_entity",
    "capture_viewport",
    "produce_directing_evidence",
    "inspect_relations",
    "inspect_pose_contacts",
    "inspect_motion_constraints",
    "preflight_motion",
    "inspect_performance",
    "inspect_visual_qa_metrics",
)
# Exact capture_viewport params the bridge sends; every key is always present
# and null when unset, so an unknown key is protocol skew, not an option.
CAPTURE_VIEWPORT_PARAM_KEYS = frozenset({"subject", "views", "project_id"})
# Exact inspect_entity params the bridge sends; unknown keys are protocol skew.
INSPECT_ENTITY_PARAM_KEYS = frozenset({
    "entity_id",
    "scope",
    "data_path_filter",
    "frame_start",
    "frame_end",
})
# Lowercase UUID v4, the only entity_id form the bridge emits. Compiled here
# (not imported from manifest.py, which imports bpy) so host-side pure tests can
# exercise the validation without a Blender process.
_UUID_V4_LOWERCASE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_INSPECT_ENTITY_SCOPES = frozenset({"bones", "animation", "material", "all"})
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


_DISCOVERY_SLOT_FILENAMES = {
    "controller_peer": "controller-peer-slot.json",
}
_DISCOVERY_SLOT_V1_FIELDS = {
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
    """One atomically consumed controller-peer discovery credential."""

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
    return base / f"cclay-{uid}"


def _valid_attach_ticket(ticket: object) -> bool:
    return (
        isinstance(ticket, str)
        and len(ticket) == 43
        and all(
            character.isascii() and (character.isalnum() or character in "_-")
            for character in ticket
        )
    )



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
    if slot != "controller_peer":
        raise ConnectionError("discovery slot must be controller_peer")
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
    """Transport-neutral bridge request dispatcher."""

    def __init__(
        self,
        child: object | None,
        websocket: Any,
        project_directory: str | PathLike[str] | None = None,
        *,
        bridge_requests_allowed: bool = True,
        identity: dict[str, str] | None = None,
        capabilities: frozenset[str] | None = None,
    ):
        self.websocket = websocket
        self.state = LifecycleState.ACTIVE
        self.bridge_requests_allowed = bridge_requests_allowed
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
        self._response_queues: dict[str, queue.Queue] = {}
        self.last_bridge_response: dict | None = None
        self._transport_send: Callable[[dict], None] | None = None
        self._send_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self.project_directory = (
            Path(project_directory) if project_directory is not None else None
        )

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

    def allow_bridge_requests(self) -> None:
        """Allow bridge requests after durable recovery evidence is reconciled."""
        if self.state != LifecycleState.ACTIVE:
            raise ConnectionError(
                "cannot allow bridge requests on an inactive connection"
            )
        self.bridge_requests_allowed = True

    def require_recovery(self) -> None:
        """Withhold bridge request service and retain a terminal recovery state."""
        self.bridge_requests_allowed = False
        self._log_bridge_event(
            "require_recovery",
            stack="".join(traceback.format_stack(limit=10)),
        )
        with self._state_lock:
            self.state = LifecycleState.RECOVERY_REQUIRED
        self._finish_in_flight_for_lifecycle("recovery_required")


    def _append_rebind_journal(
        self,
        source: str,
        project_id: object,
        scene_hash: object,
        *,
        old_revision_id: str | None = None,
        new_revision_id: str | None = None,
    ) -> None:
        """Audit one inspect rebind; propagates project_store.ProjectStoreError."""
        from . import project_store

        entry: dict = {
            "type": "inspect_rebind",
            "source": source,
            "project_id": project_id,
            "scene_hash": scene_hash,
        }
        if old_revision_id is not None:
            entry["old_revision_id"] = old_revision_id
        if new_revision_id is not None:
            entry["new_revision_id"] = new_revision_id
        project_store.append_journal(str(self.project_directory), entry)

    def _durable_project_base(
        self,
        expected_revision_id: str,
        *,
        allow_bootstrap: bool = False,
        allow_rebind: bool = False,
    ) -> tuple[str, str]:
        if self.project_directory is None:
            raise ConnectionError("durable project directory is unavailable")
        try:
            project = json.loads(
                (self.project_directory / ".cclay/project.json").read_text(
                    encoding="utf-8"
                )
            )
            revision_id = project["current_revision_id"]
            scene_hash = project["manifest"]["sceneHash"]
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as error:
            raise ConnectionError(f"durable project manifest is unavailable: {error}") from error
        rebind_required = revision_id != expected_revision_id and not (
            allow_bootstrap
            and expected_revision_id == _BOOTSTRAP_REVISION_ID
        )
        if rebind_required and not allow_rebind:
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
        if rebind_required:
            # Inspect is the universal STALE_BASE recovery path: serve the
            # durable truth instead of wedging the director, and leave an
            # audit record of the rebind. Mutation paths never take this
            # branch; they keep failing closed on stale bases.
            from . import project_store

            try:
                self._append_rebind_journal(
                    "durable_serve",
                    project.get("project_id"),
                    scene_hash,
                    old_revision_id=expected_revision_id,
                    new_revision_id=revision_id,
                )
            except project_store.ProjectStoreError as error:
                raise DurableStoreFailed(
                    f"durable project rebind journal append failed: {error}"
                ) from error
        return revision_id, scene_hash

    def _durable_scene_hash(self, expected_revision_id: str) -> str:
        return self._durable_project_base(expected_revision_id)[1]

    def _inspect_project_result(
        self,
        revision_id: str,
        current_scene_hash: str,
    ) -> dict:
        from .manifest import (
            extract_scene_snapshot,
            extract_scene_manifest_v4,
            resolve_manifest_for_expected_hash,
        )
        from . import project_store

        live_manifest = resolve_manifest_for_expected_hash(current_scene_hash)
        if live_manifest is None:
            # The durable substrate and the live Blender scene diverged. This
            # happens whenever the user edits the scene directly in Blender
            # (or the .blend was touched outside a stage_scene commit). Rather
            # than bricking every turn with STALE_BASE, rebind the project to
            # the live V2 manifest so the director can keep working. Mutation
            # tools still enforce expected_revision_id against the new base.
            live_manifest = extract_scene_manifest_v4()
            if self.project_directory is None:
                raise StaleBridgeBase(
                    "live Blender scene does not match the durable project substrate"
                )
            # The audit record is appended BEFORE the substrate rewrite so a
            # crash or store failure between the two writes can never leave a
            # persisted rebind with no journal entry.
            try:
                self._append_rebind_journal(
                    "live_rewrite",
                    live_manifest["projectId"],
                    live_manifest["sceneHash"],
                    old_revision_id=revision_id,
                    new_revision_id=live_manifest["revisionId"],
                )
            except project_store.ProjectStoreError as error:
                raise DurableStoreFailed(
                    "durable rebind journal append failed before the substrate "
                    f"rewrite: {error}"
                ) from error
            try:
                project_store.write_project_index(
                    str(self.project_directory),
                    live_manifest["projectId"],
                    {
                        "schema_version": 1,
                        "current_revision_id": live_manifest["revisionId"],
                        "manifest": live_manifest,
                    },
                )
            except project_store.ProjectStoreError as error:
                raise DurableStoreFailed(
                    f"durable project substrate rewrite failed after the rebind audit: {error}"
                ) from error
            revision_id = live_manifest["revisionId"]
        return {
            "revision": revision_id,
            "snapshot": extract_scene_snapshot(),
        }

    def _inspect_entity_result(
        self,
        revision_id: str,
        params: dict,
    ) -> dict:
        from .entity_animation import fit_result_to_budget
        from .manifest import _entity_detail

        # A non-dict params value is protocol skew, not an empty request:
        # coercing it to {} would turn a malformed frame into a default-shaped
        # success and hide the skew from both sides.
        if not isinstance(params, dict):
            raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: params must be an object")
        request = params
        # Closed param set: an unknown key is protocol skew, not an option.
        unknown = sorted(set(request) - INSPECT_ENTITY_PARAM_KEYS)
        if unknown:
            raise ConnectionError(
                f"INVALID_INSPECT_ENTITY_PARAMS: unknown params {unknown}"
            )
        entity_id = request.get("entity_id")
        scope = request.get("scope")
        # scope is required on both sides: no "all" defaulting here. The bridge
        # always sends an explicit scope, so a missing one is protocol skew.
        if scope not in _INSPECT_ENTITY_SCOPES:
            raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: scope is required and must be bones|animation|material|all")
        # entity_id is required and must be a lowercase UUID v4 -- the only form
        # the bridge emits -- so a non-UUID value is protocol skew, not a
        # best-effort lookup.
        if not isinstance(entity_id, str) or not entity_id:
            raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: entity_id is required")
        if not _UUID_V4_LOWERCASE.fullmatch(entity_id):
            raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: entity_id must be a lowercase UUID v4")
        # Optional narrowing params, all independent. bool is an int subclass in
        # Python and must be rejected for the integer frame bounds. An explicit
        # null is rejected rather than treated as absent, because the
        # TypeScript schema rejects it too and the bridge only ever omits an
        # unset key -- a present null is protocol skew.
        for optional_key in ("data_path_filter", "frame_start", "frame_end"):
            if optional_key in request and request[optional_key] is None:
                raise ConnectionError(
                    f"INVALID_INSPECT_ENTITY_PARAMS: {optional_key} must be omitted, not null"
                )
        data_path_filter = request.get("data_path_filter")
        if data_path_filter is not None:
            if not isinstance(data_path_filter, str) or not data_path_filter:
                raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: data_path_filter must be a non-empty string")
            if len(data_path_filter) > 128:
                raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: data_path_filter must be at most 128 chars")
        frame_start = request.get("frame_start")
        frame_end = request.get("frame_end")
        if frame_start is not None and (isinstance(frame_start, bool) or not isinstance(frame_start, int)):
            raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: frame_start must be an integer")
        if frame_end is not None and (isinstance(frame_end, bool) or not isinstance(frame_end, int)):
            raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: frame_end must be an integer")
        if frame_start is not None and frame_start < -1000000:
            raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: frame_start must be >= -1000000")
        if frame_start is not None and frame_start > 1000000:
            raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: frame_start must be <= 1000000")
        if frame_end is not None and frame_end < -1000000:
            raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: frame_end must be >= -1000000")
        if frame_end is not None and frame_end > 1000000:
            raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: frame_end must be <= 1000000")
        if frame_start is not None and frame_end is not None and frame_start > frame_end:
            raise ConnectionError("INVALID_INSPECT_ENTITY_PARAMS: frame_start must be <= frame_end")
        animation_query = None
        if data_path_filter is not None or frame_start is not None or frame_end is not None:
            animation_query = {
                "data_path_filter": data_path_filter,
                "frame_start": frame_start,
                "frame_end": frame_end,
            }
        detail = _entity_detail(entity_id, scope, animation_query=animation_query)
        if detail is None:
            raise ConnectionError(f"ENTITY_NOT_FOUND: entity {entity_id} does not exist")
        # Bound the exact envelope the bridge measures. An oversized result is
        # refused there, and a refusal after the work is done leaves the model
        # unable to inspect the entity at all.
        return fit_result_to_budget(
            {"revision": revision_id, "entity_id": entity_id, "scope": scope, "detail": detail}
        )

    def _inspect_relations_result(self, revision_id: str, params: dict) -> dict:
        from .scene_relations import collect_relations

        return collect_relations(revision_id, params)

    def _inspect_pose_contacts_result(self, revision_id: str, params: dict) -> dict:
        from .pose_contacts import collect_pose_contacts

        return collect_pose_contacts(revision_id, params)

    def _inspect_motion_constraints_result(self, revision_id: str, params: dict) -> dict:
        """Which frames on an entity carry ARDY constraints, and on what clip.

        Read-only and diagnostic. Regeneration does not travel this way: the
        add-on has no push channel, so it publishes a queue file instead. This
        exists so a host can see the constraint state before it sweeps.
        """
        from . import constraint_capture

        unknown = set(params) - {"entity_id"}
        if unknown:
            raise ConnectionError(
                f"INVALID_PARAMS: unknown inspect_motion_constraints keys {sorted(unknown)}"
            )
        entity_id = params.get("entity_id")
        armature = next(
            (
                scene_object
                for scene_object in bpy.data.objects
                if scene_object.get("cclay.entity_id") == entity_id
                and scene_object.type == "ARMATURE"
            ),
            None,
        )
        if armature is None:
            raise ConnectionError(f"ENTITY_NOT_FOUND: no armature owns entity {entity_id}")
        try:
            # backfill=False keeps this method genuinely read-only. The legacy
            # start-frame recovery writes a custom property, and doing that
            # here would mutate Blender data outside the mutation path's task
            # tracking and revision handling.
            clip = constraint_capture.base_clip_of(armature, backfill=False)
        except constraint_capture.ConstraintCaptureError as error:
            raise ConnectionError(f"INVALID_MOTION_CLIP: {error}") from None
        pending = constraint_capture.read_pending_request(armature)
        return {
            "revision_id": revision_id,
            "entity_id": entity_id,
            "base_motion_id": clip["motion_id"],
            "start_frame": clip["start_frame"],
            "frame_count": clip["frame_count"],
            "constraints": constraint_capture.marked_frames_by_kind(armature),
            "pending_request_id": None if pending is None else pending["request_id"],
        }

    def _preflight_motion_result(self, revision_id: str, params: dict) -> dict:
        from .motion_preflight import collect_preflight

        return collect_preflight(revision_id, params, self.project_directory)

    def _capture_viewport_result(self, revision_id: str, params: dict | None = None) -> dict:
        from .viewport_capture import VIEWPORT_VIEW_KEYS, capture_viewport

        # A non-dict params value is protocol skew, not an empty request; see
        # _inspect_entity_result for why coercion is refused.
        if not isinstance(params, dict):
            raise ConnectionError("INVALID_CAPTURE_VIEWPORT_PARAMS: params must be an object")
        request = params
        # Closed in this direction too: the bridge always sends exactly these
        # three keys (null when unset), so anything else is a version skew we
        # must not silently ignore.
        unknown = sorted(set(request) - CAPTURE_VIEWPORT_PARAM_KEYS)
        if unknown:
            raise ConnectionError(
                f"INVALID_CAPTURE_VIEWPORT_PARAMS: unknown params {unknown}"
            )
        subject = request.get("subject")
        views = request.get("views")
        project_id = request.get("project_id")
        if subject is not None and not isinstance(subject, str):
            raise ConnectionError("INVALID_CAPTURE_VIEWPORT_PARAMS: subject must be a string entity id")
        if views is not None and not isinstance(views, list):
            raise ConnectionError("INVALID_CAPTURE_VIEWPORT_PARAMS: views must be a list of view names")
        if isinstance(views, list) and not all(isinstance(view, str) for view in views):
            raise ConnectionError("INVALID_CAPTURE_VIEWPORT_PARAMS: every view name must be a string")
        if views is not None and subject is None:
            # The no-subject capture is the human's live viewport and cannot be
            # re-framed, so honouring the request is impossible; returning a
            # different image than the caller asked for is worse than failing.
            raise ConnectionError("INVALID_CAPTURE_VIEWPORT_PARAMS: named views require a subject entity id")
        if project_id is not None and not isinstance(project_id, str):
            raise ConnectionError("INVALID_CAPTURE_VIEWPORT_PARAMS: project_id must be a string")
        viewport = capture_viewport(subject=subject, views=views, project_id=project_id)
        # The bridge turns every view into a model image content block, and a
        # view missing its mime type or data poisons the whole conversation:
        # data:undefined;base64,undefined is rejected by the model API on every
        # later request, so the session cannot recover. Fail the call instead.
        views_result = viewport["views"]
        for view in views_result:
            if set(view) != VIEWPORT_VIEW_KEYS:
                raise ConnectionError(
                    f"INVALID_CAPTURE_VIEWPORT_RESULT: view keys {sorted(view)} do not match the wire contract"
                )
            if not view["mime_type"] or not view["data_base64"]:
                raise ConnectionError(
                    f"INVALID_CAPTURE_VIEWPORT_RESULT: view {view['name']} carries no image data"
                )
        return {"revision": revision_id, "views": views_result}

    def _produce_directing_evidence_result(self, params: object) -> dict:
        from .directing_evidence import produce_directing_evidence

        value = params if isinstance(params, dict) else {}
        return produce_directing_evidence(
            value.get("project_id"),
            value.get("frame_start"),
            value.get("frame_end"),
            project_directory=self.project_directory,
        )

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
            if self._transport_send is not None:
                self._transport_send(message)
            else:
                self.websocket.send_json(message)

    def _log_bridge_event(self, event: str, **fields: Any) -> None:
        """Append one addon-side bridge diagnostics line; never raises."""
        try:
            directory = self.project_directory
            if directory is None:
                return
            payload = {
                "timestamp": time.time(),
                "event": event,
                "state": getattr(self.state, "value", str(self.state)),
                **fields,
            }
            path = Path(directory) / ".cclay" / "addon-bridge.log"
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, default=str) + "\n")
        except Exception:
            pass


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
        if not self.bridge_requests_allowed:
            self._send_bridge_error(
                message,
                "RECOVERY_REQUIRED",
                "tool remains callable, but bridge requests are refused until reconnect verification succeeds",
            )
            return
        if message.get("method") not in SUPPORTED_BRIDGE_METHODS:
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
                    allow_rebind=True,
                )
                if current_scene_hash is None:
                    current_scene_hash = durable_scene_hash
            elif message["method"] in _READ_ONLY_BRIDGE_METHODS:
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
        if message["method"] != "inspect_project" and message["method"] not in _READ_ONLY_BRIDGE_METHODS:
            self.begin_task(message["method"], message["params"])
        if bpy is None:
            self.finish_bridge(bridge_id)
            if message["method"] != "inspect_project" and message["method"] not in _READ_ONLY_BRIDGE_METHODS:
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
        if message["method"] == "inspect_entity":
            try:
                result = self._inspect_entity_result(
                    durable_revision_id,
                    message["params"],
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
        if message["method"] == "inspect_relations":
            try:
                result = self._inspect_relations_result(
                    durable_revision_id,
                    message["params"],
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
        if message["method"] == "inspect_motion_constraints":
            try:
                result = self._inspect_motion_constraints_result(
                    durable_revision_id,
                    message["params"],
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
        if message["method"] == "inspect_pose_contacts":
            try:
                result = self._inspect_pose_contacts_result(
                    durable_revision_id,
                    message["params"],
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
        if message["method"] == "preflight_motion":
            try:
                result = self._preflight_motion_result(
                    durable_revision_id,
                    message["params"],
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
        if message["method"] == "inspect_performance":
            try:
                result = {
                    **inspect_scene_performance(),
                    "revision": durable_revision_id,
                }
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
        if message["method"] == "inspect_visual_qa_metrics":
            try:
                request = parse_inspect_visual_qa_metrics(message["params"])
                if request["expected_revision_id"] != durable_revision_id:
                    raise StaleBridgeBase(
                        "visual QA metrics expected revision "
                        f"{request['expected_revision_id']}, current durable revision is {durable_revision_id}"
                    )
                result = {
                    **inspect_scene_qa_metrics(request),
                    "revision": durable_revision_id,
                }
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
        if message["method"] == "capture_viewport":
            try:
                result = self._capture_viewport_result(durable_revision_id, message.get("params"))
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
        if message["method"] == "produce_directing_evidence":
            try:
                result = self._produce_directing_evidence_result(message["params"])
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
            if message["method"] == "replace_camera_action":
                request = parse_replace_camera_action(message["params"])
                result = replace_scene_camera_action(request, durable_revision_id)
                self._send_json({
                    "type": "bridge_result",
                    "id": bridge_id,
                    "request_id": message["request_id"],
                    "result": result,
                })
                self.finish_bridge(bridge_id)
                self.finish_task("success")
            elif message["method"] == "create_fall_motion":
                request = parse_create_fall_motion(message["params"])
                result = create_scene_fall_motion(request, durable_revision_id)
                self._send_json({
                    "type": "bridge_result",
                    "id": bridge_id,
                    "request_id": message["request_id"],
                    "result": result,
                })
                self.finish_bridge(bridge_id)
                self.finish_task("success")
            elif message["method"] == "apply_performance_mode":
                request = parse_apply_performance_mode(message["params"])
                if request["expected_revision_id"] != durable_revision_id:
                    raise StaleBridgeBase(
                        "performance mode expected revision "
                        f"{request['expected_revision_id']}, current durable revision is {durable_revision_id}"
                    )
                result = {
                    **apply_scene_performance_mode(request["profile"]),
                    "revision_id": durable_revision_id,
                }
                self._send_json({
                    "type": "bridge_result",
                    "id": bridge_id,
                    "request_id": message["request_id"],
                    "result": result,
                })
                self.finish_bridge(bridge_id)
                self.finish_task("success")
            elif message["method"] == "apply_camera_plan":
                bpy.ops.cclay.apply_camera_plan(
                    plan_json=json.dumps(message["params"], separators=(",", ":")),
                    current_scene_hash=current_scene_hash,
                    bridge_id=bridge_id,
                    request_id=message["request_id"],
                    deadline_ms=message["deadline_ms"],
                )
            elif message["method"] == "stage_scene":
                bpy.ops.cclay.stage_scene(
                    plan_json=json.dumps(message["params"], separators=(",", ":")),
                    current_scene_hash=current_scene_hash,
                    bridge_id=bridge_id,
                    request_id=message["request_id"],
                    deadline_ms=message["deadline_ms"],
                )
            else:
                bpy.ops.cclay.render_qa_frames(
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
        if self.state != LifecycleState.ACTIVE or socket_closed:
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
                (self.project_directory / ".cclay/project.json").read_text(
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
            if self.websocket.closed and (
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
        allow_bridge_requests: bool = True,
        deadline: float | None = None,
    ) -> dict | None:
        """Resolve durable startup evidence before allowing bridge requests."""

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
            if allow_bridge_requests:
                self.allow_bridge_requests()
            return None
        self.bridge_requests_allowed = False
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
        if self._transport_send is not None:
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
                if allow_bridge_requests:
                    self.allow_bridge_requests()
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
    @staticmethod
    def _prepared_mutation_result(operation: str, result: dict) -> dict:
        """Project a mutation result to its exact extension-side candidate schema."""
        if operation != "stage_scene":
            return result
        return {
            "expected_revision_id": result["expected_revision_id"],
            "scene_hash": result["scene_hash"],
            "manifest": result["manifest"],
            "entity_identities": result["entity_identities"],
            "applied_hand_shapes": result["applied_hand_shapes"],
        }

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
        result = self._prepared_mutation_result(operation, result)
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
        response_queue = queue.Queue(maxsize=1) if (
            self._transport_send is not None
        ) else None
        if response_queue is not None:
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
        if self._transport_send is not None:
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


    def disconnect(self, reason: str, timeout: float = 8.0) -> None:
        """Close the transport and release dispatcher state."""
        if self.state == LifecycleState.STOPPED:
            return
        self._log_bridge_event("disconnect_called", reason=reason)
        self.state = LifecycleState.DRAINING
        self._finish_in_flight_for_lifecycle("disconnected")
        if not self.websocket.closed:
            try:
                self.websocket.close()
            except (OSError, WebSocketError):
                pass
        self._response_queues.clear()
        self._bridge_cancellations.clear()
        self._terminal_bridge_ids.clear()
        self.state = LifecycleState.STOPPED





_active_connection: Connection | None = None
class _FramedServerTransport:
    """Connection-compatible outbound sink for the framed loopback client."""

    def __init__(self, send: Callable[[dict], None]):
        self._send = send
        self.closed = False

    def send_json(self, message: dict) -> None:
        if not self.closed:
            self._send(message)

    def close(self) -> None:
        self.closed = True


def _execution_mutations_frozen(project_directory: Path) -> bool:
    try:
        return bool(recovery_gate(project_directory))
    except ExecutionJournalError:
        return True


def _execute_blender_python(message: dict, send: Callable[[dict], None], project_directory: Path) -> None:
    request_id = message.get("request_id")
    if not isinstance(request_id, str):
        raise ConnectionError("execute_blender_python request_id is invalid")
    if bpy is None:
        send({"type": "precondition_failed", "request_id": request_id, "code": "UNSAVED_PROJECT", "message": "Blender is unavailable."})
        return
    from . import project_store
    from .identity import IdentityError
    from .manifest import extract_scene_manifest_v4

    try:
        stored = project_store.read_project_index(str(project_directory))
        permission = project_store.read_execute_blender_python_permission(str(project_directory))
        if stored is None or permission is False:
            send({"type": "precondition_failed", "request_id": request_id, "code": "AUTH_INVALID", "message": "Execution is disabled in the durable project record."})
            return
        current_revision_id = stored.get("current_revision_id")
        if current_revision_id != message.get("expected_revision_id"):
            send({"type": "precondition_failed", "request_id": request_id, "code": "REVISION_STALE", "message": "Expected revision does not match the durable current revision."})
            return
        durable_manifest = stored.get("manifest")
        live_manifest = extract_scene_manifest_v4()
        project_store.verify_project_ids_match(
            live_manifest.get("projectId"), stored.get("project_id")
        )
        if (
            not isinstance(durable_manifest, dict)
            or durable_manifest.get("revisionId") != current_revision_id
            or live_manifest.get("sceneHash") != durable_manifest.get("sceneHash")
        ):
            send({"type": "precondition_failed", "request_id": request_id, "code": "REVISION_STALE", "message": "Live Blender scene does not match the durable current revision."})
            return
    except (project_store.ProjectStoreError, IdentityError) as error:
        send({"type": "precondition_failed", "request_id": request_id, "code": "AUTH_INVALID", "message": str(error)})
        return

    def save_backup(destination: Path) -> None:
        bpy.ops.wm.save_as_mainfile(filepath=str(destination), copy=True)

    def execute_script(script: str) -> tuple[str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(script, bpy.__dict__, bpy.__dict__)
        return stdout.getvalue(), stderr.getvalue()

    def mint_revision() -> str:
        from .manifest import extract_scene_manifest_v4
        from .scene_manifest import finalize_scene_manifest_child

        durable = project_store.read_project_index(str(project_directory))
        if (
            not isinstance(durable, dict)
            or durable.get("current_revision_id") != current_revision_id
        ):
            raise StaleBridgeBase(
                "durable project revision changed during Blender Python execution"
            )
        project_id = durable.get("project_id")
        manifest = extract_scene_manifest_v4()
        if manifest.get("projectId") != project_id:
            raise ConnectionError(
                "trusted manifest rescan does not match the durable project identity"
            )
        child = finalize_scene_manifest_child(
            manifest,
            current_revision_id,
            {
                "type": "execute_blender_python",
                "request_id": request_id,
            },
        )
        revision_id = child.get("revisionId")
        if (
            not isinstance(revision_id, str)
            or not re.fullmatch(r"[0-9a-f]{64}", revision_id)
            or revision_id == current_revision_id
        ):
            raise ConnectionError("trusted manifest rescan did not produce one child revision")
        updated = dict(durable)
        updated.pop("project_id")
        updated["current_revision_id"] = revision_id
        updated["manifest"] = child
        project_store.write_project_index(str(project_directory), project_id, updated)
        return revision_id

    server = _blender_server
    result = ExecutionCoordinator(
        project_root=project_directory,
        source_blend_path=lambda: bpy.data.filepath or None,
        save_backup=save_backup,
        execute_script=execute_script,
        mint_revision=mint_revision,
        token_generation=0 if server is None else server.token_generation,
    ).execute(message)
    record = read_journal(project_directory, request_id)
    if record is not None and record.status == "failed_pending_reload":
        close_client = getattr(send, "close_client", None)
        if callable(close_client):
            close_client()
        if _active_connection is not None:
            _active_connection.require_recovery()
        stop_blender_server()
        bpy.ops.wm.open_mainfile(filepath=record.backup_path)
        return
    send(result)


def _execution_outcome(project_directory: Path, request_id: str) -> dict | None:
    return query_outcome(project_directory, request_id)


def execution_recovery_handoff(project_directory: str | PathLike[str], request_id: str) -> dict | None:
    """Return a preserved execution outcome after the connection is replaced."""
    return query_outcome(project_directory, request_id)


def recover_pending_execution_after_load(addon_version: str) -> bool:
    """Verify the backup Blender just loaded, then publish a fresh listener."""
    if bpy is None:
        return False
    loaded = Path(bpy.data.filepath).resolve()
    if loaded.parent.name != "execution-backups" or loaded.parent.parent.name != ".cclay":
        return False
    project_directory = loaded.parents[2]
    try:
        pending = failed_pending_reloads(project_directory)
    except ExecutionJournalError:
        return False
    record = next((item for item in pending if Path(item.backup_path).resolve() == loaded), None)
    if record is None:
        return False
    try:
        canonical = Path(record.canonical_blend_path).resolve()
        canonical.relative_to(project_directory)
        if not record.canonical_blend_path:
            raise ExecutionJournalError("execution journal has no canonical blend path")

        from . import project_store
        from .manifest import extract_scene_manifest_v4

        stored = project_store.read_project_index(str(project_directory))
        if not isinstance(stored, dict):
            raise ExecutionJournalError("durable project index is unavailable")
        durable_manifest = stored.get("manifest")
        if not isinstance(durable_manifest, dict):
            raise ExecutionJournalError("durable project manifest is unavailable")

        def has_durable_base(revision_id: str) -> bool:
            live_manifest = extract_scene_manifest_v4()
            return (
                stored.get("current_revision_id") == revision_id
                and durable_manifest.get("revisionId") == revision_id
                and live_manifest.get("sceneHash") == durable_manifest.get("sceneHash")
                and live_manifest.get("projectId") == stored.get("project_id")
            )

        coordinator = ExecutionCoordinator(
            project_root=project_directory,
            source_blend_path=lambda: None,
            save_backup=lambda _destination: None,
            execute_script=lambda _script: ("", ""),
            mint_revision=lambda: "",
        )
        if loaded != Path(record.backup_path).resolve():
            raise ExecutionJournalError("loaded Blender file does not match the recovery backup")
        coordinator.verify_reloaded_evidence(record.request_id, has_durable_base)

        outcome = bpy.ops.wm.save_as_mainfile(
            filepath=str(canonical), check_existing=False
        )
        if "FINISHED" not in outcome:
            raise ExecutionJournalError("cannot restore the canonical blend filepath")
        result = coordinator.verify_reloaded(record.request_id, has_durable_base)
        if result.get("outcome") != "failed_recovered":
            return False
        start_blender_server(
            project_directory, addon_version, token_generation=record.token_generation + 1
        )
        return True
    except Exception:
        try:
            coordinator = ExecutionCoordinator(
                project_root=project_directory,
                source_blend_path=lambda: None,
                save_backup=lambda _destination: None,
                execute_script=lambda _script: ("", ""),
                mint_revision=lambda: "",
            )
            coordinator.verify_reloaded(record.request_id, lambda _revision_id: False)
        except Exception:
            pass
        return False


_blender_server: BlenderServer | None = None


def _dispatch_blender_server_message(
    message: dict, send: Callable[[dict], None], project_directory: Path
) -> None:
    """Use the existing bridge dispatcher for framed domain requests."""
    global _active_connection
    active = _active_connection
    if active is None or active.state != LifecycleState.ACTIVE:
        active = Connection(
            None,
            _FramedServerTransport(send),
            project_directory=project_directory,
            capabilities=frozenset({
                MUTATION_BRIDGE_CAPABILITY,
                SCENE_MANIFEST_V3_CAPABILITY,
                TRANSACTION_COMMIT_CAPABILITY,
            }),
        )
        _active_connection = active
    active._transport_send = send
    if message.get("type") == "bridge_transaction_ack":
        response_queue = active._response_queues.get(message.get("id"))
        if response_queue is not None:
            response_queue.put(message)
        return
    if message.get("type") == "execute_blender_python":
        _execute_blender_python(message, send, project_directory)
        return
    if (
        message.get("type") == "bridge_request"
        and message.get("method") not in _READ_ONLY_BRIDGE_METHODS
        and message.get("method") != "inspect_project"
        and _execution_mutations_frozen(project_directory)
    ):
        active._send_bridge_error(message, "RECOVERY_REQUIRED", "execution recovery is pending; mutations are frozen")
        return
    active.dispatch_bridge_message(message)


def start_blender_server(
    project_directory: str | PathLike[str], addon_version: str, *, token_generation: int = 0
) -> BlenderServer:
    """Start the one Blender-owned loopback listener for this project."""
    global _blender_server
    if _blender_server is not None:
        if _blender_server.project_directory == Path(project_directory):
            return _blender_server
        raise ConnectionError("a Blender bridge server is already active for another project")
    server = BlenderServer(
        project_directory,
        addon_version,
        lambda message, send: _dispatch_blender_server_message(
            message, send, Path(project_directory)
        ),
        log=lambda event, fields: _log_blender_server_event(
            Path(project_directory), event, fields
        ),
        capabilities=SERVER_CAPABILITIES,
        token_generation=token_generation,
        outcome_lookup=lambda request_id: _execution_outcome(
            Path(project_directory), request_id
        ),
    )
    try:
        server.start()
    except BlenderServerError as error:
        raise ConnectionError(str(error)) from error
    _blender_server = server
    return server


def stop_blender_server() -> None:
    """Synchronously remove the Blender-owned discovery endpoint."""
    global _blender_server
    server, _blender_server = _blender_server, None
    if server is not None:
        server.stop()


def _log_blender_server_event(directory: Path, event: str, fields: dict) -> None:
    try:
        path = directory / ".cclay" / "addon-bridge.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({
                "timestamp": time.time(), "event": event, **fields,
            }, default=str) + "\n")
    except OSError:
        pass


def _live_scene_hash(current_scene_hash: str) -> str:
    """Return the live durable-substrate scene hash, or no hash when unavailable."""
    from .manifest import resolve_manifest_for_expected_hash

    manifest = resolve_manifest_for_expected_hash(current_scene_hash)
    return manifest["sceneHash"] if manifest is not None else ""


def _reconcile_connected_transaction(
    bridge: Connection,
    cwd: str | PathLike[str],
) -> None:
    """Withhold bridge requests until the prepared transaction has one authority."""
    marker_file = Path(cwd) / ".cclay" / "prepared-transaction.json"
    if not marker_file.exists():
        if not bridge.bridge_requests_allowed:
            bridge.allow_bridge_requests()
        return
    bridge.bridge_requests_allowed = False
    if bpy is None:
        bridge.require_recovery()
        raise DurableCommitReconciliationRequired(
            "Blender is required to reconcile a prepared transaction"
        )
    from .manifest import resolve_manifest_for_expected_hash
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
        project_id = bpy.context.scene.get("cclay.project_id")
        if not isinstance(project_id, str):
            raise PreparedTransactionError("blend project id is unavailable")
        return project_id

    def read_scene_hash(_path: Path) -> str:
        for expected_hash in (marker.base_scene_hash, marker.candidate_scene_hash):
            manifest = resolve_manifest_for_expected_hash(expected_hash)
            if manifest is not None:
                return manifest["sceneHash"]
        raise PreparedTransactionError(
            "blend scene hash does not match the prepared transaction"
        )

    bridge.reconcile_prepared_transaction(
        canonical_blend_path=canonical,
        read_blend_project_id=read_project_id,
        read_blend_scene_hash=read_scene_hash,
        reload_blend=lambda path: bpy.ops.wm.open_mainfile(filepath=str(path)),
        allow_bridge_requests=True,
        deadline=time.monotonic() + 3.0,
    )

def disconnect_active(reason: str) -> bool:
    """Disconnect controllers and release the retained bridge, if one exists."""
    global _active_connection
    from . import controller_connection

    active = _active_connection
    controller_closed = controller_connection.disconnect_active_controller(
        reason=reason if reason in ("client_exit", "addon_unload") else "client_exit",
        shutdown_owner=False,
    )
    if active is None or active.state == LifecycleState.STOPPED:
        _active_connection = None
        return controller_closed
    try:
        active.disconnect(reason)
    finally:
        _active_connection = None
    return True
