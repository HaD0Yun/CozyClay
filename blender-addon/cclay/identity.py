"""Pure stable-identity helpers used by Blender operators."""

import re
import uuid
from collections.abc import Iterable, Mapping

_UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


class IdentityError(ValueError):
    """Persistent project or entity identity is invalid."""


def new_project_id() -> str:
    return str(uuid.uuid4())


def assign_entity_ids(existing_map: Mapping[str, str], names: Iterable[str]) -> dict[str, str]:
    """Return assignments needed for new names and later duplicate IDs.

    Input order is Blender's stable serialized data-block order; the first owner
    of an ID retains it.
    """
    assignments: dict[str, str] = {}
    seen: set[str] = set()
    for name in names:
        current = existing_map.get(name)
        if isinstance(current, str) and _UUID4.fullmatch(current) and current not in seen:
            seen.add(current)
            continue
        fresh = new_project_id()
        while fresh in seen:
            fresh = new_project_id()
        assignments[name] = fresh
        seen.add(fresh)
    return assignments


def validate_project_ids(scene_prop: object, store_prop: object) -> str:
    if not isinstance(scene_prop, str) or not _UUID4.fullmatch(scene_prop):
        raise IdentityError("scene project_id is missing or malformed")
    if not isinstance(store_prop, str) or not _UUID4.fullmatch(store_prop):
        raise IdentityError("stored project_id is missing or malformed")
    if scene_prop != store_prop:
        raise IdentityError("scene and persisted project_id do not match")
    return scene_prop
