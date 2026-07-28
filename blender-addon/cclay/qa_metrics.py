"""Deterministic Visual QA metrics that do not require a rendered image."""

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


class QaMetricsError(RuntimeError):
    """Visual QA metrics cannot be collected safely."""


class QaMetricsValidationError(QaMetricsError):
    """One closed inspect_visual_qa_metrics contract failure."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _invalid(message: str) -> None:
    raise QaMetricsValidationError("INVALID_VISUAL_QA_METRICS_REQUEST", message)


def _integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _invalid(f"{label} must be an integer")
    return value


def parse_inspect_visual_qa_metrics(value: object) -> dict[str, Any]:
    """Parse the closed inspect_visual_qa_metrics request."""
    required = {"expected_revision_id", "frames", "subject_entity_ids"}
    allowed = required | {"ground_z"}
    if not isinstance(value, dict) or not required <= set(value) or not set(value) <= allowed:
        _invalid("request must contain only the closed inspect_visual_qa_metrics fields")
    expected_revision_id = value.get("expected_revision_id")
    if not isinstance(expected_revision_id, str) or _HASH.fullmatch(expected_revision_id) is None:
        _invalid("expected_revision_id must be a lowercase SHA-256")
    frames = value.get("frames")
    if not isinstance(frames, list) or not 1 <= len(frames) <= 64:
        _invalid("frames must contain 1..64 frame numbers")
    parsed_frames = []
    for index, frame in enumerate(frames):
        parsed_frame = _integer(frame, f"frames[{index}]")
        if parsed_frame < 0 or parsed_frame > 100000:
            _invalid(f"frames[{index}] must be in 0..100000")
        parsed_frames.append(parsed_frame)
    if len(set(parsed_frames)) != len(parsed_frames):
        _invalid("frames must not contain duplicates")
    subject_entity_ids = value.get("subject_entity_ids")
    if not isinstance(subject_entity_ids, list) or not 1 <= len(subject_entity_ids) <= 32:
        _invalid("subject_entity_ids must contain 1..32 UUIDv4 values")
    parsed_subjects = []
    for index, entity_id in enumerate(subject_entity_ids):
        if not isinstance(entity_id, str) or _UUID4.fullmatch(entity_id) is None:
            _invalid(f"subject_entity_ids[{index}] must be a lowercase UUIDv4")
        parsed_subjects.append(entity_id)
    if len(set(parsed_subjects)) != len(parsed_subjects):
        _invalid("subject_entity_ids must not contain duplicates")
    ground_z = value.get("ground_z", 0.0)
    if isinstance(ground_z, bool) or not isinstance(ground_z, (int, float)) or not math.isfinite(ground_z):
        _invalid("ground_z must be a finite number")
    return {
        "expected_revision_id": expected_revision_id,
        "frames": sorted(parsed_frames),
        "subject_entity_ids": parsed_subjects,
        "ground_z": float(ground_z),
    }


def _world_corners(scene_object):
    return [scene_object.matrix_world @ Vector(corner) for corner in scene_object.bound_box]


def _project_point(camera, scene, point):
    projection = camera.matrix_world.normalized().inverted() @ point
    perspective = projection * camera.data.lens / max(1e-6, -projection.z)
    return (
        perspective.x / (2 * camera.data.sensor_width) + 0.5,
        perspective.y / (2 * camera.data.sensor_width) + 0.5,
    )


def inspect_visual_qa_metrics(request: dict[str, Any]) -> dict[str, Any]:
    """Compute deterministic scene metrics without rendering or mutating state."""
    scene = bpy.context.scene
    camera = scene.camera
    if camera is None or camera.type != "CAMERA":
        raise QaMetricsError("QA_METRICS_CAMERA_MISSING: scene has no active camera")
    subjects = []
    for entity_id in request["subject_entity_ids"]:
        subject = next(
            (
                scene_object
                for scene_object in bpy.data.objects
                if scene_object.get("cclay.entity_id") == entity_id
            ),
            None,
        )
        if subject is None:
            raise QaMetricsError(f"QA_METRICS_SUBJECT_NOT_FOUND: subject {entity_id} was not found")
        subjects.append((entity_id, subject))
    emission_count = 0
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            if node.bl_idname in {"ShaderNodeEmission", "ShaderNodeBsdfPrincipled"}:
                emission_socket = node.inputs.get("Emission Strength")
                if emission_socket is not None and emission_socket.default_value > 0:
                    emission_count += 1
                    break
    action_keyframes = (
        sum(len(curve.keyframe_points) for curve in camera.animation_data.action.fcurves)
        if camera.animation_data and camera.animation_data.action
        else 0
    )
    frames = []
    previous_frame = scene.frame_current
    try:
        for frame in request["frames"]:
            scene.frame_set(frame)
            frame_subjects = []
            for entity_id, subject in subjects:
                if subject.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"}:
                    corners = _world_corners(subject)
                    center = sum(corners, Vector((0.0, 0.0, 0.0))) / 8
                    lowest_z = min(corner.z for corner in corners)
                else:
                    center = subject.matrix_world.translation.copy()
                    lowest_z = center.z
                u, v = _project_point(camera, scene, center)
                distance = (center - camera.matrix_world.translation).length
                frame_subjects.append(
                    {
                        "entity_id": entity_id,
                        "screen_u": round(u, 6),
                        "screen_v": round(v, 6),
                        "on_screen": 0.0 <= u <= 1.0 and 0.0 <= v <= 1.0,
                        "distance_to_camera_m": round(distance, 6),
                        "ground_gap_m": round(lowest_z - request["ground_z"], 6),
                        "below_ground_m": round(max(0.0, request["ground_z"] - lowest_z), 6),
                    }
                )
            frames.append({"frame": frame, "subjects": frame_subjects})
    finally:
        scene.frame_set(previous_frame)
    return {
        "schema_version": 1,
        "camera": {
            "entity_id": camera.get("cclay.entity_id"),
            "name": camera.name,
            "lens_mm": camera.data.lens,
            "sensor_width_mm": camera.data.sensor_width,
            "action_keyframes": action_keyframes,
        },
        "scene": {
            "frame_start": scene.frame_start,
            "frame_end": scene.frame_end,
            "fps": scene.render.fps,
        },
        "materials": {"emission_count": emission_count},
        "frames": frames,
    }
