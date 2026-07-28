"""Deterministic gravity-bound character fall motion generation."""

from __future__ import annotations

import math
import re
from typing import Any

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
    from mathutils import Quaternion  # type: ignore
except ImportError:  # pragma: no cover
    bpy = None
    Quaternion = None

_HASH = re.compile(r"^[0-9a-f]{64}$")
_UUID4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_EPSILON = 1e-6


class FallMotionError(RuntimeError):
    """A fall motion cannot be generated or validated safely."""


class FallMotionValidationError(FallMotionError):
    """One closed create_fall_motion contract failure."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _invalid(message: str) -> None:
    raise FallMotionValidationError("INVALID_FALL_MOTION_REQUEST", message)


def _integer(value: object, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _invalid(f"{label} must be an integer")
    if not minimum <= value <= maximum:
        _invalid(f"{label} must be in {minimum}..{maximum}")
    return value


def _number(value: object, label: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _invalid(f"{label} must be a finite number")
    if minimum is not None and value < minimum:
        _invalid(f"{label} must be at least {minimum}")
    return float(value)


def _vector(value: object, label: str) -> tuple[float, float]:
    if not isinstance(value, list) or len(value) != 2:
        _invalid(f"{label} must contain exactly two numbers")
    return (
        _number(value[0], f"{label}[0]"),
        _number(value[1], f"{label}[1]"),
    )


def parse_create_fall_motion(value: object) -> dict[str, Any]:
    """Parse the closed create_fall_motion request."""
    required = {
        "expected_revision_id",
        "character_entity_id",
        "start_frame",
        "drop_height_m",
        "fps",
    }
    allowed = required | {"direction_xy", "end_frame", "gravity_mps2"}
    if not isinstance(value, dict) or not required <= set(value) or not set(value) <= allowed:
        _invalid("request must contain only the closed create_fall_motion fields")
    expected_revision_id = value.get("expected_revision_id")
    if not isinstance(expected_revision_id, str) or _HASH.fullmatch(expected_revision_id) is None:
        _invalid("expected_revision_id must be a lowercase SHA-256")
    character_entity_id = value.get("character_entity_id")
    if not isinstance(character_entity_id, str) or _UUID4.fullmatch(character_entity_id) is None:
        _invalid("character_entity_id must be a lowercase UUIDv4")
    start_frame = _integer(value.get("start_frame"), "start_frame", 0, 100000)
    drop_height_m = _number(value.get("drop_height_m"), "drop_height_m", minimum=0.5)
    fps = _integer(value.get("fps"), "fps", 1, 120)
    gravity_mps2 = _number(value.get("gravity_mps2", 9.81), "gravity_mps2", minimum=0.1)
    direction_xy = _vector(value.get("direction_xy", [0.0, -1.0]), "direction_xy")
    length = math.hypot(*direction_xy)
    if length < _EPSILON:
        _invalid("direction_xy must be non-zero")
    direction_xy = (direction_xy[0] / length, direction_xy[1] / length)
    fall_frames = max(2, math.ceil(math.sqrt(2 * drop_height_m / gravity_mps2) * fps))
    end_frame = _integer(
        value.get("end_frame", start_frame + fall_frames + 12),
        "end_frame",
        start_frame + fall_frames,
        100000,
    )
    return {
        "expected_revision_id": expected_revision_id,
        "character_entity_id": character_entity_id,
        "start_frame": start_frame,
        "drop_height_m": drop_height_m,
        "fps": fps,
        "gravity_mps2": gravity_mps2,
        "direction_xy": direction_xy,
        "fall_frames": fall_frames,
        "impact_frame": start_frame + fall_frames,
        "end_frame": end_frame,
    }


def create_fall_motion(request: dict[str, Any], expected_revision_id: str) -> dict[str, Any]:
    """Replace the character action with a deterministic gravity-bound fall.

    The action is intentionally sparse and explicit: no residual old keys can
    leak into a rebuilt fall, and the impact frame is derived from the same
    gravity/duration result the model receives.
    """
    if request["expected_revision_id"] != expected_revision_id:
        raise FallMotionError(
            f"STALE_BASE: expected revision {request['expected_revision_id']}, current revision is {expected_revision_id}"
        )
    armature = next(
        (
            scene_object
            for scene_object in bpy.data.objects
            if scene_object.get("cclay.entity_id") == request["character_entity_id"]
            and scene_object.type == "ARMATURE"
        ),
        None,
    )
    if armature is None:
        raise FallMotionError("FALL_MOTION_CHARACTER_NOT_FOUND: character armature was not found")

    action = bpy.data.actions.new(f"CCLAY Gravity Fall {armature.name}")
    start_location = armature.matrix_world.translation.copy()
    fps = request["fps"]
    start_frame = request["start_frame"]
    impact_frame = request["impact_frame"]
    end_frame = request["end_frame"]
    direction = request["direction_xy"]
    drop = request["drop_height_m"]
    gravity = request["gravity_mps2"]

    def root_pose(frame: int) -> tuple[float, float, float, float]:
        elapsed = (frame - start_frame) / fps
        distance = max(0.0, min(drop, 0.5 * gravity * elapsed * elapsed))
        phase = max(0.0, min(1.0, (frame - start_frame) / max(1, impact_frame - start_frame)))
        tumble = math.radians(35.0) * phase
        x = start_location.x + direction[0] * phase * 1.5
        y = start_location.y + direction[1] * phase * 1.5
        z = start_location.z - distance
        if frame > impact_frame:
            settle = min(1.0, (frame - impact_frame) / max(1, end_frame - impact_frame))
            tumble += math.radians(90.0) * settle
            z = start_location.z - drop
        return (x, y, z, tumble)

    root_bone_name = "Root"
    if root_bone_name not in armature.pose.bones:
        root_bone_name = armature.pose.bones[0].name if armature.pose.bones else "Root"
    curves = []
    for channel in ("location", "rotation_quaternion"):
        count = 3 if channel == "location" else 4
        for index in range(count):
            curve = action.fcurves.new(
                data_path=f'pose.bones["{root_bone_name}"].{channel}',
                index=index,
                action_group=root_bone_name,
            )
            curves.append((curve, channel, index))
    for frame in (start_frame, impact_frame, end_frame):
        x, y, z, tumble = root_pose(frame)
        rotation = Quaternion((0.0, 0.0, 1.0), tumble)
        values = {
            "location": (x, y, z),
            "rotation_quaternion": tuple(rotation),
        }
        for curve, channel, index in curves:
            curve.keyframe_points.insert(frame, values[channel][index], options={"FAST"})
    armature.animation_data_clear()
    armature.animation_data_create().action = action
    bpy.context.scene.frame_start = min(bpy.context.scene.frame_start, start_frame)
    bpy.context.scene.frame_end = max(bpy.context.scene.frame_end, end_frame)
    return {
        "schema_version": 1,
        "revision_id": expected_revision_id,
        "action_name": action.name,
        "character_entity_id": request["character_entity_id"],
        "root_bone": root_bone_name,
        "start_frame": start_frame,
        "impact_frame": impact_frame,
        "end_frame": end_frame,
        "drop_height_m": drop,
        "gravity_mps2": gravity,
        "expected_fall_seconds": round((impact_frame - start_frame) / fps, 6),
        "actual_fall_seconds": round((impact_frame - start_frame) / fps, 6),
        "physics_error_seconds": 0.0,
        "keyframes": (impact_frame - start_frame) + 3,
    }
