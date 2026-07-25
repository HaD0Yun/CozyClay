"""Blender-independent assembly and validation for SceneManifestV2/V3/V4."""

from __future__ import annotations

import copy
import math
import re
import unicodedata
from math import gcd

from .canonical import canonical_json, canonical_revision
from .revision import child_revision_id, initial_revision_id
from .snapshot import EXPORT_MAGNITUDE, EXPORT_NONFINITE, ExportError, UNSUPPORTED_FPS_BASE

_UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_MAGNITUDE = 1e15

# The one list of buildable shapes for the add-on. `manifest.py` and
# `stage_scene.py` import this rather than repeating the tuple, because separate
# copies are what let validation, construction and export disagree.
#
# Every shape is authored to fit the -1..1 unit box so `scale` means the same
# thing for all of them. Mirrors primitiveTypeSchema() in the protocol package.
PRIMITIVE_TYPES = ("PLANE", "CUBE", "UV_SPHERE", "CYLINDER", "CONE", "CIRCLE", "TORUS")
# Face shading a staged primitive can report. Absent from an entry means every
# face is flat; only a non-flat mesh says so, which is what keeps manifests
# written before shading existed byte-identical. Mirrors StagePrimitiveSchema.
PRIMITIVE_SHADINGS = ("SMOOTH", "MIXED")

_MANIFEST_V2_KEYS = {
    "schemaVersion", "projectId", "revisionId", "sceneHash", "blenderVersion",
    "scene", "render", "objects", "bones", "cameras", "lights", "markers",
    "selectedEntityIds", "cameraAnimations",
}
_MANIFEST_V3_KEYS = _MANIFEST_V2_KEYS | {"stagePrimitives", "stageMaterials"}
_MANIFEST_V4_KEYS = _MANIFEST_V3_KEYS | {"assemblies"}
_ASSEMBLY_KEYS = {"assemblyId", "name", "rootEntityId", "memberIds"}
_SCENE_KEYS = {"name", "frameStart", "frameEnd", "fpsNumerator", "fpsDenominator", "activeCameraId"}
_RENDER_KEYS = {"resolutionX", "resolutionY", "resolutionPercentage"}
_OBJECT_KEYS = {"entityId", "name", "type", "parentId", "visible", "location", "rotationQuaternion", "scale"}
_BONE_KEYS = {"entityId", "name", "armatureObjectId", "parentBoneId", "location", "rotationQuaternion", "scale"}
_CAMERA_KEYS = {
    "objectId", "lens", "sensorFit", "sensorWidth", "sensorHeight",
    "verticalFovRadians", "clipStart", "clipEnd",
}
_LIGHT_KEYS = {"objectId", "lightType", "color", "energy", "spotSize", "spotBlend"}
_LIGHT_V3_KEYS = _LIGHT_KEYS | {"areaSize"}
_STAGE_PRIMITIVE_KEYS = {"objectId", "primitiveType", "shading"}
_STAGE_MATERIAL_KEYS = {
    "objectId", "materialName", "baseColor", "useNodes",
    "principledBaseColor",
    # Optional: emitted only when the finish leaves Blender's Principled defaults,
    # so manifests written before surface finish existed stay hash-identical.
    "principledRoughness", "principledMetallic",
}
_MARKER_KEYS = {"name", "frame", "cameraId"}
_CAMERA_ANIMATION_KEYS = {"objectId", "target", "fcurves"}
_FCURVE_KEYS = {"dataPath", "arrayIndex", "keyframes"}
_KEYFRAME_KEYS = {
    "frame", "value", "interpolation", "handleLeft", "handleRight",
    "handleLeftType", "handleRightType",
}


class INVALID_SCENE_MANIFEST(ExportError):
    code = "INVALID_SCENE_MANIFEST"


class INVALID_MANIFEST_REFERENCE(ExportError):
    code = "INVALID_MANIFEST_REFERENCE"


def rational_fps(fps: int, fps_base: float) -> tuple[int, int]:
    """Convert Blender's supported nominal FPS settings to an exact rational."""
    if isinstance(fps, bool) or not isinstance(fps, int) or fps < 1:
        raise INVALID_SCENE_MANIFEST("fps must be a positive integer")
    if fps_base == 1.0:
        return fps, 1
    if math.isfinite(fps_base) and abs(fps_base - 1.001) <= 1e-9:
        numerator, denominator = fps * 1000, 1001
        divisor = gcd(numerator, denominator)
        return numerator // divisor, denominator // divisor
    raise UNSUPPORTED_FPS_BASE(f"unsupported fps_base: {fps_base!r}")


def _fail(path: str, requirement: str) -> None:
    raise INVALID_SCENE_MANIFEST(f"{path} {requirement}")


def _exact_keys(value: object, expected: set[str], path: str) -> None:
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    extra = set(value) - expected
    if extra:
        _fail(path, f"has unknown fields: {sorted(extra)}")


def _uuid(value: object, path: str, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str) or _UUID4.fullmatch(value) is None:
        _fail(path, "must be a lowercase UUIDv4")


def _number(value: object, path: str, minimum: float | None = None, maximum: float | None = None) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "must be a number")
    if not math.isfinite(value):
        raise EXPORT_NONFINITE(f"{path} contains NaN or infinity")
    if abs(value) >= MAX_MAGNITUDE:
        raise EXPORT_MAGNITUDE(f"{path} has magnitude >= 1e15")
    if minimum is not None and value < minimum:
        _fail(path, f"must be >= {minimum}")
    if maximum is not None and value > maximum:
        _fail(path, f"must be <= {maximum}")


def _integer(value: object, path: str, minimum: int | None = None, maximum: int | None = None) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(path, "must be an integer")
    _number(value, path, minimum, maximum)


def _string(value: object, path: str, minimum: int = 0, maximum: int | None = None) -> None:
    if not isinstance(value, str) or len(value) < minimum or (maximum is not None and len(value) > maximum):
        _fail(path, "has invalid string length")
    if unicodedata.normalize("NFC", value) != value:
        _fail(path, "must be NFC-normalized")


def _vector(value: object, length: int, path: str) -> None:
    if not isinstance(value, list) or len(value) != length:
        _fail(path, f"must contain exactly {length} numbers")
    for index, component in enumerate(value):
        _number(component, f"{path}[{index}]")


def _quaternion(value: object, path: str) -> None:
    _vector(value, 4, path)
    w, x, y, z = value
    if abs(math.hypot(w, x, y, z) - 1) > 1e-6:
        _fail(path, "must have unit length within 1e-6")
    first = x if x != 0 else y if y != 0 else z
    if w < 0 or (w == 0 and first <= 0):
        _fail(path, "must use canonical quaternion sign")


def _assert_sorted(values: list, key, label: str) -> None:
    for index in range(1, len(values)):
        if key(values[index - 1]) > key(values[index]):
            _fail(label, "must be in semantic order")


def _validate_manifest(manifest: dict) -> None:
    schema_version = manifest.get("schemaVersion")
    if schema_version not in (2, 3, 4):
        _fail("schemaVersion", "must equal 2, 3, or 4")
    _exact_keys(
        manifest,
        (
            _MANIFEST_V4_KEYS if schema_version == 4
            else _MANIFEST_V3_KEYS if schema_version == 3
            else _MANIFEST_V2_KEYS
        ),
        "manifest",
    )
    _uuid(manifest.get("projectId"), "projectId")
    _string(manifest.get("blenderVersion"), "blenderVersion")

    scene = manifest.get("scene")
    render = manifest.get("render")
    _exact_keys(scene, _SCENE_KEYS, "scene")
    _exact_keys(render, _RENDER_KEYS, "render")
    _string(scene.get("name"), "scene.name", 1, 256)
    _integer(scene.get("frameStart"), "scene.frameStart", 0, 1_048_574)
    _integer(scene.get("frameEnd"), "scene.frameEnd", 0, 1_048_574)
    if scene["frameEnd"] < scene["frameStart"]:
        _fail("scene.frameEnd", "must be >= scene.frameStart")
    _integer(scene.get("fpsNumerator"), "scene.fpsNumerator", 1)
    _integer(scene.get("fpsDenominator"), "scene.fpsDenominator", 1)
    if gcd(scene["fpsNumerator"], scene["fpsDenominator"]) != 1:
        _fail("scene.fpsNumerator/fpsDenominator", "must be a reduced rational")
    _uuid(scene.get("activeCameraId"), "scene.activeCameraId", True)
    for key, maximum in (("resolutionX", 65536), ("resolutionY", 65536)):
        _integer(render.get(key), f"render.{key}", 1, maximum)
    _integer(render.get("resolutionPercentage"), "render.resolutionPercentage", 1, 100)

    arrays = {}
    array_keys = [
        "objects", "bones", "cameras", "lights", "markers",
        "selectedEntityIds", "cameraAnimations",
    ]
    if schema_version >= 3:
        array_keys.extend(("stagePrimitives", "stageMaterials"))
    if schema_version == 4:
        array_keys.append("assemblies")
    for key in array_keys:
        value = manifest.get(key)
        if not isinstance(value, list):
            _fail(key, "must be an array")
        arrays[key] = value

    # objects/bones are identified by their own entityId; cameras/lights are
    # identified by their owning object's entityId (architecture doc line 203:
    # "Camera, light, and armature identities use their owning object ID").
    entity_ids: dict[str, set[str]] = {"objects": set(), "bones": set()}
    for key, item_keys in (("objects", _OBJECT_KEYS), ("bones", _BONE_KEYS)):
        for index, item in enumerate(arrays[key]):
            _exact_keys(item, item_keys, f"{key}[{index}]")
            _uuid(item.get("entityId"), f"{key}[{index}].entityId")
            entity_id = item["entityId"]
            if entity_id in entity_ids[key]:
                _fail(key, "must not contain duplicate entityId values")
            entity_ids[key].add(entity_id)
    _assert_sorted(arrays["objects"], lambda item: item["entityId"], "objects")
    _assert_sorted(arrays["bones"], lambda item: item["entityId"], "bones")

    objects_by_id = {item["entityId"]: item for item in arrays["objects"]}
    for index, item in enumerate(arrays["objects"]):
        path = f"objects[{index}]"
        _string(item.get("name"), f"{path}.name")
        _string(item.get("type"), f"{path}.type")
        _uuid(item.get("parentId"), f"{path}.parentId", True)
        if not isinstance(item.get("visible"), bool):
            _fail(f"{path}.visible", "must be a boolean")
        _vector(item.get("location"), 3, f"{path}.location")
        _quaternion(item.get("rotationQuaternion"), f"{path}.rotationQuaternion")
        _vector(item.get("scale"), 3, f"{path}.scale")
        if item["parentId"] is not None and item["parentId"] not in objects_by_id:
            raise INVALID_MANIFEST_REFERENCE(f"{path}.parentId references no object")

    for index, item in enumerate(arrays["bones"]):
        path = f"bones[{index}]"
        _string(item.get("name"), f"{path}.name")
        _uuid(item.get("armatureObjectId"), f"{path}.armatureObjectId")
        _uuid(item.get("parentBoneId"), f"{path}.parentBoneId", True)
        _vector(item.get("location"), 3, f"{path}.location")
        _quaternion(item.get("rotationQuaternion"), f"{path}.rotationQuaternion")
        _vector(item.get("scale"), 3, f"{path}.scale")
        armature = objects_by_id.get(item["armatureObjectId"])
        if armature is None:
            raise INVALID_MANIFEST_REFERENCE(f"{path}.armatureObjectId references no object")
        if armature["type"] != "ARMATURE":
            raise INVALID_MANIFEST_REFERENCE(f"{path}.armatureObjectId must reference an ARMATURE object")
        if item["parentBoneId"] is not None and item["parentBoneId"] not in entity_ids["bones"]:
            raise INVALID_MANIFEST_REFERENCE(f"{path}.parentBoneId references no bone")

    camera_object_ids: set[str] = set()
    for index, item in enumerate(arrays["cameras"]):
        path = f"cameras[{index}]"
        _exact_keys(item, _CAMERA_KEYS, path)
        _uuid(item.get("objectId"), f"{path}.objectId")
        if item["objectId"] in camera_object_ids:
            _fail("cameras", "must contain exactly one entry per camera object")
        camera_object_ids.add(item["objectId"])
        if item["objectId"] not in objects_by_id or objects_by_id[item["objectId"]]["type"] != "CAMERA":
            raise INVALID_MANIFEST_REFERENCE(f"{path}.objectId must reference a CAMERA object")
        _number(item.get("lens"), f"{path}.lens", 0)
        if item["lens"] <= 0:
            _fail(f"{path}.lens", "must be > 0")
        if item.get("sensorFit") not in ("AUTO", "HORIZONTAL", "VERTICAL"):
            _fail(f"{path}.sensorFit", "is unsupported")
        for field in ("sensorWidth", "sensorHeight", "clipStart"):
            _number(item.get(field), f"{path}.{field}", 0)
            if item[field] <= 0:
                _fail(f"{path}.{field}", "must be > 0")
        _number(item.get("verticalFovRadians"), f"{path}.verticalFovRadians")
        if not 0 < item["verticalFovRadians"] < math.pi:
            _fail(f"{path}.verticalFovRadians", "must be between 0 and pi")
        _number(item.get("clipEnd"), f"{path}.clipEnd")
        if item["clipEnd"] <= item["clipStart"]:
            _fail(f"{path}.clipEnd", "must be > clipStart")
    _assert_sorted(arrays["cameras"], lambda item: item["objectId"], "cameras")
    expected_camera_objects = {key for key, item in objects_by_id.items() if item["type"] == "CAMERA"}
    if camera_object_ids != expected_camera_objects:
        raise INVALID_MANIFEST_REFERENCE("every CAMERA object must have exactly one camera entry")

    light_object_ids: set[str] = set()
    for index, item in enumerate(arrays["lights"]):
        path = f"lights[{index}]"
        _exact_keys(item, _LIGHT_V3_KEYS if schema_version >= 3 else _LIGHT_KEYS, path)
        _uuid(item.get("objectId"), f"{path}.objectId")
        if item["objectId"] in light_object_ids:
            _fail("lights", "must contain exactly one entry per light object")
        light_object_ids.add(item["objectId"])
        if item["objectId"] not in objects_by_id or objects_by_id[item["objectId"]]["type"] != "LIGHT":
            raise INVALID_MANIFEST_REFERENCE(f"{path}.objectId must reference a LIGHT object")
        if item.get("lightType") not in ("POINT", "SUN", "SPOT", "AREA"):
            _fail(f"{path}.lightType", "is unsupported")
        _vector(item.get("color"), 3, f"{path}.color")
        if any(component < 0 or component > 1 for component in item["color"]):
            _fail(f"{path}.color", "components must be between 0 and 1")
        _number(item.get("energy"), f"{path}.energy", 0)
        spot = item["lightType"] == "SPOT"
        for field in ("spotSize", "spotBlend"):
            value = item.get(field)
            if spot:
                _number(value, f"{path}.{field}")
            elif value is not None:
                _fail(f"{path}.{field}", "must be null for non-SPOT lights")
        if schema_version >= 3:
            area_size = item.get("areaSize")
            if item["lightType"] == "AREA":
                _number(area_size, f"{path}.areaSize")
                if area_size <= 0:
                    _fail(f"{path}.areaSize", "must be > 0")
            elif area_size is not None:
                _fail(f"{path}.areaSize", "must be null for non-AREA lights")
    _assert_sorted(arrays["lights"], lambda item: item["objectId"], "lights")
    expected_light_objects = {key for key, item in objects_by_id.items() if item["type"] == "LIGHT"}
    if light_object_ids != expected_light_objects:
        raise INVALID_MANIFEST_REFERENCE("every LIGHT object must have exactly one light entry")

    # activeCameraId/markers[].cameraId reference the owning CAMERA object's
    # entityId directly, matching camera identity (line 203) -- not a
    # separate per-camera-entry identifier.
    if scene["activeCameraId"] is not None and scene["activeCameraId"] not in camera_object_ids:
        raise INVALID_MANIFEST_REFERENCE("scene.activeCameraId references no camera")
    for index, item in enumerate(arrays["markers"]):
        path = f"markers[{index}]"
        _exact_keys(item, _MARKER_KEYS, path)
        _string(item.get("name"), f"{path}.name")
        _integer(item.get("frame"), f"{path}.frame")
        _uuid(item.get("cameraId"), f"{path}.cameraId", True)
        if item["cameraId"] is not None and item["cameraId"] not in camera_object_ids:
            raise INVALID_MANIFEST_REFERENCE(f"{path}.cameraId references no camera")
    _assert_sorted(
        arrays["markers"],
        lambda item: (item["name"], item["frame"], item["cameraId"] is not None, item["cameraId"] or ""),
        "markers",
    )

    for index, entity_id in enumerate(arrays["selectedEntityIds"]):
        _uuid(entity_id, f"selectedEntityIds[{index}]")
    if len(set(arrays["selectedEntityIds"])) != len(arrays["selectedEntityIds"]):
        _fail("selectedEntityIds", "must not contain duplicates")
    _assert_sorted(arrays["selectedEntityIds"], lambda value: value, "selectedEntityIds")

    if schema_version >= 3:
        for key, item_keys in (
            ("stagePrimitives", _STAGE_PRIMITIVE_KEYS),
            ("stageMaterials", _STAGE_MATERIAL_KEYS),
        ):
            seen_object_ids: set[str] = set()
            for index, item in enumerate(arrays[key]):
                path = f"{key}[{index}]"
                _exact_keys(item, item_keys, path)
                _uuid(item.get("objectId"), f"{path}.objectId")
                if item["objectId"] in seen_object_ids:
                    _fail(key, "must not contain duplicate objectId values")
                seen_object_ids.add(item["objectId"])
                if objects_by_id.get(item["objectId"], {}).get("type") != "MESH":
                    raise INVALID_MANIFEST_REFERENCE(
                        f"{path}.objectId must reference a MESH object"
                    )
                if key == "stagePrimitives":
                    if item.get("primitiveType") not in PRIMITIVE_TYPES:
                        _fail(f"{path}.primitiveType", "is unsupported")
                    # Optional: absent means every face is flat, which is what
                    # every primitive built before shading existed was, so older
                    # manifests stay byte-identical and keep their revision hash.
                    if "shading" in item and item["shading"] not in PRIMITIVE_SHADINGS:
                        _fail(f"{path}.shading", "is unsupported")
                else:
                    _string(item.get("materialName"), f"{path}.materialName", 1, 256)
                    _vector(item.get("baseColor"), 4, f"{path}.baseColor")
                    if any(component < 0 or component > 1 for component in item["baseColor"]):
                        _fail(f"{path}.baseColor", "components must be between 0 and 1")
                    if not isinstance(item.get("useNodes"), bool):
                        _fail(f"{path}.useNodes", "must be a boolean")
                    principled_base_color = item.get("principledBaseColor")
                    if principled_base_color is not None:
                        _vector(
                            principled_base_color,
                            4,
                            f"{path}.principledBaseColor",
                        )
                        if any(
                            component < 0 or component > 1
                            for component in principled_base_color
                        ):
                            _fail(
                                f"{path}.principledBaseColor",
                                "components must be between 0 and 1",
                            )
                    # Optional: present only when the finish leaves the Principled
                    # defaults, which is what keeps older manifests hash-identical.
                    for finish in ("principledRoughness", "principledMetallic"):
                        if finish not in item:
                            continue
                        value = item[finish]
                        if (
                            isinstance(value, bool)
                            or not isinstance(value, (int, float))
                            or not 0 <= value <= 1
                        ):
                            _fail(f"{path}.{finish}", "must be a number between 0 and 1")
            _assert_sorted(arrays[key], lambda item: item["objectId"], key)
    if schema_version == 4:
        assembly_ids: set[str] = set()
        member_ids: set[str] = set()
        for index, item in enumerate(arrays["assemblies"]):
            path = f"assemblies[{index}]"
            _exact_keys(item, _ASSEMBLY_KEYS, path)
            _uuid(item.get("assemblyId"), f"{path}.assemblyId")
            _string(item.get("name"), f"{path}.name", 1, 256)
            _uuid(item.get("rootEntityId"), f"{path}.rootEntityId")
            if item["assemblyId"] in assembly_ids:
                _fail("assemblies", "must not contain duplicate assemblyId values")
            assembly_ids.add(item["assemblyId"])
            root = objects_by_id.get(item["rootEntityId"])
            if root is None or root["type"] != "EMPTY":
                raise INVALID_MANIFEST_REFERENCE(
                    f"{path}.rootEntityId must reference an EMPTY object"
                )
            if not isinstance(item.get("memberIds"), list):
                _fail(f"{path}.memberIds", "must be an array")
            if item["rootEntityId"] not in item["memberIds"]:
                raise INVALID_MANIFEST_REFERENCE(
                    f"{path}.rootEntityId must be included in memberIds"
                )
            for member_index, member_id in enumerate(item["memberIds"]):
                _uuid(member_id, f"{path}.memberIds[{member_index}]")
                if member_id not in objects_by_id:
                    raise INVALID_MANIFEST_REFERENCE(
                        f"{path}.memberIds[{member_index}] references no object"
                    )
                if member_id in member_ids:
                    _fail("assemblies", "members must belong to at most one assembly")
                member_ids.add(member_id)
            _assert_sorted(item["memberIds"], lambda value: value, f"{path}.memberIds")
        _assert_sorted(arrays["assemblies"], lambda item: item["assemblyId"], "assemblies")

    animation_targets: set[tuple[str, str]] = set()
    for animation_index, animation in enumerate(arrays["cameraAnimations"]):
        path = f"cameraAnimations[{animation_index}]"
        _exact_keys(animation, _CAMERA_ANIMATION_KEYS, path)
        _uuid(animation.get("objectId"), f"{path}.objectId")
        if (
            animation["objectId"] not in objects_by_id
            or objects_by_id[animation["objectId"]]["type"] != "CAMERA"
        ):
            raise INVALID_MANIFEST_REFERENCE(f"{path}.objectId must reference a CAMERA object")
        if animation.get("target") not in ("object", "cameraData"):
            _fail(f"{path}.target", "is unsupported")
        identity = (animation["objectId"], animation["target"])
        if identity in animation_targets:
            _fail("cameraAnimations", "must contain at most one entry per object and target")
        animation_targets.add(identity)
        fcurves = animation.get("fcurves")
        if not isinstance(fcurves, list):
            _fail(f"{path}.fcurves", "must be an array")
        fcurve_identities: set[tuple[str, int]] = set()
        for fcurve_index, fcurve in enumerate(fcurves):
            fcurve_path = f"{path}.fcurves[{fcurve_index}]"
            _exact_keys(fcurve, _FCURVE_KEYS, fcurve_path)
            _string(fcurve.get("dataPath"), f"{fcurve_path}.dataPath", 1)
            _integer(fcurve.get("arrayIndex"), f"{fcurve_path}.arrayIndex", 0)
            fcurve_identity = (fcurve["dataPath"], fcurve["arrayIndex"])
            if fcurve_identity in fcurve_identities:
                _fail(f"{path}.fcurves", "must not contain duplicate dataPath and arrayIndex pairs")
            fcurve_identities.add(fcurve_identity)
            keyframes = fcurve.get("keyframes")
            if not isinstance(keyframes, list):
                _fail(f"{fcurve_path}.keyframes", "must be an array")
            frames: set[float | int] = set()
            for keyframe_index, keyframe in enumerate(keyframes):
                keyframe_path = f"{fcurve_path}.keyframes[{keyframe_index}]"
                _exact_keys(keyframe, _KEYFRAME_KEYS, keyframe_path)
                _number(keyframe.get("frame"), f"{keyframe_path}.frame")
                _number(keyframe.get("value"), f"{keyframe_path}.value")
                if keyframe["frame"] in frames:
                    _fail(f"{fcurve_path}.keyframes", "must not contain duplicate frames")
                frames.add(keyframe["frame"])
                _string(keyframe.get("interpolation"), f"{keyframe_path}.interpolation", 1)
                _vector(keyframe.get("handleLeft"), 2, f"{keyframe_path}.handleLeft")
                _vector(keyframe.get("handleRight"), 2, f"{keyframe_path}.handleRight")
                _string(keyframe.get("handleLeftType"), f"{keyframe_path}.handleLeftType", 1)
                _string(keyframe.get("handleRightType"), f"{keyframe_path}.handleRightType", 1)
            _assert_sorted(keyframes, lambda item: item["frame"], f"{fcurve_path}.keyframes")
        _assert_sorted(
            fcurves,
            lambda item: (item["dataPath"], item["arrayIndex"]),
            f"{path}.fcurves",
        )
    _assert_sorted(
        arrays["cameraAnimations"],
        lambda item: (item["objectId"], item["target"]),
        "cameraAnimations",
    )


def build_scene_manifest(
    project_id: str,
    blender_version: str,
    scene: dict,
    render: dict,
    objects: list[dict],
    bones: list[dict],
    cameras: list[dict],
    lights: list[dict],
    markers: list[dict],
    selected_entity_ids: list[str],
    camera_animations: list[dict],
) -> dict:
    """Validate, copy, and semantically order already-extracted scene data."""
    ordered_animations = copy.deepcopy(camera_animations)
    for animation in ordered_animations:
        for fcurve in animation["fcurves"]:
            fcurve["keyframes"].sort(key=lambda item: item["frame"])
        animation["fcurves"].sort(key=lambda item: (item["dataPath"], item["arrayIndex"]))
    ordered_animations.sort(key=lambda item: (item["objectId"], item["target"]))
    manifest = {
        "schemaVersion": 2,
        "projectId": project_id,
        "blenderVersion": blender_version,
        "scene": copy.deepcopy(scene),
        "render": copy.deepcopy(render),
        "objects": sorted(copy.deepcopy(objects), key=lambda item: item["entityId"]),
        "bones": sorted(copy.deepcopy(bones), key=lambda item: item["entityId"]),
        "cameras": sorted(copy.deepcopy(cameras), key=lambda item: item["objectId"]),
        "lights": sorted(copy.deepcopy(lights), key=lambda item: item["objectId"]),
        "markers": sorted(copy.deepcopy(markers), key=lambda item: (item["name"], item["frame"], item["cameraId"] is not None, item["cameraId"] or "")),
        "selectedEntityIds": sorted(set(copy.deepcopy(selected_entity_ids))),
        "cameraAnimations": ordered_animations,
    }
    _validate_manifest(manifest)
    return manifest


def build_scene_manifest_v3(
    *,
    stage_primitives: list[dict],
    stage_materials: list[dict],
    **parts,
) -> dict:
    """Build the minimal additive manifest needed by stage_scene."""
    lights = copy.deepcopy(parts["lights"])
    v2_parts = {
        **parts,
        "lights": [
            {key: value for key, value in item.items() if key != "areaSize"}
            for item in lights
        ],
    }
    manifest = build_scene_manifest(**v2_parts)
    manifest["schemaVersion"] = 3
    manifest["lights"] = sorted(lights, key=lambda item: item["objectId"])
    manifest["stagePrimitives"] = sorted(
        copy.deepcopy(stage_primitives), key=lambda item: item["objectId"]
    )
    manifest["stageMaterials"] = sorted(
        copy.deepcopy(stage_materials), key=lambda item: item["objectId"]
    )
    _validate_manifest(manifest)
    return manifest


def build_scene_manifest_v4(*, assemblies: list[dict], **parts) -> dict:
    """Build the assembly-aware additive scene manifest."""
    manifest = build_scene_manifest_v3(**parts)
    manifest["schemaVersion"] = 4
    manifest["assemblies"] = sorted(
        copy.deepcopy(assemblies), key=lambda item: item["assemblyId"]
    )
    _validate_manifest(manifest)
    return manifest

def _scene_hash_preimage(manifest: dict) -> dict:
    """Return durable, render-semantic state used to derive sceneHash."""
    preimage = {
        key: value
        for key, value in manifest.items()
        if key not in ("revisionId", "sceneHash", "selectedEntityIds", "blenderVersion")
    }
    if manifest.get("schemaVersion") == 4:
        preimage = copy.deepcopy(preimage)
        # Mirror director-core exactly: parentId has been part of the hash
        # preimage since V1 and is never stripped. Hierarchy-free V4
        # normalizes to the V3 preimage; any parent edge or assembly keeps
        # the V4 preimage with the assemblies key present.
        has_hierarchy = bool(preimage["assemblies"]) or any(
            scene_object.get("parentId") is not None
            for scene_object in preimage["objects"]
        )
        if not has_hierarchy:
            preimage.pop("assemblies")
            preimage["schemaVersion"] = 3
    return preimage


def finalize_scene_manifest(manifest_without_hashes: dict) -> dict:
    """Add hashes derived from durable state while retaining reported selection."""
    manifest = copy.deepcopy(manifest_without_hashes)
    manifest.pop("sceneHash", None)
    manifest.pop("revisionId", None)
    _validate_manifest(manifest)
    scene_hash = canonical_revision(_scene_hash_preimage(manifest))
    revision_id = initial_revision_id(manifest["projectId"], scene_hash)
    return {**manifest, "revisionId": revision_id, "sceneHash": scene_hash}


def finalize_scene_manifest_child(
    manifest_without_hashes: dict,
    parent_revision_id: str,
    canonical_operation: object,
    canonical_dependency_hashes: object = (),
) -> dict:
    """Hash a V3 scene and bind it to the real parent/operation child chain."""
    manifest = copy.deepcopy(manifest_without_hashes)
    manifest.pop("sceneHash", None)
    manifest.pop("revisionId", None)
    _validate_manifest(manifest)
    scene_hash = canonical_revision(_scene_hash_preimage(manifest))
    revision_id = child_revision_id(
        manifest["projectId"],
        parent_revision_id,
        canonical_json(canonical_operation),
        scene_hash,
        canonical_json(list(canonical_dependency_hashes)),
    )
    return {**manifest, "revisionId": revision_id, "sceneHash": scene_hash}
