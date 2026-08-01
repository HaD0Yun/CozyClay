"""Durable recovery core for execute_blender_python.

This module intentionally has no bpy dependency.  The Blender save, reload, script,
and manifest operations are supplied by the bridge that owns the Blender thread.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
import hashlib
import json
import os
import re
from pathlib import Path
import tempfile
import traceback as traceback_module
from typing import TypeAlias

MAX_OUTPUT_BYTES = 4096
MAX_ERROR_MESSAGE_BYTES = 1024
MAX_TRACEBACK_BYTES = 8192
MAX_REASON_BYTES = 256
MAX_SCRIPT_BYTES = 8192
MAX_DEADLINE_MS = 30_000
EXTERNAL_SIDE_EFFECT_DISCLOSURE = (
    "Blender scene state rolled back; external side effects (files, network, processes) "
    "are not and cannot be undone."
)

_JOURNAL_STATUSES = frozenset(
    {
        "started",
        "succeeded",
        "finalized",
        "failed_pending_reload",
        "recovered",
        "recovery_verification_failed",
    }
)
_TERMINAL_STATUSES = frozenset({"succeeded", "finalized", "recovered"})

ExecutionResult: TypeAlias = dict[str, object]


class ExecutionJournalError(ValueError):
    """Journal input or durable state is invalid or unsafe."""


@dataclass(frozen=True)
class ExecutionJournal:
    """Closed, durable execution record; optional fields describe completed work."""

    request_id: str
    base_revision_id: str
    backup_path: str
    backup_sha256: str
    status: str
    started_at: str = ""
    stdout: str = ""
    stdout_truncated: bool = False
    stderr: str = ""
    stderr_truncated: bool = False
    error_message: str | None = None
    error_traceback: str | None = None
    new_revision_id: str | None = None
    canonical_blend_path: str = ""
    token_generation: int = 0

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _bounded_utf8(value: object, maximum: int) -> tuple[str, bool]:
    text = value if isinstance(value, str) else str(value)
    encoded = text.encode("utf-8", "replace")
    if len(encoded) <= maximum:
        return text, False
    clipped = encoded[:maximum]
    while True:
        try:
            return clipped.decode("utf-8"), True
        except UnicodeDecodeError as exc:
            clipped = clipped[: exc.start]


def bounded_output(value: object) -> tuple[str, bool]:
    """Return a valid UTF-8 prefix within the protocol output ceiling."""
    return _bounded_utf8(value, MAX_OUTPUT_BYTES)


def _bounded_reason(value: object) -> str:
    return _bounded_utf8(value, MAX_REASON_BYTES)[0] or "Execution outcome is unknown."


def _fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_file(path: Path) -> None:
    with path.open("rb") as handle:
        os.fsync(handle.fileno())


def journal_path(project_root: str | os.PathLike[str], request_id: str) -> Path:
    """Return the request-specific journal location without creating it."""
    if not isinstance(request_id, str) or not request_id or Path(request_id).name != request_id:
        raise ExecutionJournalError("request_id must be a nonempty filename")
    return Path(project_root) / ".cclay" / "execution-journal" / f"{request_id}.json"


def backup_path(project_root: str | os.PathLike[str], request_id: str) -> Path:
    """Return the request-specific whole-blend backup location."""
    if not isinstance(request_id, str) or not request_id or Path(request_id).name != request_id:
        raise ExecutionJournalError("request_id must be a nonempty filename")
    return Path(project_root) / ".cclay" / "execution-backups" / f"{request_id}.blend"


def _parse_journal(value: object) -> ExecutionJournal:
    if not isinstance(value, Mapping):
        raise ExecutionJournalError("execution journal must be a JSON object")
    fields = set(ExecutionJournal.__dataclass_fields__)
    if set(value) != fields:
        raise ExecutionJournalError("execution journal has an invalid schema")
    try:
        record = ExecutionJournal(**dict(value))
    except TypeError as exc:
        raise ExecutionJournalError("execution journal has an invalid schema") from exc
    if not all(isinstance(getattr(record, name), str) for name in ("request_id", "base_revision_id", "backup_path", "backup_sha256", "status", "started_at", "stdout", "stderr", "canonical_blend_path")):
        raise ExecutionJournalError("execution journal has invalid string fields")
    if record.status not in _JOURNAL_STATUSES:
        raise ExecutionJournalError("execution journal has an invalid status")
    if (
        isinstance(record.token_generation, bool)
        or not isinstance(record.token_generation, int)
        or record.token_generation < 0
    ):
        raise ExecutionJournalError("execution journal has an invalid token generation")
    if not isinstance(record.stdout_truncated, bool) or not isinstance(record.stderr_truncated, bool):
        raise ExecutionJournalError("execution journal has invalid truncation fields")
    if record.error_message is not None and not isinstance(record.error_message, str):
        raise ExecutionJournalError("execution journal has an invalid error message")
    if record.error_traceback is not None and not isinstance(record.error_traceback, str):
        raise ExecutionJournalError("execution journal has an invalid traceback")
    if record.new_revision_id is not None and not isinstance(record.new_revision_id, str):
        raise ExecutionJournalError("execution journal has an invalid revision")
    if len(record.stdout.encode("utf-8")) > MAX_OUTPUT_BYTES or len(
        record.stderr.encode("utf-8")
    ) > MAX_OUTPUT_BYTES:
        raise ExecutionJournalError("execution journal output exceeds the UTF-8 byte limit")
    if record.error_message is not None and len(
        record.error_message.encode("utf-8")
    ) > MAX_ERROR_MESSAGE_BYTES:
        raise ExecutionJournalError("execution journal error exceeds the UTF-8 byte limit")
    if record.error_traceback is not None and len(
        record.error_traceback.encode("utf-8")
    ) > MAX_TRACEBACK_BYTES:
        raise ExecutionJournalError(
            "execution journal traceback exceeds the UTF-8 byte limit"
        )
    return record


def write_journal(project_root: str | os.PathLike[str], record: ExecutionJournal) -> None:
    """Atomically replace and fsync one journal record through a legal transition."""
    record = _parse_journal(record.to_dict())
    previous = read_journal(project_root, record.request_id)
    if previous is not None:
        allowed = {
            "started": {"succeeded", "failed_pending_reload"},
            "succeeded": {"finalized"},
            "failed_pending_reload": {"recovered", "recovery_verification_failed"},
        }
        if record.status not in allowed.get(previous.status, set()):
            raise ExecutionJournalError(
                f"invalid execution journal transition {previous.status} -> {record.status}"
            )
    destination = journal_path(project_root, record.request_id)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    encoded = (json.dumps(record.to_dict(), ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{record.request_id}.", suffix=".tmp", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        _fsync_directory(destination.parent)
    except OSError as exc:
        raise ExecutionJournalError(f"cannot write execution journal: {exc}") from exc
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def read_journal(project_root: str | os.PathLike[str], request_id: str) -> ExecutionJournal | None:
    """Read a journal record, returning None only when it does not exist."""
    path = journal_path(project_root, request_id)
    try:
        with path.open(encoding="utf-8") as handle:
            return _parse_journal(json.load(handle))
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ExecutionJournalError(f"cannot read execution journal: {exc}") from exc
def query_outcome(
    project_root: str | os.PathLike[str], request_id: str
) -> ExecutionResult | None:
    """Return a safe outcome even when on-disk recovery evidence is malformed."""
    try:
        record = read_journal(project_root, request_id)
    except ExecutionJournalError:
        return {
            "type": "execute_result",
            "request_id": request_id,
            "outcome": "outcome_unknown",
            "reason": _bounded_reason("Execution journal is unreadable; mutations are frozen."),
        }
    return outcome_for_journal(record)



def outcome_for_journal(record: ExecutionJournal | None) -> ExecutionResult | None:
    """Map durable state to the exact safe execution-outcome response shape."""
    if record is None:
        return None
    if record.status in {"succeeded", "finalized"} and record.new_revision_id:
        return {
            "type": "execute_result", "request_id": record.request_id, "outcome": "success",
            "new_revision_id": record.new_revision_id, "stdout": record.stdout,
            "stdout_truncated": record.stdout_truncated, "stderr": record.stderr,
            "stderr_truncated": record.stderr_truncated,
        }
    if record.status == "recovered":
        return {
            "type": "execute_result", "request_id": record.request_id, "outcome": "failed_recovered",
            "restored_revision_id": record.base_revision_id,
            "error": {"message": record.error_message or "Execution failed.", "traceback": record.error_traceback or "Recovery completed."},
            "stdout": record.stdout, "stdout_truncated": record.stdout_truncated,
            "stderr": record.stderr, "stderr_truncated": record.stderr_truncated,
            "disclosure": EXTERNAL_SIDE_EFFECT_DISCLOSURE,
        }
    if record.status == "recovery_verification_failed":
        return {"type": "execute_result", "request_id": record.request_id, "outcome": "recovery_required", "journal_status": "recovery_verification_failed"}
    return {"type": "execute_result", "request_id": record.request_id, "outcome": "outcome_unknown", "reason": _bounded_reason("Execution recovery is pending; mutations are frozen.")}


def recovery_gate(project_root: str | os.PathLike[str]) -> list[ExecutionJournal]:
    """Return records that must freeze new mutations until recovery is resolved."""
    directory = Path(project_root) / ".cclay" / "execution-journal"
    try:
        paths = sorted(directory.glob("*.json"))
    except OSError as exc:
        raise ExecutionJournalError(f"cannot inspect execution journals: {exc}") from exc
    blocked: list[ExecutionJournal] = []
    for path in paths:
        try:
            record = read_journal(project_root, path.stem)
        except ExecutionJournalError:
            raise ExecutionJournalError(
                "an execution journal is unreadable; mutations must remain frozen"
            ) from None
        if record is not None and record.status not in _TERMINAL_STATUSES:
            blocked.append(record)
    return blocked
def failed_pending_reloads(project_root: str | os.PathLike[str]) -> list[ExecutionJournal]:
    """Return every durable script failure that awaits a post-load verification."""
    return [
        record for record in recovery_gate(project_root)
        if record.status == "failed_pending_reload"
    ]




class ExecutionCoordinator:
    """Injectable Blender-thread coordinator for backup, execution, and recovery."""

    def __init__(
        self,
        *,
        project_root: str | os.PathLike[str],
        source_blend_path: Callable[[], str | os.PathLike[str] | None],
        save_backup: Callable[[Path], None],
        execute_script: Callable[[str], tuple[object, object]],
        mint_revision: Callable[[], str],
        token_generation: int = 0,
    ) -> None:
        self.project_root = Path(project_root).resolve()
        self.source_blend_path = source_blend_path
        self.save_backup = save_backup
        self.execute_script = execute_script
        self.mint_revision = mint_revision
        self.token_generation = token_generation

    def _precondition(self, request_id: str, code: str, message: object) -> ExecutionResult:
        return {"type": "precondition_failed", "request_id": request_id, "code": code, "message": _bounded_utf8(message, MAX_ERROR_MESSAGE_BYTES)[0] or code}

    def execute(self, request: Mapping[str, object]) -> ExecutionResult:
        request_id = request.get("request_id")
        script = request.get("script")
        base_revision = request.get("expected_revision_id")
        capture_stdout = request.get("capture_stdout")
        deadline_ms = request.get("deadline_ms")
        if (
            set(request) != {
                "type", "request_id", "script", "deadline_ms", "capture_stdout",
                "expected_revision_id",
            }
            or request.get("type") != "execute_blender_python"
            or not isinstance(request_id, str)
            or not isinstance(script, str)
            or not isinstance(base_revision, str)
            or not isinstance(capture_stdout, bool)
            or isinstance(deadline_ms, bool)
            or not isinstance(deadline_ms, int)
        ):
            raise ExecutionJournalError("request must match the closed execute_blender_python schema")
        if len(script.encode("utf-8")) > MAX_SCRIPT_BYTES:
            raise ExecutionJournalError("script exceeds the UTF-8 byte limit")
        if not 1 <= deadline_ms <= MAX_DEADLINE_MS:
            raise ExecutionJournalError("deadline_ms is out of range")
        if (
            not re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
                request_id,
            )
            or not re.fullmatch(r"[0-9a-f]{64}", base_revision)
        ):
            raise ExecutionJournalError("request_id or expected_revision_id is invalid")
        try:
            if recovery_gate(self.project_root):
                return {
                    "type": "execute_result",
                    "request_id": request_id,
                    "outcome": "outcome_unknown",
                    "reason": _bounded_reason(
                        "Execution recovery is pending; mutations are frozen."
                    ),
                }
        except ExecutionJournalError:
            return {
                "type": "execute_result",
                "request_id": request_id,
                "outcome": "outcome_unknown",
                "reason": _bounded_reason(
                    "Execution journal is unreadable; mutations are frozen."
                ),
            }
        source = self.source_blend_path()
        if source is None:
            return self._precondition(request_id, "UNSAVED_PROJECT", "Save the Blender project before executing Python.")
        source_path = Path(source).resolve()
        try:
            source_path.relative_to(self.project_root)
        except ValueError:
            return self._precondition(request_id, "UNSAVED_PROJECT", "The Blender project must be saved inside the attached project directory.")
        target = backup_path(self.project_root, request_id)
        try:
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            self.save_backup(target)
            _fsync_file(target)
            _fsync_directory(target.parent)
            _fsync_directory(target.parent.parent)
            digest = _sha256_file(target)
            if not digest:
                raise OSError("backup SHA-256 is empty")
        except Exception as exc:
            return self._precondition(request_id, "BACKUP_UNAVAILABLE", f"Cannot create verified Blender backup: {exc}")
        started = ExecutionJournal(
            request_id,
            base_revision,
            str(target),
            digest,
            "started",
            started_at=datetime.now(timezone.utc).isoformat(),
            canonical_blend_path=str(source_path),
            token_generation=self.token_generation,
        )
        try:
            write_journal(self.project_root, started)
        except ExecutionJournalError:
            raise
        try:
            stdout, stderr = self.execute_script(script)
        except Exception as exc:
            message, _ = _bounded_utf8(str(exc) or exc.__class__.__name__, MAX_ERROR_MESSAGE_BYTES)
            details, _ = _bounded_utf8(traceback_module.format_exc(), MAX_TRACEBACK_BYTES)
            failed = replace(started, status="failed_pending_reload", error_message=message, error_traceback=details)
            write_journal(self.project_root, failed)
            return outcome_for_journal(failed) or {}
        stdout_text, stdout_truncated = bounded_output(stdout if capture_stdout else "")
        stderr_text, stderr_truncated = bounded_output(stderr)
        try:
            revision = self.mint_revision()
        except Exception as exc:
            message, _ = _bounded_utf8(str(exc) or exc.__class__.__name__, MAX_ERROR_MESSAGE_BYTES)
            details, _ = _bounded_utf8(traceback_module.format_exc(), MAX_TRACEBACK_BYTES)
            failed = replace(started, status="failed_pending_reload", stdout=stdout_text, stdout_truncated=stdout_truncated, stderr=stderr_text, stderr_truncated=stderr_truncated, error_message=message, error_traceback=details)
            write_journal(self.project_root, failed)
            return outcome_for_journal(failed) or {}
        succeeded = replace(started, status="succeeded", stdout=stdout_text, stdout_truncated=stdout_truncated, stderr=stderr_text, stderr_truncated=stderr_truncated, new_revision_id=revision)
        write_journal(self.project_root, succeeded)
        finalized = replace(succeeded, status="finalized")
        write_journal(self.project_root, finalized)
        return outcome_for_journal(finalized) or {}

    def verify_reloaded_evidence(
        self,
        request_id: str,
        verify_base_revision: Callable[[str], bool],
    ) -> ExecutionJournal:
        """Verify the already-loaded backup without changing durable status."""
        record = read_journal(self.project_root, request_id)
        if record is None:
            raise ExecutionJournalError("execution journal was not found")
        if record.status != "failed_pending_reload":
            raise ExecutionJournalError("execution journal is not pending reload")
        path = Path(record.backup_path)
        _fsync_file(path)
        if _sha256_file(path) != record.backup_sha256:
            raise ExecutionJournalError("backup SHA-256 does not match the journal")
        if not verify_base_revision(record.base_revision_id):
            raise ExecutionJournalError("reloaded Blender scene does not match the base revision")
        return record

    def verify_reloaded(
        self,
        request_id: str,
        verify_base_revision: Callable[[str], bool],
    ) -> ExecutionResult:
        """Verify a backup already loaded by Blender's main-file lifecycle."""
        try:
            record = self.verify_reloaded_evidence(
                request_id, verify_base_revision
            )
        except Exception:
            record = read_journal(self.project_root, request_id)
            if record is None:
                raise
            failed = replace(record, status="recovery_verification_failed")
            write_journal(self.project_root, failed)
            return outcome_for_journal(failed) or {}
        recovered = replace(record, status="recovered")
        write_journal(self.project_root, recovered)
        return outcome_for_journal(recovered) or {}

    def recover(self, request_id: str, reload_backup: Callable[[Path], None], verify_base_revision: Callable[[str], bool]) -> ExecutionResult:
        """Reload a failed backup and verify its base revision without minting one."""
        record = read_journal(self.project_root, request_id)
        if record is None:
            raise ExecutionJournalError("execution journal was not found")
        if record.status != "failed_pending_reload":
            return outcome_for_journal(record) or {}
        try:
            reload_backup(Path(record.backup_path))
        except Exception:
            failed = replace(record, status="recovery_verification_failed")
            write_journal(self.project_root, failed)
            return outcome_for_journal(failed) or {}
        return self.verify_reloaded(request_id, verify_base_revision)
