"""Closed StageScenePlanV1 validation and transactional Blender mutation."""

from __future__ import annotations

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
import traceback
import unicodedata
from collections.abc import Callable
from pathlib import Path

from . import hand_shapes, motion_archive, motion_preflight, motion_retarget
from .character_rig import CharacterRigAdapter


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
_PLAN_KEYS = {"schema_version", "expected_revision_id", "operations"}
_OPERATION_KEYS = {
    "add_character": {
        "op", "entity_id", "character_type", "name", "location", "rotation", "scale",
    },
    "adopt_entity": {"op", "entity_id"},
    "set_render_settings": {
        "op", "resolution_x", "resolution_y", "resolution_percentage",
        "fps", "frame_start", "frame_end",
    },
    "apply_motion": {
        "op", "entity_id", "motion_id", "hand_pose", "hand_shapes", "hand_track",
        "start_frame",
    },
}
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


class STAGE_SCENE_SHARED_DATABLOCK(StageSceneError):
    code = "STAGE_SCENE_SHARED_DATABLOCK"
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
        operation = dict(raw_operation)
        if operation_kind == "apply_motion":
            hand_fields = [
                field for field in ("hand_pose", "hand_shapes", "hand_track")
                if field in operation
            ]
            if len(hand_fields) > 1:
                _invalid(f"operations[{index}].{' and '.join(hand_fields)} are mutually exclusive")
            for optional_field in ("hand_pose", "hand_shapes", "hand_track", "start_frame"):
                if optional_field not in operation:
                    expected_keys = expected_keys - {optional_field}
        elif operation_kind == "set_render_settings":
            if not set(operation) <= expected_keys:
                _invalid(f"operations[{index}] must contain 'op' and only optional render setting fields")
            expected_keys = set(operation)
        operation = _exact(operation, expected_keys, f"operations[{index}]")
        if operation_kind == "set_render_settings":
            for field, (minimum, maximum) in _RENDER_SETTING_BOUNDS.items():
                if field in operation:
                    _integer(operation[field], f"operations[{index}].{field}", minimum=minimum, maximum=maximum)
            continue
        entity_id = _uuid(operation.get("entity_id"), f"operations[{index}].entity_id")
        if operation_kind == "add_character":
            if operation.get("character_type") not in _CHARACTERS:
                _invalid(f"operations[{index}].character_type is unsupported")
            _name(operation.get("name"), f"operations[{index}].name")
            _vector(operation.get("location"), 3, f"operations[{index}].location")
            _vector(operation.get("rotation"), 3, f"operations[{index}].rotation")
            _vector(operation.get("scale"), 3, f"operations[{index}].scale", positive=True)
            if entity_id in created_ids:
                raise StageSceneValidationError("STAGE_SCENE_ENTITY_ID_DUPLICATE", f"entity_id {entity_id} is created more than once")
            created_ids.add(entity_id)
            stable_name = operation["name"]
            if stable_name in stable_names:
                raise StageSceneValidationError("STAGE_SCENE_STABLE_NAME_DUPLICATE", f"stable name {stable_name!r} is repeated")
            stable_names.add(stable_name)
        elif operation_kind == "apply_motion":
            try:
                motion_archive.validate_motion_id(operation.get("motion_id"))
            except motion_archive.MotionArchiveError:
                _invalid(f"operations[{index}].motion_id must be a lowercase [a-z0-9-] slug of at most 64 characters")
            if "hand_pose" in operation and operation["hand_pose"] not in _HAND_POSES:
                _invalid(f"operations[{index}].hand_pose is unsupported")
            if "hand_shapes" in operation:
                requested = operation["hand_shapes"]
                if not isinstance(requested, dict) or not requested or not set(requested) <= {"left", "right"}:
                    _invalid(f"operations[{index}].hand_shapes must contain exactly left, right, or both")
                for side in requested:
                    if requested[side] not in hand_shapes.PRESET_NAMES:
                        _invalid(f"operations[{index}].hand_shapes.{side} is unsupported")
            if "hand_track" in operation:
                requested = operation["hand_track"]
                if not isinstance(requested, dict) or not requested or not set(requested) <= {"left", "right"}:
                    _invalid(f"operations[{index}].hand_track must contain exactly left, right, or both")
                for side, keys in requested.items():
                    if not isinstance(keys, list) or not keys or len(keys) > hand_shapes.MAX_HAND_TRACK_KEYS:
                        _invalid(f"operations[{index}].hand_track.{side} must be a non-empty bounded list of keys")
                    for key_index, key in enumerate(keys):
                        if not isinstance(key, dict) or set(key) != {"frame", "preset"}:
                            _invalid(f"operations[{index}].hand_track.{side}[{key_index}] must contain exactly frame and preset")
                        if not isinstance(key["frame"], int) or isinstance(key["frame"], bool) or key["frame"] < 0:
                            _invalid(f"operations[{index}].hand_track.{side}[{key_index}].frame must be a non-negative integer")
                        if key["preset"] not in hand_shapes.PRESET_NAMES:
                            _invalid(f"operations[{index}].hand_track.{side}[{key_index}].preset is unsupported")
            if "start_frame" in operation:
                _integer(operation["start_frame"], f"operations[{index}].start_frame", minimum=-100000, maximum=100000)
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


def _owned(scene_object: object, project_id: str) -> bool:
    return scene_object.get("cclay.owned_project_id") == project_id

_MIGRATION_VERSION = 1


def _is_foreign_object(scene_object: object, project_id: str) -> bool:
    """True when an object is absent from, or owned outside, this project."""
    return scene_object.get("cclay.owned_project_id") != project_id


def _scene_collection_objects(collection: object):
    """Yield each object in a scene-linked collection hierarchy once."""
    seen_collections: set[object] = set()
    seen_objects: set[object] = set()

    def visit(current: object):
        if current in seen_collections:
            return
        seen_collections.add(current)
        for scene_object in current.objects:
            if scene_object not in seen_objects:
                seen_objects.add(scene_object)
                yield scene_object
        for child in current.children:
            yield from visit(child)

    yield from visit(collection)

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
        # Pre-existing foreign objects stamped with cclay.owned_project_id by
        # adopt_entity during this transaction; rollback removes the stamp.
        self.adopted_objects: list[object] = []
        self.render_state: dict | None = None
        # Object -> previously assigned action (or None); actions created by
        # apply_motion during this transaction. Rollback restores the old
        # action reference and removes now-orphaned created actions.
        self.animation_states: dict[object, dict] = {}
        self.created_actions: list[object] = []
        self.custom_property_states: dict[tuple[object, str], object] = {}
        self._missing_custom_property = object()
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

    def capture_custom_property(self, target: object, key: str) -> None:
        property_key = (target, key)
        if property_key in self.custom_property_states:
            return
        self.custom_property_states[property_key] = (
            target[key] if key in target else self._missing_custom_property
        )


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

    def rollback(self) -> None:
        for (target, key), value in self.custom_property_states.items():
            if value is self._missing_custom_property:
                if key in target:
                    del target[key]
            else:
                target[key] = value
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


def _migrate_foreign_objects(scene: object, transaction: _StageTransaction, project_id: str) -> None:
    """Lock pre-existing foreign objects and record the completed scene migration."""
    version = scene.get("cclay.migration_version")
    if type(version) is int and version >= _MIGRATION_VERSION:
        return
    for scene_object in _scene_collection_objects(scene.collection):
        if scene_object.library is not None:
            continue
        if _is_foreign_object(scene_object, project_id):
            transaction.capture_custom_property(scene_object, "cclay.locked_by_human")
            scene_object["cclay.locked_by_human"] = True
    transaction.capture_custom_property(scene, "cclay.migration_version")
    scene["cclay.migration_version"] = _MIGRATION_VERSION


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


def _stage_motion_fps(project_directory: object, motion_id: str) -> int:
    try:
        return motion_archive.motion_fps(project_directory, motion_id)
    except motion_archive.MotionArchiveError as error:
        raise StageSceneError(str(error)) from error
def _live_baked_motions() -> list[tuple[str, str, int]]:
    """(entity_id, motion_id, fps) for every apply_motion bake in the live scene.

    ``_apply_motion`` is the only writer of ``cclay.motion_fps``; reading it
    back off the baked action is the cross-call signal the fps guard needs (the
    within-plan check cannot see a later plan that only changes the rate). A
    bake whose object lost its entity id is skipped: it could not have been
    produced by apply_motion.
    """
    if bpy is None:
        return []
    baked = []
    for scene_object in bpy.context.scene.objects:
        animation_data = getattr(scene_object, "animation_data", None)
        action = getattr(animation_data, "action", None)
        if action is None:
            continue
        motion_id = action.get("cclay.motion_id")
        fps = action.get("cclay.motion_fps")
        entity_id = scene_object.get("cclay.entity_id")
        if (
            isinstance(motion_id, str)
            and isinstance(fps, (int, float))
            and isinstance(entity_id, str)
        ):
            baked.append((entity_id, motion_id, int(fps)))
    return baked


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


def _require_plan_fps_agrees(
    plan: dict,
    motion_fps_of,
    live_baked: list[tuple[str, str, int]] = (),
    live_scene_fps: int | None = None,
) -> None:
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

    Deliberately ignores the LIVE scene fps for a first apply: a factory-startup
    Blender scene is already 24 fps, so comparing the motion rate against it
    would reject every first apply_motion. Resampling key spacing by
    scene_fps/motion_fps is the other possible contract and is deliberately
    deferred rather than half-done -- it would have to move hand_track clip
    frames, start_frame, contact windows and camera cut frames together.

    CLOSED GAP, two-call case. The within-plan check cannot see a LATER,
    separate plan that changes the scene rate, so the baked action's recorded
    ``cclay.motion_fps`` is read back: when such a plan would leave an
    already-baked motion playing at a different rate, it is rejected with the
    same APPLY_MOTION_FPS_CONFLICT contract. A bake the plan re-applies over is
    exempt -- replacing the clip is the sanctioned way to change the rate.
    ``live_baked`` ((entity_id, motion_id, fps) triples) and ``live_scene_fps``
    are injected by the gate (stage_scene.py:2281-2288) so this stays a pure
    function; both default to "no live scene" for plan-only callers.
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
        # The plan is coherent, but it may still change the scene rate under an
        # already-baked motion. A bake the plan re-applies over is replaced by
        # the plan and exempt; any other live bake must already be at the rate
        # the plan leaves the scene at.
        if live_scene_fps is not None and live_baked:
            motion_rates = {
                rate for source, rate in rates if source != "set_render_settings"
            }
            resulting_rate = (
                requested
                if requested is not None
                else (next(iter(motion_rates)) if motion_rates else None)
            )
            if resulting_rate is not None and resulting_rate != live_scene_fps:
                reapplied = {
                    operation["entity_id"]
                    for operation in plan["operations"]
                    if operation["op"] == "apply_motion"
                }
                mismatched = [
                    (entity_id, motion_id, baked_fps)
                    for entity_id, motion_id, baked_fps in live_baked
                    if entity_id not in reapplied and baked_fps != resulting_rate
                ]
                if mismatched:
                    detail = ", ".join(
                        f"motion {motion_id} baked at {baked_fps} fps"
                        for _entity_id, motion_id, baked_fps in mismatched
                    )
                    raise StageSceneError(
                        f"APPLY_MOTION_FPS_CONFLICT: the scene already carries "
                        f"{detail} but this plan changes the scene to "
                        f"{resulting_rate} fps; apply_motion bakes one npz frame "
                        f"per scene frame, so keep the scene at the baked "
                        f"motion's rate or regenerate the motion at the rate "
                        f"you want"
                    )
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
def _apply_motion_scale(entity_id: str, scene_object, posed_joints) -> float:
    """Shared scale derivation for apply_motion, with preflight's closed codes.

    A non-uniform or otherwise unusable object scale surfaces as the same code
    preflight_motion reports it (INVALID_PREFLIGHT_MOTION_PARAMS), and a
    degenerate thigh as APPLY_MOTION_MALFORMED -- never the
    PreflightMotionError class name (see motion_preflight.py:391-394).
    """
    try:
        return motion_preflight._derive_scale_for_object(
            entity_id, scene_object, posed_joints
        )
    except motion_preflight.PreflightMotionError as error:
        raised = StageSceneError(f"{error.code}: {error}")
        raised.code = error.code
        raise raised from error


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
    try:
        local_rot_mats, posed_joints, fps, _carried = motion_archive.load_motion_payload(
            project_directory, operation["motion_id"], validate=False
        )
    except motion_archive.MotionArchiveError as error:
        raise StageSceneError(str(error)) from error
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

    rig = CharacterRigAdapter(scene_object.data.bones)
    prefix = rig.prefix
    rest_rotations = rig.rest_rotations()
    for required_bone in ("Hips", "RightUpLeg", "RightLeg"):
        if required_bone not in rest_rotations:
            raise STAGE_SCENE_TARGET_TYPE_INVALID(
                f"character rig is missing the {required_bone} bone"
            )
    try:
        # Shared with preflight_motion: the object's world scale is validated
        # (non-uniform fails closed) and the LOCAL units-per-npz-unit factor is
        # what the retarget needs -- Blender's own object transform carries it
        # to world meters. Same closed codes preflight uses.
        scale = _apply_motion_scale(operation["entity_id"], scene_object, posed_joints)
        track_builder = motion_retarget.PoseTrackBuilder(
            local_rot_mats,
            posed_joints,
            rest_rotations,
            rig.hips_head(),
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
    authored_bone_names = rig.authored_bone_names(tracks["rotations"], pose_bones)
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
    from .manifest import extract_scene_manifest_v4

    manifest = extract_scene_manifest_v4()
    if manifest["sceneHash"] == current_scene_hash:
        return manifest
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
        arguments = (operation, self.transaction, self.project_id)
        if operation["op"] == "add_character":
            return _create_character(*arguments)
        if operation["op"] == "adopt_entity":
            return _adopt_entity(*arguments)
        return _set_render_settings(*arguments)

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
        self.result = {
            "expected_revision_id": self.plan["expected_revision_id"],
            "scene_hash": self.candidate_manifest["sceneHash"],
            "manifest": self.candidate_manifest,
            "entity_identities": [
                {
                    "entity_id": operation["entity_id"],
                    "requested_name": operation["name"],
                    "actual_name": objects_by_id[operation["entity_id"]]["name"],
                }
                for operation in self.plan["operations"]
                if operation["op"] == "add_character"
            ],
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
            from .manifest import extract_scene_manifest_v4
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
                # motion whose native fps differs. A plan that only changes the
                # scene fps (no apply_motion) is checked too: the live scene's
                # already-baked motions are read back so a later rate change
                # cannot orphan them at a different rate.
                if self.motion_count or _requested_scene_fps(self.plan) is not None:
                    _require_plan_fps_agrees(
                        self.plan,
                        lambda motion_id: _stage_motion_fps(
                            getattr(self.connection, "project_directory", None),
                            motion_id,
                        ),
                        live_baked=_live_baked_motions(),
                        live_scene_fps=int(bpy.context.scene.render.fps),
                    )
                try:
                    self.mode = _motion_keyframe_mode()
                except StageSceneError:
                    self.mode = "invalid"
                    raise
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
                    self.phase = "MIGRATE_FOREIGN_OBJECTS"
            elif self.phase == "MIGRATE_FOREIGN_OBJECTS":
                executed, _ = self._measure(
                    lambda: _migrate_foreign_objects(
                        self.scene, self.transaction, self.project_id
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
                executed, _ = self._measure(lambda: self._apply_operation(operation))
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
                executed, extracted = self._measure(extract_scene_manifest_v4)
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
