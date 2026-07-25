"""Durable prepared-transaction marker, backup, and recovery decisions.

This module deliberately has no ``bpy`` dependency. Blender project inspection and
scene actions are injected by callers so marker parsing and recovery policy remain
purely unit-testable.
"""

from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from enum import Enum
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid


_UUID4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_HASH64 = re.compile(r"^[0-9a-f]{64}$")
_UTC_MILLISECONDS = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
)
_OPERATIONS = frozenset(("stage_scene", "apply_camera_plan"))
_PHASES = (
    "prepared",
    "candidate_saved",
    "manifest_committed",
    "acknowledged",
    "rollback_saved",
)
_MARKER_FIELDS = frozenset(
    (
        "schema_version",
        "transaction_id",
        "project_id",
        "operation",
        "request_id",
        "base_revision_id",
        "base_scene_hash",
        "candidate_revision_id",
        "candidate_scene_hash",
        "canonical_blend_path",
        "canonical_blend_sha256",
        "base_backup_path",
        "base_backup_sha256",
        "base_backup_project_id",
        "created_at",
        "updated_at",
        "phase",
    )
)


class PreparedTransactionError(ValueError):
    """Prepared transaction state or recovery evidence is unsafe or invalid."""


@dataclass(frozen=True)
class PreparedTransactionMarker:
    """The exact closed 17-field durable marker schema."""

    schema_version: int
    transaction_id: str
    project_id: str
    operation: str
    request_id: str
    base_revision_id: str
    base_scene_hash: str
    candidate_revision_id: str
    candidate_scene_hash: str
    canonical_blend_path: str
    canonical_blend_sha256: str | None
    base_backup_path: str
    base_backup_sha256: str
    base_backup_project_id: str
    created_at: str
    updated_at: str
    phase: str

    def to_dict(self) -> dict:
        """Return the exact JSON representation in schema field order."""
        return asdict(self)


@dataclass(frozen=True)
class BaseBackup:
    """Verified transaction-private base backup evidence."""

    path: Path
    sha256: str
    project_id: str


class StoreEvidence(str, Enum):
    """Daemon-side evidence classes, evaluated after phase consistency."""

    CONFLICT = "conflict"
    TARGET = "target"
    JOURNAL_FORWARD = "journal_forward"
    BASE = "base"


@dataclass(frozen=True)
class ReconcileDecision:
    """A single closed reconciliation result and its permitted actions."""

    status: str
    store_action: str
    blender_action: str
    recovery_required: bool


def _validate_uuid(value: object, field: str) -> str:
    if not isinstance(value, str) or _UUID4.fullmatch(value) is None:
        raise PreparedTransactionError(f"{field} must be a lowercase UUIDv4")
    return value


def _validate_hash(value: object, field: str) -> str:
    if not isinstance(value, str) or _HASH64.fullmatch(value) is None:
        raise PreparedTransactionError(f"{field} must be a 64-character lowercase SHA-256")
    return value


def _validate_timestamp(value: object, field: str) -> tuple[str, datetime]:
    if not isinstance(value, str) or _UTC_MILLISECONDS.fullmatch(value) is None:
        raise PreparedTransactionError(f"{field} must be ISO-8601 UTC milliseconds")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError as exc:
        raise PreparedTransactionError(
            f"{field} must be ISO-8601 UTC milliseconds"
        ) from exc
    return value, parsed


def _normalized_absolute_path(value: object, field: str) -> Path:
    if not isinstance(value, str):
        raise PreparedTransactionError(f"{field} must be an absolute normalized path")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise PreparedTransactionError(f"{field} must be valid UTF-8") from exc
    if not 1 <= len(encoded) <= 4096:
        raise PreparedTransactionError(f"{field} must be 1..4096 UTF-8 bytes")
    path = Path(value)
    if not path.is_absolute() or os.path.normpath(value) != value:
        raise PreparedTransactionError(f"{field} must be an absolute normalized path")
    return path


def _normalize_project_root(project_root: str | os.PathLike[str]) -> Path:
    # The caller-supplied root is a trusted local API argument; Blender's
    # bpy.path.abspath("//") hands it over with a trailing separator, so
    # normalize before the strict marker-grade path validation (marker-embedded
    # path strings keep the byte-exact requirement).
    raw = os.fspath(project_root)
    if isinstance(raw, str) and len(raw) > 1:
        raw = os.path.normpath(raw)
    root = _normalized_absolute_path(raw, "project_root")
    try:
        info = os.lstat(root)
    except OSError as exc:
        raise PreparedTransactionError(f"project_root is unavailable: {exc}") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise PreparedTransactionError("project_root must be a non-symlink directory")
    if info.st_uid != os.getuid():
        raise PreparedTransactionError("project_root must be owned by the current user")
    return root


def _assert_beneath(path: Path, root: Path, field: str) -> None:
    try:
        if os.path.commonpath((str(path), str(root))) != str(root):
            raise PreparedTransactionError(f"{field} must resolve beneath project_root")
    except ValueError as exc:
        raise PreparedTransactionError(
            f"{field} must resolve beneath project_root"
        ) from exc


def _assert_no_symlink_beneath(path: Path, root: Path, field: str) -> None:
    _assert_beneath(path, root, field)
    relative = path.relative_to(root)
    current = root
    for component in relative.parts:
        current = current / component
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise PreparedTransactionError(f"cannot inspect {field}: {exc}") from exc
        if stat.S_ISLNK(info.st_mode):
            raise PreparedTransactionError(f"{field} must not contain symlinks")


def _validate_marker_paths(
    payload: Mapping[str, object],
    root: Path,
    canonical_blend_path: str | os.PathLike[str] | None,
) -> tuple[Path, Path]:
    canonical = _normalized_absolute_path(
        payload.get("canonical_blend_path"), "canonical_blend_path"
    )
    backup = _normalized_absolute_path(
        payload.get("base_backup_path"), "base_backup_path"
    )
    _assert_no_symlink_beneath(canonical, root, "canonical_blend_path")
    _assert_no_symlink_beneath(backup, root, "base_backup_path")

    transaction_id = payload.get("transaction_id")
    expected_backup = (
        root / ".cclay" / "transactions" / str(transaction_id) / "base.blend"
    )
    if backup != expected_backup:
        raise PreparedTransactionError(
            "base_backup_path must be .cclay/transactions/<transaction_id>/base.blend"
        )
    if canonical_blend_path is not None:
        expected_canonical = _normalized_absolute_path(
            os.fspath(canonical_blend_path), "current canonical_blend_path"
        )
        if canonical != expected_canonical:
            raise PreparedTransactionError(
                "canonical_blend_path does not equal the current project blend path"
            )
    return canonical, backup


def parse_marker(
    value: object,
    *,
    project_root: str | os.PathLike[str],
    canonical_blend_path: str | os.PathLike[str] | None = None,
) -> PreparedTransactionMarker:
    """Parse the exact marker schema and reject all unsafe phase/path states."""
    if not isinstance(value, Mapping) or set(value) != _MARKER_FIELDS:
        raise PreparedTransactionError(
            "prepared transaction marker must contain exactly 17 required fields"
        )
    root = _normalize_project_root(project_root)
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise PreparedTransactionError("schema_version must be the literal 1")

    transaction_id = _validate_uuid(value["transaction_id"], "transaction_id")
    project_id = _validate_uuid(value["project_id"], "project_id")
    request_id = _validate_uuid(value["request_id"], "request_id")
    operation = value["operation"]
    if not isinstance(operation, str) or operation not in _OPERATIONS:
        raise PreparedTransactionError(
            "operation must be stage_scene or apply_camera_plan"
        )
    base_revision_id = _validate_hash(value["base_revision_id"], "base_revision_id")
    base_scene_hash = _validate_hash(value["base_scene_hash"], "base_scene_hash")
    candidate_revision_id = _validate_hash(
        value["candidate_revision_id"], "candidate_revision_id"
    )
    candidate_scene_hash = _validate_hash(
        value["candidate_scene_hash"], "candidate_scene_hash"
    )
    canonical, backup = _validate_marker_paths(value, root, canonical_blend_path)
    base_backup_sha256 = _validate_hash(
        value["base_backup_sha256"], "base_backup_sha256"
    )
    base_backup_project_id = _validate_uuid(
        value["base_backup_project_id"], "base_backup_project_id"
    )
    if base_backup_project_id != project_id:
        raise PreparedTransactionError(
            "base_backup_project_id must equal project_id"
        )
    created_at, created = _validate_timestamp(value["created_at"], "created_at")
    updated_at, updated = _validate_timestamp(value["updated_at"], "updated_at")
    if updated < created:
        raise PreparedTransactionError("updated_at must not precede created_at")

    phase = value["phase"]
    if not isinstance(phase, str) or phase not in _PHASES:
        raise PreparedTransactionError(
            "phase must be prepared, candidate_saved, manifest_committed, acknowledged, or rollback_saved"
        )
    canonical_hash_value = value["canonical_blend_sha256"]
    if phase == "prepared":
        if canonical_hash_value is not None:
            raise PreparedTransactionError(
                "prepared phase requires canonical_blend_sha256 to be null"
            )
        canonical_hash = None
    else:
        if canonical_hash_value is None:
            raise PreparedTransactionError(
                f"{phase} phase requires canonical_blend_sha256"
            )
        canonical_hash = _validate_hash(
            canonical_hash_value, "canonical_blend_sha256"
        )
    if phase == "rollback_saved" and canonical_hash != base_backup_sha256:
        raise PreparedTransactionError(
            "rollback_saved canonical hash must equal the base backup hash"
        )

    return PreparedTransactionMarker(
        schema_version=1,
        transaction_id=transaction_id,
        project_id=project_id,
        operation=operation,
        request_id=request_id,
        base_revision_id=base_revision_id,
        base_scene_hash=base_scene_hash,
        candidate_revision_id=candidate_revision_id,
        candidate_scene_hash=candidate_scene_hash,
        canonical_blend_path=str(canonical),
        canonical_blend_sha256=canonical_hash,
        base_backup_path=str(backup),
        base_backup_sha256=base_backup_sha256,
        base_backup_project_id=base_backup_project_id,
        created_at=created_at,
        updated_at=updated_at,
        phase=phase,
    )


def _fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _ensure_private_directory(directory: Path, root: Path) -> None:
    _assert_no_symlink_beneath(directory, root, "transaction directory")
    created = False
    try:
        directory.mkdir(mode=0o700)
        created = True
    except FileExistsError:
        pass
    except OSError as exc:
        raise PreparedTransactionError(
            f"cannot create private transaction directory: {exc}"
        ) from exc
    try:
        info = os.lstat(directory)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise PreparedTransactionError(
                "transaction directory must be a non-symlink directory"
            )
        if info.st_uid != os.getuid():
            raise PreparedTransactionError(
                "transaction directory must be owned by the current user"
            )
        os.chmod(directory, 0o700)
        if created:
            _fsync_directory(directory.parent)
    except OSError as exc:
        raise PreparedTransactionError(
            f"cannot secure private transaction directory: {exc}"
        ) from exc


def _ensure_transaction_directories(root: Path, transaction_id: str) -> Path:
    cclay = root / ".cclay"
    _ensure_private_directory(cclay, root)
    transactions = cclay / "transactions"
    _ensure_private_directory(transactions, root)
    transaction_directory = transactions / transaction_id
    _ensure_private_directory(transaction_directory, root)
    return transaction_directory


def _open_no_follow(path: Path, flags: int, mode: int | None = None) -> int:
    flags |= getattr(os, "O_NOFOLLOW", 0)
    if mode is None:
        return os.open(path, flags)
    return os.open(path, flags, mode)


def _owned_regular_file(path: Path, field: str, required_mode: int | None = None) -> os.stat_result:
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise PreparedTransactionError(f"{field} is unavailable: {exc}") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise PreparedTransactionError(f"{field} must be a non-symlink regular file")
    if info.st_uid != os.getuid():
        raise PreparedTransactionError(f"{field} must be owned by the current user")
    if required_mode is not None and stat.S_IMODE(info.st_mode) != required_mode:
        raise PreparedTransactionError(
            f"{field} must have mode {required_mode:04o}"
        )
    return info


def _sha256_file(path: Path, field: str) -> str:
    _owned_regular_file(path, field)
    digest = hashlib.sha256()
    try:
        descriptor = _open_no_follow(path, os.O_RDONLY)
        try:
            while chunk := os.read(descriptor, 1024 * 1024):
                digest.update(chunk)
        finally:
            os.close(descriptor)
    except OSError as exc:
        raise PreparedTransactionError(f"cannot hash {field}: {exc}") from exc
    return digest.hexdigest()


def _copy_to_temporary(source: Path, temporary: Path, field: str) -> str:
    source_descriptor = -1
    target_descriptor = -1
    digest = hashlib.sha256()
    try:
        source_descriptor = _open_no_follow(source, os.O_RDONLY)
        target_descriptor = _open_no_follow(
            temporary,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY,
            0o600,
        )
        while chunk := os.read(source_descriptor, 1024 * 1024):
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(target_descriptor, view)
                if written <= 0:
                    raise OSError("short write")
                view = view[written:]
        os.fsync(target_descriptor)
    except OSError as exc:
        raise PreparedTransactionError(f"cannot copy {field}: {exc}") from exc
    finally:
        if source_descriptor >= 0:
            os.close(source_descriptor)
        if target_descriptor >= 0:
            os.close(target_descriptor)
    return digest.hexdigest()


def _atomic_copy(source: Path, destination: Path, field: str) -> str:
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4()}.tmp")
    try:
        digest = _copy_to_temporary(source, temporary, field)
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
        _fsync_directory(destination.parent)
        return digest
    except (OSError, PreparedTransactionError) as exc:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
        if isinstance(exc, PreparedTransactionError):
            raise
        raise PreparedTransactionError(f"cannot atomically replace {field}: {exc}") from exc


def _inspect_project_id(
    path: Path,
    expected_project_id: str,
    read_blend_project_id: Callable[[Path], str],
    field: str,
) -> None:
    try:
        observed = read_blend_project_id(path)
    except Exception as exc:
        raise PreparedTransactionError(
            f"cannot inspect {field} project_id: {exc}"
        ) from exc
    if observed != expected_project_id:
        raise PreparedTransactionError(
            f"{field} project_id does not match the transaction project_id"
        )


def _verify_backup(
    path: Path,
    expected_sha256: str | None,
    expected_project_id: str,
    read_blend_project_id: Callable[[Path], str],
) -> BaseBackup:
    _owned_regular_file(path, "base backup", 0o600)
    digest = _sha256_file(path, "base backup")
    if expected_sha256 is not None and digest != expected_sha256:
        raise PreparedTransactionError("base backup SHA-256 does not match marker")
    _inspect_project_id(
        path, expected_project_id, read_blend_project_id, "base backup"
    )
    return BaseBackup(path=path, sha256=digest, project_id=expected_project_id)


def create_base_backup(
    *,
    project_root: str | os.PathLike[str],
    transaction_id: str,
    canonical_blend_path: str | os.PathLike[str],
    project_id: str,
    read_blend_project_id: Callable[[Path], str],
) -> BaseBackup:
    """Create or verify the immutable fsynced transaction-private base backup."""
    root = _normalize_project_root(project_root)
    transaction_id = _validate_uuid(transaction_id, "transaction_id")
    project_id = _validate_uuid(project_id, "project_id")
    canonical = _normalized_absolute_path(
        os.fspath(canonical_blend_path), "canonical_blend_path"
    )
    _assert_no_symlink_beneath(canonical, root, "canonical_blend_path")
    _owned_regular_file(canonical, "canonical blend")
    transaction_directory = _ensure_transaction_directories(root, transaction_id)
    backup_path = transaction_directory / "base.blend"
    _assert_no_symlink_beneath(backup_path, root, "base_backup_path")

    if backup_path.exists():
        return _verify_backup(
            backup_path, None, project_id, read_blend_project_id
        )

    try:
        digest = _atomic_copy(canonical, backup_path, "base backup")
        backup = _verify_backup(
            backup_path, digest, project_id, read_blend_project_id
        )
    except PreparedTransactionError:
        try:
            backup_path.unlink()
            _fsync_directory(transaction_directory)
        except FileNotFoundError:
            pass
        except OSError:
            pass
        raise
    return backup


def marker_path(project_root: str | os.PathLike[str]) -> Path:
    """Return the singleton prepared marker path for a project."""
    return _normalize_project_root(project_root) / ".cclay" / "prepared-transaction.json"


def write_marker(
    project_root: str | os.PathLike[str], marker: PreparedTransactionMarker
) -> None:
    """Atomically replace and durably fsync the exact recovery marker."""
    root = _normalize_project_root(project_root)
    parsed = parse_marker(
        marker.to_dict(),
        project_root=root,
        canonical_blend_path=marker.canonical_blend_path,
    )
    cclay = root / ".cclay"
    _ensure_private_directory(cclay, root)
    destination = cclay / "prepared-transaction.json"
    _assert_no_symlink_beneath(
        destination, root, "prepared transaction marker"
    )
    if destination.exists():
        _owned_regular_file(destination, "prepared transaction marker", 0o600)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4()}.tmp")
    encoded = (
        json.dumps(parsed.to_dict(), ensure_ascii=False, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")
    descriptor = -1
    try:
        descriptor = _open_no_follow(
            temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600
        )
        view = memoryview(encoded)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short write")
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, destination)
        _fsync_directory(cclay)
    except OSError as exc:
        raise PreparedTransactionError(f"cannot write marker: {exc}") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass


def read_marker(
    project_root: str | os.PathLike[str],
    *,
    canonical_blend_path: str | os.PathLike[str] | None = None,
) -> PreparedTransactionMarker:
    """Read and parse the durable recovery marker."""
    root = _normalize_project_root(project_root)
    path = root / ".cclay" / "prepared-transaction.json"
    try:
        _owned_regular_file(path, "prepared transaction marker", 0o600)
        with path.open(encoding="utf-8") as handle:
            value = json.load(handle)
    except PreparedTransactionError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PreparedTransactionError(f"cannot read marker: {exc}") from exc
    return parse_marker(
        value,
        project_root=root,
        canonical_blend_path=canonical_blend_path,
    )


def _same_prepare_request(
    marker: PreparedTransactionMarker,
    *,
    transaction_id: str,
    project_id: str,
    operation: str,
    request_id: str,
    base_revision_id: str,
    base_scene_hash: str,
    candidate_revision_id: str,
    candidate_scene_hash: str,
    canonical_blend_path: Path,
) -> bool:
    return (
        marker.transaction_id == transaction_id
        and marker.project_id == project_id
        and marker.operation == operation
        and marker.request_id == request_id
        and marker.base_revision_id == base_revision_id
        and marker.base_scene_hash == base_scene_hash
        and marker.candidate_revision_id == candidate_revision_id
        and marker.candidate_scene_hash == candidate_scene_hash
        and marker.canonical_blend_path == str(canonical_blend_path)
    )


def prepare_transaction(
    *,
    project_root: str | os.PathLike[str],
    transaction_id: str,
    project_id: str,
    operation: str,
    request_id: str,
    base_revision_id: str,
    base_scene_hash: str,
    candidate_revision_id: str,
    candidate_scene_hash: str,
    canonical_blend_path: str | os.PathLike[str],
    read_blend_project_id: Callable[[Path], str],
    now: Callable[[], str] | None = None,
) -> PreparedTransactionMarker:
    """Verify the base backup, then durably publish the prepared marker."""
    root = _normalize_project_root(project_root)
    canonical = _normalized_absolute_path(
        os.fspath(canonical_blend_path), "canonical_blend_path"
    )
    transaction_id = _validate_uuid(transaction_id, "transaction_id")
    project_id = _validate_uuid(project_id, "project_id")
    request_id = _validate_uuid(request_id, "request_id")
    base_revision_id = _validate_hash(base_revision_id, "base_revision_id")
    base_scene_hash = _validate_hash(base_scene_hash, "base_scene_hash")
    candidate_revision_id = _validate_hash(
        candidate_revision_id, "candidate_revision_id"
    )
    candidate_scene_hash = _validate_hash(
        candidate_scene_hash, "candidate_scene_hash"
    )
    if operation not in _OPERATIONS:
        raise PreparedTransactionError(
            "operation must be stage_scene or apply_camera_plan"
        )

    existing_path = root / ".cclay" / "prepared-transaction.json"
    if existing_path.exists():
        existing = read_marker(root, canonical_blend_path=canonical)
        if _same_prepare_request(
            existing,
            transaction_id=transaction_id,
            project_id=project_id,
            operation=operation,
            request_id=request_id,
            base_revision_id=base_revision_id,
            base_scene_hash=base_scene_hash,
            candidate_revision_id=candidate_revision_id,
            candidate_scene_hash=candidate_scene_hash,
            canonical_blend_path=canonical,
        ):
            return existing
        raise PreparedTransactionError(
            "another prepared transaction marker is already active"
        )

    backup = create_base_backup(
        project_root=root,
        transaction_id=transaction_id,
        canonical_blend_path=canonical,
        project_id=project_id,
        read_blend_project_id=read_blend_project_id,
    )
    timestamp = (
        now()
        if now is not None
        else datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    payload = {
        "schema_version": 1,
        "transaction_id": transaction_id,
        "project_id": project_id,
        "operation": operation,
        "request_id": request_id,
        "base_revision_id": base_revision_id,
        "base_scene_hash": base_scene_hash,
        "candidate_revision_id": candidate_revision_id,
        "candidate_scene_hash": candidate_scene_hash,
        "canonical_blend_path": str(canonical),
        "canonical_blend_sha256": None,
        "base_backup_path": str(backup.path),
        "base_backup_sha256": backup.sha256,
        "base_backup_project_id": backup.project_id,
        "created_at": timestamp,
        "updated_at": timestamp,
        "phase": "prepared",
    }
    marker = parse_marker(
        payload, project_root=root, canonical_blend_path=canonical
    )
    write_marker(root, marker)
    return marker


def restore_base_backup(
    project_root: str | os.PathLike[str],
    marker: PreparedTransactionMarker,
    *,
    read_blend_project_id: Callable[[Path], str],
    now: Callable[[], str] | None = None,
) -> PreparedTransactionMarker:
    """Atomically restore verified base evidence and durably mark rollback_saved."""
    root = _normalize_project_root(project_root)
    marker = parse_marker(
        marker.to_dict(),
        project_root=root,
        canonical_blend_path=marker.canonical_blend_path,
    )
    if marker.phase not in ("prepared", "candidate_saved", "rollback_saved"):
        raise PreparedTransactionError(
            f"cannot restore base backup from {marker.phase} phase"
        )
    backup = _verify_backup(
        Path(marker.base_backup_path),
        marker.base_backup_sha256,
        marker.project_id,
        read_blend_project_id,
    )
    canonical = Path(marker.canonical_blend_path)
    _assert_no_symlink_beneath(canonical, root, "canonical_blend_path")
    if canonical.exists():
        _owned_regular_file(canonical, "canonical blend")
        # The canonical blend may have been rewritten (by a later legitimate
        # commit, or by a raw script/manual save entirely outside this
        # transaction) since this marker last recorded what it expected to
        # find there. Restoring the base backup on top of that unrecognized
        # content would silently discard real work - refuse and require an
        # operator to triage instead of overwriting blind.
        expected_pre_restore_sha256 = (
            marker.canonical_blend_sha256
            if marker.canonical_blend_sha256 is not None
            else marker.base_backup_sha256
        )
        observed_pre_restore_sha256 = _sha256_file(canonical, "canonical blend")
        if observed_pre_restore_sha256 != expected_pre_restore_sha256:
            raise PreparedTransactionError(
                "canonical blend does not match this transaction's last known "
                "state - it was rewritten after the marker was written, so "
                "restoring the base backup would silently discard that newer "
                "work. This requires operator intervention: back up the "
                "current canonical blend if it holds real work, then clear "
                f"{marker_path(root)} and its transaction directory before "
                "retrying."
            )
    try:
        digest = _atomic_copy(backup.path, canonical, "base backup restore")
    except PreparedTransactionError as exc:
        raise PreparedTransactionError(f"cannot restore base backup: {exc}") from exc
    if digest != backup.sha256 or _sha256_file(canonical, "restored canonical blend") != backup.sha256:
        raise PreparedTransactionError("restored canonical blend SHA-256 is invalid")
    _inspect_project_id(
        canonical,
        marker.project_id,
        read_blend_project_id,
        "restored canonical blend",
    )
    timestamp = (
        now()
        if now is not None
        else datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    restored = parse_marker(
        replace(
            marker,
            canonical_blend_sha256=backup.sha256,
            updated_at=timestamp,
            phase="rollback_saved",
        ).to_dict(),
        project_root=root,
        canonical_blend_path=canonical,
    )
    write_marker(root, restored)
    return restored


def _updated_timestamp(now: Callable[[], str] | None) -> str:
    return (
        now()
        if now is not None
        else datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def save_candidate(
    project_root: str | os.PathLike[str],
    marker: PreparedTransactionMarker,
    *,
    save_blend: Callable[[Path], object],
    read_blend_project_id: Callable[[Path], str],
    now: Callable[[], str] | None = None,
) -> PreparedTransactionMarker:
    """Save, fsync, hash, and project-bind the canonical candidate blend."""
    root = _normalize_project_root(project_root)
    marker = parse_marker(
        marker.to_dict(),
        project_root=root,
        canonical_blend_path=marker.canonical_blend_path,
    )
    if marker.phase == "candidate_saved":
        canonical = Path(marker.canonical_blend_path)
        observed = _sha256_file(canonical, "canonical candidate blend")
        if observed != marker.canonical_blend_sha256:
            raise PreparedTransactionError(
                "canonical candidate blend SHA-256 does not match marker"
            )
        _inspect_project_id(
            canonical,
            marker.project_id,
            read_blend_project_id,
            "canonical candidate blend",
        )
        return marker
    if marker.phase != "prepared":
        raise PreparedTransactionError(
            f"cannot save candidate blend from {marker.phase} phase"
        )

    canonical = Path(marker.canonical_blend_path)
    _assert_no_symlink_beneath(canonical, root, "canonical_blend_path")
    try:
        save_blend(canonical)
    except Exception as exc:
        raise PreparedTransactionError(f"cannot save candidate blend: {exc}") from exc
    _owned_regular_file(canonical, "canonical candidate blend")
    descriptor = -1
    try:
        descriptor = _open_no_follow(canonical, os.O_RDONLY)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        _fsync_directory(canonical.parent)
    except OSError as exc:
        raise PreparedTransactionError(
            f"cannot fsync canonical candidate blend: {exc}"
        ) from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    digest = _sha256_file(canonical, "canonical candidate blend")
    _inspect_project_id(
        canonical,
        marker.project_id,
        read_blend_project_id,
        "canonical candidate blend",
    )
    candidate = parse_marker(
        replace(
            marker,
            canonical_blend_sha256=digest,
            updated_at=_updated_timestamp(now),
            phase="candidate_saved",
        ).to_dict(),
        project_root=root,
        canonical_blend_path=canonical,
    )
    write_marker(root, candidate)
    return candidate


def recover_candidate_authority(
    project_root: str | os.PathLike[str],
    marker: PreparedTransactionMarker,
    *,
    read_blend_project_id: Callable[[Path], str],
    read_blend_scene_hash: Callable[[Path], str],
    now: Callable[[], str] | None = None,
) -> PreparedTransactionMarker:
    """Verify the authoritative candidate and repair only a pre-phase marker."""

    root = _normalize_project_root(project_root)
    marker = parse_marker(
        marker.to_dict(),
        project_root=root,
        canonical_blend_path=marker.canonical_blend_path,
    )
    if marker.phase not in (
        "prepared",
        "candidate_saved",
        "manifest_committed",
        "acknowledged",
    ):
        raise PreparedTransactionError(
            f"cannot recover candidate authority from {marker.phase} phase"
        )
    canonical = Path(marker.canonical_blend_path)
    digest = _sha256_file(canonical, "canonical candidate blend")
    _inspect_project_id(
        canonical,
        marker.project_id,
        read_blend_project_id,
        "canonical candidate blend",
    )
    observed_scene_hash = read_blend_scene_hash(canonical)
    if observed_scene_hash != marker.candidate_scene_hash:
        raise PreparedTransactionError(
            "canonical candidate scene hash does not match marker"
        )
    if marker.phase == "prepared":
        if digest == marker.base_backup_sha256:
            raise PreparedTransactionError(
                "authoritative candidate is indistinguishable from the base backup"
            )
        repaired = parse_marker(
            replace(
                marker,
                canonical_blend_sha256=digest,
                updated_at=_updated_timestamp(now),
                phase="candidate_saved",
            ).to_dict(),
            project_root=root,
            canonical_blend_path=canonical,
        )
        write_marker(root, repaired)
        return repaired
    if digest != marker.canonical_blend_sha256:
        raise PreparedTransactionError(
            "canonical candidate blend SHA-256 does not match marker"
        )
    return marker

def advance_marker(
    project_root: str | os.PathLike[str],
    marker: PreparedTransactionMarker,
    phase: str,
    *,
    now: Callable[[], str] | None = None,
) -> PreparedTransactionMarker:
    """Advance candidate durability through the exact committed phase chain."""
    root = _normalize_project_root(project_root)
    marker = parse_marker(
        marker.to_dict(),
        project_root=root,
        canonical_blend_path=marker.canonical_blend_path,
    )
    if phase not in ("manifest_committed", "acknowledged"):
        raise PreparedTransactionError("committed phase transition is invalid")
    if marker.phase == phase:
        return marker
    expected = {
        "manifest_committed": "candidate_saved",
        "acknowledged": "manifest_committed",
    }[phase]
    if marker.phase != expected:
        raise PreparedTransactionError(
            f"cannot advance marker from {marker.phase} to {phase}"
        )
    canonical = Path(marker.canonical_blend_path)
    observed = _sha256_file(canonical, "canonical candidate blend")
    if observed != marker.canonical_blend_sha256:
        raise PreparedTransactionError(
            "canonical candidate blend SHA-256 does not match marker"
        )
    advanced = parse_marker(
        replace(
            marker,
            updated_at=_updated_timestamp(now),
            phase=phase,
        ).to_dict(),
        project_root=root,
        canonical_blend_path=canonical,
    )
    write_marker(root, advanced)
    return advanced


def cleanup_transaction(
    project_root: str | os.PathLike[str],
    marker: PreparedTransactionMarker,
    *,
    read_blend_project_id: Callable[[Path], str],
) -> None:
    """Verify terminal authority, then durably remove marker and backup evidence."""
    root = _normalize_project_root(project_root)
    marker = parse_marker(
        marker.to_dict(),
        project_root=root,
        canonical_blend_path=marker.canonical_blend_path,
    )
    if marker.phase not in ("acknowledged", "rollback_saved"):
        raise PreparedTransactionError(
            f"cannot clean transaction from {marker.phase} phase"
        )
    backup = _verify_backup(
        Path(marker.base_backup_path),
        marker.base_backup_sha256,
        marker.project_id,
        read_blend_project_id,
    )
    canonical = Path(marker.canonical_blend_path)
    observed = _sha256_file(canonical, "canonical blend")
    if observed != marker.canonical_blend_sha256:
        raise PreparedTransactionError("canonical blend SHA-256 does not match marker")
    _inspect_project_id(
        canonical,
        marker.project_id,
        read_blend_project_id,
        "canonical blend",
    )

    marker_file = root / ".cclay" / "prepared-transaction.json"
    transaction_directory = backup.path.parent
    transactions_directory = transaction_directory.parent
    try:
        marker_file.unlink()
        _fsync_directory(marker_file.parent)
        backup.path.unlink()
        _fsync_directory(transaction_directory)
        transaction_directory.rmdir()
        _fsync_directory(transactions_directory)
    except OSError as exc:
        raise PreparedTransactionError(
            f"cannot clean prepared transaction evidence: {exc}"
        ) from exc

def reconcile_decision(
    marker_phase: str, evidence: StoreEvidence | str
) -> ReconcileDecision:
    """Return the controlling 20-row recovery decision without side effects."""
    if marker_phase not in _PHASES:
        raise PreparedTransactionError("transaction phase is invalid")
    try:
        evidence = StoreEvidence(evidence)
    except ValueError as exc:
        raise PreparedTransactionError("store evidence class is invalid") from exc

    unknown = ReconcileDecision("unknown", "none", "none", True)
    if evidence is StoreEvidence.CONFLICT:
        return unknown
    if marker_phase in ("prepared", "candidate_saved"):
        if evidence is StoreEvidence.BASE:
            return ReconcileDecision(
                "base_authoritative", "none", "restore_base_backup", False
            )
        return ReconcileDecision(
            "candidate_authoritative",
            "journal_forward"
            if evidence is StoreEvidence.JOURNAL_FORWARD
            else "none",
            "verify_candidate_and_mark_manifest_committed",
            False,
        )
    if marker_phase == "manifest_committed":
        if evidence is StoreEvidence.BASE:
            return unknown
        return ReconcileDecision(
            "candidate_authoritative",
            "journal_forward"
            if evidence is StoreEvidence.JOURNAL_FORWARD
            else "none",
            "request_committed_ack",
            False,
        )
    if marker_phase == "acknowledged":
        if evidence is StoreEvidence.BASE:
            return unknown
        return ReconcileDecision(
            "candidate_authoritative",
            "journal_forward"
            if evidence is StoreEvidence.JOURNAL_FORWARD
            else "none",
            "send_acknowledged_and_clean",
            False,
        )
    if evidence is StoreEvidence.BASE:
        return ReconcileDecision(
            "base_authoritative", "none", "verify_base_and_clean", False
        )
    # rollback_saved + J is phase-inconsistent conflict. It must not forward.
    return unknown


def execute_reconcile(
    marker_phase: str,
    evidence: StoreEvidence | str,
    *,
    journal_forward: Callable[[], None],
    blender_action: Callable[[str], None],
) -> ReconcileDecision:
    """Apply only actions permitted by the pure reconciliation decision.

    Every C/unknown row returns before either callback, enforcing zero store and
    Blender mutation. In particular, rollback_saved plus journal evidence is
    classified as conflict before journal-forward precedence.
    """
    decision = reconcile_decision(marker_phase, evidence)
    if decision.status == "unknown":
        return decision
    if decision.store_action == "journal_forward":
        journal_forward()
    if decision.blender_action != "none":
        blender_action(decision.blender_action)
    return decision
