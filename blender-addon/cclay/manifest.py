"""Thin Blender extraction layer for Scene Snapshot v2."""

from __future__ import annotations

import json
import re
import math
from pathlib import Path
import unicodedata
from typing import Iterable

import bpy
from mathutils import Quaternion

from .canonical import canonical_json
from .snapshot import (
    UNSUPPORTED_FCURVE_FEATURE,
    UNSUPPORTED_FPS_BASE,
    UNSUPPORTED_LINKED_DATABLOCK,
    assemble_snapshot,
    canonical_quaternion,
    snapshot_revision,
)
from .manifest_fields_generated import (
    generated_camera_manifest_fields,
    generated_light_manifest_fields,
)
from .entity_animation import (
    MAX_BONES,
    MAX_MATERIALS,
    summarize_animation_curves,
)
from .scene_manifest import (
    build_scene_manifest_v4,
    finalize_scene_manifest,
    PRIMITIVE_TYPES,
    rational_fps,
)


_UUID_V4_LOWERCASE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
def _text(value: str) -> str:
    return unicodedata.normalize("NFC", value)


_EXTENSION_NAMESPACE = re.compile(r"^x-[a-z][a-z0-9-]{0,63}$")
_MAX_EXTENSION_DEPTH = 3
_MAX_EXTENSION_PROPERTIES = 64
_MAX_EXTENSION_NAMESPACES = 16
_MAX_EXTENSION_STRING_LENGTH = 4096
_MAX_EXTENSIONS_BYTES = 65536


def _validate_extension_value(value: object, depth: int, path: str) -> None:
    if isinstance(value, str):
        if len(value) > _MAX_EXTENSION_STRING_LENGTH:
            raise ValueError(f"{path} string exceeds 4096 characters")
        return
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"{path} must contain finite numbers")
        return
    if depth >= _MAX_EXTENSION_DEPTH:
        raise ValueError(f"{path} exceeds maximum depth of 3")
    if isinstance(value, list):
        for index, nested in enumerate(value):
            _validate_extension_value(nested, depth + 1, f"{path}[{index}]")
        return
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain JSON values")
    if len(value) > _MAX_EXTENSION_PROPERTIES:
        raise ValueError(f"{path} exceeds maximum of 64 properties")
    for key, nested in value.items():
        if not isinstance(key, str):
            raise ValueError(f"{path} object keys must be strings")
        _validate_extension_value(nested, depth + 1, f"{path}.{key}")


def validate_extensions(value: dict) -> None:
    if not isinstance(value, dict):
        raise ValueError("extensions must be an object")
    if len(value) > _MAX_EXTENSION_NAMESPACES:
        raise ValueError("extensions exceeds maximum of 16 namespaces")
    for namespace, extension in value.items():
        if not isinstance(namespace, str) or _EXTENSION_NAMESPACE.fullmatch(namespace) is None:
            raise ValueError(f"invalid extension namespace: {namespace}")
        _validate_extension_value(extension, 0, f"extensions.{namespace}")
    byte_length = len(canonical_json(value).encode("utf-8"))
    if byte_length > _MAX_EXTENSIONS_BYTES:
        raise ValueError(
            f"extensions canonical JSON is {byte_length} bytes (maximum 65536)"
        )


def write_extensions(value: dict) -> None:
    validate_extensions(value)
    bpy.context.scene["cclay.extensions_json"] = canonical_json(value)


def _read_extensions(blender_scene: bpy.types.Scene) -> dict | None:
    source = blender_scene.get("cclay.extensions_json")
    if source is None:
        return None
    if not isinstance(source, str):
        raise ValueError("cclay.extensions_json must be a canonical JSON string")
    try:
        value = json.loads(source)
    except json.JSONDecodeError as error:
        raise ValueError("cclay.extensions_json is not valid JSON") from error
    validate_extensions(value)
    if canonical_json(value) != source:
        raise ValueError("cclay.extensions_json must be canonical JSON")
    return value


def _vector(values: Iterable[float]) -> list[float]:
    return [float(value) for value in values]


# Blender's Principled BSDF defaults, which every generated material carried
# before surface finish became settable. Matching values are omitted from the
# manifest so pre-existing scenes keep their exact revision hash.
_DEFAULT_ROUGHNESS = 0.5
_DEFAULT_METALLIC = 0.0


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


def _snapshot_entity_id(scene_object: bpy.types.Object) -> str | None:
    entity_id = scene_object.get("cclay.entity_id")
    if isinstance(entity_id, str) and _UUID_V4_LOWERCASE.fullmatch(entity_id):
        return entity_id
    return None


def _object_snapshot(scene_object: bpy.types.Object) -> dict:
    _check_linked(scene_object)
    return {
        "entityId": _snapshot_entity_id(scene_object),
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


def _is_generated_motion(animation_data: object) -> bool:
    action = animation_data.action if animation_data is not None else None
    return action is not None and (
        isinstance(action.get("cclay.motion_id"), str)
        or action.name.startswith("CCLAY Motion ")
    )


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
            easing_parameter_names = {
                "BACK": ("back",),
                "ELASTIC": ("amplitude", "period"),
            }.get(point.interpolation, ())
            if (
                point.easing != "AUTO"
                or point.interpolation not in interpolation_values
                or any(
                    getattr(point, name) != easing_defaults[name]
                    for name in easing_parameter_names
                )
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


def _tracked_entity_id(entity: object) -> str | None:
    """Return the CCLAY entity id for a Blender ID-block, or None if untracked.

    Untracked entities (created by raw scripts or another add-on, never
    stamped through stage_scene/add_character) are foreign to CCLAY and must
    not brick manifest extraction for the whole scene - they are simply
    omitted, mirroring the scene_relations.py survey pattern.
    """
    entity_id = entity.get("cclay.entity_id")
    return entity_id if isinstance(entity_id, str) else None


def _assembly_entries(
    scene_objects: list[bpy.types.Object],
    object_ids: dict[bpy.types.Object, str],
    *,
    skip_incomplete: bool = False,
) -> list[dict]:
    assemblies = []
    for root in scene_objects:
        assembly_id = root.get("cclay.assembly_id")
        if not isinstance(assembly_id, str):
            continue
        members = {root, *root.children_recursive}
        if skip_incomplete and any(member not in object_ids for member in members):
            continue
        member_ids = sorted(object_ids[member] for member in members)
        assemblies.append({
            "assemblyId": assembly_id,
            "name": _text(root.get("cclay.assembly_name", root.name)),
            "rootEntityId": object_ids[root],
            "memberIds": member_ids,
        })
    return assemblies


def _manifest_object(scene_object: bpy.types.Object) -> dict:
    snapshot = _object_snapshot(scene_object)
    entity_id = _tracked_entity_id(scene_object)
    assert entity_id is not None, "caller must filter to tracked scene_objects"
    return {
        "entityId": entity_id,
        "name": snapshot["name"],
        "type": snapshot["type"],
        "parentId": (
            _tracked_entity_id(scene_object.parent)
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
        armature_id = _tracked_entity_id(scene_object)
        if armature_id is None:
            continue
        for bone in scene_object.data.bones:
            bone_id = _tracked_entity_id(bone)
            if bone_id is None:
                continue
            location, rotation, scale = bone.matrix_local.decompose()
            bones.append(
                {
                    "entityId": bone_id,
                    "name": _text(bone.name),
                    "armatureObjectId": armature_id,
                    "parentBoneId": (
                        _tracked_entity_id(bone.parent)
                        if bone.parent
                        else None
                    ),
                    "location": _vector(location),
                    "rotationQuaternion": canonical_quaternion(rotation),
                    "scale": _vector(scale),
                }
            )
    return bones


def _stage_primitive_shading(scene_object: bpy.types.Object) -> str | None:
    """Face shading of a staged primitive, or None when it is entirely flat.

    Returning None for an all-flat mesh is what keeps this hash-neutral: every
    primitive built before the add-on shaded anything was flat, so those scenes
    export byte-identically and their stored revisions still verify. A smooth or
    partly-smooth mesh is a genuinely different mesh and correctly hashes
    differently.
    """
    if scene_object.type != "MESH":
        return None
    polygons = scene_object.data.polygons
    smooth = sum(1 for polygon in polygons if polygon.use_smooth)
    if smooth == 0:
        return None
    return "SMOOTH" if smooth == len(polygons) else "MIXED"


def _stage_manifest_entries(
    scene_objects: list[bpy.types.Object],
    object_ids: dict[bpy.types.Object, str],
) -> tuple[list[dict], list[dict]]:
    primitives = []
    materials = []
    for scene_object in scene_objects:
        object_id = object_ids[scene_object]
        primitive_type = scene_object.get("cclay.stage_primitive_type")
        if primitive_type in PRIMITIVE_TYPES:
            entry = {
                "objectId": object_id,
                "primitiveType": primitive_type,
            }
            # Face shading is render-visible state, so a stored revision has to be
            # able to prove it. Without it an old flat UV_SPHERE and a newly built
            # smooth one hash identically while rendering differently, and a user
            # smoothing a cube out of band -- exactly the drift this manifest
            # exists to detect -- stays invisible.
            shading = _stage_primitive_shading(scene_object)
            if shading is not None:
                entry["shading"] = shading
            primitives.append(entry)
        if scene_object.type != "MESH" or not scene_object.material_slots:
            continue
        material = scene_object.material_slots[0].material
        if (
            material is not None
            and material.get("cclay.generated_for_entity_id") == object_id
        ):
            principled = (
                material.node_tree.nodes.get("Principled BSDF")
                if material.node_tree is not None
                else None
            )
            entry = {
                "objectId": object_id,
                "materialName": _text(material.name),
                "baseColor": _vector(material.diffuse_color),
                "useNodes": bool(material.use_nodes),
                "principledBaseColor": (
                    _vector(principled.inputs["Base Color"].default_value)
                    if principled is not None
                    else None
                ),
            }
            # Surface finish is recorded only when it leaves the Principled
            # defaults the add-on has always produced, so a scene that never sets
            # it keeps a byte-identical manifest and revision hash.
            if principled is not None:
                for key, socket_name, default in (
                    ("principledRoughness", "Roughness", _DEFAULT_ROUGHNESS),
                    ("principledMetallic", "Metallic", _DEFAULT_METALLIC),
                ):
                    socket = principled.inputs.get(socket_name)
                    if socket is None:
                        continue
                    value = float(socket.default_value)
                    if value != default:
                        entry[key] = value
            materials.append(entry)
    return primitives, materials


def _extract_scene_manifest(schema_version: int) -> dict:
    """Extract the active Blender scene through the negotiated manifest path."""
    blender_scene = bpy.context.scene
    extensions = _read_extensions(blender_scene)
    project_id = blender_scene.get("cclay.project_id")
    if not isinstance(project_id, str):
        raise ValueError("scene is missing cclay.project_id")

    # Untracked objects (created by raw scripts, other add-ons, or manual
    # Blender edits outside stage_scene) are foreign to CCLAY. They are simply
    # excluded from the manifest rather than aborting extraction for the
    # entire scene - one stray Empty must never brick inspect_project.
    scene_objects = [
        scene_object
        for scene_object in blender_scene.objects
        if _tracked_entity_id(scene_object) is not None
    ]
    object_ids = {
        scene_object: _tracked_entity_id(scene_object)
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
                    **generated_camera_manifest_fields(camera),
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
            light_entry["areaSize"] = (
                float(light.size) if light.type == "AREA" else None
            )
            light_entry.update(generated_light_manifest_fields(light))
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
    stage_primitives, stage_materials = _stage_manifest_entries(
        scene_objects, object_ids
    )
    assemblies = _assembly_entries(scene_objects, object_ids)
    manifest = build_scene_manifest_v4(
        **manifest_parts,
        stage_primitives=stage_primitives,
        stage_materials=stage_materials,
        assemblies=assemblies,
    )
    finalized = finalize_scene_manifest(manifest)
    return {**finalized, "extensions": extensions} if extensions is not None else finalized


def extract_scene_manifest_v4() -> dict:
    """Extract assembly hierarchy through SceneManifestV4."""
    return _extract_scene_manifest(4)


def resolve_manifest_for_expected_hash(expected_hash: str) -> dict | None:
    """Return the V4 manifest matching the expected scene hash."""
    manifest = extract_scene_manifest_v4()
    return manifest if manifest["sceneHash"] == expected_hash else None

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
    object_ids = {
        scene_object: entity_id
        for scene_object in scene_objects
        if (entity_id := _snapshot_entity_id(scene_object)) is not None
    }
    assemblies = _assembly_entries(scene_objects, object_ids, skip_incomplete=True)
    cameras = [
        _camera_snapshot(scene_object)
        for scene_object in scene_objects
        if scene_object.type == "CAMERA"
    ]
    animations = []
    for scene_object in scene_objects:
        object_animation = (
            None
            if _is_generated_motion(scene_object.animation_data)
            else _animation_snapshot(
                _text(scene_object.name), "object", scene_object.animation_data
            )
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
        assemblies=assemblies,
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


def write_scene_manifest(output_path: Path) -> str:
    """Write a real Blender-extracted SceneManifestV4 and return its revision."""
    scene_manifest = extract_scene_manifest_v4()
    output_path.write_text(
        json.dumps(scene_manifest, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    revision = scene_manifest["revisionId"]
    print(revision)
    return revision


def _entity_detail(entity_id: str, scope: str, animation_query=None) -> dict | None:
    """Return full detail for one entity, selected by scope.

    scope 'bones': armature bone hierarchy with transforms (rigged characters).
    scope 'animation': fcurves/keyframes for the entity and its data-block.
    scope 'material': material slots and node inputs.
    scope 'all': bones + animation + material.
    """
    target = next(
        (obj for obj in bpy.data.objects if obj.get("cclay.entity_id") == entity_id),
        None,
    )
    if target is None:
        return None
    detail: dict = {
        "name": _text(target.name),
        "type": _text(target.type),
        "location": _vector(target.location),
        "rotationMode": _text(target.rotation_mode),
        "rotationQuaternion": _object_quaternion(target),
        "scale": _vector(target.scale),
        "parent": _text(target.parent.name) if target.parent else None,
    }
    if scope in ("bones", "all") and target.type == "ARMATURE":
        bones = []
        for bone in target.data.bones:
            bones.append({
                "name": _text(bone.name),
                "parent": _text(bone.parent.name) if bone.parent else None,
                "head": _vector(bone.head_local),
                "tail": _vector(bone.tail_local),
                "length": float(bone.length),
                "useConnect": bool(bone.use_connect),
            })
        # Bound the bone section so scope "all" has a real ceiling; the cap
        # lives in entity_animation.py (bpy-free) so the pure tests can reach it.
        bones_omitted = len(bones) - MAX_BONES
        if bones_omitted > 0:
            detail["bonesOmitted"] = bones_omitted
        detail["bones"] = bones[:MAX_BONES]
    if scope in ("animation", "all"):
        # Build the raw curve list exactly as before, then delegate to the
        # pure summarizer so a fully-keyed rig cannot blow the model context
        # window (see the 2 MB incident). animation_query carries the optional
        # data_path_filter / frame_start / frame_end narrowing params.
        curves = []
        for source_label, anim_data in (
            ("object", target.animation_data),
            ("data", target.data.animation_data if target.data is not None else None),
        ):
            if anim_data is None:
                continue
            fcurves = animation_fcurves(anim_data)
            for fc in fcurves:
                keyframes = [
                    {
                        "frame": int(kp.co[0]),
                        "value": float(kp.co[1]),
                        "interpolation": _text(kp.interpolation),
                    }
                    for kp in fc.keyframe_points
                ]
                curves.append({
                    "source": source_label,
                    "dataPath": _text(fc.data_path),
                    "arrayIndex": int(fc.array_index),
                    "keyframes": keyframes,
                })
        query = animation_query or {}
        result = summarize_animation_curves(
            curves,
            data_path_filter=query.get("data_path_filter"),
            frame_start=query.get("frame_start"),
            frame_end=query.get("frame_end"),
        )
        detail["animations"] = result["animations"]
        detail["animationSummary"] = result["summary"]
    if scope in ("material", "all") and target.type == "MESH":
        materials = []
        for slot in target.material_slots:
            mat = slot.material
            if mat is None:
                materials.append({"slot": _text(slot.name), "material": None})
                continue
            principled = (
                mat.node_tree.nodes.get("Principled BSDF")
                if mat.use_nodes and mat.node_tree is not None
                else None
            )
            base_color = (
                tuple(principled.inputs["Base Color"].default_value)
                if principled is not None
                else None
            )
            materials.append({
                "slot": _text(slot.name),
                "material": _text(mat.name),
                "useNodes": bool(mat.use_nodes),
                "baseColor": list(base_color) if base_color else None,
            })
        # Bound the material section so scope "all" has a real ceiling.
        materials_omitted = len(materials) - MAX_MATERIALS
        if materials_omitted > 0:
            detail["materialsOmitted"] = materials_omitted
        detail["materials"] = materials[:MAX_MATERIALS]
    # The whole-envelope byte ceiling is applied by the caller
    # (connection._inspect_entity_result), which is where the revision,
    # entity_id, and scope fields the bridge also measures are known.
    return detail
