"""Generated pure hand-shape preset library. Do not edit by hand.

Source: blender-addon/calibration/hand-shapes-v1.json
Regenerate with scripts/generate_hand_shape_library.py.
"""

from __future__ import annotations

import math
from types import MappingProxyType
from typing import Iterable, Mapping, Sequence

LIBRARY_VERSION = "1.1.0"
CANONICAL_ROLES = (
    "Thumb1", "Thumb2", "Thumb3", "Thumb4",
    "Index1", "Index2", "Index3", "Index4",
    "Middle1", "Middle2", "Middle3", "Middle4",
    "Ring1", "Ring2", "Ring3", "Ring4",
    "Pinky1", "Pinky2", "Pinky3", "Pinky4",
)
CANONICAL_ROLE_ORDER = CANONICAL_ROLES
PRESET_NAMES = (
    "relaxed", "open", "fist", "soft_fist", "point", "two_finger",
    "cup", "grasp", "thumb_extended", "three_finger", "hook",
)
_FINGERS = ("Thumb", "Index", "Middle", "Ring", "Pinky")
_SIDES = ("left", "right")
_FLEXION_ADAPTERS = {
    "left": {"Thumb1": (1, 0, 0), "Thumb2": (1, 0, 0), "Thumb3": (1, 0, 0), "Thumb4": (1, 0, 0), "Index1": (1, 0, 0), "Index2": (1, 0, 0), "Index3": (1, 0, 0), "Index4": (1, 0, 0), "Middle1": (1, 0, 0), "Middle2": (1, 0, 0), "Middle3": (1, 0, 0), "Middle4": (1, 0, 0), "Ring1": (1, 0, 0), "Ring2": (1, 0, 0), "Ring3": (1, 0, 0), "Ring4": (1, 0, 0), "Pinky1": (1, 0, 0), "Pinky2": (1, 0, 0), "Pinky3": (1, 0, 0), "Pinky4": (1, 0, 0)},
    "right": {"Thumb1": (-1, 0, 0), "Thumb2": (-1, 0, 0), "Thumb3": (-1, 0, 0), "Thumb4": (-1, 0, 0), "Index1": (-1, 0, 0), "Index2": (-1, 0, 0), "Index3": (-1, 0, 0), "Index4": (-1, 0, 0), "Middle1": (-1, 0, 0), "Middle2": (-1, 0, 0), "Middle3": (-1, 0, 0), "Middle4": (-1, 0, 0), "Ring1": (-1, 0, 0), "Ring2": (-1, 0, 0), "Ring3": (-1, 0, 0), "Ring4": (-1, 0, 0), "Pinky1": (-1, 0, 0), "Pinky2": (-1, 0, 0), "Pinky3": (-1, 0, 0), "Pinky4": (-1, 0, 0)},
}
_IDENTITY = (1.0, 0.0, 0.0, 0.0)

# Calibrated local flexion angles in degrees. The calibration JSON is the numeric authority.
_CHANNELS = {
    "relaxed": {"left": ((8, 12, 8, 0), (4, 10, 16, 17), (3, 18, 15, 22), (2, 18, 26, 16), (4, 20, 8, 19)), "right": ((8, 12, 8, 0), (4, 10, 16, 17), (3, 18, 15, 22), (2, 18, 26, 16), (4, 20, 8, 19))},
    "open": {"left": ((0, 0, 0, 0), (0, 0, 0, 0), (0, 0, 0, 0), (0, 0, 0, 0), (0, 0, 0, 0)), "right": ((0, 0, 0, 0), (0, 0, 0, 0), (0, 0, 0, 0), (0, 0, 0, 0), (0, 0, 0, 0))},
    "fist": {"left": ((24, 42, 32, 0), (60, 55, 35, 0), (60, 55, 35, 0), (60, 55, 35, 0), (60, 55, 35, 0)), "right": ((24, 42, 32, 0), (60, 55, 35, 0), (60, 55, 35, 0), (60, 55, 35, 0), (60, 55, 35, 0))},
    "soft_fist": {"left": ((16, 28, 22, 0), (40, 40, 25, 0), (40, 40, 25, 0), (40, 40, 25, 0), (40, 40, 25, 0)), "right": ((16, 28, 22, 0), (40, 40, 25, 0), (40, 40, 25, 0), (40, 40, 25, 0), (40, 40, 25, 0))},
    "point": {"left": ((12, 20, 14, 0), (0, 0, 0, 0), (60, 55, 35, 0), (60, 55, 35, 0), (60, 55, 35, 0)), "right": ((12, 20, 14, 0), (0, 0, 0, 0), (60, 55, 35, 0), (60, 55, 35, 0), (60, 55, 35, 0))},
    "two_finger": {"left": ((10, 16, 10, 0), (0, 0, 0, 0), (0, 0, 0, 0), (60, 55, 35, 0), (60, 55, 35, 0)), "right": ((10, 16, 10, 0), (0, 0, 0, 0), (0, 0, 0, 0), (60, 55, 35, 0), (60, 55, 35, 0))},
    "cup": {"left": ((18, 24, 16, 0), (20, 25, 15, 0), (24, 28, 18, 0), (28, 32, 20, 0), (34, 36, 22, 0)), "right": ((18, 24, 16, 0), (20, 25, 15, 0), (24, 28, 18, 0), (28, 32, 20, 0), (34, 36, 22, 0))},
    "grasp": {"left": ((26, 34, 24, 0), (45, 45, 30, 0), (45, 45, 30, 0), (45, 45, 30, 0), (45, 45, 30, 0)), "right": ((26, 34, 24, 0), (45, 45, 30, 0), (45, 45, 30, 0), (45, 45, 30, 0), (45, 45, 30, 0))},
    "thumb_extended": {"left": ((-28, -12, -8, 0), (55, 50, 30, 0), (55, 50, 30, 0), (55, 50, 30, 0), (55, 50, 30, 0)), "right": ((-28, -12, -8, 0), (55, 50, 30, 0), (55, 50, 30, 0), (55, 50, 30, 0), (55, 50, 30, 0))},
    "three_finger": {"left": ((10, 14, 8, 0), (0, 0, 0, 0), (0, 0, 0, 0), (0, 0, 0, 0), (60, 55, 35, 0)), "right": ((10, 14, 8, 0), (0, 0, 0, 0), (0, 0, 0, 0), (0, 0, 0, 0), (60, 55, 35, 0))},
    "hook": {"left": ((8, 12, 8, 0), (15, 70, 45, 0), (15, 70, 45, 0), (15, 70, 45, 0), (15, 70, 45, 0)), "right": ((8, 12, 8, 0), (15, 70, 45, 0), (15, 70, 45, 0), (15, 70, 45, 0), (15, 70, 45, 0))},
}
PRESET_LIBRARY = MappingProxyType({
    name: MappingProxyType({
        side: MappingProxyType({finger: values[side][index] for index, finger in enumerate(_FINGERS)})
        for side in _SIDES
    })
    for name, values in _CHANNELS.items()
})


# Bounded like every other wire array: a hand track is a few beats per side, not
# a per-frame curve. Declared below PRESET_LIBRARY on purpose — everything above
# that marker is spliced out by scripts/generate_hand_shape_library.py.
MAX_HAND_TRACK_KEYS = 32


class HandShapeError(ValueError):
    """A hand-shape request failed closed validation."""


def _preset_name(value: object, side: str) -> str:
    name = "relaxed" if value is None else value
    if not isinstance(name, str) or name not in PRESET_LIBRARY:
        raise HandShapeError(f"unknown {side} hand-shape preset: {name!r}")
    return name


def resolve_hand_shapes(left: object = None, right: object = None) -> dict[str, str]:
    """Resolve independent side presets, defaulting only omitted sides to relaxed."""
    return {"left": _preset_name(left, "left"), "right": _preset_name(right, "right")}


def resolve_hand_track(
    left: object = None, right: object = None, frame_count: object = None
) -> dict[str, tuple[tuple[int, str], ...]]:
    """Validate a per-side preset keyframe track against a clip length.

    A track is ``[{"frame": <clip frame>, "preset": <name>}, ...]`` per side.
    Frames are 0-based CLIP frames — the same space as ``preflight_motion``
    contact windows and the ARDY constraint targets — so the caller never has to
    convert a contact into scene frames twice.

    Interpolation between two keys is left to Blender on purpose: every preset
    is a pure flexion of a fixed per-joint axis (see ``_FLEXION_ADAPTERS``), so
    two presets differ only in angle about the SAME axis. Sliding between them
    is a monotonic angle ramp with no shortest-path ambiguity, which is why a
    sparse track is exact here rather than an approximation.

    Returns a dict with both sides; a side with no track resolves to ``()``.
    """
    if not isinstance(frame_count, int) or isinstance(frame_count, bool) or frame_count < 1:
        raise HandShapeError("hand track needs a positive integer clip frame count")
    resolved: dict[str, tuple[tuple[int, str], ...]] = {}
    for side, requested in (("left", left), ("right", right)):
        if requested is None:
            resolved[side] = ()
            continue
        if not isinstance(requested, (list, tuple)):
            raise HandShapeError(f"{side} hand track must be a list of keys")
        if not requested:
            raise HandShapeError(
                f"{side} hand track must not be empty; omit the side instead"
            )
        if len(requested) > MAX_HAND_TRACK_KEYS:
            raise HandShapeError(
                f"{side} hand track has {len(requested)} keys, at most "
                f"{MAX_HAND_TRACK_KEYS} are allowed"
            )
        keys: list[tuple[int, str]] = []
        previous_frame = None
        for index, entry in enumerate(requested):
            if not isinstance(entry, dict) or set(entry) != {"frame", "preset"}:
                raise HandShapeError(
                    f"{side} hand track key {index} must contain exactly frame and preset"
                )
            frame = entry["frame"]
            if not isinstance(frame, int) or isinstance(frame, bool):
                raise HandShapeError(
                    f"{side} hand track key {index} frame must be an integer"
                )
            if not 0 <= frame < frame_count:
                raise HandShapeError(
                    f"{side} hand track key {index} frame {frame} is outside the clip "
                    f"(0..{frame_count - 1})"
                )
            if previous_frame is not None and frame <= previous_frame:
                raise HandShapeError(
                    f"{side} hand track frames must strictly increase; key {index} "
                    f"frame {frame} does not follow {previous_frame}"
                )
            previous_frame = frame
            keys.append((frame, _preset_name(entry["preset"], side)))
        resolved[side] = tuple(keys)
    if not resolved["left"] and not resolved["right"]:
        raise HandShapeError("hand track must describe at least one side")
    return resolved


def track_role_keys(
    track: Sequence[tuple[int, str]], side: str
) -> dict[str, tuple[tuple[int, tuple[float, float, float, float]], ...]]:
    """Expand one side's track into per-role (clip frame, delta quaternion) keys.

    Roles whose delta is identity at EVERY key are dropped: they need no curve.
    A role that is identity at some keys and not others keeps all of its keys,
    including the identity ones — dropping those would make Blender hold the
    non-identity value across the whole clip and silently defeat the track.
    """
    per_role: dict[str, list[tuple[int, tuple[float, float, float, float]]]] = {}
    for frame, preset in track:
        deltas = preset_deltas(**{side: preset})[side]
        for role, delta in deltas.items():
            per_role.setdefault(role, []).append((frame, delta))
    result = {}
    for role, keys in per_role.items():
        if all(
            all(abs(value - expected) <= 1e-12 for value, expected in zip(delta, _IDENTITY))
            for _, delta in keys
        ):
            continue
        result[role] = tuple(keys)
    return result


def validate_rig_bones(
    character_type: object, bone_names: Iterable[str]
) -> dict[str, dict[str, str]]:
    """Return the exact bilateral Mixamo bone inventory present on a supported rig."""
    if character_type not in ("Y_BOT", "X_BOT"):
        raise HandShapeError(f"unknown character type: {character_type!r}")
    try:
        available = set(bone_names)
    except TypeError as exc:
        raise HandShapeError("bone_names must be an iterable of strings") from exc
    if any(not isinstance(name, str) for name in available):
        raise HandShapeError("bone_names must contain only strings")
    result: dict[str, dict[str, str]] = {}
    missing: list[str] = []
    for side in _SIDES:
        side_title = side.title()
        resolved: dict[str, str] = {}
        for role in CANONICAL_ROLES:
            unprefixed = f"{side_title}Hand{role}"
            prefixed = f"mixamorig:{unprefixed}"
            if prefixed in available:
                resolved[role] = prefixed
            elif unprefixed in available:
                resolved[role] = unprefixed
            else:
                missing.append(prefixed)
        result[side] = resolved
    if missing:
        raise HandShapeError("rig is missing canonical hand bones: " + ", ".join(missing))
    return result


def _canonicalize(quaternion: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    for component in quaternion:
        if component != 0.0:
            if component < 0.0:
                return tuple(-value for value in quaternion)  # type: ignore[return-value]
            break
    return quaternion


def normalize_quaternion(values: Sequence[float]) -> tuple[float, float, float, float]:
    """Validate, normalize, and canonicalize a wxyz quaternion."""
    if isinstance(values, (str, bytes)):
        raise HandShapeError("quaternion must contain exactly four components")
    try:
        if len(values) != 4:
            raise HandShapeError("quaternion must contain exactly four components")
        quaternion = tuple(float(value) for value in values)
    except HandShapeError:
        raise
    except (TypeError, ValueError) as exc:
        raise HandShapeError("quaternion must be a four-component numeric sequence") from exc
    if not all(math.isfinite(value) for value in quaternion):
        raise HandShapeError("quaternion components must be finite")
    magnitude = math.sqrt(sum(value * value for value in quaternion))
    if magnitude <= 1e-12:
        raise HandShapeError("quaternion magnitude must be nonzero")
    normalized = tuple(value / magnitude for value in quaternion)
    return _canonicalize(normalized)  # type: ignore[arg-type]


def compose_quaternions(
    authored_base: Sequence[float], delta: Sequence[float]
) -> tuple[float, float, float, float]:
    """Compose normalized wxyz quaternions as authored_base @ delta."""
    aw, ax, ay, az = normalize_quaternion(authored_base)
    dw, dx, dy, dz = normalize_quaternion(delta)
    return normalize_quaternion((
        aw * dw - ax * dx - ay * dy - az * dz,
        aw * dx + ax * dw + ay * dz - az * dy,
        aw * dy - ax * dz + ay * dw + az * dx,
        aw * dz + ax * dy - ay * dx + az * dw,
    ))


def _flexion_delta(degrees: float, side: str, role: str) -> tuple[float, float, float, float]:
    half_angle = math.radians(degrees) / 2.0
    sine = math.sin(half_angle)
    axis = _FLEXION_ADAPTERS[side][role]
    return normalize_quaternion((
        math.cos(half_angle),
        sine * axis[0],
        sine * axis[1],
        sine * axis[2],
    ))


def preset_deltas(left: object = None, right: object = None) -> dict[str, dict[str, tuple[float, float, float, float]]]:
    """Return complete bilateral normalized local quaternion deltas."""
    selected = resolve_hand_shapes(left, right)
    result: dict[str, dict[str, tuple[float, float, float, float]]] = {}
    for side in _SIDES:
        channels = PRESET_LIBRARY[selected[side]][side]
        side_result: dict[str, tuple[float, float, float, float]] = {}
        for finger in _FINGERS:
            for segment, degrees in enumerate(channels[finger], start=1):
                role = f"{finger}{segment}"
                side_result[role] = _flexion_delta(degrees, side, role)
        result[side] = side_result
    return result


def schedule_endpoint_frames(start_frame: int, end_frame: int, keyframe_budget: int = 2) -> tuple[int, ...]:
    """Return deterministic inclusive endpoint frames within a keyframe budget."""
    if isinstance(start_frame, bool) or not isinstance(start_frame, int):
        raise HandShapeError("start_frame must be an integer")
    if isinstance(end_frame, bool) or not isinstance(end_frame, int):
        raise HandShapeError("end_frame must be an integer")
    if end_frame < start_frame:
        raise HandShapeError("end_frame must not precede start_frame")
    if isinstance(keyframe_budget, bool) or not isinstance(keyframe_budget, int) or keyframe_budget < 1:
        raise HandShapeError("keyframe_budget must be a positive integer")
    if start_frame == end_frame:
        return (start_frame,)
    if keyframe_budget < 2:
        raise HandShapeError("two distinct endpoints require a keyframe budget of at least two")
    return (start_frame, end_frame)


def schedule_role_endpoints(
    start_frame: int,
    end_frame: int,
    delta: Sequence[float],
    keyframe_budget: int = 2,
) -> tuple[tuple[int, tuple[float, float, float, float]], ...]:
    """Schedule no keys for identity, otherwise identity and target endpoint keys."""
    normalized_delta = normalize_quaternion(delta)
    if all(abs(value - expected) <= 1e-12 for value, expected in zip(normalized_delta, _IDENTITY)):
        return ()
    frames = schedule_endpoint_frames(start_frame, end_frame, keyframe_budget)
    if len(frames) == 1:
        return ((frames[0], normalized_delta),)
    return ((frames[0], _IDENTITY), (frames[1], normalized_delta))
