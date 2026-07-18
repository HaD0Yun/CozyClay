"""Blender-independent assembly and validation for SceneManifestV1."""

from __future__ import annotations

import copy
import math
import re
import unicodedata
from math import gcd

from .canonical import canonical_revision
from .revision import initial_revision_id
from .snapshot import EXPORT_MAGNITUDE, EXPORT_NONFINITE, ExportError, UNSUPPORTED_FPS_BASE

_UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_MAGNITUDE = 1e15


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


def _validate_manifest(manifest: dict) -> None:
    if not isinstance(manifest, dict):
        _fail("manifest", "must be an object")
    if manifest.get("schemaVersion") != 1:
        _fail("schemaVersion", "must equal 1")
    _uuid(manifest.get("projectId"), "projectId")
    _string(manifest.get("blenderVersion"), "blenderVersion")

    scene = manifest.get("scene")
    render = manifest.get("render")
    if not isinstance(scene, dict) or not isinstance(render, dict):
        _fail("scene/render", "must be objects")
    _string(scene.get("name"), "scene.name", 1, 256)
    _integer(scene.get("frameStart"), "scene.frameStart", 0, 1_048_574)
    _integer(scene.get("frameEnd"), "scene.frameEnd", 0, 1_048_574)
    if scene["frameEnd"] < scene["frameStart"]:
        _fail("scene.frameEnd", "must be >= scene.frameStart")
    _integer(scene.get("fpsNumerator"), "scene.fpsNumerator", 1)
    _integer(scene.get("fpsDenominator"), "scene.fpsDenominator", 1)
    _uuid(scene.get("activeCameraId"), "scene.activeCameraId", True)
    for key, maximum in (("resolutionX", 65536), ("resolutionY", 65536)):
        _integer(render.get(key), f"render.{key}", 1, maximum)
    _integer(render.get("resolutionPercentage"), "render.resolutionPercentage", 1, 100)

    arrays = {}
    for key in ("objects", "bones", "cameras", "lights", "markers", "selectedEntityIds"):
        value = manifest.get(key)
        if not isinstance(value, list):
            _fail(key, "must be an array")
        arrays[key] = value

    ids: dict[str, set[str]] = {key: set() for key in ("objects", "bones", "cameras", "lights")}
    for key in ids:
        for index, item in enumerate(arrays[key]):
            if not isinstance(item, dict):
                _fail(f"{key}[{index}]", "must be an object")
            _uuid(item.get("entityId"), f"{key}[{index}].entityId")
            entity_id = item["entityId"]
            if entity_id in ids[key]:
                _fail(key, "must not contain duplicate entityId values")
            ids[key].add(entity_id)

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
        if item["armatureObjectId"] not in objects_by_id:
            raise INVALID_MANIFEST_REFERENCE(f"{path}.armatureObjectId references no object")
        if item["parentBoneId"] is not None and item["parentBoneId"] not in ids["bones"]:
            raise INVALID_MANIFEST_REFERENCE(f"{path}.parentBoneId references no bone")

    camera_object_ids: set[str] = set()
    for index, item in enumerate(arrays["cameras"]):
        path = f"cameras[{index}]"
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
    expected_camera_objects = {key for key, item in objects_by_id.items() if item["type"] == "CAMERA"}
    if camera_object_ids != expected_camera_objects:
        raise INVALID_MANIFEST_REFERENCE("every CAMERA object must have exactly one camera entry")

    for index, item in enumerate(arrays["lights"]):
        path = f"lights[{index}]"
        _uuid(item.get("objectId"), f"{path}.objectId")
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

    camera_ids = ids["cameras"]
    if scene["activeCameraId"] is not None and scene["activeCameraId"] not in camera_ids:
        raise INVALID_MANIFEST_REFERENCE("scene.activeCameraId references no camera")
    for index, item in enumerate(arrays["markers"]):
        path = f"markers[{index}]"
        if not isinstance(item, dict):
            _fail(path, "must be an object")
        _string(item.get("name"), f"{path}.name")
        _integer(item.get("frame"), f"{path}.frame")
        _uuid(item.get("cameraId"), f"{path}.cameraId", True)
        if item["cameraId"] is not None and item["cameraId"] not in camera_ids:
            raise INVALID_MANIFEST_REFERENCE(f"{path}.cameraId references no camera")
    for index, entity_id in enumerate(arrays["selectedEntityIds"]):
        _uuid(entity_id, f"selectedEntityIds[{index}]")


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
) -> dict:
    """Validate, copy, and semantically order already-extracted scene data."""
    manifest = {
        "schemaVersion": 1,
        "projectId": project_id,
        "blenderVersion": blender_version,
        "scene": copy.deepcopy(scene),
        "render": copy.deepcopy(render),
        "objects": sorted(copy.deepcopy(objects), key=lambda item: item["entityId"]),
        "bones": sorted(copy.deepcopy(bones), key=lambda item: item["entityId"]),
        "cameras": sorted(copy.deepcopy(cameras), key=lambda item: item["entityId"]),
        "lights": sorted(copy.deepcopy(lights), key=lambda item: item["entityId"]),
        "markers": sorted(copy.deepcopy(markers), key=lambda item: (item["name"], item["frame"], item["cameraId"] is not None, item["cameraId"] or "")),
        "selectedEntityIds": sorted(set(copy.deepcopy(selected_entity_ids))),
    }
    _validate_manifest(manifest)
    return manifest


def finalize_scene_manifest(manifest_without_hashes: dict) -> dict:
    """Add canonical scene and initial revision hashes, excluding both from the preimage."""
    manifest = copy.deepcopy(manifest_without_hashes)
    manifest.pop("sceneHash", None)
    manifest.pop("revisionId", None)
    _validate_manifest(manifest)
    scene_hash = canonical_revision(manifest)
    revision_id = initial_revision_id(manifest["projectId"], scene_hash)
    return {**manifest, "revisionId": revision_id, "sceneHash": scene_hash}
