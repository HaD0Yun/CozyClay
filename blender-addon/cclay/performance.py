"""Revision-bound Blender playback performance diagnostics and profiles."""

from __future__ import annotations

import math
import re
from typing import Any

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover
    bpy = None

_HASH = re.compile(r"^[0-9a-f]{64}$")
_PROFILES = ("editing", "playback", "performance")


class PerformanceError(RuntimeError):
    """Performance diagnostics or profile application cannot proceed safely."""


class PerformanceValidationError(PerformanceError):
    """One closed request/result contract failure."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _invalid(message: str) -> None:
    raise PerformanceValidationError("INVALID_PERFORMANCE_MODE_REQUEST", message)


def _validate_revision(value: object) -> str:
    if not isinstance(value, str) or _HASH.fullmatch(value) is None:
        _invalid("expected_revision_id must be a lowercase SHA-256")
    return value


def parse_apply_performance_mode(value: object) -> dict[str, str]:
    """Parse the closed apply_performance_mode request."""
    if not isinstance(value, dict) or set(value) != {"expected_revision_id", "profile"}:
        _invalid("request must contain exactly expected_revision_id and profile")
    profile = value.get("profile")
    if profile not in _PROFILES:
        _invalid(f"profile must be one of {', '.join(_PROFILES)}")
    return {
        "expected_revision_id": _validate_revision(value.get("expected_revision_id")),
        "profile": profile,
    }


def inspect_performance() -> dict[str, Any]:
    """Collect a small, read-only baseline for diagnosing playback lag."""
    scene = bpy.context.scene
    window_manager = bpy.context.window_manager
    workspace = bpy.context.workspace
    screen = getattr(workspace, "screen", None)
    viewports = []
    if screen is not None:
        for area in screen.areas:
            if getattr(area, "type", None) != "VIEW_3D":
                continue
            space = next(
                (candidate for candidate in area.spaces if candidate.type == "VIEW_3D"),
                None,
            )
            shading = getattr(getattr(space, "shading", None), "type", None) if space else None
            viewports.append({"area": area.type, "shading": shading})
    action = None
    if getattr(scene, "animation_data", None) is not None:
        action = scene.animation_data.action
    fcurve_count = len(action.fcurves) if action is not None else 0
    keyframe_count = (
        sum(len(curve.keyframe_points) for curve in action.fcurves)
        if action is not None
        else 0
    )
    mesh_stats = {"mesh_count": 0, "vertices": 0, "polygons": 0, "armature_modified_vertices": 0}
    for scene_object in scene.objects:
        if getattr(scene_object, "type", None) != "MESH":
            continue
        mesh_stats["mesh_count"] += 1
        vertices = len(scene_object.data.vertices)
        mesh_stats["vertices"] += vertices
        mesh_stats["polygons"] += len(scene_object.data.polygons)
        if any(getattr(modifier, "type", None) == "ARMATURE" for modifier in scene_object.modifiers):
            mesh_stats["armature_modified_vertices"] += vertices
    return {
        "schema_version": 1,
        "scene": {
            "sync_mode": scene.sync_mode,
            "fps": scene.render.fps,
            "frame_start": scene.frame_start,
            "frame_end": scene.frame_end,
        },
        "workspace": {
            "name": workspace.name,
            "editor_count": len(screen.areas) if screen is not None else 0,
            "viewports": viewports,
        },
        "animation": {
            "fcurves": fcurve_count,
            "keyframes": keyframe_count,
            "window_animation_clients": len(window_manager.animation_clients)
            if hasattr(window_manager, "animation_clients")
            else None,
        },
        "meshes": mesh_stats,
    }


def _set_space_mode(space, profile: str) -> None:
    shading = getattr(space, "shading", None)
    if shading is None:
        return
    if profile in ("playback", "performance"):
        shading.type = "SOLID"
        shading.light = "FLAT"
        shading.show_shadows = False
        shading.show_cavity = False
        shading.show_xray = False
    else:
        shading.show_shadows = True
        shading.show_cavity = True


def apply_performance_mode(profile: str) -> dict[str, Any]:
    """Apply a named viewport/playback profile and return its effective state."""
    scene = bpy.context.scene
    workspace = bpy.context.workspace
    screen = getattr(workspace, "screen", None)
    scene.sync_mode = "NONE" if profile == "editing" else "FRAME_DROP"
    viewport_count = 0
    if screen is not None:
        for area in screen.areas:
            if getattr(area, "type", None) != "VIEW_3D":
                continue
            viewport_count += 1
            for space in area.spaces:
                if space.type == "VIEW_3D":
                    _set_space_mode(space, profile)
    if profile == "performance":
        for scene_object in scene.objects:
            if scene_object.name.startswith("City_"):
                scene_object.hide_set(True)
            if scene_object.name.endswith("_Joints"):
                scene_object.hide_set(True)
    else:
        for scene_object in scene.objects:
            if scene_object.name.startswith("City_") or scene_object.name.endswith("_Joints"):
                scene_object.hide_set(False)
    return {
        "schema_version": 1,
        "profile": profile,
        "scene": {"sync_mode": scene.sync_mode},
        "viewports": viewport_count,
        "objects_hidden": sum(1 for scene_object in scene.objects if scene_object.hide_get()),
    }
