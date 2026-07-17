"""Thin Blender extraction layer for Scene Snapshot v2."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

import bpy
from mathutils import Quaternion

from .snapshot import (
    UNSUPPORTED_FCURVE_FEATURE,
    UNSUPPORTED_FPS_BASE,
    UNSUPPORTED_LINKED_DATABLOCK,
    assemble_snapshot,
    canonical_quaternion,
    snapshot_revision,
)


def _vector(values: Iterable[float]) -> list[float]:
    return [float(value) for value in values]


def _object_quaternion(scene_object: bpy.types.Object) -> list[float]:
    if scene_object.rotation_mode == "QUATERNION":
        quaternion = scene_object.rotation_quaternion
    elif scene_object.rotation_mode == "AXIS_ANGLE":
        angle, axis_x, axis_y, axis_z = scene_object.rotation_axis_angle
        quaternion = Quaternion((axis_x, axis_y, axis_z), angle)
    else:
        quaternion = scene_object.rotation_euler.to_quaternion()
    return canonical_quaternion(quaternion)


def _check_linked(scene_object: bpy.types.Object) -> None:
    data = scene_object.data
    if scene_object.library is not None or (data is not None and data.library is not None):
        raise UNSUPPORTED_LINKED_DATABLOCK(
            f"object {scene_object.name!r} uses a linked datablock"
        )


def _object_snapshot(scene_object: bpy.types.Object) -> dict:
    _check_linked(scene_object)
    return {
        "name": scene_object.name,
        "type": scene_object.type,
        "parent": scene_object.parent.name if scene_object.parent else None,
        "visible": bool(scene_object.visible_get()),
        "location": _vector(scene_object.location),
        "rotationMode": scene_object.rotation_mode,
        "rotationQuaternion": _object_quaternion(scene_object),
        "scale": _vector(scene_object.scale),
    }


def _camera_snapshot(scene_object: bpy.types.Object) -> dict:
    camera = scene_object.data
    return {
        "name": scene_object.name,
        "lens": float(camera.lens),
        "sensorFit": camera.sensor_fit,
        "sensorWidth": float(camera.sensor_width),
        "sensorHeight": float(camera.sensor_height),
        "verticalFovRadians": float(camera.angle_y),
        "clipStart": float(camera.clip_start),
        "clipEnd": float(camera.clip_end),
    }


def _interpolation_values() -> set[str]:
    prop = bpy.types.Keyframe.bl_rna.properties["interpolation"]
    return {item.identifier for item in prop.enum_items}


def action_fcurves(action: object) -> list[object]:
    """Return an action's f-curves across legacy and layered (Blender 5.x) actions."""
    if hasattr(action, "fcurves"):
        return list(action.fcurves)
    return [
        fcurve
        for layer in action.layers
        for strip in layer.strips
        for channelbag in strip.channelbags
        for fcurve in channelbag.fcurves
    ]


def _animation_snapshot(object_name: str, target: str, animation_data: object) -> dict | None:
    if animation_data is None:
        return None
    drivers = animation_data.drivers
    if len(drivers):
        raise UNSUPPORTED_FCURVE_FEATURE(
            f"{object_name!r} {target} animation uses drivers"
        )
    action = animation_data.action
    if action is None:
        return None

    interpolation_values = _interpolation_values()
    fcurves = []
    for fcurve in action_fcurves(action):
        if len(fcurve.modifiers):
            raise UNSUPPORTED_FCURVE_FEATURE(
                f"{object_name!r} {target} f-curve uses modifiers"
            )
        keyframes = []
        for point in fcurve.keyframe_points:
            if point.easing != "AUTO" or point.interpolation not in interpolation_values:
                raise UNSUPPORTED_FCURVE_FEATURE(
                    f"{object_name!r} {target} f-curve uses unsupported easing or interpolation"
                )
            keyframes.append(
                {
                    "frame": float(point.co.x),
                    "value": float(point.co.y),
                    "interpolation": point.interpolation,
                    "handleLeft": [float(point.handle_left.x), float(point.handle_left.y)],
                    "handleRight": [float(point.handle_right.x), float(point.handle_right.y)],
                }
            )
        fcurves.append(
            {
                "dataPath": fcurve.data_path,
                "arrayIndex": int(fcurve.array_index),
                "keyframes": keyframes,
            }
        )
    return {"objectName": object_name, "target": target, "fcurves": fcurves}


def extract_scene_snapshot() -> dict:
    """Extract the active Blender scene into a Scene Snapshot v2 dictionary."""
    blender_scene = bpy.context.scene
    if blender_scene.render.fps_base != 1.0:
        raise UNSUPPORTED_FPS_BASE(
            f"fps_base must be 1.0, got {blender_scene.render.fps_base!r}"
        )

    scene_objects = list(blender_scene.objects)
    objects = [_object_snapshot(scene_object) for scene_object in scene_objects]
    cameras = [
        _camera_snapshot(scene_object)
        for scene_object in scene_objects
        if scene_object.type == "CAMERA"
    ]
    animations = []
    for scene_object in scene_objects:
        object_animation = _animation_snapshot(
            scene_object.name, "object", scene_object.animation_data
        )
        if object_animation is not None:
            animations.append(object_animation)
        if scene_object.type == "CAMERA":
            camera_animation = _animation_snapshot(
                scene_object.name, "cameraData", scene_object.data.animation_data
            )
            if camera_animation is not None:
                animations.append(camera_animation)

    return assemble_snapshot(
        scene={
            "name": blender_scene.name,
            "frameStart": int(blender_scene.frame_start),
            "frameEnd": int(blender_scene.frame_end),
            "fps": int(blender_scene.render.fps),
            "activeCamera": blender_scene.camera.name if blender_scene.camera else None,
        },
        render={
            "resolutionX": int(blender_scene.render.resolution_x),
            "resolutionY": int(blender_scene.render.resolution_y),
            "resolutionPercentage": int(blender_scene.render.resolution_percentage),
        },
        objects=objects,
        cameras=cameras,
        markers=[
            {
                "name": marker.name,
                "frame": int(marker.frame),
                "camera": marker.camera.name if marker.camera else None,
            }
            for marker in blender_scene.timeline_markers
        ],
        animations=animations,
    )


def write_scene_snapshot(output_path: Path) -> str:
    """Write a human-readable snapshot and print and return its revision."""
    snapshot = extract_scene_snapshot()
    output_path.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    revision = snapshot_revision(snapshot)
    print(revision)
    return revision
