"""Thin Blender extraction layer for Scene Snapshot v2."""

from __future__ import annotations

import json
from pathlib import Path
import unicodedata
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
from .scene_manifest import (
    build_scene_manifest,
    build_scene_manifest_v3,
    finalize_scene_manifest,
    rational_fps,
)


def _text(value: str) -> str:
    return unicodedata.normalize("NFC", value)


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
        "name": _text(scene_object.name),
        "type": _text(scene_object.type),
        "parent": _text(scene_object.parent.name) if scene_object.parent else None,
        "visible": bool(scene_object.visible_get()),
        "location": _vector(scene_object.location),
        "rotationMode": _text(scene_object.rotation_mode),
        "rotationQuaternion": _object_quaternion(scene_object),
        "scale": _vector(scene_object.scale),
    }


def _camera_snapshot(scene_object: bpy.types.Object) -> dict:
    camera = scene_object.data
    return {
        "name": _text(scene_object.name),
        "lens": float(camera.lens),
        "sensorFit": _text(camera.sensor_fit),
        "sensorWidth": float(camera.sensor_width),
        "sensorHeight": float(camera.sensor_height),
        "verticalFovRadians": float(camera.angle_y),
        "clipStart": float(camera.clip_start),
        "clipEnd": float(camera.clip_end),
    }


def _interpolation_values() -> set[str]:
    prop = bpy.types.Keyframe.bl_rna.properties["interpolation"]
    return {item.identifier for item in prop.enum_items}


def animation_fcurves(animation_data: object) -> list[object]:
    """Return only the f-curves associated with an animation data-block's slot."""
    action = animation_data.action
    legacy_fcurves = getattr(action, "fcurves", None)
    if legacy_fcurves is not None and len(legacy_fcurves):
        return list(legacy_fcurves)

    slot = animation_data.action_slot
    result = []
    for layer in action.layers:
        for strip in layer.strips:
            channelbag = strip.channelbag(slot) if hasattr(strip, "channelbag") else None
            if channelbag is not None:
                result.extend(channelbag.fcurves)
                continue
            result.extend(
                fcurve
                for bag in strip.channelbags
                if bag.slot_handle == slot.handle
                for fcurve in bag.fcurves
            )
    return result


def _animation_snapshot(
    object_identity: str,
    target: str,
    animation_data: object,
    *,
    identity_key: str = "objectName",
    include_handle_types: bool = False,
) -> dict | None:
    if animation_data is None:
        return None
    drivers = animation_data.drivers
    if len(drivers):
        raise UNSUPPORTED_FCURVE_FEATURE(
            f"{object_identity!r} {target} animation uses drivers"
        )
    action = animation_data.action
    if action is None:
        return None

    interpolation_values = _interpolation_values()
    easing_defaults = {
        name: bpy.types.Keyframe.bl_rna.properties[name].default
        for name in ("back", "amplitude", "period")
    }
    fcurves = []
    for fcurve in animation_fcurves(animation_data):
        if len(fcurve.modifiers):
            raise UNSUPPORTED_FCURVE_FEATURE(
                f"{object_identity!r} {target} f-curve uses modifiers"
            )
        keyframes = []
        for point in fcurve.keyframe_points:
            if (
                point.easing != "AUTO"
                or point.interpolation not in interpolation_values
                or any(getattr(point, name) != default for name, default in easing_defaults.items())
            ):
                raise UNSUPPORTED_FCURVE_FEATURE(
                    f"{object_identity!r} {target} f-curve uses unsupported easing, "
                    "interpolation, or easing parameters"
                )
            keyframe = {
                "frame": float(point.co.x),
                "value": float(point.co.y),
                "interpolation": point.interpolation,
                "handleLeft": [float(point.handle_left.x), float(point.handle_left.y)],
                "handleRight": [float(point.handle_right.x), float(point.handle_right.y)],
            }
            if include_handle_types:
                keyframe["handleLeftType"] = _text(point.handle_left_type)
                keyframe["handleRightType"] = _text(point.handle_right_type)
            keyframes.append(keyframe)
        fcurves.append(
            {
                "dataPath": _text(fcurve.data_path),
                "arrayIndex": int(fcurve.array_index),
                "keyframes": keyframes,
            }
        )
    return {identity_key: _text(object_identity), "target": _text(target), "fcurves": fcurves}


def _entity_id(entity: object, label: str) -> str:
    entity_id = entity.get("omb.entity_id")
    if not isinstance(entity_id, str):
        raise ValueError(f"{label} is missing omb.entity_id")
    return entity_id


def _manifest_object(scene_object: bpy.types.Object) -> dict:
    snapshot = _object_snapshot(scene_object)
    return {
        "entityId": _entity_id(scene_object, f"object {scene_object.name!r}"),
        "name": snapshot["name"],
        "type": snapshot["type"],
        "parentId": (
            _entity_id(scene_object.parent, f"parent of object {scene_object.name!r}")
            if scene_object.parent
            else None
        ),
        "visible": snapshot["visible"],
        "location": snapshot["location"],
        "rotationQuaternion": snapshot["rotationQuaternion"],
        "scale": snapshot["scale"],
    }


def _manifest_bones(scene_objects: list[bpy.types.Object]) -> list[dict]:
    bones = []
    for scene_object in scene_objects:
        if scene_object.type != "ARMATURE":
            continue
        armature_id = _entity_id(scene_object, f"armature {scene_object.name!r}")
        for bone in scene_object.data.bones:
            location, rotation, scale = bone.matrix_local.decompose()
            bones.append(
                {
                    "entityId": _entity_id(bone, f"bone {bone.name!r}"),
                    "name": _text(bone.name),
                    "armatureObjectId": armature_id,
                    "parentBoneId": (
                        _entity_id(bone.parent, f"parent of bone {bone.name!r}")
                        if bone.parent
                        else None
                    ),
                    "location": _vector(location),
                    "rotationQuaternion": canonical_quaternion(rotation),
                    "scale": _vector(scale),
                }
            )
    return bones


def _stage_manifest_entries(
    scene_objects: list[bpy.types.Object],
    object_ids: dict[bpy.types.Object, str],
) -> tuple[list[dict], list[dict]]:
    primitives = []
    materials = []
    for scene_object in scene_objects:
        object_id = object_ids[scene_object]
        primitive_type = scene_object.get("omb.stage_primitive_type")
        if primitive_type in ("PLANE", "CUBE", "UV_SPHERE"):
            primitives.append({
                "objectId": object_id,
                "primitiveType": primitive_type,
            })
        if scene_object.type != "MESH" or not scene_object.material_slots:
            continue
        material = scene_object.material_slots[0].material
        if (
            material is not None
            and material.get("omb.generated_for_entity_id") == object_id
        ):
            materials.append({
                "objectId": object_id,
                "materialName": _text(material.name),
                "baseColor": _vector(material.diffuse_color),
            })
    return primitives, materials


def _extract_scene_manifest(schema_version: int) -> dict:
    """Extract the active Blender scene through the negotiated manifest path."""
    blender_scene = bpy.context.scene
    project_id = blender_scene.get("omb.project_id")
    if not isinstance(project_id, str):
        raise ValueError("scene is missing omb.project_id")

    scene_objects = list(blender_scene.objects)
    object_ids = {
        scene_object: _entity_id(scene_object, f"object {scene_object.name!r}")
        for scene_object in scene_objects
    }
    cameras = []
    lights = []
    animations = []
    for scene_object in scene_objects:
        object_id = object_ids[scene_object]
        if scene_object.type == "CAMERA":
            camera = scene_object.data
            cameras.append(
                {
                    "objectId": object_id,
                    "lens": float(camera.lens),
                    "sensorFit": _text(camera.sensor_fit),
                    "sensorWidth": float(camera.sensor_width),
                    "sensorHeight": float(camera.sensor_height),
                    "verticalFovRadians": float(camera.angle_y),
                    "clipStart": float(camera.clip_start),
                    "clipEnd": float(camera.clip_end),
                }
            )
            for target, animation_data in (
                ("object", scene_object.animation_data),
                ("cameraData", camera.animation_data),
            ):
                animation = _animation_snapshot(
                    object_id,
                    target,
                    animation_data,
                    identity_key="objectId",
                    include_handle_types=True,
                )
                if animation is not None:
                    animations.append(animation)
        elif scene_object.type == "LIGHT":
            light = scene_object.data
            light_entry = {
                "objectId": object_id,
                "lightType": _text(light.type),
                "color": _vector(light.color),
                "energy": float(light.energy),
                "spotSize": float(light.spot_size) if light.type == "SPOT" else None,
                "spotBlend": float(light.spot_blend) if light.type == "SPOT" else None,
            }
            if schema_version == 3:
                light_entry["areaSize"] = (
                    float(light.size) if light.type == "AREA" else None
                )
            lights.append(light_entry)

    fps_numerator, fps_denominator = rational_fps(
        int(blender_scene.render.fps), float(blender_scene.render.fps_base)
    )
    manifest_parts = dict(
        project_id=project_id,
        blender_version=_text(bpy.app.version_string),
        scene={
            "name": _text(blender_scene.name),
            "frameStart": int(blender_scene.frame_start),
            "frameEnd": int(blender_scene.frame_end),
            "fpsNumerator": fps_numerator,
            "fpsDenominator": fps_denominator,
            "activeCameraId": object_ids.get(blender_scene.camera),
        },
        render={
            "resolutionX": int(blender_scene.render.resolution_x),
            "resolutionY": int(blender_scene.render.resolution_y),
            "resolutionPercentage": int(blender_scene.render.resolution_percentage),
        },
        objects=[_manifest_object(scene_object) for scene_object in scene_objects],
        bones=_manifest_bones(scene_objects),
        cameras=cameras,
        lights=lights,
        markers=[
            {
                "name": _text(marker.name),
                "frame": int(marker.frame),
                "cameraId": object_ids.get(marker.camera),
            }
            for marker in blender_scene.timeline_markers
        ],
        selected_entity_ids=[
            object_ids[scene_object]
            for scene_object in scene_objects
            if scene_object.select_get()
        ],
        camera_animations=animations,
    )
    if schema_version == 3:
        stage_primitives, stage_materials = _stage_manifest_entries(
            scene_objects, object_ids
        )
        manifest = build_scene_manifest_v3(
            **manifest_parts,
            stage_primitives=stage_primitives,
            stage_materials=stage_materials,
        )
    else:
        manifest = build_scene_manifest(**manifest_parts)
    return finalize_scene_manifest(manifest)


def extract_scene_manifest_v2() -> dict:
    """Extract the active Blender scene through SceneManifestV2."""
    return _extract_scene_manifest(2)


def extract_scene_manifest_v3() -> dict:
    """Extract stage_scene state through the additive SceneManifestV3."""
    return _extract_scene_manifest(3)

def extract_scene_snapshot() -> dict:
    """Extract the active Blender scene into a Scene Snapshot v2 dictionary."""
    blender_scene = bpy.context.scene
    if blender_scene.render.fps_base != 1.0:
        raise UNSUPPORTED_FPS_BASE(
            f"fps_base must be 1.0, got {blender_scene.render.fps_base!r}"
        )

    scene_objects = list(blender_scene.objects)
    objects = [_object_snapshot(scene_object) for scene_object in scene_objects]
    normalized_names = [item["name"] for item in objects]
    if len(normalized_names) != len(set(normalized_names)):
        raise ValueError("object names must be unique after NFC normalization")
    cameras = [
        _camera_snapshot(scene_object)
        for scene_object in scene_objects
        if scene_object.type == "CAMERA"
    ]
    animations = []
    for scene_object in scene_objects:
        object_animation = _animation_snapshot(
            _text(scene_object.name), "object", scene_object.animation_data
        )
        if object_animation is not None:
            animations.append(object_animation)
        if scene_object.type == "CAMERA":
            camera_animation = _animation_snapshot(
                _text(scene_object.name), "cameraData", scene_object.data.animation_data
            )
            if camera_animation is not None:
                animations.append(camera_animation)

    return assemble_snapshot(
        scene={
            "name": _text(blender_scene.name),
            "frameStart": int(blender_scene.frame_start),
            "frameEnd": int(blender_scene.frame_end),
            "fps": int(blender_scene.render.fps),
            "activeCamera": _text(blender_scene.camera.name) if blender_scene.camera else None,
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
                "name": _text(marker.name),
                "frame": int(marker.frame),
                "camera": _text(marker.camera.name) if marker.camera else None,
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


def write_scene_manifest_v2(output_path: Path) -> str:
    """Write a real Blender-extracted SceneManifestV2 and return its revision."""
    scene_manifest = extract_scene_manifest_v2()
    output_path.write_text(
        json.dumps(scene_manifest, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    revision = scene_manifest["revisionId"]
    print(revision)
    return revision
