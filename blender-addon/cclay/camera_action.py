"""Revision-bound camera action replacement without stale keyframe leakage."""

from __future__ import annotations

import math
import re
from typing import Any

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
    from mathutils import Vector  # type: ignore
except ImportError:  # pragma: no cover
    bpy = None
    Vector = None

_HASH = re.compile(r"^[0-9a-f]{64}$")
_UUID4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_EPSILON = 1e-6


class CameraActionError(RuntimeError):
    """A camera action cannot be replaced safely."""


class CameraActionValidationError(CameraActionError):
    """One closed replace_camera_action contract failure."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _invalid(message: str) -> None:
    raise CameraActionValidationError("INVALID_CAMERA_ACTION_REQUEST", message)


def _integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _invalid(f"{label} must be an integer")
    return value


def _number(value: object, label: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _invalid(f"{label} must be a finite number")
    if positive and value <= 0:
        _invalid(f"{label} must be positive")
    return float(value)


def _vector(value: object, label: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 3:
        _invalid(f"{label} must contain exactly three numbers")
    return [_number(component, f"{label}[{index}]") for index, component in enumerate(value)]


def parse_replace_camera_action(value: object) -> dict[str, Any]:
    """Parse the closed replace_camera_action request."""
    required = {"expected_revision_id", "camera_entity_id", "keyframes"}
    allowed = required | {"action_name"}
    if not isinstance(value, dict) or not required <= set(value) or not set(value) <= allowed:
        _invalid("request must contain only the closed replace_camera_action fields")
    expected_revision_id = value.get("expected_revision_id")
    if not isinstance(expected_revision_id, str) or _HASH.fullmatch(expected_revision_id) is None:
        _invalid("expected_revision_id must be a lowercase SHA-256")
    camera_entity_id = value.get("camera_entity_id")
    if not isinstance(camera_entity_id, str) or _UUID4.fullmatch(camera_entity_id) is None:
        _invalid("camera_entity_id must be a lowercase UUIDv4")
    keyframes = value.get("keyframes")
    if not isinstance(keyframes, list) or not 2 <= len(keyframes) <= 256:
        _invalid("keyframes must contain 2..256 entries")
    parsed = []
    previous_frame = -1
    for index, keyframe in enumerate(keyframes):
        if not isinstance(keyframe, dict) or set(keyframe) != {
            "frame",
            "location",
            "look_at",
            "transition",
        }:
            _invalid(f"keyframes[{index}] must contain exactly frame, location, look_at, transition")
        frame = _integer(keyframe.get("frame"), f"keyframes[{index}].frame")
        if frame <= previous_frame:
            _invalid("keyframe frames must be strictly increasing")
        previous_frame = frame
        location = _vector(keyframe.get("location"), f"keyframes[{index}].location")
        look_at = _vector(keyframe.get("look_at"), f"keyframes[{index}].look_at")
        if all(abs(location[axis] - look_at[axis]) < _EPSILON for axis in range(3)):
            _invalid(f"keyframes[{index}] look_at must differ from location")
        transition = keyframe.get("transition")
        if transition not in ("smooth", "cut"):
            _invalid(f"keyframes[{index}].transition must be smooth or cut")
        parsed.append(
            {"frame": frame, "location": location, "look_at": look_at, "transition": transition}
        )
    action_name = value.get("action_name", "CCLAY Camera Action")
    if not isinstance(action_name, str) or not 1 <= len(action_name) <= 128:
        _invalid("action_name must be 1..128 characters")
    return {
        "expected_revision_id": expected_revision_id,
        "camera_entity_id": camera_entity_id,
        "action_name": action_name,
        "keyframes": parsed,
    }


def _insert_camera_keys(action, keyframes: list[dict[str, Any]]) -> None:
    location_curves = [action.fcurves.new("location", index=index) for index in range(3)]
    rotation_curves = [action.fcurves.new("rotation_euler", index=index) for index in range(3)]
    for keyframe in keyframes:
        location = Vector(keyframe["location"])
        look_at = Vector(keyframe["look_at"])
        direction = look_at - location
        rotation = direction.to_track_quat("-Z", "Y").to_euler()
        for index, value in enumerate(location):
            location_curves[index].keyframe_points.insert(keyframe["frame"], value, options={"FAST"})
        for index, value in enumerate(rotation):
            rotation_curves[index].keyframe_points.insert(keyframe["frame"], value, options={"FAST"})
        if keyframe["transition"] == "cut":
            for curve in (*location_curves, *rotation_curves):
                point = next((p for p in curve.keyframe_points if abs(p.co.x - keyframe["frame"]) < 1e-4), None)
                if point is not None:
                    point.interpolation = "CONSTANT"


def replace_camera_action(request: dict[str, Any], expected_revision_id: str) -> dict[str, Any]:
    """Atomically replace a camera's action with only the request's keyframes."""
    if request["expected_revision_id"] != expected_revision_id:
        raise CameraActionError(
            f"STALE_BASE: expected revision {request['expected_revision_id']}, current revision is {expected_revision_id}"
        )
    camera = next(
        (
            scene_object
            for scene_object in bpy.data.objects
            if scene_object.get("cclay.entity_id") == request["camera_entity_id"]
            and scene_object.type == "CAMERA"
        ),
        None,
    )
    if camera is None:
        raise CameraActionError("CAMERA_ACTION_TARGET_NOT_FOUND: camera entity was not found")
    action = bpy.data.actions.new(request["action_name"])
    _insert_camera_keys(action, request["keyframes"])
    camera.animation_data_clear()
    camera.animation_data_create().action = action
    scene = bpy.context.scene
    scene.camera = camera
    scene.frame_start = min(scene.frame_start, request["keyframes"][0]["frame"])
    scene.frame_end = max(scene.frame_end, request["keyframes"][-1]["frame"])
    keyframe_count = len(request["keyframes"]) * 6
    return {
        "schema_version": 1,
        "revision_id": expected_revision_id,
        "camera_entity_id": request["camera_entity_id"],
        "action_name": action.name,
        "keyframes": len(request["keyframes"]),
        "fcurve_keyframes": keyframe_count,
        "frame_start": request["keyframes"][0]["frame"],
        "frame_end": request["keyframes"][-1]["frame"],
        "transitions": {
            "smooth": sum(1 for keyframe in request["keyframes"] if keyframe["transition"] == "smooth"),
            "cut": sum(1 for keyframe in request["keyframes"] if keyframe["transition"] == "cut"),
        },
    }
