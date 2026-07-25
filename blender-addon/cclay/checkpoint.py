"""Scoped value snapshots for Blender mutation rollback."""

import copy
from dataclasses import dataclass
import hashlib
import json
from typing import Callable


class CheckpointError(RuntimeError):
    """A checkpoint cannot be created, restored, or verified."""


@dataclass(frozen=True)
class Checkpoint:
    """An in-memory value snapshot and its deterministic pre-state hash."""

    _entities: dict[str, dict]
    state_hash: str

    @property
    def entities(self) -> dict[str, dict]:
        """Return a fresh copy so callers cannot mutate the retained snapshot."""
        return copy.deepcopy(self._entities)


def _state_hash(entities: dict[str, dict]) -> str:
    try:
        encoded = json.dumps(
            entities,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise CheckpointError(f"checkpoint values are not JSON-serializable: {exc}") from exc
    return hashlib.sha256(encoded).hexdigest()


def create_checkpoint(entities: dict[str, dict]) -> Checkpoint:
    """Copy scoped entity values so later caller mutations cannot alter the snapshot."""
    if not isinstance(entities, dict) or not all(
        isinstance(key, str) and isinstance(values, dict)
        for key, values in entities.items()
    ):
        raise CheckpointError("checkpoint entities must map string keys to value dictionaries")
    snapshot = copy.deepcopy(entities)
    return Checkpoint(snapshot, _state_hash(snapshot))


def restore(
    checkpoint: Checkpoint, apply_fn: Callable[[str, dict], None]
) -> None:
    """Rewrite every scoped entity to its checkpoint values."""
    try:
        for entity_key, values in checkpoint.entities.items():
            apply_fn(entity_key, copy.deepcopy(values))
    except Exception as exc:
        raise CheckpointError(f"checkpoint restore failed for {entity_key}: {exc}") from exc


def verify(checkpoint: Checkpoint, read_fn: Callable[[str], dict]) -> bool:
    """Return whether current scoped values exactly match the checkpoint hash."""
    current = {}
    try:
        for entity_key in checkpoint.entities:
            values = read_fn(entity_key)
            if not isinstance(values, dict):
                raise TypeError("read_fn must return a value dictionary")
            current[entity_key] = values
    except Exception as exc:
        raise CheckpointError(f"checkpoint verification failed for {entity_key}: {exc}") from exc
    return _state_hash(current) == checkpoint.state_hash
