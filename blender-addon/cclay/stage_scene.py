"""Closed StageScenePlanV1 validation and transactional Blender mutation."""

from __future__ import annotations
import ast

import ctypes
import gc
import json
import logging
import platform
import resource
import math
import os
import re
import time
import struct
import sys
import traceback
import zipfile
import unicodedata
import uuid
from collections.abc import Callable
from pathlib import Path

from . import hand_shapes, motion_retarget
from .scene_manifest import PRIMITIVE_TYPES


def _stage_log(connection, event: str, **fields) -> None:
    """Best-effort bridge diagnostics for fakes that predate the logger."""
    log = getattr(connection, "_log_bridge_event", None)
    if callable(log):
        log(event, **fields)

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover
    bpy = None

_UUID4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_HASH = re.compile(r"^[0-9a-f]{64}$")
_MOTION_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_PLAN_KEYS = {"schema_version", "expected_revision_id", "operations"}
_OPERATION_KEYS = {
    "add_primitive": {
        "op", "entity_id", "primitive_type", "name", "location", "rotation", "scale",
        "parent_id", "collection_name",
    },
    "add_character": {
        "op", "entity_id", "character_type", "name", "location", "rotation", "scale",
    },
    "add_camera": {
        "op", "entity_id", "name", "location", "rotation", "lens",
    },
    "create_assembly": {"op", "name"},
    "set_parent": {"op", "entity_id", "parent_id"},
    "transform_assembly": {
        "op", "assembly_id", "translation", "rotation_euler", "scale",
    },
    "set_material_color": {"op", "entity_id", "color", "roughness", "metallic"},
    "upsert_area_light": {
        "op", "entity_id", "name", "location", "rotation", "scale",
        "energy", "color", "size", "collection_name",
    },
    "delete_entity": {"op", "entity_id"},
    "adopt_entity": {"op", "entity_id"},
    "transform_entity": {
        "op", "entity_id", "location", "rotation_euler", "scale",
    },
    "set_light_property": {"op", "entity_id", "energy", "color", "size"},
    "set_camera_property": {
        "op", "entity_id", "lens", "clip_start", "clip_end",
        "sensor_width", "sensor_height", "sensor_fit",
    },
    "set_render_settings": {
        "op", "resolution_x", "resolution_y", "resolution_percentage",
        "fps", "frame_start", "frame_end",
    },
    "rename_entity": {"op", "entity_id", "name"},
    "apply_motion": {
        "op", "entity_id", "motion_id", "hand_pose", "hand_shapes", "hand_track",
        "start_frame",
    },
}
_PRIMITIVES = frozenset(PRIMITIVE_TYPES)
_SENSOR_FITS = {"AUTO", "HORIZONTAL", "VERTICAL", "SQUARE"}
_RENDER_SETTING_BOUNDS = {
    "resolution_x": (1, 65535),
    "resolution_y": (1, 65535),
    "resolution_percentage": (1, 100),
    "fps": (1, 1000),
    "frame_start": (-100000, 100000),
    "frame_end": (-100000, 100000),
}
_CHARACTERS = {
    "Y_BOT": "y-bot-tpose.fbx",
    "X_BOT": "x-bot-tpose.fbx",
}
_HAND_POSES = {"relaxed", "open"}


class StageSceneError(RuntimeError):
    """A staged scene mutation cannot be completed safely."""


class StageSceneValidationError(StageSceneError):
    """One atomic StageScenePlanV1 contract failure."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


class STAGE_SCENE_ENTITY_ID_EXISTS(StageSceneError):
    code = "STAGE_SCENE_ENTITY_ID_EXISTS"


class STAGE_SCENE_TARGET_NOT_FOUND(StageSceneError):
    code = "STAGE_SCENE_TARGET_NOT_FOUND"


class STAGE_SCENE_TARGET_NOT_CCLAY_OWNED(StageSceneError):
    code = "STAGE_SCENE_TARGET_NOT_CCLAY_OWNED"


class STAGE_SCENE_TARGET_TYPE_INVALID(StageSceneError):
    code = "STAGE_SCENE_TARGET_TYPE_INVALID"


class STAGE_SCENE_PRIMITIVE_UNSUPPORTED(StageSceneError):
    code = "STAGE_SCENE_PRIMITIVE_UNSUPPORTED"


class STAGE_SCENE_SHARED_DATABLOCK(StageSceneError):
    code = "STAGE_SCENE_SHARED_DATABLOCK"
class STAGE_SCENE_PARENT_CYCLE(StageSceneError):
    code = "STAGE_SCENE_PARENT_CYCLE"


class STAGE_SCENE_ASSEMBLY_NOT_FOUND(StageSceneError):
    code = "STAGE_SCENE_ASSEMBLY_NOT_FOUND"




class STAGE_SCENE_CANCELLED(StageSceneError):
    code = "STAGE_SCENE_CANCELLED"


class STAGE_SCENE_DEADLINE_EXCEEDED(StageSceneError):
    code = "STAGE_SCENE_DEADLINE_EXCEEDED"


def _invalid(message: str) -> None:
    raise StageSceneValidationError("INVALID_STAGE_SCENE_PLAN_SCHEMA", message)


def _exact(value: object, keys: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        _invalid(f"{label} must contain exactly {sorted(keys)}")
    return value


def _uuid(value: object, label: str) -> str:
    if not isinstance(value, str) or _UUID4.fullmatch(value) is None:
        _invalid(f"{label} must be a lowercase UUIDv4")
    return value


def _number(
    value: object,
    label: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
    positive: bool = False,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _invalid(f"{label} must be a finite number")
    if abs(value) >= 1e15:
        _invalid(f"{label} magnitude must be below 1e15")
    if minimum is not None and value < minimum:
        _invalid(f"{label} must be at least {minimum}")
    if maximum is not None and value > maximum:
        _invalid(f"{label} must be at most {maximum}")
    if positive and value <= 0:
        _invalid(f"{label} must be positive")
    return float(value)


def _integer(value: object, label: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _invalid(f"{label} must be an integer")
    if not minimum <= value <= maximum:
        _invalid(f"{label} must be in {minimum}..{maximum}")
    return value


def _vector(value: object, size: int, label: str, *, unit: bool = False, positive: bool = False) -> list[float]:
    if not isinstance(value, list) or len(value) != size:
        _invalid(f"{label} must contain exactly {size} numbers")
    result = [
        _number(component, f"{label}[{index}]", minimum=0 if unit else None, positive=positive)
        for index, component in enumerate(value)
    ]
    if unit and any(component > 1 for component in result):
        _invalid(f"{label} components must be at most 1")
    return result


def _name(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 256
        or unicodedata.normalize("NFC", value) != value
    ):
        _invalid(f"{label} must be a 1..256 character NFC string")
    return value


def parse_stage_scene_plan(value: object) -> dict:
    """Parse the closed plan and apply semantic uniqueness checks."""
    plan = _exact(value, _PLAN_KEYS, "plan")
    if plan.get("schema_version") != 1:
        _invalid("schema_version must equal 1")
    if not isinstance(plan.get("expected_revision_id"), str) or _HASH.fullmatch(
        plan["expected_revision_id"]
    ) is None:
        _invalid("expected_revision_id must be a lowercase SHA-256")
    operations = plan.get("operations")
    if not isinstance(operations, list) or not 1 <= len(operations) <= 256:
        _invalid("operations must contain 1..256 entries")

    created_ids: set[str] = set()
    stable_names: set[str] = set()
    for index, raw_operation in enumerate(operations):
        if not isinstance(raw_operation, dict):
            _invalid(f"operations[{index}] must be an object")
        operation_kind = raw_operation.get("op")
        expected_keys = _OPERATION_KEYS.get(operation_kind)
        if expected_keys is None:
            _invalid(f"operations[{index}].op is unsupported")
        raw_operation = dict(raw_operation)
        if operation_kind in ("add_primitive", "upsert_area_light"):
            for optional_field in ("parent_id", "collection_name"):
                if optional_field not in raw_operation:
                    expected_keys = expected_keys - {optional_field}
        elif operation_kind == "add_camera":
            if "lens" not in raw_operation:
                expected_keys = expected_keys - {"lens"}
        elif operation_kind == "apply_motion":
            hand_fields = [
                field
                for field in ("hand_pose", "hand_shapes", "hand_track")
                if field in raw_operation
            ]
            if len(hand_fields) > 1:
                _invalid(
                    f"operations[{index}].{' and '.join(hand_fields)} are mutually exclusive"
                )
            if "hand_track" in raw_operation:
                requested = raw_operation["hand_track"]
                if not isinstance(requested, dict) or not requested:
                    _invalid(
                        f"operations[{index}].hand_track must contain exactly left, right, or both"
                    )
                if not set(requested) <= {"left", "right"}:
                    _invalid(f"operations[{index}].hand_track contains unknown fields")
                for side in ("left", "right"):
                    if side not in requested:
                        continue
                    keys = requested[side]
                    if not isinstance(keys, list) or not keys:
                        _invalid(
                            f"operations[{index}].hand_track.{side} must be a non-empty list of keys"
                        )
                    if len(keys) > hand_shapes.MAX_HAND_TRACK_KEYS:
                        _invalid(
                            f"operations[{index}].hand_track.{side} has more than "
                            f"{hand_shapes.MAX_HAND_TRACK_KEYS} keys"
                        )
                    for key_index, key in enumerate(keys):
                        if not isinstance(key, dict) or set(key) != {"frame", "preset"}:
                            _invalid(
                                f"operations[{index}].hand_track.{side}[{key_index}] must "
                                f"contain exactly frame and preset"
                            )
                        if not isinstance(key["frame"], int) or isinstance(key["frame"], bool):
                            _invalid(
                                f"operations[{index}].hand_track.{side}[{key_index}].frame "
                                f"must be an integer"
                            )
                        if key["frame"] < 0:
                            _invalid(
                                f"operations[{index}].hand_track.{side}[{key_index}].frame "
                                f"must not be negative"
                            )
                        if key["preset"] not in hand_shapes.PRESET_NAMES:
                            _invalid(
                                f"operations[{index}].hand_track.{side}[{key_index}].preset "
                                f"is unsupported"
                            )
            if "hand_shapes" in raw_operation:
                requested = raw_operation["hand_shapes"]
                if not isinstance(requested, dict):
                    _invalid(
                        f"operations[{index}].hand_shapes must contain exactly left, right, or both"
                    )
                if not set(requested) <= {"left", "right"}:
                    _invalid(f"operations[{index}].hand_shapes contains unknown fields")
                if not requested:
                    _invalid(
                        f"operations[{index}].hand_shapes must contain exactly left, right, or both"
                    )
                for side in ("left", "right"):
                    if side in requested and requested[side] not in hand_shapes.PRESET_NAMES:
                        _invalid(
                            f"operations[{index}].hand_shapes.{side} is unsupported"
                        )
            for optional_field in ("hand_pose", "hand_shapes", "hand_track", "start_frame"):
                if optional_field not in raw_operation:
                    expected_keys = expected_keys - {optional_field}
        elif operation_kind == "transform_assembly":
            required = {"op", "assembly_id"}
            if not required <= set(raw_operation) or not set(raw_operation) <= expected_keys:
                _invalid(
                    f"operations[{index}] must contain {sorted(required)} "
                    f"and only optional transform fields"
                )
            expected_keys = set(raw_operation)
            transform_fields = [
                field
                for field in ("translation", "rotation_euler", "scale")
                if field in raw_operation
            ]
            if not transform_fields:
                _invalid(
                    f"operations[{index}] transform_assembly must include at least "
                    "one transform field"
                )
            for field in transform_fields:
                if raw_operation[field] is None:
                    _invalid(
                        f"operations[{index}].{field} must be a vector, not null"
                    )
        elif operation_kind == "transform_entity":
            required = {"op", "entity_id"}
            if not required <= set(raw_operation) or not set(raw_operation) <= expected_keys:
                _invalid(
                    f"operations[{index}] must contain {sorted(required)} "
                    f"and only optional transform fields"
                )
            expected_keys = set(raw_operation)
            transform_fields = [
                field
                for field in ("location", "rotation_euler", "scale")
                if field in raw_operation
            ]
            if not transform_fields:
                _invalid(
                    f"operations[{index}] transform_entity must include at least "
                    "one transform field"
                )
            for field in transform_fields:
                if raw_operation[field] is None:
                    _invalid(
                        f"operations[{index}].{field} must be a vector, not null"
                    )
        elif operation_kind == "set_material_color":
            # roughness and metallic are optional so a plan written before surface
            # finish existed stays valid and byte-identical on the wire.
            required = {"op", "entity_id", "color"}
            if not required <= set(raw_operation) or not set(raw_operation) <= expected_keys:
                _invalid(
                    f"operations[{index}] must contain {sorted(required)} "
                    f"and only optional surface finish fields"
                )
            expected_keys = set(raw_operation)
        elif operation_kind == "set_light_property":
            required = {"op", "entity_id"}
            if not required <= set(raw_operation) or not set(raw_operation) <= expected_keys:
                _invalid(
                    f"operations[{index}] must contain {sorted(required)} "
                    f"and only optional light property fields"
                )
            expected_keys = set(raw_operation)
            if not expected_keys - required:
                _invalid(
                    f"operations[{index}] set_light_property must include at least "
                    "one property field"
                )
        elif operation_kind == "set_camera_property":
            required = {"op", "entity_id"}
            if not required <= set(raw_operation) or not set(raw_operation) <= expected_keys:
                _invalid(
                    f"operations[{index}] must contain {sorted(required)} "
                    f"and only optional camera property fields"
                )
            expected_keys = set(raw_operation)
            if not expected_keys - required:
                _invalid(
                    f"operations[{index}] set_camera_property must include at least "
                    "one property field"
                )
        elif operation_kind == "set_render_settings":
            if not set(raw_operation) <= expected_keys:
                _invalid(
                    f"operations[{index}] must contain 'op' "
                    f"and only optional render setting fields"
                )
            expected_keys = set(raw_operation)
        operation = _exact(raw_operation, expected_keys, f"operations[{index}]")
        if operation_kind == "create_assembly":
            _name(operation.get("name"), f"operations[{index}].name")
            continue
        if operation_kind == "transform_assembly":
            _uuid(operation.get("assembly_id"), f"operations[{index}].assembly_id")
            for field in ("translation", "rotation_euler", "scale"):
                if field in operation:
                    _vector(
                        operation[field], 3, f"operations[{index}].{field}",
                        positive=field == "scale",
                    )
            continue
        if operation_kind == "set_render_settings":
            for field, (minimum, maximum) in _RENDER_SETTING_BOUNDS.items():
                if field in operation:
                    _integer(
                        operation[field], f"operations[{index}].{field}",
                        minimum=minimum, maximum=maximum,
                    )
            continue
        entity_id = _uuid(operation.get("entity_id"), f"operations[{index}].entity_id")
        if operation_kind in ("add_primitive", "set_parent"):
            if operation.get("parent_id") is not None:
                _uuid(operation["parent_id"], f"operations[{index}].parent_id")
            if operation.get("parent_id") == entity_id:
                _invalid(f"operations[{index}] cannot parent an entity to itself")
        if operation_kind == "add_primitive":
            if operation.get("primitive_type") not in _PRIMITIVES:
                _invalid(f"operations[{index}].primitive_type is unsupported")
            _name(operation.get("name"), f"operations[{index}].name")
            _vector(operation.get("location"), 3, f"operations[{index}].location")
            _vector(operation.get("rotation"), 3, f"operations[{index}].rotation")
            _vector(operation.get("scale"), 3, f"operations[{index}].scale", positive=True)
            if "collection_name" in operation:
                _name(
                    operation["collection_name"],
                    f"operations[{index}].collection_name",
                )
        elif operation_kind == "add_character":
            if operation.get("character_type") not in _CHARACTERS:
                _invalid(f"operations[{index}].character_type is unsupported")
            _name(operation.get("name"), f"operations[{index}].name")
            _vector(operation.get("location"), 3, f"operations[{index}].location")
            _vector(operation.get("rotation"), 3, f"operations[{index}].rotation")
            _vector(operation.get("scale"), 3, f"operations[{index}].scale", positive=True)
        elif operation_kind == "add_camera":
            _name(operation.get("name"), f"operations[{index}].name")
            _vector(operation.get("location"), 3, f"operations[{index}].location")
            _vector(operation.get("rotation"), 3, f"operations[{index}].rotation")
            if "lens" in operation:
                _number(operation["lens"], f"operations[{index}].lens", positive=True)
        elif operation_kind == "set_material_color":
            _vector(operation.get("color"), 4, f"operations[{index}].color", unit=True)
            # Optional: absent keeps the Principled defaults the add-on has always
            # produced, so an older plan stays byte-identical on the wire.
            for finish in ("roughness", "metallic"):
                if finish in operation:
                    _number(
                        operation[finish],
                        f"operations[{index}].{finish}",
                        minimum=0.0,
                        maximum=1.0,
                    )
        elif operation_kind == "upsert_area_light":
            _name(operation.get("name"), f"operations[{index}].name")
            _vector(operation.get("location"), 3, f"operations[{index}].location")
            _vector(operation.get("rotation"), 3, f"operations[{index}].rotation")
            _vector(operation.get("scale"), 3, f"operations[{index}].scale", positive=True)
            _number(operation.get("energy"), f"operations[{index}].energy", minimum=0)
            _vector(operation.get("color"), 3, f"operations[{index}].color", unit=True)
            _number(operation.get("size"), f"operations[{index}].size", positive=True)
            if "collection_name" in operation:
                _name(
                    operation["collection_name"],
                    f"operations[{index}].collection_name",
                )
        elif operation_kind == "transform_entity":
            for field in ("location", "rotation_euler", "scale"):
                if field in operation:
                    _vector(
                        operation[field], 3, f"operations[{index}].{field}",
                        positive=field == "scale",
                    )
        elif operation_kind == "set_light_property":
            if "energy" in operation:
                _number(operation["energy"], f"operations[{index}].energy", minimum=0)
            if "color" in operation:
                _vector(operation["color"], 3, f"operations[{index}].color", unit=True)
            if "size" in operation:
                _number(operation["size"], f"operations[{index}].size", positive=True)
        elif operation_kind == "set_camera_property":
            for field in (
                "lens", "clip_start", "clip_end", "sensor_width", "sensor_height",
            ):
                if field in operation:
                    _number(
                        operation[field], f"operations[{index}].{field}",
                        positive=True,
                    )
            if "sensor_fit" in operation and operation["sensor_fit"] not in _SENSOR_FITS:
                _invalid(f"operations[{index}].sensor_fit is unsupported")
        elif operation_kind == "rename_entity":
            _name(operation.get("name"), f"operations[{index}].name")
        elif operation_kind == "apply_motion":
            motion_id = operation.get("motion_id")
            if not isinstance(motion_id, str) or _MOTION_ID.fullmatch(motion_id) is None:
                _invalid(
                    f"operations[{index}].motion_id must be a lowercase "
                    "[a-z0-9-] slug of at most 64 characters"
                )
            if "hand_pose" in operation and operation["hand_pose"] not in _HAND_POSES:
                _invalid(f"operations[{index}].hand_pose is unsupported")
            if "start_frame" in operation:
                _integer(
                    operation["start_frame"], f"operations[{index}].start_frame",
                    minimum=-100000, maximum=100000,
                )

        if operation_kind in ("add_primitive", "upsert_area_light", "add_character", "add_camera"):
            if entity_id in created_ids:
                raise StageSceneValidationError(
                    "STAGE_SCENE_ENTITY_ID_DUPLICATE",
                    f"entity_id {entity_id} is created more than once",
                )
            created_ids.add(entity_id)
            stable_name = operation["name"]
            if stable_name in stable_names:
                raise StageSceneValidationError(
                    "STAGE_SCENE_STABLE_NAME_DUPLICATE",
                    f"stable name {stable_name!r} is repeated",
                )
            stable_names.add(stable_name)
    return plan


class STAGE_SCENE_STABLE_NAME_EXISTS(StageSceneError):
    code = "STAGE_SCENE_STABLE_NAME_EXISTS"


def _entity(entity_id: str):
    return next(
        (
            scene_object
            for scene_object in bpy.data.objects
            if scene_object.get("cclay.entity_id") == entity_id
        ),
        None,
    )


def _ensure_collection(name: str, transaction: _StageTransaction):
    """Get or create a Blender Collection named `name` and track it for rollback.

    The collection is linked to the scene collection so it appears in the
    Outliner. Reusing an existing collection is idempotent.
    """
    collection = bpy.data.collections.get(name)
    if collection is None:
        collection = bpy.data.collections.new(name)
        transaction.scene.collection.children.link(collection)
        transaction.created_collections.append(collection)
    return collection


def _link_to_collection(scene_object: object, collection_name: str | None, transaction: _StageTransaction):
    """Link `scene_object` into `collection_name` if given, else the scene root.

    Blender allows an object to live in multiple collections; we keep the
    director simple by linking into the named collection only.
    """
    if collection_name is None:
        transaction.scene.collection.objects.link(scene_object)
        return
    collection = _ensure_collection(collection_name, transaction)
    collection.objects.link(scene_object)


def _owned(scene_object: object, project_id: str) -> bool:
    return scene_object.get("cclay.owned_project_id") == project_id


def _require_owned_entity(entity_id: str, project_id: str):
    scene_object = _entity(entity_id)
    if scene_object is None:
        raise STAGE_SCENE_TARGET_NOT_FOUND(f"entity {entity_id} does not exist")
    if not _owned(scene_object, project_id):
        raise STAGE_SCENE_TARGET_NOT_CCLAY_OWNED(
            f"entity {entity_id} was not created by CCLAY for this project"
        )
    return scene_object


def _require_exclusive_datablocks(scene_object: object) -> None:
    data = scene_object.data
    if data is not None and data.users > 1:
        raise STAGE_SCENE_SHARED_DATABLOCK(
            f"entity {scene_object['cclay.entity_id']} data is shared by {data.users} users"
        )
    if scene_object.type != "MESH":
        return
    for material in data.materials:
        if (
            material is not None
            and isinstance(material.get("cclay.generated_for_entity_id"), str)
            and material.users > 1
        ):
            raise STAGE_SCENE_SHARED_DATABLOCK(
                f"entity {scene_object['cclay.entity_id']} generated material "
                f"{material.name!r} is shared by {material.users} users"
            )


def _destroy_object(scene_object: object) -> None:
    data = scene_object.data
    materials = (
        tuple(material for material in data.materials if material is not None)
        if scene_object.type == "MESH"
        else ()
    )
    object_type = scene_object.type
    bpy.data.objects.remove(scene_object, do_unlink=True)
    if data is not None and data.users == 0:
        if object_type == "MESH":
            bpy.data.meshes.remove(data)
        elif object_type == "LIGHT":
            bpy.data.lights.remove(data)
        elif object_type == "CAMERA":
            bpy.data.cameras.remove(data)
        elif object_type == "ARMATURE":
            bpy.data.armatures.remove(data)
    for material in materials:
        # A material shared by two destroyed objects is already gone on the
        # second visit; Blender invalidates the RNA wrapper at removal.
        try:
            users = material.users
        except ReferenceError:
            continue
        if users == 0:
            bpy.data.materials.remove(material)


class _StageTransaction:
    def __init__(self, scene: object):
        self.scene = scene
        self.created_objects: list[object] = []
        self.created_materials: list[object] = []
        self.created_collections: list[object] = []
        self.object_states: dict[object, dict] = {}
        self.material_states: dict[object, dict] = {}
        self.quarantined: dict[object, tuple[object, ...]] = {}
        # Pre-existing foreign objects stamped with cclay.owned_project_id by
        # adopt_entity during this transaction; rollback removes the stamp.
        self.adopted_objects: list[object] = []
        # entity_id -> collection name assigned at creation; used by set_parent
        # to keep children in the same collection as their parent.
        self.collection_by_entity: dict[str, str] = {}
        self.render_state: dict | None = None
        # Object -> previously assigned action (or None); actions created by
        # apply_motion during this transaction. Rollback restores the old
        # action reference and removes now-orphaned created actions.
        self.animation_states: dict[object, dict] = {}
        self.created_actions: list[object] = []
        self.active_camera = scene.camera
        self.selected = tuple(
            scene_object for scene_object in scene.objects if scene_object.select_get()
        )
        self.active = bpy.context.view_layer.objects.active

    def capture_animation(
        self, scene_object: object, pose_bone_names: tuple[str, ...] = ()
    ) -> None:
        if scene_object in self.animation_states:
            return
        animation_data = scene_object.animation_data
        action_slot = (
            animation_data.action_slot
            if animation_data is not None and hasattr(animation_data, "action_slot")
            else None
        )
        self.animation_states[scene_object] = {
            "animation_data_existed": animation_data is not None,
            "action": animation_data.action if animation_data is not None else None,
            "action_slot": action_slot,
            "pose": {
                name: {
                    "rotation_mode": scene_object.pose.bones[name].rotation_mode,
                    "rotation_quaternion": tuple(
                        scene_object.pose.bones[name].rotation_quaternion
                    ),
                    "location": tuple(scene_object.pose.bones[name].location),
                }
                for name in pose_bone_names
            },
        }

    def capture_object(self, scene_object: object) -> None:
        if scene_object in self.created_objects or scene_object in self.object_states:
            return
        state = {
            "name": scene_object.name,
            "location": tuple(scene_object.location),
            "rotation_mode": scene_object.rotation_mode,
            "rotation_euler": tuple(scene_object.rotation_euler),
            "scale": tuple(scene_object.scale),
            "parent": scene_object.parent,
            "matrix_parent_inverse": scene_object.matrix_parent_inverse.copy(),
            "matrix_world": scene_object.matrix_world.copy(),
        }
        if scene_object.type == "LIGHT":
            state["light"] = {
                "type": scene_object.data.type,
                "energy": float(scene_object.data.energy),
                "color": tuple(scene_object.data.color),
                "size": float(scene_object.data.size),
            }
        elif scene_object.type == "CAMERA":
            cam = scene_object.data
            state["camera"] = {
                "lens": float(cam.lens),
                "clip_start": float(cam.clip_start),
                "clip_end": float(cam.clip_end),
                "sensor_width": float(cam.sensor_width),
                "sensor_height": float(cam.sensor_height),
                "sensor_fit": cam.sensor_fit,
            }
        self.object_states[scene_object] = state

    def capture_materials(self, scene_object: object, material: object | None) -> None:
        if scene_object not in self.created_objects:
            if scene_object not in self.object_states:
                self.capture_object(scene_object)
            state = self.object_states[scene_object]
            state.setdefault("material_slots", tuple(scene_object.data.materials))
        if (
            material is not None
            and material not in self.created_materials
            and material not in self.material_states
        ):
            # Gated on the node tree ALONE, deliberately matching the exporter in
            # manifest.py rather than the narrower `use_nodes` test this used to
            # share with nothing. _set_material_color turns `use_nodes` ON and
            # then writes these sockets, so a material captured while nodes were
            # disabled would snapshot None, skip restoration on rollback, and
            # leave the sockets mutated -- and the exporter reads them regardless
            # of `use_nodes`, so the restored scene would hash differently and
            # escalate to RECOVERY_REQUIRED.
            principled = (
                material.node_tree.nodes.get("Principled BSDF")
                if material.node_tree is not None
                else None
            )
            base_color = (
                tuple(principled.inputs["Base Color"].default_value)
                if principled is not None
                else None
            )
            # Surface finish is captured alongside base_color so a transaction
            # that mutated Roughness/Metallic and then failed can restore both
            # sockets. Like base_color, both are None when there is no
            # Principled node, and the exact float is captured so the round trip
            # is lossless (Blender stores these as binary32).
            roughness = (
                float(principled.inputs["Roughness"].default_value)
                if principled is not None
                else None
            )
            metallic = (
                float(principled.inputs["Metallic"].default_value)
                if principled is not None
                else None
            )
            self.material_states[material] = {
                "diffuse_color": tuple(material.diffuse_color),
                "use_nodes": bool(material.use_nodes),
                "base_color": base_color,
                "roughness": roughness,
                "metallic": metallic,
            }

    def capture_render(self) -> None:
        if self.render_state is not None:
            return
        scene = bpy.context.scene
        render = scene.render
        self.render_state = {
            "resolution_x": render.resolution_x,
            "resolution_y": render.resolution_y,
            "resolution_percentage": render.resolution_percentage,
            "fps": render.fps,
            "fps_base": render.fps_base,
            "frame_start": scene.frame_start,
            "frame_end": scene.frame_end,
            "frame_current": scene.frame_current,
        }

    def quarantine(self, scene_object: object) -> None:
        if scene_object in self.quarantined:
            return
        collections = tuple(scene_object.users_collection)
        self.quarantined[scene_object] = collections
        for collection in collections:
            collection.objects.unlink(scene_object)

    def rollback(self) -> None:
        for scene_object, collections in self.quarantined.items():
            for collection in collections:
                if scene_object.name not in collection.objects:
                    collection.objects.link(scene_object)
        for scene_object, state in self.object_states.items():
            scene_object.name = state["name"]
            scene_object.location = state["location"]
            scene_object.rotation_mode = state["rotation_mode"]
            scene_object.rotation_euler = state["rotation_euler"]
            scene_object.scale = state["scale"]
            scene_object.parent = state["parent"]
            scene_object.matrix_parent_inverse = state["matrix_parent_inverse"]
            scene_object.matrix_world = state["matrix_world"]
            if "light" in state:
                light = state["light"]
                scene_object.data.type = light["type"]
                scene_object.data.energy = light["energy"]
                scene_object.data.color = light["color"]
                scene_object.data.size = light["size"]
            if "camera" in state:
                cam = state["camera"]
                scene_object.data.lens = cam["lens"]
                scene_object.data.clip_start = cam["clip_start"]
                scene_object.data.clip_end = cam["clip_end"]
                scene_object.data.sensor_width = cam["sensor_width"]
                scene_object.data.sensor_height = cam["sensor_height"]
                scene_object.data.sensor_fit = cam["sensor_fit"]
            if "material_slots" in state:
                scene_object.data.materials.clear()
                for material in state["material_slots"]:
                    scene_object.data.materials.append(material)
        for material, state in self.material_states.items():
            material.diffuse_color = state["diffuse_color"]
            material.use_nodes = state["use_nodes"]
            if state["base_color"] is not None:
                principled = material.node_tree.nodes["Principled BSDF"]
                principled.inputs["Base Color"].default_value = state["base_color"]
                # Restore the surface finish sockets captured above. Guarded on
                # the same Principled node as base_color, and written as the
                # exact captured float so the round trip is lossless.
                if state["roughness"] is not None:
                    principled.inputs["Roughness"].default_value = state["roughness"]
                if state["metallic"] is not None:
                    principled.inputs["Metallic"].default_value = state["metallic"]
        if self.active_camera is None or self.active_camera.name in bpy.data.objects:
            self.scene.camera = self.active_camera
        for scene_object in self.adopted_objects:
            if scene_object.get("cclay.owned_project_id") is not None:
                del scene_object["cclay.owned_project_id"]
        for scene_object, state in self.animation_states.items():
            if scene_object.name not in bpy.data.objects:
                continue
            animation_data = scene_object.animation_data
            if not state["animation_data_existed"]:
                if animation_data is not None:
                    scene_object.animation_data_clear()
                continue
            if animation_data is None:
                animation_data = scene_object.animation_data_create()
            animation_data.action = state["action"]
            if hasattr(animation_data, "action_slot"):
                animation_data.action_slot = state["action_slot"]
        if self.render_state is not None:
            scene = bpy.context.scene
            render = scene.render
            render.resolution_x = self.render_state["resolution_x"]
            render.resolution_y = self.render_state["resolution_y"]
            render.resolution_percentage = self.render_state["resolution_percentage"]
            render.fps = self.render_state["fps"]
            render.fps_base = self.render_state["fps_base"]
            scene.frame_start = self.render_state["frame_start"]
            scene.frame_end = self.render_state["frame_end"]
            scene.frame_set(self.render_state["frame_current"])
        for action in tuple(self.created_actions):
            # Created datablocks may already have been destroyed as a side
            # effect of destroying their owner (objects purge zero-user data,
            # and _destroy_object purges zero-user materials). Touching the
            # stale RNA wrapper raises ReferenceError and used to turn a clean
            # rollback into RECOVERY_REQUIRED.
            try:
                is_registered = action.name in bpy.data.actions
                users = action.users
            except ReferenceError:
                continue
            if is_registered and users == 0:
                bpy.data.actions.remove(action)
        bpy.context.view_layer.update()
        # Restoring the action and current frame evaluates animation and can
        # overwrite pose channels. Reapply the captured values only after that
        # final dependency-graph evaluation so rollback is byte-for-byte exact.
        for scene_object, state in self.animation_states.items():
            if scene_object.name not in bpy.data.objects:
                continue
            for name, pose_state in state["pose"].items():
                pose_bone = scene_object.pose.bones.get(name)
                if pose_bone is not None:
                    pose_bone.rotation_mode = pose_state["rotation_mode"]
                    pose_bone.rotation_quaternion = pose_state["rotation_quaternion"]
                    pose_bone.location = pose_state["location"]
        for scene_object in reversed(self.created_objects):
            if scene_object.name in bpy.data.objects:
                _destroy_object(scene_object)
        for collection in reversed(self.created_collections):
            if collection.name in bpy.data.collections and len(collection.objects) == 0:
                bpy.data.collections.remove(collection)
        for material in tuple(self.created_materials):
            try:
                is_registered = material.name in bpy.data.materials
                users = material.users
            except ReferenceError:
                continue
            if is_registered and users == 0:
                bpy.data.materials.remove(material)
        for scene_object in self.scene.objects:
            scene_object.select_set(scene_object in self.selected)
        bpy.context.view_layer.objects.active = (
            self.active
            if self.active is not None and self.active.name in bpy.data.objects
            else None
        )

    def finalize_deletions(self) -> None:
        for scene_object in tuple(self.quarantined):
            try:
                object_name = scene_object.name
            except ReferenceError:
                self.quarantined.pop(scene_object, None)
                continue
            if object_name in bpy.data.objects:
                _destroy_object(scene_object)
            self.quarantined.pop(scene_object, None)

    def finalize_orphan_actions(self) -> None:
        """Remove superseded actions created by repeated apply_motion operations."""
        bound = {
            scene_object.animation_data.action
            for scene_object in self.animation_states
            if scene_object.name in bpy.data.objects
            and scene_object.animation_data is not None
            and scene_object.animation_data.action is not None
        }
        for action in tuple(self.created_actions):
            try:
                is_registered = action.name in bpy.data.actions
                users = action.users
            except ReferenceError:
                continue
            if action not in bound and is_registered and users == 0:
                bpy.data.actions.remove(action)


# Authored so the ring's outer edge lands exactly on the -1..1 unit box like every
# other shape, keeping `scale` uniform: 0.75 + 0.25 = 1.0.
# TORUS is the one shape where `scale` is NOT the half-extent on every axis: the
# swept tube's Z extent is 0.5, so scale.z multiplies a 0.25 canonical half-height
# rather than a 1.0 half-extent. A circular tube cannot reach +/-1 on all three
# axes without becoming elliptical, so the XY/XZ asymmetry is intrinsic.
_TORUS_MAJOR_RADIUS = 0.75
_TORUS_MINOR_RADIUS = 0.25


def _build_cube(editable, bmesh) -> None:
    bmesh.ops.create_cube(editable, size=2)


def _build_plane(editable, bmesh) -> None:
    bmesh.ops.create_grid(editable, x_segments=1, y_segments=1, size=1)


def _build_uv_sphere(editable, bmesh) -> None:
    bmesh.ops.create_uvsphere(editable, u_segments=32, v_segments=16, radius=1)


def _build_cylinder(editable, bmesh) -> None:
    bmesh.ops.create_cone(
        editable, cap_ends=True, cap_tris=False, segments=32,
        radius1=1, radius2=1, depth=2,
    )


def _build_cone(editable, bmesh) -> None:
    bmesh.ops.create_cone(
        editable, cap_ends=True, cap_tris=False, segments=32,
        radius1=1, radius2=0, depth=2,
    )


def _build_circle(editable, bmesh) -> None:
    bmesh.ops.create_circle(editable, cap_ends=True, segments=32, radius=1)


def _build_torus(editable, bmesh) -> None:
    # bmesh.ops has no create_torus, so sweep a minor-radius ring around Z.
    ring = bmesh.ops.create_circle(
        editable, cap_ends=False, segments=12, radius=_TORUS_MINOR_RADIUS
    )
    for vert in ring["verts"]:
        across, along = vert.co.x, vert.co.y
        vert.co = (across + _TORUS_MAJOR_RADIUS, 0.0, along)
    ring_edges = {edge for vert in ring["verts"] for edge in vert.link_edges}
    bmesh.ops.spin(
        editable, geom=ring["verts"] + list(ring_edges),
        axis=(0.0, 0.0, 1.0), cent=(0.0, 0.0, 0.0), dvec=(0.0, 0.0, 0.0),
        angle=math.tau, steps=24, use_merge=True, use_duplicate=False,
    )


# One inspectable table instead of an if/elif chain, so the builder vocabulary can
# be compared against PRIMITIVE_TYPES in BOTH directions by a host-side test with
# no Blender at all. A chain could only ever be probed with guessed names, which
# proves nothing about a branch nobody guessed.
_PRIMITIVE_BUILDERS = {
    "PLANE": _build_plane,
    "CUBE": _build_cube,
    "UV_SPHERE": _build_uv_sphere,
    "CYLINDER": _build_cylinder,
    "CONE": _build_cone,
    "CIRCLE": _build_circle,
    "TORUS": _build_torus,
}

# Shading is part of what a shape IS, so the builder owns the DEFAULT policy per
# shape and it never became a wire field a director has to set. What the manifest
# records is the OBSERVED result: _stage_primitive_shading in manifest.py exports
# SMOOTH or MIXED, omitted when every face is flat. That is what lets a stored
# revision prove its own shading and catches a user flattening a mesh out of band.
# Curved surfaces rendered visibly faceted before any of this existed.
_SHADING_ALL_SMOOTH = frozenset({"UV_SPHERE", "TORUS"})
# Smooth the swept side but keep the caps flat. Shading a cap as though it were
# curved is exactly what makes a "smooth" cylinder look wrong.
_SHADING_SMOOTH_SIDES = frozenset({"CYLINDER", "CONE"})
_SHADING_FLAT = frozenset({"PLANE", "CUBE", "CIRCLE"})
# The threshold separating a swept side from a cap. Safe ONLY for the fixed
# unit-box proportions every builder authors: the unit CONE's side face
# |normal.z| is 0.445488364 (margin 0.454511636 below it) and its cap is 1.0
# (margin 0.1 above). A radius-1 depth-0.4 cone would be 0.928477 and be
# misclassified as a cap. It stays safe because the director's `scale` is an
# OBJECT transform that never touches mesh-space normals -- so if anyone ever
# parameterises a builder's aspect ratio, replace this with structural cap
# identification (e.g. cap faces all share one vertex ring) rather than a
# normal-z heuristic.
_CAP_NORMAL_Z = 0.9


def _build_primitive_mesh(editable, primitive_type: str) -> None:
    """Author one shape into `editable`, sized to the -1..1 unit box.

    Construction stays pure bmesh -- no bpy.ops -- so there is no operator
    context, no selection side effect, and no dependency on the active scene.
    An unknown shape raises instead of falling through to a sphere: with seven
    shapes a silent default would turn a validation gap into a wrong mesh.
    """
    import bmesh

    builder = _PRIMITIVE_BUILDERS.get(primitive_type)
    if builder is None:
        raise STAGE_SCENE_PRIMITIVE_UNSUPPORTED(
            f"primitive_type {primitive_type!r} passed validation but has no builder"
        )
    builder(editable, bmesh)

    editable.normal_update()
    if primitive_type in _SHADING_ALL_SMOOTH:
        for face in editable.faces:
            face.smooth = True
    elif primitive_type in _SHADING_SMOOTH_SIDES:
        for face in editable.faces:
            face.smooth = abs(face.normal.z) < _CAP_NORMAL_Z


def _create_primitive(operation: dict, transaction: _StageTransaction, project_id: str):
    import bmesh

    if _entity(operation["entity_id"]) is not None:
        raise STAGE_SCENE_ENTITY_ID_EXISTS(
            f"entity_id {operation['entity_id']} already exists"
        )
    if bpy.data.objects.get(operation["name"]) is not None:
        raise STAGE_SCENE_STABLE_NAME_EXISTS(
            f"stable name {operation['name']!r} already exists"
        )
    mesh = bpy.data.meshes.new(f"{operation['name']} Mesh")
    editable = bmesh.new()
    try:
        _build_primitive_mesh(editable, operation["primitive_type"])
        editable.to_mesh(mesh)
    finally:
        editable.free()
    scene_object = bpy.data.objects.new(operation["name"], mesh)
    scene_object["cclay.entity_id"] = operation["entity_id"]
    scene_object["cclay.owned_project_id"] = project_id
    scene_object["cclay.stage_primitive_type"] = operation["primitive_type"]
    scene_object.location = operation["location"]
    scene_object.rotation_mode = "XYZ"
    scene_object.rotation_euler = operation["rotation"]
    scene_object.scale = operation["scale"]
    collection_name = operation.get("collection_name")
    _link_to_collection(scene_object, collection_name, transaction)
    if collection_name is not None:
        transaction.collection_by_entity[operation["entity_id"]] = collection_name
    transaction.created_objects.append(scene_object)
    if operation.get("parent_id") is not None:
        parent = _require_owned_entity(operation["parent_id"], project_id)
        scene_object.parent = parent
        scene_object.matrix_parent_inverse = parent.matrix_world.inverted()
    return scene_object


def _create_camera(operation: dict, transaction: _StageTransaction, project_id: str):
    if _entity(operation["entity_id"]) is not None:
        raise STAGE_SCENE_ENTITY_ID_EXISTS(
            f"entity_id {operation['entity_id']} already exists"
        )
    if bpy.data.objects.get(operation["name"]) is not None:
        raise STAGE_SCENE_STABLE_NAME_EXISTS(
            f"stable name {operation['name']!r} already exists"
        )
    camera = bpy.data.cameras.new(f"{operation['name']} Data")
    scene_object = bpy.data.objects.new(operation["name"], camera)
    scene_object["cclay.entity_id"] = operation["entity_id"]
    scene_object["cclay.owned_project_id"] = project_id
    scene_object.location = operation["location"]
    scene_object.rotation_mode = "XYZ"
    scene_object.rotation_euler = operation["rotation"]
    if "lens" in operation:
        camera.lens = operation["lens"]
    transaction.scene.collection.objects.link(scene_object)
    transaction.created_objects.append(scene_object)
    transaction.scene.camera = scene_object
    return scene_object

def _derived_child_entity_id(root_entity_id: str, child_name: str) -> str:
    """Deterministic UUIDv4-shaped id for a datablock imported under a character root."""
    import hashlib

    digest = hashlib.sha256(
        f"{root_entity_id}\0{child_name}".encode("utf-8")
    ).hexdigest()
    variant = "89ab"[int(digest[16], 16) % 4]
    return (
        f"{digest[:8]}-{digest[8:12]}-4{digest[13:16]}-"
        f"{variant}{digest[17:20]}-{digest[20:32]}"
    )


def _import_character_fbx(operators: object, filepath: str) -> None:
    """Invoke the supported FBX importer, preferring Blender 5.x."""
    missing_error = None
    wm = getattr(operators, "wm", None)
    modern = getattr(wm, "fbx_import", None) if wm is not None else None
    if callable(modern):
        try:
            modern(filepath=filepath)
        except AttributeError as error:
            missing_error = error
        else:
            return
    import_scene = getattr(operators, "import_scene", None)
    legacy = (
        getattr(import_scene, "fbx", None)
        if import_scene is not None else None
    )
    if callable(legacy):
        try:
            legacy(filepath=filepath)
        except AttributeError as error:
            missing_error = error
        else:
            return
    raise StageSceneError(
        "CHARACTER_IMPORT_UNSUPPORTED: Blender FBX import operator is unavailable"
    ) from missing_error


def _create_character(operation: dict, transaction: _StageTransaction, project_id: str):
    """Append one bundled rigged character (armature + skinned meshes) as CCLAY-owned."""
    from mathutils import Euler

    if _entity(operation["entity_id"]) is not None:
        raise STAGE_SCENE_ENTITY_ID_EXISTS(
            f"entity_id {operation['entity_id']} already exists"
        )
    if bpy.data.objects.get(operation["name"]) is not None:
        raise STAGE_SCENE_STABLE_NAME_EXISTS(
            f"stable name {operation['name']!r} already exists"
        )
    asset = (
        Path(__file__).resolve().parent
        / "assets" / "characters" / _CHARACTERS[operation["character_type"]]
    )
    if not asset.is_file():
        raise StageSceneError(
            f"CHARACTER_ASSET_MISSING: {asset.name} is not bundled with the add-on"
        )
    objects_before = set(bpy.data.objects)
    materials_before = set(bpy.data.materials)
    _import_character_fbx(bpy.ops, str(asset))
    imported = [
        scene_object
        for scene_object in bpy.data.objects
        if scene_object not in objects_before
    ]
    roots = [
        scene_object
        for scene_object in imported
        if scene_object.parent is None or scene_object.parent in objects_before
    ]
    if len(roots) != 1 or roots[0].type != "ARMATURE":
        for scene_object in imported:
            _destroy_object(scene_object)
        raise StageSceneError(
            "CHARACTER_IMPORT_INVALID: bundled character must import exactly one armature root"
        )
    for material in bpy.data.materials:
        if material not in materials_before:
            transaction.created_materials.append(material)
    root = roots[0]
    transaction.created_objects.extend(imported)
    root["cclay.entity_id"] = operation["entity_id"]
    root["cclay.owned_project_id"] = project_id
    root["cclay.character_type"] = operation["character_type"]
    root.name = operation["name"]
    for child in imported:
        if child is root:
            continue
        child["cclay.entity_id"] = _derived_child_entity_id(
            operation["entity_id"], child.name
        )
        child["cclay.owned_project_id"] = project_id
        child.name = f"{operation['name']} {child.name}"
    # The bones manifest track requires every bone to carry an entity id;
    # derive them from the root id so re-applying the same plan (rollback,
    # replay) yields identical identities.
    for bone in root.data.bones:
        bone["cclay.entity_id"] = _derived_child_entity_id(
            operation["entity_id"], f"bone:{bone.name}"
        )
    # The FBX importer bakes unit conversion into the armature object
    # (X+90deg rotation, 0.01 scale), so the requested transform composes
    # with - never replaces - the imported base transform.
    root.location = operation["location"]
    root.rotation_mode = "XYZ"
    base_rotation = root.rotation_euler.to_matrix()
    extra_rotation = Euler(operation["rotation"], "XYZ").to_matrix()
    root.rotation_euler = (extra_rotation @ base_rotation).to_euler("XYZ")
    root.scale = [
        float(root.scale[axis]) * operation["scale"][axis] for axis in range(3)
    ]
    return root



def _create_assembly(operation: dict, transaction: _StageTransaction, project_id: str):
    if bpy.data.objects.get(operation["name"]) is not None:
        raise STAGE_SCENE_STABLE_NAME_EXISTS(
            f"stable name {operation['name']!r} already exists"
        )
    root = bpy.data.objects.new(operation["name"], None)
    root["cclay.entity_id"] = str(uuid.uuid4())
    root["cclay.owned_project_id"] = project_id
    root["cclay.assembly_id"] = str(uuid.uuid4())
    root["cclay.assembly_name"] = operation["name"]
    # An assembly owns a Blender Collection of the same name so every part
    # parented under it lives in one Outliner group the user can toggle/hide.
    collection = _ensure_collection(operation["name"], transaction)
    collection.objects.link(root)
    transaction.collection_by_entity[root["cclay.entity_id"]] = operation["name"]
    transaction.created_objects.append(root)
    return root


def _set_parent(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    child = _require_owned_entity(operation["entity_id"], project_id)
    parent = (
        _require_owned_entity(operation["parent_id"], project_id)
        if operation["parent_id"] is not None
        else None
    )
    ancestor = parent
    while ancestor is not None:
        if ancestor == child:
            raise STAGE_SCENE_PARENT_CYCLE(
                f"parenting entity {operation['entity_id']} would create a cycle"
            )
        ancestor = ancestor.parent
    transaction.capture_object(child)
    world = child.matrix_world.copy()
    child.parent = parent
    if parent is not None:
        child.matrix_parent_inverse = parent.matrix_world.inverted()
        # Keep the child in the same Blender Collection as its parent so the
        # Outliner hierarchy and the parenting hierarchy stay aligned.
        parent_collection_name = transaction.collection_by_entity.get(
            parent.get("cclay.entity_id")
        )
        if parent_collection_name is not None:
            parent_collection = bpy.data.collections.get(parent_collection_name)
            if parent_collection is not None and child.name not in parent_collection.objects:
                parent_collection.objects.link(child)
            transaction.collection_by_entity[child.get("cclay.entity_id")] = parent_collection_name
    child.matrix_world = world


def _transform_assembly(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    root = next(
        (
            scene_object
            for scene_object in bpy.data.objects
            if scene_object.get("cclay.assembly_id") == operation["assembly_id"]
        ),
        None,
    )
    if root is None:
        raise STAGE_SCENE_ASSEMBLY_NOT_FOUND(
            f"assembly {operation['assembly_id']} does not exist"
        )
    if not _owned(root, project_id):
        raise STAGE_SCENE_TARGET_NOT_CCLAY_OWNED(
            f"assembly {operation['assembly_id']} was not created by CCLAY for this project"
        )
    transaction.capture_object(root)
    if operation.get("translation") is not None:
        root.location = operation["translation"]
    if operation.get("rotation_euler") is not None:
        root.rotation_mode = "XYZ"
        root.rotation_euler = operation["rotation_euler"]
    if operation.get("scale") is not None:
        root.scale = operation["scale"]


def _generated_material(scene_object: object, transaction: _StageTransaction):
    entity_id = scene_object["cclay.entity_id"]
    generated = [
        material
        for material in scene_object.data.materials
        if material is not None
        and material.get("cclay.generated_for_entity_id") == entity_id
    ]
    if len(generated) > 1:
        raise STAGE_SCENE_TARGET_TYPE_INVALID(
            f"entity {entity_id} has more than one generated material"
        )
    material = generated[0] if generated else None
    transaction.capture_materials(scene_object, material)
    if material is None:
        material = bpy.data.materials.new(f"CCLAY Material {entity_id[:8]}")
        material["cclay.generated_for_entity_id"] = entity_id
        transaction.created_materials.append(material)
    scene_object.data.materials.clear()
    scene_object.data.materials.append(material)
    return material


def _belongs_to_character(mesh: object, root: object) -> bool:
    """True when a mesh is skinned to (or parented under) a character armature."""
    parent = mesh.parent
    while parent is not None:
        if parent == root:
            return True
        parent = parent.parent
    return any(
        modifier.type == "ARMATURE" and modifier.object == root
        for modifier in mesh.modifiers
    )


def _apply_material_color(scene_object: object, operation: dict, transaction: _StageTransaction) -> None:
    material = _generated_material(scene_object, transaction)
    material.use_nodes = True
    material.diffuse_color = operation["color"]
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled is None:
        raise STAGE_SCENE_TARGET_TYPE_INVALID(
            "generated material has no Principled BSDF node"
        )
    principled.inputs["Base Color"].default_value = operation["color"]
    # Surface finish is what separates a metal handrail from matte concrete. When
    # omitted the Principled default is left untouched, so an older plan produces
    # exactly the material it produced before.
    for key, socket_name in (("roughness", "Roughness"), ("metallic", "Metallic")):
        if key not in operation:
            continue
        socket = principled.inputs.get(socket_name)
        if socket is None:
            raise STAGE_SCENE_TARGET_TYPE_INVALID(
                f"generated material has no {socket_name} input"
            )
        socket.default_value = operation[key]


def _set_material_color(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    scene_object = _require_owned_entity(operation["entity_id"], project_id)
    targets: list[object]
    if scene_object.type == "MESH":
        targets = [scene_object]
    elif scene_object.type == "ARMATURE" and scene_object.get("cclay.character_type") is not None:
        # A character is authored as one armature root plus skinned meshes. The
        # director names the character when it says "make it gray"; resolving
        # that name to the armature and then refusing because an armature is not
        # a mesh made a normal request fail and, worse, sent rollback down a
        # path that used to close the bridge. Color the character's meshes.
        targets = [
            candidate
            for candidate in bpy.data.objects
            if candidate.type == "MESH"
            and candidate.get("cclay.owned_project_id") == project_id
            and _belongs_to_character(candidate, scene_object)
        ]
        if not targets:
            raise STAGE_SCENE_TARGET_TYPE_INVALID(
                f"character entity {operation['entity_id']} has no owned skinned mesh"
            )
    else:
        raise STAGE_SCENE_TARGET_TYPE_INVALID(
            f"entity {operation['entity_id']} must be a MESH or a CCLAY character"
        )
    for target in targets:
        _apply_material_color(target, operation, transaction)


def _upsert_area_light(operation: dict, transaction: _StageTransaction, project_id: str):
    scene_object = _entity(operation["entity_id"])
    if scene_object is None:
        if bpy.data.objects.get(operation["name"]) is not None:
            raise STAGE_SCENE_STABLE_NAME_EXISTS(
                f"stable name {operation['name']!r} already exists"
            )
        light = bpy.data.lights.new(f"{operation['name']} Data", "AREA")
        scene_object = bpy.data.objects.new(operation["name"], light)
        scene_object["cclay.entity_id"] = operation["entity_id"]
        scene_object["cclay.owned_project_id"] = project_id
        _link_to_collection(scene_object, operation.get("collection_name"), transaction)
        if operation.get("collection_name") is not None:
            transaction.collection_by_entity[operation["entity_id"]] = operation["collection_name"]
        transaction.created_objects.append(scene_object)
    else:
        if not _owned(scene_object, project_id):
            raise STAGE_SCENE_TARGET_NOT_CCLAY_OWNED(
                f"entity {operation['entity_id']} was not created by CCLAY for this project"
            )
        if scene_object.type != "LIGHT":
            raise STAGE_SCENE_TARGET_TYPE_INVALID(
                f"entity {operation['entity_id']} must be a LIGHT"
            )
        transaction.capture_object(scene_object)
    scene_object.name = operation["name"]
    scene_object.location = operation["location"]
    scene_object.rotation_mode = "XYZ"
    scene_object.rotation_euler = operation["rotation"]
    scene_object.scale = operation["scale"]
    scene_object.data.type = "AREA"
    scene_object.data.energy = operation["energy"]
    scene_object.data.color = operation["color"]
    scene_object.data.size = operation["size"]
    return scene_object


def _adopt_entity(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    """Stamp a pre-existing non-CCLAY object as owned by this project.

    The object must already carry the cclay.entity_id issued by project
    initialization or entity-ID repair; adopting only adds the ownership
    stamp so every owned-entity operation (delete, transform, parent,
    material) works on it afterwards. Re-adopting an object this project
    already owns is an idempotent no-op.
    """
    scene_object = _entity(operation["entity_id"])
    if scene_object is None:
        raise STAGE_SCENE_TARGET_NOT_FOUND(
            f"entity {operation['entity_id']} does not exist"
        )
    owner = scene_object.get("cclay.owned_project_id")
    if owner == project_id:
        return
    if owner is not None:
        raise STAGE_SCENE_TARGET_NOT_CCLAY_OWNED(
            f"entity {operation['entity_id']} is already owned by another project"
        )
    data = scene_object.data
    if scene_object.library is not None or (
        data is not None and data.library is not None
    ):
        raise STAGE_SCENE_SHARED_DATABLOCK(
            f"entity {operation['entity_id']} uses a library-linked datablock"
        )
    _require_exclusive_datablocks(scene_object)
    transaction.adopted_objects.append(scene_object)
    scene_object["cclay.owned_project_id"] = project_id


def _transform_entity(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    scene_object = _require_owned_entity(operation["entity_id"], project_id)
    _require_exclusive_datablocks(scene_object)
    transaction.capture_object(scene_object)
    if "location" in operation:
        scene_object.location = operation["location"]
    if "rotation_euler" in operation:
        scene_object.rotation_mode = "XYZ"
        scene_object.rotation_euler = operation["rotation_euler"]
    if "scale" in operation:
        scene_object.scale = operation["scale"]


def _set_light_property(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    scene_object = _require_owned_entity(operation["entity_id"], project_id)
    if scene_object.type != "LIGHT":
        raise STAGE_SCENE_TARGET_TYPE_INVALID(
            f"entity {operation['entity_id']} must be a LIGHT"
        )
    _require_exclusive_datablocks(scene_object)
    transaction.capture_object(scene_object)
    light = scene_object.data
    if "energy" in operation:
        light.energy = operation["energy"]
    if "color" in operation:
        light.color = operation["color"]
    if "size" in operation:
        if light.type == "AREA":
            light.size = operation["size"]
        elif light.type == "SPOT":
            light.spot_size = operation["size"]
        else:
            raise STAGE_SCENE_TARGET_TYPE_INVALID(
                f"entity {operation['entity_id']} light type {light.type} has no size"
            )


def _set_camera_property(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    scene_object = _require_owned_entity(operation["entity_id"], project_id)
    if scene_object.type != "CAMERA":
        raise STAGE_SCENE_TARGET_TYPE_INVALID(
            f"entity {operation['entity_id']} must be a CAMERA"
        )
    _require_exclusive_datablocks(scene_object)
    transaction.capture_object(scene_object)
    camera = scene_object.data
    if "lens" in operation:
        camera.lens = operation["lens"]
    if "clip_start" in operation:
        camera.clip_start = operation["clip_start"]
    if "clip_end" in operation:
        camera.clip_end = operation["clip_end"]
    if "sensor_width" in operation:
        camera.sensor_width = operation["sensor_width"]
    if "sensor_height" in operation:
        camera.sensor_height = operation["sensor_height"]
    if "sensor_fit" in operation:
        fit_map = {"AUTO": "AUTO", "HORIZONTAL": "HORIZONTAL", "VERTICAL": "VERTICAL", "SQUARE": "SQUARE"}
        camera.sensor_fit = fit_map[operation["sensor_fit"]]


def _set_render_settings(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    render = bpy.context.scene.render
    scene = bpy.context.scene
    transaction.capture_render()
    if "resolution_x" in operation:
        render.resolution_x = operation["resolution_x"]
    if "resolution_y" in operation:
        render.resolution_y = operation["resolution_y"]
    if "resolution_percentage" in operation:
        render.resolution_percentage = operation["resolution_percentage"]
    if "fps" in operation:
        render.fps = operation["fps"]
        render.fps_base = 1.0
    if "frame_start" in operation:
        scene.frame_start = operation["frame_start"]
    if "frame_end" in operation:
        scene.frame_end = operation["frame_end"]


def _rename_entity(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    scene_object = _require_owned_entity(operation["entity_id"], project_id)
    _require_exclusive_datablocks(scene_object)
    transaction.capture_object(scene_object)
    scene_object.name = operation["name"]


_MAX_MOTION_FILE_BYTES = 64 * 1024 * 1024
_MAX_MOTION_PAYLOAD_BYTES = 96 * 1024 * 1024
_MAX_NPY_HEADER_BYTES = 16 * 1024
_MOTION_REQUIRED_MEMBERS = {
    "local_rot_mats.npy",
    "posed_joints.npy",
    "fps.npy",
}
# ARDY writes these next to the three members we consume: scripts/generate.py
# and both cclay_* generators end in np.savez(path, **motion_dict), so a real
# generated motion always carries them. Demanding an exact three-member set
# rejected every unmodified ARDY npz (measured: 16 of 42 staged motions failed
# APPLY_MOTION_MALFORMED), so they are validated and carried rather than
# stripped -- stripping would also throw away foot_contacts, which the model
# predicts and preflight currently re-derives from joint heights.
# Shapes are frame-locked to local_rot_mats so a carried member cannot smuggle
# in a different clip; ``None`` in a shape means "the clip's frame count".
_MOTION_OPTIONAL_MEMBERS = {
    "foot_contacts.npy": (("b",), (None, 4)),
    "global_rot_mats.npy": (("f",), (None, 27, 3, 3)),
    "global_root_heading.npy": (("f",), (None, 2)),
    "root_positions.npy": (("f",), (None, 3)),
    "smooth_root_pos.npy": (("f",), (None, 3)),
    "text.npy": (("U",), ()),
}
_MOTION_MEMBER_NAMES = _MOTION_REQUIRED_MEMBERS | set(_MOTION_OPTIONAL_MEMBERS)


def _motion_malformed(motion_id: str, message: str) -> None:
    raise StageSceneError(f"APPLY_MOTION_MALFORMED: motion {motion_id} {message}")


def _inspect_motion_member(archive, info, motion_id: str):
    try:
        with archive.open(info, "r") as member:
            if member.read(6) != b"\x93NUMPY":
                _motion_malformed(motion_id, f"{info.filename} has an invalid npy magic")
            version = tuple(member.read(2))
            if version == (1, 0):
                header_length_bytes = member.read(2)
                if len(header_length_bytes) != 2:
                    raise EOFError("truncated npy header length")
                header_length = struct.unpack("<H", header_length_bytes)[0]
                encoding = "latin1"
            elif version in ((2, 0), (3, 0)):
                header_length_bytes = member.read(4)
                if len(header_length_bytes) != 4:
                    raise EOFError("truncated npy header length")
                header_length = struct.unpack("<I", header_length_bytes)[0]
                encoding = "utf-8" if version == (3, 0) else "latin1"
            else:
                _motion_malformed(
                    motion_id,
                    f"{info.filename} uses unsupported npy version {version}",
                )
            if header_length > _MAX_NPY_HEADER_BYTES:
                _motion_malformed(
                    motion_id,
                    f"{info.filename} header exceeds {_MAX_NPY_HEADER_BYTES} bytes",
                )
            header_bytes = member.read(header_length)
            if len(header_bytes) != header_length:
                raise EOFError("truncated npy header")
            header = ast.literal_eval(header_bytes.decode(encoding))
            payload_offset = member.tell()
    except (EOFError, OSError, UnicodeError, ValueError, SyntaxError) as error:
        _motion_malformed(motion_id, f"has an invalid {info.filename} header: {error}")
    if not isinstance(header, dict) or set(header) != {
        "descr", "fortran_order", "shape"
    }:
        _motion_malformed(motion_id, f"{info.filename} has invalid header fields")
    shape = header["shape"]
    fortran_order = header["fortran_order"]
    descr = header["descr"]
    if (
        not isinstance(shape, tuple)
        or any(
            isinstance(size, bool) or not isinstance(size, int) or size < 0
            for size in shape
        )
    ):
        _motion_malformed(motion_id, f"{info.filename} has an invalid shape")
    if not isinstance(fortran_order, bool):
        _motion_malformed(motion_id, f"{info.filename} has invalid order metadata")
    if fortran_order:
        _motion_malformed(motion_id, f"{info.filename} must use C order")
    if not isinstance(descr, str):
        _motion_malformed(motion_id, f"{info.filename} must have a scalar dtype")
    # Itemsize is multi-digit for the carried unicode prompt scalar (e.g. "<U187");
    # the numeric members stay pinned to 1/2/4/8 by _is_supported_motion_dtype.
    dtype_match = re.fullmatch(r"([<>=|])([A-Za-z?])([0-9]{1,4})", descr)
    if dtype_match is None:
        _motion_malformed(motion_id, f"{info.filename} has an invalid dtype")
    byte_order, dtype_kind, itemsize_text = dtype_match.groups()
    itemsize = int(itemsize_text)
    if dtype_kind == "U":
        # numpy spells unicode width in characters ("<U187"), not bytes, and the
        # payload is UCS-4. Return bytes so every caller's size math is uniform.
        itemsize *= 4
    return shape, dtype_kind, itemsize, byte_order, payload_offset


def _is_supported_motion_dtype(kind: str, itemsize: int, byte_order: str) -> bool:
    return (
        (
            (kind in ("i", "u") and itemsize in (1, 2, 4, 8))
            or (kind == "f" and itemsize in (2, 4, 8))
        )
        and (byte_order != "|" or itemsize == 1)
    )


def _is_supported_carried_dtype(
    kind: str, itemsize: int, byte_order: str, kinds: tuple
) -> bool:
    """Dtype rule for the carried members listed in _MOTION_OPTIONAL_MEMBERS.

    ``_is_supported_motion_dtype`` only covers the numeric arrays we read; the
    carried set adds boolean foot contacts and a unicode prompt scalar. Object
    dtypes stay rejected here, and ``numpy.load(allow_pickle=False)`` in
    ``_load_motion_payload`` is the second line of defence.
    """
    if kind not in kinds:
        return False
    if kind == "b":
        return itemsize == 1
    if kind == "U":
        return itemsize > 0 and itemsize % 4 == 0
    return _is_supported_motion_dtype(kind, itemsize, byte_order)


def _inspect_motion_archive(path: Path, motion_id: str | None = None) -> int:
    motion_id = path.stem if motion_id is None else motion_id
    try:
        with zipfile.ZipFile(path, "r") as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                _motion_malformed(motion_id, "contains duplicate members")
            missing = sorted(_MOTION_REQUIRED_MEMBERS - set(names))
            if missing:
                _motion_malformed(motion_id, f"is missing {missing}")
            unknown = sorted(set(names) - _MOTION_MEMBER_NAMES)
            if unknown:
                _motion_malformed(motion_id, f"contains unknown member(s) {unknown}")
            if any(
                info.is_dir()
                or info.filename != Path(info.filename).name
                or "\\" in info.filename
                for info in infos
            ):
                _motion_malformed(motion_id, "contains an unsafe member name")
            declared_size = sum(info.file_size for info in infos)
            if declared_size > _MAX_MOTION_PAYLOAD_BYTES:
                _motion_malformed(
                    motion_id,
                    f"declares more than {_MAX_MOTION_PAYLOAD_BYTES} uncompressed bytes",
                )

            by_name = {info.filename: info for info in infos}
            (
                rotations_shape,
                rotations_kind,
                rotations_itemsize,
                rotations_byte_order,
                rotations_offset,
            ) = _inspect_motion_member(
                archive, by_name["local_rot_mats.npy"], motion_id
            )
            (
                joints_shape,
                joints_kind,
                joints_itemsize,
                joints_byte_order,
                joints_offset,
            ) = _inspect_motion_member(
                archive, by_name["posed_joints.npy"], motion_id
            )
            fps_shape, fps_kind, fps_itemsize, fps_byte_order, fps_offset = (
                _inspect_motion_member(archive, by_name["fps.npy"], motion_id)
            )
            if (
                len(rotations_shape) != 4
                or rotations_shape[1:] != (27, 3, 3)
                or not 1 <= rotations_shape[0] <= motion_retarget.MAX_FRAMES
            ):
                _motion_malformed(
                    motion_id, "local_rot_mats.npy must have shape (F, 27, 3, 3)"
                )
            if joints_shape != (rotations_shape[0], 27, 3):
                _motion_malformed(
                    motion_id, "posed_joints.npy must have shape (F, 27, 3)"
                )
            if not _is_supported_motion_dtype(
                rotations_kind, rotations_itemsize, rotations_byte_order
            ):
                _motion_malformed(
                    motion_id, "local_rot_mats.npy must have a real numeric dtype"
                )
            if not _is_supported_motion_dtype(
                joints_kind, joints_itemsize, joints_byte_order
            ):
                _motion_malformed(
                    motion_id, "posed_joints.npy must have a real numeric dtype"
                )
            if (
                fps_shape != ()
                or fps_kind not in ("i", "u")
                or not _is_supported_motion_dtype(
                    fps_kind, fps_itemsize, fps_byte_order
                )
            ):
                _motion_malformed(
                    motion_id, "fps.npy must be a non-boolean integral scalar"
                )
            size_checks = [
                (
                    by_name["local_rot_mats.npy"],
                    rotations_shape,
                    rotations_itemsize,
                    rotations_offset,
                ),
                (
                    by_name["posed_joints.npy"],
                    joints_shape,
                    joints_itemsize,
                    joints_offset,
                ),
                (by_name["fps.npy"], fps_shape, fps_itemsize, fps_offset),
            ]
            frame_count = rotations_shape[0]
            for name, (kinds, template) in _MOTION_OPTIONAL_MEMBERS.items():
                info = by_name.get(name)
                if info is None:
                    continue
                shape, kind, itemsize, byte_order, offset = _inspect_motion_member(
                    archive, info, motion_id
                )
                expected = tuple(
                    frame_count if dimension is None else dimension
                    for dimension in template
                )
                if shape != expected:
                    _motion_malformed(motion_id, f"{name} must have shape {expected}")
                if not _is_supported_carried_dtype(kind, itemsize, byte_order, kinds):
                    _motion_malformed(motion_id, f"{name} has an unsupported dtype")
                size_checks.append((info, shape, itemsize, offset))
            for info, shape, itemsize, payload_offset in size_checks:
                if payload_offset + math.prod(shape) * itemsize != info.file_size:
                    _motion_malformed(
                        motion_id,
                        f"{info.filename} size does not match its header",
                    )
            with archive.open(by_name["fps.npy"], "r") as fps_member:
                fps_member.read(fps_offset)
                fps_bytes = fps_member.read(fps_itemsize)
            byte_order = (
                "little"
                if fps_byte_order == "<"
                or fps_byte_order == "|"
                or (fps_byte_order == "=" and sys.byteorder == "little")
                else "big"
            )
            fps = int.from_bytes(
                fps_bytes,
                byteorder=byte_order,
                signed=fps_kind == "i",
            )
            if not motion_retarget.FPS_BOUNDS[0] <= fps <= motion_retarget.FPS_BOUNDS[1]:
                _motion_malformed(
                    motion_id,
                    f"fps must be in {motion_retarget.FPS_BOUNDS[0]}.."
                    f"{motion_retarget.FPS_BOUNDS[1]}",
                )
            return fps
    except StageSceneError:
        raise
    except (NotImplementedError, RuntimeError, zipfile.BadZipFile) as error:
        _motion_malformed(motion_id, f"is not a readable npz: {error}")


def _motion_path(project_directory: object, motion_id: str) -> Path:
    """Resolve .cclay/motions/<motion_id>.npz with the trust fencing applied.

    The motion id grammar (validated at parse time) cannot traverse, but the
    resolved path is still fenced to the motions directory and symlinks are
    refused, mirroring the runtime-evidence trust rules.

    Extracted so the plan-level fps preflight reads the same fenced path as the
    loader instead of re-deriving it; two derivations would be two places to
    forget a check.
    """
    if project_directory is None:
        raise StageSceneError(
            "APPLY_MOTION_PROJECT_DIR_UNKNOWN: the mutation connection has no "
            "project directory bound"
        )
    motions_dir = (Path(project_directory) / ".cclay" / "motions").resolve()
    path = motions_dir / f"{motion_id}.npz"
    if path.is_symlink() or not path.is_file():
        raise StageSceneError(
            f"APPLY_MOTION_NOT_FOUND: .cclay/motions/{motion_id}.npz is not a regular file"
        )
    if path.resolve().parent != motions_dir:
        raise StageSceneError(
            f"APPLY_MOTION_NOT_FOUND: motion {motion_id} escapes the motions directory"
        )
    if path.stat().st_size > _MAX_MOTION_FILE_BYTES:
        raise StageSceneError(
            f"APPLY_MOTION_TOO_LARGE: motion {motion_id} exceeds "
            f"{_MAX_MOTION_FILE_BYTES} bytes"
        )
    return path


def _motion_fps(project_directory: object, motion_id: str) -> int:
    """The npz's native fps, read from headers only.

    Cheap enough to call for every apply_motion in a plan before any mutation:
    _inspect_motion_archive never materializes an array.
    """
    return _inspect_motion_archive(
        _motion_path(project_directory, motion_id), motion_id
    )


def _load_motion_payload(
    project_directory: object,
    motion_id: str,
    *,
    validate: bool = True,
    carried: tuple = (),
) -> tuple[object, object, int, dict]:
    """Load and validate .cclay/motions/<motion_id>.npz from the project dir."""
    path = _motion_path(project_directory, motion_id)
    fps = _inspect_motion_archive(path, motion_id)

    import numpy

    try:
        with numpy.load(path, allow_pickle=False) as data:
            local_rot_mats = data["local_rot_mats"]
            posed_joints = data["posed_joints"]
            # Only the requested carried arrays are materialized: global_rot_mats
            # alone is as large as local_rot_mats, so apply_motion must not pay
            # for members it never reads.
            carried_arrays = {
                name: data[name] for name in carried if name in data.files
            }
    except StageSceneError:
        raise
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        raise StageSceneError(
            f"APPLY_MOTION_MALFORMED: motion {motion_id} is not a readable npz: {error}"
        )
    if validate:
        try:
            motion_retarget.validate_motion(local_rot_mats, posed_joints, fps)
        except motion_retarget.MotionRetargetError as error:
            raise StageSceneError(f"APPLY_MOTION_MALFORMED: {error}")
    return local_rot_mats, posed_joints, fps, carried_arrays


def _rig_scale_inputs(bones) -> tuple[str, object]:
    """Pure read-only (bone prefix, rig thigh length) scale inputs.

    Shared by ``_apply_motion`` and ``motion_preflight._derive_entity_scale``
    so the two thigh measurements cannot drift. Returns ``(prefix, None)``
    when the RightUpLeg/RightLeg pair is missing so each caller raises its
    own contract error.
    """
    prefix = "mixamorig:" if any(b.name.startswith("mixamorig:") for b in bones) else ""
    upper = bones.get(f"{prefix}RightUpLeg")
    lower = bones.get(f"{prefix}RightLeg")
    if upper is None or lower is None:
        return prefix, None
    return prefix, (lower.head_local - upper.head_local).length


class PoseContactError(StageSceneError):
    """A pose-contact inspection request is malformed or its target invalid."""

    code = "INVALID_POSE_CONTACT_REQUEST"


_MAX_POSE_CONTACT_FRAMES = 64
# ARDY's own vocabulary (LeftFoot/RightFoot/*ToeBase) is preserved verbatim in
# the bone lookup below -- it is external constrained-generation vocabulary
# (see motion_retarget.MIXAMO_TARGETS and motion_preflight.FOOT_CONTACT_CHANNELS)
# and issue #2 requires it stay addressable, even though the joint itself is
# NOT a sole-contact point (see the module docstring of motion_preflight.py).
_POSE_CONTACT_SIDES = (
    ("left", "LeftFoot", "LeftToeBase"),
    ("right", "RightFoot", "RightToeBase"),
)


def _pose_contact_frames(frames: object) -> list[int]:
    """Validate and return the requested frame list; fail closed on anything
    that is not a short list of non-negative integers.
    """
    if (
        not isinstance(frames, list)
        or not frames
        or len(frames) > _MAX_POSE_CONTACT_FRAMES
    ):
        raise PoseContactError(
            f"frames must be a list of 1..{_MAX_POSE_CONTACT_FRAMES} integers"
        )
    result = []
    for value in frames:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise PoseContactError(
                "every frame must be a non-negative integer"
            )
        result.append(value)
    return result


def _pose_contact_armature(entity_id: str):
    """Resolve ``entity_id`` to a CCLAY-tagged armature; fail closed otherwise."""
    scene_object = _entity(entity_id)
    if scene_object is None:
        raise PoseContactError(f"entity_id {entity_id} does not exist")
    if scene_object.type != "ARMATURE":
        raise PoseContactError(
            f"entity_id {entity_id} is a {scene_object.type}, not an ARMATURE"
        )
    return scene_object


def _skinned_meshes(armature) -> list:
    """MESH objects deformed by ``armature`` through an Armature modifier."""
    meshes = []
    for candidate in bpy.data.objects:
        if candidate.type != "MESH":
            continue
        for modifier in candidate.modifiers:
            if getattr(modifier, "type", None) == "ARMATURE" and modifier.object is armature:
                meshes.append(candidate)
                break
    return meshes


def _foot_vertex_group_hits(meshes, bone_name: str) -> list[tuple[object, int]]:
    """(mesh, vertex_group_index) pairs whose vertex group is named ``bone_name``."""
    hits = []
    for mesh_obj in meshes:
        group = mesh_obj.vertex_groups.get(bone_name)
        if group is not None:
            hits.append((mesh_obj, group.index))
    return hits


def _lowest_deformed_vertex_world(depsgraph, hits) -> list[float] | None:
    """World co of the lowest-Z evaluated vertex weighted (>0) to any of ``hits``.

    Reads the depsgraph-evaluated mesh, so this reflects the deformed sole
    surface at the currently-set frame, not the rest-pose mesh or a joint
    offset. Returns ``None`` when no such vertex exists (empty groups, no
    weight, or no bound mesh) -- callers must not fall back to a guessed
    constant offset.
    """
    best = None
    for mesh_obj, group_index in hits:
        evaluated = mesh_obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            matrix = evaluated.matrix_world
            for vertex in mesh.vertices:
                if not any(
                    group.group == group_index and group.weight > 0.0
                    for group in vertex.groups
                ):
                    continue
                world = matrix @ vertex.co
                if best is None or world.z < best.z:
                    best = world.copy()
        finally:
            evaluated.to_mesh_clear()
    return list(best) if best is not None else None


def _pose_contact_side(
    armature, meshes, depsgraph, foot_bone_name: str, toe_bone_name: str, *, deformed: bool
) -> dict:
    """Raw per-side geometry for one frame; never infers surface contact.

    ``foot_joint_co``/``toe_joint_co`` are the skeleton joints (e.g.
    ``LeftFoot``/``LeftToeBase``) that issue #2 warns must not be treated as
    sole-contact markers. ``heel_co``/``toe_co``/``sole_co`` are read from the
    deformed mesh surface when ``deformed`` is true and a matching vertex
    group resolves; otherwise they -- and ``sole_source`` -- are ``None``
    rather than a guessed constant offset.
    """
    pose_bone = armature.pose.bones.get(foot_bone_name)
    toe_pose_bone = armature.pose.bones.get(toe_bone_name)
    if pose_bone is None or toe_pose_bone is None:
        return {
            "foot_joint_co": None,
            "toe_joint_co": None,
            "heel_co": None,
            "toe_co": None,
            "sole_co": None,
            "sole_source": None,
            "heel_to_toe": None,
        }
    foot_joint_co = list(armature.matrix_world @ pose_bone.head)
    toe_joint_co = list(armature.matrix_world @ toe_pose_bone.head)
    heel_co = None
    toe_co = None
    if deformed:
        heel_co = _lowest_deformed_vertex_world(
            depsgraph, _foot_vertex_group_hits(meshes, foot_bone_name)
        )
        toe_co = _lowest_deformed_vertex_world(
            depsgraph, _foot_vertex_group_hits(meshes, toe_bone_name)
        )
    candidates = [co for co in (heel_co, toe_co) if co is not None]
    sole_co = min(candidates, key=lambda co: co[2]) if candidates else None
    sole_source = "deformed_mesh" if candidates else None
    heel_to_toe = (
        [toe_co[axis] - heel_co[axis] for axis in range(3)]
        if heel_co is not None and toe_co is not None
        else None
    )
    return {
        "foot_joint_co": foot_joint_co,
        "toe_joint_co": toe_joint_co,
        "heel_co": heel_co,
        "toe_co": toe_co,
        "sole_co": sole_co,
        "sole_source": sole_source,
        "heel_to_toe": heel_to_toe,
    }


def _pose_contact_samples(
    entity_id: str, frames: object, *, deformed: bool = True
) -> list[dict]:
    """Read-only per-frame/per-side character-side geometry for pose-contact QA.

    Returns one ``{"frame": int, "sides": {"left": {...}, "right": {...}}}``
    dict per requested frame (see ``_pose_contact_side`` for the per-side
    shape). This is the character-side half of issue #2's frame-specific
    pose-contact inspection: it reports skeleton joint position alongside
    deformed-mesh heel/toe/sole samples, but deliberately stops short of
    support-plane gap/penetration/footprint math (that support geometry and
    the closed result schema belong to ``pose_contacts``/``connection``, so
    this stays bpy-only and host-untestable pieces stay out of it).

    Frame stepping mutates and restores ``scene.frame_current`` and forces a
    depsgraph re-evaluation per frame via ``frame_set`` so every sample
    reflects that frame's actually-deformed pose, never a stale evaluation.
    ``frame_set`` does not itself reject a frame outside ``[scene.frame_start,
    scene.frame_end]`` -- it silently clamps/holds instead, which is exactly
    the "looks right, is wrong" failure issue #2 targets. This layer only
    validates frame count/type (see ``_pose_contact_frames``); the caller
    (``pose_contacts``'s pose-contact param validation) MUST reject any
    frame outside the scene's configured range before calling this function.
    """
    armature = _pose_contact_armature(entity_id)
    frame_list = _pose_contact_frames(frames)
    meshes = _skinned_meshes(armature)
    prefix = (
        "mixamorig:"
        if any(bone.name.startswith("mixamorig:") for bone in armature.data.bones)
        else ""
    )
    scene = bpy.context.scene
    original_frame = scene.frame_current
    samples = []
    try:
        for frame in frame_list:
            scene.frame_set(frame)
            depsgraph = bpy.context.evaluated_depsgraph_get()
            sides = {
                side: _pose_contact_side(
                    armature,
                    meshes,
                    depsgraph,
                    f"{prefix}{foot_bone}",
                    f"{prefix}{toe_bone}",
                    deformed=deformed,
                )
                for side, foot_bone, toe_bone in _POSE_CONTACT_SIDES
            }
            samples.append({"frame": frame, "sides": sides})
    finally:
        scene.frame_set(original_frame)
    return samples


_KEYFRAME_BULK_VALUES: dict[str, int | float] | None = None


def _keyframe_bulk_values() -> dict[str, int | float]:
    global _KEYFRAME_BULK_VALUES
    if _KEYFRAME_BULK_VALUES is None:
        properties = bpy.types.Keyframe.bl_rna.properties
        enum_identifiers = {
            "interpolation": "BEZIER",
            "easing": "AUTO",
            "handle_left_type": "AUTO_CLAMPED",
            "handle_right_type": "AUTO_CLAMPED",
        }
        values = {
            name: properties[name].enum_items[identifier].value
            for name, identifier in enum_identifiers.items()
        }
        values.update({
            name: properties[name].default
            for name in ("back", "amplitude", "period")
        })
        _KEYFRAME_BULK_VALUES = values
    return _KEYFRAME_BULK_VALUES


def _create_detached_action_topology(action: object, object_name: str) -> tuple[object, object]:
    """Create and feature-probe one layered OBJECT-slot keyframe channel bag."""
    try:
        slots = action.slots
        layers = action.layers
        slot = slots.new(id_type="OBJECT", name=object_name)
        layer = layers.new(name="CCLAY Motion")
        strip = layer.strips.new(type="KEYFRAME")
        channelbag_fn = strip.channelbag
        channelbag = channelbag_fn(slot, ensure=True)
    except (AttributeError, RuntimeError, TypeError) as error:
        raise StageSceneError(
            "APPLY_MOTION_ACTION_TOPOLOGY_UNSUPPORTED: Blender must provide "
            "OBJECT slots, layers, KEYFRAME strips, and slot channel bags"
        ) from error
    if (
        channelbag is None
        or not hasattr(channelbag, "fcurves")
        or not hasattr(channelbag.fcurves, "new")
        or not hasattr(slot, "handle")
        or not hasattr(channelbag, "slot_handle")
        or channelbag.slot_handle != slot.handle
    ):
        raise StageSceneError(
            "APPLY_MOTION_ACTION_TOPOLOGY_UNSUPPORTED: layered action probe was partial"
        )
    return slot, channelbag


def _unsupported_group_name_signature(error: TypeError) -> bool:
    message = str(error)
    return (
        (
            "group_name" in message
            and (
                "keyword" in message
                or "argument" in message
                or "parameter" in message
            )
        )
        or (
            "ActionChannelbagFCurves.new()" in message
            and "takes at most 2 arguments" in message
        )
    )


def _new_grouped_fcurve(
    channelbag: object,
    data_path: str,
    array_index: int,
    group_name: str,
) -> object:
    """Create a grouped channel-bag F-Curve on Blender 5.x or 4.4."""
    try:
        return channelbag.fcurves.new(
            data_path, index=array_index, group_name=group_name
        )
    except TypeError as error:
        if not _unsupported_group_name_signature(error):
            raise
    fcurve = channelbag.fcurves.new(data_path, index=array_index)
    try:
        groups = channelbag.groups
        group = groups.get(group_name)
        if group is None:
            group = groups.new(group_name)
        fcurve.group = group
        return fcurve
    except BaseException:
        try:
            channelbag.fcurves.remove(fcurve)
        except (AttributeError, ReferenceError, RuntimeError, TypeError):
            pass
        raise


def _bulk_fcurve(
    channelbag: object,
    data_path: str,
    array_index: int,
    group_name: str,
    frames: list[float],
    values: list[float],
) -> object:
    if len(frames) != len(values) or not frames:
        raise StageSceneError("APPLY_MOTION_CURVE_INVALID: curve samples are incomplete")
    try:
        fcurve = _new_grouped_fcurve(
            channelbag, data_path, array_index, group_name
        )
        points = fcurve.keyframe_points
        points.add(len(frames))
        coordinates = [0.0] * (2 * len(frames))
        coordinates[0::2] = frames
        coordinates[1::2] = values
        points.foreach_set("co", coordinates)
        bulk_values = _keyframe_bulk_values()
        point_count = len(frames)
        for name, value in bulk_values.items():
            points.foreach_set(name, [value] * point_count)
        fcurve.update()
    except (AttributeError, KeyError, RuntimeError, TypeError, ValueError) as error:
        raise StageSceneError(
            "APPLY_MOTION_CURVE_WRITE_FAILED: bulk F-Curve authoring failed"
        ) from error
    return fcurve


_CURVE_VALUE_REL_TOLERANCE = 1e-6
_CURVE_VALUE_ABS_TOLERANCE = 1e-6


def _curve_inventory_matches(
    actual: dict[tuple[str, int], tuple[str, list[float], list[float]]],
    expected: dict[tuple[str, int], tuple[str, list[float], list[float]]],
) -> bool:
    """Compare exact curve topology/frames with bounded RNA float value drift."""
    if actual.keys() != expected.keys():
        return False
    for key, (expected_group, expected_frames, expected_values) in expected.items():
        actual_group, actual_frames, actual_values = actual[key]
        if (
            actual_group != expected_group
            or actual_frames != expected_frames
            or len(actual_values) != len(expected_values)
            or any(
                not math.isclose(
                    actual_value,
                    expected_value,
                    rel_tol=_CURVE_VALUE_REL_TOLERANCE,
                    abs_tol=_CURVE_VALUE_ABS_TOLERANCE,
                )
                for actual_value, expected_value in zip(
                    actual_values, expected_values
                )
            )
        ):
            return False
    return True


def _rna_identity(value: object) -> tuple[str, int]:
    """Return stable Blender RNA identity, falling back only for test doubles."""
    as_pointer = getattr(value, "as_pointer", None)
    if callable(as_pointer):
        try:
            pointer = int(as_pointer())
        except (ReferenceError, RuntimeError, TypeError, ValueError):
            pointer = 0
        if pointer:
            return ("RNA", pointer)
    return ("PYTHON", id(value))


def _channelbag_has_unique_owner(
    channelbag: object,
    slot_handle: object,
    ownership_locations: list[list[object]],
) -> bool:
    """Require one strip/layer owner, deduplicating alternate RNA enumeration paths."""
    target_identity = _rna_identity(channelbag)
    owning_locations = 0
    for enumerated in ownership_locations:
        unique_for_slot: dict[tuple[str, int], object] = {}
        for bag in enumerated:
            if getattr(bag, "slot_handle", None) != slot_handle:
                continue
            unique_for_slot.setdefault(_rna_identity(bag), bag)
        if target_identity in unique_for_slot:
            if len(unique_for_slot) != 1:
                return False
            owning_locations += 1
    return owning_locations == 1


_POINT_VECTOR_FIELDS = ("co", "handle_left", "handle_right")
_POINT_ENUM_FIELDS = (
    "interpolation", "easing", "handle_left_type", "handle_right_type",
)
_POINT_INERT_FIELDS = ("back", "amplitude", "period")


def _keyframe_points_snapshot(
    points: object,
    bulk_values: dict,
    buffer_cache: dict[int, tuple[dict, dict, dict]] | None = None,
) -> tuple[list[float], list[float], bool, bool]:
    """Read and validate point RNA in bulk, with a test-double fallback."""
    point_count = len(points)
    foreach_get = getattr(points, "foreach_get", None)
    if callable(foreach_get):
        try:
            cached = (
                buffer_cache.get(point_count)
                if buffer_cache is not None else None
            )
            if cached is None:
                vectors = {
                    name: [0.0] * (2 * point_count)
                    for name in _POINT_VECTOR_FIELDS
                }
                enums = {
                    name: [0] * point_count for name in _POINT_ENUM_FIELDS
                }
                inert = {
                    name: [0.0] * point_count for name in _POINT_INERT_FIELDS
                }
                if buffer_cache is not None:
                    buffer_cache[point_count] = (vectors, enums, inert)
            else:
                vectors, enums, inert = cached
            for name, values in vectors.items():
                foreach_get(name, values)
            for name, values in enums.items():
                foreach_get(name, values)
            for name, values in inert.items():
                foreach_get(name, values)
            coordinates = vectors["co"]
            frames = coordinates[0::2]
            values = coordinates[1::2]
            valid = (
                all(
                    math.isfinite(value)
                    for vector in vectors.values()
                    for value in vector
                )
                and all(
                    value == bulk_values[name]
                    for name, field_values in enums.items()
                    for value in field_values
                )
                and all(
                    value == bulk_values[name]
                    for name, field_values in inert.items()
                    for value in field_values
                )
                and all(
                    frames[index] < frames[index + 1]
                    for index in range(point_count - 1)
                )
            )
            return frames, values, valid, True
        except (AttributeError, KeyError, RuntimeError, TypeError, ValueError):
            pass

    point_values = list(points)
    frames = [float(point.co.x) for point in point_values]
    values = [float(point.co.y) for point in point_values]
    valid = (
        all(point.interpolation == "BEZIER" for point in point_values)
        and all(point.easing == "AUTO" for point in point_values)
        and all(
            point.handle_left_type == "AUTO_CLAMPED" for point in point_values
        )
        and all(
            point.handle_right_type == "AUTO_CLAMPED" for point in point_values
        )
        and all(
            math.isfinite(value)
            for point in point_values
            for value in (
                point.co.x, point.co.y,
                point.handle_left.x, point.handle_left.y,
                point.handle_right.x, point.handle_right.y,
            )
        )
        and all(
            getattr(point, name) == bulk_values[name]
            for point in point_values
            for name in _POINT_INERT_FIELDS
        )
        and all(
            frames[index] < frames[index + 1]
            for index in range(point_count - 1)
        )
    )
    return frames, values, valid, False


def _validate_detached_curves(
    action: object,
    slot: object,
    channelbag: object,
    expected: dict[tuple[str, int], tuple[str, list[float], list[float]]],
) -> None:
    if channelbag.slot_handle != slot.handle:
        raise StageSceneError("APPLY_MOTION_CURVE_INVALID: channel bag owns wrong slot")
    curves = list(channelbag.fcurves)
    actual: dict[tuple[str, int], tuple[str, list[float], list[float]]] = {}
    grouped_indices: dict[tuple[str, str], set[int]] = {}
    inert = _keyframe_bulk_values()
    point_buffer_cache: dict[int, tuple[dict, dict, dict]] = {}
    for fcurve in curves:
        key = (fcurve.data_path, fcurve.array_index)
        if key in actual:
            raise StageSceneError("APPLY_MOTION_CURVE_INVALID: duplicate F-Curve")
        points = fcurve.keyframe_points
        group_name = fcurve.group.name if fcurve.group is not None else ""
        frames, values, points_valid, _ = _keyframe_points_snapshot(
            points, inert, point_buffer_cache
        )
        actual[key] = (group_name, frames, values)
        indices = grouped_indices.setdefault((fcurve.data_path, group_name), set())
        if fcurve.array_index in indices:
            raise StageSceneError("APPLY_MOTION_CURVE_INVALID: duplicate grouped component")
        indices.add(fcurve.array_index)
        if (
            fcurve.extrapolation != "CONSTANT"
            or len(fcurve.modifiers) != 0
            or not points_valid
        ):
            raise StageSceneError(
                "APPLY_MOTION_CURVE_INVALID: detached curve validation failed"
            )
    if not _curve_inventory_matches(actual, expected):
        raise StageSceneError(
            "APPLY_MOTION_CURVE_INVALID: detached curve inventory does not match tracks"
        )
    ownership_locations = []
    for layer in action.layers:
        for strip in layer.strips:
            enumerated = []
            if hasattr(strip, "channelbag"):
                try:
                    enumerated.append(strip.channelbag(slot))
                except (RuntimeError, TypeError):
                    pass
            enumerated.extend(getattr(strip, "channelbags", ()))
            ownership_locations.append(enumerated)
    if not _channelbag_has_unique_owner(
        channelbag, slot.handle, ownership_locations
    ):
        raise StageSceneError(
            "APPLY_MOTION_CURVE_INVALID: action/slot/channel bag ownership mismatch"
        )


def _resolve_operation_hand_shapes(operation: dict) -> dict[str, str]:
    if "hand_shapes" in operation:
        requested = operation["hand_shapes"]
        return hand_shapes.resolve_hand_shapes(
            requested.get("left"), requested.get("right")
        )
    legacy = operation.get("hand_pose", "relaxed")
    return hand_shapes.resolve_hand_shapes(legacy, legacy)


def _resolve_operation_hand_track(
    operation: dict, frame_count: int
) -> dict[str, tuple[tuple[int, str], ...]]:
    """Resolve the optional per-side preset track against the clip length."""
    if "hand_track" not in operation:
        return {"left": (), "right": ()}
    requested = operation["hand_track"]
    return hand_shapes.resolve_hand_track(
        requested.get("left"), requested.get("right"), frame_count
    )


def _requested_scene_fps(plan: dict) -> int | None:
    """The fps the plan explicitly asks for, or None when it asks for nothing.

    Last write wins, mirroring Blender: a plan may carry several
    set_render_settings operations and only the final fps survives.
    """
    requested = None
    for operation in plan["operations"]:
        if operation["op"] == "set_render_settings" and "fps" in operation:
            requested = int(operation["fps"])
    return requested


def _require_plan_fps_agrees(plan: dict, motion_fps_of) -> None:
    """Require a single frame rate across the whole plan.

    apply_motion bakes exactly one npz frame per scene frame, so the scene rate
    IS the motion rate -- ARDY Core is 20 fps. Two things can disagree with it
    and both used to be decided by operation order, silently:

    * an explicit set_render_settings fps. Render-last left 20 fps keys playing
      at 24, so the clip ran 20% fast; motion-last discarded the requested fps.
    * a second apply_motion whose npz has a different native fps. Whichever ran
      last won the scene, so the other clip played at the wrong rate.

    Checking the whole plan up front is what makes the contract independent of
    operation order; a per-operation check cannot see the second case at all.
    ``motion_fps_of`` resolves a motion id to its npz fps and is injected so
    this stays a pure function over the plan.

    Deliberately ignores the LIVE scene fps: a factory-startup Blender scene is
    already 24 fps, so comparing against it would reject every first
    apply_motion. Resampling key spacing by scene_fps/motion_fps is the other
    possible contract and is deliberately deferred rather than half-done -- it
    would have to move hand_track clip frames, start_frame, contact windows and
    camera cut frames together.

    KNOWN GAP, within-plan only. Ignoring the live fps also means a LATER,
    separate plan that carries an fps and no apply_motion is not checked at all,
    so it can still overwrite an already-baked motion's rate and reproduce the
    same 20%-fast defect split across two stage_scene calls. Closing it needs a
    different signal than the plan -- the baked action already records
    ``cclay.motion_fps`` -- so it is recorded here rather than half-enforced.
    """
    rates: list[tuple[str, int]] = []
    requested = _requested_scene_fps(plan)
    if requested is not None:
        rates.append(("set_render_settings", requested))
    for operation in plan["operations"]:
        if operation["op"] == "apply_motion":
            motion_id = operation["motion_id"]
            rates.append((f"motion {motion_id}", int(motion_fps_of(motion_id))))
    if len({rate for _source, rate in rates}) <= 1:
        return
    # Remediation names only the sources actually in conflict: telling a
    # two-motion conflict to "omit fps from set_render_settings" points the
    # caller at an operation its plan does not even contain.
    remedies = []
    if requested is not None:
        remedies.append("omit fps from set_render_settings")
    # Gate on DISTINCT motion rates, not motion count: two motions that already
    # agree with each other need no advice about sharing a rate, and offering it
    # would point at the wrong thing when the real conflict is the requested fps.
    if len({rate for source, rate in rates if source != "set_render_settings"}) > 1:
        remedies.append("apply only motions that share a frame rate")
    remedies.append("or regenerate the motion at the rate you want")
    detail = ", ".join(f"{source} is {rate} fps" for source, rate in rates)
    raise StageSceneError(
        f"APPLY_MOTION_FPS_CONFLICT: the plan needs one frame rate but {detail}; "
        f"apply_motion bakes one npz frame per scene frame, so "
        f"{', '.join(remedies)}"
    )


def _apply_motion(
    operation: dict,
    transaction: _StageTransaction,
    project_id: str,
    project_directory: object,
):
    scene_object = _require_owned_entity(operation["entity_id"], project_id)
    if scene_object.type != "ARMATURE":
        raise STAGE_SCENE_TARGET_TYPE_INVALID(
            f"entity {operation['entity_id']} must be an CCLAY character armature"
        )
    _require_exclusive_datablocks(scene_object)
    resolved = _resolve_operation_hand_shapes(operation)
    try:
        inventory = hand_shapes.validate_rig_bones(
            scene_object.get("cclay.character_type"),
            (bone.name for bone in scene_object.data.bones),
        )
    except hand_shapes.HandShapeError as error:
        raise StageSceneError(f"APPLY_MOTION_HAND_SHAPE_RIG_UNSUPPORTED: {error}")
    local_rot_mats, posed_joints, fps, _carried = _load_motion_payload(
        project_directory, operation["motion_id"], validate=False
    )
    try:
        validation_cursor = motion_retarget.MotionValidationCursor(
            local_rot_mats, posed_joints, fps
        )
        while not validation_cursor.step(max_frames=64):
            yield "MOTION_PREPARE"
        yield "MOTION_PREPARE"
    except motion_retarget.MotionRetargetError as error:
        raise StageSceneError(f"APPLY_MOTION_MALFORMED: {error}")
    frame_count = len(local_rot_mats)
    # The track is validated against the real clip length, which is only known
    # after the payload loads. A tracked side's resting preset is its LAST key:
    # that is the shape the clip ends in, so the action metadata and the result
    # stay meaningful for a side that changes shape mid-clip.
    try:
        hand_track = _resolve_operation_hand_track(operation, frame_count)
    except hand_shapes.HandShapeError as error:
        raise StageSceneError(f"APPLY_MOTION_HAND_TRACK_INVALID: {error}")
    for side in ("left", "right"):
        if hand_track[side]:
            resolved[side] = hand_track[side][-1][1]

    bones = scene_object.data.bones
    prefix, rig_thigh = _rig_scale_inputs(bones)
    rest_rotations = {}
    for cskel, target in motion_retarget.MIXAMO_TARGETS.items():
        if target is None:
            continue
        bone = bones.get(f"{prefix}{target}")
        if bone is not None:
            rest_rotations[cskel] = [list(row) for row in bone.matrix_local.to_3x3()]
    for required_bone in ("Hips", "RightUpLeg", "RightLeg"):
        if required_bone not in rest_rotations:
            raise STAGE_SCENE_TARGET_TYPE_INVALID(
                f"character rig is missing the {required_bone} bone"
            )
    try:
        scale = motion_retarget.derive_scale(posed_joints[0], rig_thigh)
        track_builder = motion_retarget.PoseTrackBuilder(
            local_rot_mats,
            posed_joints,
            rest_rotations,
            list(bones[f"{prefix}Hips"].head_local),
            scale,
        )
        while not track_builder.step(max_frames=64):
            yield "MOTION_PREPARE"
        tracks = track_builder.tracks
        yield "MOTION_PREPARE"
        yield "OPTIMIZE_OR_DENSE"
    except motion_retarget.MotionRetargetError as error:
        raise StageSceneError(f"APPLY_MOTION_MALFORMED: {error}")

    pose_bones = scene_object.pose.bones
    digit_names = tuple(
        inventory[side][role]
        for side in ("left", "right")
        for role in hand_shapes.CANONICAL_ROLE_ORDER
    )
    authored_bone_names = tuple(
        f"{prefix}{motion_retarget.MIXAMO_TARGETS[cskel]}"
        for cskel in tracks["rotations"]
        if motion_retarget.MIXAMO_TARGETS[cskel] is not None
        and pose_bones.get(f"{prefix}{motion_retarget.MIXAMO_TARGETS[cskel]}") is not None
    )
    captured_names = tuple(dict.fromkeys(
        (*authored_bone_names, f"{prefix}Hips", *digit_names)
    ))
    transaction.capture_animation(scene_object, captured_names)
    transaction.capture_render()

    animation_data = scene_object.animation_data
    if animation_data is None:
        animation_data = scene_object.animation_data_create()
    action = bpy.data.actions.new(name=f"CCLAY Motion {operation['motion_id']}")
    transaction.created_actions.append(action)
    # Hoisted before the metadata block so start_frame can be recorded on the
    # action; the dense-frame math below reuses the same value unchanged.
    start_frame = operation.get("start_frame", 1)
    action["cclay.motion_id"] = operation["motion_id"]
    action["cclay.motion_fps"] = fps
    # Downstream clip-frame conversion (clip_frame = scene_frame - start_frame)
    # reads this from the action instead of re-deriving it from the caller.
    action["cclay.motion_start_frame"] = start_frame
    action["cclay.motion_frames"] = frame_count
    action["cclay.hand_shape_left"] = resolved["left"]
    action["cclay.hand_shape_right"] = resolved["right"]
    action["cclay.hand_shape_library"] = 1
    if "hand_shapes" not in operation and "hand_track" not in operation:
        action["cclay.hand_pose"] = operation.get("hand_pose", "relaxed")
    for side in ("left", "right"):
        if hand_track[side]:
            # Clip-relative keys, recorded verbatim so the bake is auditable
            # without re-deriving it from the curves.
            action[f"cclay.hand_track_{side}"] = json.dumps(
                [{"frame": frame, "preset": preset} for frame, preset in hand_track[side]]
            )

    slot, channelbag = _create_detached_action_topology(action, scene_object.name)
    yield "ACTION_CREATE"
    end_frame = start_frame + frame_count - 1
    dense_frames = [float(start_frame + offset) for offset in range(frame_count)]
    deltas = hand_shapes.preset_deltas(resolved["left"], resolved["right"])
    bone_to_role = {
        name: (side, role)
        for side in ("left", "right")
        for role, name in inventory[side].items()
    }
    authored_roles: set[tuple[str, str]] = set()
    expected: dict[
        tuple[str, int], tuple[str, list[float], list[float]]
    ] = {}
    final_rotations: dict[str, tuple[float, float, float, float]] = {}

    for cskel, quaternions in tracks["rotations"].items():
        target = motion_retarget.MIXAMO_TARGETS[cskel]
        if target is None:
            continue
        bone_name = f"{prefix}{target}"
        pose_bone = pose_bones.get(bone_name)
        if pose_bone is None:
            continue
        role_key = bone_to_role.get(bone_name)
        if role_key is not None:
            authored_roles.add(role_key)
        values = []
        for quaternion in quaternions:
            if role_key is not None:
                quaternion = hand_shapes.compose_quaternions(
                    quaternion, deltas[role_key[0]][role_key[1]]
                )
            values.append(tuple(float(value) for value in quaternion))
        data_path = pose_bone.path_from_id("rotation_quaternion")
        for array_index in range(4):
            component_values = [
                quaternion[array_index] for quaternion in values
            ]
            yield "CURVE_BUILD_READY"
            _bulk_fcurve(
                channelbag,
                data_path,
                array_index,
                bone_name,
                dense_frames,
                component_values,
            )
            expected[(data_path, array_index)] = (
                bone_name, dense_frames, component_values
            )
            yield "CURVE_BUILD"
        final_rotations[bone_name] = values[-1]

    hips_name = f"{prefix}Hips"
    hips = pose_bones[hips_name]
    hips_path = hips.path_from_id("location")
    for array_index in range(3):
        component_values = [
            float(location[array_index]) for location in tracks["hips_locations"]
        ]
        yield "CURVE_BUILD_READY"
        _bulk_fcurve(
            channelbag,
            hips_path,
            array_index,
            hips_name,
            dense_frames,
            component_values,
        )
        expected[(hips_path, array_index)] = (
            hips_name, dense_frames, component_values
        )
        yield "CURVE_BUILD"
    final_hips_location = tuple(float(value) for value in tracks["hips_locations"][-1])

    sparse_frames = [float(start_frame)]
    if end_frame != start_frame:
        sparse_frames.append(float(end_frame))
    # A tracked side keys its own frames per role; an untracked side keeps the
    # clip-wide constant. Clip frames are 0-based, so they offset from
    # start_frame exactly like the dense body curves above.
    tracked_role_keys = {
        side: (
            hand_shapes.track_role_keys(hand_track[side], side)
            if hand_track[side]
            else None
        )
        for side in ("left", "right")
    }
    for side in ("left", "right"):
        role_keys = tracked_role_keys[side]
        for role in hand_shapes.CANONICAL_ROLE_ORDER:
            if (side, role) in authored_roles:
                continue
            bone_name = inventory[side][role]
            pose_bone = pose_bones[bone_name]
            if role_keys is None:
                delta = tuple(float(value) for value in deltas[side][role])
                final_rotations[bone_name] = delta
                if all(
                    abs(value - identity) <= 1e-12
                    for value, identity in zip(delta, (1.0, 0.0, 0.0, 0.0))
                ):
                    continue
                role_frames = sparse_frames
                role_values = [delta] * len(sparse_frames)
            else:
                keys = role_keys.get(role)
                # The resting delta is the track's last key, which
                # track_role_keys drops only when the role never leaves
                # identity — so identity is the correct final rotation there.
                resting = hand_shapes.preset_deltas(**{side: hand_track[side][-1][1]})[side][role]
                final_rotations[bone_name] = tuple(float(value) for value in resting)
                if keys is None:
                    continue
                role_frames = [float(start_frame + frame) for frame, _ in keys]
                role_values = [
                    tuple(float(value) for value in delta) for _, delta in keys
                ]
            data_path = pose_bone.path_from_id("rotation_quaternion")
            for array_index in range(4):
                component_values = [value[array_index] for value in role_values]
                yield "CURVE_BUILD_READY"
                _bulk_fcurve(
                    channelbag,
                    data_path,
                    array_index,
                    bone_name,
                    role_frames,
                    component_values,
                )
                expected[(data_path, array_index)] = (
                    bone_name, role_frames, component_values
                )
                yield "CURVE_BUILD"

    _validate_detached_curves(action, slot, channelbag, expected)
    yield "DETACHED_VALIDATE"

    # The detached action is complete and validated before either binding write.
    animation_data.action = action
    try:
        animation_data.action_slot = slot
    except (AttributeError, RuntimeError, TypeError) as error:
        raise StageSceneError(
            "APPLY_MOTION_ACTION_TOPOLOGY_UNSUPPORTED: action slot cannot be bound"
        ) from error
    from .manifest import animation_fcurves

    bound_curves = animation_fcurves(animation_data)
    if {
        (fcurve.data_path, fcurve.array_index): len(fcurve.keyframe_points)
        for fcurve in bound_curves
    } != {key: len(value[1]) for key, value in expected.items()}:
        raise StageSceneError(
            "APPLY_MOTION_CURVE_INVALID: bound slot does not enumerate detached curves"
        )

    for bone_name, quaternion in final_rotations.items():
        pose_bone = pose_bones[bone_name]
        pose_bone.rotation_mode = "QUATERNION"
        pose_bone.rotation_quaternion = quaternion
    hips.location = final_hips_location

    # Timing contract: the baked keys are at the motion's native fps, so the
    # scene rate follows the motion (rollback restores it via render_state).
    scene = bpy.context.scene
    scene.render.fps = fps
    scene.render.fps_base = 1.0
    if scene.frame_end < end_frame:
        scene.frame_end = end_frame
    bpy.context.view_layer.update()
    result = {
        "entity_id": operation["entity_id"],
        "motion_id": operation["motion_id"],
        "left": resolved["left"],
        "right": resolved["right"],
        "library_version": hand_shapes.LIBRARY_VERSION,
    }
    # Only present for a tracked request: QA must be able to check the keys that
    # were actually baked, and left/right above only carry the resting shape.
    for side in ("left", "right"):
        if hand_track[side]:
            result.setdefault("track", {})[side] = [
                {"frame": frame, "preset": preset} for frame, preset in hand_track[side]
            ]
    return result


def _live_base_manifest(current_scene_hash: str) -> dict:
    from .manifest import (
        extract_scene_manifest_v2,
        extract_scene_manifest_v3,
        extract_scene_manifest_v4,
    )

    v2 = extract_scene_manifest_v2()
    if v2["sceneHash"] == current_scene_hash:
        return v2
    v3 = extract_scene_manifest_v3()
    if v3["sceneHash"] == current_scene_hash:
        return v3
    v4 = extract_scene_manifest_v4()
    if v4["sceneHash"] == current_scene_hash:
        return v4
    raise StageSceneError(
        "STALE_BASE: live main-thread manifest hash differs from the durable expected base"
    )


_ADAPTIVE_QUALIFIED = False
_SLICE_SECONDS = 0.025
_MAX_PRIMITIVE_SECONDS = 0.250
_REASON_KEYS = (
    "ENDPOINT", "DISCONTINUITY", "CONTACT_ENTER", "CONTACT_EXIT", "IMPACT",
    "FALL_ENTER", "FALL_MINIMUM", "EXTREMUM_SPEED",
    "EXTREMUM_VERTICAL_VELOCITY", "EXTREMUM_VERTICAL_ACCELERATION",
    "STILL_BOUNDARY", "GUARD",
)


def _current_rss_bytes(*, required: bool = False) -> int:
    """Return current resident bytes, using Mach task_info on Darwin."""
    if platform.system() == "Darwin":
        class MachTaskBasicInfo(ctypes.Structure):
            _fields_ = [
                ("virtual_size", ctypes.c_uint64),
                ("resident_size", ctypes.c_uint64),
                ("resident_size_max", ctypes.c_uint64),
                ("user_time_seconds", ctypes.c_int32),
                ("user_time_microseconds", ctypes.c_int32),
                ("system_time_seconds", ctypes.c_int32),
                ("system_time_microseconds", ctypes.c_int32),
                ("policy", ctypes.c_int32),
                ("suspend_count", ctypes.c_int32),
            ]
        try:
            libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
            info = MachTaskBasicInfo()
            count = ctypes.c_uint32(
                ctypes.sizeof(MachTaskBasicInfo) // ctypes.sizeof(ctypes.c_uint32)
            )
            result = libc.task_info(
                libc.mach_task_self(),
                20,
                ctypes.byref(info),
                ctypes.byref(count),
            )
            if result != 0 or info.resident_size <= 0:
                raise OSError(f"task_info returned {result}")
            return int(info.resident_size)
        except (AttributeError, OSError, TypeError, ValueError) as error:
            if required:
                raise StageSceneError("STAGE_SCENE_RSS_UNAVAILABLE") from error
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(usage * (1 if sys.platform == "darwin" else 1024))


def _motion_keyframe_mode() -> str:
    mode = os.environ.get("CCLAY_MOTION_KEYFRAME_MODE", "bulk_dense")
    if mode != "bulk_dense":
        if mode == "qualified_adaptive" and _ADAPTIVE_QUALIFIED:
            return mode
        raise StageSceneError("MOTION_KEYFRAME_MODE_DISABLED")
    return mode

def _check_abort(deadline: float | None, cancelled: Callable[[], bool]) -> None:
    if cancelled():
        raise STAGE_SCENE_CANCELLED("stage_scene was cancelled")
    if deadline is not None and time.monotonic() >= deadline:
        raise STAGE_SCENE_DEADLINE_EXCEEDED("stage_scene deadline elapsed")

def _watch_pace_ms() -> int:
    """Visual watch-mode pacing per applied operation, in milliseconds.

    Purely presentational: paces viewport redraws while a plan is applied so
    the scene builds up visibly. The durable commit stays atomic - a crash
    mid-application rolls back to the base revision exactly as before.
    Disabled headless, host-side, and unless CCLAY_WATCH_MS is set (the cclay
    launcher sets it for interactive sessions; tests run unpaced).
    """
    if bpy is None or bpy.app.background:
        return 0
    try:
        value = int(os.environ.get("CCLAY_WATCH_MS", "0"))
    except ValueError:
        return 0
    return min(max(value, 0), 1000)


def _watch_step() -> None:
    pace = _watch_pace_ms()
    if pace == 0:
        return
    try:
        bpy.context.view_layer.update()
        bpy.ops.wm.redraw_timer(type="DRAW_WIN_SWAP", iterations=1)
    except Exception:
        return
    time.sleep(pace / 1000.0)



class _StageSceneRun:
    """Single retained owner and execution path for staged scene transactions."""

    def __init__(
        self,
        plan_value: object,
        current_scene_hash: str,
        connection: object,
        commit_fn: Callable[[dict], object],
        *,
        result_fn: Callable[[dict | None, BaseException | None], None] | None = None,
        cancelled: Callable[[], bool] = lambda: False,
        deadline: float | None = None,
        scheduled: bool = False,
    ):
        self.plan_value = plan_value
        self.current_scene_hash = current_scene_hash
        self.connection = connection
        self.commit_fn = commit_fn
        self.result_fn = result_fn
        self.cancelled = cancelled
        self.deadline = deadline
        self.scheduled = scheduled
        self.phase = "NEW"
        self.operation_index = 0
        self.motion_cursor = None
        self.candidate_manifest = None
        self.result = None
        self.error = None
        self.plan = None
        self.before_manifest = None
        self.scene = None
        self.project_id = None
        self.transaction = None
        self.checkpoint = None
        self.mode = None
        self.uses_v4 = False
        self.applied_hand_shapes = []
        self.recovery_direction = "ROLLBACK"
        self.callback_done = False
        self.log_done = False
        self.done = False
        self.started_at = time.monotonic()
        self.slice_started_at = self.started_at
        self.last_step_at = self.started_at
        self.max_scheduled_step_ms = 0.0
        self.max_heartbeat_gap_ms = 0.0
        self.longest_rna_call_ms = 0.0
        self.commit_call_ms = 0.0
        self.rss_baseline = 0
        self.rss_high_water = 0
        self.motion_count = 0
        self.completed_motion_count = 0
        self.source_frames = 0
        self.source_points = 0
        self.curves = 0
        self.timings = {
            "prepare": 0.0, "optimize": 0.0, "write": 0.0, "bind": 0.0,
        }

    def _check_before_primitive(self) -> bool:
        _check_abort(self.deadline, self.cancelled)
        return not (
            self.scheduled
            and time.monotonic() - self.slice_started_at >= _SLICE_SECONDS
        )

    def _measure(self, function: Callable[[], object], *, commit: bool = False):
        if not self._check_before_primitive():
            return False, None
        started = time.monotonic()
        caught = None
        value = None
        try:
            value = function()
        except BaseException as error:
            caught = error
        elapsed_ms = (time.monotonic() - started) * 1000.0
        self.longest_rna_call_ms = max(self.longest_rna_call_ms, elapsed_ms)
        if commit:
            self.commit_call_ms = elapsed_ms
        self._sample_rss()
        if elapsed_ms >= _MAX_PRIMITIVE_SECONDS * 1000.0:
            raise StageSceneError(
                "STAGE_SCENE_UNINTERRUPTIBLE_CALL_LIMIT"
            ) from caught
        if caught is not None:
            raise caught
        return True, value

    def _measure_recovery(self, function: Callable[[], object]):
        """Measure mandatory recovery without allowing cancellation to suppress it."""
        started = time.monotonic()
        try:
            return function()
        finally:
            elapsed_ms = (time.monotonic() - started) * 1000.0
            self.longest_rna_call_ms = max(self.longest_rna_call_ms, elapsed_ms)
            self._sample_terminal_rss()

    def _sample_rss(self, *, enforce_limit: bool = True) -> None:
        rss = _current_rss_bytes()
        if self.rss_baseline == 0:
            self.rss_baseline = rss
        self.rss_high_water = max(self.rss_high_water, rss)
        if (
            enforce_limit
            and self.rss_high_water - self.rss_baseline > 512 * 1024 * 1024
        ):
            raise StageSceneError("STAGE_SCENE_RSS_LIMIT_EXCEEDED")

    def _sample_terminal_rss(self) -> None:
        """Best-effort terminal sample that cannot suppress disposition reporting."""
        try:
            self._sample_rss(enforce_limit=False)
        except BaseException:
            pass

    def _account_terminal_step(self) -> None:
        started = getattr(self, "_active_step_started", None)
        if started is not None:
            self.max_scheduled_step_ms = max(
                self.max_scheduled_step_ms,
                (time.monotonic() - started) * 1000.0,
            )

    def _recover(self) -> bool:
        if self.recovery_direction == "FORWARD":
            self.transaction.finalize_deletions()
            self.transaction.finalize_orphan_actions()
            if self.candidate_manifest is None:
                return False
            return (
                _live_base_manifest(self.candidate_manifest["sceneHash"])["sceneHash"]
                == self.candidate_manifest["sceneHash"]
            )
        self.transaction.rollback()
        return (
            _live_base_manifest(self.before_manifest["sceneHash"])["sceneHash"]
            == self.before_manifest["sceneHash"]
        )

    def _apply_operation(self, operation: dict):
        op = operation["op"]
        arguments = (operation, self.transaction, self.project_id)
        if op == "add_primitive":
            return _create_primitive(*arguments)
        if op == "add_character":
            return _create_character(*arguments)
        if op == "add_camera":
            return _create_camera(*arguments)
        if op == "create_assembly":
            return _create_assembly(*arguments)
        if op == "set_parent":
            return _set_parent(*arguments)
        if op == "transform_assembly":
            return _transform_assembly(*arguments)
        if op == "set_material_color":
            return _set_material_color(*arguments)
        if op == "upsert_area_light":
            return _upsert_area_light(*arguments)
        if op == "adopt_entity":
            return _adopt_entity(*arguments)
        if op == "transform_entity":
            return _transform_entity(*arguments)
        if op == "set_light_property":
            return _set_light_property(*arguments)
        if op == "set_camera_property":
            return _set_camera_property(*arguments)
        if op == "set_render_settings":
            return _set_render_settings(*arguments)
        if op == "rename_entity":
            return _rename_entity(*arguments)
        # apply_motion is deliberately absent: OP_DISPATCH routes it to
        # MOTION_PREPARE so it runs as an amortized cursor, never through here.
        # Keeping a second call site meant two places had to learn every new
        # apply_motion argument, and only one of them was ever executed.
        scene_object = _require_owned_entity(operation["entity_id"], self.project_id)
        _require_exclusive_datablocks(scene_object)
        return self.transaction.quarantine(scene_object)

    def _record_completed_motion(self) -> None:
        action = self.transaction.created_actions[-1]
        frames = int(action["cclay.motion_frames"])
        from .manifest import animation_fcurves
        bound_object = next(
            scene_object
            for scene_object in self.transaction.animation_states
            if scene_object.animation_data is not None
            and scene_object.animation_data.action is action
        )
        curves = list(animation_fcurves(bound_object.animation_data))
        self.completed_motion_count += 1
        self.source_frames += frames
        self.source_points += sum(len(curve.keyframe_points) for curve in curves)
        self.curves += len(curves)

    def _build_result(self) -> None:
        objects_by_id = {
            scene_object["entityId"]: scene_object
            for scene_object in self.candidate_manifest["objects"]
        }
        entity_identities = [
            {
                "entity_id": operation["entity_id"],
                "requested_name": operation["name"],
                "actual_name": objects_by_id[operation["entity_id"]]["name"],
            }
            for operation in self.plan["operations"]
            if operation["op"] in (
                "add_primitive", "upsert_area_light", "add_character", "add_camera",
            )
        ]
        self.result = {
            "expected_revision_id": self.plan["expected_revision_id"],
            "scene_hash": self.candidate_manifest["sceneHash"],
            "manifest": self.candidate_manifest,
            "entity_identities": entity_identities,
            "applied_hand_shapes": self.applied_hand_shapes,
        }

    def _error_code(self) -> str | None:
        if self.error is None:
            return None
        if isinstance(self.error, STAGE_SCENE_CANCELLED):
            return "CANCELLED"
        if isinstance(self.error, STAGE_SCENE_DEADLINE_EXCEEDED):
            return "DEADLINE_EXCEEDED"
        text = str(self.error)
        for code in (
            "MOTION_KEYFRAME_MODE_DISABLED", "STAGE_SCENE_RSS_UNAVAILABLE",
            "STAGE_SCENE_RSS_LIMIT_EXCEEDED",
            "STAGE_SCENE_UNINTERRUPTIBLE_CALL_LIMIT",
        ):
            if text.startswith(code):
                return code
        return "STAGE_SCENE_FAILED"

    def _emit_log(self, outcome: str) -> None:
        if self.log_done:
            return
        self.log_done = True
        total_ms = (time.monotonic() - self.started_at) * 1000.0
        record = {
            "schema": "cclay.stage_scene_motion.v2",
            "report_version": 2,
            "qualification_version": "ardy-adaptive-v1",
            "outcome": outcome,
            "terminal_phase": self.phase,
            "error_code": self._error_code(),
            "mode": self.mode or "bulk_dense",
            "effective_mode": "bulk_dense",
            "action_api": "LAYERED_SLOT",
            "motion_count": self.motion_count,
            "completed_motion_count": self.completed_motion_count,
            "dense_motion_count": self.completed_motion_count,
            "optimized_motion_count": 0,
            "fallback_motion_count": 0,
            "source_frames": min(self.source_frames, 6_144_000),
            "source_points": min(self.source_points, 608_256_000),
            "kept_points": min(self.source_points, 608_256_000),
            "curve_count": min(self.curves, 66_304),
            "protected_reason_counts": {key: 0 for key in _REASON_KEYS},
            "max_rotation_error_microdegrees": None,
            "max_hips_error_micrometers": None,
            "timings_ms": {
                **self.timings,
                "commit": self.commit_call_ms if self.commit_call_ms else None,
                "total": total_ms,
            },
            "rss_delta_bytes": max(0, self.rss_high_water - self.rss_baseline),
            "longest_uninterruptible_call_ms": max(
                self.longest_rna_call_ms, self.commit_call_ms
            ),
            "max_scheduled_step_ms": self.max_scheduled_step_ms,
            "max_heartbeat_gap_ms": self.max_heartbeat_gap_ms,
            "cancellation_latency_ms": (
                max(25.0, self.longest_rna_call_ms)
                if self._error_code() == "CANCELLED" else None
            ),
        }
        payload = json.dumps(record, sort_keys=True, separators=(",", ":"))
        if len(payload.encode("utf-8")) > 4096:
            return
        try:
            logging.getLogger("cclay.motion_keyframes").info(payload)
        except BaseException:
            pass

    def _callback(self) -> None:
        if self.result_fn is None or self.callback_done:
            return
        self.callback_done = True
        try:
            self.result_fn(
                self.result if self.error is None else None,
                self.error,
            )
        except BaseException:
            pass

    def _finish_success(self) -> None:
        self.phase = "SUCCEEDED"
        self.done = True
        self._sample_terminal_rss()
        self._account_terminal_step()
        self._emit_log("SUCCESS")
        self._callback()

    def _finish_error(self, error: BaseException) -> None:
        from .connection import DurableCommitReconciliationRequired
        self.error = error
        _stage_log(
            self.connection,
            "stage_finish_error",
            phase=self.phase,
            recovery_direction=self.recovery_direction,
            error=repr(error),
            stack="".join(traceback.format_exception(type(error), error, error.__traceback__, limit=12)),
        )
        if self.checkpoint is None:
            self.phase = "PRE_CHECKPOINT"
            outcome = "ERROR_NO_MUTATION"
        elif self.recovery_direction == "FORWARD":
            self.phase = "RECONCILIATION_REQUIRED"
            self.connection.require_recovery()
            if not isinstance(error, DurableCommitReconciliationRequired):
                self.error = DurableCommitReconciliationRequired(
                    "stage_scene durable commit requires forward reconciliation"
                )
            outcome = "ERROR_RECONCILIATION_REQUIRED"
        else:
            try:
                self._measure_recovery(self.transaction.rollback)
                recovered = (
                    _live_base_manifest(self.before_manifest["sceneHash"])["sceneHash"]
                    == self.before_manifest["sceneHash"]
                )
                if not recovered:
                    raise StageSceneError("stage_scene rollback verification failed")
                try:
                    self._measure_recovery(self.connection.release_checkpoint)
                except BaseException:
                    active = getattr(self.connection, "active_checkpoint", self.checkpoint)
                    if active is not None:
                        raise
                self.phase = "ERROR"
                outcome = "ERROR_ROLLED_BACK"
            except BaseException as recovery_error:
                _stage_log(
                    self.connection,
                    "stage_rollback_failed",
                    phase=self.phase,
                    error=repr(error),
                    recovery_error=repr(recovery_error),
                    recovery_stack="".join(
                        traceback.format_exception(
                            type(recovery_error),
                            recovery_error,
                            recovery_error.__traceback__,
                            limit=12,
                        )
                    ),
                )
                self.connection.require_recovery()
                self.phase = "RECONCILIATION_REQUIRED"
                self.error = DurableCommitReconciliationRequired(
                    "stage_scene rollback failed and requires recovery"
                )
                self.error.__cause__ = recovery_error
                outcome = "ERROR_RECONCILIATION_REQUIRED"
        self.done = True
        self._sample_terminal_rss()
        self._account_terminal_step()
        self._emit_log(outcome)
        self._callback()

    def step(self):
        """Run at most one measured primitive and retain all continuation state."""
        if self.done:
            return None
        step_started = time.monotonic()
        self._active_step_started = step_started
        self.max_heartbeat_gap_ms = max(
            self.max_heartbeat_gap_ms,
            (step_started - self.last_step_at) * 1000.0,
        )
        self.slice_started_at = step_started
        try:
            from .checkpoint import create_checkpoint
            from .connection import DurableCommitReconciliationRequired
            from .manifest import extract_scene_manifest_v3, extract_scene_manifest_v4
            from .scene_manifest import finalize_scene_manifest_child

            if self.phase == "NEW":
                if bpy is None:
                    raise StageSceneError("stage_scene requires Blender")
                self.plan = parse_stage_scene_plan(self.plan_value)
                self.motion_count = sum(
                    operation["op"] == "apply_motion"
                    for operation in self.plan["operations"]
                )
                # Up front, before any mutation: one frame rate for the whole
                # plan. Order-independent by construction, which a check inside
                # apply_motion could not be -- it would never see a second
                # motion whose native fps differs.
                if self.motion_count:
                    _require_plan_fps_agrees(
                        self.plan,
                        lambda motion_id: _motion_fps(
                            getattr(self.connection, "project_directory", None),
                            motion_id,
                        ),
                    )
                try:
                    self.mode = _motion_keyframe_mode()
                except StageSceneError:
                    self.mode = "invalid"
                    raise
                self.uses_v4 = any(
                    operation["op"] in (
                        "create_assembly", "set_parent", "transform_assembly"
                    )
                    or (
                        operation["op"] == "add_primitive"
                        and operation.get("parent_id") is not None
                    )
                    for operation in self.plan["operations"]
                )
                self.before_manifest = _live_base_manifest(self.current_scene_hash)
                _check_abort(self.deadline, self.cancelled)
                self.scene = bpy.context.scene
                self.project_id = self.scene.get("cclay.project_id")
                if not isinstance(self.project_id, str):
                    raise StageSceneError("scene is missing cclay.project_id")
                gc.collect()
                self.rss_baseline = _current_rss_bytes(required=True)
                self.rss_high_water = self.rss_baseline
                self.transaction = _StageTransaction(self.scene)
                self.phase = "CHECKPOINT_CREATE"
            elif self.phase == "CHECKPOINT_CREATE":
                executed, checkpoint = self._measure(lambda: create_checkpoint({
                    "stage_scene_scope": {
                        "scene_hash": self.before_manifest["sceneHash"]
                    }
                }))
                if executed:
                    self.checkpoint = checkpoint
                    self.phase = "CHECKPOINTED"
            elif self.phase == "CHECKPOINTED":
                executed, _ = self._measure(
                    lambda: self.connection.hold_checkpoint(
                        self.checkpoint, self._recover
                    )
                )
                if executed:
                    self.phase = "AFTER_CHECKPOINT_CONNECTION"
            elif self.phase == "AFTER_CHECKPOINT_CONNECTION":
                executed, _ = self._measure(
                    lambda: self.connection.ensure_mutation_connection(
                        "after_checkpoint"
                    )
                )
                if executed:
                    self.phase = "OP_DISPATCH"
            elif self.phase == "OP_DISPATCH":
                if self.operation_index >= len(self.plan["operations"]):
                    self.phase = "FINAL_MANIFEST"
                else:
                    operation = self.plan["operations"][self.operation_index]
                    self.phase = (
                        "MOTION_PREPARE"
                        if operation["op"] == "apply_motion"
                        else "OTHER_OPERATION"
                    )
            elif self.phase == "OTHER_OPERATION":
                operation = self.plan["operations"][self.operation_index]
                executed, _ = self._measure(
                    lambda: self._apply_operation(operation)
                )
                if executed:
                    self.phase = "NEXT_OPERATION"
            elif self.phase in (
                "MOTION_PREPARE", "OPTIMIZE_OR_DENSE", "ACTION_CREATE",
                "CURVE_BUILD_READY", "CURVE_BUILD", "DETACHED_VALIDATE",
            ):
                operation = self.plan["operations"][self.operation_index]
                if self.motion_cursor is None:
                    self.motion_cursor = _apply_motion(
                        operation,
                        self.transaction,
                        self.project_id,
                        getattr(self.connection, "project_directory", None),
                    )
                started = time.monotonic()
                try:
                    executed, motion_phase = self._measure(
                        lambda: next(self.motion_cursor)
                    )
                except StopIteration as completed:
                    elapsed_ms = (time.monotonic() - started) * 1000.0
                    self.timings["bind"] += elapsed_ms
                    applied = completed.value
                    self.applied_hand_shapes.append({
                        "operation_index": self.operation_index,
                        **applied,
                    })
                    self._record_completed_motion()
                    self.motion_cursor = None
                    self.phase = "ATOMIC_BIND"
                else:
                    if executed:
                        elapsed_ms = (time.monotonic() - started) * 1000.0
                        if motion_phase == "MOTION_PREPARE":
                            self.timings["prepare"] += elapsed_ms
                        elif motion_phase == "OPTIMIZE_OR_DENSE":
                            self.timings["optimize"] += elapsed_ms
                        elif motion_phase in ("CURVE_BUILD_READY", "CURVE_BUILD"):
                            self.timings["write"] += elapsed_ms
                        elif motion_phase == "DETACHED_VALIDATE":
                            self.timings["write"] += elapsed_ms
                        self.phase = motion_phase
            elif self.phase == "ATOMIC_BIND":
                self.completed_motion_count = len(self.applied_hand_shapes)
                self.phase = "NEXT_OPERATION"
            elif self.phase == "NEXT_OPERATION":
                operation = self.plan["operations"][self.operation_index]
                executed, _ = self._measure(
                    lambda: self.connection.ensure_mutation_connection(
                        operation["op"]
                    )
                )
                if executed:
                    self.phase = "WATCH_STEP"
            elif self.phase == "WATCH_STEP":
                executed, _ = self._measure(_watch_step)
                if executed:
                    self.operation_index += 1
                    self.phase = "OP_DISPATCH"
            elif self.phase == "FINAL_MANIFEST":
                executed, extracted = self._measure(
                    extract_scene_manifest_v4
                    if self.uses_v4 else extract_scene_manifest_v3
                )
                if executed:
                    self.candidate_manifest = finalize_scene_manifest_child(
                        extracted,
                        self.plan["expected_revision_id"],
                        self.plan,
                    )
                    self._build_result()
                    self.phase = "DURABLE_COMMIT"
            elif self.phase == "DURABLE_COMMIT":
                try:
                    executed, _ = self._measure(
                        lambda: self.commit_fn(self.result), commit=True
                    )
                except DurableCommitReconciliationRequired:
                    self.recovery_direction = "FORWARD"
                    self.connection.require_recovery()
                    raise
                if executed:
                    self.recovery_direction = "FORWARD"
                    self.phase = "POST_COMMIT_FINALIZE"
            elif self.phase == "POST_COMMIT_FINALIZE":
                executed, _ = self._measure(self.transaction.finalize_deletions)
                if executed:
                    self.phase = "POST_COMMIT_ACTION_FINALIZE"
            elif self.phase == "POST_COMMIT_ACTION_FINALIZE":
                executed, _ = self._measure(self.transaction.finalize_orphan_actions)
                if executed:
                    self.phase = "POST_COMMIT_VERIFY"
            elif self.phase == "POST_COMMIT_VERIFY":
                executed, live_manifest = self._measure(
                    lambda: _live_base_manifest(
                        self.candidate_manifest["sceneHash"]
                    )
                )
                if executed:
                    if live_manifest["sceneHash"] != self.candidate_manifest["sceneHash"]:
                        raise StageSceneError(
                            "STAGE_SCENE_COMMITTED_HASH_MISMATCH"
                        )
                    self.phase = "CHECKPOINT_RELEASE"
            elif self.phase == "CHECKPOINT_RELEASE":
                try:
                    executed, _ = self._measure(self.connection.release_checkpoint)
                except BaseException:
                    active = getattr(
                        self.connection, "active_checkpoint", self.checkpoint
                    )
                    released_hash_verified = False
                    if active is None:
                        released_manifest = self._measure_recovery(
                            lambda: _live_base_manifest(
                                self.candidate_manifest["sceneHash"]
                            )
                        )
                        released_hash_verified = (
                            released_manifest["sceneHash"]
                            == self.candidate_manifest["sceneHash"]
                        )
                    if active is None and released_hash_verified:
                        self._finish_success()
                    else:
                        raise
                else:
                    if executed:
                        self._finish_success()
            else:
                raise StageSceneError("STAGE_SCENE_INVALID_RUN_PHASE")
        except BaseException as error:
            self._finish_error(error)
        elapsed_ms = (time.monotonic() - step_started) * 1000.0
        self.max_scheduled_step_ms = max(self.max_scheduled_step_ms, elapsed_ms)
        self.last_step_at = time.monotonic()
        return None if self.done else 0.0


def apply_stage_scene_transaction(
    plan_value: object,
    current_scene_hash: str,
    connection: object,
    commit_fn: Callable[[dict], object],
    *,
    cancelled: Callable[[], bool] = lambda: False,
    deadline: float | None = None,
) -> dict:
    """Drive the retained transaction run synchronously to its terminal state."""
    run = _StageSceneRun(
        plan_value,
        current_scene_hash,
        connection,
        commit_fn,
        cancelled=cancelled,
        deadline=deadline,
    )
    while not run.done:
        run.step()
    if run.error is not None:
        raise run.error
    return run.result


def schedule_stage_scene_transaction(
    plan_value: object,
    current_scene_hash: str,
    connection: object,
    commit_fn: Callable[[dict], object],
    result_fn: Callable[[dict | None, BaseException | None], None],
    *,
    cancelled: Callable[[], bool] = lambda: False,
    deadline: float | None = None,
) -> None:
    """Register and resume one retained main-thread transaction run."""
    run = _StageSceneRun(
        plan_value,
        current_scene_hash,
        connection,
        commit_fn,
        result_fn=result_fn,
        cancelled=cancelled,
        deadline=deadline,
        scheduled=True,
    )
    try:
        bpy.app.timers.register(run.step, first_interval=0.0)
    except BaseException as error:
        run._finish_error(error)
