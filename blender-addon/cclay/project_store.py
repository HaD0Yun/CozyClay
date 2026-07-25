"""Durable, dependency-free storage for Blender project identity metadata."""

import json
import os
import tempfile
from collections.abc import Iterable
from pathlib import Path

from .identity import IdentityError, assign_entity_ids, validate_project_ids


class ProjectStoreError(ValueError):
    """The persisted project index or journal operation is invalid."""


def _cclay_directory(directory: str) -> Path:
    return Path(directory) / ".cclay"


def read_project_index(directory: str) -> dict | None:
    """Read and validate the current project index, if one exists."""
    path = _cclay_directory(directory) / "project.json"
    try:
        with path.open(encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProjectStoreError(f"cannot read project index: {exc}") from exc
    if not isinstance(value, dict):
        raise ProjectStoreError("project index must be a JSON object")
    try:
        validate_project_ids(value.get("project_id"), value.get("project_id"))
    except IdentityError as exc:
        raise ProjectStoreError(f"invalid project index: {exc}") from exc
    return value


def write_project_index(directory: str, project_id: str, extra: dict | None = None) -> None:
    """Atomically and durably replace the current project index."""
    try:
        validate_project_ids(project_id, project_id)
    except IdentityError as exc:
        raise ProjectStoreError(f"invalid project_id: {exc}") from exc
    if extra is not None and not isinstance(extra, dict):
        raise ProjectStoreError("project index extra fields must be a dict")

    cclay_directory = _cclay_directory(directory)
    final_path = cclay_directory / "project.json"
    temporary_path: str | None = None
    try:
        cclay_directory.mkdir(parents=True, exist_ok=True)
        payload = dict(extra or {})
        payload["project_id"] = project_id
        descriptor, temporary_path = tempfile.mkstemp(
            prefix=".project.json.", suffix=".tmp", dir=cclay_directory
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, final_path)
        temporary_path = None
        directory_descriptor = os.open(cclay_directory, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except (OSError, TypeError, ValueError) as exc:
        raise ProjectStoreError(f"cannot write project index: {exc}") from exc
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass


def append_journal(directory: str, entry: dict) -> None:
    """Append and fsync exactly one compact JSON journal record."""
    if not isinstance(entry, dict) or not isinstance(entry.get("type"), str) or not entry["type"]:
        raise ProjectStoreError("journal entry requires a nonempty type")
    try:
        line = json.dumps(entry, separators=(",", ":")) + "\n"
        cclay_directory = _cclay_directory(directory)
        cclay_directory.mkdir(parents=True, exist_ok=True)
        with (cclay_directory / "journal.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())
    except (OSError, TypeError, ValueError) as exc:
        raise ProjectStoreError(f"cannot append project journal: {exc}") from exc


def verify_project_ids_match(scene_project_id: object, stored_project_id: object) -> None:
    """Raise IdentityError unless both persisted project IDs are equal UUIDv4s."""
    validate_project_ids(scene_project_id, stored_project_id)


def verify_connect_precondition(
    directory: str, scene_project_id: object, is_dirty: bool
) -> None:
    """Refuse a connection unless saved state and durable identity agree."""
    if is_dirty:
        raise ProjectStoreError("Save unsaved changes before connecting")
    stored = read_project_index(directory)
    if stored is None:
        raise ProjectStoreError("Project is not initialized in .cclay/project.json")
    verify_project_ids_match(scene_project_id, stored.get("project_id"))


def prepare_project_index(
    directory: str,
    scene_project_id: str,
    project_created: bool,
    manifest: dict | None = None,
) -> bool:
    """Persist a missing or legacy index, or verify a durable document unchanged."""
    stored = read_project_index(directory)
    if project_created and stored is not None:
        raise ProjectStoreError(
            ".cclay/project.json already exists; use an explicit recovery step, "
            "not Initialize Project"
        )
    if stored is not None:
        verify_project_ids_match(scene_project_id, stored.get("project_id"))
        if "current_revision_id" in stored:
            return False
    if manifest is None:
        raise ProjectStoreError(
            "scene manifest is required to create or upgrade project index"
        )
    else:
        revision_id = manifest.get("revisionId") if isinstance(manifest, dict) else None
        if not isinstance(revision_id, str) or not revision_id:
            raise ProjectStoreError("scene manifest requires a nonempty revisionId")
        write_project_index(
            directory,
            scene_project_id,
            {
                "schema_version": 1,
                "current_revision_id": revision_id,
                "manifest": manifest,
            },
        )
    return True


def apply_property_assignments(
    entities: dict[str, object], assignments: dict[str, str]
) -> list[tuple[object, bool, object]]:
    """Apply ID-property assignments while retaining exact rollback state."""
    originals = []
    for key, value in assignments.items():
        entity = entities[key]
        existed = "cclay.entity_id" in entity  # type: ignore[operator]
        original = entity.get("cclay.entity_id") if existed else None  # type: ignore[attr-defined]
        originals.append((entity, existed, original))
        entity["cclay.entity_id"] = value  # type: ignore[index]
    return originals


def restore_property_assignments(
    originals: Iterable[tuple[object, bool, object]],
) -> None:
    """Restore ID properties, deleting keys which were originally absent."""
    for entity, existed, original in originals:
        if existed:
            entity["cclay.entity_id"] = original  # type: ignore[index]
        elif "cclay.entity_id" in entity:  # type: ignore[operator]
            del entity["cclay.entity_id"]  # type: ignore[attr-defined]


def repair_entity_ids(entries: Iterable[tuple[str, object]]) -> dict[str, str]:
    """Return fresh-ID assignments using serialized first-owner-keeps-it order."""
    existing: dict[str, object] = {}
    keys: list[str] = []
    for key, entity_id in entries:
        if key in existing:
            raise ProjectStoreError(f"duplicate entity key: {key}")
        existing[key] = entity_id
        keys.append(key)
    return assign_entity_ids(existing, keys)  # type: ignore[arg-type]
