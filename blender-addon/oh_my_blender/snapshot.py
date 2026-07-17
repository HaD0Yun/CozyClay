"""Blender-independent assembly and hashing for Scene Snapshot v2."""

from __future__ import annotations

import copy
import math
from collections.abc import Sequence

from .canonical import canonical_json, canonical_revision

MAX_SNAPSHOT_BYTES = 1_048_576
MAX_MAGNITUDE = 1e15


class ExportError(ValueError):
    """An export failure with a stable machine-readable code."""

    code = "EXPORT_ERROR"

    def __init__(self, message: str = "") -> None:
        super().__init__(message or self.code)
        self.code = type(self).code


class EXPORT_NONFINITE(ExportError):
    code = "EXPORT_NONFINITE"


class EXPORT_MAGNITUDE(ExportError):
    code = "EXPORT_MAGNITUDE"


class UNSUPPORTED_FPS_BASE(ExportError):
    code = "UNSUPPORTED_FPS_BASE"


class UNSUPPORTED_LINKED_DATABLOCK(ExportError):
    code = "UNSUPPORTED_LINKED_DATABLOCK"


class UNSUPPORTED_FCURVE_FEATURE(ExportError):
    code = "UNSUPPORTED_FCURVE_FEATURE"


class SNAPSHOT_TOO_LARGE(ExportError):
    code = "SNAPSHOT_TOO_LARGE"


class UNSUPPORTED_PLAN_UP(ExportError):
    code = "UNSUPPORTED_PLAN_UP"


def canonical_quaternion(values: Sequence[float]) -> list[float]:
    """Normalize and sign-canonicalize a ``[w, x, y, z]`` quaternion."""
    if len(values) != 4:
        raise ValueError("quaternion must contain exactly four components")
    quaternion = [float(value) for value in values]
    if not all(math.isfinite(value) for value in quaternion):
        raise EXPORT_NONFINITE("quaternion contains NaN or infinity")
    length = math.hypot(*quaternion)
    if length == 0.0:
        raise ValueError("quaternion must have nonzero length")
    normalized = [value / length for value in quaternion]
    first_nonzero = next((value for value in normalized if value != 0.0), 0.0)
    if first_nonzero < 0.0:
        normalized = [-value for value in normalized]
    return [0.0 if value == 0.0 else value for value in normalized]


def _validate_numbers(value: object, path: str = "snapshot") -> None:
    if isinstance(value, bool):
        return
    if isinstance(value, float) and not math.isfinite(value):
        raise EXPORT_NONFINITE(f"{path} contains NaN or infinity")
    if isinstance(value, (int, float)):
        if abs(value) >= MAX_MAGNITUDE:
            raise EXPORT_MAGNITUDE(f"{path} has magnitude >= 1e15")
        return
    if isinstance(value, dict):
        for key, nested in value.items():
            _validate_numbers(nested, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, nested in enumerate(value):
            _validate_numbers(nested, f"{path}[{index}]")


def assemble_snapshot(
    scene: dict,
    render: dict,
    objects: list[dict],
    cameras: list[dict],
    markers: list[dict],
    animations: list[dict],
) -> dict:
    """Assemble plain extracted parts into a semantically ordered snapshot."""
    sorted_animations = copy.deepcopy(animations)
    for animation in sorted_animations:
        for fcurve in animation["fcurves"]:
            fcurve["keyframes"].sort(key=lambda keyframe: keyframe["frame"])
        animation["fcurves"].sort(key=lambda fcurve: (fcurve["dataPath"], fcurve["arrayIndex"]))

    snapshot = {
        "schemaVersion": 2,
        "scene": copy.deepcopy(scene),
        "render": copy.deepcopy(render),
        "objects": sorted(copy.deepcopy(objects), key=lambda item: item["name"]),
        "cameras": sorted(copy.deepcopy(cameras), key=lambda item: item["name"]),
        "markers": sorted(
            copy.deepcopy(markers),
            key=lambda item: (item["name"], item["frame"], item["camera"] or ""),
        ),
        "animations": sorted(
            sorted_animations,
            key=lambda item: (item["objectName"], item["target"]),
        ),
    }
    _validate_numbers(snapshot)
    if len(canonical_json(snapshot).encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        raise SNAPSHOT_TOO_LARGE("canonical snapshot exceeds 1 MiB")
    return snapshot


def snapshot_revision(snapshot: dict) -> str:
    """Return the canonical SHA-256 revision of a snapshot."""
    return canonical_revision(snapshot)
